"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getConfig, estimateCosts } = require("../server/config");
const { checkRateLimit } = require("../server/rate-limit");
const { buildResearchPrompt, normalizePublicUrl, validateRequest, validateResearchResult } = require("../server/research");

const config = getConfig({});

function groundedResults(count) {
    const opportunities = Array.from({ length: count }, (_, index) => {
        const url = `https://product-${index + 1}.example/product`;
        return {
            productName: `Product ${index + 1}`,
            directUrl: url,
            originName: "Product repository",
            originType: "repository",
            originUrl: url,
            supportingSources: [{ title: `Product ${index + 1}`, url }],
            license: { name: null, status: "unverified", sourceUrl: null },
            price: { amount: null, currency: null, period: null, status: "unknown", sourceUrl: null },
            verifiedFacts: [{ claim: "Public product page", sourceUrl: url }],
            estimates: ["Revenue estimate unavailable"]
        };
    });
    return {
        text: JSON.stringify({ summary: "Verified research summary", verificationNote: "", opportunities }),
        chunks: opportunities.map((item) => ({ web: { uri: item.directUrl, title: item.productName } }))
    };
}

function mockResponse(data, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => data };
}

async function withTestEnvironment(run) {
    const names = ["qlook_key", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
    const oldValues = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
        qlook_key: "test-only-key",
        UPSTASH_REDIS_REST_URL: "https://redis.example",
        UPSTASH_REDIS_REST_TOKEN: "test-only-token"
    });
    try {
        await run();
    } finally {
        for (const name of names) {
            if (oldValues[name] === undefined) delete process.env[name];
            else process.env[name] = oldValues[name];
        }
    }
}

test("validates requested counts, language, and honeypot", () => {
    assert.equal(validateRequest({ settings: "research", opportunityCount: 5 }, config).value.opportunityCount, 5);
    assert.equal(validateRequest({ settings: "research", opportunityCount: 7 }, config).errorCode, "INVALID_OPPORTUNITY_COUNT");
    assert.equal(validateRequest({ settings: "research", opportunityCount: 10, language: "fr" }, config).errorCode, "INVALID_LANGUAGE");
    assert.equal(validateRequest({ settings: "research", opportunityCount: 20, website: "bot" }, config).errorCode, "AUTOMATED_REQUEST_REJECTED");
    assert.equal(validateRequest({ settings: "x".repeat(4001), opportunityCount: 5 }, config).errorCode, "SETTINGS_TOO_LONG");
});

test("accepts only safe public HTTP URLs and strips tracking parameters", () => {
    assert.equal(normalizePublicUrl("https://example.com/product/?utm_source=test#details"), "https://example.com/product");
    assert.equal(normalizePublicUrl("javascript:alert(1)"), null);
    assert.equal(normalizePublicUrl("http://127.0.0.1/admin"), null);
    assert.equal(normalizePublicUrl("http://service.local/admin"), null);
});

test("requires grounded sources, deduplicates products, and ties facts to evidence", () => {
    const fixture = groundedResults(2);
    fixture.text = JSON.stringify({
        summary: "Summary",
        verificationNote: "",
        opportunities: [
            JSON.parse(fixture.text).opportunities[0],
            { ...JSON.parse(fixture.text).opportunities[0], productName: "Duplicate" },
            { ...JSON.parse(fixture.text).opportunities[1], directUrl: "https://not-grounded.example/" }
        ]
    });
    const result = validateResearchResult(fixture.text, fixture.chunks, 5);
    assert.equal(result.value.verifiedCount, 1);
    assert.equal(result.value.excludedCount, 2);
    assert.equal(result.value.opportunities[0].verifiedFacts[0].url, fixture.chunks[0].web.uri);
    assert.equal(result.value.opportunities[0].confidence, "low");
});

test("rejects invalid JSON and caps results to the requested count", () => {
    assert.equal(validateResearchResult("not json", [], 5).errorCode, "INVALID_MODEL_JSON");
    const fixture = groundedResults(2);
    const fewer = validateResearchResult(fixture.text, fixture.chunks, 5);
    assert.equal(fewer.value.verifiedCount, 2);
    const result = validateResearchResult(fixture.text, fixture.chunks, 1);
    assert.equal(result.value.verifiedCount, 1);
    assert.equal(result.value.excludedCount, 1);
});

test("separates model and search cost estimates", () => {
    const pricing = getConfig({});
    assert.deepEqual(estimateCosts({ promptTokenCount: 1000000, candidatesTokenCount: 1000000 }, pricing, true), {
        modelUsd: "2.800000",
        searchUsd: "0.035000",
        totalUsd: "2.835000",
        estimateBasis: "conservative_list_price"
    });
    assert.equal(estimateCosts({ promptTokenCount: 1000, candidatesTokenCount: 1000 }, pricing, false).searchUsd, "0.000000");
});

test("rate limiter enforces shared minute, per-IP day and global-day limits", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => mockResponse({ result: [3, 1, 1] });
    try {
        const result = await checkRateLimit(
            { headers: { "x-qlook-client-ip": "203.0.113.4" } },
            { redisUrl: "https://redis.example", redisToken: "test", rateLimitSalt: "salt", maxRequestsPerMinutePerIp: 2, maxRequestsPerDayPerIp: 10, maxRequestsPerDayGlobal: 100 }
        );
        assert.equal(result.allowed, false);
        assert.equal(result.statusCode, 429);
    } finally {
        global.fetch = originalFetch;
    }
});

test("prompt requests JSON without asking Gemini 2.5 for schema-enforced tool output", () => {
    const prompt = buildResearchPrompt({ settings: "budget test", opportunityCount: 10, language: "ar", filters: [] });
    assert.match(prompt, /Return ONLY a JSON object in Arabic/);
    assert.match(prompt, /Produce at most 10 opportunities/);
    assert.match(prompt, /Do not invent opportunities/);
});

