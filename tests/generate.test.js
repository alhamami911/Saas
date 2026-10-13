"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getConfig, estimateCosts, searchAllowance } = require("../server/config");
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

async function withTestEnvironment(run, overrides = { QL_PROVIDER: "gemini" }) {
    const names = ["qlook_key", "qlook_claude_key", "QL_PROVIDER", "QL_CLAUDE_MODEL", "QL_CATALOG", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
    const oldValues = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    Object.assign(process.env, {
        qlook_key: "test-only-key",
        UPSTASH_REDIS_REST_URL: "https://redis.example",
        UPSTASH_REDIS_REST_TOKEN: "test-only-token",
        QL_CATALOG: "off"
    }, overrides);
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
    const gemini = getConfig({ QL_PROVIDER: "gemini" });
    assert.deepEqual(estimateCosts({ promptTokenCount: 1000000, candidatesTokenCount: 1000000 }, gemini, true), {
        modelUsd: "4.500000",
        searchUsd: "0.035000",
        totalUsd: "4.535000",
        estimateBasis: "conservative_list_price"
    });
    assert.equal(estimateCosts({ promptTokenCount: 1000, candidatesTokenCount: 1000 }, gemini, false).searchUsd, "0.000000");

    // Claude bills each web search ($10 per 1,000) on top of Haiku 5.5 token prices.
    const claude = getConfig({});
    assert.deepEqual(estimateCosts({ promptTokenCount: 1000000, candidatesTokenCount: 1000000, webSearchRequests: 3 }, claude, true), {
        modelUsd: "0.600000",
        searchUsd: "0.030000",
        totalUsd: "0.630000",
        estimateBasis: "conservative_list_price"
    });
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
        assert.equal(result.errorCode, "RATE_LIMITED");
        assert.equal(result.retryAfter, 60);

        global.fetch = async () => mockResponse({ result: [1, 31, 1] });
        const daily = await checkRateLimit(
            { headers: { "x-qlook-client-ip": "203.0.113.4" } },
            { ...getConfig({}), redisUrl: "https://redis.example", redisToken: "test", rateLimitSalt: "salt" }
        );
        assert.equal(daily.errorCode, "DAILY_LIMIT_REACHED");
        assert.match(daily.error, /30 searches per day/);
        assert.ok(daily.retryAfter > 60);
    } finally {
        global.fetch = originalFetch;
    }
});

test("live listing check drops sold Flippa listings and keeps other sources", async () => {
    const { dropClosedListings } = require("../server/listing-check");
    const page = (title) => ({
        ok: true,
        url: "https://flippa.com/x",
        body: new Response(`<html><head><title>${title}</title></head></html>`).body
    });
    const originalFetch = global.fetch;
    const fetched = [];
    global.fetch = async (url) => {
        fetched.push(url);
        if (url.endsWith("/1")) return page("GetAdReady | SaaS Listing Ended on Flippa");
        if (url.endsWith("/2")) return page("Profitable SaaS | SaaS & Software Projects for Sale");
        throw new Error("offline");
    };
    try {
        const listing = (id) => ({ productName: id, directUrl: `https://flippa.com/${id}`, availability: { status: "unknown" } });
        const result = await dropClosedListings({
            opportunities: [listing("1"), listing("2"), listing("3"), { productName: "repo", directUrl: "https://github.com/a/b" }],
            verifiedCount: 4,
            excludedCount: 1
        });
        assert.deepEqual(result.opportunities.map((o) => o.productName), ["2", "3", "repo"]);
        assert.equal(result.verifiedCount, 3);
        assert.equal(result.excludedCount, 2);
        assert.equal(result.opportunities[0].availability.status, "available");
        assert.equal(result.opportunities[1].availability.status, "unknown");
        assert.ok(!fetched.some((url) => url.includes("github.com")));
    } finally {
        global.fetch = originalFetch;
    }
});

test("defaults to Claude Haiku 5.5 and validates provider and model settings", () => {
    const defaults = getConfig({ qlook_claude_key: "sk-ant-test", qlook_key: "AIza-test" });
    assert.equal(defaults.provider, "claude");
    assert.equal(defaults.model, "claude-haiku-5-5");
    assert.equal(defaults.apiKey, "sk-ant-test");
    assert.equal(defaults.requestTimeoutMs, 75000);
    assert.equal(getConfig({ QL_CLAUDE_MODEL: "claude-sonnet-5-5" }).model, "claude-sonnet-5-5");
    assert.throws(() => getConfig({ QL_CLAUDE_MODEL: "claude-unknown" }), /QL_CLAUDE_MODEL/);
    assert.throws(() => getConfig({ QL_PROVIDER: "openai" }), /QL_PROVIDER/);

    const gemini = getConfig({ QL_PROVIDER: "gemini", qlook_key: "AIza-test" });
    assert.equal(gemini.model, "gemini-3.8-flash");
    assert.equal(gemini.apiKey, "AIza-test");
    assert.equal(getConfig({ QL_PROVIDER: "gemini", QL_GEMINI_MODEL: "gemini-3.8-pro" }).model, "gemini-3.8-pro");
    assert.throws(() => getConfig({ QL_PROVIDER: "gemini", QL_GEMINI_MODEL: "../evil" }), /QL_GEMINI_MODEL/);
});

