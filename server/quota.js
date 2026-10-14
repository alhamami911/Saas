"use strict";

// Trial usage limits. The plan's credit budget (minus a reserve) is split into a
// small shared visitor pool and equal shares for the trial accounts. Each
// account's share is spent across four windows, like Claude's own limits:
//   session - a 5-hour window that starts with the first use,
//   day     - the UTC day,
//   week    - 7-day windows counted from the account's first sign-in,
//   period  - the whole trial (periodDays from the first sign-in).
// Limits are in estimated US dollars; the interface converts them into an
// approximate number of searches and messages.

const { redisCommand, utcDayInfo } = require("./usage-store");

const SESSION_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHARES = { session: 0.06, day: 0.12, week: 0.35 };

function planLimits(plan, estimates) {
    const usable = plan.totalBudgetUsd * (1 - plan.reservePct / 100);
    const visitorPool = plan.totalBudgetUsd * plan.visitorSharePct / 100;
    const accountPool = Math.max(0, usable - visitorPool);
    const period = accountPool / plan.accounts;
    // Every window allows at least one search, as long as the period has room.
    const floor = estimates.search;
    const session = Math.min(period, Math.max(period * SHARES.session, floor));
    const day = Math.min(period, Math.max(period * SHARES.day, session));
    const week = Math.min(period, Math.max(period * SHARES.week, day));
    const visitorDay = Math.min(visitorPool, Math.max(visitorPool / plan.periodDays, floor));
    return { usable, visitorPool, accountPool, perAccount: { session, day, week, period }, visitorDay };
}

function keysFor(plan, who, now) {
    const base = `ql:q:${plan.id}`;
    const { day } = utcDayInfo(now);
    if (who.account) {
        const start = Date.parse(who.account.activatedAt || new Date(now).toISOString());
        const week = Math.max(0, Math.floor((now - start) / WEEK_MS));
        const a = `${base}:a:${who.account.id}`;
        return { kind: "account", start, week, total: `${base}:total`, sessionStart: `${a}:sess:start`, session: `${a}:sess:spent`, day: `${a}:day:${day}`, weekKey: `${a}:week:${week}`, period: `${a}:period` };
    }
    return { kind: "visitor", total: `${base}:total`, day: `${base}:v:day:${day}`, period: `${base}:v:period` };
}

const money = (value) => Math.round((Number(value) || 0) * 1e6) / 1e6;

// Current use of every window, with its limit and when it renews.
async function accessStatus(config, plan, who, now = Date.now()) {
    const estimates = { search: config.searchEstimateUsd, discuss: config.discussEstimateUsd };
    const limits = planLimits(plan, estimates);
    const keys = keysFor(plan, who, now);
    const tomorrow = Date.parse(`${utcDayInfo(now).day}T00:00:00.000Z`) + DAY_MS;
    if (keys.kind === "visitor") {
        const [total, day, period] = await redisCommand(config, ["MGET", keys.total, keys.day, keys.period]);
        return {
            kind: "visitor",
            estimates,
            planUsed: money(total),
            planUsable: money(limits.usable),
            windows: {
                day: { used: money(day), limit: money(limits.visitorDay), resetsAt: new Date(tomorrow).toISOString() },
                period: { used: money(period), limit: money(limits.visitorPool), resetsAt: null }
            }
        };
    }
    const [total, sessionStart, session, day, week, period] = await redisCommand(config, ["MGET", keys.total, keys.sessionStart, keys.session, keys.day, keys.weekKey, keys.period]);
    const periodEnds = keys.start + plan.periodDays * DAY_MS;
    // A session lasts 5 hours from its first use, whether or not its keys expired yet.
    const sessionOpen = Number(sessionStart) > 0 && now < Number(sessionStart) + SESSION_MS;
    return {
        kind: "account",
        estimates,
        planUsed: money(total),
        planUsable: money(limits.usable),
        activatedAt: who.account.activatedAt,
        expiresAt: new Date(periodEnds).toISOString(),
        expired: now >= periodEnds,
        disabled: Boolean(who.account.disabled),
        windows: {
            session: { used: sessionOpen ? money(session) : 0, limit: money(limits.perAccount.session), resetsAt: sessionOpen ? new Date(Number(sessionStart) + SESSION_MS).toISOString() : null },
            day: { used: money(day), limit: money(limits.perAccount.day), resetsAt: new Date(tomorrow).toISOString() },
            week: { used: money(week), limit: money(limits.perAccount.week), resetsAt: new Date(Math.min(keys.start + (keys.week + 1) * WEEK_MS, periodEnds)).toISOString() },
            period: { used: money(period), limit: money(limits.perAccount.period), resetsAt: null }
        }
    };
}

