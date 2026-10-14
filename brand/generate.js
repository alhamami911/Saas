"use strict";

// Generates the QLook brand assets as SVG: a radar scope with one emerald sweep
// and one amber target. Run: node brand/generate.js
// Palette: deep emerald #0E5E4A (structure), bright emerald #10B981 (sweep and
// glow), amber #F59E0B (the single opportunity), near-black green #0A0F0D
// (backgrounds), off-white #E7F0EC (highlights). No text in any artwork.

const fs = require("node:fs");
const path = require("node:path");

const C = { deep: "#0E5E4A", bright: "#10B981", amber: "#F59E0B", night: "#0A0F0D", light: "#E7F0EC" };
const OUT = __dirname;
const r2 = (n) => Math.round(n * 100) / 100;
const polar = (cx, cy, r, deg) => [r2(cx + r * Math.cos((deg * Math.PI) / 180)), r2(cy + r * Math.sin((deg * Math.PI) / 180))];

// A pie wedge from angle a to angle b (degrees, clockwise, 0 = east).
function wedge(cx, cy, r, a, b) {
    const [x1, y1] = polar(cx, cy, r, a);
    const [x2, y2] = polar(cx, cy, r, b);
    return `M${cx} ${cy}L${x1} ${y1}A${r} ${r} 0 ${b - a > 180 ? 1 : 0} 1 ${x2} ${y2}Z`;
}

const glowFilter = (id, blur, color, strength = 1) => `
    <filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="b"/>
      <feFlood flood-color="${color}" flood-opacity="${strength}"/>
      <feComposite in2="b" operator="in" result="g"/>
      <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`;

// The core symbol. `detail` 1 = full scope, 0 = favicon simplification.
// The sweep's leading edge points up-right; the amber target sits just behind it.
function radar({ cx, cy, R, detail = 1, id = "q", lead = -50, span = 64, target = { angle: -72, radius: 0.62 } }) {
    const ring = Math.max(2, R * (detail ? 0.045 : 0.15));
    const thin = Math.max(1.2, R * 0.022);
    const slices = detail ? 8 : 3;
    const parts = [];
    // Sweep: stacked wedges get brighter toward the leading edge (a crisp conic fade).
    for (let i = 0; i < slices; i += 1) {
        const a = lead - span + (span / slices) * i;
        const opacity = r2((0.05 + 0.4 * ((i + 1) / slices) ** 1.6) * (detail ? 1 : 1.5));
        parts.push(`<path d="${wedge(cx, cy, R - ring / 2, a, lead)}" fill="${C.bright}" opacity="${Math.min(0.9, opacity / (detail ? 1.6 : 0.8))}"/>`);
    }
    if (detail) {
        // Structure: inner rings and crosshair in deep emerald.
        for (const f of [0.34, 0.67]) parts.push(`<circle cx="${cx}" cy="${cy}" r="${r2(R * f)}" fill="none" stroke="${C.deep}" stroke-width="${r2(thin)}"/>`);
        parts.push(`<path d="M${r2(cx - R)} ${cy}H${r2(cx + R)}M${cx} ${r2(cy - R)}V${r2(cy + R)}" stroke="${C.deep}" stroke-width="${r2(thin)}"/>`);
        // Tick marks on the outer ring every 30 degrees.
        for (let a = 0; a < 360; a += 30) {
            const [x1, y1] = polar(cx, cy, R * 0.9, a);
            const [x2, y2] = polar(cx, cy, R * 0.97, a);
            parts.push(`<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${C.deep}" stroke-width="${r2(thin)}" stroke-linecap="round"/>`);
        }
    }
    // Outer ring and the bright leading edge.
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r2(R)}" fill="none" stroke="${C.bright}" stroke-width="${r2(ring)}" opacity="${detail ? 0.9 : 1}"/>`);
    const [ex, ey] = polar(cx, cy, R - ring / 2, lead);
    parts.push(`<path d="M${cx} ${cy}L${ex} ${ey}" stroke="${C.bright}" stroke-width="${r2(ring * (detail ? 0.75 : 1))}" stroke-linecap="round" filter="url(#${id}-glow)"/>`);
    // The one opportunity: amber target with a ripple ring.
    const [tx, ty] = polar(cx, cy, R * target.radius, target.angle);
    const dot = R * (detail ? 0.075 : 0.22);
    if (detail) parts.push(`<circle cx="${tx}" cy="${ty}" r="${r2(dot * 2.3)}" fill="none" stroke="${C.amber}" stroke-width="${r2(thin * 1.1)}" opacity="0.45"/>`);
    parts.push(`<circle cx="${tx}" cy="${ty}" r="${r2(dot)}" fill="${C.amber}" filter="url(#${id}-amber)"/>`);
    // Centre point.
    if (detail) parts.push(`<circle cx="${cx}" cy="${cy}" r="${r2(R * 0.035)}" fill="${C.light}"/>`);
    const defs = `<defs>${glowFilter(`${id}-glow`, R * 0.03, C.bright, 0.9)}${glowFilter(`${id}-amber`, R * (detail ? 0.05 : 0.04), C.amber, 1)}</defs>`;
    return { defs, body: parts.join("\n    ") };
}

