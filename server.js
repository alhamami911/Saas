"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { createSettingsStore } = require("./server/settings");

const MAX_BODY_BYTES = 128 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const SESSION_COOKIE = "ql_admin";

const BASE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin"
};
const ADMIN_HEADERS = {
    ...BASE_HEADERS,
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

function send(res, statusCode, body, headers = {}) {
    res.writeHead(statusCode, { ...BASE_HEADERS, ...headers });
    res.end(body);
}

function sendJson(res, statusCode, payload, headers = {}) {
    send(res, statusCode, JSON.stringify(payload), { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error("Body too large"), { statusCode: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

async function readJson(req) {
    try {
        return JSON.parse(await readBody(req) || "{}");
    } catch (error) {
        if (error.statusCode) throw error;
        throw Object.assign(new Error("Invalid JSON"), { statusCode: 400 });
    }
}

function parseCookies(header = "") {
    return Object.fromEntries(header.split(";").map((part) => {
        const index = part.indexOf("=");
        return index < 0 ? [part.trim(), ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }));
}

function createApp({ env = process.env, dataDir, rootDir = __dirname, fetchImpl = fetch } = {}) {
    const settings = createSettingsStore({ dataDir: dataDir || env.DATA_DIR || path.join(rootDir, "data"), env });
    settings.load();
    // Loaded after the settings store so the handler sees the saved Gemini key.
    const { handler } = require("./netlify/functions/generate");

    const sessionSecret = env.SESSION_SECRET || randomBytes(32).toString("hex");
    const trustProxy = env.TRUST_PROXY === "1";
    const version = env.GIT_SHA || "dev";
    const loginFailures = new Map();
    const pages = {
        index: fs.readFileSync(path.join(rootDir, "index.html")),
        admin: fs.readFileSync(path.join(rootDir, "admin.html"))
    };

    function clientIp(req) {
        const forwarded = trustProxy && req.headers["x-real-ip"];
        return forwarded || req.socket.remoteAddress || "unknown";
    }

    function sign(value) {
        return createHmac("sha256", sessionSecret)
            .update(`${value}.${settings.credentialFingerprint()}`)
            .digest("base64url");
    }

    function issueSession(req) {
        const expires = Date.now() + SESSION_TTL_MS;
        const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        return `${SESSION_COOKIE}=${expires}.${sign(expires)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
    }

    function hasSession(req) {
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (!token) return false;
        const [expires, signature] = token.split(".");
        if (!signature || !(Number(expires) > Date.now())) return false;
        const expected = Buffer.from(sign(expires));
        const actual = Buffer.from(signature);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    }

    // Admin writes must come from this site: SameSite=Strict covers browsers,
    // and the Origin check rejects any cross-site form or script that slips by.
    function sameOrigin(req) {
        const origin = req.headers.origin;
        if (!origin) return true;
        try {
            return new URL(origin).host === req.headers.host;
        } catch (error) {
            return false;
        }
    }

    async function testGeminiKey(key) {
        try {
            const response = await fetchImpl(
                "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash",
                { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(10000) }
            );
            if (response.ok) return { valid: true };
            const data = await response.json().catch(() => ({}));
            const message = typeof data?.error?.message === "string" ? data.error.message.slice(0, 300) : `HTTP ${response.status}`;
            return { valid: false, reachable: true, status: response.status, message };
        } catch (error) {
            return { valid: false, reachable: false, message: "Google could not be reached to check the key" };
        }
    }

    async function handleGenerate(req, res) {
        const body = await readBody(req);
        const headers = { ...req.headers, "x-nf-client-connection-ip": clientIp(req) };
        const result = await handler({ httpMethod: req.method, headers, body, isBase64Encoded: false });
        send(res, result.statusCode, result.body, { "Cache-Control": "no-store", ...result.headers });
    }

    async function handleAdminApi(req, res, route) {
        if (req.method !== "GET" && !sameOrigin(req)) {
            return sendJson(res, 403, { error: "Cross-site request rejected" });
        }

        if (route === "/login" && req.method === "POST") {
            const ip = clientIp(req);
            const record = loginFailures.get(ip);
            if (record && record.until > Date.now()) {
                return sendJson(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
            }
            if (!settings.adminConfigured()) {
                return sendJson(res, 503, { error: "Admin password is not configured on the server" });
            }
            const { password } = await readJson(req);
            if (!settings.verifyAdminPassword(password)) {
                const count = (record?.count || 0) + 1;
                if (loginFailures.size > 10000) loginFailures.clear();
                loginFailures.set(ip, count >= LOGIN_MAX_FAILURES
                    ? { count: 0, until: Date.now() + LOGIN_LOCK_MS }
                    : { count, until: 0 });
                return sendJson(res, 401, { error: "Wrong password" });
            }
            loginFailures.delete(ip);
            return sendJson(res, 200, { ok: true }, { "Set-Cookie": issueSession(req) });
        }

        if (route === "/logout" && req.method === "POST") {
            return sendJson(res, 200, { ok: true }, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0` });
        }

        if (!hasSession(req)) return sendJson(res, 401, { error: "Sign in required" });

        if (route === "/settings" && req.method === "GET") {
            return sendJson(res, 200, { gemini: settings.geminiStatus(), version });
        }

        if (route === "/gemini-key" && req.method === "PUT") {
            const { key, skipCheck } = await readJson(req);
            const trimmed = String(key || "").trim();
            const check = await testGeminiKey(trimmed);
            if (!check.valid && check.reachable && !skipCheck) {
                return sendJson(res, 422, { error: `Google rejected this key: ${check.message}`, check });
            }
            const saved = settings.setGeminiKey(trimmed);
            if (saved.error) return sendJson(res, 400, { error: saved.error });
            return sendJson(res, 200, { gemini: settings.geminiStatus(), check });
        }

        if (route === "/gemini-key" && req.method === "DELETE") {
            settings.clearGeminiKey();
            return sendJson(res, 200, { gemini: settings.geminiStatus() });
        }

        if (route === "/gemini-key/test" && req.method === "POST") {
            if (!env.qlook_key) return sendJson(res, 200, { check: { valid: false, message: "No key is configured" } });
            return sendJson(res, 200, { check: await testGeminiKey(env.qlook_key) });
        }

        if (route === "/password" && req.method === "PUT") {
            const { current, next } = await readJson(req);
            if (!settings.verifyAdminPassword(current)) return sendJson(res, 401, { error: "Current password is wrong" });
            const result = settings.setAdminPassword(next);
            if (result.error) return sendJson(res, 400, { error: result.error });
            // The fingerprint changed, so issue a fresh session for this browser.
            return sendJson(res, 200, { ok: true }, { "Set-Cookie": issueSession(req) });
        }

        return sendJson(res, 404, { error: "Not found" });
    }

    async function route(req, res) {
        const { pathname } = new URL(req.url, "http://localhost");

        if (pathname === "/healthz") return sendJson(res, 200, { ok: true, version });
        if (pathname === "/api/generate" || pathname === "/.netlify/functions/generate") return handleGenerate(req, res);
        if (pathname.startsWith("/admin/api/")) return handleAdminApi(req, res, pathname.slice("/admin/api".length));
        if (pathname === "/admin" || pathname === "/admin/") {
            return send(res, 200, pages.admin, { ...ADMIN_HEADERS, "Content-Type": "text/html; charset=utf-8" });
        }
        if (pathname === "/" || pathname === "/index.html") {
            if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
            return send(res, 200, req.method === "HEAD" ? undefined : pages.index, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-cache"
            });
        }
        return send(res, 404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
    }

    return http.createServer((req, res) => {
        route(req, res).catch((error) => {
            const statusCode = error.statusCode || 500;
            if (statusCode === 500) console.error("Unhandled request error", error);
            if (!res.headersSent) sendJson(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message });
            else res.end();
        });
    });
}

if (require.main === module) {
    const port = Number(process.env.PORT) || 8080;
    const server = createApp();
    server.listen(port, () => console.log(`QLook listening on :${port} (version ${process.env.GIT_SHA || "dev"})`));
    const shutdown = () => server.close(() => process.exit(0));
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

module.exports = { createApp };
