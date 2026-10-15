"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { planLimits, accessStatus, checkAccess, chargeAccess } = require("../server/quota");

const config = { redisUrl: "https://redis.example", redisToken: "t", searchEstimateUsd: 0.08, discussEstimateUsd: 0.002 };
// The real default plan: every account gets its own $20, independent of any
// other account — no pool is split between them.
const plan = { id: "p1", perAccountBudgetUsd: 20, periodDays: 30, visitorDailyUsd: 0.08 };
const HOUR = 3600000;

// Minimal Redis for the quota scripts: GET, MGET, counters and session opening.
function withRedis(run) {
    const store = new Map();
    const original = global.fetch;
    global.fetch = async (url, init) => {
        const [name, a, n, ...rest] = JSON.parse(init.body);
        let result = null;
        if (name === "GET") result = store.get(a) ?? null;
        else if (name === "MGET") result = [a, n, ...rest].map((key) => store.get(key) ?? null);
        else if (name === "EVAL" && a.includes("start + tonumber")) {
            const [startKey, spentKey, now] = rest;
            if (!store.has(startKey) || Number(store.get(startKey)) + 5 * HOUR <= Number(now)) {
                store.set(startKey, now);
                store.set(spentKey, "0");
            }
            result = store.get(startKey);
        } else if (name === "EVAL" && a.includes("INCRBYFLOAT")) {
            const keys = rest.slice(0, Number(n));
            const amount = Number(rest[Number(n)]);
            for (const key of keys) store.set(key, String((Number(store.get(key)) || 0) + amount));
            result = 1;
        }
        return { ok: true, status: 200, json: async () => ({ result }) };
    };
    return Promise.resolve(run(store)).finally(() => { global.fetch = original; });
}

test("every account gets the same flat $20, split across session/day/week/period", () => {
    const limits = planLimits(plan, { search: 0.08, discuss: 0.002 });
    assert.equal(limits.perAccount.period, 20, "the account's own budget, not a share of a pool");
    assert.equal(limits.perAccount.session.toFixed(2), "1.20", "6% of $20");
    assert.equal(limits.perAccount.day.toFixed(2), "2.40", "12% of $20");
    assert.equal(limits.perAccount.week.toFixed(2), "7.00", "35% of $20");
    assert.ok(limits.perAccount.week <= limits.perAccount.period);
    assert.equal(limits.visitorDay, 0.08, "visitors share one small daily allowance, set directly by the admin");
    // A very small budget still guarantees at least one search per window.
    const tiny = planLimits({ ...plan, perAccountBudgetUsd: 0.32 }, { search: 0.08, discuss: 0.002 });
    assert.equal(tiny.perAccount.session.toFixed(2), "0.08");
    assert.equal(tiny.perAccount.day.toFixed(2), "0.08");
    assert.equal(tiny.perAccount.week.toFixed(3), "0.112");
    assert.equal(tiny.perAccount.period, 0.32);
});

test("an account is stopped by its session, then day, week and trial period", async () => {
    // A small budget keeps the numbers easy to exhaust on purpose for this test.
    const small = { id: "p-small", perAccountBudgetUsd: 0.32, periodDays: 30, visitorDailyUsd: 0.08 };
    await withRedis(async () => {
        const now = Date.parse("2026-10-14T08:00:00Z");
        const account = { id: "acc-1", activatedAt: new Date(now - HOUR).toISOString() };
        const who = { account };
        assert.equal((await checkAccess(config, small, who, "search", now)).allowed, true);
        await chargeAccess(config, small, who, 0.08, {}, now);
        const blocked = await checkAccess(config, small, who, "search", now + HOUR);
        assert.equal(blocked.allowed, false);
        assert.equal(blocked.errorCode, "ACCOUNT_LIMIT");
        assert.equal(blocked.scope, "session");
        assert.equal(blocked.resetsAt, new Date(now + 5 * HOUR).toISOString(), "the session renews 5 hours after it began");
        // A used-up window blocks messages too.
        assert.equal((await checkAccess(config, small, who, "discuss", now + HOUR)).allowed, false);
        // A cheap cached search leaves balance, so the session allows another one.
        const cheap = { id: "acc-cheap", activatedAt: new Date(now - HOUR).toISOString() };
        await chargeAccess(config, small, { account: cheap }, 0.0106, {}, now);
        assert.equal((await checkAccess(config, small, { account: cheap }, "search", now)).allowed, true);
        // After the session ends the day limit (one search) is also used.
        const later = await checkAccess(config, small, who, "search", now + 6 * HOUR);
        assert.equal(later.scope, "day");
        // Next day: the week ($0.112) still has balance, so one more search runs
        // (soft limit) and its real cost is charged; then the week is used up.
        const nextDay = now + 24 * HOUR;
        assert.equal((await checkAccess(config, small, who, "search", nextDay)).allowed, true);
        await chargeAccess(config, small, who, 0.05, {}, nextDay);
        const week = await checkAccess(config, small, who, "search", nextDay + 6 * HOUR + 24 * HOUR);
        assert.equal(week.scope, "week");
        assert.equal(week.resetsAt, new Date(now - HOUR + 7 * 24 * HOUR).toISOString(), "weeks count from the first sign-in");
        const status = await accessStatus(config, small, who, nextDay);
        assert.equal(status.windows.period.used.toFixed(2), "0.13");
        assert.equal(status.expiresAt, new Date(now - HOUR + 30 * 24 * HOUR).toISOString());
    });
});

test("expired and disabled accounts, and the shared visitor allowance", async () => {
    await withRedis(async () => {
        const now = Date.parse("2026-10-14T08:00:00Z");
        const expired = { id: "old", activatedAt: new Date(now - 31 * 24 * HOUR).toISOString() };
        assert.equal((await checkAccess(config, plan, { account: expired }, "search", now)).errorCode, "ACCOUNT_EXPIRED");
        const disabled = { id: "off", activatedAt: new Date(now).toISOString(), disabled: true };
        assert.equal((await checkAccess(config, plan, { account: disabled }, "search", now)).errorCode, "ACCOUNT_DISABLED");

        // All anonymous visitors share one bucket; it has only a 'day' window.
        const visitor = { visitor: true };
        assert.equal((await checkAccess(config, plan, visitor, "search", now)).allowed, true);
        await chargeAccess(config, plan, visitor, 0.08, {}, now);
        const used = await checkAccess(config, plan, visitor, "search", now);
        assert.equal(used.errorCode, "VISITOR_LIMIT");
        assert.equal(used.scope, "day");
        assert.equal((await accessStatus(config, plan, visitor, now)).windows.period, undefined, "no shared pool to deplete over a longer period");

        // Failed requests still count toward the admin's total-spend view...
        const account = { id: "acc-2", activatedAt: new Date(now).toISOString() };
        await chargeAccess(config, plan, { account }, 0.05, { personal: false }, now);
        // ...but never against the account's own windows.
        assert.equal((await accessStatus(config, plan, { account }, now)).windows.day.used, 0);
        // A brand-new $20 account is nowhere near any of its own limits.
        assert.equal((await checkAccess(config, plan, { account }, "search", now)).allowed, true);
    });
});
