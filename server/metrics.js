"use strict";

// A minimal first-party funnel counter: pageviews, sign-ups and searches per
// UTC day, so the admin dashboard can see visits -> sign-ups -> searches
// without wiring up an external analytics account.

const { redisCommand, utcDayInfo } = require("./usage-store");

const EVENTS = ["pageview", "signup", "search"];
const RETENTION_DAYS = 90;
const INCR_AND_EXPIRE = "local n = redis.call('INCR', KEYS[1]) redis.call('EXPIRE', KEYS[1], ARGV[1]) return n";

// Fire-and-forget: a funnel counter must never slow down or fail a request.
function recordEvent(config, name, now = Date.now()) {
    if (!config.redisUrl || !config.redisToken) return;
    const { day, secondsUntilTomorrow } = utcDayInfo(now);
    const ttl = secondsUntilTomorrow + RETENTION_DAYS * 86400;
    redisCommand(config, ["EVAL", INCR_AND_EXPIRE, 1, `ql:metric:${name}:${day}`, String(ttl)]).catch(() => {});
}

// The last `days` UTC days (oldest first) of pageview/sign-up/search counts.
async function funnel(config, days = 14, now = Date.now()) {
    const dates = [];
    for (let i = days - 1; i >= 0; i -= 1) dates.push(utcDayInfo(now - i * 86400000).day);
    const keys = [];
    for (const event of EVENTS) for (const day of dates) keys.push(`ql:metric:${event}:${day}`);
    const values = await redisCommand(config, ["MGET", ...keys]);
    const byEvent = {};
    EVENTS.forEach((event, eventIndex) => {
        byEvent[event] = dates.map((day, dayIndex) => Number(values[eventIndex * dates.length + dayIndex]) || 0);
    });
    return { dates, ...byEvent };
}

module.exports = { recordEvent, funnel };