test("handler rejects missing key and invalid input without calling providers", async () => {
    await withTestEnvironment(async () => {
        const originalFetch = global.fetch;
        let fetchCalls = 0;
        global.fetch = async () => { fetchCalls += 1; throw new Error("unexpected network request"); };
        try {
            delete process.env.qlook_key;
            const { handler } = require("../server/generate");
            const missingKey = await handler({ httpMethod: "POST", body: "{}" });
            assert.equal(missingKey.statusCode, 503);
            assert.equal(JSON.parse(missingKey.body).errorCode, "GEMINI_KEY_MISSING");

            process.env.qlook_key = "test-only-key";
            const invalidInput = await handler({ httpMethod: "POST", body: JSON.stringify({ settings: "x", opportunityCount: 4 }) });
            assert.equal(invalidInput.statusCode, 400);
            assert.equal(JSON.parse(invalidInput.body).errorCode, "INVALID_OPPORTUNITY_COUNT");
            assert.equal(fetchCalls, 0);
        } finally {
            global.fetch = originalFetch;
        }
    });
});

test("mocked handler accepts 5, 10, and 20 results and returns per-opportunity citations", async () => {
    await withTestEnvironment(async () => {
        const originalFetch = global.fetch;
        let lastPrompt = "";
        global.fetch = async (url, options) => {
            if (String(url).startsWith("https://redis.example")) {
                const command = JSON.parse(options.body);
                return mockResponse({ result: command[1].includes("local results") ? [1, 1, 1] : Number(command[6]) ? 1 : 0 });
            }
            const request = JSON.parse(options.body);
            lastPrompt = request.contents[0].parts[0].text;
            assert.equal(request.tools[0].googleSearch !== undefined, true);
            assert.equal(request.generationConfig.maxOutputTokens, getConfig({}).maxOutputTokens);
            const count = Number(request.contents[0].parts[0].text.match(/Produce at most (\d+) opportunities/)[1]);
            const fixture = groundedResults(count);
            return mockResponse({
                candidates: [{
                    finishReason: "STOP",
                    content: { parts: [{ text: fixture.text }] },
                    groundingMetadata: { groundingChunks: fixture.chunks }
                }],
                usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 2000, thoughtsTokenCount: 100, totalTokenCount: 3100 }
            });
        };
        try {
            const { handler } = require("../server/generate");
            for (const count of [5, 10, 20]) {
                const response = await handler({
                    httpMethod: "POST",
                    headers: { "content-type": "application/json", "x-qlook-client-ip": "203.0.113.5" },
                    // An English interface still gets an Arabic report.
                    body: JSON.stringify({ settings: "UAT", opportunityCount: count, language: count === 10 ? "en" : "ar" })
                });
                assert.equal(response.statusCode, 200);
                const data = JSON.parse(response.body);
                assert.match(lastPrompt, /Return ONLY a JSON object in Arabic/);
                assert.equal(data.verifiedCount, count);
                assert.equal(data.requestedCount, count);
                assert.equal(data.opportunities.length, count);
                assert.ok(data.opportunities.every((item) => item.supportingSources.length > 0));
                assert.equal(data.estimatedCosts.actualBilling, undefined);
                assert.ok(data.requestId);
            }
        } finally {
            global.fetch = originalFetch;
        }
    });
});

test("handler maps provider quota responses and enforces rate limit before Gemini", async () => {
    await withTestEnvironment(async () => {
        const originalFetch = global.fetch;
        let mode = "quota";
        let geminiCalls = 0;
        global.fetch = async (url, options) => {
            if (String(url).startsWith("https://redis.example")) {
                const command = JSON.parse(options.body);
                return mockResponse({ result: command[1].includes("local results")
                    ? mode === "limited" ? [3, 1, 1] : [1, 1, 1]
                    : 0 });
            }
            geminiCalls += 1;
            return mode === "quota"
                ? mockResponse({ error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }, 429)
                : mockResponse({ candidates: [], usageMetadata: {} });
        };
        try {
            const { handler } = require("../server/generate");
            const input = { httpMethod: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: "UAT", opportunityCount: 5 }) };
            const quota = await handler(input);
            assert.equal(quota.statusCode, 429);
            assert.equal(JSON.parse(quota.body).errorCode, "AI_QUOTA_EXCEEDED");
            assert.equal(geminiCalls, 1);

            mode = "limited";
            const limited = await handler(input);
            assert.equal(limited.statusCode, 429);
            assert.equal(JSON.parse(limited.body).errorCode, "RATE_LIMITED");
            assert.equal(geminiCalls, 1);
        } finally {
            global.fetch = originalFetch;
        }
    });
});

test("handler converts Gemini timeout into a bounded 504 response", async () => {
    await withTestEnvironment(async () => {
        const originalFetch = global.fetch;
        global.fetch = async (url, options) => {
            if (String(url).startsWith("https://redis.example")) {
                const command = JSON.parse(options.body);
                return mockResponse({ result: command[1].includes("local results") ? [1, 1, 1] : 0 });
            }
            const error = new Error("simulated timeout");
            error.name = "TimeoutError";
            throw error;
        };
        try {
            const { handler } = require("../server/generate");
            const response = await handler({
                httpMethod: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ settings: "UAT", opportunityCount: 5 })
            });
            assert.equal(response.statusCode, 504);
            assert.equal(JSON.parse(response.body).errorCode, "GEMINI_TIMEOUT");
        } finally {
            global.fetch = originalFetch;
        }
    });
});