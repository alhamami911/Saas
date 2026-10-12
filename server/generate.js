"use strict";

const { getConfig, estimateCosts, searchAllowance } = require("./config");
const { checkRateLimit } = require("./rate-limit");
const { createUsageEvent, storeUsage, dailySpendUsd, addDailySpend } = require("./usage-store");
const { buildResearchPrompt, validateRequest, validateResearchResult } = require("./research");
const { runGeminiResearch } = require("./providers/gemini");
const { runClaudeResearch } = require("./providers/claude");
const { dropClosedListings } = require("./listing-check");

const PROVIDER_LABELS = { claude: "Claude", gemini: "Gemini" };

function jsonResponse(statusCode, payload, extraHeaders = {}) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json", ...extraHeaders },
        body: JSON.stringify(payload)
    };
}

async function persistRequest(config, fields, usage, grounded) {
    const event = createUsageEvent({ provider: config.provider, model: config.model, ...fields, usage: usage || null, grounded });
    const stored = await storeUsage(config, event, grounded);
    const costs = estimateCosts(
        usage,
        config,
        grounded && stored.groundedPromptsToday > config.searchFreeDailyPrompts
    );
    event.groundedPromptsToday = stored.groundedPromptsToday;
    event.estimatedCosts = costs;
    event.spentTodayUsd = await addDailySpend(config, Number(costs.totalUsd));
    await storeUsage(config, event, false);
    return { requestId: event.requestId, usage: event.usage, costs };
}

async function persistFailure(config, fields, usage, grounded) {
    try {
        await persistRequest(config, fields, usage, grounded);
    } catch (error) {
        console.error("Could not persist failed request usage", error.message);
    }
}

exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return jsonResponse(405, { errorCode: "METHOD_NOT_ALLOWED", error: "Method Not Allowed" }, { Allow: "POST" });
    }

    let config;
    try {
        config = getConfig();
    } catch (error) {
        console.error("Invalid QLook environment configuration", error.message);
        return jsonResponse(500, { errorCode: "INVALID_SERVER_CONFIGURATION", error: "Server configuration is invalid" });
    }
    const label = PROVIDER_LABELS[config.provider];
    if (!config.apiKey) {
        console.error(`${label} API key is not configured`);
        return jsonResponse(503, {
            errorCode: config.provider === "claude" ? "CLAUDE_KEY_MISSING" : "GEMINI_KEY_MISSING",
            error: `${label} service is not configured`
        });
    }

    const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body || "", "base64").toString("utf8")
        : event.body || "";
    if (Buffer.byteLength(rawBody, "utf8") > config.maxRequestBodyBytes) {
        return jsonResponse(413, { errorCode: "REQUEST_TOO_LARGE", error: "Request body exceeds the allowed size" });
    }
    const contentType = event.headers?.["content-type"] || event.headers?.["Content-Type"];
    if (contentType && !contentType.toLowerCase().startsWith("application/json")) {
        return jsonResponse(415, { errorCode: "UNSUPPORTED_CONTENT_TYPE", error: "Send the request as application/json" });
    }

    let data;
    try {
        data = JSON.parse(rawBody);
    } catch (error) {
        return jsonResponse(400, { errorCode: "INVALID_JSON", error: "Invalid JSON request body" });
    }
    const validation = validateRequest(data, config);
    if (validation.error) {
        return jsonResponse(validation.statusCode, {
            errorCode: validation.errorCode,
            error: validation.error
        });
    }

    const limit = await checkRateLimit(event, config);
    if (!limit.allowed) {
        const headers = limit.retryAfter ? { "Retry-After": String(limit.retryAfter) } : {};
        return jsonResponse(limit.statusCode, { errorCode: limit.errorCode, error: limit.error }, headers);
    }

    // Stop before spending once today's estimated provider cost reaches the budget.
    let spentToday;
    try {
        spentToday = await dailySpendUsd(config);
    } catch (error) {
        console.error("Daily budget check failed", error.message);
        return jsonResponse(503, { errorCode: "BUDGET_CHECK_UNAVAILABLE", error: "Research is temporarily unavailable. Please retry shortly." });
    }
    if (spentToday >= config.dailyBudgetUsd) {
        console.error("Daily research budget reached", spentToday.toFixed(4), config.dailyBudgetUsd);
        return jsonResponse(429, {
            errorCode: "DAILY_BUDGET_REACHED",
            error: "Today's research budget has been used. Please try again tomorrow."
        }, { "Retry-After": "3600" });
    }

    // Reports are always written in Arabic, whatever language the interface uses.
    const request = { ...validation.value, language: "ar" };
    const prompt = buildResearchPrompt(request);
    const startedAt = Date.now();
    const result = config.provider === "claude"
        ? await runClaudeResearch(config, prompt, { maxSearches: searchAllowance(config, request.opportunityCount) })
        : await runGeminiResearch(config, prompt);
    const elapsedMs = Date.now() - startedAt;
    const baseFields = { requestedCount: request.opportunityCount, language: request.language, elapsedMs };
    console.log(`${label} research finished`, result.ok ? "ok" : result.kind, `${elapsedMs}ms`, `${result.sources?.length || 0} sources`);

    if (!result.ok) {
        await persistFailure(config, {
            ...baseFields,
            providerStatus: result.status,
            outcome: result.kind === "quota" ? "provider_quota_exceeded" : result.kind
        }, result.usage, false);
        console.error(`${label} request failed`, result.kind, result.status || "", result.message);
        if (result.kind === "timeout" || result.kind === "network") {
            const timedOut = result.kind === "timeout";
            return jsonResponse(timedOut ? 504 : 502, {
                errorCode: timedOut ? "AI_TIMEOUT" : "AI_UNAVAILABLE",
                error: timedOut ? `${label} request timed out. Try again.` : `${label} could not be reached`
            });
        }
        return jsonResponse(result.kind === "quota" ? 429 : 502, {
            errorCode: result.kind === "quota" ? "AI_QUOTA_EXCEEDED" : "AI_REQUEST_FAILED",
            error: result.kind === "quota"
                ? `${label} usage quota or credit is exhausted. Check the provider account and try again later.`
                : `${label} rejected the research request. Check the admin key test for details.`
        });
    }

    if (!result.text || result.truncated) {
        const errorCode = result.truncated ? "OUTPUT_LIMIT_REACHED" : "EMPTY_MODEL_RESPONSE";
        await persistFailure(config, { ...baseFields, outcome: errorCode.toLowerCase() }, result.usage, result.grounded);
        return jsonResponse(502, {
            errorCode,
            error: result.truncated
                ? `${label} reached the configured output limit. Retry with fewer opportunities.`
                : `${label} returned no research text`
        });
    }

    const groundingChunks = result.sources.map((source) => ({ web: source }));
    const research = validateResearchResult(result.text, groundingChunks, request.opportunityCount);
    if (research.error) {
        await persistFailure(config, { ...baseFields, outcome: research.errorCode }, result.usage, result.grounded);
        return jsonResponse(502, { errorCode: research.errorCode, error: research.error });
    }
    research.value = await dropClosedListings(research.value);

    let accounting;
    try {
        accounting = await persistRequest(config, {
            ...baseFields,
            verifiedCount: research.value.verifiedCount,
            excludedCount: research.value.excludedCount,
            outcome: "success"
        }, result.usage, result.grounded);
    } catch (error) {
        console.error("Usage accounting failed; withholding report", error.message);
        return jsonResponse(503, {
            errorCode: "USAGE_ACCOUNTING_UNAVAILABLE",
            error: "Usage tracking is temporarily unavailable. Please retry shortly."
        });
    }

    const usage = result.usage || {};
    return jsonResponse(200, {
        ...research.value,
        requestedCount: request.opportunityCount,
        provider: config.provider,
        model: config.model,
        elapsedMs,
        sources: [...new Map(result.sources
            .filter((source) => source?.uri)
            .map((source) => [source.uri, { title: source.title, url: source.uri }])).values()],
        usage: {
            promptTokens: usage.promptTokenCount || 0,
            completionTokens: usage.candidatesTokenCount || 0,
            thinkingTokens: usage.thoughtsTokenCount || 0,
            totalTokens: usage.totalTokenCount || 0,
            webSearches: usage.webSearchRequests || 0
        },
        estimatedCosts: accounting.costs,
        billingNote: `Estimated provider cost only. Actual charges are shown in the ${label} billing console.`,
        requestId: accounting.requestId
    });
};
