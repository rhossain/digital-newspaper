# Performance Fixes — Detailed To-Do List

Scope: native fixes only (no third-party plugin, no extra Node service, no CDN).
Guiding rule for every task: **additive and reversible**. New code paths must
fall back to today's behaviour when their preconditions aren't met, so no
existing feature, UI state, or data is ever lost.

Legend: 🔴 critical · 🟠 high · 🟢 optional · ⏱ rough effort

---

## Global guardrails (apply to ALL tasks)

- [ ] Branch off `feat/import-export-improvize` into `perf/native-image-pipeline`; one task per commit.
- [ ] No change may alter the shape of `dn_data` in a way that drops existing keys. New fields are **added** alongside old ones; old fields stay populated.
- [ ] Take a full export (`/data/export-full`) + a WordPress DB backup of the `dn_data` option **before** any task that writes data (Tasks 1, 5).
- [ ] Every new server-rendered image path must degrade to the current full-image-on-canvas / single `[src]` path if the new asset is missing.
- [ ] Keep the existing 4-layer cache, granular endpoints, light-first payload, locking, activity log, and conflict-guard untouched.
- [ ] Verify after each task: public viewer loads, date navigation, edition switch, page switch, section click, linked sections, modal zoom, print, download, share, admin save round-trip.

---

## 🔴 Task 1 — Server-side pre-cropped section images
**Problem:** every section click + every linked section re-downloads the full page via `/proxy` and crops it on a `<canvas>` (`cropSectionImage` / `cropLinkedSectionImage`, newspaper.component.ts ~1526–1660). Heavy bandwidth, main-thread decode jank, large base64 data URLs in memory.

**Approach:** generate the crop once on the server using the GD/Imagick path already used for `/social-thumb`, store its URL on the section, and let the viewer use a plain `<img src>`.

- [ ] **PHP — add a crop generator** in `digital-newspaper.php` near the existing `imagecreatetruecolor`/`WP_Image_Editor` code (~3447–3631).
  - [ ] Input: page `fullImage` URL + section `x,y,width,height` (percentages already stored).
  - [ ] Output: a `.webp` file written under `wp-content/uploads/dn-crops/{date}/{edition}/{pageId}-{sectionId}.webp`.
  - [ ] Make it **idempotent**: skip if the file exists and is newer than the source; safe to re-run.
  - [ ] Wrap GD/Imagick calls in capability checks (mirror existing `extension_loaded('gd')` guards) and return `null` on failure — never fatal.
- [ ] **PHP — populate a new section field** `croppedImageUrl` during save/import (`save_data()` / import path) **without removing** `imageUrl`, `x`, `y`, `width`, `height`. Existing crop-on-client stays usable if `croppedImageUrl` is absent.
- [ ] **PHP — backfill endpoint** (admin-only, like `/warm-cache`): generate crops for all existing sections of a date on demand, so old editions get crops without a re-import.
- [ ] **Angular — prefer the precomputed URL.** In `getCroppedImageForSection()` (newspaper.component.ts ~1517) return `section.croppedImageUrl` when present; otherwise fall through to the **existing** `cropCache` canvas logic unchanged.
- [ ] **Angular — interim fallback optimisation (only if crop URL missing):** reuse the already-decoded main page `<img>` bitmap instead of `new Image()` re-fetch. Leave the proxy path as the last resort.

**No-regression / no-data-loss guards**
- `imageUrl` and the percentage coords are **kept**, so re-cropping at any resolution remains possible and the client canvas path still works for un-backfilled data.
- New files live in their own `dn-crops/` folder; no existing upload is overwritten.
- If GD/Imagick is unavailable on the host, behaviour is byte-for-byte today's behaviour.

**Verify:** click sections + linked sections on a backfilled date (network tab shows one small webp, not a full-page fetch); click sections on a NON-backfilled date (old canvas path still renders identical crop); modal zoom + print + download of section still work.
⏱ 1–2 days (PHP crop + backfill is the bulk).

---

## 🔴 Task 2 — Responsive next-gen main page image (`<picture>` + AVIF/WebP + intrinsic size)

> **STATUS (implemented):** Scoped to **CLS fix only — no server image generation**
> (decision: `fullImage` is already a 700px WebP per WEBP_IMPLEMENTATION_PLAN.md, so
> extra WebP variants add little and AVIF needs uncertain host Imagick-AVIF support).
> Delivered: (1) Angular `<picture>` wrapper + precomputed sources + intrinsic
> `width`/`height`, falling back to the original `<img [src]="fullImage">` when no
> variants exist — **`ng build` clean**. (2) PHP `dn_attach_page_dimensions()` injects
> `imageVariants.{width,height}` via cached `getimagesize()` at `/data/editions/:date`;
> writes **only transients**, no stored data touched — **needs live-WP verification**.
> AVIF + multi-width srcset deferred; the Angular side already consumes
> `imageVariants.avif`/`.webp` if a later step supplies them.

