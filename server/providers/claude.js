"use strict";

const MAX_CONTINUATIONS = 4;

// The SDK is loaded lazily so tests can swap the client without installing it.
let createClient = (options) => {
    const Anthropic = require("@anthropic-ai/sdk");
    return new Anthropic(options);
};

function setClientFactory(factory) {
    const previous = createClient;
    createClient = factory;
    return previous;
}

// Opus and Sonnet take the dynamic-filtering search tool; Haiku takes the basic one.
function webSearchTool(model, maxUses) {
    const type = /^claude-(opus|sonnet)-/.test(model) ? "web_search_20260209" : "web_search_20250305";
    return { type, name: "web_search", max_uses: maxUses };
}

function collectSources(content, sources) {
    for (const block of content) {
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
            for (const result of block.content) {
                if (result.type === "web_search_result" && result.url) sources.push({ uri: result.url, title: result.title });
            }
        }
        if (block.type === "text" && Array.isArray(block.citations)) {
            for (const citation of block.citations) {
                if (citation.url) sources.push({ uri: citation.url, title: citation.title });
            }
        }
    }
}

function classifyError(error) {
    const status = Number(error?.status) || undefined;
    const message = typeof error?.message === "string" ? error.message.slice(0, 500) : "No provider error details";
    if (error?.name === "APIConnectionTimeoutError" || error?.name === "AbortError" || error?.name === "TimeoutError") {
        return { kind: "timeout", status, message: "timeout" };
    }
    if (status === undefined) return { kind: "network", message };
    if (status === 429 || /credit balance|quota|billing/i.test(message)) return { kind: "quota", status, message };
    return { kind: "provider_error", status, message };
}

// Runs one Claude research turn with server-side web search and returns the shared
// research result shape. Search results carry the real page URLs, so grounding
// verification can compare them directly with the URLs in the report.
async function runClaudeResearch(config, prompt) {
    const client = createClient({ apiKey: config.apiKey, maxRetries: 1, timeout: config.requestTimeoutMs });
    const signal = AbortSignal.timeout(config.requestTimeoutMs);
    const messages = [{ role: "user", content: prompt }];
    const sources = [];
    const texts = [];
    const usage = { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0, webSearchRequests: 0 };
    let message;

    try {
        for (let turn = 0; turn <= MAX_CONTINUATIONS; turn += 1) {
            const stream = client.messages.stream({
                model: config.model,
                max_tokens: config.maxOutputTokens,
                output_config: { effort: config.claudeEffort },
                tools: [webSearchTool(config.model, config.claudeMaxSearches)],
                messages
            }, { signal });
            message = await stream.finalMessage();

            const input = (message.usage?.input_tokens || 0)
                + (message.usage?.cache_creation_input_tokens || 0)
                + (message.usage?.cache_read_input_tokens || 0);
            const output = message.usage?.output_tokens || 0;
            const thinking = message.usage?.output_tokens_details?.thinking_tokens || 0;
            usage.promptTokenCount += input;
            usage.candidatesTokenCount += output - thinking;
            usage.thoughtsTokenCount += thinking;
            usage.totalTokenCount += input + output;
            usage.webSearchRequests += message.usage?.server_tool_use?.web_search_requests || 0;

            collectSources(message.content, sources);
            for (const block of message.content) if (block.type === "text") texts.push(block.text);

            // A long server-tool turn can pause; send it back unchanged to let it finish.
            if (message.stop_reason !== "pause_turn") break;
            messages.push({ role: "assistant", content: message.content });
        }
    } catch (error) {
        return { ok: false, ...classifyError(error), usage, sources };
    }

    if (message.stop_reason === "refusal") {
        return { ok: false, kind: "provider_error", message: `Claude declined the request (${message.stop_details?.category || "unspecified"})`, usage, sources };
    }
    return {
        ok: true,
        text: texts.join(""),
        truncated: message.stop_reason === "max_tokens" || message.stop_reason === "pause_turn",
        sources,
        grounded: usage.webSearchRequests > 0,
        usage
    };
}

// Checks a Claude key for the admin page. Looking up the model is free and proves the
// key exists; `research` also runs a one-search request, the same shape research uses.
async function testClaudeKey(apiKey, model, { research = false } = {}) {
    const client = createClient({ apiKey, maxRetries: 0, timeout: 60000 });
    try {
        await client.models.retrieve(model);
        if (!research) return { valid: true };
        const message = await client.messages.create({
            model,
            max_tokens: 2000,
            output_config: { effort: "low" },
            tools: [webSearchTool(model, 1)],
            messages: [{ role: "user", content: "Search the web for one SaaS boilerplate on CodeCanyon and reply with its name only." }]
        });
        if (!message.usage?.server_tool_use?.web_search_requests) {
            return { valid: false, reachable: true, research: false, message: "Key works, but the test request ran no web search" };
        }
        return { valid: true, research: true };
    } catch (error) {
        const failure = classifyError(error);
        if (failure.kind === "network" || failure.kind === "timeout") {
            return { valid: false, reachable: false, message: "Anthropic could not be reached to check the key" };
        }
        return { valid: false, reachable: true, status: failure.status, message: failure.message.slice(0, 300) };
    }
}

module.exports = { runClaudeResearch, testClaudeKey, setClientFactory, webSearchTool };
