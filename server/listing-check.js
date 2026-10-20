"use strict";

const { CLOSED_LISTING } = require("./research");

// Business-for-sale listings go stale between a search engine's crawl and the
// report, so the live page title decides. Only these hosts are fetched.
const LISTING_HOSTS = ["flippa.com", "acquire.com", "microns.io", "empireflippers.com", "sideprojectors.com"];
const MAX_BYTES = 200 * 1024;

function isListingUrl(value) {
    try {
        const { hostname, protocol } = new URL(value);
        return protocol === "https:" && LISTING_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
    } catch (error) {
        return false;
    }
}

async function pageTitle(url, timeoutMs) {
    const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; QLookListingCheck/1.0)", Accept: "text/html" },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok || !isListingUrl(response.url || url)) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    let html = "";
    const decoder = new TextDecoder();
    while (html.length < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        if (/<\/title>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match ? match[1].trim() : null;
}

// Removes listings whose live page says they were sold or ended. A page that
// cannot be read keeps the opportunity but leaves availability unconfirmed.
async function dropClosedListings(research, { timeoutMs = 6000 } = {}) {
    const checks = await Promise.all(research.opportunities.map(async (opportunity) => {
        if (!isListingUrl(opportunity.directUrl)) return { opportunity, closed: false };
        try {
            const title = await pageTitle(opportunity.directUrl, timeoutMs);
            if (title && CLOSED_LISTING.test(title)) return { opportunity, closed: true };
            if (!title) opportunity.availability = { status: "unknown", sourceUrl: null };
            else opportunity.availability = { status: "available", sourceUrl: opportunity.directUrl };
        } catch (error) {
            opportunity.availability = { status: "unknown", sourceUrl: null };
        }
        return { opportunity, closed: false };
    }));
    const kept = checks.filter((check) => !check.closed).map((check) => check.opportunity);
    const removed = research.opportunities.length - kept.length;
    return { ...research, opportunities: kept, verifiedCount: kept.length, excludedCount: research.excludedCount + removed };
}

module.exports = { dropClosedListings, isListingUrl, LISTING_HOSTS };
