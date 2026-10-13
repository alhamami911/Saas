export default async function run(page) {
    const failures = [];
    await page.setViewportSize({ width: 390, height: 844 });

    const initial = await page.evaluate(() => ({
        title: document.title,
        language: document.documentElement.lang,
        direction: document.documentElement.dir,
        countField: { tag: document.getElementById("opportunityCount").tagName, value: document.getElementById("opportunityCount").value },
        countryOptions: document.querySelectorAll("#country option").length,
        countryCodes: Array.from(document.querySelectorAll("#country option"), (option) => option.value),
        defaults: ["country", "budget", "industry", "goal"].map((id) => document.getElementById(id).value),
        requiredFields: document.querySelectorAll("#configForm [required]").length,
        industryOptions: document.querySelectorAll("#industry option").length,
        featureFilters: document.querySelectorAll('input[name="featureFilter"]').length,
        examples: document.querySelectorAll("#aiExamples .example-chip").length,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
    }));
    if (initial.language !== "ar" || initial.direction !== "rtl") failures.push("Arabic initial state");
    if (initial.countField.tag !== "INPUT" || initial.countField.value !== "5") failures.push("fixed five opportunities");
    if (initial.countryOptions !== 21 || !["SA", "GCC", "AE", "MENA", "EG", "MA"].every((code) => initial.countryCodes.includes(code))
        || initial.countryCodes.includes("US") || initial.industryOptions < 10 || initial.featureFilters !== 7) {
        failures.push("preserved country, industry, or capability configuration");
    }
    if (initial.defaults.join("|") !== "SA|مفتوح|جميع المجالات|إطلاق SaaS جديد" || initial.requiredFields !== 0) failures.push("optional fields with defaults");
    if (initial.examples !== 4) failures.push("AI search examples");
    if (initial.pageWidth > initial.viewportWidth) failures.push("mobile horizontal overflow before render");

    const navigation = await page.evaluate(() => ({
        views: Array.from(document.querySelectorAll("#appNav button"), (button) => button.dataset.view),
        overviewVisible: !document.getElementById("view-overview").classList.contains("hidden"),
        adminLinks: document.querySelectorAll('a[href*="admin"], form[action*="admin"]').length
    }));
    if (navigation.views.join(",") !== "overview,discover,results,watchlist,settings" || !navigation.overviewVisible) {
        failures.push("dashboard sections");
    }
    if (navigation.adminLinks !== 0) failures.push("admin controls exposed on public page");
    await page.locator('#appNav button[data-view="discover"]').click();

    await page.locator("#langToggle").click();
    const english = await page.evaluate(() => ({
        language: document.documentElement.lang,
        direction: document.documentElement.dir,
        start: document.getElementById("startBtn").textContent,
        firstExample: document.querySelector("#aiExamples .example-chip")?.textContent
    }));
    if (english.language !== "en" || english.direction !== "ltr" || english.start !== "Search with AI" || !/ZATCA/.test(english.firstExample || "")) {
        failures.push("English toggle");
    }
    await page.locator("#langToggle").click();

    await page.locator("#refine summary").click();
    await page.locator("#budget").selectOption("حتى 500 دولار");
    await page.locator('input[name="featureFilter"][value="ai_features"]').check();
    await page.locator("#aiExamples .example-chip").first().click();
    const description = await page.locator("#promptOverride").inputValue();
    if (!description.includes("ZATCA")) failures.push("example fills the AI search box");

    const opportunity = (name, url) => ({
        productName: name,
        directUrl: url,
        originName: "Repository",
        originType: "repository",
        originUrl: "https://repository.example/project",
        supportingSources: [{ title: "Supporting source", url: "https://source.example/evidence" }],
        license: { name: null, status: "unverified", sourceUrl: null },
        price: { amount: null, currency: null, period: null, status: "unknown", sourceUrl: null },
        lastVerifiedDate: "2026-10-13",
        confidence: "low",
        verifiedFacts: [{ claim: "Mock fact", url: "https://source.example/evidence", title: "Supporting source" }],
        estimates: ["Mock estimate"]
    });
    const response = (opportunities) => ({
        summary: "Mocked report summary",
        verificationNote: "Mock UAT fixture; not provider-verified",
        requestedCount: 5,
        verifiedCount: opportunities.length,
        excludedCount: 1,
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        estimatedCosts: { modelUsd: "0.000530", searchUsd: "0.000000", totalUsd: "0.000530" },
        opportunities
    });
    const payloads = [];
    await page.route("**/api/generate", async (route) => {
        const payload = JSON.parse(route.request().postData() || "{}");
        payloads.push(payload);
        const body = payloads.length === 1
            ? response([opportunity("<img src=x onerror=alert(1)>", "https://product.example/")])
            : response([opportunity("Repeated", "https://product.example/"), opportunity("Second product", "https://second.example/")]);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    // Enter in the AI search box submits the search.
    await page.locator("#promptOverride").press("Enter");
    // Results arrive as a table; a row opens the full analysis card.
    await page.locator(".results-table .result-row").first().waitFor({ state: "visible" });
    const table = await page.evaluate(() => ({
        headers: document.querySelectorAll(".results-table thead th").length,
        rows: document.querySelectorAll(".results-table .result-row").length,
        cardsBeforeClick: document.querySelectorAll(".opportunity").length,
        moreButton: Boolean(document.getElementById("moreBtn"))
    }));
    if (table.headers !== 8 || table.rows !== 1 || table.cardsBeforeClick !== 0 || !table.moreButton) failures.push("results table");
    await page.locator(".results-table .result-row").first().click();
    await page.locator(".opportunity").waitFor({ state: "visible" });

    const rendered = await page.evaluate(() => ({
        opportunityCards: document.querySelectorAll(".opportunity").length,
        sourceLinks: document.querySelectorAll(".opportunity .opportunity-section a").length,
        verifiedCount: document.querySelector(".report-summary strong")?.textContent,
        injectedImages: document.querySelectorAll(".opportunity img").length,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
    }));
    const submittedPayload = payloads[0];
    if (rendered.opportunityCards !== 1 || rendered.sourceLinks < 1) failures.push("opportunity card citations");
    if (rendered.injectedImages !== 0) failures.push("untrusted content escaped as HTML");
    if (submittedPayload?.opportunityCount !== 5 || submittedPayload?.language !== "ar"
        || !submittedPayload?.filters?.includes("ai_features") || submittedPayload?.budget !== "حتى 500 دولار") {
        failures.push("submit payload contract");
    }
    if (!submittedPayload?.settings?.includes("ZATCA")) failures.push("AI search text reaches the request");
    if (rendered.pageWidth > rendered.viewportWidth) failures.push("mobile horizontal overflow after render");
    if (!submittedPayload?.settings?.includes("Write the report in Arabic")) failures.push("report language follows the interface");
    if (await page.locator("#view-results").isHidden()) failures.push("results view not shown after search");

    await page.locator(".opportunity .card-actions button").first().click();

    // "Find 5 more" repeats the search, excludes what is shown and appends new rows only.
    await page.locator("#moreBtn").click();
    await page.waitForFunction(() => document.querySelectorAll(".results-table .result-row").length === 2);
    const more = {
        exclude: payloads[1]?.exclude,
        rows: await page.locator(".results-table .result-row").count(),
        names: await page.$$eval(".result-row td:nth-child(2)", (cells) => cells.map((cell) => cell.textContent)),
        message: await page.locator("#moreMsg").textContent()
    };
    if (more.exclude?.join() !== "https://product.example/" || more.rows !== 2 || more.names[1] !== "Second product" || !more.message) {
        failures.push("find more opportunities");
    }

    await page.locator('#appNav button[data-view="watchlist"]').click();
    const watchlistCards = await page.locator("#watchlistItems .opportunity").count();
    if (watchlistCards !== 1) failures.push("watchlist save");

    await page.locator('#appNav button[data-view="settings"]').click();
    await page.locator("#default-budget").selectOption("حتى 100 دولار");
    await page.locator("#settingsForm button[type=submit]").click();
    const appliedBudget = await page.locator("#budget").inputValue();
    if (appliedBudget !== "حتى 100 دولار") failures.push("research settings defaults");

    await page.locator('#appNav button[data-view="overview"]').click();
    const overviewStats = await page.evaluate(() => ({
        reports: document.getElementById("statReports").textContent,
        watchlist: document.getElementById("statWatchlist").textContent
    }));
    if (overviewStats.reports !== "2" || overviewStats.watchlist !== "1") failures.push("overview stats");

    await page.setViewportSize({ width: 1440, height: 900 });
    const desktop = await page.evaluate(() => ({ pageWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
    if (desktop.pageWidth > desktop.viewportWidth) failures.push("desktop horizontal overflow");
    if (failures.length) throw new Error(`Browser smoke failures: ${failures.join(", ")}`);

    return { title: initial.title, mobile: initial, navigation, english, table, rendered, more, watchlistCards, appliedBudget, overviewStats, desktop, submittedPayload, passed: true };
}
