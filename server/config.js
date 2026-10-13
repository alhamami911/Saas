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

const PROVIDERS = ["claude", "gemini"];
const DEFAULT_PROVIDER = "claude";

// Google retired gemini-2.5-flash for new users; QL_GEMINI_MODEL overrides the default.
const DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";
const CLAUDE_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"];
const CLAUDE_EFFORTS = ["low", "medium", "high"];

// Estimated list prices in USD. Claude prices come from Anthropic's pricing page;
// Gemini 3.8 Flash prices are third-party reports and only feed estimates.
const MODEL_PRICES = {
    "claude-haiku-5-5": { input: 0.10, output: 0.50 },
    "claude-sonnet-5-5": { input: 2.00, output: 10.00 },
    "gemini-3.8-flash": { input: 0.75, output: 3.75 }
};
const CLAUDE_SEARCH_USD_PER_1000 = 10;

function geminiModel(env = process.env) {
    const model = env.QL_GEMINI_MODEL || DEFAULT_MODEL;
    if (!/^gemini-[a-z0-9.-]{1,60}$/.test(model)) throw new Error("QL_GEMINI_MODEL is not a valid Gemini model name");
    return model;
}

function claudeModel(env = process.env) {
    const model = env.QL_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
    if (!CLAUDE_MODELS.includes(model)) throw new Error(`QL_CLAUDE_MODEL must be one of ${CLAUDE_MODELS.join(", ")}`);
    return model;
}

function researchProvider(env = process.env) {
    const provider = env.QL_PROVIDER || DEFAULT_PROVIDER;
    if (!PROVIDERS.includes(provider)) throw new Error(`QL_PROVIDER must be one of ${PROVIDERS.join(", ")}`);
    return provider;
}

function getConfig(env = process.env) {
    const provider = researchProvider(env);
    const model = provider === "claude" ? claudeModel(env) : geminiModel(env);
    const effort = env.QL_CLAUDE_EFFORT || "low";
    if (!CLAUDE_EFFORTS.includes(effort)) throw new Error(`QL_CLAUDE_EFFORT must be one of ${CLAUDE_EFFORTS.join(", ")}`);
    const prices = MODEL_PRICES[model] || {};

    return {
        provider,
        model,
        apiKey: provider === "claude" ? env.qlook_claude_key : env.qlook_key,
        claudeEffort: effort,
        envatoToken: env.qlook_envato_token || null,
        githubToken: env.GITHUB_TOKEN || null,
        catalogEnabled: env.QL_CATALOG !== "off",
        // Upper bound on web searches per report; the actual allowance scales with
        // the requested count (see searchAllowance) so small reports stay cheap.
        claudeMaxSearches: numericSetting(env, "QL_CLAUDE_MAX_SEARCHES", 10, 1, 20),
        dailyBudgetUsd: numericSetting(env, "QL_DAILY_BUDGET_USD", 4, 0.1, 1000),
        redisUrl: env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, ""),
        redisToken: env.UPSTASH_REDIS_REST_TOKEN,
        rateLimitSalt: env.QL_RATE_LIMIT_SALT || env.qlook_key || env.qlook_claude_key,
        maxRequestsPerMinutePerIp: numericSetting(env, "QL_MAX_REQUESTS_PER_MINUTE_PER_IP", 3, 1, 100),
        maxRequestsPerDayPerIp: numericSetting(env, "QL_MAX_REQUESTS_PER_DAY_PER_IP", 30, 1, 1000),
        maxRequestsPerDayGlobal: numericSetting(env, "QL_MAX_REQUESTS_PER_DAY_GLOBAL", 200, 1, 100000),
        // Discussion messages about saved opportunities: one daily limit per visitor
        // across all opportunities and tabs, enforced by the server.
        discussPerDay: numericSetting(env, "QL_MAX_DISCUSS_PER_DAY", 30, 1, 1000),
        discussPerMinute: numericSetting(env, "QL_MAX_DISCUSS_PER_MINUTE", 6, 1, 100),
        maxSettingsCharacters: numericSetting(env, "QL_MAX_SETTINGS_CHARACTERS", 4000, 100, 20000),
        maxRequestBodyBytes: numericSetting(env, "QL_MAX_REQUEST_BODY_BYTES", 16000, 1000, 100000),
        maxOutputTokens: numericSetting(env, "QL_MAX_OUTPUT_TOKENS", 16384, 512, 32768),
        // nginx waits 90 s for the app; the catalogue and listing checks need ~10 s of that.
        requestTimeoutMs: provider === "claude"
            ? numericSetting(env, "QL_CLAUDE_TIMEOUT_MS", 75000, 5000, 75000)
            : numericSetting(env, "QL_GEMINI_TIMEOUT_MS", 25000, 1000, 55000),
        inputUsdPerMillionTokens: numericSetting(env, "QL_INPUT_USD_PER_MILLION", prices.input ?? 0.75, 0, 1000),
        outputUsdPerMillionTokens: numericSetting(env, "QL_OUTPUT_USD_PER_MILLION", prices.output ?? 3.75, 0, 1000),
        searchUsdPerThousandGroundedPrompts: numericSetting(env, "QL_SEARCH_USD_PER_1000_GROUNDED_PROMPTS", 35, 0, 10000),
        claudeSearchUsdPerThousand: CLAUDE_SEARCH_USD_PER_1000,
        searchFreeDailyPrompts: numericSetting(env, "QL_SEARCH_FREE_DAILY_PROMPTS", 0, 0, 1000000),
        usageRetentionDays: numericSetting(env, "QL_USAGE_RETENTION_DAYS", 90, 1, 365)
    };
}

// At $10 per 1,000 searches this keeps a report at about $0.06 (5), $0.08 (10)
// and $0.10 (20) in search fees.
const SEARCHES_BY_COUNT = { 5: 6, 10: 8, 20: 10 };

function searchAllowance(config, opportunityCount) {
    return Math.min(config.claudeMaxSearches, SEARCHES_BY_COUNT[opportunityCount] || 6);
}

// Gemini bills one fee per grounded prompt; Claude bills each web search it runs.
function estimateCosts(usage, config, isSearchBillable) {
    const promptTokens = Number(usage?.promptTokenCount) || 0;
    const completionTokens = (Number(usage?.candidatesTokenCount) || 0)
        + (Number(usage?.thoughtsTokenCount) || 0);
    const modelUsd = (promptTokens * config.inputUsdPerMillionTokens
        + completionTokens * config.outputUsdPerMillionTokens) / 1000000;
    let searchUsd = 0;
    if (config.provider === "claude") {
        searchUsd = (Number(usage?.webSearchRequests) || 0) * config.claudeSearchUsdPerThousand / 1000;
    } else if (isSearchBillable) {
        searchUsd = config.searchUsdPerThousandGroundedPrompts / 1000;
    }

    return {
        modelUsd: modelUsd.toFixed(6),
        searchUsd: searchUsd.toFixed(6),
        totalUsd: (modelUsd + searchUsd).toFixed(6),
        estimateBasis: "conservative_list_price"
    };
}

module.exports = {
    getConfig,
    geminiModel,
    claudeModel,
    researchProvider,
    estimateCosts,
    searchAllowance,
    DEFAULT_MODEL,
    DEFAULT_CLAUDE_MODEL,
    CLAUDE_MODELS,
    PROVIDERS
};