const svg = (w, h, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n${inner}\n</svg>\n`;
const write = (name, content) => fs.writeFileSync(path.join(OUT, name), content);

// 1. Logo mark on a dark square.
{
    const mark = radar({ cx: 512, cy: 512, R: 330, id: "m" });
    write("qlook-logo-mark.svg", svg(1024, 1024, `  ${mark.defs}
  <rect width="1024" height="1024" fill="${C.night}"/>
  <radialGradient id="m-halo" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${C.bright}" stop-opacity="0.10"/><stop offset="1" stop-color="${C.bright}" stop-opacity="0"/></radialGradient>
  <circle cx="512" cy="512" r="470" fill="url(#m-halo)"/>
  <g>
    ${mark.body}
  </g>`));
    // Transparent version for use on any dark surface.
    write("qlook-symbol.svg", svg(1024, 1024, `  ${mark.defs}\n  <g>\n    ${mark.body}\n  </g>`));
}

// 2. App icon: rounded square, matte dark green, symbol centred.
{
    const mark = radar({ cx: 512, cy: 512, R: 300, id: "a" });
    write("qlook-app-icon.svg", svg(1024, 1024, `  ${mark.defs}
  <linearGradient id="a-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0F1814"/><stop offset="1" stop-color="${C.night}"/></linearGradient>
  <rect width="1024" height="1024" rx="228" fill="url(#a-bg)"/>
  <rect x="6" y="6" width="1012" height="1012" rx="222" fill="none" stroke="${C.deep}" stroke-opacity="0.55" stroke-width="4"/>
  <g>
    ${mark.body}
  </g>`));
}

// Favicon: the simplified silhouette that stays readable at 16-32 px.
{
    const mark = radar({ cx: 32, cy: 32, R: 26, detail: 0, id: "f", target: { angle: -72, radius: 0.55 } });
    write("qlook-favicon.svg", svg(64, 64, `  ${mark.defs}
  <rect width="64" height="64" rx="14" fill="${C.night}"/>
  <g>
    ${mark.body}
  </g>`));
}

// 3. Hero 16:9: large radar on the left, opportunities around it, right side
// left empty for an Arabic headline.
{
    const cx = 600;
    const cy = 560;
    const R = 400;
    const mark = radar({ cx, cy, R, id: "h", target: { angle: -72, radius: 0.6 } });
    const blips = [[1010, 300, 7], [935, 820, 6], [250, 260, 5], [180, 760, 6], [1060, 560, 5], [430, 980, 4], [840, 160, 4]];
    const [tx, ty] = polar(cx, cy, R * 0.6, -72);
    const links = blips.slice(0, 5).map(([x, y]) => `<path d="M${tx} ${ty}L${x} ${y}" stroke="${C.bright}" stroke-opacity="0.16" stroke-width="1.5" stroke-dasharray="2 8"/>`).join("\n  ");
    const dots = blips.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r * 2.6}" fill="none" stroke="${C.amber}" stroke-opacity="0.22" stroke-width="1.5"/><circle cx="${x}" cy="${y}" r="${r}" fill="${C.amber}" opacity="0.85" filter="url(#h-amber)"/>`).join("\n  ");
    write("qlook-hero.svg", svg(1920, 1080, `  ${mark.defs}
  <radialGradient id="h-halo" cx="${cx / 1920}" cy="${cy / 1080}" r="0.55" gradientUnits="objectBoundingBox"><stop offset="0" stop-color="${C.bright}" stop-opacity="0.16"/><stop offset="0.45" stop-color="${C.deep}" stop-opacity="0.07"/><stop offset="1" stop-color="${C.night}" stop-opacity="0"/></radialGradient>
  <rect width="1920" height="1080" fill="${C.night}"/>
  <rect width="1920" height="1080" fill="url(#h-halo)"/>
  <circle cx="${cx}" cy="${cy}" r="${R * 1.35}" fill="none" stroke="${C.deep}" stroke-opacity="0.35" stroke-width="1.2"/>
  <circle cx="${cx}" cy="${cy}" r="${R * 1.75}" fill="none" stroke="${C.deep}" stroke-opacity="0.18" stroke-width="1"/>
  ${links}
  <g>
    ${mark.body}
  </g>
  ${dots}`));
}

