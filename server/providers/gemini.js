"use strict";

function providerMessage(data) {
    const message = data?.error?.message;
    return typeof message === "string" ? message.slice(0, 500) : "No provider error details";
}

// Runs one grounded Gemini request and returns the shared research result shape.
async function runGeminiResearch(config, prompt) {
    let response;
    let data;
    try {
        response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    tools: [{ googleSearch: {} }],
                    generationConfig: { maxOutputTokens: config.maxOutputTokens, temperature: 0.2 }
                }),
                signal: AbortSignal.timeout(config.requestTimeoutMs)
            }
        );
        data = await response.json();
    } catch (error) {
        const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
        return { ok: false, kind: timedOut ? "timeout" : "network", message: timedOut ? "timeout" : error.message };
    }

    const candidate = data?.candidates?.[0];
    const usage = data?.usageMetadata || null;
    const sources = (candidate?.groundingMetadata?.groundingChunks || [])
        .map((chunk) => chunk?.web)
        .filter((web) => web?.uri)
        .map((web) => ({ uri: web.uri, title: web.title }));

    if (!response.ok) {
        const message = providerMessage(data);
        const quota = response.status === 429
            || data?.error?.status === "RESOURCE_EXHAUSTED"
            || /quota|resource.?exhausted|rate.?limit|credits? (are|is) depleted/i.test(message);
        return { ok: false, kind: quota ? "quota" : "provider_error", status: response.status, message, usage, sources };
    }

    const text = candidate?.content?.parts?.map((part) => part.text).filter(Boolean).join("") || "";
    return {
        ok: true,
        text,
        truncated: candidate?.finishReason === "MAX_TOKENS",
        sources,
        grounded: sources.length > 0,
        usage
    };
}

module.exports = { runGeminiResearch };
