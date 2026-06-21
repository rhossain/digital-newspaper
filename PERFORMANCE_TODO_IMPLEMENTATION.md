# Performance Optimization — Implementation To-Do (Ordered)

**Companion to:** `PERFORMANCE_OPTIMIZATION_STRATEGY.md`
**Date:** 2026-06-21
**Rule:** Each task is independently shippable and reversible. Do them top-to-bottom. Don't start a phase until the previous one is measured and merged.

---

## Phase 0 — Measurement Baseline (do this first, ~0.5 day)

- [ ] **T0.1** Add native `PerformanceObserver` RUM in Angular (entry types: `navigation`, `paint`, `largest-contentful-paint`, `event`/INP, `layout-shift`). No external library.
- [ ] **T0.2** Beacon those metrics to the existing `/activity-log/batch` endpoint (reuse `activity-log.service.ts`).
- [ ] **T0.3** Capture cold-first-visit Lighthouse run (throttled "Fast 4G") → record TTFB / FCP / LCP / INP / CLS / TTI.
- [ ] **T0.4** Extend `load-test.js` to hammer `/data/editions/<today>`; record p50/p95 latency + error rate at rising concurrency (the "before" number).
- [ ] **T0.5** Commit baseline numbers to a `PERF_BASELINE.md` so every later phase is measured against it.

**Gate:** baseline recorded before any optimization lands.

---

## Phase 1 — Zero-Risk Quick Wins (~1–2 days)

- [ ] **T1.1** Run bundle analysis (esbuild metafile / source-map-explorer) on the production build.
- [ ] **T1.2** Confirm `quill`, `ngx-quill`, `parchment`, `xlsx` are in the lazy `admin` chunk and **not** in the initial bundle. Fix any leak (move imports behind the lazy route).
- [ ] **T1.3** Add `loading="lazy" decoding="async"` to **below-the-fold** newspaper page images only.
- [ ] **T1.4** Preload the first/LCP page image: emit `<link rel="preload" as="image" fetchpriority="high">` once today's first-page URL is known. Do **not** lazy-load this image.
- [ ] **T1.5** Set explicit width/height (or `aspect-ratio`) on page images to prevent CLS.
- [ ] **T1.6** Add `<IfModule mod_brotli>` block to `.htaccess` for `application/json` + JS/CSS (guarded; safe if absent).
- [ ] **T1.7** Add `requestIdleCallback` prefetch of the previous day's edition via `EditionCacheService`.
- [ ] **T1.8** Re-measure vs baseline; merge.

**Gate:** no regression; initial bundle confirmed free of admin-only libs.

---

## Phase 2 — Origin Hardening: Static JSON Snapshots (~2–4 days) — *highest scalability ROI*

- [ ] **T2.1** In the WP plugin save/publish flow, write static files on every publish (atomic temp-write → `rename()`):
  - `/data-static/settings.json`
  - `/data-static/dates.json`
  - `/data-static/version.json`
  - `/data-static/editions/<date>.json` (for each affected date)
- [ ] **T2.2** Tie generation to the existing `dataVersion` bump (single source of truth for invalidation).
- [ ] **T2.3** Add `.htaccess` rules to serve the static file when present, PHP fallback on miss. Place **after** the social-bot block, **before** the SPA catch-all.
- [ ] **T2.4** Set cache headers: past-date snapshots `Cache-Control: public, max-age=31536000, immutable`; today's snapshot short max-age + ETag.
- [ ] **T2.5** Exclude statically-served read endpoints from the PHP rate limiter (so spike traffic isn't throttled).
- [ ] **T2.6** Backfill: generate snapshots for existing dates once (one-time script or via `/warm-cache`).
- [ ] **T2.7** Test matrix on **staging**: homepage, deep article URL, social crawler, admin, wp-admin, missing-snapshot fallback.
- [ ] **T2.8** Re-run load test; confirm PHP RPS drops and p95 TTFB falls. (Rollback = delete the `.htaccess` block.)

**Gate:** static path proven faster + origin proven to survive target concurrency.

---

## Phase 3 — Instant First Paint: Data Inlining (~2–4 days) — *highest UX ROI*

- [ ] **T3.1** On publish, inject `<script id="dn-initial-state" type="application/json">{…today's settings+dates+today-edition+dataVersion+generatedAt…}</script>` into the served `index.html` (PHP string-replace on a shell template — pure-PHP, no Node).
- [ ] **T3.2** Add an Angular boot path (`APP_INITIALIZER` or data-service constructor) that reads the blob, hydrates `TransferState`, and seeds `EditionCacheService` + `DateIndexService` synchronously.
- [ ] **T3.3** Skip the initial `forkJoin` in `loadDataFromGranular()` when the blob is present **and** `dataVersion` is current.
- [ ] **T3.4** Fall through to the current `loadDataFromGranular()` path unchanged when the blob is absent or stale (non-breaking guarantee).
- [ ] **T3.5** Verify the 5-min `/version` poll still detects later publishes and runs `reloadCurrentDateOnly()`.
- [ ] **T3.6** Confirm prerendered/inlined `index.html` is **not** long-cached (`text/html` → 0s already set; verify SW serves it with revalidation).
- [ ] **T3.7** Measure cold-visit: spinner gone, LCP improved. Merge.

**Gate:** cold first-visit shows today's news with no spinner; freshness still converges ≤5 min.

---

## Phase 4 — Prerendered Markup (optional, ~3–5 days) — *only if LCP still needs it*

- [ ] **T4.1** Stand up a publish-triggered Node prerender job (reuse `webhook-server.js` + SFTP/`ftp-deploy`).
- [ ] **T4.2** Prerender `/` against the live API, bake first-page section markup + the inlined state blob.
- [ ] **T4.3** Upload generated `index.html` + `/data-static/*` via existing deploy path; keep `index.csr.html` fallback in `.htaccess`.
- [ ] **T4.4** Verify failed prerender never blocks deploy (falls back to `index.csr.html`).

**Gate:** pre-hydration markup measurably improves LCP; otherwise skip this phase.

---

## Phase 5 — Payload Refinement (optional, ~2–3 days)

- [ ] **T5.1** Add `?view=light` (or `/data/editions/<date>/summary`) returning only first-paint data (page list + first page sections + image URLs).
- [ ] **T5.2** Lazy-load full section HTML for other pages on navigation.
- [ ] **T5.3** Tighten `angular.json` initial budget now that the bundle is clean.

---

## Phase 6 — Validate & Document (~1 day)

- [ ] **T6.1** Re-measure all KPIs vs Phase-0 baseline.
- [ ] **T6.2** Prove the concurrency target (e.g. 5,000 concurrent readers, p95 TTFB < 300 ms) with `load-test.js`.
- [ ] **T6.3** Mark completed items in `PERFORMANCE_TODO.md` / `ARCHITECTURE_IMPROVEMENT_PLAN.md`.

---

## Critical Path (if time is limited)

**T0.x → T2.x → T3.x.** Phase 2 makes the site survive spikes; Phase 3 kills the first-visit spinner. Phases 1, 4, 5 are valuable but secondary. Never skip Phase 0 — without the baseline you can't prove any of it worked.
