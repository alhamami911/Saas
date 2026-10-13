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

const ADD_SPEND = `
local total = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return total
`;

async function redisCommand(config, command) {
    if (!config.redisUrl || !config.redisToken) throw new Error("Usage storage is not configured");
    const response = await fetch(config.redisUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.redisToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(3000)
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error("Usage storage rejected the request");
    return data.result;
}

// Estimated provider spend for the current UTC day, used to keep research
// within the daily budget the operator sets.
async function dailySpendUsd(config, now = Date.now()) {
    const { day } = utcDayInfo(now);
    return Number(await redisCommand(config, ["GET", `ql:spend:usd:${day}`])) || 0;
}

async function addDailySpend(config, usd, now = Date.now()) {
    if (!(usd > 0)) return dailySpendUsd(config, now);
    const { day, secondsUntilTomorrow } = utcDayInfo(now);
    const total = await redisCommand(config, ["EVAL", ADD_SPEND, 1, `ql:spend:usd:${day}`, usd.toFixed(6), secondsUntilTomorrow]);
    return Number(total) || 0;
}

function createUsageEvent(fields) {
    return {
        requestId: randomUUID(),
        createdAt: new Date().toISOString(),
        provider: fields.provider || "claude",
        actualProviderBilling: "not_available_from_api_response",
        ...fields
    };
}

// The most recent requests, newest first, for the admin cost view.
const RECENT_KEY = "ql:usage:recent";
async function recordRecent(config, event) {
    const entry = {
        requestId: event.requestId,
        createdAt: event.createdAt,
        kind: event.kind || "search",
        outcome: event.outcome,
        model: event.model,
        elapsedMs: event.elapsedMs,
        verifiedCount: event.verifiedCount ?? null,
        reviewCount: event.reviewCount ?? null,
        coverage: event.coverage || null,
        usage: event.usage || null,
        estimatedCosts: event.estimatedCosts || null
    };
    await redisCommand(config, ["EVAL", "redis.call('LPUSH', KEYS[1], ARGV[1]) redis.call('LTRIM', KEYS[1], 0, 199) return 1", 1, RECENT_KEY, JSON.stringify(entry)]);
}

async function recentUsage(config, count = 50) {
    const rows = await redisCommand(config, ["LRANGE", RECENT_KEY, 0, Math.max(0, count - 1)]);
    return (Array.isArray(rows) ? rows : []).map((row) => {
        try {
            return JSON.parse(row);
        } catch (error) {
            return null;
        }
    }).filter(Boolean);
}

module.exports = { createUsageEvent, storeUsage, utcDayInfo, dailySpendUsd, addDailySpend, recordRecent, recentUsage, redisCommand };