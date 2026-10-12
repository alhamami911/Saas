"use strict";

// The dashboard sends industry and goal as the Arabic option values; official
// marketplace APIs need English search terms.
const INDUSTRY_TERMS = {
    "جميع المجالات": "saas",
    "أدوات الذكاء الاصطناعي للشركات": "ai saas",
    "أنظمة إدارة الموارد البشرية HR": "hr management",
    "التجارة الإلكترونية والمدفوعات": "ecommerce",
    "التسويق والمبيعات": "crm",
    "الصحة والرعاية الصحية": "clinic management",
    "التعليم والتدريب": "lms",
    "المالية والمحاسبة": "accounting invoicing",
    "العقارات وإدارة الممتلكات": "property management",
    "الأمن السيبراني والخصوصية": "security",
    "الإنتاجية وإدارة المشاريع": "project management",
    "الخدمات القانونية": "legal case management",
    "سلاسل الإمداد والخدمات اللوجستية": "inventory management"
};

const FILTER_TERMS = {
    multi_tenant: "multi-tenant",
    white_label: "white label",
    ai_features: "ai",
    api_integrations: "api"
};

// Budget caps in USD; "مفتوح" (open) and unknown values mean no cap.
const BUDGET_CAPS = { "حتى 100 دولار": 100, "حتى 500 دولار": 500, "حتى 5000 دولار": 5000 };

// Catalogue APIs match every word, so they get the industry term only; the
// capability filters are judged later by the analysis step.
function searchTerms({ industry }) {
    return INDUSTRY_TERMS[industry] || "saas";
}

function filterTerms(filters = []) {
    return filters.map((filter) => FILTER_TERMS[filter]).filter(Boolean);
}

function budgetCap(budget) {
    return BUDGET_CAPS[budget] || null;
}

// Acquisition goals point at businesses for sale rather than source code.
function wantsBusinesses(goal) {
    return goal === "شراء وتطوير مشروع قائم";
}

module.exports = { searchTerms, filterTerms, budgetCap, wantsBusinesses, INDUSTRY_TERMS };