**Problem:** main `<img>` (newspaper.component.html ~631) is a single `[src]`, one format, no `srcset/sizes`, no `width`/`height` → oversized downloads on mobile + layout shift.

- [ ] **PHP — at import/save, emit per page:** `page-NN.avif` and `page-NN.webp` at 2–3 widths (e.g. 800 / 1400 / 2200). Imagick handles AVIF; fall back to WebP-only if AVIF unsupported on host.
  - [ ] Store the variant URLs + the source's intrinsic `width`/`height` in a **new** `imageVariants` field on the page object. Keep `fullImage` as-is (used for download/print/zoom + fallback).
- [ ] **Angular — render `<picture>`** in the center panel, sources ordered AVIF → WebP, `<img>` fallback = current `resolveImageUrl(fullImage)`.
  - [ ] Add `width`/`height` from `imageVariants` to remove CLS (keep the skeleton; it just stops causing reflow).
  - [ ] Keep `fetchpriority="high"`, `decoding="async"`, the `(load)`/`(error)` handlers, `[style.opacity]`, and the `#mainImage` ViewChild **unchanged** — the section overlay alignment depends on the rendered `<img>` box, so the displayed pixel box must stay identical.
- [ ] **Print/Download/Zoom must still use the full-resolution `fullImage`,** not a downsized variant. Audit `printImage()`, `downloadImage()`, `openImageModal()` to confirm they read `fullImage`.

**No-regression / no-data-loss guards**
- `fullImage` stays the source of truth; variants are additive. Missing `imageVariants` → `<img src=fullImage>` exactly as today.
- Section overlay maps onto the `<img>` element's rendered box, which is unchanged (still aspect-correct), so click hot-zones stay aligned.

**Verify:** main image renders on browsers with/without AVIF; overlay click targets still land correctly; zoom/print/download deliver full-res; Lighthouse CLS ≈ 0; mobile payload visibly smaller in network tab.
⏱ 1 day.

---

## 🟠 Task 3 — IntersectionObserver-driven thumbnail loading
**Problem:** all 12–16 thumbnails load eagerly (lazy was correctly removed because native lazy-load measures the window, not the scroll panel) and compete with the main image for the 6-connection pool.

