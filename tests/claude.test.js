"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { setClientFactory, webSearchTool, testClaudeKey } = require("../server/providers/claude");
const { quoteFound, pickCandidates } = require("../server/pipeline");

// One product page per marketplace, as its site search would return it.
const PRODUCTS = {
    "codecanyon.net": "https://codecanyon.net/item/easy-invoice/39237894",
    "codester.com": "https://www.codester.com/items/26927/quicksuite-saas",
    "sourceforge.net": "https://sourceforge.net/projects/openbilling",
    "gumroad.com": "https://maker.gumroad.com/l/invoice-kit",
    "appsumo.com": "https://appsumo.com/products/invoiless",
    "acquire.com": "https://acquire.com/startup/billing-saas",
    "flippa.com": "https://flippa.com/11813737",
    "microns.io": "https://microns.io/listing/all-in-one",
    "indiehackers.com": "https://www.indiehackers.com/product/invoicely"
};
const PAGES = {
    [PRODUCTS["sourceforge.net"]]: "OpenBilling — invoicing for small firms. Licensed under the MIT License. Full RTL support for Arabic. REST API with webhooks.",
    [PRODUCTS["codecanyon.net"]]: "Easy Invoice SaaS. Regular License $45. Full RTL support. REST API included.",
    [PRODUCTS["gumroad.com"]]: "Invoice kit source code. Released under the MIT License. Works with Stripe."
};

function message(content, usage = {}) {
    return { stop_reason: "end_turn", content, usage: { input_tokens: 1000, output_tokens: 200, output_tokens_details: { thinking_tokens: 20 }, server_tool_use: {}, ...usage } };
}

function searchReply(domain, query) {
    const url = PRODUCTS[domain];
    const results = domain === "acquire.com"
        ? [{ type: "web_search_result", url: "https://acquire.com/marketplace", title: "Marketplace" }]
        : [{ type: "web_search_result", url, title: url.split("/").pop() }];
    return message([
        { type: "server_tool_use", id: "s1", name: "web_search", input: { query } },
        { type: "web_search_tool_result", tool_use_id: "s1", content: results },
        { type: "text", text: "DONE" }
    ], { server_tool_use: { web_search_requests: 1 } });
}

function fetchReply(url) {
    const text = PAGES[url];
    return message([
        { type: "server_tool_use", id: "f1", name: "web_fetch", input: { url } },
        { type: "web_fetch_tool_result", tool_use_id: "f1", content: text
            ? { type: "web_fetch_result", url, content: { type: "document", source: { type: "text", media_type: "text/plain", data: text } } }
            : { type: "web_fetch_tool_error", error_code: "url_not_accessible" } },
        { type: "text", text: "DONE" }
    ], { server_tool_use: { web_fetch_requests: 1 } });
}

// The analysis names candidates by id; the fake finds each id by its URL in the prompt.
function analysisReply(prompt) {
    const idFor = (url) => prompt.match(new RegExp(`<candidate id="(c\\d+)">\\nsource: [^;]+; url: ${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};`))?.[1];
    const candidates = [];
    const add = (url, entry) => {
        const id = idFor(url);
        if (id) candidates.push({ id, relevant: true, risks: [], estimates: ["تقدير: تكلفة استضافة شهرية منخفضة"], fitNote: "يناسب السوق", ...entry });
    };
    add(PRODUCTS["sourceforge.net"], {
        productName: "OpenBilling", offerType: "open_source", licenseName: "MIT", licenseQuote: "Licensed under the MIT License",
        commercialUse: { status: "allowed", condition: null, quote: null }, price: { amount: null, currency: null, licenseLabel: null, quote: null },
        requirements: [{ capability: "rtl_support", status: "verified", quote: "Full RTL support for Arabic" }, { capability: "api_integrations", status: "verified", quote: "REST API with webhooks" }]
    });
    add(PRODUCTS["codecanyon.net"], {
        productName: "Easy Invoice", offerType: "perpetual_license", licenseName: "Regular License", licenseQuote: "Regular License $45",
        commercialUse: { status: "conditional", condition: "Extended License needed", quote: null }, price: { amount: "45", currency: "USD", licenseLabel: "Regular License", quote: "Regular License $45" },
        requirements: [{ capability: "rtl_support", status: "verified", quote: "Full RTL support" }, { capability: "api_integrations", status: "verified", quote: "REST API included" }]
    });
    // Claims capabilities with quotes that are not on its page.
    add(PRODUCTS["gumroad.com"], {
        productName: "Invoice Kit", offerType: "open_source", licenseName: "MIT", licenseQuote: "Released under the MIT License",
        commercialUse: { status: "allowed", condition: null, quote: null }, price: { amount: null, currency: null, licenseLabel: null, quote: null },
        requirements: [{ capability: "rtl_support", status: "verified", quote: "Supports Arabic RTL layouts" }, { capability: "api_integrations", status: "verified", quote: "Works with Stripe" }]
    });
    return message([{ type: "text", text: JSON.stringify({ candidates }) }]);
}

