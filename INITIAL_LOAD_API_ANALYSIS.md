# Initial-Load API Call Analysis & Zero-API First-Paint Plan

_Analysis only — no code changed. Date: 2026-06-23._

## 1. What actually happens when you hit the root URL (`/`)

### Serving layer
- Root route `''` is configured `RenderMode.Client` (`src/app/app.config.server.ts`). There is **no SSR and no prerender** for `/`. On the shared host, Apache serves a **static `index.html` shell** (via `.htaccess`), Angular boots in the browser, and only *then* does it fetch data.
- Because the HTML shell carries **no content**, first contentful paint is blocked on JavaScript download + bootstrap + the data round-trips below.

### The API calls fired before content can render
All of these run in one parallel `forkJoin` inside `loadDataFromGranular()` (`src/app/services/newspaper-data.service.ts:663`), triggered from `loadNewspaperData()` → `loadData({ lightFirst: true })`:

| # | Call | Endpoint | Hits PHP? | Source |
|---|------|----------|-----------|--------|
| 1 | Settings | `GET /wp-json/digital-newspaper/v1/data/settings` | **Yes (WordPress REST)** | `settings.service.ts:65` |
| 2 | Dates index | `GET /wp-json/digital-newspaper/v1/data/dates` | **Yes (WordPress REST)** | `date-index.service.ts:79` |
| 3 | Version probe | `GET /wp-json/digital-newspaper/v1/data/version` | **Yes (WordPress REST)** | `newspaper-data.service.ts:685` |
| 4 | Latest edition (light) | `GET /wp-content/dn-static/editions/{date}.light.json` → REST fallback | Static-first, PHP on miss | `edition-cache.service.ts:179` |

Then, shortly after first paint, **more** calls fire:
- **Background "upgrade"** from the light edition to the full edition payload (because `lightFirst: true` marks data `_partial`).
- **Version poll** every 5 minutes: `startVersionPoll(300_000)` (`newspaper-data.service.ts`), hitting `/data/version`.
- **Idle prefetch** of the previous day's edition (`prefetchPreviousDateOnIdle()`).

### The core problem
**Three of the four blocking calls (settings, dates, version) always go to WordPress PHP REST endpoints** — every one spins up a full WordPress bootstrap. Even when caches are warm, `settings.fetch()` and `dateIndex.fetch()` **unconditionally** call `http.get` (no freshness short-circuit), so a cold browser reload always pays for 3 PHP requests serially-gated behind WP startup. That is the dominant cause of the "site takes some time to load" you are seeing on both prod and staging.

## 2. Why the existing optimizations don't fully solve it

The codebase already has strong machinery, but it is **half-wired**:

1. **Inline bootstrap state exists but is never delivered.** `BootstrapStateService` reads `<script id="dn-initial-state">` from the HTML and seeds caches synchronously *before* the first request (`newspaper-data.service.ts:362`). The plugin even **generates `initial-state.json`** (`digital-newspaper.php:1704`). **But nothing injects that blob into the served `index.html`** — confirmed: no `dn-initial-state` placeholder exists in `src/index.html` or the built `index.csr.html`, and the plugin never rewrites the HTML. So this path is **dead code in production** and the network boot path always runs.

2. **Static snapshots exist but only editions use them.** The plugin writes `settings.json`, `dates.json`, `version.json`, `editions/*.json` to `wp-content/dn-static/` (`digital-newspaper.php:1604-1707`). Only `EditionCacheService` does static-first (`edition-cache.service.ts:285`). **`SettingsService`, `DateIndexService`, and the version probe still go straight to PHP REST.**

3. **The HTTP cache is in-memory only** (`http-cache.interceptor.ts`) — "intentionally cleared on page reload." So it never helps a cold load or a refresh.

4. **Service worker is registered but not precaching the data endpoints.** `ngsw-config.json` does not list the snapshot/data URLs as `dataGroups`, so repeat visits don't serve data from the SW cache.

## 3. The honest constraint

You cannot reach **literally zero network for a first-ever visitor** unless the content is *already inside the HTML the server hands back*. Any client-side app that fetches data has to get that data from somewhere. So "avoid all API calls on initial load" splits into two achievable goals:

- **A. First contentful paint with zero API calls** → bake the data into the HTML (inline state). The browser renders immediately from the HTML; refresh/validation happens later, off the critical path.
- **B. Zero *PHP* calls, ever, on the read path** → serve all read data as static files (Apache/CDN), never WordPress REST.
- **C. Zero network on repeat visits** → service worker precache + long cache headers.

The plan below delivers all three, and most of it is finishing work already started.

## 4. Recommended solutions (priority order, standard patterns)

### Solution 1 — Inline the initial state into `index.html` (biggest win; finishes the half-built path)
**Pattern:** state-inlining / "transfer state without SSR." This is the same idea Next/Nuxt/Angular-SSR use, achieved on PHP hosting by writing the blob into the static HTML at publish time.

- Add a placeholder to `src/index.html`: `<script id="dn-initial-state" type="application/json"></script>`.
- On every publish, have the plugin **rewrite the deployed `index.html`** (atomic write, same mechanism as snapshots) replacing that script's contents with the already-generated `initial-state.json` payload (settings + dates + latest editions + dataVersion).
- `BootstrapStateService` already reads and validates it; `NewspaperDataService` already seeds caches from it.
- **Result:** root URL renders today's paper from the HTML with **zero API calls** before first paint. CSP already allows this (settings page CSP note at `digital-newspaper.php:551`; `application/json` script is not executable JS, so no `unsafe-inline` needed).

