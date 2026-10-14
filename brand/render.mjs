// Exports PNGs of the brand SVGs with a headless browser.
// Usage: browser-automation runner with --script brand/render.mjs (BRAND_DIR env).
export default async function run(page) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = process.env.BRAND_DIR;
    const out = path.join(dir, "png");
    fs.mkdirSync(out, { recursive: true });
    const dataUri = (file) => `data:image/svg+xml;base64,${fs.readFileSync(path.join(dir, file)).toString("base64")}`;
    const shot = async (file, width, height, name) => {
        await page.setViewportSize({ width, height });
        await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${dataUri(file)}" width="${width}" height="${height}" style="display:block"></body></html>`);
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(out, name), omitBackground: true, clip: { x: 0, y: 0, width, height } });
        return name;
    };
    const made = [];
    made.push(await shot("qlook-logo-mark.svg", 1024, 1024, "qlook-logo-mark-1024.png"));
    made.push(await shot("qlook-symbol.svg", 1024, 1024, "qlook-symbol-1024.png"));
    made.push(await shot("qlook-app-icon.svg", 1024, 1024, "qlook-app-icon-1024.png"));
    made.push(await shot("qlook-app-icon.svg", 512, 512, "qlook-app-icon-512.png"));
    made.push(await shot("qlook-app-icon.svg", 180, 180, "apple-touch-icon-180.png"));
    made.push(await shot("qlook-favicon.svg", 32, 32, "favicon-32.png"));
    made.push(await shot("qlook-favicon.svg", 16, 16, "favicon-16.png"));
    made.push(await shot("qlook-hero.svg", 1920, 1080, "qlook-hero-1920x1080.png"));
    made.push(await shot("qlook-dashboard-bg.svg", 1920, 1080, "qlook-dashboard-bg-1920x1080.png"));
    made.push(await shot("qlook-marketing.svg", 1920, 1080, "qlook-marketing-1920x1080.png"));

    // Review sheet: the symbol at real small sizes next to the full mark.
    await page.setViewportSize({ width: 900, height: 300 });
    await page.setContent(`<html><body style="margin:0;background:#0A0F0D;display:flex;gap:40px;align-items:center;padding:30px;font-family:sans-serif;color:#E7F0EC">
      ${[16, 32, 64].map((s) => `<div style="text-align:center"><img src="${dataUri("qlook-favicon.svg")}" width="${s}" height="${s}"><div style="font-size:12px;margin-top:8px">favicon ${s}px</div></div>`).join("")}
      ${[32, 64, 128].map((s) => `<div style="text-align:center"><img src="${dataUri("qlook-app-icon.svg")}" width="${s}" height="${s}"><div style="font-size:12px;margin-top:8px">app icon ${s}px</div></div>`).join("")}
      <div style="text-align:center"><img src="${dataUri("qlook-logo-mark.svg")}" width="200" height="200"><div style="font-size:12px;margin-top:8px">mark 200px</div></div>
    </body></html>`);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(out, "review-small-sizes.png") });
    made.push("review-small-sizes.png");
    return made;
}
