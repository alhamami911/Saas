"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } = require("node:crypto");

const KEY_PATTERN = /^[A-Za-z0-9_\-.]{20,200}$/;
const CLAUDE_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_\-]{20,300}$/;
const ENVATO_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,43}$/;
const MIN_PASSWORD_LENGTH = 12;

function sha256(value) {
    return createHash("sha256").update(String(value)).digest();
}

function hashPassword(password) {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function passwordMatches(password, stored) {
    const [scheme, saltHex, hashHex] = String(stored).split("$");
    if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(String(password), Buffer.from(saltHex, "hex"), expected.length);
    return timingSafeEqual(actual, expected);
}

function maskKey(key) {
    if (!key) return null;
    return key.length <= 10 ? "••••" : `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

// Settings that admins change at runtime (Gemini key, admin password) live in a
// JSON file on the data volume, so nobody needs shell access to rotate them.
function createSettingsStore({ dataDir, env = process.env }) {
    const file = path.join(dataDir, "settings.json");
    let state = {};

    function load() {
        try {
            state = JSON.parse(fs.readFileSync(file, "utf8")) || {};
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            state = {};
        }
        applyToEnv();
        return state;
    }

    function save() {
        fs.mkdirSync(dataDir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file);
    }

    // The research handler reads its keys and provider from process.env; values saved
    // from the admin page take precedence over ones supplied by the environment.
    const envKey = env.qlook_key;
    const envClaudeKey = env.qlook_claude_key;
    const envProvider = env.QL_PROVIDER;
    const envClaudeModel = env.QL_CLAUDE_MODEL;
    const envEnvatoToken = env.qlook_envato_token;
    function applyValue(name, saved, fallback) {
        if (saved) env[name] = saved;
        else if (fallback) env[name] = fallback;
        else delete env[name];
    }
    function applyToEnv() {
        applyValue("qlook_key", state.geminiKey, envKey);
        applyValue("qlook_claude_key", state.claudeKey, envClaudeKey);
        applyValue("QL_PROVIDER", state.provider, envProvider);
        applyValue("QL_CLAUDE_MODEL", state.claudeModel, envClaudeModel);
        applyValue("qlook_envato_token", state.envatoToken, envEnvatoToken);
    }

    function geminiStatus() {
        const source = state.geminiKey ? "admin" : envKey ? "environment" : null;
        return {
            configured: Boolean(source),
            source,
            masked: maskKey(state.geminiKey || envKey),
            updatedAt: state.geminiKey ? state.geminiKeyUpdatedAt || null : null
        };
    }

    function setGeminiKey(key) {
        const value = String(key || "").trim();
        if (!KEY_PATTERN.test(value)) return { error: "That does not look like a Gemini API key" };
        state.geminiKey = value;
        state.geminiKeyUpdatedAt = new Date().toISOString();
        save();
        applyToEnv();
        return { ok: true };
    }

    function clearGeminiKey() {
        delete state.geminiKey;
        delete state.geminiKeyUpdatedAt;
        save();
        applyToEnv();
    }

    function claudeStatus() {
        const source = state.claudeKey ? "admin" : envClaudeKey ? "environment" : null;
        return {
            configured: Boolean(source),
            source,
            masked: maskKey(state.claudeKey || envClaudeKey),
            updatedAt: state.claudeKey ? state.claudeKeyUpdatedAt || null : null
        };
    }

    function setClaudeKey(key) {
        const value = String(key || "").trim();
        if (!CLAUDE_KEY_PATTERN.test(value)) return { error: "That does not look like a Claude API key" };
        state.claudeKey = value;
        state.claudeKeyUpdatedAt = new Date().toISOString();
        save();
        applyToEnv();
        return { ok: true };
    }

    function clearClaudeKey() {
        delete state.claudeKey;
        delete state.claudeKeyUpdatedAt;
        save();
        applyToEnv();
    }

    function envatoStatus() {
        const source = state.envatoToken ? "admin" : envEnvatoToken ? "environment" : null;
        return { configured: Boolean(source), source, masked: maskKey(state.envatoToken || envEnvatoToken) };
    }

    function setEnvatoToken(token) {
        const value = String(token || "").trim();
        if (!ENVATO_TOKEN_PATTERN.test(value)) return { error: "That does not look like an Envato personal token" };
        state.envatoToken = value;
        save();
        applyToEnv();
        return { ok: true };
    }

    function clearEnvatoToken() {
        delete state.envatoToken;
        save();
        applyToEnv();
    }

    // Provider and model names are validated by the caller against config.js.
    function setResearchProvider({ provider, claudeModel }) {
        state.provider = provider;
        state.claudeModel = claudeModel;
        save();
        applyToEnv();
        return { ok: true };
    }

    function adminConfigured() {
        return Boolean(state.adminPasswordHash || env.ADMIN_PASSWORD);
    }

    function verifyAdminPassword(password) {
        if (typeof password !== "string" || !password) return false;
        if (state.adminPasswordHash) return passwordMatches(password, state.adminPasswordHash);
        if (!env.ADMIN_PASSWORD) return false;
        return timingSafeEqual(sha256(password), sha256(env.ADMIN_PASSWORD));
    }

    function setAdminPassword(password) {
        if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
            return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
        }
        state.adminPasswordHash = hashPassword(password);
        save();
        return { ok: true };
    }

    // ---- Trial plan and accounts ------------------------------------------
    // The product is free for now: an account's day limit is a flat, moderate
    // allowance (accountDailyUsd) rather than a slice of a pool that runs out.
    // perAccountBudgetUsd/periodDays stay as a generous backstop against abuse,
    // not as the everyday constraint. Visitors without an account share one
    // small daily allowance.
    const DEFAULT_PLAN = { perAccountBudgetUsd: 300, periodDays: 365, accountDailyUsd: 2.4, visitorDailyUsd: 1.6, referralBonusUsd: 1.6, signupsOpen: true };
    // A login name is either an admin-issued username or a self-signup email.
    const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.@+-]{2,63}$/;
    const EMAIL_PATTERN = /^[^\s@]{1,80}@[^\s@]{1,80}\.[^\s@]{2,24}$/;
    const ACCOUNT_PASSWORD_MIN_LENGTH = 8;
    const REFERRAL_BONUS_DAYS = 7;
    const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

    function randomCode(length) {
        const bytes = randomBytes(length);
        return Array.from(bytes, (byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]).join("");
    }

    // A readable backup code shown once, used later instead of an email link
    // (the server sends no email) to reset a forgotten password.
    function formatRecoveryCode() {
        const raw = randomCode(12);
        return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
    }

    function normalizeCode(code) {
        return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    }

    function uniqueReferralCode() {
        let code;
        do { code = randomCode(7); } while ((state.accounts || []).some((account) => account.referralCode === code));
        return code;
    }

    function findByReferralCode(code) {
        const normalized = String(code || "").trim().toUpperCase();
        if (!normalized) return null;
        return (state.accounts || []).find((account) => account.referralCode === normalized) || null;
    }

    function plan() {
        return { ...DEFAULT_PLAN, ...(state.plan || {}), id: state.plan?.id || "default", startedAt: state.plan?.startedAt || null };
    }

    function setPlan(input) {
        const number = (value, min, max) => {
            const parsed = Number(value);
            return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
        };
        const next = {
            perAccountBudgetUsd: number(input.perAccountBudgetUsd, 0.5, 100000),
            periodDays: number(input.periodDays, 1, 3650),
            accountDailyUsd: number(input.accountDailyUsd, 0.01, 1000),
            visitorDailyUsd: number(input.visitorDailyUsd, 0, 1000),
            referralBonusUsd: number(input.referralBonusUsd, 0, 1000),
            signupsOpen: Boolean(input.signupsOpen)
        };
        const numericFields = ["perAccountBudgetUsd", "periodDays", "accountDailyUsd", "visitorDailyUsd", "referralBonusUsd"];
        if (numericFields.some((field) => next[field] === null)) return { error: "Check the plan values" };
        // A new budget starts a new period: spend counters are kept per plan id.
        const restart = Boolean(input.restart) || !state.plan?.id;
        state.plan = { ...next, id: restart ? randomUUID() : state.plan.id, startedAt: restart ? new Date().toISOString() : state.plan.startedAt };
        save();
        return { ok: true, plan: plan() };
    }

    // Self-service sign-up: the trial starts immediately, same as a first login.
    // referredByCode is optional: a friend's referral code grants both accounts
    // a temporary daily-limit bonus (no cash, just more headroom for a week).
    function signUpAccount(email, password, referredByCode) {
        const name = String(email || "").trim().toLowerCase();
        if (!EMAIL_PATTERN.test(name)) return { error: "Enter a valid email address", code: "invalid_email" };
        if (typeof password !== "string" || password.length < ACCOUNT_PASSWORD_MIN_LENGTH) {
            return { error: `Password must be at least ${ACCOUNT_PASSWORD_MIN_LENGTH} characters`, code: "weak_password" };
        }
        state.accounts = state.accounts || [];
        if (state.accounts.some((account) => account.username === name)) {
            return { error: "An account with this email already exists", code: "email_taken" };
        }
        const now = new Date().toISOString();
        const recoveryCode = formatRecoveryCode();
        const referrer = findByReferralCode(referredByCode);
        const account = {
            id: randomUUID(), username: name, email: name, passwordHash: hashPassword(password),
            source: "signup", createdAt: now, activatedAt: now, disabled: false,
            referralCode: uniqueReferralCode(), referredBy: referrer ? referrer.id : null,
            recoveryCodeHash: hashPassword(normalizeCode(recoveryCode))
        };
        const bonus = plan().referralBonusUsd;
        if (referrer && bonus > 0) {
            const until = new Date(Date.now() + REFERRAL_BONUS_DAYS * 86400000).toISOString();
            account.bonusDayUsd = bonus;
            account.bonusUntil = until;
            referrer.bonusDayUsd = bonus;
            referrer.bonusUntil = until;
        }
        state.accounts.push(account);
        save();
        return { ok: true, account: publicAccount(account), recoveryCode };
    }

    // No email is sent; the backup code shown once at sign-up is the only proof.
    // A successful reset rotates the code so the old (now-used) one stops working.
    function resetPasswordWithRecoveryCode(email, recoveryCode, newPassword) {
        const name = String(email || "").trim().toLowerCase();
        if (typeof newPassword !== "string" || newPassword.length < ACCOUNT_PASSWORD_MIN_LENGTH) {
            return { error: `Password must be at least ${ACCOUNT_PASSWORD_MIN_LENGTH} characters`, code: "weak_password" };
        }
        const account = (state.accounts || []).find((item) => item.username === name);
        if (!account || !account.recoveryCodeHash || !passwordMatches(normalizeCode(recoveryCode), account.recoveryCodeHash)) {
            return { error: "Email or recovery code is incorrect", code: "invalid_recovery" };
        }
        account.passwordHash = hashPassword(newPassword);
        account.passwordChangedAt = new Date().toISOString();
        const next = formatRecoveryCode();
        account.recoveryCodeHash = hashPassword(normalizeCode(next));
        save();
        return { ok: true, account: publicAccount(account), recoveryCode: next };
    }

    function publicAccount(account) {
        if (!account) return null;
        const { passwordHash, recoveryCodeHash, ...rest } = account;
        return rest;
    }

    function accounts() {
        return (state.accounts || []).map(publicAccount);
    }

    function findAccount(id) {
        return (state.accounts || []).find((account) => account.id === id) || null;
    }

    function randomPassword() {
        // Readable characters only, 14 long: about 80 bits.
        const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const bytes = randomBytes(14);
        return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
    }

    // Creates accounts trial01, trial02, ... and returns their passwords once.
    function generateAccounts(count, prefix = "trial") {
        const total = Math.max(1, Math.min(500, Number(count) || 0));
        if (!/^[a-z][a-z0-9]{1,15}$/.test(prefix)) return { error: "Prefix must be lowercase letters and digits" };
        state.accounts = state.accounts || [];
        const taken = new Set(state.accounts.map((account) => account.username));
        const created = [];
        for (let index = 1; created.length < total && index < 100000; index += 1) {
            const username = `${prefix}${String(index).padStart(2, "0")}`;
            if (taken.has(username)) continue;
            const password = randomPassword();
            const account = { id: randomUUID(), username, passwordHash: hashPassword(password), source: "admin", createdAt: new Date().toISOString(), activatedAt: null, disabled: false };
            state.accounts.push(account);
            taken.add(username);
            created.push({ id: account.id, username, password });
        }
        save();
        return { ok: true, created };
    }

    function updateAccount(id, { disabled }) {
        const account = findAccount(id);
        if (!account) return { error: "Account not found" };
        if (typeof disabled === "boolean") account.disabled = disabled;
        save();
        return { ok: true, account: publicAccount(account) };
    }

    function resetAccountPassword(id) {
        const account = findAccount(id);
        if (!account) return { error: "Account not found" };
        const password = randomPassword();
        account.passwordHash = hashPassword(password);
        account.passwordChangedAt = new Date().toISOString();
        save();
        return { ok: true, username: account.username, password };
    }

    function deleteAccount(id) {
        const before = (state.accounts || []).length;
        state.accounts = (state.accounts || []).filter((account) => account.id !== id);
        save();
        return before === state.accounts.length ? { error: "Account not found" } : { ok: true };
    }

    // Checks a trial login; the trial period starts at the first successful sign-in.
    function verifyAccount(username, password) {
        const name = String(username || "").trim().toLowerCase();
        if (!USERNAME_PATTERN.test(name) || typeof password !== "string" || !password) return null;
        const account = (state.accounts || []).find((item) => item.username === name);
        if (!account || !passwordMatches(password, account.passwordHash)) return null;
        if (!account.activatedAt) {
            account.activatedAt = new Date().toISOString();
            save();
        }
        return publicAccount(account);
    }

    // Changes when the account's password changes, which signs out its old sessions.
    function accountFingerprint(id) {
        const account = findAccount(id);
        return account ? sha256(account.passwordHash).toString("hex") : null;
    }

    // Changes whenever the admin password changes, which invalidates old sessions.
    function credentialFingerprint() {
        return sha256(state.adminPasswordHash || env.ADMIN_PASSWORD || "").toString("hex");
    }

    return {
        load,
        geminiStatus,
        setGeminiKey,
        clearGeminiKey,
        claudeStatus,
        setClaudeKey,
        clearClaudeKey,
        setResearchProvider,
        envatoStatus,
        setEnvatoToken,
        clearEnvatoToken,
        adminConfigured,
        verifyAdminPassword,
        setAdminPassword,
        credentialFingerprint,
        plan,
        setPlan,
        signUpAccount,
        resetPasswordWithRecoveryCode,
        accounts,
        findAccount: (id) => publicAccount(findAccount(id)),
        generateAccounts,
        updateAccount,
        resetAccountPassword,
        deleteAccount,
        verifyAccount,
        accountFingerprint
    };
}

module.exports = { createSettingsStore, maskKey, MIN_PASSWORD_LENGTH };
