"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../server");
const { setClientFactory } = require("../server/providers/claude");

const VALID_KEY = "AIzaTestKey_0123456789abcdefghij";

async function withServer(run, { envOverrides = {}, fetchImpl } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qlook-"));
    const names = ["qlook_key", "qlook_claude_key", "QL_PROVIDER", "QL_CLAUDE_MODEL", "ADMIN_PASSWORD", "SESSION_SECRET", "GIT_SHA"];
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
        async call(pathname, { method = "GET", body, cookie, headers = {}, csrf = true } = {}) {
            const response = await fetch(`${ctx.base}${pathname}`, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    ...(csrf ? { "X-QLook-Admin": "1" } : {}),
                    ...(cookie ? { Cookie: cookie } : {}),
                    ...headers
                },
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
        assert.doesNotMatch(index.data, /admin\/api|ADMIN_PASSWORD|qlook_key/);
        assert.equal(index.headers.get("x-frame-options"), "DENY");
        assert.match(index.headers.get("content-security-policy"), /frame-ancestors 'none'/);
        assert.equal(index.headers.get("strict-transport-security"), null);
        const secure = await call("/", { headers: { "X-Forwarded-Proto": "https" } });
        assert.match(secure.headers.get("strict-transport-security"), /max-age=31536000/);
        const admin = await call("/admin");
        assert.equal(admin.status, 200);
        assert.match(admin.headers.get("content-security-policy"), /frame-ancestors 'none'/);
        assert.equal((await call("/server/config.js")).status, 404);
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
        const secureLogin = await ctx.call("/admin/api/login", {
            method: "POST", body: { password: "initial-admin-password" }, headers: { "X-Forwarded-Proto": "https" }
        });
        assert.match(secureLogin.headers.get("set-cookie"), /HttpOnly; SameSite=Strict;.*Secure/);
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

test("key test runs a grounded research request and reports Google's reason", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, body: options.body });
        if (url.endsWith(":generateContent")) {
            return { ok: false, status: 400, json: async () => ({ error: { message: "Search grounding is not enabled for this project" } }) };
        }
        return { ok: options.headers["x-goog-api-key"] === VALID_KEY, status: 200, json: async () => ({}) };
    };
    await withServer(async (ctx) => {
        const cookie = await ctx.login();
        const empty = await ctx.call("/admin/api/gemini-key/test", { method: "POST", cookie });
        assert.equal(empty.data.check.valid, false);
        assert.equal((await ctx.call("/admin/api/gemini-key", { method: "PUT", cookie, body: { key: VALID_KEY } })).status, 200);
        const tested = await ctx.call("/admin/api/gemini-key/test", { method: "POST", cookie });
        assert.equal(tested.data.check.valid, false);
        assert.equal(tested.data.check.research, false);
        assert.match(tested.data.check.message, /research requests fail: Search grounding is not enabled/);
        assert.ok(!JSON.stringify(tested.data).includes(VALID_KEY));
        const research = calls.find((call) => call.url.endsWith(":generateContent"));
        assert.ok(JSON.parse(research.body).tools[0].googleSearch);
    }, { fetchImpl });
});

test("admin saves a checked Claude key and switches provider and model", async () => {
    const CLAUDE_KEY = "sk-ant-api03-test_only_key_0123456789abcdef";
    const checked = [];
    const previous = setClientFactory(({ apiKey }) => ({
        models: {
            retrieve: async (model) => {
                checked.push({ apiKey, model });
                if (apiKey !== CLAUDE_KEY) throw Object.assign(new Error("invalid x-api-key"), { status: 401 });
                return { id: model };
            }
        },
        messages: {
            create: async () => ({ stop_reason: "end_turn", content: [], usage: { server_tool_use: { web_search_requests: 1 } } })
        }
    }));
    try {
        await withServer(async (ctx) => {
            const cookie = await ctx.login();
            const initial = await ctx.call("/admin/api/settings", { cookie });
            assert.equal(initial.data.research.provider, "claude");
            assert.equal(initial.data.claude.model, "claude-haiku-5-5");
            assert.equal(initial.data.claude.configured, false);

            const wrong = await ctx.call("/admin/api/claude-key", { method: "PUT", cookie, body: { key: "sk-ant-api03-wrong_key_0123456789abcdefgh" } });
            assert.equal(wrong.status, 422);
            assert.equal(process.env.qlook_claude_key, undefined);

            const saved = await ctx.call("/admin/api/claude-key", { method: "PUT", cookie, body: { key: CLAUDE_KEY } });
            assert.equal(saved.status, 200);
            assert.equal(saved.data.claude.masked, "sk-a••••cdef");
            assert.equal(process.env.qlook_claude_key, CLAUDE_KEY);
            assert.ok(!JSON.stringify(saved.data).includes(CLAUDE_KEY));

            const tested = await ctx.call("/admin/api/claude-key/test", { method: "POST", cookie });
            assert.deepEqual(tested.data.check, { valid: true, research: true });

            const badProvider = await ctx.call("/admin/api/provider", { method: "PUT", cookie, body: { provider: "openai", claudeModel: "claude-haiku-5-5" } });
            assert.equal(badProvider.status, 400);
            const switched = await ctx.call("/admin/api/provider", { method: "PUT", cookie, body: { provider: "claude", claudeModel: "claude-sonnet-5-5" } });
            assert.deepEqual(switched.data.research, { provider: "claude", claudeModel: "claude-sonnet-5-5" });
            assert.equal(process.env.QL_CLAUDE_MODEL, "claude-sonnet-5-5");

            await ctx.restart();
            const after = await ctx.call("/admin/api/settings", { cookie });
            assert.equal(after.data.claude.model, "claude-sonnet-5-5");
            assert.equal(after.data.claude.source, "admin");
            assert.equal((await ctx.call("/admin/api/provider", { method: "PUT", body: { provider: "gemini", claudeModel: "claude-haiku-5-5" } })).status, 401);
        });
    } finally {
        setClientFactory(previous);
    }
    assert.ok(checked.every((entry) => entry.model.startsWith("claude-")));
});

