"use strict";

const { getConfig, estimateCosts } = require("./config");
const { checkRateLimit } = require("./rate-limit");
const { createUsageEvent, storeUsage } = require("./usage-store");
const { buildResearchPrompt, validateRequest, validateResearchResult } = require("./research");

function jsonResponse(statusCode, payload, extraHeaders = {}) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json", ...extraHeaders },
        body: JSON.stringify(payload)
    };
}

function safeProviderMessage(data) {
    const message = data?.error?.message;
    return typeof message === "string" ? message.slice(0, 500) : "No provider error details";
}

async function persistRequest(config, fields, usage, grounded) {
    const event = createUsageEvent({ model: config.model, ...fields, usage: usage || null, grounded });
    const stored = await storeUsage(config, event, grounded);
    const costs = estimateCosts(
        usage,
        config,
        grounded && stored.groundedPromptsToday > config.searchFreeDailyPrompts
    );
    event.groundedPromptsToday = stored.groundedPromptsToday;
    event.estimatedCosts = costs;
    await storeUsage(config, event, false);
    return { requestId: event.requestId, usage: event.usage, costs };
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
    if (!config.apiKey) {
        console.error("qlook_key is not configured");
        return jsonResponse(503, { errorCode: "GEMINI_KEY_MISSING", error: "Gemini service is not configured" });
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

    // Reports are always written in Arabic, whatever language the interface uses.
    const request = { ...validation.value, language: "ar" };
    const prompt = buildResearchPrompt(request);
    let providerResponse;
    let providerData;
    try {
        providerResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": config.apiKey
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    tools: [{ googleSearch: {} }],
                    generationConfig: {
                        maxOutputTokens: config.maxOutputTokens,
                        temperature: 0.2
                    }
                }),
                signal: AbortSignal.timeout(config.requestTimeoutMs)
            }
        );
        providerData = await providerResponse.json();
    } catch (error) {
        const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
        console.error("Gemini request failed", timedOut ? "timeout" : error.message);
        try {
            await persistRequest(config, {
                requestedCount: request.opportunityCount,
                language: request.language,
                outcome: timedOut ? "timeout" : "network_error"
            }, null, false);
        } catch (usageError) {
            console.error("Could not persist failed request usage", usageError.message);
        }
        return jsonResponse(timedOut ? 504 : 502, {
            errorCode: timedOut ? "GEMINI_TIMEOUT" : "GEMINI_UNAVAILABLE",
            error: timedOut ? "Gemini request timed out. Try again." : "Gemini could not be reached"
        });
    }

    const candidate = providerData?.candidates?.[0];
    const usage = providerData?.usageMetadata || null;
    const groundingChunks = candidate?.groundingMetadata?.groundingChunks || [];

    if (!providerResponse.ok) {
        const providerMessage = safeProviderMessage(providerData);
        const quotaExceeded = providerResponse.status === 429
            || providerData?.error?.status === "RESOURCE_EXHAUSTED"
            || /quota|resource.?exhausted|rate.?limit/i.test(providerMessage);
        try {
            await persistRequest(config, {
                requestedCount: request.opportunityCount,
                language: request.language,
                providerStatus: providerResponse.status,
                outcome: quotaExceeded ? "provider_quota_exceeded" : "provider_error"
            }, usage, false);
        } catch (usageError) {
            console.error("Could not persist failed request usage", usageError.message);
        }
        console.error("Gemini API request failed", providerResponse.status, providerMessage);
        return jsonResponse(quotaExceeded ? 429 : 502, {
            errorCode: quotaExceeded ? "AI_QUOTA_EXCEEDED" : "GEMINI_REQUEST_FAILED",
            error: quotaExceeded
                ? "Gemini usage quota reached. Check the provider quota and try again later."
                : "Gemini rejected the research request. Check server logs for provider details."
        });
    }

    const responseText = candidate?.content?.parts
        ?.map((part) => part.text)
        .filter(Boolean)
        .join("");
    if (!responseText || candidate.finishReason === "MAX_TOKENS") {
        const errorCode = candidate?.finishReason === "MAX_TOKENS" ? "OUTPUT_LIMIT_REACHED" : "EMPTY_MODEL_RESPONSE";
        try {
            await persistRequest(config, {
                requestedCount: request.opportunityCount,
                language: request.language,
                outcome: errorCode.toLowerCase()
            }, usage, groundingChunks.length > 0);
        } catch (usageError) {
            console.error("Could not persist incomplete request usage", usageError.message);
        }
        return jsonResponse(502, {
            errorCode,
            error: errorCode === "OUTPUT_LIMIT_REACHED"
                ? "Gemini reached the configured output limit. Retry with fewer opportunities."
                : "Gemini returned no research text"
        });
    }

    const research = validateResearchResult(
        responseText,
        groundingChunks,
        request.opportunityCount
    );
    if (research.error) {
        try {
            await persistRequest(config, {
                requestedCount: request.opportunityCount,
                outcome: research.errorCode
            }, usage, groundingChunks.length > 0);
        } catch (usageError) {
            console.error("Could not persist invalid model response usage", usageError.message);
        }
        return jsonResponse(502, { errorCode: research.errorCode, error: research.error });
    }

    let accounting;
    try {
        accounting = await persistRequest(config, {
            requestedCount: request.opportunityCount,
            verifiedCount: research.value.verifiedCount,
            excludedCount: research.value.excludedCount,
            language: request.language,
            outcome: "success"
        }, usage, groundingChunks.length > 0);
    } catch (error) {
        console.error("Usage accounting failed; withholding report", error.message);
        return jsonResponse(503, {
            errorCode: "USAGE_ACCOUNTING_UNAVAILABLE",
            error: "Usage tracking is temporarily unavailable. Please retry shortly."
        });
    }

    return jsonResponse(200, {
        ...research.value,
        requestedCount: request.opportunityCount,
        sources: [...new Map(groundingChunks
            .map((chunk) => chunk?.web)
            .filter((web) => web?.uri)
            .map((web) => [web.uri, { title: web.title, url: web.uri }])).values()],
        usage: {
            promptTokens: usage?.promptTokenCount || 0,
            completionTokens: usage?.candidatesTokenCount || 0,
            thinkingTokens: usage?.thoughtsTokenCount || 0,
            totalTokens: usage?.totalTokenCount || 0
        },
        estimatedCosts: accounting.costs,
        billingNote: "Estimated provider cost only. Actual charges and shared project quotas are shown in Google AI Studio/Cloud billing.",
        requestId: accounting.requestId
    });
};