// 4. Dashboard background: almost plain, faint grid and rings.
{
    const lines = [];
    for (let x = 0; x <= 1920; x += 48) lines.push(`M${x} 0V1080`);
    for (let y = 0; y <= 1080; y += 48) lines.push(`M0 ${y}H1920`);
    const rings = [180, 360, 540, 720, 900].map((r) => `<circle cx="1500" cy="860" r="${r}" fill="none" stroke="${C.bright}" stroke-opacity="0.06" stroke-width="1.2"/>`).join("\n  ");
    write("qlook-dashboard-bg.svg", svg(1920, 1080, `  <radialGradient id="d-v" cx="0.78" cy="0.8" r="0.9"><stop offset="0" stop-color="#0E1713"/><stop offset="1" stop-color="${C.night}"/></radialGradient>
  <rect width="1920" height="1080" fill="url(#d-v)"/>
  <path d="${lines.join("")}" stroke="${C.bright}" stroke-opacity="0.028" stroke-width="1"/>
  ${rings}
  <path d="M1500 0V1080M0 860H1920" stroke="${C.bright}" stroke-opacity="0.04" stroke-width="1"/>`));
}

// 5. Marketing scene (vector interpretation): a radar dish scanning a dark
// horizon of floating dashboard cards; one card glows amber.
{
    const horizon = 640;
    const floor = [];
    for (let i = -16; i <= 16; i += 1) floor.push(`M960 ${horizon}L${960 + i * 260} 1080`);
    for (const y of [668, 706, 760, 838, 950]) floor.push(`M0 ${y}H1920`);
    // A dashboard card: frame, a few bars and a line chart.
    const card = (x, y, w, s, opts = {}) => {
        const h = w * 0.62;
        const stroke = opts.amber ? C.amber : C.bright;
        const bars = [0.35, 0.6, 0.45, 0.8, 0.55].map((v, i) => `<rect x="${r2(x + w * 0.1 + i * w * 0.09)}" y="${r2(y + h * (0.9 - v * 0.55))}" width="${r2(w * 0.05)}" height="${r2(h * v * 0.55)}" rx="${r2(w * 0.01)}" fill="${stroke}" opacity="${opts.amber ? 0.9 : 0.55}"/>`).join("");
        const pts = [0.7, 0.5, 0.58, 0.32, 0.4, 0.2].map((v, i) => `${r2(x + w * 0.56 + i * w * 0.075)},${r2(y + h * v)}`).join(" ");
        return `<g opacity="${s}"${opts.blur ? ` filter="url(#k-blur${opts.blur})"` : ""}${opts.amber ? ' filter="url(#k-amber)"' : ""}>
    <rect x="${x}" y="${y}" width="${w}" height="${r2(h)}" rx="${r2(w * 0.06)}" fill="#0D1813" stroke="${stroke}" stroke-opacity="${opts.amber ? 1 : 0.5}" stroke-width="${opts.amber ? 3 : 1.5}"/>
    <rect x="${r2(x + w * 0.1)}" y="${r2(y + h * 0.14)}" width="${r2(w * 0.3)}" height="${r2(h * 0.06)}" rx="${r2(h * 0.03)}" fill="${C.light}" opacity="0.35"/>
    ${bars}
    <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="${r2(Math.max(1.5, w * 0.012))}" stroke-linejoin="round" opacity="0.9"/>
  </g>`;
    };
    const cards = [
        card(1560, 330, 180, 0.35, { blur: 2 }), card(1320, 250, 150, 0.3, { blur: 2 }), card(1700, 470, 140, 0.3, { blur: 2 }),
        card(1180, 420, 210, 0.55, { blur: 1 }), card(1480, 520, 230, 0.6, { blur: 1 }),
        card(980, 300, 260, 0.9, { amber: true }),
        card(860, 600, 300, 0.75), card(1240, 700, 340, 0.7)
    ].join("\n  ");
    // Dish: a parabolic bowl on a pedestal, aimed at the amber card.
    const dish = `<g transform="translate(360 600) rotate(50)">
    <path d="M-150 0 Q0 150 150 0 Z" fill="#0F1C17" stroke="${C.bright}" stroke-opacity="0.55" stroke-width="3"/>
    <path d="M-150 0 Q0 150 150 0" fill="none" stroke="${C.deep}" stroke-width="10" opacity="0.8"/>
    <path d="M-100 8 Q0 90 100 8M-50 12 Q0 52 50 12" fill="none" stroke="${C.deep}" stroke-width="3"/>
    <path d="M0 0V-110" stroke="${C.light}" stroke-opacity="0.7" stroke-width="5" stroke-linecap="round"/>
    <circle cx="0" cy="-118" r="12" fill="${C.bright}" filter="url(#k-glow)"/>
  </g>
  <path d="M287 662 L257 860 H377 L347 662 Z" fill="#0F1C17" stroke="${C.deep}" stroke-width="3"/>
  <rect x="207" y="852" width="220" height="22" rx="8" fill="#0F1C17" stroke="${C.deep}" stroke-width="3"/>`;
    write("qlook-marketing.svg", svg(1920, 1080, `  <defs>
    ${glowFilter("k-glow", 10, C.bright, 1)}
    ${glowFilter("k-amber", 12, C.amber, 0.9)}
    <filter id="k-blur1"><feGaussianBlur stdDeviation="1.6"/></filter>
    <filter id="k-blur2"><feGaussianBlur stdDeviation="3.6"/></filter>
    <filter id="k-beam" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="26"/></filter>
    <linearGradient id="k-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.night}"/><stop offset="0.59" stop-color="#0E1A15"/><stop offset="0.6" stop-color="#0B1410"/><stop offset="1" stop-color="${C.night}"/></linearGradient>
    <linearGradient id="k-cone" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.bright}" stop-opacity="0.55"/><stop offset="1" stop-color="${C.bright}" stop-opacity="0"/></linearGradient>
    <radialGradient id="k-horizon" cx="0.55" cy="0.6" r="0.5"><stop offset="0" stop-color="${C.bright}" stop-opacity="0.12"/><stop offset="1" stop-color="${C.bright}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#k-sky)"/>
  <rect width="1920" height="1080" fill="url(#k-horizon)"/>
  <path d="${floor.join("")}" stroke="${C.bright}" stroke-opacity="0.07" stroke-width="1.2"/>
  <path d="M0 ${horizon}H1920" stroke="${C.bright}" stroke-opacity="0.22" stroke-width="1.5"/>
  <path d="M450 524 L1700 150 L1800 780 Z" fill="url(#k-cone)" opacity="0.45" filter="url(#k-beam)"/>
  <path d="M450 524 L1060 300 L1240 470 Z" fill="url(#k-cone)" opacity="0.6" filter="url(#k-beam)"/>
  ${cards}
  ${dish}`));
}

console.log("Brand assets written to", OUT);
