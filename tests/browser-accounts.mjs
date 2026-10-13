// Browser test for trial accounts with mocked APIs: sign-in, usage meters and
// the messages shown when a limit is reached.
export default async function run(page) {
    const failures = [];
    const errors = [];
    const R = {};
    page.on("pageerror", (error) => errors.push(error.message));
    const check = (ok, label) => { if (!ok) failures.push(label); };
    await page.setViewportSize({ width: 1280, height: 900 });
    const estimates = { search: 0.08, discuss: 0.002 };
    const visitorAccess = { kind: "visitor", estimates, planUsed: 1, planUsable: 18, windows: { day: { used: 0.08, limit: 0.08, resetsAt: "2026-10-15T00:00:00.000Z" }, period: { used: 0.5, limit: 2, resetsAt: null } } };
    const accountAccess = (sessionUsed) => ({
        kind: "account", estimates, planUsed: 1, planUsable: 18, activatedAt: "2026-10-14T08:00:00.000Z", expiresAt: "2026-11-13T08:00:00.000Z", expired: false, disabled: false,
        windows: {
            session: { used: sessionUsed, limit: 0.08, resetsAt: sessionUsed ? "2026-10-14T13:00:00.000Z" : null },
            day: { used: sessionUsed, limit: 0.08, resetsAt: "2026-10-15T00:00:00.000Z" },
            week: { used: sessionUsed, limit: 0.112, resetsAt: "2026-10-21T08:00:00.000Z" },
            period: { used: sessionUsed, limit: 0.32, resetsAt: null }
        }
    });
    let signedIn = false;
    await page.route("**/api/account", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(signedIn ? { signedIn: true, username: "trial07", access: accountAccess(0) } : { signedIn: false, username: null, access: visitorAccess }) }));
    await page.route("**/api/account/login", async (route) => {
        const body = JSON.parse(route.request().postData());
        if (body.password !== "Good-Pass-123") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ errorCode: "LOGIN_FAILED" }) });
        signedIn = true;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ signedIn: true, username: "trial07", access: accountAccess(0) }) });
    });
    await page.route("**/api/account/logout", (route) => { signedIn = false; return route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
    await page.route("**/api/generate", (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify(signedIn
        ? { errorCode: "ACCOUNT_LIMIT", scope: "session", resetsAt: "2026-10-14T13:00:00.000Z", access: accountAccess(0.08) }
        : { errorCode: "VISITOR_LIMIT", scope: "day", resetsAt: "2026-10-15T00:00:00.000Z", access: visitorAccess }) }));

    // The page asks for the account on load, so load it again with the mocks in place.
    await page.reload();
    // Visitor: the shared allowance meter and the limit message with a sign-in offer.
    await page.waitForSelector("#visitorMeters .meter");
    R.visitorMeter = await page.locator("#visitorMeters").innerText();
    const clickChip = async (text) => {
        await page.waitForFunction((t) => Array.from(document.querySelectorAll(".chip:not(:disabled)")).some((c) => c.textContent.startsWith(t)), text);
        await page.locator(".chip:not(:disabled)", { hasText: text }).last().click();
    };
    await page.locator("#suggestions .suggestion").first().click();
    await clickChip("السعودية");
    await clickChip("المالية والمحاسبة");
    await clickChip("حتى 100 دولار");
    await clickChip("إطلاق منتج SaaS جديد");
    await clickChip("لا يهم");
    await clickChip("ابدأ البحث");
    await page.waitForSelector("text=انتهت حصة الزوار");
    R.visitorLimit = await page.locator(".msg-bot .bubble").last().innerText();
    check(/سجّل الدخول/.test(R.visitorLimit) && (await page.locator(".chip", { hasText: "تسجيل الدخول بحساب تجريبي" }).count()) === 1, "visitor limit offers sign-in");

    // Wrong password, then the right one, from the chip in the conversation.
    await page.locator(".chip", { hasText: "تسجيل الدخول بحساب تجريبي" }).click();
    await page.locator("#accUser").fill("trial07");
    await page.locator("#accPass").fill("wrong");
    await page.locator("#accountLoginForm button[type=submit]").click();
    await page.waitForSelector("#accountLoginError:has-text('غير صحيحة')");
    R.wrongLogin = await page.locator("#accountLoginError").innerText();
    await page.locator("#accPass").fill("Good-Pass-123");
    await page.locator("#accountLoginForm button[type=submit]").click();
    await page.waitForSelector("#accountSignedIn:not([hidden]) .meter");
    R.signedIn = { name: await page.locator("#accountName").innerText(), meters: await page.locator("#accountMeters .meter").count(), text: await page.locator("#accountMeters").innerText(), expiry: await page.locator("#accountExpiry").innerText() };
    check(R.signedIn.name === "trial07" && R.signedIn.meters === 4 && /الأسبوع/.test(R.signedIn.text), "four account meters");
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/accounts-signed-in.png` });

    // Session limit: clear message with the renewal time, no retry, meters updated.
    await page.locator("#promptOverride").fill("نفس البحث");
    await page.locator("#promptOverride").press("Enter");
    await page.waitForSelector("text=بلغت حد الجلسة");
    R.sessionLimit = await page.locator(".msg-bot .bubble").last().innerText();
    R.retryAfterLimit = await page.locator(".msg-bot .bubble").last().locator(".chip").count();
    R.fullBars = await page.locator("#accountMeters .meter-bar.full").count();
    check(/يتجدد/.test(R.sessionLimit) && R.retryAfterLimit === 0 && R.fullBars >= 2, "session limit message");

    // Sign out returns to the visitor allowance.
    await page.locator("#accountLogout").click();
    await page.waitForSelector("#accountSignedOut:not([hidden])");
    R.signedOut = await page.locator("#accountSignedIn").isHidden();
    // English labels follow the language switch.
    await page.locator("#langToggle").click();
    R.english = await page.locator("#accountLoginBtn").innerText();
    check(R.signedOut && /Sign in/.test(R.english), "sign out and English");
    R.errors = errors;
    if (errors.length) failures.push(`page errors: ${errors.join(" | ")}`);
    R.failures = failures;
    R.passed = failures.length === 0;
    return R;
}
