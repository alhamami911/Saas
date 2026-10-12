"use strict";

function numericSetting(env, name, fallback, minimum, maximum) {
    const rawValue = env[name];
    if (rawValue === undefined || rawValue === "") return fallback;

    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be between ${minimum} and ${maximum}`);
    }
    return value;
}

// Google retired gemini-2.5-flash for new users; QL_GEMINI_MODEL overrides the default.
const DEFAULT_MODEL = "gemini-3.8-flash";

function geminiModel(env = process.env) {
    const model = env.QL_GEMINI_MODEL || DEFAULT_MODEL;
    if (!/^gemini-[a-z0-9.-]{1,60}$/.test(model)) throw new Error("QL_GEMINI_MODEL is not a valid Gemini model name");
    return model;
}

function getConfig(env = process.env) {
    return {
        model: geminiModel(env),
        apiKey: env.qlook_key,
        redisUrl: env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, ""),
        redisToken: env.UPSTASH_REDIS_REST_TOKEN,
        rateLimitSalt: env.QL_RATE_LIMIT_SALT || env.qlook_key,
        maxRequestsPerMinutePerIp: numericSetting(env, "QL_MAX_REQUESTS_PER_MINUTE_PER_IP", 2, 1, 100),
        maxRequestsPerDayPerIp: numericSetting(env, "QL_MAX_REQUESTS_PER_DAY_PER_IP", 10, 1, 1000),
        maxRequestsPerDayGlobal: numericSetting(env, "QL_MAX_REQUESTS_PER_DAY_GLOBAL", 100, 1, 100000),
        maxSettingsCharacters: numericSetting(env, "QL_MAX_SETTINGS_CHARACTERS", 4000, 100, 20000),
        maxRequestBodyBytes: numericSetting(env, "QL_MAX_REQUEST_BODY_BYTES", 16000, 1000, 100000),
        maxOutputTokens: numericSetting(env, "QL_MAX_OUTPUT_TOKENS", 16384, 512, 32768),
        requestTimeoutMs: numericSetting(env, "QL_GEMINI_TIMEOUT_MS", 25000, 1000, 55000),
        inputUsdPerMillionTokens: numericSetting(env, "QL_GEMINI_INPUT_USD_PER_MILLION", 0.30, 0, 1000),
        outputUsdPerMillionTokens: numericSetting(env, "QL_GEMINI_OUTPUT_USD_PER_MILLION", 2.50, 0, 1000),
        searchUsdPerThousandGroundedPrompts: numericSetting(env, "QL_SEARCH_USD_PER_1000_GROUNDED_PROMPTS", 35, 0, 10000),
        searchFreeDailyPrompts: numericSetting(env, "QL_SEARCH_FREE_DAILY_PROMPTS", 0, 0, 1000000),
        usageRetentionDays: numericSetting(env, "QL_USAGE_RETENTION_DAYS", 90, 1, 365)
    };
}

function estimateCosts(usage, config, isSearchBillable) {
    const promptTokens = Number(usage?.promptTokenCount) || 0;
    const completionTokens = (Number(usage?.candidatesTokenCount) || 0)
        + (Number(usage?.thoughtsTokenCount) || 0);
    const modelUsd = (promptTokens * config.inputUsdPerMillionTokens
        + completionTokens * config.outputUsdPerMillionTokens) / 1000000;
    const searchUsd = isSearchBillable
        ? config.searchUsdPerThousandGroundedPrompts / 1000
        : 0;

    return {
        modelUsd: modelUsd.toFixed(6),
        searchUsd: searchUsd.toFixed(6),
        totalUsd: (modelUsd + searchUsd).toFixed(6),
        estimateBasis: "conservative_list_price"
    };
}

module.exports = { getConfig, geminiModel, estimateCosts, DEFAULT_MODEL };