function fakeClient(calls, { failOnce = [], analysis } = {}) {
    const failed = new Set();
    return () => ({
        messages: {
            async create(params) {
                calls.push(JSON.parse(JSON.stringify(params)));
                const tool = params.tools?.[0];
                if (tool?.name === "web_search") {
                    const domain = tool.allowed_domains[0];
                    if (failOnce.includes(domain) && !failed.has(domain)) {
                        failed.add(domain);
                        throw Object.assign(new Error("overloaded"), { status: 529 });
                    }
                    const query = params.messages[0].content.match(/query and nothing else: (.*)\n/)[1];
                    return searchReply(domain, query);
                }
                if (tool?.name === "web_fetch") return fetchReply(params.messages[0].content.match(/exact URL and nothing else: (\S+)/)[1]);
                return message([{ type: "text", text: "SaaS Starter" }], { server_tool_use: { web_search_requests: 1 } });
            },
            stream(params) {
                calls.push(JSON.parse(JSON.stringify(params)));
                return { finalMessage: async () => (analysis ? analysis(params) : analysisReply(params.messages[0].content)) };
            }
        },
        models: { retrieve: async (model) => ({ id: model }) }
    });
}

// In-memory Redis for the REST shim: counters, reserve/refund scripts, seen links.
function fakeRedis(seen = []) {
    const store = new Map();
    const commands = [];
    const handle = (command) => {
        commands.push(command);
        const [name, a, , key, arg1, arg2] = command;
        if (name === "SMEMBERS") return seen;
        if (name === "GET") return store.get(a) ?? null;
        if (name === "SET") {
            store.set(a, command[2]);
            return "OK";
        }
        if (name === "LRANGE") return [];
        if (name !== "EVAL") return 0;
        if (a.includes("local results")) return [1, 1, 1];
        if (a.includes("redis.call('DECR', KEYS[1])\n  return -1")) {
            const next = (Number(store.get(key)) || 0) + 1;
            if (next > Number(arg1)) return -1;
            store.set(key, next);
            return next;
        }
        if (a.startsWith("local v = tonumber")) {
            const value = Number(store.get(key)) || 0;
            if (value > 0) store.set(key, value - 1);
            return Math.max(0, value - 1);
        }
        if (a.includes("INCRBYFLOAT")) return Number(arg1) || 0;
        if (a.includes("SADD")) return 1;
        if (a.includes("groundedCount")) return 1;
        return 1;
    };
    return { store, commands, handle };
}

async function withEnv(options, run) {
    const names = ["qlook_key", "qlook_claude_key", "QL_PROVIDER", "QL_CLAUDE_MODEL", "QL_CATALOG", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "QL_MAX_DISCUSS_PER_DAY"];
    const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    Object.assign(process.env, {
        qlook_claude_key: "sk-ant-test-only-key-0123456789",
        UPSTASH_REDIS_REST_URL: "https://redis.example",
        UPSTASH_REDIS_REST_TOKEN: "test-only-token",
        QL_CATALOG: "off",
        ...(options.env || {})
    });
    const calls = [];
    const previous = setClientFactory(fakeClient(calls, options));
    const redis = fakeRedis(options.seen);
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
        if (String(url).startsWith("https://redis.example")) {
            const result = redis.handle(JSON.parse(init.body));
            return { ok: true, status: 200, json: async () => ({ result }) };
        }
        // Listing pages for the sold-listing check are unreachable in tests.
        throw new Error(`no network in tests: ${url}`);
    };
    try {
        await run({ calls, redis });
    } finally {
        global.fetch = originalFetch;
        setClientFactory(previous);
        for (const name of names) {
            if (old[name] === undefined) delete process.env[name];
            else process.env[name] = old[name];
        }
    }
}

