"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, scryptSync, timingSafeEqual, createHash } = require("node:crypto");

const KEY_PATTERN = /^[A-Za-z0-9_\-.]{20,200}$/;
const CLAUDE_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_\-]{20,300}$/;
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
        adminConfigured,
        verifyAdminPassword,
        setAdminPassword,
        credentialFingerprint
    };
}

module.exports = { createSettingsStore, maskKey, MIN_PASSWORD_LENGTH };
