export default async function run(page) {
    const failures = [];
    await page.setViewportSize({ width: 390, height: 844 });

    const initial = await page.evaluate(() => ({
        title: document.title,
        language: document.documentElement.lang,
        direction: document.documentElement.dir,
        countOptions: Array.from(document.querySelectorAll('#opportunityCount option'), (option) => option.value),
        countryOptions: document.querySelectorAll("#country option").length,
        countryCodes: Array.from(document.querySelectorAll("#country option"), (option) => option.value),
        industryOptions: document.querySelectorAll('#industry option').length,
        featureFilters: document.querySelectorAll('input[name="featureFilter"]').length,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
    }));
    if (initial.language !== "ar" || initial.direction !== "rtl") failures.push("Arabic initial state");
    if (initial.countOptions.join(",") !== "5,10,20") failures.push("opportunity count options");
    if (initial.countryOptions !== 22 || !["SA", "GCC", "AE", "MENA", "EG", "MA"].every((code) => initial.countryCodes.includes(code))
        || initial.countryCodes.includes("US") || initial.industryOptions < 10 || initial.featureFilters !== 7) {
        failures.push("preserved country, industry, or capability configuration");
    }
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
    await page.locator("#country").selectOption("SA");
    await page.locator("#budget").selectOption("حتى 500 دولار");
    await page.locator("#industry").selectOption("جميع المجالات");
    await page.locator("#goal").selectOption("إطلاق SaaS جديد");
    await page.locator('input[name="featureFilter"][value="ai_features"]').check();
    const englishOption = await page.locator("#opportunityCount option:checked").textContent();
    const englishState = await page.evaluate(() => ({ language: document.documentElement.lang, direction: document.documentElement.dir }));
    if (englishState.language !== "en" || englishState.direction !== "ltr" || !englishOption.includes("opportunities")) {
        failures.push("English toggle or translated selected option");
    }

    await page.locator("#langToggle").click();
    await page.locator("#advancedToggle").click();
    const advancedOpen = await page.locator("#advancedSection").isVisible();
    if (!advancedOpen) failures.push("advanced settings expansion");

    const mockResponse = {
        summary: "Mocked report summary",
        verificationNote: "Mock UAT fixture; not provider-verified",
        requestedCount: 5,
        verifiedCount: 1,
        excludedCount: 1,
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        estimatedCosts: { modelUsd: "0.000530", searchUsd: "0.000000", totalUsd: "0.000530" },
        opportunities: [{
            productName: "<img src=x onerror=alert(1)>",
            directUrl: "https://product.example/",
            originName: "Repository",
            originType: "repository",
            originUrl: "https://repository.example/project",
            supportingSources: [{ title: "Supporting source", url: "https://source.example/evidence" }],
            license: { name: null, status: "unverified", sourceUrl: null },
            price: { amount: null, currency: null, period: null, status: "unknown", sourceUrl: null },
            lastVerifiedDate: "2026-10-12",
            confidence: "low",
            verifiedFacts: [{ claim: "Mock fact", url: "https://source.example/evidence", title: "Supporting source" }],
            estimates: ["Mock estimate"]
        }]
    };
    let submittedPayload = null;
    await page.route("**/api/generate", async (route) => {
        submittedPayload = JSON.parse(route.request().postData() || "{}");
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockResponse) });
    });
    await page.locator("#configForm").evaluate((form) => form.requestSubmit());
    await page.locator(".opportunity").waitFor({ state: "visible" });

    const rendered = await page.evaluate(() => ({
        opportunityCards: document.querySelectorAll(".opportunity").length,
        sourceLinks: document.querySelectorAll(".opportunity .opportunity-section a").length,
        verifiedCount: document.querySelector(".report-summary strong")?.textContent,
        injectedImages: document.querySelectorAll(".opportunity img").length,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
    }));
    if (rendered.opportunityCards !== 1 || rendered.sourceLinks < 1) failures.push("opportunity card citations");
    if (rendered.injectedImages !== 0) failures.push("untrusted content escaped as HTML");
    if (submittedPayload?.opportunityCount !== 5 || submittedPayload?.language !== "ar"
        || !submittedPayload?.filters?.includes("ai_features")) {
        failures.push("submit payload contract");
    }
    if (rendered.pageWidth > rendered.viewportWidth) failures.push("mobile horizontal overflow after render");
    if (!submittedPayload?.settings?.includes("Write the report in Arabic")) failures.push("report language is not Arabic");
    if (await page.locator("#view-results").isHidden()) failures.push("results view not shown after search");

    await page.locator(".opportunity .card-actions button").first().click();
    await page.locator('#appNav button[data-view="watchlist"]').click();
    const watchlistCards = await page.locator("#watchlistItems .opportunity").count();
    if (watchlistCards !== 1) failures.push("watchlist save");

    await page.locator('#appNav button[data-view="settings"]').click();
    await page.locator("#default-opportunityCount").selectOption("10");
    await page.locator("#settingsForm button[type=submit]").click();
    const appliedCount = await page.locator("#opportunityCount").inputValue();
    if (appliedCount !== "10") failures.push("research settings defaults");

    await page.locator('#appNav button[data-view="overview"]').click();
    const overviewStats = await page.evaluate(() => ({
        reports: document.getElementById("statReports").textContent,
        watchlist: document.getElementById("statWatchlist").textContent
    }));
    if (overviewStats.reports !== "1" || overviewStats.watchlist !== "1") failures.push("overview stats");

    await page.setViewportSize({ width: 1440, height: 900 });
    const desktop = await page.evaluate(() => ({ pageWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
    if (desktop.pageWidth > desktop.viewportWidth) failures.push("desktop horizontal overflow");
    if (failures.length) throw new Error(`Browser smoke failures: ${failures.join(", ")}`);

    return { title: initial.title, mobile: initial, navigation, rendered, watchlistCards, appliedCount, overviewStats, desktop, advancedOpen, submittedPayload, passed: true };
}