const search = (body = {}) => require("../server/generate").handler({
    httpMethod: "POST",
    headers: { "content-type": "application/json", "x-qlook-client-ip": "203.0.113.9" },
    body: JSON.stringify({ settings: "UAT", opportunityCount: 5, language: "ar", budget: "حتى 100 دولار", industry: "المالية والمحاسبة", filters: ["rtl_support", "api_integrations"], ...body })
});

test("the server searches every approved source itself and logs each one", async () => {
    await withEnv({ failOnce: ["flippa.com"] }, async ({ calls }) => {
        const response = await search();
        assert.equal(response.statusCode, 200);
        const data = JSON.parse(response.body);
        const bySource = Object.fromEntries(data.coverage.map((entry) => [entry.source, entry]));
        assert.deepEqual(Object.keys(bySource).sort(), ["Acquire.com", "AppSumo", "Awesome Selfhosted", "CodeCanyon", "Codester", "Flippa", "GitHub", "GitLab", "Gumroad", "Indie Hackers", "Microns.io", "SourceForge"].sort());
        // One site-restricted search per marketplace, with the server's own query.
        const searches = calls.filter((call) => call.tools?.[0]?.name === "web_search");
        assert.equal(searches.length, 10, "9 marketplaces plus one retry");
        assert.equal(bySource["Indie Hackers"].status, "found");
        assert.equal(bySource["Indie Hackers"].query, "accounting invoicing saas product");
        assert.ok(searches.every((call) => call.tools[0].allowed_domains.length === 1 && call.tools[0].max_uses === 1));
        assert.equal(bySource.CodeCanyon.query, "accounting invoicing saas script");
        assert.equal(bySource.CodeCanyon.status, "found");
        assert.equal(bySource.CodeCanyon.products, 1);
        assert.equal(bySource.CodeCanyon.links[0].url, PRODUCTS["codecanyon.net"]);
        assert.ok(bySource.CodeCanyon.startedAt && Number.isFinite(bySource.CodeCanyon.ms));
        // Flippa failed once and the completion round checked it again.
        assert.equal(bySource.Flippa.round, 2);
        assert.equal(bySource.Flippa.firstAttempt.status, "error");
        assert.equal(bySource.Flippa.status, "found");
        // A search that returned no product pages is "checked, no results", not success.
        assert.equal(bySource["Acquire.com"].status, "no_results");
        assert.equal(bySource["Acquire.com"].results, 1);
        assert.equal(bySource.GitHub.status, "not_checked", "the official APIs are off in this test");
        assert.equal(data.coverageComplete, false);
        // No CodeCanyon token anywhere in the request path.
        assert.ok(!JSON.stringify(calls).includes("envato"));
    });
});

test("only products with quoted evidence for every requirement are eligible", async () => {
    await withEnv({}, async ({ calls }) => {
        const data = JSON.parse((await search()).body);
        const analysis = calls.find((call) => !call.tools);
        assert.ok(analysis.output_config.format.schema.properties.candidates, "analysis uses structured output");
        assert.ok(!analysis.tools, "the analysis step does not search");
        assert.match(analysis.messages[0].content, /Licensed under the MIT License/);

        assert.deepEqual(data.opportunities.map((o) => o.productName), ["OpenBilling"]);
        assert.equal(data.verifiedCount, 1);
        const [open] = data.opportunities;
        assert.equal(open.license.status, "verified");
        assert.equal(open.budgetFit, "free");
        assert.deepEqual(open.requirements.map((r) => [r.capability, r.status, r.quote]), [
            ["rtl_support", "verified", "Full RTL support for Arabic"],
            ["api_integrations", "verified", "REST API with webhooks"]
        ]);

        const review = Object.fromEntries(data.alternatives.map((o) => [o.productName, o.reasons]));
        assert.ok(review["Easy Invoice"].includes("budget_unverified"), "a Regular License price is not the SaaS price");
        assert.ok(review["Invoice Kit"].includes("capability_unverified"), "quotes missing from the page do not verify");
        const kit = data.alternatives.find((o) => o.productName === "Invoice Kit");
        assert.equal(kit.requirements.find((r) => r.capability === "api_integrations").status, "unverified", "a quote must be about the capability");

        // The public report carries no tokens or costs, and the summary uses the real counts.
        assert.equal(data.usage, undefined);
        assert.equal(data.estimatedCosts, undefined);
        assert.match(data.summary, /اجتازت 1 فرص/);
        assert.match(data.summary, /للمراجعة/);
    });
});

