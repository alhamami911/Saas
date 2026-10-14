"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { planLimits, accessStatus, checkAccess, chargeAccess } = require("../server/quota");

const config = { redisUrl: "https://redis.example", redisToken: "t", searchEstimateUsd: 0.08, discussEstimateUsd: 0.002 };
const plan = { id: "p1", totalBudgetUsd: 20, accounts: 50, periodDays: 30, visitorSharePct: 10, reservePct: 10 };
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

test("a $20 plan for 50 accounts over 30 days gives each account small, layered limits", () => {
    const limits = planLimits(plan, { search: 0.08, discuss: 0.002 });
    assert.equal(limits.usable.toFixed(2), "18.00", "10% reserve");
    assert.equal(limits.visitorPool.toFixed(2), "2.00", "10% shared by visitors");
    assert.equal(limits.perAccount.period.toFixed(2), "0.32", "(18 - 2) / 50");
    // A 6% session or 12% day would be below one search, so both allow exactly one.
    assert.equal(limits.perAccount.session.toFixed(2), "0.08");
    assert.equal(limits.perAccount.day.toFixed(2), "0.08");
    assert.equal(limits.perAccount.week.toFixed(3), "0.112", "35% of the period");
    assert.ok(limits.perAccount.week <= limits.perAccount.period);
    // With $200 the percentages take over from the one-search floor.
    const bigger = planLimits({ ...plan, totalBudgetUsd: 200 }, { search: 0.08 });
    assert.equal(bigger.perAccount.period.toFixed(2), "3.20");
    assert.equal(bigger.perAccount.day.toFixed(3), "0.384");
    assert.equal(bigger.perAccount.session.toFixed(3), "0.192");
});

test("an account is stopped by its session, then day, week and trial period", async () => {
    await withRedis(async () => {
        const now = Date.parse("2026-10-14T08:00:00Z");
        const account = { id: "acc-1", activatedAt: new Date(now - HOUR).toISOString() };
        const who = { account };
        assert.equal((await checkAccess(config, plan, who, "search", now)).allowed, true);
        await chargeAccess(config, plan, who, 0.08, {}, now);
        const blocked = await checkAccess(config, plan, who, "search", now + HOUR);
        assert.equal(blocked.allowed, false);
        assert.equal(blocked.errorCode, "ACCOUNT_LIMIT");
        assert.equal(blocked.scope, "session");
        assert.equal(blocked.resetsAt, new Date(now + 5 * HOUR).toISOString(), "the session renews 5 hours after it began");
        // A used-up window blocks messages too.
        assert.equal((await checkAccess(config, plan, who, "discuss", now + HOUR)).allowed, false);
        // A cheap cached search leaves balance, so the session allows another one.
        const cheap = { id: "acc-cheap", activatedAt: new Date(now - HOUR).toISOString() };
        await chargeAccess(config, plan, { account: cheap }, 0.0106, {}, now);
        assert.equal((await checkAccess(config, plan, { account: cheap }, "search", now)).allowed, true);
        // After the session ends the day limit (one search) is also used.
        const later = await checkAccess(config, plan, who, "search", now + 6 * HOUR);
        assert.equal(later.scope, "day");
        // Next day: the week ($0.112) still has balance, so one more search runs
        // (soft limit) and its real cost is charged; then the week is used up.
        const nextDay = now + 24 * HOUR;
        assert.equal((await checkAccess(config, plan, who, "search", nextDay)).allowed, true);
        await chargeAccess(config, plan, who, 0.05, {}, nextDay);
        const week = await checkAccess(config, plan, who, "search", nextDay + 6 * HOUR + 24 * HOUR);
        assert.equal(week.scope, "week");
        assert.equal(week.resetsAt, new Date(now - HOUR + 7 * 24 * HOUR).toISOString(), "weeks count from the first sign-in");
        const status = await accessStatus(config, plan, who, nextDay);
        assert.equal(status.windows.period.used.toFixed(2), "0.13");
        assert.equal(status.expiresAt, new Date(now - HOUR + 30 * 24 * HOUR).toISOString());
    });
});

test("expired and disabled accounts, the visitor pool and the plan budget", async () => {
    await withRedis(async (store) => {
        const now = Date.parse("2026-10-14T08:00:00Z");
        const expired = { id: "old", activatedAt: new Date(now - 31 * 24 * HOUR).toISOString() };
        assert.equal((await checkAccess(config, plan, { account: expired }, "search", now)).errorCode, "ACCOUNT_EXPIRED");
        const disabled = { id: "off", activatedAt: new Date(now).toISOString(), disabled: true };
        assert.equal((await checkAccess(config, plan, { account: disabled }, "search", now)).errorCode, "ACCOUNT_DISABLED");

        const visitor = { visitor: true };
        assert.equal((await checkAccess(config, plan, visitor, "search", now)).allowed, true);
        await chargeAccess(config, plan, visitor, 0.08, {}, now);
        const pool = await checkAccess(config, plan, visitor, "search", now);
        assert.equal(pool.errorCode, "VISITOR_LIMIT");
        assert.equal(pool.scope, "day");

        // Failed requests count against the plan but not the person.
        const account = { id: "acc-2", activatedAt: new Date(now).toISOString() };
        await chargeAccess(config, plan, { account }, 0.05, { personal: false }, now);
        assert.equal((await accessStatus(config, plan, { account }, now)).windows.day.used, 0);
        store.set("ql:q:p1:total", "17.99");
        assert.equal((await checkAccess(config, plan, { account }, "search", now)).errorCode, "PLAN_BUDGET_EXHAUSTED");
    });
});
