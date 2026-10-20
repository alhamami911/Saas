"use strict";

const { getConfig, estimateCosts, searchAllowance } = require("./config");
const { checkRateLimit, refundRateLimit, clientHash } = require("./rate-limit");
const { seenLinks, rememberLinks } = require("./seen-store");
const { createUsageEvent, storeUsage, dailySpendUsd, addDailySpend, recordRecent } = require("./usage-store");
const { buildResearchPrompt, validateRequest, validateResearchResult, applyCatalogue, catalogueChunks, normalizePublicUrl, partitionEligible, RESEARCH_SCHEMA } = require("./research");
const { collectCandidates } = require("./sources/catalog");
const { runGeminiResearch } = require("./providers/gemini");
const { runClaudeResearch } = require("./providers/claude");
const { dropClosedListings } = require("./listing-check");
const { runPipeline } = require("./pipeline");
const { checkAccess, chargeAccess, accessStatus } = require("./quota");

// Trial limits apply when the server passes the plan: to the signed-in account,
// or to the shared visitor pool for everyone else.
const whoFor = (event) => (event.account ? { account: event.account } : { visitor: true });

async function chargeAndStatus(config, event, usd, personal) {
    if (!event.plan) return null;
    try {
        await chargeAccess(config, event.plan, whoFor(event), usd, { personal });
        return await accessStatus(config, event.plan, whoFor(event));
    } catch (error) {
        console.error("Could not record trial usage", error.message);
        return null;
    }
}

const PROVIDER_LABELS = { claude: "Claude", gemini: "Gemini" };

// Marketplaces without a public search API are reached through web search,
// limited to their own domains. CodeCanyon joins them when no Envato token is set.
const WEB_SEARCH_DOMAINS = ["codester.com", "sourceforge.net", "gumroad.com", "appsumo.com", "acquire.com", "flippa.com", "microns.io", "indiehackers.com", "empireflippers.com", "sideprojectors.com", "lemonsqueezy.com", "openalternative.co", "alternativeto.net", "saashub.com", "producthunt.com"];

// Coverage log: what happened on every approved source in this search. A web-only
// marketplace counts as checked when a query named it or a result came from it.
function sourceCoverage(catalogueCoverage, webDomains, queries = [], sources = []) {
    const fromApi = catalogueCoverage.map((entry) => ({
        source: entry.source,
        method: "official_api",
        status: entry.status !== "ok" ? "error" : entry.count ? "found" : "no_results",
        count: entry.count
    }));
    const hostOf = (uri) => {
        try {
            return new URL(uri).hostname.replace(/^www\./, "");
        } catch (error) {
            return "";
        }
    };
    const fromSearch = webDomains.map((domain) => {
        const results = new Set(sources.map((source) => source.uri).filter((uri) => {
            const host = hostOf(uri);
            return host === domain || host.endsWith(`.${domain}`);
        }));
        const name = domain.split(".")[0].toLowerCase();
        const searched = queries.some((query) => query.toLowerCase().includes(name));
        return {
            source: domain,
            method: "web_search",
            status: results.size ? "found" : searched ? "no_results" : "not_checked",
            count: results.size
        };
    });
    return [...fromApi, ...fromSearch];
}

function jsonResponse(statusCode, payload, extraHeaders = {}) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json", ...extraHeaders },
        body: JSON.stringify(payload)
    };
}

async function persistRequest(config, fields, usage, grounded) {
    const event = createUsageEvent({ provider: config.provider, model: config.model, ...fields, usage: usage || null, grounded });
    const stored = await storeUsage(config, event, grounded);
    const costs = estimateCosts(
        usage,
        config,
        grounded && stored.groundedPromptsToday > config.searchFreeDailyPrompts
    );
    event.groundedPromptsToday = stored.groundedPromptsToday;
    event.estimatedCosts = costs;
    event.spentTodayUsd = await addDailySpend(config, Number(costs.totalUsd));
    await storeUsage(config, event, false);
    // The admin page lists recent searches with their tokens and estimated cost.
    await recordRecent(config, event).catch((error) => console.error("Could not record recent usage", error.message));
    return { requestId: event.requestId, usage: event.usage, costs };
}

async function persistFailure(config, fields, usage, grounded, event) {
    try {
        const accounting = await persistRequest(config, fields, usage, grounded);
        // A failed request still cost money: it counts against the plan, not the person.
        if (event) await chargeAndStatus(config, event, Number(accounting.costs.totalUsd), false);
    } catch (error) {
        console.error("Could not persist failed request usage", error.message);
    }
}