// Decides whether one more search or message fits. Returns the blocking window.
async function checkAccess(config, plan, who, kind, now = Date.now()) {
    const status = await accessStatus(config, plan, who, now);
    const estimate = status.estimates[kind] || status.estimates.search;
    if (status.planUsed + estimate > status.planUsable) return { allowed: false, errorCode: "PLAN_BUDGET_EXHAUSTED", status };
    if (status.disabled) return { allowed: false, errorCode: "ACCOUNT_DISABLED", status };
    if (status.expired) return { allowed: false, errorCode: "ACCOUNT_EXPIRED", status };
    for (const scope of ["session", "day", "week", "period"]) {
        const window = status.windows[scope];
        if (!window) continue;
        // Soft limit: while a window has any balance left, the next request runs and
        // its real cost is charged afterwards (a cached search costs about a cent).
        // The plan total above still uses the full estimate, so the credit is safe.
        if (window.used >= window.limit - 1e-9) {
            return {
                allowed: false,
                errorCode: status.kind === "account" ? "ACCOUNT_LIMIT" : "VISITOR_LIMIT",
                scope,
                resetsAt: window.resetsAt || (scope === "period" ? status.expiresAt || null : null),
                status
            };
        }
    }
    return { allowed: true, status };
}

const CHARGE = `
for i = 1, #KEYS do
  redis.call('INCRBYFLOAT', KEYS[i], ARGV[1])
  redis.call('EXPIRE', KEYS[i], ARGV[i + 1])
end
return 1
`;
const OPEN_SESSION = `
local start = tonumber(redis.call('GET', KEYS[1]) or '0')
if start == 0 or start + tonumber(ARGV[2]) <= tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  redis.call('SET', KEYS[2], '0', 'PX', ARGV[2])
end
return redis.call('GET', KEYS[1])
`;

// Adds a request's estimated cost. The plan total always counts what was spent;
// the person's own windows count only requests that succeeded.
async function chargeAccess(config, plan, who, usd, { personal = true } = {}, now = Date.now()) {
    const amount = Number(usd);
    if (!(amount > 0)) return;
    const keys = keysFor(plan, who, now);
    const { secondsUntilTomorrow } = utcDayInfo(now);
    const longTtl = Math.ceil((plan.periodDays + 30) * 86400);
    const charge = [[keys.total, longTtl]];
    if (personal && keys.kind === "visitor") charge.push([keys.day, secondsUntilTomorrow], [keys.period, longTtl]);
    if (personal && keys.kind === "account") {
        const sessionStart = Number(await redisCommand(config, ["EVAL", OPEN_SESSION, 2, keys.sessionStart, keys.session, String(now), String(SESSION_MS)]));
        const sessionTtl = Math.max(1, Math.ceil((sessionStart + SESSION_MS - now) / 1000));
        charge.push([keys.session, sessionTtl], [keys.day, secondsUntilTomorrow], [keys.weekKey, Math.ceil(WEEK_MS / 1000) + 86400], [keys.period, longTtl]);
    }
    await redisCommand(config, ["EVAL", CHARGE, charge.length, ...charge.map(([key]) => key), amount.toFixed(6), ...charge.map(([, ttl]) => String(ttl))]);
}

module.exports = { planLimits, accessStatus, checkAccess, chargeAccess, SHARES };