- [ ] **Angular — observe the scroll panel.** Add an `IntersectionObserver` with `root` = the `.left-panel` / `.thumbnail-list` scroll container; set each thumbnail's real `src` only when it intersects.
  - [ ] Preserve the existing `thumbnailsLoading` / `pageThumbnailSrcs` / `_thumbnailSrcCache` machinery and the cross-date "no skeleton on revisit" behaviour — only the *trigger* for assigning `src` changes.
  - [ ] Keep the active/current thumbnail and the first 1–2 thumbnails eager so the panel never looks empty.
  - [ ] SSR guard: `IntersectionObserver` is browser-only — wrap in `isBrowser`, and on the server/no-IO fallback, assign all `src` immediately (today's behaviour).
- [ ] Let the main image win: don't assign off-screen thumbnail `src` until after the main image `(load)` fires (or via low `fetchpriority`).

**No-regression / no-data-loss guards**
- Pure client-side; no data touched.
- Fallback path = current eager assignment, so worst case equals today.

**Verify:** thumbnails fill in as you scroll the panel; no permanent skeletons; main image first-paint time improves; revisiting a date shows no skeleton flash (cache behaviour intact).
⏱ ~half day.

---

## 🟠 Task 4 — Display vs. zoom resolution split
**Problem:** one full-res image serves both normal reading and zoom.

- [ ] Use the mid-width variant from Task 2 for normal viewing; fetch `fullImage` only on explicit zoom/download.
- [ ] Gate on Task 2 being merged (reuses `imageVariants`); if variants absent, use `fullImage` for both (today's behaviour).

**No-regression guards:** zoom modal and download keep full-res; only the at-rest center image gets the lighter variant.
**Verify:** zoom still crisp; download still full-res; normal-view payload reduced.
⏱ ~half day (mostly folded into Task 2).

---

## 🟢 Task 5 — Watch the single-JSON-blob model (monitor, no rewrite now)
**Problem:** `dn_data` is one `wp_option`; writes replace the whole blob. Reads are already well-shielded by granular endpoints + light-first + 4-layer cache, so this is a write/scaling watch item, not a reader fix.

- [ ] Add a lightweight size log (blob byte size) to the existing activity log on save, to track growth.
- [ ] Document a future option: move older editions to per-edition options/CPT meta. **Do not** implement now — high data-loss risk, separate project with its own migration + backup plan.

**No-data-loss guard:** this task only *reads* and logs a size; it changes no write path.
⏱ ~1 hour (logging only).

---

## 🟢 Task 6 — Evaluate zoneless change detection
**Problem:** `zone.js` polyfill + CD overhead still shipped (components are already `OnPush`).

- [ ] Spike `provideZonelessChangeDetection()` on a throwaway branch.
- [ ] Audit any code relying on Zone's auto-CD (timers, non-Angular event callbacks, `setTimeout`-driven UI like the share dropdown close, slow-connection warning, thumbnail `(load)`); add explicit `markForCheck()` where needed.
- [ ] Ship only if the full verify checklist passes; this is all-or-nothing per app.

**No-regression guard:** isolated branch; do not merge unless every interactive flow is re-tested.
⏱ 1 day to evaluate.

---

## 🔴 Task 7 — Static-asset compression (Brotli/Gzip) without cPanel access

> **STATUS (implemented).** The LiteSpeed host serves static JS/CSS/JSON
> uncompressed and server-level tuning isn't reachable on shared cPanel, so we
> pre-compress the bytes ourselves and serve them via `.htaccess` negotiation.

**Problem:** `main.js` (~164 KB) and `editions/<date>.json` (~360 KB) ship
uncompressed (no `Content-Encoding`); `.htaccess` `mod_deflate` filters don't
compress static files on LSWS.

Workflow: deployment is a **manual upload of `dist/digital-newspaper/browser`**
to cPanel (not `npm run deploy`), so compression happens at **build time** and
the serve-rules live in `src/.htaccess` (copied into the bundle by the build).

What was done:
- **JSON snapshots — already in the plugin** (`atomic_write()` writes
  `.json.gz` always + `.json.br` when the brotli PHP extension exists;
  `static_snapshot_htaccess()` serves them). No change needed.
- **Build-time compressor — `scripts/compress-dist.js`** (Node **built-in**
  `zlib`, Brotli q11 + Gzip l9). Writes `<file>.br`/`.gz` for
  `.js/.mjs/.css/.json/.svg/.webmanifest`, skips < 1 KB and any sibling not
  smaller. Wired into `package.json`: `build` and `build:staging` now run it
  after `ng build`; `build:nocompress` and `compress` added as escape hatches.
  **Verified:** runs clean on a real `dist` copy — 10 assets, ~1.2 MB saved;
  `main.js` 169 KB → 32 KB (81%); Brotli round-trips to original bytes
  (incl. `ngsw.json`); `node --check` passes.
- **Serve rules — added to `src/.htaccess`** (so they ship inside
  `dist/browser`): rewrite to `.br`/`.gz` on `Accept-Encoding` when the sibling
  exists (`-f` guard = guaranteed fallback), per-type
  `Content-Encoding`/`Content-Type`/`Vary` headers, and
  `SetEnvIfNoCase … no-gzip` to prevent double-compression. The existing
  service-worker no-cache `FilesMatch` was widened to also match `.br`/`.gz`
  so the SW update cycle still works when `ngsw.json`/`ngsw-worker.js` are
  compressed.
- **`deploy.js` path also covered** (for completeness): same compression +
  serve-rules added there too, so `npm run deploy` stays consistent.

**How you deploy now:** run `npm run build` (instead of `ng build`), then upload
`dist/digital-newspaper/browser` as usual — the `.br`/`.gz` files and the
updated `.htaccess` are already inside it. If you ever build with bare
`ng build`, run `npm run compress` before uploading.

**No-regression / no-data-loss guards**
- Purely additive: original uncompressed files remain; missing/failed sibling
  → `-f` fails → plain asset served exactly as today.
- Uses built-in zlib only — no new dependency, no runtime service, no CDN.
- Needs `mod_rewrite` + `mod_headers` in `.htaccess` (normal on cPanel/LiteSpeed).

**Verify (live):** `curl -s -I -H "Accept-Encoding: br,gzip" https://…/main-*.js | grep -i content-encoding` → `br`; confirm the SPA, social-crawler, SW no-cache, and WP/WAF rules in the same `.htaccess` still behave.

## Suggested sequence
1. Task 2 (`<picture>` + variants) — biggest reader win, self-contained.
2. Task 1 (server-side crops) — highest per-interaction cost; reuses Task 2's PHP image work.
3. Task 3 (IO thumbnails) — quick, client-only.
4. Task 4 (display/zoom split) — folds into Task 2.
5. Task 5 / 6 — monitoring + optional, anytime.

## Definition of done (whole effort)
- [ ] Full verify checklist green on desktop + mobile.
- [ ] Export-full diff shows only **added** fields (`croppedImageUrl`, `imageVariants`); nothing removed.
- [ ] Un-backfilled (legacy) dates render identically to today via fallbacks.
- [ ] Lighthouse: LCP + CLS improved, no new console errors; SSR build still renders.
- [ ] Rollback = revert the commit; no data migration to undo (all fields additive).
