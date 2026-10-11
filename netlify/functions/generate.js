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

    if (typeof data.settings !== "string" || !data.settings.trim()) {
        return {
            statusCode: 400,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "A non-empty settings value is required" })
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

    const masterPrompt = `أنت محلل استثمارات SaaS خبير. مهمتك البحث وتقديم تقرير مفصل باللغة العربية بناءً على إعدادات المستخدم. يجب أن يشمل التقرير: جدول مقارنة شامل، التحليل المالي، والتوصيات النهائية مع خطة عمل واضحة للمشروع الأفضل.
        إعدادات البحث المطلوبة: ${data.settings}`;

    try {
        const url = new URL("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
        url.searchParams.set("key", apiKey);

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: masterPrompt }] }] })
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

        const generatedText = resultData.candidates?.[0]?.content?.parts
            ?.map((part) => part.text)
            .filter(Boolean)
            .join("");

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
            body: JSON.stringify({ result: generatedText })
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