test("rejects cross-site admin writes", async () => {
    await withServer(async (ctx) => {
        const noHeaderLogin = await ctx.call("/admin/api/login", { method: "POST", body: { password: "initial-admin-password" }, csrf: false });
        assert.equal(noHeaderLogin.status, 403);
        const cookie = await ctx.login();
        const noHeaderWrite = await ctx.call("/admin/api/gemini-key", { method: "PUT", cookie, body: { key: VALID_KEY }, csrf: false });
        assert.equal(noHeaderWrite.status, 403);
        assert.equal((await ctx.call("/admin/api/gemini-key", { method: "DELETE", cookie, csrf: false })).status, 403);
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

test("generate endpoint runs the research handler", async () => {
    await withServer(async ({ call }) => {
        const missingKey = await call("/api/generate", { method: "POST", body: { settings: "x", opportunityCount: 5 } });
        assert.equal(missingKey.status, 503);
        assert.equal(missingKey.data.errorCode, "CLAUDE_KEY_MISSING");
        assert.equal((await call("/api/generate")).status, 405);
    });
});

test("trial accounts: admin creates them, users sign in, resets end old sessions", async () => {
    await withServer(async ({ call, login }) => {
        assert.equal((await call("/admin/api/accounts")).status, 401, "accounts are admin-only");
        const admin = await login();
        const created = await call("/admin/api/accounts", { method: "POST", cookie: admin, body: { count: 2 } });
        assert.equal(created.status, 200);
        assert.deepEqual(created.data.created.map((item) => item.username), ["trial01", "trial02"]);
        const [first] = created.data.created;
        assert.equal(first.password.length, 14);
        const listed = await call("/admin/api/accounts", { cookie: admin });
        assert.equal(listed.data.accounts.length, 2);
        assert.ok(listed.data.accounts.every((account) => !("passwordHash" in account) && !("password" in account)), "passwords are shown once only");

        const wrong = await call("/api/account/login", { method: "POST", csrf: false, body: { username: "trial01", password: "nope" } });
        assert.equal(wrong.status, 401);
        const crossSite = await call("/api/account/login", { method: "POST", csrf: false, headers: { Origin: "https://evil.example" }, body: { username: "trial01", password: first.password } });
        assert.equal(crossSite.status, 403);
        const signedIn = await call("/api/account/login", { method: "POST", csrf: false, body: { username: "TRIAL01", password: first.password } });
        assert.equal(signedIn.status, 200);
        assert.match(signedIn.cookie, /^ql_user=/);
        const me = await call("/api/account", { cookie: signedIn.cookie });
        assert.equal(me.data.signedIn, true);
        assert.equal(me.data.username, "trial01");
        const afterList = await call("/admin/api/accounts", { cookie: admin });
        assert.ok(afterList.data.accounts[0].activatedAt, "the trial starts at the first sign-in");
        assert.ok(afterList.data.accounts[0].expiresAt);

        const reset = await call(`/admin/api/accounts/${first.id}/password`, { method: "POST", cookie: admin });
        assert.equal(reset.status, 200);
        assert.notEqual(reset.data.password, first.password);
        assert.equal((await call("/api/account", { cookie: signedIn.cookie })).data.signedIn, false, "a reset signs the old session out");
        const disabled = await call(`/admin/api/accounts/${first.id}`, { method: "PUT", cookie: admin, body: { disabled: true } });
        assert.equal(disabled.data.account.disabled, true);
        const removed = await call(`/admin/api/accounts/${created.data.created[1].id}`, { method: "DELETE", cookie: admin });
        assert.equal(removed.status, 200);
        assert.equal((await call("/admin/api/accounts", { cookie: admin })).data.accounts.length, 1);
    });
});

test("the free-trial plan is validated and its limits are shown to the admin", async () => {
    await withServer(async ({ call, login }) => {
        const admin = await login();
        const plan = await call("/admin/api/plan", { cookie: admin });
        assert.equal(plan.data.plan.perAccountBudgetUsd, 20, "every account gets the same flat credit");
        assert.equal(plan.data.plan.signupsOpen, true, "public sign-ups are open by default");
        assert.equal(plan.data.limits.perAccount.period, 20, "not split across any number of accounts");
        const bad = await call("/admin/api/plan", { method: "PUT", cookie: admin, body: { perAccountBudgetUsd: -5, periodDays: 30, visitorDailyUsd: 0.08 } });
        assert.equal(bad.status, 400);
        const good = await call("/admin/api/plan", { method: "PUT", cookie: admin, body: { perAccountBudgetUsd: 40, periodDays: 14, visitorDailyUsd: 0.2, signupsOpen: false, restart: true } });
        assert.equal(good.status, 200);
        assert.equal(good.data.plan.perAccountBudgetUsd, 40);
        assert.equal(good.data.plan.signupsOpen, false);
        assert.ok(good.data.plan.startedAt);
    });
});

test("anyone can sign up for a free trial; each account gets its own credit", async () => {
    await withServer(async ({ call, login }) => {
        // The public page can read the trial's $ amount and whether sign-ups are open.
        const pub = await call("/api/account");
        assert.equal(pub.data.signedIn, false);
        assert.equal(pub.data.plan.perAccountBudgetUsd, 20);
        assert.equal(pub.data.plan.signupsOpen, true);

        const bad = [
            [{ email: "not-an-email", password: "longenough1" }, "SIGNUP_INVALID_EMAIL"],
            [{ email: "person@example.com", password: "short" }, "SIGNUP_WEAK_PASSWORD"],
            [{ email: "person@example.com", password: "longenough1", website: "https://bot.example" }, "AUTOMATED_REQUEST_REJECTED"]
        ];
        for (const [body, code] of bad) {
            const result = await call("/api/account/signup", { method: "POST", csrf: false, body });
            assert.equal(result.status, 400, code);
            assert.equal(result.data.errorCode, code);
        }
        const crossSite = await call("/api/account/signup", { method: "POST", csrf: false, headers: { Origin: "https://evil.example" }, body: { email: "person@example.com", password: "longenough1" } });
        assert.equal(crossSite.status, 403);

        const signedUp = await call("/api/account/signup", { method: "POST", csrf: false, body: { email: "Person@Example.com", password: "longenough1" } });
        assert.equal(signedUp.status, 200);
        assert.equal(signedUp.data.username, "person@example.com", "the email is normalised to lowercase");
        assert.ok("access" in signedUp.data, "the sign-up response logs the person straight in, same shape as login");
        assert.match(signedUp.cookie, /^ql_user=/);

        const dupe = await call("/api/account/signup", { method: "POST", csrf: false, body: { email: "person@example.com", password: "anotherpass1" } });
        assert.equal(dupe.data.errorCode, "SIGNUP_EMAIL_TAKEN");

        // The new account shows up in the admin dashboard, tagged as a sign-up.
        const admin = await login();
        const accounts = (await call("/admin/api/accounts", { cookie: admin })).data.accounts;
        const theirs = accounts.find((account) => account.username === "person@example.com");
        assert.equal(theirs.source, "signup");
        assert.ok(theirs.activatedAt, "the trial starts immediately, same as a first login");

        // Closing sign-ups blocks new accounts without touching the one just made.
        await call("/admin/api/plan", { method: "PUT", cookie: admin, body: { perAccountBudgetUsd: 20, periodDays: 30, visitorDailyUsd: 0.08, signupsOpen: false } });
        const closed = await call("/api/account/signup", { method: "POST", csrf: false, body: { email: "another@example.com", password: "longenough1" } });
        assert.equal(closed.status, 403);
        assert.equal(closed.data.errorCode, "SIGNUPS_CLOSED");
        const stillWorks = await call("/api/account/login", { method: "POST", csrf: false, body: { username: "person@example.com", password: "longenough1" } });
        assert.equal(stillWorks.status, 200, "existing sign-ups keep working while new ones are paused");
    });
});
