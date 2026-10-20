// Renders the 1200x630 link-preview card (og:image) shown when a QLook link
// is shared on WhatsApp, X, LinkedIn or Slack.
// Usage: browser-automation runner with --script brand/render-og.mjs (BRAND_DIR, OUT_FILE env).
export default async function run(page) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = process.env.BRAND_DIR;
    const symbol = `data:image/svg+xml;base64,${fs.readFileSync(path.join(dir, "qlook-logo-mark.svg")).toString("base64")}`;
    await page.setViewportSize({ width: 1200, height: 630 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; width: 1200px; height: 630px; background: #0A0F0D; color: #E7F0EC;
             font-family: "Segoe UI", Tahoma, "Noto Sans Arabic", sans-serif; display: flex; align-items: center; }
      .wrap { display: flex; align-items: center; gap: 56px; padding: 0 90px; width: 100%; box-sizing: border-box; }
      img { width: 300px; height: 300px; flex: none; }
      h1 { font-size: 96px; margin: 0 0 18px; letter-spacing: -2px; color: #FFFFFF; }
      .ar { font-size: 44px; line-height: 1.35; color: #10B981; direction: rtl; margin: 0 0 14px; }
      .en { font-size: 30px; line-height: 1.4; color: #A7C4B8; margin: 0; }
      .rule { width: 72px; height: 6px; background: #F59E0B; border-radius: 3px; margin: 0 0 26px; }
    </style></head><body><div class="wrap">
      <img src="${symbol}">
      <div>
        <h1>QLook</h1>
        <div class="rule"></div>
        <p class="ar">فرص SaaS حقيقية من أسواق برمجيات موثوقة</p>
        <p class="en">Real SaaS opportunities, with licence, price and source</p>
      </div>
    </div></body></html>`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: process.env.OUT_FILE, clip: { x: 0, y: 0, width: 1200, height: 630 } });
    return process.env.OUT_FILE;
}
