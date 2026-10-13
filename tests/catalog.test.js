"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { collectCandidates, parseAwesome } = require("../server/sources/catalog");
const { searchTerms, budgetCap } = require("../server/sources/keywords");
const { applyCatalogue, catalogueChunks, validateResearchResult, buildResearchPrompt } = require("../server/research");

const AWESOME = [
    "### Customer Relationship Management (CRM)",
    "- [EspoCRM](https://www.espocrm.com/) - CRM with a REST API. ([Demo](https://demo.espocrm.com/), [Source Code](https://github.com/espocrm/espocrm)) `AGPL-3.0` `PHP`",
    "- [Krayin](https://krayincrm.com/) - Laravel CRM for SMEs. ([Source Code](https://github.com/krayin/laravel-crm)) `MIT` `PHP`",
    "### Games",
    "- [Lila](https://lichess.org/) - Chess server. ([Source Code](https://github.com/lichess-org/lila)) `AGPL-3.0` `Scala`"
].join("\n");

function json(data, status = 200) {
    return { ok: status < 300, status, json: async () => data, text: async () => (typeof data === "string" ? data : JSON.stringify(data)) };
}

async function withFetch(handler, run) {
    const original = global.fetch;
    const calls = [];
    global.fetch = async (url, options = {}) => { calls.push({ url: String(url), headers: options.headers || {} }); return handler(String(url)); };
    try {
        await run(calls);
    } finally {
        global.fetch = original;
    }
}

test("maps dashboard choices to marketplace search terms and budget caps", () => {
    assert.equal(searchTerms({ industry: "التسويق والمبيعات" }), "crm");
    assert.equal(searchTerms({ industry: "unknown" }), "saas");
    assert.equal(budgetCap("حتى 500 دولار"), 500);
    assert.equal(budgetCap("مفتوح"), null);
});

test("parses Awesome Selfhosted entries with their section, source code and license", () => {
    const entries = parseAwesome(AWESOME);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[0], {
        name: "EspoCRM",
        website: "https://www.espocrm.com/",
        sourceCode: "https://github.com/espocrm/espocrm",
        description: "CRM with a REST API.",
        license: "AGPL-3.0",
        section: "Customer Relationship Management (CRM)"
    });
});

test("collects candidates from every official source and reports failures without blocking", async () => {
    await withFetch((url) => {
        if (url.startsWith("https://api.github.com/search/repositories")) {
            return json({ items: [
                { full_name: "acme/crm", html_url: "https://github.com/acme/crm", description: "CRM", license: { spdx_id: "MIT" }, stargazers_count: 900, pushed_at: "2026-10-01T00:00:00Z" },
                { full_name: "someone/awesome-crm", html_url: "https://github.com/someone/awesome-crm", license: null, stargazers_count: 5000, pushed_at: "2026-10-01T00:00:00Z" }
            ] });
        }
        if (url.startsWith("https://gitlab.com/api/v4/projects?")) return json([{ id: 7, path_with_namespace: "g/crm", web_url: "https://gitlab.com/g/crm", star_count: 3 }]);
        if (url.startsWith("https://gitlab.com/api/v4/projects/7")) return json({ license: { name: "Apache License 2.0" } });
        if (url.startsWith("https://raw.githubusercontent.com/")) return json(AWESOME);
        if (url.startsWith("https://api.envato.com/")) {
            return json({ matches: [
                { name: "Perfex CRM", url: "https://codecanyon.net/item/perfex/14013737", price_cents: 5900, number_of_sales: 25000, rating: { rating: 4.6 }, updated_at: "2026-09-01T00:00:00Z" },
                { name: "Too expensive", url: "https://codecanyon.net/item/big/1", price_cents: 99900 }
            ] });
        }
        throw new Error(`unexpected ${url}`);
    }, async (calls) => {
        const result = await collectCandidates({ industry: "التسويق والمبيعات", budget: "حتى 500 دولار" }, { envatoToken: "t".repeat(32) });
        const names = result.candidates.map((candidate) => `${candidate.source}:${candidate.name}`);
        assert.ok(names.includes("GitHub:acme/crm"));
        assert.ok(!names.some((name) => name.includes("awesome-crm")), "awesome lists are not products");
        assert.ok(names.includes("GitLab:g/crm"));
        assert.ok(names.includes("Awesome Selfhosted:Krayin"));
        assert.ok(!names.includes("Awesome Selfhosted:Lila"), "only entries matching the industry");
        assert.ok(names.includes("CodeCanyon:Perfex CRM"));
        assert.ok(!names.includes("CodeCanyon:Too expensive"), "over-budget items are dropped");
        const perfex = result.candidates.find((candidate) => candidate.name === "Perfex CRM");
        assert.deepEqual(perfex.price, { amount: "59.00", currency: "USD" });
        assert.equal(perfex.sales, 25000);
        assert.ok(calls.find((call) => call.url.startsWith("https://api.envato.com/")).headers.Authorization.startsWith("Bearer "));
        assert.deepEqual(result.coverage.map((entry) => `${entry.source}:${entry.status}`),
            ["GitHub:ok", "GitLab:ok", "Awesome Selfhosted:ok", "CodeCanyon:ok"]);
    });

    await withFetch((url) => {
        if (url.startsWith("https://api.github.com/")) return json({ message: "rate limited" }, 403);
        if (url.startsWith("https://gitlab.com/")) return json([]);
        return json(AWESOME);
    }, async (calls) => {
        const result = await collectCandidates({ industry: "التسويق والمبيعات" });
        assert.equal(result.coverage.find((entry) => entry.source === "GitHub").status, "error");
        assert.ok(!calls.some((call) => call.url.includes("envato")), "no token, no Envato call");
    });
});

