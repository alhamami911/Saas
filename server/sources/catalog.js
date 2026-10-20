"use strict";

const { searchTerms, budgetCap } = require("./keywords");

const TIMEOUT_MS = 8000;
const USER_AGENT = "QLook/1.0 (+https://qlook.jawab.sa)";
const AWESOME_URL = "https://raw.githubusercontent.com/awesome-selfhosted/awesome-selfhosted/master/README.md";
const AWESOME_TTL_MS = 12 * 60 * 60 * 1000;

let awesomeCache = { at: 0, entries: null };

async function getJson(url, headers = {}) {
    const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    return response.json();
}

function bounded(value, length) {
    return typeof value === "string" ? value.trim().slice(0, length) : null;
}

// GitHub: public repositories ranked by stars, with the license GitHub detected.
async function searchGitHub(terms, { token } = {}) {
    // A bare "saas" matches link lists; the topic tag finds actual products.
    const query = terms === "saas"
        ? "topic:saas archived:false stars:>30"
        : `${terms} in:name,description,topics archived:false stars:>30`;
    const data = await getJson(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=10`,
        token ? { Authorization: `Bearer ${token}` } : {}
    );
    return (data.items || []).filter((repo) => !/awesome|free-for|public-apis|\blist\b/i.test(repo.full_name)).map((repo) => ({
        source: "GitHub",
        sourceType: "repository",
        name: bounded(repo.full_name, 200),
        url: repo.html_url,
        description: bounded(repo.description, 300),
        license: repo.license?.spdx_id && repo.license.spdx_id !== "NOASSERTION" ? repo.license.spdx_id : null,
        stars: repo.stargazers_count,
        updatedAt: repo.pushed_at?.slice(0, 10) || null
    }));
}

// GitLab: the search listing omits licenses, so the top projects are looked up one by one.
async function searchGitLab(terms) {
    const projects = await getJson(
        `https://gitlab.com/api/v4/projects?search=${encodeURIComponent(terms)}&order_by=star_count&sort=desc&per_page=5&archived=false`
    );
    return Promise.all((Array.isArray(projects) ? projects : []).map(async (project) => {
        let license = null;
        try {
            const detail = await getJson(`https://gitlab.com/api/v4/projects/${project.id}?license=true`);
            license = detail.license?.name || null;
        } catch (error) {
            license = null;
        }
        return {
            source: "GitLab",
            sourceType: "repository",
            name: bounded(project.path_with_namespace, 200),
            url: project.web_url,
            description: bounded(project.description, 300),
            license,
            stars: project.star_count,
            updatedAt: project.last_activity_at?.slice(0, 10) || null
        };
    }));
}

// Codeberg (Forgejo API): the search omits licenses, so each repository's
// LICENSE file is read and its first lines name the license.
const LICENSE_NAMES = [
    [/GNU AFFERO/i, "AGPL-3.0"], [/GNU LESSER/i, "LGPL"], [/GNU GENERAL PUBLIC/i, "GPL"],
    [/Mozilla Public/i, "MPL-2.0"], [/Apache License/i, "Apache-2.0"], [/MIT License|Permission is hereby granted, free of charge/i, "MIT"],
    [/BSD/i, "BSD"], [/European Union Public/i, "EUPL"], [/ISC License/i, "ISC"]
];

async function codebergLicense(fullName) {
    for (const file of ["LICENSE", "LICENSE.md", "COPYING"]) {
        try {
            const response = await fetch(`https://codeberg.org/${fullName}/raw/branch/HEAD/${file}`, {
                headers: { "User-Agent": USER_AGENT },
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
            if (!response.ok) continue;
            const head = (await response.text()).slice(0, 1500);
            return LICENSE_NAMES.find(([pattern]) => pattern.test(head))?.[1] || null;
        } catch (error) {
            return null;
        }
    }
    return null;
}

async function searchCodeberg(terms) {
    const data = await getJson(
        `https://codeberg.org/api/v1/repos/search?q=${encodeURIComponent(terms)}&sort=stars&order=desc&limit=8`
    );
    const repos = (data.data || []).filter((repo) => !repo.archived && !repo.fork && !repo.mirror).slice(0, 4);
    return Promise.all(repos.map(async (repo) => ({
        source: "Codeberg",
        sourceType: "repository",
        name: bounded(repo.full_name, 200),
        url: repo.html_url,
        description: bounded(repo.description, 300),
        license: await codebergLicense(repo.full_name),
        stars: repo.stars_count,
        updatedAt: repo.updated_at?.slice(0, 10) || null
    })));
}

// Awesome Selfhosted lines look like:
// - [Name](url) - Description. ([Demo](..), [Source Code](url)) `License` `Platform`
function parseAwesome(markdown) {
    const entries = [];
    let section = "";
    for (const line of markdown.split("\n")) {
        if (line.startsWith("### ")) section = line.slice(4).trim();
        const match = line.match(/^- \[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s+(?:`⚠`\s+)?-\s+(.*)$/);
        if (!match || !section) continue;
        const [, name, website, rest] = match;
        const sourceCode = rest.match(/\[Source Code\]\((https?:\/\/[^)\s]+)\)/)?.[1] || null;
        const tags = [...rest.matchAll(/`([^`]+)`/g)].map((tag) => tag[1]);
        entries.push({
            name,
            website,
            sourceCode,
            description: rest.replace(/\s*\(\[.*$/, "").replace(/`[^`]+`/g, "").trim(),
            license: tags[0] || null,
            section
        });
    }
    return entries;
}

