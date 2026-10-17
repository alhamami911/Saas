// Browser test for trial accounts with mocked APIs: the free-trial CTA,
// sign-in/sign-up mode switching, usage meters and the messages shown when a
// limit is reached.
export default async function run(page) {
    const failures = [];
    const errors = [];
    const R = {};
    page.on("pageerror", (error) => errors.push(error.message));
    const check = (ok, label) => { if (!ok) failures.push(label); };
    await page.setViewportSize({ width: 1280, height: 900 });
    const estimates = { search: 0.08, discuss: 0.002 };
    const planInfo = { accountDailyUsd: 2.4, dailySearches: 30, signupsOpen: true };
    // Every account gets the same flat budget; this one is deliberately tiny so
    // the UI's limit messages are easy to trigger.
    const visitorAccess = { kind: "visitor", estimates, windows: { day: { used: 0.08, limit: 0.08, resetsAt: "2026-10-15T00:00:00.000Z" } } };
    const accountAccess = (sessionUsed) => ({
        kind: "account", estimates, activatedAt: "2026-10-14T08:00:00.000Z", expiresAt: "2026-11-13T08:00:00.000Z", expired: false, disabled: false,
        windows: {
            session: { used: sessionUsed, limit: 0.08, resetsAt: sessionUsed ? "2026-10-14T13:00:00.000Z" : null },
            day: { used: sessionUsed, limit: 0.08, resetsAt: "2026-10-15T00:00:00.000Z" },
            week: { used: sessionUsed, limit: 0.112, resetsAt: "2026-10-21T08:00:00.000Z" },
            period: { used: sessionUsed, limit: 0.32, resetsAt: null }
        }
    });
    let signedIn = false;
    let signedUpEmail = null;
    await page.route("**/api/account", (route) => {
        if (route.request().method() !== "GET") return route.continue();
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(signedIn
            ? { signedIn: true, username: signedUpEmail || "trial07", access: accountAccess(0), plan: planInfo }
            : { signedIn: false, username: null, access: visitorAccess, plan: planInfo }) });
    });
    await page.route("**/api/account/login", async (route) => {
        const body = JSON.parse(route.request().postData());
        if (body.password !== "Good-Pass-123") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ errorCode: "LOGIN_FAILED" }) });
        signedIn = true;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ signedIn: true, username: "trial07", access: accountAccess(0), plan: planInfo, referralCode: "TRIAL0007" }) });
    });
    await page.route("**/api/account/signup", async (route) => {
        const body = JSON.parse(route.request().postData());
        if (body.website) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ errorCode: "AUTOMATED_REQUEST_REJECTED" }) });
        signedIn = true;
        signedUpEmail = body.email;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
            signedIn: true, username: body.email, access: accountAccess(0), plan: planInfo, recoveryCode: "TEST-CODE-0000", referralCode: "FRIEND01"
        }) });
    });
    await page.route("**/api/account/logout", (route) => { signedIn = false; return route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
    await page.route("**/api/generate", (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify(signedIn
        ? { errorCode: "ACCOUNT_LIMIT", scope: "session", resetsAt: "2026-10-14T13:00:00.000Z", access: accountAccess(0.08) }
        : { errorCode: "VISITOR_LIMIT", scope: "day", resetsAt: "2026-10-15T00:00:00.000Z", access: visitorAccess }) }));

    // The page asks for the account on load, so load it again with the mocks in place.
    await page.reload();
    // The sidebar button promotes the real daily allowance once the plan loads.
    await page.waitForFunction(() => document.getElementById("accountLoginBtn").textContent.includes("30"));
    R.ctaText = await page.locator("#accountLoginBtn").innerText();
    check(/30/.test(R.ctaText), "CTA shows the free daily search allowance");

    // Sign-up happens inline: it validates, rejects a honeypot hit, and logs in.
    await page.locator("#accountLoginBtn").click();
    R.signupIsDefault = await page.locator("#accountSignupForm").isVisible();
    await page.locator("#suEmail").fill("new person@bad");
    await page.locator("#suPass").fill("longenough1");
    await page.locator("#suPassConfirm").fill("longenough1");
    await page.locator("#accountSignupForm button[type=submit]").click();
    R.invalidEmailMsg = await page.locator("#accountSignupError").innerText();
    await page.locator("#suEmail").fill("");
    await page.locator("#suEmail").fill("newcomer@example.com");
    await page.locator("#accountSignupForm button[type=submit]").click();

    // A one-time backup code is shown before the dialog closes - no email involved.
    await page.waitForSelector("#accountCodeReveal:not([hidden])");
    R.recoveryCodeShown = await page.locator("#accountCodeValue").innerText();
    await page.locator("#accountCodeContinue").click();

    await page.waitForSelector("#accountSignedIn:not([hidden])");
    R.signedUpName = await page.locator("#accountName").innerText();
    check(R.signupIsDefault && R.invalidEmailMsg && R.signedUpName === "newcomer@example.com", "sign-up validates then logs the new account in");
    check(R.recoveryCodeShown === "TEST-CODE-0000", "the backup code is shown once at sign-up");
    R.referralVisible = await page.locator(".referral-note").isVisible();
    check(R.referralVisible, "a signed-in account can share its referral link");
    await page.locator("#accountLogout").click();
    await page.waitForSelector("#accountSignedOut:not([hidden])");

    // Visitor: the shared allowance meter and the limit message with a sign-up offer.
    await page.waitForSelector("#visitorMeters .meter-now");
    R.visitorMeter = await page.locator("#visitorMeters").innerText();
    await page.locator("#suggestions .suggestion").first().click();
    // The setup card: one card with every setting, then one click.
    await page.waitForSelector(".setup");
    await page.locator('.setup select[data-field="industry"]').selectOption("المالية والمحاسبة");
    await page.locator('.setup select[data-field="budget"]').selectOption("حتى 100 دولار");
    await page.locator(".setup-go").click();
    await page.waitForSelector("text=انتهت حصة الزوار");
    R.visitorLimit = await page.locator(".msg-bot .bubble").last().innerText();
    check(/أنشئ حساباً مجانياً|سجّل الدخول/.test(R.visitorLimit), "visitor limit message");
    const ctaChip = page.locator(".msg-bot .bubble").last().locator(".chip");
    check((await ctaChip.count()) === 1, "visitor limit offers one CTA chip");

    // The chip opens the dialog in sign-up mode; switch to sign-in for an
    // existing account, with the wrong password first.
    await ctaChip.click();
    check(await page.locator("#accountSignupForm").isVisible(), "the limit CTA opens sign-up by default");
    await page.locator("#goToLogin").click();

    // Forgot password: no email is sent, so this is a backup-code form, round-tripped back to sign-in.
    await page.locator("#goToReset").click();
    check(await page.locator("#accountResetForm").isVisible(), "forgot password opens the backup-code reset form");
    await page.locator("#goToLoginFromReset").click();
    check(await page.locator("#accountLoginForm").isVisible(), "reset form switches back to sign-in");

    await page.locator("#accUser").fill("trial07");
    await page.locator("#accPass").fill("wrong");
    await page.locator("#accountLoginForm button[type=submit]").click();
    await page.waitForSelector("#accountLoginError:has-text('صحيحة')");
    R.wrongLogin = await page.locator("#accountLoginError").innerText();
    await page.locator("#accPass").fill("Good-Pass-123");
    await page.locator("#accountLoginForm button[type=submit]").click();
    await page.waitForSelector("#accountSignedIn:not([hidden]) .meter-now");
    R.signedIn = { name: await page.locator("#accountName").innerText(), meters: await page.locator("#accountMeters .meter").count(), text: await page.locator("#accountMeters").innerText(), expiry: await page.locator("#accountExpiry").innerText() };
    R.signedIn.detailMeters = await page.locator("#accountMeters .meter-details .meter").count();
    check(R.signedIn.name === "trial07" && R.signedIn.detailMeters === 4 && /متبقٍ لك/.test(R.signedIn.text), "one summary line and four detailed meters");
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
    await page.waitForTimeout(150);
    R.english = await page.locator("#accountLoginBtn").innerText();
    check(R.signedOut && /free/i.test(R.english), "sign out and English");
    R.errors = errors;
    if (errors.length) failures.push(`page errors: ${errors.join(" | ")}`);
    R.failures = failures;
    R.passed = failures.length === 0;
    return R;
}
