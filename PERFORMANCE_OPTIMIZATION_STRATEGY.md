# Performance Optimization Strategy — High-Traffic News Portal (No-Node Hosting)

**Project:** digital-newspaper (Angular 21 + WordPress REST plugin)
**Date:** 2026-06-21
**Status:** Planning only — no implementation in this document
**Author note:** This plan is tailored to the *actual* codebase. It explicitly avoids re-recommending work that is already done, and focuses the effort on the genuine remaining gaps.

---

## 0. Executive Summary

The core constraint is: **SSR exists in the build (`@angular/ssr`, `platform-server`, `src/server.ts`) but cannot run, because the host has no Node.js.** Apache/LiteSpeed serves static files only. Therefore per-request server rendering is impossible. The goal — *today's news appears instantly, with no spinner, even on a cold first visit* — must be achieved without a live server runtime.

There is exactly one robust way to do this on static hosting:

> **Generate today's page as a static artifact at publish time, not at request time.**
> A prerendered `index.html` with **today's edition JSON inlined** is written to disk whenever an editor publishes, served directly by Apache, and read synchronously by Angular on boot via `TransferState` — zero network round-trip before first paint.

Most of the surrounding infrastructure to support this **already exists** and simply needs to be connected:

- The build already prerenders a homepage `index.html`, and `.htaccess` already prefers it over `index.csr.html`.
- A `/version` endpoint + 5-minute version poll already exists for invalidation.
- A `/warm-cache` endpoint and webhook server already exist.
- `provideClientHydration()` already enables Angular's HTTP transfer cache.

So the headline recommendation is **not** "build new caching" — your caching is already excellent (4-layer: memory → localStorage → IndexedDB → HTTP, with ETag/304 revalidation and SW dataGroups). The headline recommendation is **"close the first-paint gap with publish-time static generation, and harden the origin so PHP/MySQL is rarely touched under load."**

---

## 1. Baseline — What Already Exists (Do NOT Rebuild)

A precise inventory matters, because half of a typical "news portal performance plan" is already implemented here. Re-doing it would be wasted effort and a regression risk.

