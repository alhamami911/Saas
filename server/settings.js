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
    // Every account — self-signed-up or admin-issued — gets the same free credit,
    // spent across a 5-hour session, the day, the week and the whole trial.
    // Visitors without an account share one small daily allowance.
    const DEFAULT_PLAN = { perAccountBudgetUsd: 20, periodDays: 30, visitorDailyUsd: 0.08, signupsOpen: true };
    // A login name is either an admin-issued username or a self-signup email.
    const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.@+-]{2,63}$/;
    const EMAIL_PATTERN = /^[^\s@]{1,80}@[^\s@]{1,80}\.[^\s@]{2,24}$/;
    const ACCOUNT_PASSWORD_MIN_LENGTH = 8;

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
            periodDays: number(input.periodDays, 1, 366),
            visitorDailyUsd: number(input.visitorDailyUsd, 0, 1000),
            signupsOpen: Boolean(input.signupsOpen)
        };
        if (next.perAccountBudgetUsd === null || next.periodDays === null || next.visitorDailyUsd === null) return { error: "Check the plan values" };
        // A new budget starts a new period: spend counters are kept per plan id.
        const restart = Boolean(input.restart) || !state.plan?.id;
        state.plan = { ...next, id: restart ? randomUUID() : state.plan.id, startedAt: restart ? new Date().toISOString() : state.plan.startedAt };
        save();
        return { ok: true, plan: plan() };
    }

    // Self-service sign-up: the trial starts immediately, same as a first login.
    function signUpAccount(email, password) {
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
        const account = { id: randomUUID(), username: name, email: name, passwordHash: hashPassword(password), source: "signup", createdAt: now, activatedAt: now, disabled: false };
        state.accounts.push(account);
        save();
        return { ok: true, account: publicAccount(account) };
    }

    function publicAccount(account) {
        if (!account) return null;
        const { passwordHash, ...rest } = account;
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
