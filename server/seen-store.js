"use strict";

// Remembers which product links each visitor (keyed by a hash of their IP) has
// already been shown, so later searches from the same visitor bring new ones.
const SEEN_TTL_SECONDS = 14 * 24 * 60 * 60;
const MAX_SEEN = 300;

const ADD_SEEN = `
for i = 2, #ARGV do redis.call('SADD', KEYS[1], ARGV[i]) end
if redis.call('SCARD', KEYS[1]) > tonumber(ARGV[1]) then
  redis.call('SPOP', KEYS[1], redis.call('SCARD', KEYS[1]) - tonumber(ARGV[1]))
end
redis.call('EXPIRE', KEYS[1], ${SEEN_TTL_SECONDS})
return redis.call('SCARD', KEYS[1])
`;

async function redisCommand(config, command) {
    const response = await fetch(config.redisUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.redisToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(3000)
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error("Seen-store rejected the request");
    return data.result;
}

// Never blocks research: if Redis is unavailable the visitor simply may see a repeat.
async function seenLinks(config, visitor) {
    try {
        const result = await redisCommand(config, ["SMEMBERS", `ql:seen:${visitor}`]);
        return Array.isArray(result) ? result.filter((value) => typeof value === "string") : [];
    } catch (error) {
        console.error("Could not read seen opportunities", error.message);
        return [];
    }
}

async function rememberLinks(config, visitor, links) {
    if (!links.length) return;
    try {
        await redisCommand(config, ["EVAL", ADD_SEEN, 1, `ql:seen:${visitor}`, MAX_SEEN, ...links]);
    } catch (error) {
        console.error("Could not store seen opportunities", error.message);
    }
}

module.exports = { seenLinks, rememberLinks, SEEN_TTL_SECONDS };
