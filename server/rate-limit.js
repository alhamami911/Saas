"use strict";

const { createHmac } = require("node:crypto");

const INCREMENT_WINDOWS = `
local results = {}
for i = 1, #KEYS do
  local count = redis.call('INCR', KEYS[i])
  if count == 1 then redis.call('EXPIRE', KEYS[i], ARGV[i]) end
  results[i] = count
end
return results
`;

function getClientIp(event) {
    const headers = event.headers || {};
    return headers["x-qlook-client-ip"] || "unknown";
}

// Visitors are identified only by a keyed hash of their IP address.
function clientHash(event, config) {
    return createHmac("sha256", config.rateLimitSalt).update(getClientIp(event)).digest("hex");
}

async function checkRateLimit(event, config, now = Date.now()) {
    if (!config.redisUrl || !config.redisToken || !config.rateLimitSalt) {
        return { allowed: false, statusCode: 503, errorCode: "RATE_LIMIT_UNAVAILABLE", error: "Request protection is not configured" };
    }

    const ipHash = clientHash(event, config);
    const minuteBucket = Math.floor(now / 60000);
    const day = new Date(now).toISOString().slice(0, 10);
    const secondsToNextDay = Math.ceil((Date.parse(`${day}T00:00:00.000Z`) + 86400000 - now) / 1000) + 60;
    const keys = [
        `ql:limit:ip-minute:${ipHash}:${minuteBucket}`,
        `ql:limit:ip-day:${ipHash}:${day}`,
        `ql:limit:global-day:${day}`
    ];
    const ttlSeconds = [75, secondsToNextDay, secondsToNextDay];

    try {
        const response = await fetch(config.redisUrl, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${config.redisToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(["EVAL", INCREMENT_WINDOWS, keys.length, ...keys, ...ttlSeconds]),
            signal: AbortSignal.timeout(3000)
        });
        const data = await response.json();
        if (!response.ok || data.error || !Array.isArray(data.result)) {
            throw new Error("Rate limit storage rejected the request");
        }

        const [minuteCount, dayCount, globalCount] = data.result.map(Number);
        if (![minuteCount, dayCount, globalCount].every(Number.isSafeInteger)
            || [minuteCount, dayCount, globalCount].some((count) => count < 0)) {
            throw new Error("Rate limit storage returned invalid counters");
        }
        if (dayCount > config.maxRequestsPerDayPerIp || globalCount > config.maxRequestsPerDayGlobal) {
            return {
                allowed: false,
                statusCode: 429,
                errorCode: "DAILY_LIMIT_REACHED",
                error: `Today's search limit has been reached (${config.maxRequestsPerDayPerIp} searches per day). Try again tomorrow.`,
                retryAfter: secondsToNextDay
            };
        }
        if (minuteCount > config.maxRequestsPerMinutePerIp) {
            return {
                allowed: false,
                statusCode: 429,
                errorCode: "RATE_LIMITED",
                error: "Too many searches in a short time. Wait one minute and try again.",
                retryAfter: 60
            };
        }
        return { allowed: true };
    } catch (error) {
        console.error("Rate limit storage unavailable", error.message);
        return { allowed: false, statusCode: 503, errorCode: "RATE_LIMIT_UNAVAILABLE", error: "Request protection is temporarily unavailable" };
    }
}

// Gives back the day's search when it failed, so a failed attempt is not charged.
async function refundRateLimit(event, config, now = Date.now()) {
    if (!config.redisUrl || !config.redisToken || !config.rateLimitSalt) return;
    const day = new Date(now).toISOString().slice(0, 10);
    const ipHash = clientHash(event, config);
    await fetch(config.redisUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.redisToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(["EVAL", "local v = tonumber(redis.call('GET', KEYS[1]) or '0') if v > 0 then return redis.call('DECR', KEYS[1]) end return 0", 1, `ql:limit:ip-day:${ipHash}:${day}`]),
        signal: AbortSignal.timeout(3000)
    });
}

module.exports = { checkRateLimit, refundRateLimit, clientHash };