const LOG_STATUS = {
    ar: { found: "فُحص وله نتائج", no_results: "فُحص دون نتائج", error: "تعذّر فحصه", not_checked: "لم يُفحص" },
    en: { found: "checked, results found", no_results: "checked, no results", error: "could not be checked", not_checked: "not checked" }
};

// The summary is written by the server from the actual counts, so it can never
// disagree with the table, the counters or the review list.
function buildSummary(language, { opportunities, alternatives, log, notRelevant, pagesRead, candidatesChecked, requestedCount, closedListings = [] }) {
    const checked = log.filter((entry) => ["found", "no_results"].includes(entry.status)).length;
    const missed = log.filter((entry) => !["found", "no_results"].includes(entry.status));
    const reasons = {};
    for (const item of alternatives) for (const reason of item.reasons) reasons[reason] = (reasons[reason] || 0) + 1;
    const ar = language === "ar";
    const reasonText = {
        license_restricted: ar ? "ترخيص يمنع التشغيل التجاري" : "licence forbids commercial use",
        license_unclear: ar ? "ترخيص غير متحقق أو غير واضح" : "licence not verified or unclear",
        license_not_perpetual: ar ? "اشتراك غير دائم" : "subscription, not perpetual",
        missing_capability: ar ? "تنقصه خاصية مطلوبة" : "lacks a required capability",
        capability_unverified: ar ? "خاصية مطلوبة غير متحققة" : "required capability not verified",
        over_budget: ar ? "أعلى من الميزانية" : "over budget",
        budget_unverified: ar ? "السعر غير متحقق" : "price not verified"
    };
    const breakdown = Object.entries(reasons).map(([key, n]) => `${reasonText[key] || key}: ${n}`).join(ar ? "، " : ", ");
    const parts = [];
    parts.push(ar
        ? `فُحص ${checked} من ${log.length} مصدراً معتمداً، وقُرئت صفحات ${pagesRead} من ${candidatesChecked} منتجاً مرشحاً.`
        : `${checked} of ${log.length} approved sources were checked, and the pages of ${pagesRead} of ${candidatesChecked} candidate products were read.`);
    if (missed.length) {
        parts.push(ar
            ? `لم يكتمل فحص: ${missed.map((entry) => `${entry.source} (${LOG_STATUS.ar[entry.status]})`).join("، ")}؛ لذلك البحث غير شامل.`
            : `Not fully checked: ${missed.map((entry) => `${entry.source} (${LOG_STATUS.en[entry.status]})`).join(", ")}; the search is therefore not complete.`);
    }
    parts.push(ar
        ? `اجتازت ${opportunities.length} فرص شروط الترخيص والخصائص المطلوبة والميزانية من أصل ${requestedCount} مطلوبة.`
        : `${opportunities.length} of the ${requestedCount} requested opportunities passed the licence, required-capability and budget checks.`);
    if (alternatives.length) {
        parts.push(ar
            ? `نُقل ${alternatives.length} منتجاً إلى «للمراجعة» ولا تُحسب ضمن الفرص (${breakdown}).`
            : `${alternatives.length} products were moved to the review list and are not counted (${breakdown}).`);
    }
    if (closedListings.length) {
        parts.push(ar
            ? `واستُبعد ${closedListings.length} منتجاً لأن صفحته تقول إنه لم يعد معروضاً (بيع أو سُحب أو أُزيل).`
            : `${closedListings.length} were left out because their page says they are no longer offered (sold, unlisted or removed).`);
    }
    if (notRelevant) parts.push(ar ? `واستُبعد ${notRelevant} لعدم ملاءمته لما تبحث عنه.` : `${notRelevant} were left out as not matching your request.`);
    return parts.join(" ");
}

// The public log keeps what a reviewer needs: query, time, status, counts and links.
function publicLog(log) {
    return log.map((entry) => ({
        source: entry.source,
        method: entry.method,
        query: entry.query,
        round: entry.round,
        startedAt: entry.startedAt,
        ms: entry.ms,
        status: entry.status,
        error: entry.error || null,
        results: entry.results,
        products: entry.products,
        links: entry.links,
        firstAttempt: entry.firstAttempt || null,
        cached: Boolean(entry.cached),
        cachedAt: entry.cachedAt || null
    }));
}

