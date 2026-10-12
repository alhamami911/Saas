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

async function checkRateLimit(event, config, now = Date.now()) {
    if (!config.redisUrl || !config.redisToken || !config.rateLimitSalt) {
        return { allowed: false, statusCode: 503, errorCode: "RATE_LIMIT_UNAVAILABLE", error: "Request protection is not configured" };
    }

    const ipHash = createHmac("sha256", config.rateLimitSalt)
        .update(getClientIp(event))
        .digest("hex");
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
        if (minuteCount > config.maxRequestsPerMinutePerIp
            || dayCount > config.maxRequestsPerDayPerIp
            || globalCount > config.maxRequestsPerDayGlobal) {
            return {
                allowed: false,
                statusCode: 429,
                errorCode: "RATE_LIMITED",
                error: "Request quota reached. Try again later.",
                retryAfter: 60
            };
        }
        return { allowed: true };
    } catch (error) {
        console.error("Rate limit storage unavailable", error.message);
        return { allowed: false, statusCode: 503, errorCode: "RATE_LIMIT_UNAVAILABLE", error: "Request protection is temporarily unavailable" };
    }
}

module.exports = { checkRateLimit };