// Browser acceptance test for the review milestone. Every API is mocked, so this
// proves the interface behaviour only; live searches are tested separately.
export default async function run(page) {
    const failures = [];
    const errors = [];
    const R = {};
    page.on("pageerror", (error) => errors.push(error.message));
    const check = (ok, label) => { if (!ok) failures.push(label); };
    await page.setViewportSize({ width: 1280, height: 900 });

    const log = ["GitHub", "GitLab", "Awesome Selfhosted", "CodeCanyon", "Codester", "SourceForge", "Gumroad", "AppSumo", "Acquire.com", "Flippa", "Microns.io"].map((source, index) => ({
        source, method: index < 3 ? "official_api" : "site_search", query: "accounting invoicing", round: index === 9 ? 2 : 1, startedAt: "2026-10-13T10:00:00Z", ms: 2400,
        status: index === 8 ? "no_results" : "found", results: 10, products: index === 8 ? 0 : 3,
        links: index === 8 ? [] : [{ url: `https://example.com/${index}`, title: `${source} item` }], firstAttempt: index === 9 ? { status: "error", error: "overloaded" } : null
    }));
    const base = (name, extra = {}) => ({
        productName: name, directUrl: `https://sourceforge.net/projects/${name.toLowerCase()}`, originName: "SourceForge", originType: "repository", originUrl: "https://sourceforge.net/",
        supportingSources: [{ title: name, url: `https://sourceforge.net/projects/${name.toLowerCase()}` }],
        license: { name: "MIT", status: "verified", sourceUrl: null }, commercialUse: { status: "allowed", note: "MIT" }, availability: { status: "unknown" },
        price: { amount: null, currency: null, status: "unknown" }, budgetFit: "free", lastVerifiedDate: "2026-10-13", confidence: "medium",
        verifiedFacts: [{ claim: "«Licensed under the MIT License»", url: "https://sourceforge.net/projects/x", title: name }], estimates: ["تقدير: استضافة 20 دولاراً شهرياً"],
        requirements: [{ capability: "rtl_support", status: "verified", quote: "Full RTL support", sourceUrl: "https://sourceforge.net/projects/x" }, { capability: "api_integrations", status: "verified", quote: "REST API", sourceUrl: "https://sourceforge.net/projects/x" }],
        discoveredVia: "site_search", catalogueSource: "SourceForge", stats: {}, ...extra
    });
    const report = (names, alternatives = []) => ({
        summary: `فُحص 10 من 11 مصدراً معتمداً. اجتازت ${names.length} فرص شروط الترخيص والخصائص المطلوبة والميزانية من أصل 5 مطلوبة.`,
        verificationNote: "", requestedCount: 5, verifiedCount: names.length, excludedCount: alternatives.length,
        opportunities: names.map((name) => base(name)), alternatives, coverage: log, coverageComplete: true, candidatesChecked: 16, pagesRead: 16
    });
    const reviewItem = base("EasyInvoice", { directUrl: "https://codecanyon.net/item/easy-invoice/1", originName: "CodeCanyon", originType: "marketplace", license: { name: "Regular License", status: "verified" }, commercialUse: { status: "conditional", note: "Extended License" }, price: { amount: "45", currency: "USD", status: "verified" }, budgetFit: "unknown", reasons: ["budget_unverified"] });

    let mode = "timeout";
    let generateCalls = 0;
    await page.route("**/api/generate", async (route) => {
        generateCalls += 1;
        const body = JSON.parse(route.request().postData());
        if (mode === "timeout") return route.fulfill({ status: 504, contentType: "application/json", body: JSON.stringify({ errorCode: "AI_TIMEOUT" }) });
        if (mode === "network") return route.abort("internetdisconnected");
        if (mode === "zero") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(report([], [reviewItem])) });
        if (body.exclude?.length) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(report(["MoreOne"])) });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(report(["OpenBilling", "LedgerLite"], [reviewItem])) });
    });
    const quota = { limit: 30, used: 0, remaining: 30, resetsAt: "2026-10-14T00:00:00.000Z" };
    let discussMode = "ok";
    let discussPosts = 0;
    await page.route("**/api/discuss", async (route) => {
        if (route.request().method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ quota }) });
        discussPosts += 1;
        const body = JSON.parse(route.request().postData());
        R.discussContext = { product: body.opportunity.productName, requirements: body.opportunity.requirements?.length, history: body.history.length };
        if (discussMode === "fail") return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ errorCode: "AI_REQUEST_FAILED", quota }) });
        if (discussMode === "limit") return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ errorCode: "DISCUSS_LIMIT_REACHED", quota: { ...quota, used: 30, remaining: 0 } }) });
        quota.used += 1;
        quota.remaining -= 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reply: "الحقيقة المتحققة: الترخيص MIT.\nتقدير: يحتاج تعريب الفواتير.", quota }) });
    });

    // Walk the conversation to the search.
    const clickChip = async (text) => {
        await page.waitForFunction((t) => Array.from(document.querySelectorAll(".chip:not(:disabled)")).some((c) => c.textContent.startsWith(t)), text);
        await page.locator(".chip:not(:disabled)", { hasText: text }).last().click();
    };
    await page.locator("#promptOverride").fill("نظام محاسبة يدعم العربية وAPI");
    await page.locator("#promptOverride").press("Enter");
    await clickChip("السعودية");
    await clickChip("المالية والمحاسبة");
    await clickChip("حتى 100 دولار");
    await clickChip("إطلاق منتج SaaS جديد");
    await page.waitForFunction(() => document.querySelectorAll(".chip-toggle").length === 7);
    await page.locator(".chip-toggle").nth(0).click();
    await page.locator(".chip-toggle", { hasText: "API" }).click();
    await clickChip("متابعة");
    await clickChip("ابدأ البحث");

    // 1. Provider timeout: clear message, retry offered, no progress left running.
    await page.waitForFunction(() => document.querySelector(".progress.done"));
    await page.waitForSelector("text=حاول مرة أخرى");
    R.timeout = { status: await page.locator(".progress-status").last().innerText(), activeSpinners: await page.locator(".progress-steps li.active").count(), sendEnabled: await page.locator("#startBtn").isEnabled() };
    check(R.timeout.activeSpinners === 0 && R.timeout.sendEnabled, "timeout leaves no running progress");
    // 2. Network loss on retry.
    mode = "network";
    await page.locator(".chip:not(:disabled)", { hasText: "حاول مرة أخرى" }).last().click();
    await page.waitForFunction(() => document.querySelectorAll(".progress.done").length === 2);
    await page.waitForTimeout(700);
    R.network = await page.locator(".msg-bot .bubble").last().innerText();
    check(/انقطع الاتصال/.test(R.network), "network loss message");
    // 3. Zero eligible results.
    mode = "zero";
    await page.locator(".chip:not(:disabled)", { hasText: "حاول مرة أخرى" }).last().click();
    await page.waitForSelector("#chatLog .alternatives");
    R.zero = { count: await page.locator(".report-summary > strong").innerText(), rows: await page.locator("#chatLog .result-row").count() };
    check(R.zero.rows === 0 && /0 \/ 5/.test(R.zero.count), "zero results shown honestly");
    // 4. Success: one report in the conversation, no duplicate.
    mode = "ok";
    await page.locator("#promptOverride").fill("نفس البحث");
    await page.locator("#promptOverride").press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("#chatLog .result-row").length === 2);
    await page.waitForTimeout(600);
    R.success = {
        reports: await page.locator("#chatLog #reportOutput").count(),
        progressDone: await page.locator(".progress.done").count(),
        progressRunning: await page.locator(".progress:not(.done)").count(),
        costShown: await page.locator(".usage-stats").count(),
        tokensInText: /توكن|token|\$0\./i.test(await page.locator("#chatLog").innerText()),
        logEntries: await page.locator(".coverage > ul > li").count(),
        logText: await page.locator(".coverage > ul > li").nth(9).textContent()
    };
    check(R.success.reports === 1 && R.success.progressRunning === 0, "single report, no running progress");
    check(R.success.costShown === 0 && !R.success.tokensInText, "no cost or tokens on the public page");
    check(R.success.logEntries === 11 && /accounting invoicing/.test(R.success.logText), "per-source log with queries");

    // 5. Price wording is the same in the table and the card.
    const tablePrice = await page.locator("#chatLog .result-row").first().locator("td").nth(3).innerText();
    await page.locator("#chatLog .result-row").first().click();
    const cardPrice = await page.locator("#chatLog .detail-row .opportunity").innerText();
    R.price = { tablePrice, cardHasSame: cardPrice.includes(tablePrice), cardHasUnknown: cardPrice.includes("غير معروف") };
    check(tablePrice === "تكلفة الترخيص مجانية" && R.price.cardHasSame && !R.price.cardHasUnknown, "consistent price wording");
    // 6. Review list opens the full card.
    await page.locator("#chatLog .alternatives > summary").click();
    await page.locator("#chatLog .alternatives li details > summary").first().click();
    await page.waitForTimeout(400);
    R.reviewCard = await page.locator("#chatLog .alternatives .opportunity").count();
    check(R.reviewCard === 1, "review item opens its card");

    // 7. Watchlist: save once (no duplicate), then discuss.
    const save = page.locator("#chatLog .detail-row .card-actions button").first();
    await save.click();
    R.saveDisabledAfter = await save.isDisabled();
    await page.locator('#appNav button[data-view="watchlist"]').click();
    R.watchCount = await page.locator("#watchlistItems .opportunity").count();
    R.progressOnWatchlist = await page.locator(".progress:visible").count();
    check(R.saveDisabledAfter && R.watchCount === 1 && R.progressOnWatchlist === 0, "watchlist save without duplicate");
    await page.locator('#appNav button[data-view="results"]').click();
    R.progressOnResults = await page.locator(".progress:visible").count();
    check(R.progressOnResults === 0, "no progress marks on results page");
    await page.locator('#appNav button[data-view="watchlist"]').click();
    await page.locator("#watchlistItems .discuss-btn").first().click();
    await page.waitForSelector("#discussQuota:has-text('30')");
    R.discussOpen = { title: await page.locator("#discussTitle").innerText(), quota: await page.locator("#discussQuota").innerText(), postsAfterOpen: discussPosts };
    check(R.discussOpen.postsAfterOpen === 0, "opening a discussion sends nothing");
    await page.locator("#discussInput").fill("هل يناسب السوق السعودي؟");
    await page.locator("#discussInput").press("Enter");
    await page.waitForSelector("text=تقدير: يحتاج تعريب الفواتير.");
    R.discussAfterOne = { quota: await page.locator("#discussQuota").innerText(), context: R.discussContext };
    check(/29/.test(R.discussAfterOne.quota) && R.discussContext.product === "OpenBilling" && R.discussContext.requirements === 2, "discussion uses the opportunity context and counts once");
    // A failed answer is not stored and retry does not duplicate the question.
    discussMode = "fail";
    await page.locator("#discussInput").fill("ما المخاطر؟");
    await page.locator("#discussInput").press("Enter");
    await page.waitForSelector("text=إعادة الإرسال");
    discussMode = "ok";
    await page.locator(".chip", { hasText: "إعادة الإرسال" }).click();
    await page.waitForFunction(() => document.querySelectorAll("#discussLog .msg-bot").length === 3);
    R.discussMessages = { user: await page.locator("#discussLog .msg-user").count(), bot: await page.locator("#discussLog .msg-bot").count(), historySent: R.discussContext.history };
    check(R.discussMessages.user === 2 && R.discussContext.history === 2, "retry without duplicate turns");

    // 8. Reload: report, language, discussion history all come back.
    await page.locator("#langToggle").click();
    await page.reload();
    await page.waitForTimeout(800);
    R.afterReload = { lang: await page.evaluate(() => document.documentElement.lang) };
    await page.locator('#appNav button[data-view="results"]').click();
    R.afterReload.rows = await page.locator("#view-results .result-row").count();
    R.afterReload.note = await page.locator(".restored-note").innerText().catch(() => "");
    await page.locator('#appNav button[data-view="watchlist"]').click();
    await page.locator("#watchlistItems .discuss-btn").first().click();
    await page.waitForTimeout(500);
    R.afterReload.discussTurns = await page.locator("#discussLog .msg").count();
    check(R.afterReload.lang === "en" && R.afterReload.rows === 2 && /saved on this device/.test(R.afterReload.note) && R.afterReload.discussTurns === 5, "state restored after reload");
    // 9. Daily limit reached: sending stops, history stays.
    discussMode = "limit";
    await page.locator("#discussInput").fill("one more");
    await page.locator("#discussInput").press("Enter");
    await page.waitForSelector("#discussQuota.quota-out");
    R.limit = { inputDisabled: await page.locator("#discussInput").isDisabled(), quota: await page.locator("#discussQuota").innerText(), historyKept: await page.locator("#discussLog .msg").count() };
    check(R.limit.inputDisabled && R.limit.historyKept >= 5, "limit stops sending and keeps history");
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/accept-discuss.png` });

    R.generateCalls = generateCalls;
    R.errors = errors;
    if (errors.length) failures.push(`page errors: ${errors.join(" | ")}`);
    R.failures = failures;
    R.passed = failures.length === 0;
    return R;
}
