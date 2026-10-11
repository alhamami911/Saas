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

    const sourceCount = Number(data.sourceCount);
    if (!Number.isInteger(sourceCount) || ![3, 5, 8, 10].includes(sourceCount)) {
        return {
            statusCode: 400,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Choose a supported source count: 3, 5, 8, or 10" })
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
    const masterPrompt = `أنت محلل استثمارات SaaS خبير. ابحث على الويب عن فرص ومشاريع SaaS حقيقية وحديثة، ثم أعد تقريراً مفصلاً باللغة ${reportLanguage} بناءً على إعدادات المستخدم. استهدف الاستناد إلى نحو ${sourceCount} مصادر مستقلة وموثوقة. أدرج جدول مقارنة، تحليلاً مالياً، توصية نهائية وخطة عمل واضحة. لا تختلق مصادر أو أرقاماً أو بيانات مالية؛ ميّز التقديرات عن الحقائق، واذكر بوضوح عندما لا تتوفر بيانات. استخدم الاستشهادات التي توفرها أداة البحث فقط.
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
            return {
                statusCode: 502,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Gemini API request failed" })
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
                allSources.findIndex((item) => item.url === source.url) === index)
            .slice(0, sourceCount);

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