"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { planLimits, accessStatus, checkAccess, chargeAccess } = require("../server/quota");

const config = { redisUrl: "https://redis.example", redisToken: "t", searchEstimateUsd: 0.08, discussEstimateUsd: 0.002 };
// The real default plan: free, with a flat moderate daily allowance per account
// (not a slice of a pool that runs out) and a generous period backstop against abuse.
const plan = { id: "p1", perAccountBudgetUsd: 300, periodDays: 365, accountDailyUsd: 2.4, visitorDailyUsd: 0.08 };
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

test("every account gets the same flat daily allowance, not a slice of a pool that runs out", () => {
    const limits = planLimits(plan, { search: 0.08, discuss: 0.002 });
    assert.equal(limits.perAccount.day.toFixed(2), "2.40", "the admin-set flat daily allowance (~30 searches)");
    assert.equal(limits.perAccount.session.toFixed(2), "1.20", "half the day, so one sitting can't spend it all");
    assert.equal(limits.perAccount.week.toFixed(2), "14.40", "six days' worth - a daily user never feels this cap");
    assert.equal(limits.perAccount.period, 300, "a generous backstop against abuse, not an everyday limit");
    assert.ok(limits.perAccount.week <= limits.perAccount.period);
    assert.equal(limits.visitorDay, 0.08, "visitors share one small daily allowance, set directly by the admin");
    // A very small daily allowance still guarantees at least one search per window.
    const tiny = planLimits({ ...plan, accountDailyUsd: 0.02 }, { search: 0.08, discuss: 0.002 });
    assert.equal(tiny.perAccount.day.toFixed(2), "0.08");
    assert.equal(tiny.perAccount.session.toFixed(2), "0.08");
    assert.equal(tiny.perAccount.week.toFixed(2), "0.48");
    // The period backstop still wins if it's smaller than what the daily shares imply.
    const capped = planLimits({ ...plan, perAccountBudgetUsd: 10 }, { search: 0.08, discuss: 0.002 });
    assert.equal(capped.perAccount.week, 10);
    assert.equal(capped.perAccount.period, 10);
});

test("an account is stopped by its session, then day, week and period backstop", async () => {
    // A small daily allowance keeps the numbers easy to exhaust on purpose.
    // day=0.16 (2 searches), session=0.08 (half the day), week=0.96 (6 days'
    // worth), period=1.0 (a backstop just above a week, for this test only).
    const small = { id: "p-small", perAccountBudgetUsd: 1.0, periodDays: 30, accountDailyUsd: 0.16, visitorDailyUsd: 0.08 };
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
        // A new session 5h later still has day balance left (0.08 of 0.16 used),
        // so one more search runs; that exhausts the day. Checked from a third,
        // later session (so the session window itself is no longer the blocker),
        // the day total - not the session - is what's binding.
        const newSession = now + 5 * HOUR + 60000;
        assert.equal((await checkAccess(config, small, who, "search", newSession)).allowed, true);
        await chargeAccess(config, small, who, 0.08, {}, newSession);
        const dayBlocked = await checkAccess(config, small, who, "search", newSession + 5 * HOUR + 60000);
        assert.equal(dayBlocked.scope, "day");

        // Week: a separate account that has spent a whole week's allowance in one
        // go is still blocked the next day, even though that day's own window is
        // fresh - the week total, not the daily one, is what's binding here.
        const weekly = { id: "acc-week", activatedAt: new Date(now - HOUR).toISOString() };
        await chargeAccess(config, small, { account: weekly }, 0.96, {}, now);
        const weekBlocked = await checkAccess(config, small, { account: weekly }, "search", now + 2 * 24 * HOUR);
        assert.equal(weekBlocked.scope, "week");
        assert.equal(weekBlocked.resetsAt, new Date(now - HOUR + 7 * 24 * HOUR).toISOString(), "weeks count from the first sign-in");

        // Period: a generous backstop, independent of the day/week story, that
        // still eventually stops extreme cumulative abuse.
        const heavy = { id: "acc-heavy", activatedAt: new Date(now - HOUR).toISOString() };
        await chargeAccess(config, small, { account: heavy }, 1.0, {}, now);
        const periodBlocked = await checkAccess(config, small, { account: heavy }, "search", now + 10 * 24 * HOUR);
        assert.equal(periodBlocked.scope, "period");
        assert.equal((await accessStatus(config, small, { account: heavy }, now)).expiresAt, new Date(now - HOUR + 30 * 24 * HOUR).toISOString());
    });
});

test("a referral bonus temporarily raises the day limit, then expires", async () => {
    const small = { id: "p-bonus", perAccountBudgetUsd: 1.0, periodDays: 30, accountDailyUsd: 0.16, visitorDailyUsd: 0.08 };
    await withRedis(async () => {
        const now = Date.parse("2026-10-14T08:00:00Z");
        const boosted = { id: "acc-boost", activatedAt: new Date(now).toISOString(), bonusDayUsd: 0.16, bonusUntil: new Date(now + 24 * HOUR).toISOString() };
        // Two searches in two separate sessions use up the base 0.16 day limit.
        await chargeAccess(config, small, { account: boosted }, 0.08, {}, now);
        await chargeAccess(config, small, { account: boosted }, 0.08, {}, now + 5 * HOUR + 60000);
        // From a third, later session (so the session window itself has room
        // again), the base day limit would normally block - but the bonus
        // raises it to 0.32, so the account can still search.
        const checkTime = now + 10 * HOUR + 2 * 60000;
        assert.equal((await checkAccess(config, small, { account: boosted }, "search", checkTime)).allowed, true);
        const status = await accessStatus(config, small, { account: boosted }, checkTime);
        assert.equal(status.windows.day.limit, 0.32);
        assert.equal(status.windows.day.used, 0.16);
        assert.equal(status.bonusUntil, boosted.bonusUntil);
        // Once bonusUntil has passed, the account is back to the plain day limit.
        const afterBonus = await accessStatus(config, small, { account: boosted }, now + 25 * HOUR);
        assert.equal(afterBonus.windows.day.limit, 0.16);
        assert.equal(afterBonus.bonusUntil, null);
    });
});

test("expired and disabled accounts, and the shared visitor allowance", async () => {
    await withRedis(async () => {
        const now = Date.parse("2026-10-14T08:00:00Z");
        const expired = { id: "old", activatedAt: new Date(now - 366 * 24 * HOUR).toISOString() };
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
        // A brand-new account is nowhere near any of its own limits.
        assert.equal((await checkAccess(config, plan, { account }, "search", now)).allowed, true);
    });
});