test("evidence quotes must appear in the page", () => {
    assert.equal(quoteFound("Full  RTL\nsupport", "We offer full RTL support."), true);
    assert.equal(quoteFound("RTL", "RTL"), false, "too short to prove anything");
    assert.equal(quoteFound("Arabic interface", "English only"), false);
});

test("candidate picking skips products the visitor has already seen", () => {
    const log = [{ source: "CodeCanyon", links: [{ url: PRODUCTS["codecanyon.net"], title: "a" }, { url: "https://codecanyon.net/item/other/2", title: "b" }] }];
    const picked = pickCandidates({ candidates: [] }, log, new Set([PRODUCTS["codecanyon.net"]]), 16);
    assert.deepEqual(picked.map((item) => item.url), ["https://codecanyon.net/item/other/2"]);
});

test("a failed analysis returns a clear error and refunds the day's search", async () => {
    const timeout = () => {
        throw Object.assign(new Error("timed out"), { name: "APIConnectionTimeoutError" });
    };
    await withEnv({ analysis: timeout }, async ({ redis }) => {
        const response = await search();
        assert.equal(response.statusCode, 504);
        assert.equal(JSON.parse(response.body).errorCode, "AI_TIMEOUT");
        assert.ok(redis.commands.some((command) => command[0] === "EVAL" && String(command[3]).startsWith("ql:limit:ip-day:")), "the search is given back");
    });
    await withEnv({}, async ({ calls }) => {
        delete process.env.qlook_claude_key;
        const response = await search();
        assert.equal(response.statusCode, 503);
        assert.equal(JSON.parse(response.body).errorCode, "CLAUDE_KEY_MISSING");
        assert.equal(calls.length, 0);
    });
});

test("discussion messages share one daily limit; reading and failures are free", async () => {
    const discuss = require("../server/discuss");
    const call = (method, body) => discuss.handler({ httpMethod: method, headers: { "x-qlook-client-ip": "203.0.113.20" }, body: body && JSON.stringify(body) });
    const opportunity = (name) => ({ productName: name, directUrl: `https://example.com/${name}`, license: { name: "MIT", status: "verified" }, requirements: [{ capability: "rtl_support", status: "unverified" }] });
    let fail = false;
    const analysis = () => {
        throw new Error("unused");
    };
    await withEnv({ env: { QL_MAX_DISCUSS_PER_DAY: "2" }, analysis }, async ({ calls }) => {
        const client = require("../server/providers/claude");
        const previous = client.setClientFactory(() => ({
            messages: {
                async create(params) {
                    calls.push(params);
                    if (fail) throw Object.assign(new Error("overloaded"), { status: 529 });
                    return message([{ type: "text", text: "الحقائق المتحققة: الترخيص MIT. تقدير: يحتاج تعريباً." }]);
                }
            }
        }));
        try {
            const quota = async () => JSON.parse((await call("GET")).body).quota;
            assert.equal((await quota()).remaining, 2);
            assert.equal((await quota()).remaining, 2, "reading the quota does not use it");

            const first = await call("POST", { opportunity: opportunity("alpha"), history: [], message: "هل يناسب السعودية؟", language: "ar" });
            assert.equal(first.statusCode, 200);
            assert.equal(JSON.parse(first.body).quota.remaining, 1);
            assert.match(calls[0].system, /alpha/, "the opportunity is the conversation's context");
            assert.match(calls[0].system, /not a new verification/);

            fail = true;
            const failed = await call("POST", { opportunity: opportunity("beta"), history: [], message: "ما المخاطر؟" });
            assert.equal(failed.statusCode, 502);
            assert.equal(JSON.parse(failed.body).quota.remaining, 1, "a failed answer is not counted");

            fail = false;
            const second = await call("POST", { opportunity: opportunity("beta"), history: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }], message: "ما المخاطر؟" });
            assert.equal(JSON.parse(second.body).quota.remaining, 0, "the limit is shared by every opportunity");
            const blocked = await call("POST", { opportunity: opportunity("gamma"), history: [], message: "مرحبا" });
            assert.equal(blocked.statusCode, 429);
            assert.equal(JSON.parse(blocked.body).errorCode, "DISCUSS_LIMIT_REACHED");
            assert.equal(calls.length, 3, "a blocked message never reaches Claude");
        } finally {
            client.setClientFactory(previous);
        }
    });
});