async function runClaudeSearch(config, request, shown, visitor, event, seenBefore = new Set()) {
    const startedAt = Date.now();
    const result = await runPipeline(config, request, { shown, seenBefore });
    const elapsedMs = Date.now() - startedAt;
    const baseFields = { kind: "search", requestedCount: request.opportunityCount, language: request.language, elapsedMs };
    console.log("Claude pipeline finished", result.ok ? "ok" : result.kind, `${elapsedMs}ms`, `${result.log?.length || 0} sources`);
    if (!result.ok) {
        // A failed search is not charged to the visitor's daily searches.
        await refundRateLimit(event, config).catch(() => {});
        await persistFailure(config, { ...baseFields, outcome: result.kind, coverage: summarizeLog(result.log) }, result.usage, true, event);
        if (result.kind === "quota") return jsonResponse(429, { errorCode: "AI_QUOTA_EXCEEDED", error: "Claude usage quota or credit is exhausted." });
        if (result.kind === "timeout") return jsonResponse(504, { errorCode: "AI_TIMEOUT", error: "The analysis timed out. Try again." });
        if (result.kind === "network") return jsonResponse(502, { errorCode: "AI_UNAVAILABLE", error: "Claude could not be reached" });
        console.error("Claude pipeline failed", result.kind, result.status || "", result.message || "");
        // The failure kind (never provider text) helps a reviewer report what went wrong.
        return jsonResponse(502, { errorCode: "AI_REQUEST_FAILED", reason: `${result.kind}${result.status ? `:${result.status}` : ""}`, error: "The analysis could not be completed. Try again." });
    }

    // Out of AI credit: every marketplace search failed for that reason. Say so
    // plainly instead of returning a report built from the APIs alone.
    const siteSearches = result.log.filter((entry) => entry.method === "site_search");
    if (siteSearches.length && siteSearches.every((entry) => entry.error === "quota")) {
        await refundRateLimit(event, config).catch(() => {});
        await persistFailure(config, { ...baseFields, outcome: "provider_quota_exceeded", coverage: summarizeLog(result.log) }, result.usage, true, event);
        return jsonResponse(429, { errorCode: "AI_QUOTA_EXCEEDED", error: "Claude usage quota or credit is exhausted." });
    }
    let research = { opportunities: result.opportunities, verifiedCount: result.opportunities.length, excludedCount: 0 };
    research = await dropClosedListings(research);
    research.opportunities = research.opportunities.filter((opportunity) => !shown.has(opportunity.directUrl));
    research = partitionEligible(research, request);
    await rememberLinks(config, visitor, [...research.opportunities, ...research.alternatives].map((opportunity) => opportunity.directUrl));

    const log = publicLog(result.log);
    const coverageComplete = log.every((entry) => ["found", "no_results"].includes(entry.status));
    let accounting;
    try {
        accounting = await persistRequest(config, {
            ...baseFields,
            verifiedCount: research.verifiedCount,
            reviewCount: research.alternatives.length,
            outcome: "success",
            coverage: summarizeLog(result.log),
            pagesRead: result.pagesRead
        }, result.usage, true);
    } catch (error) {
        console.error("Usage accounting failed; withholding report", error.message);
        await refundRateLimit(event, config).catch(() => {});
        return jsonResponse(503, { errorCode: "USAGE_ACCOUNTING_UNAVAILABLE", error: "Usage tracking is temporarily unavailable. Please retry shortly." });
    }
    const access = await chargeAndStatus(config, event, Number(accounting.costs.totalUsd), true);
    return jsonResponse(200, {
        access,
        summary: buildSummary(request.language, { ...research, log, notRelevant: result.notRelevant, pagesRead: result.pagesRead, candidatesChecked: result.candidatesChecked, requestedCount: request.opportunityCount, closedListings: result.closedListings }),
        closedListings: result.closedListings,
        verificationNote: "",
        opportunities: research.opportunities,
        alternatives: research.alternatives,
        verifiedCount: research.verifiedCount,
        requestedCount: request.opportunityCount,
        excludedCount: research.alternatives.length + result.notRelevant,
        coverage: log,
        coverageComplete,
        candidatesChecked: result.candidatesChecked,
        pagesRead: result.pagesRead,
        unreadPages: result.unreadPages,
        provider: config.provider,
        elapsedMs,
        requestId: accounting.requestId
    });
}

// The daily budget renews at midnight UTC.
function budgetResetsAt(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString();
}

function summarizeLog(log = []) {
    return log.map((entry) => `${entry.source}:${entry.status}:${entry.products ?? 0}`).join(" ");
}

exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return jsonResponse(405, { errorCode: "METHOD_NOT_ALLOWED", error: "Method Not Allowed" }, { Allow: "POST" });
    }

    let config;
    try {
        config = getConfig();
    } catch (error) {
        console.error("Invalid QLook environment configuration", error.message);
        return jsonResponse(500, { errorCode: "INVALID_SERVER_CONFIGURATION", error: "Server configuration is invalid" });
    }
    const label = PROVIDER_LABELS[config.provider];
    if (!config.apiKey) {
        console.error(`${label} API key is not configured`);
        return jsonResponse(503, {
            errorCode: config.provider === "claude" ? "CLAUDE_KEY_MISSING" : "GEMINI_KEY_MISSING",
            error: `${label} service is not configured`
        });
    }

    const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body || "", "base64").toString("utf8")
        : event.body || "";
    if (Buffer.byteLength(rawBody, "utf8") > config.maxRequestBodyBytes) {
        return jsonResponse(413, { errorCode: "REQUEST_TOO_LARGE", error: "Request body exceeds the allowed size" });
    }
    const contentType = event.headers?.["content-type"] || event.headers?.["Content-Type"];
    if (contentType && !contentType.toLowerCase().startsWith("application/json")) {
        return jsonResponse(415, { errorCode: "UNSUPPORTED_CONTENT_TYPE", error: "Send the request as application/json" });
    }

    let data;
    try {
        data = JSON.parse(rawBody);
    } catch (error) {
        return jsonResponse(400, { errorCode: "INVALID_JSON", error: "Invalid JSON request body" });
    }
    const validation = validateRequest(data, config);
    if (validation.error) {
        return jsonResponse(validation.statusCode, {
            errorCode: validation.errorCode,
            error: validation.error
        });
    }

    const limit = await checkRateLimit(event, config);
    if (!limit.allowed) {
        const headers = limit.retryAfter ? { "Retry-After": String(limit.retryAfter) } : {};
        return jsonResponse(limit.statusCode, { errorCode: limit.errorCode, error: limit.error }, headers);
    }
    if (event.plan) {
        let access;
        try {
            access = await checkAccess(config, event.plan, whoFor(event), "search");
        } catch (error) {
            await refundRateLimit(event, config).catch(() => {});
            return jsonResponse(503, { errorCode: "RATE_LIMIT_UNAVAILABLE", error: "Usage limits are temporarily unavailable" });
        }
        if (!access.allowed) {
            await refundRateLimit(event, config).catch(() => {});
            return jsonResponse(429, { errorCode: access.errorCode, scope: access.scope || null, resetsAt: access.resetsAt || null, access: access.status, error: "Usage limit reached" });
        }
    }

    // Stop before spending once today's estimated provider cost reaches the budget.
    let spentToday;
    try {
        spentToday = await dailySpendUsd(config);
    } catch (error) {
        console.error("Daily budget check failed", error.message);
        return jsonResponse(503, { errorCode: "BUDGET_CHECK_UNAVAILABLE", error: "Research is temporarily unavailable. Please retry shortly." });
    }
    if (spentToday >= config.dailyBudgetUsd) {
        console.error("Daily research budget reached", spentToday.toFixed(4), config.dailyBudgetUsd);
        return jsonResponse(429, {
            errorCode: "DAILY_BUDGET_REACHED",
            resetsAt: budgetResetsAt(),
            error: "Today's research budget has been used. Please try again tomorrow."
        }, { "Retry-After": "3600" });
    }

    // The report is written in the language the dashboard was using.
    const request = validation.value;
    // Never show a visitor the same product twice: links from "find more" plus
    // everything this IP was shown in the last 14 days.
    // A signed-in trial account is one person on every device; visitors are counted by IP.
    const visitor = event.account ? `account-${event.account.id}` : clientHash(event, config);
    const previouslySeen = (await seenLinks(config, visitor)).map(normalizePublicUrl).filter(Boolean);
    if (config.provider === "claude") return runClaudeSearch(config, request, new Set(request.exclude), visitor, event, new Set(previouslySeen));
    const shown = new Set([...request.exclude, ...previouslySeen]);
    const catalogue = config.catalogEnabled
        ? await collectCandidates(request, { envatoToken: config.envatoToken, githubToken: config.githubToken })
        : { candidates: [], coverage: [] };
    // Products already on the visitor's screen are not offered again.
    catalogue.candidates = catalogue.candidates.filter((candidate) => !shown.has(normalizePublicUrl(candidate.url)));
    const webDomains = config.provider === "claude"
        ? [...WEB_SEARCH_DOMAINS, ...(config.envatoToken ? [] : ["codecanyon.net"])]
        : [];
    const prompt = buildResearchPrompt({ ...request, exclude: [...shown].slice(0, 60), candidates: catalogue.candidates, webDomains });
    const startedAt = Date.now();
    const result = config.provider === "claude"
        ? await runClaudeResearch(config, prompt, {
            // Repeat searches need extra queries to get past what the visitor already saw.
            // One targeted search per web-only marketplace, plus a couple to dig deeper.
            maxSearches: Math.min(config.claudeMaxSearches, Math.max(searchAllowance(config, request.opportunityCount), webDomains.length + 2) + (shown.size ? 2 : 0)),
            allowedDomains: webDomains,
            schema: RESEARCH_SCHEMA
        })
        : await runGeminiResearch(config, prompt);
    const elapsedMs = Date.now() - startedAt;
    const baseFields = { requestedCount: request.opportunityCount, language: request.language, elapsedMs };
    console.log(`${label} research finished`, result.ok ? "ok" : result.kind, `${elapsedMs}ms`, `${result.sources?.length || 0} sources`);

    if (!result.ok) {
        await persistFailure(config, {
            ...baseFields,
            providerStatus: result.status,
            outcome: result.kind === "quota" ? "provider_quota_exceeded" : result.kind
        }, result.usage, false);
        console.error(`${label} request failed`, result.kind, result.status || "", result.message);
        if (result.kind === "timeout" || result.kind === "network") {
            const timedOut = result.kind === "timeout";
            return jsonResponse(timedOut ? 504 : 502, {
                errorCode: timedOut ? "AI_TIMEOUT" : "AI_UNAVAILABLE",
                error: timedOut ? `${label} request timed out. Try again.` : `${label} could not be reached`
            });
        }
        return jsonResponse(result.kind === "quota" ? 429 : 502, {
            errorCode: result.kind === "quota" ? "AI_QUOTA_EXCEEDED" : "AI_REQUEST_FAILED",
            error: result.kind === "quota"
                ? `${label} usage quota or credit is exhausted. Check the provider account and try again later.`
                : `${label} rejected the research request. Check the admin key test for details.`
        });
    }

    if (!result.text || result.truncated) {
        const errorCode = result.truncated ? "OUTPUT_LIMIT_REACHED" : "EMPTY_MODEL_RESPONSE";
        await persistFailure(config, { ...baseFields, outcome: errorCode.toLowerCase() }, result.usage, result.grounded);
        return jsonResponse(502, {
            errorCode,
            error: result.truncated
                ? `${label} reached the configured output limit. Retry with fewer opportunities.`
                : `${label} returned no research text`
        });
    }

    const groundingChunks = [...result.sources.map((source) => ({ web: source })), ...catalogueChunks(catalogue.candidates)];
    // The model proposes a few spare candidates so the eligibility gate can drop some.
    const research = validateResearchResult(result.text, groundingChunks, request.opportunityCount + 3, new Date(), request.language, request.filters);
    if (research.error) {
        await persistFailure(config, { ...baseFields, outcome: research.errorCode }, result.usage, result.grounded);
        return jsonResponse(502, { errorCode: research.errorCode, error: research.error });
    }
    research.value = await dropClosedListings(applyCatalogue(research.value, catalogue.candidates, request.language));
    const repeated = research.value.opportunities.filter((opportunity) => shown.has(opportunity.directUrl)).length;
    if (repeated) {
        const opportunities = research.value.opportunities.filter((opportunity) => !shown.has(opportunity.directUrl));
        research.value = { ...research.value, opportunities, verifiedCount: opportunities.length, excludedCount: research.value.excludedCount + repeated };
    }
    research.value = partitionEligible(research.value, request);

    await rememberLinks(config, visitor, [...research.value.opportunities, ...research.value.alternatives].map((opportunity) => opportunity.directUrl));

    let accounting;
    try {
        accounting = await persistRequest(config, {
            ...baseFields,
            verifiedCount: research.value.verifiedCount,
            excludedCount: research.value.excludedCount,
            outcome: "success"
        }, result.usage, result.grounded);
    } catch (error) {
        console.error("Usage accounting failed; withholding report", error.message);
        return jsonResponse(503, {
            errorCode: "USAGE_ACCOUNTING_UNAVAILABLE",
            error: "Usage tracking is temporarily unavailable. Please retry shortly."
        });
    }

    // Tokens and estimated costs are shown on the admin page only.
    return jsonResponse(200, {
        ...research.value,
        requestedCount: request.opportunityCount,
        provider: config.provider,
        model: config.model,
        elapsedMs,
        coverage: sourceCoverage(catalogue.coverage, webDomains, result.queries, result.sources),
        sources: [...new Map(result.sources
            .filter((source) => source?.uri)
            .map((source) => [source.uri, { title: source.title, url: source.uri }])).values()],
        requestId: accounting.requestId
    });
};