async function searchAwesomeSelfhosted(terms) {
    if (!awesomeCache.entries || Date.now() - awesomeCache.at > AWESOME_TTL_MS) {
        const response = await fetch(AWESOME_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        awesomeCache = { at: Date.now(), entries: parseAwesome(await response.text()) };
    }
    const words = terms.toLowerCase().split(/\s+/).filter((word) => word.length > 2 && word !== "saas");
    const scored = awesomeCache.entries.map((entry) => {
        const haystack = `${entry.name} ${entry.description} ${entry.section}`.toLowerCase();
        return { entry, score: words.length ? words.filter((word) => haystack.includes(word)).length : 1 };
    }).filter((item) => item.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map(({ entry }) => ({
        source: "Awesome Selfhosted",
        sourceType: "repository",
        name: bounded(entry.name, 200),
        url: entry.sourceCode || entry.website,
        website: entry.website,
        description: bounded(`${entry.section}: ${entry.description}`, 300),
        license: entry.license,
        stars: null,
        updatedAt: null
    }));
}

// CodeCanyon through the official Envato API (needs a free personal token).
async function searchCodeCanyon(terms, { token, maxPriceUsd }) {
    const data = await getJson(
        `https://api.envato.com/v1/discovery/search/search/item?site=codecanyon.net&term=${encodeURIComponent(terms)}&sort_by=sales&page_size=10`,
        { Authorization: `Bearer ${token}` }
    );
    return (data.matches || [])
        .filter((item) => !maxPriceUsd || !(item.price_cents > maxPriceUsd * 100))
        .map((item) => ({
            source: "CodeCanyon",
            sourceType: "marketplace",
            name: bounded(item.name, 200),
            url: item.url,
            description: bounded(item.description, 300),
            license: "Regular License",
            price: Number.isFinite(item.price_cents) ? { amount: (item.price_cents / 100).toFixed(2), currency: "USD" } : null,
            sales: item.number_of_sales ?? null,
            rating: item.rating?.rating ?? null,
            updatedAt: item.updated_at?.slice(0, 10) || null
        }));
}

// Queries every official catalogue in parallel. A failing source is reported in
// coverage and never blocks the others.
async function collectCandidates(request, { envatoToken, githubToken } = {}) {
    const terms = searchTerms(request);
    const tasks = [
        ["GitHub", () => searchGitHub(terms, { token: githubToken })],
        ["GitLab", () => searchGitLab(terms)],
        ["Codeberg", () => searchCodeberg(terms)],
        ["Awesome Selfhosted", () => searchAwesomeSelfhosted(terms)]
    ];
    if (envatoToken) tasks.push(["CodeCanyon", () => searchCodeCanyon(terms, { token: envatoToken, maxPriceUsd: budgetCap(request.budget) })]);

    const results = await Promise.all(tasks.map(async ([source, run]) => {
        const started = Date.now();
        try {
            const items = (await run()).filter((item) => item.url && item.name);
            return { source, items, coverage: { source, method: "official_api", status: "ok", count: items.length, ms: Date.now() - started } };
        } catch (error) {
            console.error(`Catalogue search failed for ${source}`, error.message);
            const reason = error.name === "TimeoutError" ? "timeout" : error.status ? `HTTP ${error.status}` : "request_failed";
            return { source, items: [], coverage: { source, method: "official_api", status: "error", error: reason, count: 0, ms: Date.now() - started } };
        }
    }));
    return {
        terms,
        candidates: results.flatMap((result) => result.items),
        coverage: results.map((result) => result.coverage)
    };
}

module.exports = { collectCandidates, parseAwesome, searchGitHub, searchGitLab, searchCodeberg, searchCodeCanyon };
