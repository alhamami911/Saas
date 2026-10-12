"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { setClientFactory, webSearchTool, testClaudeKey } = require("../server/providers/claude");

const PRODUCT = "https://codecanyon.net/item/saas-starter/123";
const ORIGIN = "https://codecanyon.net/category/php-scripts";

function report() {
    return JSON.stringify({
        summary: "ملخص",
        verificationNote: "CodeCanyon checked",
        opportunities: [{
            productName: "SaaS Starter",
            directUrl: PRODUCT,
            originName: "CodeCanyon",
            originType: "marketplace",
            originUrl: ORIGIN,
            supportingSources: [{ title: "SaaS Starter", url: PRODUCT }],
            license: { name: "Regular", status: "verified", sourceUrl: PRODUCT },
            price: { amount: "49", currency: "USD", period: "one-time", status: "verified", sourceUrl: PRODUCT },
            verifiedFacts: [{ claim: "Multi-tenant", sourceUrl: PRODUCT }],
            estimates: []
        }]
    });
}

function message(stopReason, content, usage = {}) {
    return {
        stop_reason: stopReason,
        content,
        usage: { input_tokens: 1000, output_tokens: 500, output_tokens_details: { thinking_tokens: 100 }, server_tool_use: { web_search_requests: 1 }, ...usage }
    };
}

function fakeClient(responses, calls) {
    return () => ({
        messages: {
            stream(params, options) {
                calls.push({ params: JSON.parse(JSON.stringify(params)), options });
                const next = responses.shift();
                return { finalMessage: async () => { if (next instanceof Error) throw next; return next; } };
            },
            create: async () => responses.shift()
        },
        models: { retrieve: async (model) => ({ id: model }) }
    });
}

async function withClaude(responses, run) {
    const names = ["qlook_key", "qlook_claude_key", "QL_PROVIDER", "QL_CLAUDE_MODEL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
    const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    Object.assign(process.env, {
        qlook_claude_key: "sk-ant-test-only-key-0123456789",
        UPSTASH_REDIS_REST_URL: "https://redis.example",
        UPSTASH_REDIS_REST_TOKEN: "test-only-token"
    });
    const calls = [];
    const previous = setClientFactory(fakeClient(responses, calls));
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
        const command = JSON.parse(options.body);
        const result = command[1].includes("local results") ? [1, 1, 1] : Number(command[6]) ? 1 : 0;
        return { ok: true, status: 200, json: async () => ({ result }) };
    };
    try {
        const { handler } = require("../server/generate");
        const call = (body) => handler({
            httpMethod: "POST",
            headers: { "content-type": "application/json", "x-qlook-client-ip": "203.0.113.9" },
            body: JSON.stringify({ settings: "UAT", opportunityCount: 5, language: "en", ...body })
        });
        await run({ call, calls });
    } finally {
        global.fetch = originalFetch;
        setClientFactory(previous);
        for (const name of names) {
            if (old[name] === undefined) delete process.env[name];
            else process.env[name] = old[name];
        }
    }
}