test("drops sold or ended listings and classifies commercial SaaS use from evidence", () => {
    const url = (name) => `https://${name}.example/item`;
    const item = (name, extra = {}) => ({
        productName: name, directUrl: url(name), originName: "Market", originType: "marketplace", originUrl: url(name),
        supportingSources: [], license: { name: null, status: "unverified", sourceUrl: null },
        price: { status: "unknown" }, verifiedFacts: [], estimates: [], ...extra
    });
    const verified = (name, license) => ({ license: { name: license, status: "verified", sourceUrl: url(name) } });
    const text = JSON.stringify({ summary: "", verificationNote: "", opportunities: [
        item("sold"),
        item("claimed-ended", { availability: { status: "ended", sourceUrl: url("claimed-ended") } }),
        item("agpl", verified("agpl", "AGPL-3.0")),
        item("mit", { ...verified("mit", "MIT"), availability: { status: "available", sourceUrl: url("mit") } }),
        item("regular", verified("regular", "Regular License")),
        item("lgpl", verified("lgpl", "LGPL-2.1")),
        item("unsourced", { commercialUse: { status: "allowed", note: "trust me", sourceUrl: "https://elsewhere.example/" } })
    ] });
    const chunks = ["sold", "claimed-ended", "agpl", "mit", "regular", "lgpl", "unsourced"].map((name) => ({
        web: { uri: url(name), title: name === "sold" ? "Profitable SaaS | SaaS Sold on Flippa" : name }
    }));
    const result = validateResearchResult(text, chunks, 20).value;
    assert.equal(result.excludedCount, 2);
    const byName = Object.fromEntries(result.opportunities.map((o) => [o.productName, o]));
    assert.deepEqual(Object.keys(byName), ["agpl", "mit", "regular", "lgpl", "unsourced"]);
    assert.equal(byName.agpl.commercialUse.status, "restricted");
    assert.equal(byName.regular.commercialUse.status, "restricted");
    assert.equal(byName.mit.commercialUse.status, "allowed");
    assert.equal(byName.lgpl.commercialUse.status, "allowed");
    assert.equal(byName.unsourced.commercialUse.status, "unclear");
    assert.equal(byName.mit.availability.status, "available");
    assert.equal(byName.agpl.availability.status, "unknown");
});

test("search allowance scales with the requested count within the cap", () => {
    const config = getConfig({});
    assert.deepEqual([5, 10, 20].map((count) => searchAllowance(config, count)), [6, 8, 10]);
    assert.equal(searchAllowance(getConfig({ QL_CLAUDE_MAX_SEARCHES: "4" }), 20), 4);
    assert.equal(config.dailyBudgetUsd, 2);
});

test("handler stops before calling the provider once the daily budget is spent", async () => {
    await withTestEnvironment(async () => {
        const originalFetch = global.fetch;
        let providerCalls = 0;
        global.fetch = async (url, options) => {
            if (!String(url).startsWith("https://redis.example")) { providerCalls += 1; throw new Error("provider must not be called"); }
            const command = JSON.parse(options.body);
            if (command[0] === "GET") return mockResponse({ result: "2.150000" });
            return mockResponse({ result: command[1].includes("local results") ? [1, 1, 1] : 0 });
        };
        try {
            const { handler } = require("../server/generate");
            const response = await handler({
                httpMethod: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ settings: "UAT", opportunityCount: 5 })
            });
            assert.equal(response.statusCode, 429);
            assert.equal(JSON.parse(response.body).errorCode, "DAILY_BUDGET_REACHED");
            assert.equal(providerCalls, 0);
        } finally {
            global.fetch = originalFetch;
        }
    });
});

test("extracts the JSON object when the model adds text around it", () => {
    const fixture = groundedResults(1);
    const result = validateResearchResult(`Here is the report:\n${fixture.text}\nDone.`, fixture.chunks, 5);
    assert.equal(result.value.verifiedCount, 1);
    assert.equal(validateResearchResult("no json at all", [], 5).errorCode, "INVALID_MODEL_JSON");
});

test("prompt requests JSON without asking Gemini for schema-enforced tool output", () => {
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
            assert.match(String(url), /\/models\/gemini-3\.8-flash:generateContent$/);
            const request = JSON.parse(options.body);
            lastPrompt = request.contents[0].parts[0].text;
            assert.equal(request.tools[0].googleSearch !== undefined, true);
            assert.equal(request.generationConfig.maxOutputTokens, getConfig({ QL_PROVIDER: "gemini" }).maxOutputTokens);
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
                    // The report follows the interface language.
                    body: JSON.stringify({ settings: "UAT", opportunityCount: count, language: count === 10 ? "en" : "ar" })
                });
                assert.equal(response.statusCode, 200);
                const data = JSON.parse(response.body);
                assert.match(lastPrompt, count === 10 ? /Return ONLY a JSON object in English/ : /Return ONLY a JSON object in Arabic/);
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
                    ? mode === "limited" ? [4, 1, 1] : [1, 1, 1]
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
            assert.equal(JSON.parse(response.body).errorCode, "AI_TIMEOUT");
        } finally {
            global.fetch = originalFetch;
        }
    });
});