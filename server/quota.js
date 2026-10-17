"use strict";

// Usage limits. The product is free: an account's day limit is a flat, moderate
// allowance (plan.accountDailyUsd) rather than a slice of a pool that runs out,
// spent across four windows, like Claude's own limits:
//   session - a 5-hour window that starts with the first use,
//   day     - the UTC day (the limit that actually matters day to day),
//   week    - 7-day windows counted from the account's first sign-in,
//   period  - the whole account lifetime (periodDays) - a generous backstop
//             against runaway abuse, not an everyday constraint.
// Visitors without an account share one small daily allowance instead.
// Limits are in estimated US dollars; the interface converts them into an
// approximate number of searches and messages.

const { redisCommand, utcDayInfo } = require("./usage-store");

const SESSION_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// session is half a day's allowance (so one sitting can't spend the whole day),
// week is six days' worth (a daily user never feels the week cap).
const SHARES = { session: 0.5, week: 6 };

function planLimits(plan, estimates) {
    const period = plan.perAccountBudgetUsd;
    const floor = estimates.search;
    const day = Math.min(period, Math.max(plan.accountDailyUsd, floor));
    const session = Math.min(day, Math.max(day * SHARES.session, floor));
    const week = Math.min(period, Math.max(day * SHARES.week, day));
    return { perAccount: { session, day, week, period }, visitorDay: Math.max(plan.visitorDailyUsd, 0) };
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
    // All anonymous visitors share one bucket: individual visitors are not
    // tracked, which is also why this allowance stays small.
    return { kind: "visitor", total: `${base}:total`, day: `${base}:v:day:${day}` };
}

const money = (value) => Math.round((Number(value) || 0) * 1e6) / 1e6;

// Current use of every window, with its limit and when it renews.
async function accessStatus(config, plan, who, now = Date.now()) {
    const estimates = { search: config.searchEstimateUsd, discuss: config.discussEstimateUsd };
    const limits = planLimits(plan, estimates);
    const keys = keysFor(plan, who, now);
    const tomorrow = Date.parse(`${utcDayInfo(now).day}T00:00:00.000Z`) + DAY_MS;
    if (keys.kind === "visitor") {
        const [day] = await redisCommand(config, ["MGET", keys.day]);
        return {
            kind: "visitor",
            estimates,
            windows: {
                day: { used: money(day), limit: money(limits.visitorDay), resetsAt: new Date(tomorrow).toISOString() }
            }
        };
    }
    const [sessionStart, session, day, week, period] = await redisCommand(config, ["MGET", keys.sessionStart, keys.session, keys.day, keys.weekKey, keys.period]);
    const periodEnds = keys.start + plan.periodDays * DAY_MS;
    // A session lasts 5 hours from its first use, whether or not its keys expired yet.
    const sessionOpen = Number(sessionStart) > 0 && now < Number(sessionStart) + SESSION_MS;
    // A referral (sending or accepting one) temporarily raises the day limit.
    const bonusActive = who.account.bonusUntil && now < Date.parse(who.account.bonusUntil);
    const dayLimit = limits.perAccount.day + (bonusActive ? Number(who.account.bonusDayUsd) || 0 : 0);
    return {
        kind: "account",
        estimates,
        activatedAt: who.account.activatedAt,
        expiresAt: new Date(periodEnds).toISOString(),
        expired: now >= periodEnds,
        disabled: Boolean(who.account.disabled),
        bonusUntil: bonusActive ? who.account.bonusUntil : null,
        windows: {
            session: { used: sessionOpen ? money(session) : 0, limit: money(limits.perAccount.session), resetsAt: sessionOpen ? new Date(Number(sessionStart) + SESSION_MS).toISOString() : null },
            day: { used: money(day), limit: money(dayLimit), resetsAt: new Date(tomorrow).toISOString() },
            week: { used: money(week), limit: money(limits.perAccount.week), resetsAt: new Date(Math.min(keys.start + (keys.week + 1) * WEEK_MS, periodEnds)).toISOString() },
            period: { used: money(period), limit: money(limits.perAccount.period), resetsAt: null }
        }
    };
}

// Decides whether one more search or message fits. Returns the blocking window.
async function checkAccess(config, plan, who, kind, now = Date.now()) {
    const status = await accessStatus(config, plan, who, now);
    const estimate = status.estimates[kind] || status.estimates.search;
    if (status.disabled) return { allowed: false, errorCode: "ACCOUNT_DISABLED", status };
    if (status.expired) return { allowed: false, errorCode: "ACCOUNT_EXPIRED", status };
    for (const scope of ["session", "day", "week", "period"]) {
        const window = status.windows[scope];
        if (!window) continue;
        // Soft limit: while a window has any balance left, the next request runs and
        // its real cost is charged afterwards (a cached search costs about a cent).
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

// Adds a request's estimated cost. The total key always counts what was spent
// (for the admin dashboard); the person's own windows count only requests that
// succeeded.
async function chargeAccess(config, plan, who, usd, { personal = true } = {}, now = Date.now()) {
    const amount = Number(usd);
    if (!(amount > 0)) return;
    const keys = keysFor(plan, who, now);
    const { secondsUntilTomorrow } = utcDayInfo(now);
    const longTtl = Math.ceil((plan.periodDays + 30) * 86400);
    const charge = [[keys.total, longTtl]];
    if (personal && keys.kind === "visitor") charge.push([keys.day, secondsUntilTomorrow]);
    if (personal && keys.kind === "account") {
        const sessionStart = Number(await redisCommand(config, ["EVAL", OPEN_SESSION, 2, keys.sessionStart, keys.session, String(now), String(SESSION_MS)]));
        const sessionTtl = Math.max(1, Math.ceil((sessionStart + SESSION_MS - now) / 1000));
        charge.push([keys.session, sessionTtl], [keys.day, secondsUntilTomorrow], [keys.weekKey, Math.ceil(WEEK_MS / 1000) + 86400], [keys.period, longTtl]);
    }
    await redisCommand(config, ["EVAL", CHARGE, charge.length, ...charge.map(([key]) => key), amount.toFixed(6), ...charge.map(([, ttl]) => String(ttl))]);
}

module.exports = { planLimits, accessStatus, checkAccess, chargeAccess, SHARES };