test("catalogue facts override the model and label how each opportunity was found", () => {
    const candidates = [
        { source: "GitHub", name: "acme/crm", url: "https://github.com/acme/crm", license: "AGPL-3.0", stars: 900, updatedAt: "2026-10-01" },
        { source: "CodeCanyon", name: "Perfex", url: "https://codecanyon.net/item/perfex/1", license: "Regular License", price: { amount: "59.00", currency: "USD" }, sales: 25000 }
    ];
    const opportunity = (name, url, origin) => ({
        productName: name, directUrl: url, originName: origin, originType: "repository", originUrl: url, supportingSources: [],
        license: { name: "MIT", status: "verified", sourceUrl: url }, price: { status: "unknown" }, verifiedFacts: [], estimates: []
    });
    const text = JSON.stringify({ summary: "", verificationNote: "", opportunities: [
        opportunity("acme", "https://github.com/acme/crm", "GitHub"),
        opportunity("perfex", "https://codecanyon.net/item/perfex/1", "CodeCanyon"),
        opportunity("listing", "https://flippa.com/123", "Flippa")
    ] });
    const chunks = [...catalogueChunks(candidates), { web: { uri: "https://flippa.com/123", title: "Listing" } }];
    const validated = validateResearchResult(text, chunks, 5).value;
    assert.equal(validated.verifiedCount, 3, "catalogue URLs count as grounded evidence");
    const [acme, perfex, listing] = applyCatalogue(validated, candidates).opportunities;

    assert.equal(acme.discoveredVia, "official_api");
    assert.equal(acme.license.name, "AGPL-3.0", "the API license wins over the model's MIT");
    assert.equal(acme.commercialUse.status, "restricted");
    assert.equal(acme.stats.stars, 900);
    assert.equal(acme.confidence, "high");
    assert.equal(perfex.price.amount, "59.00");
    assert.equal(perfex.price.status, "verified");
    assert.equal(perfex.commercialUse.status, "restricted");
    assert.equal(perfex.stats.sales, 25000);
    assert.equal(listing.discoveredVia, "web_search");
});

test("product links must open the product, not a marketplace search or category page", () => {
    const { isProductPage } = require("../server/research");
    for (const url of [
        "https://codecanyon.net/item/lion-pos-saas/33733665",
        "https://www.codester.com/items/70764/inkora-self-hosted-client-portal-saas",
        "https://github.com/YunaiV/yudao-cloud",
        "https://flippa.com/12285909",
        "https://techwithemma.gumroad.com/l/huytmd",
        "https://www.espocrm.com/"
    ]) assert.equal(isProductPage(url), true, url);
    for (const url of [
        "https://codecanyon.net/search/multi%20tenant%20saas",
        "https://codecanyon.net/category/php-scripts?term=saas+crm",
        "https://www.codester.com/items/comments/41712?p=4",
        "https://github.com/YunaiV/yudao-cloud/issues",
        "https://flippa.com/search?query=saas"
    ]) assert.equal(isProductPage(url), false, url);

    const page = "https://codecanyon.net/search/saas";
    const text = JSON.stringify({ summary: "", verificationNote: "", opportunities: [{
        productName: "From a search page", directUrl: page, originName: "CodeCanyon", originType: "marketplace", originUrl: page,
        supportingSources: [], license: { status: "unverified" }, price: { status: "unknown" }, verifiedFacts: [], estimates: []
    }] });
    const result = validateResearchResult(text, [{ web: { uri: page, title: "Search" } }], 5).value;
    assert.equal(result.verifiedCount, 0);
    assert.equal(result.excludedCount, 1);
});

test("a marketplace home page is accepted as origin for that marketplace's product page", () => {
    // Real response shape: product page found by search, origin given as the site root.
    const product = "https://codecanyon.net/item/slotara-appointment-booking/63704666";
    const item = (originUrl) => ({
        productName: "Slotara", directUrl: product, originName: "CodeCanyon", originType: "marketplace", originUrl,
        supportingSources: [], license: { status: "unverified" }, price: { status: "unknown" }, verifiedFacts: [], estimates: []
    });
    const chunks = [{ web: { uri: product, title: "Slotara — Appointment Booking & Scheduling SaaS Platform" } }];
    const text = (originUrl) => JSON.stringify({ summary: "", verificationNote: "", opportunities: [item(originUrl)] });
    assert.equal(validateResearchResult(text("https://codecanyon.net/"), chunks, 5).value.verifiedCount, 1);
    assert.equal(validateResearchResult(text("https://www.codecanyon.net/"), chunks, 5).value.verifiedCount, 1);
    assert.equal(validateResearchResult(text("https://elsewhere.example/"), chunks, 5).value.verifiedCount, 0, "an unrelated, ungrounded origin is still rejected");
});

test("prompt carries the catalogue as data and the limited search domains", () => {
    const prompt = buildResearchPrompt({
        settings: "Country: SA", opportunityCount: 5, language: "ar", filters: [],
        candidates: [{ source: "GitHub", name: "acme/crm", url: "https://github.com/acme/crm", license: "MIT", stars: 900 }],
        webDomains: ["flippa.com", "acquire.com"]
    });
    assert.match(prompt, /<catalogue>\[\{"source":"GitHub","name":"acme\/crm"/);
    assert.match(prompt, /flippa\.com, acquire\.com/);
    assert.match(prompt, /Middle East and North Africa/);
    assert.match(prompt, /Return ONLY a JSON object in Arabic/);
});
