# QLook brand

A radar that spots one opportunity before anyone else: an emerald scope with a
single sweep and exactly one amber target. Flat vector, crisp edges, matte dark
backgrounds, soft glow. No purple, no blue gradients, no glassmorphism, no 3D
bevels, no letters in the artwork.

## Palette

| Role | Hex |
|---|---|
| Structure (rings, crosshair) | `#0E5E4A` deep emerald |
| Sweep and glow | `#10B981` bright emerald |
| The opportunity (one accent only) | `#F59E0B` amber |
| Backgrounds | `#0A0F0D` near-black green |
| Highlights (centre point, labels) | `#E7F0EC` off-white |

## Files

| Asset | Vector | Raster (`png/`) |
|---|---|---|
| Logo mark, dark square 1:1 | `qlook-logo-mark.svg` | `qlook-logo-mark-1024.png` |
| Symbol, transparent | `qlook-symbol.svg` | `qlook-symbol-1024.png` |
| App icon, rounded square | `qlook-app-icon.svg` | `qlook-app-icon-1024.png`, `-512.png`, `apple-touch-icon-180.png` |
| Favicon (simplified for 16–32 px) | `qlook-favicon.svg` | `favicon-32.png`, `favicon-16.png` |
| Hero 16:9, empty right side for an Arabic headline | `qlook-hero.svg` | `qlook-hero-1920x1080.png` |
| Dashboard background 16:9 | `qlook-dashboard-bg.svg` | `qlook-dashboard-bg-1920x1080.png` |
| Marketing scene 16:9 (vector interpretation) | `qlook-marketing.svg` | `qlook-marketing-1920x1080.png` |

`png/review-small-sizes.png` shows the favicon and app icon at real small sizes.

## Usage

- Below 48 px use the favicon variant: it drops the thin rings and ticks and
  keeps the ring, the sweep and the amber target.
- Keep amber for the single opportunity. Everything else stays emerald and dark.
- Keep clear space around the mark of at least a quarter of its width.
- The marketing scene is a flat-vector stand-in; a photorealistic render
  (volumetric light, depth of field) needs an image-generation tool, briefed
  with the same palette and the rule of one amber target.

## Regenerating

```
node brand/generate.js          # writes the SVGs
# PNGs: run brand/render.mjs with the browser-automation runner (BRAND_DIR=brand)
```
