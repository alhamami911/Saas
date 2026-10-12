"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../server");

const VALID_KEY = "AIzaTestKey_0123456789abcdefghij";

async function withServer(run, { envOverrides = {}, fetchImpl } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qlook-"));
    const names = ["qlook_key", "ADMIN_PASSWORD", "SESSION_SECRET", "GIT_SHA"];
    const oldValues = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    Object.assign(process.env, { ADMIN_PASSWORD: "initial-admin-password", SESSION_SECRET: "test-secret", GIT_SHA: "abc1234def" }, envOverrides);

    const googleFetch = fetchImpl || (async (url, options) => ({
        ok: options.headers["x-goog-api-key"] === VALID_KEY,
        status: options.headers["x-goog-api-key"] === VALID_KEY ? 200 : 400,
        json: async () => ({ error: { message: "API key not valid" } })
    }));
    const start = () => new Promise((resolve) => {
        const server = createApp({ dataDir, fetchImpl: googleFetch });
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
    let server = await start();
    const ctx = {
        dataDir,
        get base() { return `http://127.0.0.1:${server.address().port}`; },
        async restart() {
            await new Promise((resolve) => server.close(resolve));
            server = await start();
        },
        async call(pathname, { method = "GET", body, cookie, headers = {} } = {}) {
            const response = await fetch(`${ctx.base}${pathname}`, {
                method,
                headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            const text = await response.text();
            let data;
            try { data = JSON.parse(text); } catch (error) { data = text; }
            const setCookie = response.headers.get("set-cookie");
            return { status: response.status, data, cookie: setCookie && setCookie.split(";")[0], headers: response.headers };
        },
        async login(password = "initial-admin-password") {
            const result = await ctx.call("/admin/api/login", { method: "POST", body: { password } });
            assert.equal(result.status, 200);
            return result.cookie;
        }
    };
    try {
        await run(ctx);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dataDir, { recursive: true, force: true });
        for (const name of names) {
            if (oldValues[name] === undefined) delete process.env[name];
            else process.env[name] = oldValues[name];
        }
    }
}

test("serves the app, admin page and health check", async () => {
    await withServer(async ({ call }) => {
        const health = await call("/healthz");
        assert.deepEqual(health.data, { ok: true, version: "abc1234def" });
        const index = await call("/");
        assert.equal(index.status, 200);
        assert.match(index.data, /fetch\('\/api\/generate'/);
        const admin = await call("/admin");
        assert.equal(admin.status, 200);
        assert.match(admin.headers.get("content-security-policy"), /frame-ancestors 'none'/);
        assert.equal((await call("/netlify/lib/config.js")).status, 404);
        assert.equal((await call("/../server.js")).status, 404);
    });
});

test("admin API requires a session and rejects wrong passwords", async () => {
    await withServer(async ({ call }) => {
        assert.equal((await call("/admin/api/settings")).status, 401);
        assert.equal((await call("/admin/api/gemini-key", { method: "PUT", body: { key: VALID_KEY } })).status, 401);
        assert.equal((await call("/admin/api/login", { method: "POST", body: { password: "nope" } })).status, 401);
        assert.equal((await call("/admin/api/settings", { cookie: "ql_admin=9999999999999.forged" })).status, 401);
    });
});

test("locks out an IP after repeated failed logins", async () => {
    await withServer(async ({ call }) => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            assert.equal((await call("/admin/api/login", { method: "POST", body: { password: "wrong" } })).status, 401);
        }
        const locked = await call("/admin/api/login", { method: "POST", body: { password: "initial-admin-password" } });
        assert.equal(locked.status, 429);
    });
});

test("saves a checked Gemini key, applies it immediately, and keeps it across restarts", async () => {
    await withServer(async (ctx) => {
        const cookie = await ctx.login();
        const empty = await ctx.call("/admin/api/settings", { cookie });
        assert.equal(empty.data.gemini.configured, false);

        const rejected = await ctx.call("/admin/api/gemini-key", { method: "PUT", cookie, body: { key: "AIzaWrongKey_0123456789abcdefgh" } });
        assert.equal(rejected.status, 422);
        assert.equal(process.env.qlook_key, undefined);

        const saved = await ctx.call("/admin/api/gemini-key", { method: "PUT", cookie, body: { key: ` ${VALID_KEY} ` } });
        assert.equal(saved.status, 200);
        assert.equal(saved.data.check.valid, true);
        assert.equal(saved.data.gemini.masked, "AIza••••ghij");
        assert.equal(saved.data.gemini.source, "admin");
        assert.equal(process.env.qlook_key, VALID_KEY);
        assert.ok(!JSON.stringify(saved.data).includes(VALID_KEY));

        const file = path.join(ctx.dataDir, "settings.json");
        if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

        delete process.env.qlook_key;
        await ctx.restart();
        assert.equal(process.env.qlook_key, VALID_KEY);

        const removed = await ctx.call("/admin/api/gemini-key", { method: "DELETE", cookie });
        assert.equal(removed.data.gemini.configured, false);
        assert.equal(process.env.qlook_key, undefined);
    });
});

test("rejects cross-site admin writes", async () => {
    await withServer(async (ctx) => {
        const cookie = await ctx.login();
        const result = await ctx.call("/admin/api/gemini-key", {
            method: "PUT", cookie, body: { key: VALID_KEY }, headers: { Origin: "https://evil.example" }
        });
        assert.equal(result.status, 403);
        assert.equal(process.env.qlook_key, undefined);
    });
});

test("changing the admin password signs out old sessions", async () => {
    await withServer(async (ctx) => {
        const oldCookie = await ctx.login();
        const short = await ctx.call("/admin/api/password", { method: "PUT", cookie: oldCookie, body: { current: "initial-admin-password", next: "short" } });
        assert.equal(short.status, 400);
        const changed = await ctx.call("/admin/api/password", {
            method: "PUT", cookie: oldCookie, body: { current: "initial-admin-password", next: "a-much-better-password" }
        });
        assert.equal(changed.status, 200);
        assert.equal((await ctx.call("/admin/api/settings", { cookie: oldCookie })).status, 401);
        assert.equal((await ctx.call("/admin/api/settings", { cookie: changed.cookie })).status, 200);
        assert.equal((await ctx.call("/admin/api/login", { method: "POST", body: { password: "initial-admin-password" } })).status, 401);
        await ctx.login("a-much-better-password");
    });
});

test("generate endpoint runs the research handler on both paths", async () => {
    await withServer(async ({ call }) => {
        for (const pathname of ["/api/generate", "/.netlify/functions/generate"]) {
            const missingKey = await call(pathname, { method: "POST", body: { settings: "x", opportunityCount: 5 } });
            assert.equal(missingKey.status, 503);
            assert.equal(missingKey.data.errorCode, "GEMINI_KEY_MISSING");
        }
        assert.equal((await call("/api/generate")).status, 405);
    });
});