test("search tool version follows the model and the key test runs a real search", async () => {
    assert.equal(webSearchTool("claude-haiku-5-5", 2).type, "web_search_20250305");
    assert.equal(webSearchTool("claude-sonnet-5-5", 2).type, "web_search_20260209");
    const replies = [
        message([{ type: "text", text: "SaaS Starter" }], { server_tool_use: { web_search_requests: 1 } }),
        message([{ type: "text", text: "no search" }], { server_tool_use: { web_search_requests: 0 } })
    ];
    const previous = setClientFactory(() => ({ messages: { create: async () => replies.shift() }, models: { retrieve: async (model) => ({ id: model }) } }));
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

test("when the AI credit is used up the search says so instead of returning a thin report", async () => {
    await withEnv({ failOnce: [] }, async () => {
        const claude = require("../server/providers/claude");
        const previous = claude.setClientFactory(() => ({
            messages: {
                create: async () => { throw Object.assign(new Error("Your credit balance is too low to access the Anthropic API."), { status: 400 }); },
                stream: () => ({ finalMessage: async () => { throw Object.assign(new Error("Your credit balance is too low"), { status: 400 }); } })
            }
        }));
        try {
            const response = await search();
            assert.equal(response.statusCode, 429);
            assert.equal(JSON.parse(response.body).errorCode, "AI_QUOTA_EXCEEDED");
        } finally {
            claude.setClientFactory(previous);
        }
    });
});

test("a repeated search reuses cached marketplace results and pages, and says so", async () => {
    await withEnv({}, async ({ calls }) => {
        const first = JSON.parse((await search()).body);
        const searchesFirst = calls.filter((call) => call.tools?.[0]?.name === "web_search").length;
        const fetchesFirst = calls.filter((call) => call.tools?.[0]?.name === "web_fetch").length;
        assert.equal(searchesFirst, 9);
        assert.ok(fetchesFirst > 0);
        const before = calls.length;
        const second = JSON.parse((await search()).body);
        assert.equal(calls.filter((call) => call.tools?.[0]?.name === "web_search").length, searchesFirst, "no new paid searches");
        // Pages that were read are reused; pages that failed are tried again.
        const readAgain = calls.slice(before).filter((call) => call.tools?.[0]?.name === "web_fetch" && Object.keys(PAGES).some((url) => call.messages[0].content.includes(url)));
        assert.equal(readAgain.length, 0, "no new reads of pages already read");
        const codecanyon = second.coverage.find((entry) => entry.source === "CodeCanyon");
        assert.equal(codecanyon.cached, true);
        assert.equal(codecanyon.cachedAt, first.coverage.find((entry) => entry.source === "CodeCanyon").startedAt, "the log keeps when the search really ran");
        assert.deepEqual(second.opportunities.map((o) => o.productName), first.opportunities.map((o) => o.productName));
    });
});

test("the server finds capability and licence evidence in the page when the analysis missed it", () => {
    const { toOpportunity, excerpt } = require("../server/pipeline");
    const candidate = (url, text, extra = {}) => ({ id: "c1", url, name: "X", source: "S", sourceType: "repository", evidence: { method: "readme", url, text }, ...extra });
    const entry = { relevant: true, productName: "Corteza", offerType: "open_source", requirements: [], commercialUse: {}, price: {} };
    const corteza = toOpportunity(candidate("https://github.com/cortezaproject/corteza", "Low-code platform.\n* [using the REST API](https://docs.example) for integrations", { license: "Apache-2.0" }),
        entry, { filters: ["api_integrations", "rtl_support"], budget: "حتى 100 دولار" }, "ar", "2026-10-14");
    assert.equal(corteza.requirements[0].status, "verified");
    assert.match(corteza.requirements[0].quote, /REST API/);
    assert.equal(corteza.requirements[1].status, "unverified", "no RTL phrase on the page, so it stays unverified");
    const market = toOpportunity(candidate("https://codecanyon.net/item/nazmart/1", "Nazmart. Regular License $69 Extended License $499", { sourceType: "marketplace" }),
        { ...entry, productName: "Nazmart" }, { filters: [], budget: "حتى 5000 دولار" }, "ar", "2026-10-14");
    assert.equal(market.license.name, "Extended License");
    assert.equal(market.commercialUse.status, "allowed");
    assert.equal(market.price.amount, "499", "the Extended License price is the SaaS price");
    assert.equal(excerpt("a\ud83d b").includes("\ud83d"), false, "half emoji are removed before the API sees them");
});