test("Claude research resumes paused turns and verifies real search URLs", async () => {
    const searchResults = {
        type: "web_search_tool_result",
        content: [
            { type: "web_search_result", url: PRODUCT, title: "SaaS Starter" },
            { type: "web_search_result", url: ORIGIN, title: "PHP Scripts" }
        ]
    };
    const json = report();
    const responses = [
        message("pause_turn", [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }, searchResults]),
        message("end_turn", [
            { type: "text", text: `Here is the report: ${json.slice(0, 40)}` },
            { type: "text", text: json.slice(40), citations: [{ type: "web_search_result_location", url: PRODUCT, title: "SaaS Starter" }] }
        ], { server_tool_use: { web_search_requests: 2 } })
    ];
    await withClaude(responses, async ({ call, calls }) => {
        const response = await call();
        assert.equal(response.statusCode, 200);
        const data = JSON.parse(response.body);
        assert.equal(data.provider, "claude");
        assert.equal(data.model, "claude-haiku-5-5");
        assert.equal(data.verifiedCount, 1);
        assert.equal(data.opportunities[0].directUrl, PRODUCT);
        assert.equal(data.opportunities[0].license.status, "verified");
        assert.equal(data.usage.webSearches, 3);
        assert.equal(data.usage.promptTokens, 2000);
        assert.equal(data.usage.thinkingTokens, 200);
        assert.equal(data.estimatedCosts.searchUsd, "0.030000");
        assert.ok(data.sources.some((source) => source.url === ORIGIN));

        assert.equal(calls.length, 2);
        const first = calls[0].params;
        assert.equal(first.model, "claude-haiku-5-5");
        assert.deepEqual(first.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }]);
        assert.deepEqual(first.output_config, { effort: "low" });
        assert.match(first.messages[0].content, /Return ONLY a JSON object in Arabic/);
        assert.match(first.messages[0].content, /CodeCanyon, Codester, GitHub/);
        assert.ok(calls[0].options.signal);
        // The paused assistant turn goes back unchanged so the server can resume it.
        assert.equal(calls[1].params.messages[1].role, "assistant");
        assert.equal(calls[1].params.messages[1].content[1].type, "web_search_tool_result");
    });
});

test("Claude errors map to quota, refusal and missing-key responses", async () => {
    await withClaude([Object.assign(new Error("credit balance is too low"), { status: 400 })], async ({ call }) => {
        const response = await call();
        assert.equal(response.statusCode, 429);
        assert.equal(JSON.parse(response.body).errorCode, "AI_QUOTA_EXCEEDED");
    });
    await withClaude([Object.assign(new Error("rate limited"), { status: 429 })], async ({ call }) => {
        assert.equal((await call()).statusCode, 429);
    });
    await withClaude([message("refusal", [])], async ({ call }) => {
        const response = await call();
        assert.equal(response.statusCode, 502);
        assert.equal(JSON.parse(response.body).errorCode, "AI_REQUEST_FAILED");
    });
    await withClaude([message("max_tokens", [{ type: "text", text: "{" }])], async ({ call }) => {
        assert.equal(JSON.parse((await call()).body).errorCode, "OUTPUT_LIMIT_REACHED");
    });
    await withClaude([Object.assign(new Error("timed out"), { name: "APIConnectionTimeoutError" })], async ({ call }) => {
        const response = await call();
        assert.equal(response.statusCode, 504);
        assert.equal(JSON.parse(response.body).errorCode, "AI_TIMEOUT");
    });
    await withClaude([], async ({ call, calls }) => {
        delete process.env.qlook_claude_key;
        const response = await call();
        assert.equal(response.statusCode, 503);
        assert.equal(JSON.parse(response.body).errorCode, "CLAUDE_KEY_MISSING");
        assert.equal(calls.length, 0);
    });
});

test("search tool version follows the model and the key test runs a real search", async () => {
    assert.equal(webSearchTool("claude-haiku-5-5", 2).type, "web_search_20250305");
    assert.equal(webSearchTool("claude-sonnet-5-5", 2).type, "web_search_20260209");

    const calls = [];
    const previous = setClientFactory(fakeClient([
        message("end_turn", [{ type: "text", text: "SaaS Starter" }]),
        message("end_turn", [{ type: "text", text: "no search" }], { server_tool_use: { web_search_requests: 0 } })
    ], calls));
    try {
        assert.deepEqual(await testClaudeKey("sk-ant-x", "claude-haiku-5-5"), { valid: true });
        assert.deepEqual(await testClaudeKey("sk-ant-x", "claude-haiku-5-5", { research: true }), { valid: true, research: true });
        const noSearch = await testClaudeKey("sk-ant-x", "claude-haiku-5-5", { research: true });
        assert.equal(noSearch.valid, false);
        assert.match(noSearch.message, /ran no web search/);
    } finally {
        setClientFactory(previous);
    }
});
