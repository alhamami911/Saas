"use strict";

const { randomUUID } = require("node:crypto");

const STORE_USAGE = `
local groundedCount = tonumber(redis.call('GET', KEYS[1])) or 0
if ARGV[2] == '1' then
  groundedCount = redis.call('INCR', KEYS[1])
  if groundedCount == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
end
local event = cjson.decode(ARGV[1])
event.groundedPromptsToday = groundedCount
redis.call('SET', KEYS[2], cjson.encode(event), 'EX', ARGV[4])
return groundedCount
`;

function utcDayInfo(now = Date.now()) {
    const date = new Date(now);
    const day = date.toISOString().slice(0, 10);
    const tomorrow = Date.parse(`${day}T00:00:00.000Z`) + 86400000;
    return { day, secondsUntilTomorrow: Math.ceil((tomorrow - now) / 1000) + 60 };
}

async function storeUsage(config, usageEvent, grounded, now = Date.now()) {
    if (!config.redisUrl || !config.redisToken) throw new Error("Usage storage is not configured");
    const { day, secondsUntilTomorrow } = utcDayInfo(now);
    const expiresIn = Math.ceil(config.usageRetentionDays * 86400);
    const keys = [`ql:grounded:count:${day}`, `ql:usage:${usageEvent.requestId}`];

    const response = await fetch(config.redisUrl, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.redisToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify([
            "EVAL",
            STORE_USAGE,
            keys.length,
            ...keys,
            JSON.stringify(usageEvent),
            grounded ? "1" : "0",
            secondsUntilTomorrow,
            expiresIn
        ]),
        signal: AbortSignal.timeout(3000)
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error("Could not persist request usage");
    return { requestId: usageEvent.requestId, groundedPromptsToday: Number(data.result) || 0 };
}

function createUsageEvent(fields) {
    return {
        requestId: randomUUID(),
        createdAt: new Date().toISOString(),
        provider: "google_gemini",
        model: "gemini-2.5-flash",
        actualProviderBilling: "not_available_from_api_response",
        ...fields
    };
}

module.exports = { createUsageEvent, storeUsage, utcDayInfo };