| Capability | Status | Where |
|---|---|---|
| Split granular endpoints (`/data/settings`, `/data/dates`, `/data/editions/:date`, `/data/version`) | ✅ Done | `digital-newspaper.php` routes; `newspaper-data.service.ts` `loadDataFromGranular()` |
| Parallel initial fetch (forkJoin settings+dates+version+today's edition) | ✅ Done | `loadDataFromGranular()` |
| In-memory + localStorage + IndexedDB edition cache | ✅ Done | `edition-cache.service.ts`, `idb-cache.service.ts` |
| HTTP cache interceptor w/ per-endpoint TTL + ETag/If-None-Match → 304 | ✅ Done | `http-cache.interceptor.ts` |
| Server-side ETag + `Cache-Control` per date (past 24h, today 5m) | ✅ Done | PHP `editions` handler (~line 3680) |
| Service worker with dataGroups (settings/dates/editions/version) | ✅ Done | `ngsw-config.json` |
| Build-time homepage prerender + `.htaccess` prefer `index.html` | ✅ Done (partial) | `src/.htaccess`, deploy pipeline |
| Auth-aware lazy preload of admin chunk only | ✅ Done | `app.config.ts` `AuthAwarePreloadingStrategy` |
| Self-hosted fonts + `<link rel=preload>` for 3 woff2 subsets | ✅ Done | `index.html`, `@fontsource-variable/google-sans` |
| Critical CSS inlining (`inlineCritical: true`) + minify | ✅ Done | `angular.json` production config |
| Apache gzip (`mod_deflate`) + 1-year expires for hashed assets | ✅ Done | `src/.htaccess` |
| Version poll (5 min) → targeted `reloadCurrentDateOnly()` | ✅ Done | `newspaper-data.service.ts` |
| Splash screen to mask cold boot | ✅ Done | `index.html` `#app-splash` |
| Public GET rate limiter (transient sliding window) | ✅ Done | PHP (~line 513) |

**Implication:** the plan below is deliberately short on "add a cache" items and long on "wire the publish-time pipeline + protect the origin + measure."

---

## 2. The Core Problem, Stated Precisely

Cold first visit, no SW yet, empty client caches. The critical-path waterfall today is roughly:

```
DNS/TLS → HTML (index.html or index.csr.html) → JS download+parse → Angular bootstrap
        → HttpClient forkJoin(settings, dates, version, today-edition) → first contentful render
```

Every client-side cache you have (memory/localStorage/IndexedDB/SW) helps **repeat** visits but does **nothing** for the cold first visit — the data still arrives via an HTTP round-trip *after* JS boots. That round-trip (plus JS parse) is the spinner the user sees.

Two independent levers remove it:

1. **Inline today's data into the HTML** so Angular boots with data already in hand (no post-boot fetch for the primary content).
2. **Prerender today's visible markup** so the browser paints meaningful content before Angular even hydrates.

Both must be produced **at publish time** (static), because there is no Node to produce them per request.

---

## 3. Frontend Optimization (Angular)

### 3.1 Near-instant today's news without SSR — the primary play

**Recommendation A1 — Publish-time data inlining via `TransferState` (highest impact).**

At publish time, write today's `settings` + `dates` + today's `editions[]` as a JSON blob into the served `index.html`:

```html
<script id="dn-initial-state" type="application/json">
  {"settings":{…},"dates":[…],"editions":[…],"dataVersion":1234,"generatedAt":"2026-06-21T03:00:00Z"}
</script>
```

On boot, an `APP_INITIALIZER` (or the existing data service constructor) reads this blob, hydrates `EditionCacheService`'s in-memory layer and `DateIndexService` synchronously, and **skips the initial HTTP `forkJoin` entirely** when the blob is present and `dataVersion` is current. Angular's existing `provideClientHydration()` transfer cache is the same mechanism SSR would have used — here you populate it from a static blob instead of from a live render.

- **First paint of today's news:** immediate, no spinner, no network for primary content.
- **Freshness:** the existing 5-minute `/version` poll runs *after* paint. If it detects a newer `dataVersion` than the inlined blob, `reloadCurrentDateOnly()` silently refreshes — exactly the path that already exists.
- **Non-breaking:** if the blob is absent (e.g. an interior route, or generation failed), fall through to the current `loadDataFromGranular()` path unchanged.

**Recommendation A2 — Prerender markup for the homepage at publish time (extends what exists).**

You already prerender a homepage `index.html`. The gap is that it is produced at **build/deploy** time, so it goes stale the moment a new edition publishes. Move prerendering to a **publish-triggered** step (see §4.4) so the static `index.html` always reflects the latest edition. The prerender should bake the first page's sections markup so the browser shows real content pre-hydration. Because there is no Node at request time, this render must run during the publish hook (on a build box / CI / the webhook server you already have), not on the live host.

**Recommendation A3 — Start the data fetch before Angular boots (fallback for non-inlined routes).**

For routes where inlining isn't available, add a tiny inline script in `<head>` that kicks off the `fetch('/wp-json/.../data/editions/<today>')` *immediately*, in parallel with the main JS bundle download, and stashes the promise on `window`. The data service awaits that promise instead of issuing a fresh request. This overlaps network with JS parse and can shave hundreds of ms. Pair with `<link rel="preload" as="fetch" crossorigin>` for the today-edition URL. Low effort, low risk, complements A1.

**Recommendation A4 — Protect LCP: preload the first page image.**

`PERFORMANCE_TODO.md` PERF-05 already scopes this. The largest contentful element is the first newspaper page image. Once today's first-page image URL is known at publish time, emit `<link rel="preload" as="image" fetchpriority="high">` for it in the generated `index.html`. Add `loading="lazy" decoding="async"` to all *below-the-fold* page images (PERF-04). Do **not** lazy-load the first/LCP image.

### 3.2 Caching strategy assessment (Service Worker / localStorage / IndexedDB)

Your instinct to ask "which is most effective" is already answered well by the existing layering; the right split is:

- **Service Worker (Cache Storage API):** best for the **app shell** (JS/CSS/fonts/HTML) and for making **repeat visits offline-capable and instant**. Already configured. Keep `registerWhenStable:30000` so SW registration never competes with first paint. Recommendation: for the today-edition dataGroup, keep `freshness` strategy but consider adding a **`performance`-strategy mirror for *past* dates** (immutable) so historical browsing is served from SW cache with no revalidation.
- **IndexedDB (`idb`):** correct choice for the **bulk edition archive** (a year ≈ 18 MB, far over localStorage's 5–10 MB quota). Already used for past dates. Keep.
- **localStorage:** correct *only* for **small, synchronous-at-boot** values (latest date, today's edition with 30-min TTL, auth token). Already used exactly this way. Do **not** expand it for large payloads — synchronous JSON.parse of big blobs on the main thread hurts boot.

**Net:** no architectural change needed; the layering is textbook. The one refinement is the past-date SW strategy above, plus making the localStorage "today" seed the source for the inlined-blob fallback.

### 3.3 Preload / prefetch of critical data

- **Prefetch tomorrow/adjacent dates on idle:** when a reader opens today, use `requestIdleCallback` to warm the cache for the previous day (common "yesterday's paper" navigation) via `EditionCacheService` — network-idle, cancellable, never blocks today.
- **`<link rel="preload" as="fetch">`** for the today-edition endpoint (A3).
- **Route-level:** keep `AuthAwarePreloadingStrategy`. Do not switch to `PreloadAllModules` (it would pull the ~689 KB admin chunk for every reader — your code comment already notes this; keep it).

### 3.4 Bundle & boot cost

- Run `source-map-explorer` / `esbuild` metafile analysis (PERF-02/03). Likely suspects from `package.json`: `quill` + `ngx-quill` + `parchment` (editor) and `xlsx` are **admin-only** — confirm they are in the lazy `admin` chunk and **not** in the initial bundle. If any leak into `initial`, that is the single biggest quick win for cold boot. The 750 KB initial budget warning in `angular.json` should be tightened once verified.
- Confirm `zone.js` is still required; if a future migration to **zoneless** change detection (Angular 21 supports it) is on the table, it reduces bundle and boot overhead — but treat as a separate, later, well-tested change (it touches every component's change detection; higher risk). Out of scope for the first phases.

---

## 4. Backend / API Strategy (WordPress REST plugin)

### 4.1 Reduce API latency — serve static JSON, bypass PHP/MySQL

This is the **single most important backend change for both latency and scalability.** Today each `/data/editions/:date` request boots WordPress, runs PHP, and hits `get_option()` (MySQL). Under news-spike traffic that is the bottleneck.

**Recommendation B1 — Publish-time static JSON snapshots.**
On every save/publish, write the response body to a real file on disk, e.g. `/data-static/editions/2026-06-21.json` and `/data-static/dates.json`, `/data-static/settings.json`, `/data-static/version.json`. Then in `.htaccess`, route the read endpoints to the static file when it exists, falling back to PHP only on a miss:

```apache
# Serve prebuilt JSON directly; PHP only generates on a miss.
RewriteCond %{DOCUMENT_ROOT}/data-static/editions/$1.json -f
RewriteRule ^wp-json/digital-newspaper/v1/data/editions/(\d{4}-\d{2}-\d{2})/?$ /data-static/editions/$1.json [L]
```

Result: the hot path (today's edition, dates, settings, version) is served as a static file by Apache — **no PHP, no MySQL** — which is what makes a news portal survive a traffic spike on shared/static hosting. Writes still go through the full plugin; only reads are short-circuited. This is fully non-breaking: identical JSON shape, identical URLs.

**Recommendation B2 — If file generation is undesirable, use WordPress transients/object cache.**
Lower-impact alternative: cache the fully-rendered JSON in a transient keyed by `date + dataVersion` (`set_transient("dn_edition_{$date}_{$ver}", $json, DAY)`), so the handler returns the cached string without re-reading/normalizing options. You already use `wp_cache_*` for ad slots and transients for migration locks — same pattern. B1 is strictly better for high traffic, but B2 is a good stopgap and they compose.

### 4.2 Smart invalidation (cache-bust only on publish)

You already have the right primitive: a monotonically increasing `dataVersion` stamped by PHP on every save, plus a 5-minute client poll. Extend it:

- On publish, **(a)** bump `dataVersion`, **(b)** regenerate the static JSON snapshots (B1) for affected dates, **(c)** regenerate the prerendered `index.html` (A2), **(d)** optionally hit the existing `/warm-cache` endpoint to pre-build them. All keyed off the one publish event.
- Past-date snapshots are immutable → `Cache-Control: public, max-age=31536000, immutable`. Today's snapshot → short max-age + ETag (already implemented server-side; mirror it on the static file via `.htaccess` headers).
- The client's existing ETag/304 path and version poll then converge readers onto fresh content within ≤5 minutes with near-zero bandwidth.

### 4.3 Large JSON payloads (the monolithic `/data`)

Largely **already solved** — you split `/data` into per-date `/data/editions/:date`. Remaining refinements:

- **Field trimming / "light" today payload:** add an optional `?view=light` (or a `/data/editions/:date/summary`) that returns only what the *first paint* needs (page list + first page's sections + image URLs), deferring full section HTML for other pages to a lazy fetch when the reader navigates. Smaller first byte → faster LCP. Keep the full endpoint for cache-warming and offline.
- **Compression:** ensure `application/json` is gzipped (already in `mod_deflate` list). If the host supports **Brotli** (`mod_brotli`), add it — Brotli beats gzip on JSON by ~15–20%. Guard with `<IfModule>` so it's safe where absent.
- **Avoid base64 / inline images in JSON** — confirm payloads carry image **URLs** only (they appear to). Never inline image bytes into the edition JSON.

### 4.4 Where publish-time generation runs (no Node on host)

Since the live host has no Node, the prerender + snapshot generation must run somewhere that does:

- **Option 1 (recommended): the existing `webhook-server.js` / deploy pipeline.** WordPress already can fire a webhook on publish (`WEBHOOK_SETUP.md`). Point it at a small job that runs `ng build` prerender for `/` against the live API, inlines the state blob, writes static JSON snapshots, and uploads `index.html` + `/data-static/*` via the existing SFTP/FTP deploy path (`ssh2-sftp-client`, `ftp-deploy` are already dependencies).
- **Option 2 (pure-PHP, no Node at all): PHP writes the snapshots + a templated `index.html`.** PHP can `file_put_contents()` the JSON snapshots trivially (B1). For the inlined-state `index.html`, PHP can string-replace the `<script id="dn-initial-state">` placeholder in a copy of the shell on publish. This removes the Node dependency entirely for the data-inlining play (A1), though it does **not** give you prerendered *markup* (A2) — only inlined data. A1 alone already removes the spinner, so Option 2 is a valid, simpler path if standing up a Node publish job is unwanted.

**Trade-off:** Option 1 gives the best result (prerendered markup *and* inlined data) but needs a Node build box in the publish loop. Option 2 needs zero Node but delivers inlined-data-only (still a huge win). Recommend starting with Option 2 (A1) for speed and adding Option 1 (A2) later if LCP still needs the pre-hydration markup.

---

## 5. Performance Metrics, KPIs & Trade-offs

### 5.1 What to track

| Metric | Target (median, 4G mobile) | Why |
|---|---|---|
| **TTFB** | < 200 ms (static) / < 600 ms (PHP) | B1 static JSON should pull this down sharply under load |
| **FCP** | < 1.0 s | Splash + critical CSS already help; prerender (A2) improves further |
| **LCP** | < 2.0 s (good), < 2.5 s threshold | First page image; preload it (A4) |
| **INP** | < 200 ms | Interaction latency (date picker, modal). Watch for main-thread JSON parse stalls |
| **CLS** | < 0.1 | Reserve image dimensions to avoid shift when page images load |
| **TTI / bootstrap time** | < 3 s | Driven by initial JS; depends on bundle hygiene (§3.4) |
| **Origin RPS served by PHP** | minimize | After B1, today's reads should mostly be static-file hits |

### 5.2 How to measure (no third-party services)

- **Synthetic:** Chrome DevTools / Lighthouse locally (free, no external dependency). Run before/after each phase on a throttled "Fast 4G" profile.
- **Field (RUM):** use the browser's native `PerformanceObserver` (`paint`, `largest-contentful-paint`, `event`/INP, `layout-shift`, `navigation` entries) — **no library required**. Beacon the numbers to the **existing `/activity-log` endpoint** (you already have `activity-log.service.ts` + batch route). This gives real-user vitals without any external analytics SaaS, honoring the "no third-party tools" constraint.
- **Load testing:** you already ship `load-test.js`. Extend it to hammer `/data/editions/<today>` and compare PHP-path vs static-path (B1) latency and error rate at rising concurrency.

### 5.3 Trade-offs (honest accounting)

- **Inlined state (A1):** larger HTML document (today's JSON adds tens of KB). Mitigate with gzip/Brotli; it's still a net win vs a separate round-trip, and it's only the *today* payload, not the archive.
- **Publish-time generation (B1/A2):** moves cost from read-time to publish-time and adds a generation step that can fail. Mitigate with atomic writes (write temp file → rename) and the existing `index.csr.html` fallback in `.htaccess` so a failed generation never takes the site down.
- **Static JSON snapshots (B1):** risk of serving stale JSON if invalidation misses. Mitigate by keying regeneration to the `dataVersion` bump and keeping today's snapshot on a short max-age + ETag; past dates are immutable so staleness is not possible there.
- **Brotli/static routing in `.htaccess`:** host-dependent. Guard everything in `<IfModule>` and test on staging first.

---

## 6. Traffic Scalability (Concurrent-User Spikes)

News portals spike hard (breaking news). On static hosting with no Node, the strategy is **"make the origin mostly static so spikes hit files, not PHP/MySQL."**

1. **B1 static JSON is the linchpin** — when today's edition, dates, settings, and version are flat files, Apache/LiteSpeed serves thousands of concurrent reads with trivial CPU. PHP/MySQL is touched only on cache-miss or write.
2. **Push freshness to the client, not the server** — the 5-minute version poll means each reader self-refreshes; you never need server push or websockets.
3. **Service Worker absorbs repeat load** — returning readers during a spike are served entirely from SW/IndexedDB; their requests may never reach the origin at all.
4. **Long-cache immutable assets** — already done (1-year expires on hashed JS/CSS/images). Hashed filenames mean a deploy never causes a cache stampede.
5. **Rate limiter stays** — the existing transient sliding-window limiter protects write/auth endpoints; ensure read endpoints served statically (B1) are *excluded* so legitimate spike traffic isn't throttled.
6. **Future CDN hook (when allowed):** every read response already carries correct `Cache-Control`/`s-maxage`/ETag, so the day the "no third-party" constraint lifts, dropping a CDN in front is plug-and-play with zero code change. Note this as a future lever, not current work.

**Concurrency budget to validate:** define a target (e.g. "5,000 concurrent readers, p95 TTFB < 300 ms") and prove it with the extended `load-test.js` against the static path before declaring scalability done.

---

## 7. Risks & Pitfalls (and Mitigations)

- **Stale inlined data on a returning user** whose HTML is SW-cached from yesterday → the version poll + `reloadCurrentDateOnly()` already corrects this within 5 min; ensure the inlined blob carries `dataVersion` so the poll can compare. Also ensure the SW serves `index.html` with a short/`no-cache`-revalidated policy so the shell HTML itself refreshes (ngsw already handles index via `freshness`-style navigation; verify the prerendered `index.html` isn't long-cached by `mod_expires` — it's `text/html` → `0 seconds`, which is correct).
- **Prerender built against an unreachable API** → `.htaccess` already falls back `index.html` → `index.csr.html`. Keep that fallback; never let a failed prerender block deploy.
- **Editor confusion / "I published but the site shows old content"** → because generation is publish-triggered, make the publish hook synchronous-enough or surface a "regenerating…" state in admin. Document the ≤5-min poll convergence for readers.
- **localStorage/IndexedDB quota or private-mode failures** → already handled defensively (try/catch, availability checks) in `idb-cache.service.ts`. Keep all new cache reads non-throwing.
- **Bundle leak of admin-only libs (quill/xlsx)** into the initial chunk → measure (§3.4) before/after; this can silently inflate cold boot.
- **`.htaccess` rule ordering** → the static-JSON routing must come *before* the SPA catch-all and *after* the social-bot block. Test the full matrix (homepage, deep article URL, social crawler, admin, wp-admin) on staging.
- **CLS from late-loading page images** → set explicit width/height (or aspect-ratio) so reserving space prevents shift.

---

## 8. Safe, Phased, Non-Breaking Roadmap

Each phase is independently shippable, reversible, and gated by measurement. Nothing here changes the Angular component tree or UI.

### Phase 0 — Measurement baseline (0.5 day, zero risk)
- Add native `PerformanceObserver` RUM beaconing to the existing `/activity-log` endpoint (TTFB/FCP/LCP/INP/CLS).
- Capture Lighthouse + `load-test.js` numbers for cold first visit and for `/data/editions/<today>` under load. **This is the before-picture; do not skip it.**

### Phase 1 — Zero-risk quick wins (1–2 days)
- Confirm and fix any admin-lib bundle leak (PERF-02/03).
- Add `loading="lazy" decoding="async"` to below-the-fold page images (PERF-04); preload the first/LCP image (PERF-05/A4).
- Add Brotli `<IfModule mod_brotli>` block to `.htaccess` if host supports it.
- Add `requestIdleCallback` prefetch of the previous day's edition.

### Phase 2 — Origin hardening: static JSON snapshots (2–4 days, highest scalability ROI)
- Implement **B1**: PHP writes `/data-static/{settings,dates,version}.json` and `/data-static/editions/<date>.json` on save (atomic temp-write + rename).
- Add `.htaccess` rules to serve those files when present, PHP fallback on miss.
- Set immutable long-cache on past-date snapshots; short max-age + ETag on today.
- Re-run the load test; verify PHP RPS drops and p95 TTFB falls. Roll back = delete the `.htaccess` block (instant revert).

### Phase 3 — Instant first paint: data inlining (2–4 days, highest UX ROI)
- Implement **A1**: PHP (Option 2) injects `<script id="dn-initial-state">` with today's settings+dates+today-edition into a generated `index.html` on publish.
- Add the Angular boot path that reads the blob into `TransferState` → seeds `EditionCacheService`/`DateIndexService` → skips the initial `forkJoin` when blob is fresh. Fall through to current path when absent.
- Verify cold-visit spinner is gone; verify version poll still refreshes on a later publish.

### Phase 4 — Prerendered markup (optional, 3–5 days)
- Stand up the publish-triggered Node prerender (Option 1 / A2) via the existing webhook + SFTP deploy, baking first-page markup + the inlined blob.
- Only pursue if Phase-3 LCP still needs pre-hydration markup. Otherwise defer.

### Phase 5 — Payload refinement (2–3 days, optional)
- Add `?view=light` first-paint payload (§4.3); lazy-load full section HTML on navigation.
- Tighten `angular.json` initial budget once bundle is clean.

### Phase 6 — Validate & document (1 day)
- Re-measure all KPIs vs Phase-0 baseline; prove the concurrency target with `load-test.js`.
- Update `PERFORMANCE_TODO.md` / `ARCHITECTURE_IMPROVEMENT_PLAN.md` to mark items done.

**Suggested order of impact:** Phase 2 (survives spikes) and Phase 3 (kills the spinner) are the two that matter most; do them first after baselining. Phases 4–5 are polish.

---

## 9. Non-Breaking Guarantee (Design Principles)

- Every change has a **fallback to the current path**: missing inline blob → `loadDataFromGranular()`; missing static JSON → PHP handler; failed prerender → `index.csr.html`.
- **No UI/component changes** are required for Phases 0–3; they alter only the *data-delivery* and *origin-serving* layers.
- All `.htaccess` and server-module changes are wrapped in `<IfModule>` and tested on **staging** (`environment.staging.ts` / `serve:staging` already exist) before production.
- Invalidation is driven by the **single existing `dataVersion` primitive**, so there is one source of truth and no new cache-coherence surface.
- Writes always go through the full plugin; only **reads** are accelerated — editorial workflow is untouched.

---

## 10. One-Paragraph Recommendation

Keep your already-excellent client caching as-is. Spend the effort on two publish-time moves that static hosting actually rewards: **(1) write today's edition/settings/dates/version as flat JSON files on publish and serve them straight from Apache (B1)** — this is what lets the site survive traffic spikes without a Node server or CDN; and **(2) inline today's data into `index.html` on publish and read it via `TransferState` on boot (A1)** — this is what removes the first-visit spinner without SSR. Both are reversible, both reuse the `dataVersion`/webhook/warm-cache machinery you already built, and neither touches the Angular UI. Measure first (Phase 0), then ship Phase 2 and Phase 3.