### Solution 2 — Gate the granular fetches so a fresh inline state skips the network entirely
Right now, even after inline seeding, `loadDataFromGranular()` still fires all 4 calls. Add a freshness gate:
- If inline `dataVersion` (or a cached `dataVersion` newer than a small TTL) is present, **skip** the settings/dates/version/edition network calls on initial load and let the **5-minute version poll** (or a single deferred `requestIdleCallback` revalidation) detect staleness and refresh in the background.
- This converts the blocking `forkJoin` from "4 calls" to "0 calls" on the common path, with correctness preserved by the existing version poll.
- **Result:** initial load makes **no API calls at all** when the inlined content is current.

### Solution 3 — Repoint settings/dates/version to static snapshots (kill PHP on the read path)
For the cases where a network call *does* happen (first-ever visit, stale version, inline disabled):
- Make `SettingsService.fetch()`, `DateIndexService.fetch()`, and the version probe do **static-first** (`wp-content/dn-static/settings.json`, `dates.json`, `version.json`) with REST fallback — mirroring `EditionCacheService._tryStatic()`.
- These are flat files served by Apache/LiteSpeed with **no PHP**, and are CDN-cacheable.
- **Result:** the read path never touches WordPress PHP; even a "miss" is a static file fetch, 10–50× cheaper.

### Solution 4 — Service worker precache of the data snapshots (zero network on repeat visits)
- Add the snapshot URLs to `ngsw-config.json` as a `dataGroups` entry with `strategy: freshness` (or `performance` with a short `maxAge` + background revalidate).
- **Result:** returning visitors get settings/dates/today's edition from the SW cache instantly, offline-capable, network only to revalidate.

### Solution 5 — Cache headers + preconnect/preload (squeeze the remainder)
- Ensure `wp-content/dn-static/*.json` is served with a sane `Cache-Control` (the snapshot `.htaccess` currently uses `no-cache, must-revalidate` for correctness — fine, because Last-Modified/ETag 304s are tiny; pair with the SW for instant repeat paint).
- Add `<link rel="preload">` for the main JS bundle and `rel="preconnect"` to the WP origin in `index.html`, and make sure the splash screen (`#app-splash`) is dismissed the instant inline content paints.

## 5. Expected outcome

| Scenario | Today | After plan |
|----------|-------|------------|
| First-ever visit | 3 PHP + 1 edition fetch before paint | 1 static file set (or inline if pre-baked); **0 PHP** |
| Return visit (warm) | Still 3 PHP calls on reload | **0 network calls** before paint (SW + inline) |
| Content actually changed | n/a | Detected by version poll, refreshed off critical path |

The single highest-leverage step is **Solution 1 + 2** (inline state + fetch gating): it makes the common initial load require **zero API calls** and reuses code that is already 80% written. Solutions 3–5 harden the fallback and repeat-visit paths.

## 6. Suggested sequencing (when you approve implementation)
1. Solution 3 (static-first for settings/dates/version) — smallest, immediate PHP elimination, low risk.
2. Solution 1 (plugin injects inline state into `index.html`).
3. Solution 2 (gate fetches on fresh inline `dataVersion`).
4. Solution 4 (SW dataGroups).
5. Solution 5 (headers/preload polish).

Each step is independently shippable and backward-compatible (every path already has a REST fallback).

---

## 7. Live staging verification (run 2026-06-23 against `nepaper.dailysangram.com`)

Loaded staging in a real browser and inspected the network waterfall + the actual served files. Findings:

**Warm / returning visit is already near-zero-API.** On a reload with a primed service-worker cache, the **only** first-party request that hit the network was the idle prefetch of the previous date's static snapshot:
`GET /wp/wp-content/dn-static/editions/2026-06-21.json → 200`.
The shell, bundles, settings, dates and today's edition were all served from the SW/disk cache — **no WordPress REST calls at all.** So the slowness you feel is the **cold load** (empty SW cache, or first visit after a deploy/SW update), not the warm path.

**The static-snapshot system is live and healthy.** All three confirmed present and served by Apache as `application/json` with **no PHP**:
- `…/dn-static/settings.json` → full settings + `dataVersion`.
- `…/dn-static/dates.json` → dates list + `latestDate`.
- `…/dn-static/initial-state.json` → **settings + dates + today's full editions + dataVersion** — exactly the blob the inline-state path needs, and it was current (contained today, `2026-06-23`).

**Two concrete gaps confirmed live:**
1. **The inline blob is generated but never delivered.** `initial-state.json` exists and is fresh, but the served `index.html` carries no `<script id="dn-initial-state">`, so `BootstrapStateService` always reads `null` and the cold path runs the network boot. **Solution 1 is purely "wire up something that already exists."**
2. **`dates.json` snapshot is stale relative to `initial-state.json`.** At test time `dates.json.latestDate` was `2026-06-21` and the array omitted `2026-06-23`, while `initial-state.json` and the live page already showed `2026-06-23`. The idle prefetch even fetched `2026-06-21` as "previous date" off that stale list. This is a snapshot-regeneration consistency bug (the dates snapshot isn't rewritten as reliably as initial-state) and is worth fixing alongside Solution 3 — otherwise pointing `DateIndexService` at the static `dates.json` could surface a missing latest date until the next publish.

**Net:** the live evidence supports the plan. The fastest, lowest-risk wins are (a) inject `initial-state.json` into `index.html` at publish (Solution 1 + 2 → zero API calls on cold first paint), and (b) fix the `dates.json` regeneration so the static dates index is never behind the editions.
