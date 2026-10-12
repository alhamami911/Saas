exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405,
            headers: { Allow: "POST" },
            body: "Method Not Allowed"
        };
    }

    let data;
    try {
        data = JSON.parse(event.body || "");
    } catch (error) {
        return {
            statusCode: 400,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Invalid JSON request body" })
        };
    }

    if (!data || typeof data !== "object" || Array.isArray(data)
        || typeof data.settings !== "string" || !data.settings.trim()) {
        return {
            statusCode: 400,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "A non-empty settings value is required" })
        };
    }

    const opportunityCount = Number(data.opportunityCount);
    if (!Number.isInteger(opportunityCount) || ![5, 10, 20].includes(opportunityCount)) {
        return {
            statusCode: 400,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Choose a supported opportunity count: 5, 10, or 20" })
        };
    }

    const language = data.language === undefined ? "ar" : data.language;
    if (language !== "ar" && language !== "en") {
        return {
            statusCode: 400,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Choose a supported report language: ar or en" })
        };
    }

    const filterDescriptions = {
        rtl_support: "RTL and right-to-left language support",
        multi_tenant: "multi-tenant architecture with organization/workspace support",
        arabic_localization: "Arabic localization and Arabic-language interface",
        api_integrations: "API integrations",
        ai_features: "AI features",
        white_label: "white-label capability",
        security_compliance: "security and regulatory compliance"
    };
    const filters = data.filters === undefined ? [] : data.filters;
    if (!Array.isArray(filters)
        || filters.some((filter) => typeof filter !== "string"
            || !Object.prototype.hasOwnProperty.call(filterDescriptions, filter))
        || new Set(filters).size !== filters.length) {
        return {
            statusCode: 400,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Choose valid, unique SaaS capability filters" })
        };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("GEMINI_API_KEY is not configured");
        return {
            statusCode: 500,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "The Gemini API key is not configured" })
        };
    }

    const reportLanguage = language === "ar" ? "العربية" : "الإنجليزية";
    const selectedFilters = filters.length
        ? filters.map((filter) => filterDescriptions[filter]).join(", ")
        : "No mandatory product capability filters";
    const masterPrompt = `أنت محلل استثمارات SaaS خبير. ابحث على الويب عن فرص ومشاريع SaaS حقيقية وحديثة، ثم أعد تقريراً مفصلاً باللغة ${reportLanguage} بناءً على إعدادات المستخدم. أنشئ ${opportunityCount} فرص SaaS منفصلة بالضبط، ورقّم كل فرصة واجعلها واضحة ومستقلة في جدول المقارنة والتوصيات. طبّق خصائص SaaS المطلوبة التالية كمرشحات إلزامية، ولا تعرض فرصة على أنها مطابقة ما لم يدعمها مصدر موثوق: ${selectedFilters}. إذا تعذر العثور على ${opportunityCount} فرص تطابق المرشحات، اذكر العدد الذي أمكن التحقق منه ولا تختلق فرصاً ولا تخفف المرشحات. استخدم بحث الويب والاستشهادات لدعم الفرص، وأدرج روابط المصادر الحقيقية في التقرير. أضف تحليلاً مالياً وتوصية نهائية وخطة عمل واضحة. لا تختلق مصادر أو أرقاماً أو بيانات مالية؛ ميّز التقديرات عن الحقائق، واذكر بوضوح عندما لا تتوفر بيانات. استخدم الاستشهادات التي توفرها أداة البحث فقط.
        إعدادات البحث المطلوبة: ${data.settings}`;

    try {
        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey
            },
            body: JSON.stringify({
                model: "gemini-3.8-flash",
                input: masterPrompt,
                tools: [{ type: "google_search" }],
                store: false
            })
        });

        const resultData = await response.json();
        if (!response.ok) {
            console.error("Gemini API request failed", response.status, resultData.error?.message);
            const quotaExceeded = response.status === 429
                || resultData.error?.status === "RESOURCE_EXHAUSTED";
            return {
                statusCode: quotaExceeded ? 429 : 502,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    errorCode: quotaExceeded ? "AI_QUOTA_EXCEEDED" : "GEMINI_REQUEST_FAILED",
                    error: quotaExceeded
                        ? "The AI search quota is exceeded. Check Gemini API billing and usage limits, then try again."
                        : "Gemini API request failed"
                })
            };
        }

        const generatedText = resultData.steps
            ?.filter((step) => step.type === "model_output")
            .flatMap((step) => step.content || [])
            .map((part) => part.text)
            .filter(Boolean)
            .join("");
        const sources = resultData.steps
            ?.filter((step) => step.type === "model_output")
            .flatMap((step) => step.content || [])
            .flatMap((part) => part.annotations || [])
            .filter((annotation) => annotation.type === "url_citation"
                && typeof annotation.url === "string"
                && /^https?:\/\//i.test(annotation.url))
            .map((annotation) => ({ title: annotation.title, url: annotation.url }))
            .filter((source, index, allSources) =>
                allSources.findIndex((item) => item.url === source.url) === index);

        if (!generatedText) {
            console.error("Gemini API response did not contain generated text");
            return {
                statusCode: 502,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Gemini returned no generated text" })
            };
        }

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ result: generatedText, sources })
        };
    } catch (error) {
        console.error("Failed to generate the SaaS opportunity report", error);
        return {
            statusCode: 502,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Unable to generate the report" })
        };
    }
};