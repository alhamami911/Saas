// Browser smoke test for the public chat app and its conversation.
// The search API is mocked; nothing here calls a paid provider.
export default async function run(page) {
    const failures = [];
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: 390, height: 844 });

    // The sidebar is a drawer on phones; open it before using its buttons.
    const sidebar = async (selector) => {
        if (await page.locator("#menuBtn").isVisible()) {
            await page.locator("#menuBtn").click();
            await page.waitForTimeout(300);
        }
        await page.locator(selector).click();
    };
    const nav = (view) => sidebar(`#appNav button[data-view="${view}"]`);

    const initial = await page.evaluate(() => ({
        title: document.title,
        language: document.documentElement.lang,
        direction: document.documentElement.dir,
        countField: { tag: document.getElementById("opportunityCount").tagName, value: document.getElementById("opportunityCount").value },
        countryCodes: Array.from(document.querySelectorAll("#country option"), (option) => option.value),
        featureFilters: document.querySelectorAll('input[name="featureFilter"]').length,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
    }));
    if (initial.language !== "ar" || initial.direction !== "rtl") failures.push("Arabic initial state");
    if (initial.countField.tag !== "INPUT" || initial.countField.value !== "5") failures.push("fixed five opportunities");
    if (initial.countryCodes.length !== 21 || !["SA", "GCC", "MENA"].every((code) => initial.countryCodes.includes(code)) || initial.featureFilters !== 7) {
        failures.push("MENA countries and capability filters");
    }
    if (initial.pageWidth > initial.viewportWidth) failures.push("mobile horizontal overflow before render");

    const navigation = await page.evaluate(() => ({
        views: Array.from(document.querySelectorAll("#appNav button"), (button) => button.dataset.view),
        adminLinks: document.querySelectorAll('a[href*="admin"], form[action*="admin"]').length
    }));
    if (navigation.views.join(",") !== "discover,results,watchlist,settings,overview") failures.push("dashboard sections");
    if (navigation.adminLinks !== 0) failures.push("admin controls exposed on public page");

    const opportunity = (name, url) => ({
        productName: name, directUrl: url, originName: "Repository", originType: "repository", originUrl: "https://repository.example/project",
        supportingSources: [{ title: "Supporting source", url: "https://source.example/evidence" }],
        license: { name: null, status: "unverified", sourceUrl: null }, price: { amount: null, currency: null, period: null, status: "unknown", sourceUrl: null },
        lastVerifiedDate: "2026-10-13", confidence: "low", verifiedFacts: [{ claim: "Mock fact", url: "https://source.example/evidence", title: "Supporting source" }], estimates: ["Mock estimate"]
    });
    const response = (opportunities) => ({
        summary: "Mocked report summary", verificationNote: "", requestedCount: 5, verifiedCount: opportunities.length, excludedCount: 0,
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 }, estimatedCosts: { modelUsd: "0.000530", searchUsd: "0.000000", totalUsd: "0.000530" }, opportunities
    });
    const payloads = [];
    await page.route("**/api/generate", async (route) => {
        payloads.push(JSON.parse(route.request().postData() || "{}"));
        const body = payloads.length === 1
            ? response([opportunity("<img src=x onerror=alert(1)>", "https://product.example/")])
            : response([opportunity("Repeated", "https://product.example/"), opportunity("Second product", "https://second.example/")]);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });

    // The conversation: greeting, description, market, industry, budget, goal, capabilities.
    await nav("discover");
    const clickChip = async (text) => {
        await page.waitForFunction((label) => Array.from(document.querySelectorAll(".chip:not(:disabled)")).some((chip) => chip.textContent === label), text);
        await page.locator(".chip:not(:disabled)", { hasText: text }).last().click();
    };
    await page.waitForFunction(() => document.querySelectorAll("#suggestions .suggestion").length >= 4);
    const examples = await page.locator("#suggestions .suggestion").count();
    if (examples < 4) failures.push("conversation examples");
    await page.locator("#promptOverride").fill("نظام حجوزات للعيادات يدعم ZATCA");
    await page.locator("#promptOverride").press("Enter");
    // The setup card: one card with every setting, then one click.
    await page.waitForSelector(".setup");
    await page.locator('.setup select[data-field="country"]').selectOption("SA");
    await page.locator('.setup select[data-field="industry"]').selectOption("الصحة والرعاية الصحية");
    await page.locator('.setup select[data-field="budget"]').selectOption("حتى 500 دولار");
    await page.locator('.setup select[data-field="goal"]').selectOption("إطلاق SaaS جديد");
    await page.locator(".setup .chip-toggle", { hasText: "مزايا AI" }).click();
    await page.locator(".setup-go").click();
    await page.waitForSelector(".progress", { state: "attached" });
    await page.locator(".bubble .results-table .result-row").first().waitFor({ state: "visible" });

    const table = await page.evaluate(() => ({
        headers: document.querySelectorAll(".bubble .results-table thead th").length,
        rows: document.querySelectorAll(".bubble .results-table .result-row").length,
        cardsBeforeClick: document.querySelectorAll(".opportunity").length,
        moreButton: Boolean(document.getElementById("moreBtn")),
        progressDone: document.querySelector(".progress")?.classList.contains("done"),
        welcomeHidden: document.getElementById("welcome").classList.contains("hidden")
    }));
    if (table.headers !== 7 || table.rows !== 1 || table.cardsBeforeClick !== 0 || !table.moreButton || !table.progressDone || !table.welcomeHidden) failures.push("results table in conversation");
    await page.locator(".results-table .result-row").first().click();
    await page.locator(".opportunity").waitFor({ state: "visible" });

    const submittedPayload = payloads[0];
    const rendered = await page.evaluate(() => ({
        opportunityCards: document.querySelectorAll(".opportunity").length,
        sourceLinks: document.querySelectorAll(".opportunity .opportunity-section a").length,
        injectedImages: document.querySelectorAll(".opportunity img, #chatLog img").length,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
    }));
    if (rendered.opportunityCards !== 1 || rendered.sourceLinks < 1) failures.push("opportunity card citations");
    if (rendered.injectedImages !== 0) failures.push("untrusted content escaped as HTML");
    if (submittedPayload?.opportunityCount !== 5 || submittedPayload?.language !== "ar" || submittedPayload?.country !== "SA"
        || submittedPayload?.industry !== "الصحة والرعاية الصحية" || submittedPayload?.budget !== "حتى 500 دولار"
        || submittedPayload?.goal !== "إطلاق SaaS جديد" || submittedPayload?.filters?.join() !== "ai_features") {
        failures.push("conversation answers reach the request");
    }
    if (!submittedPayload?.settings?.includes("ZATCA") || !submittedPayload?.settings?.includes("Write the report in Arabic")) failures.push("description and report language");
    if (rendered.pageWidth > rendered.viewportWidth) failures.push("mobile horizontal overflow after render");

    await page.locator(".opportunity .card-actions button").first().click();

    // "Find 5 more" excludes what is shown and appends only new rows.
    await page.locator("#moreBtn").click();
    await page.waitForFunction(() => document.querySelectorAll(".results-table .result-row").length === 2);
    const more = {
        exclude: payloads[1]?.exclude,
        names: await page.$$eval(".result-row td:nth-child(2)", (cells) => cells.map((cell) => cell.textContent))
    };
    if (more.exclude?.join() !== "https://product.example/" || more.names[1] !== "Second product") failures.push("find more opportunities");

    // The Results tab shows the same report, and it returns to the conversation.
    await nav("results");
    const resultsTabRows = await page.locator("#view-results .result-row").count();
    await nav("discover");
    const backInChat = await page.locator("#chatLog .result-row").count();
    if (resultsTabRows !== 2 || backInChat !== 2) failures.push("results tab shares the report");

    await nav("watchlist");
    const watchlistCards = await page.locator("#watchlistItems .opportunity").count();
    if (watchlistCards !== 1) failures.push("watchlist save");

    await nav("settings");
    await page.locator("#default-budget").selectOption("حتى 100 دولار");
    await page.locator("#settingsForm button[type=submit]").click();
    if ((await page.locator("#budget").inputValue()) !== "حتى 100 دولار") failures.push("research settings defaults");

    await nav("overview");
    const overviewStats = await page.evaluate(() => ({
        reports: document.getElementById("statReports").textContent,
        watchlist: document.getElementById("statWatchlist").textContent
    }));
    if (overviewStats.reports !== "2" || overviewStats.watchlist !== "1") failures.push("overview stats");

    // A new chat shows the welcome screen; switching language redraws it in English.
    await sidebar("#chatRestart");
    await sidebar("#langToggle");
    await page.keyboard.press("Escape");
    const english = await page.evaluate(() => ({
        dir: document.documentElement.dir, title: document.getElementById("titleText").textContent,
        welcomeVisible: !document.getElementById("welcome").classList.contains("hidden"),
        messages: document.querySelectorAll("#chatLog .msg").length,
        suggestion: document.querySelector("#suggestions .suggestion")?.textContent || "",
        brandFree: !/Qanas|قنّاص|falcon/i.test(document.body.innerText)
    }));
    if (english.dir !== "ltr" || !english.title.startsWith("Hello") || !english.welcomeVisible || english.messages !== 0
        || !english.suggestion.includes("ZATCA") || !english.brandFree) failures.push("English welcome screen");

    await page.setViewportSize({ width: 1440, height: 900 });
    const desktop = await page.evaluate(() => ({ pageWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
    if (desktop.pageWidth > desktop.viewportWidth) failures.push("desktop horizontal overflow");
    if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(" | ")}`);
    if (failures.length) throw new Error(`Browser smoke failures: ${failures.join(", ")}`);

    return { title: initial.title, navigation, table, rendered, more, watchlistCards, overviewStats, english, desktop, submittedPayload, passed: true };
}
