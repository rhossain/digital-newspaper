# Epaper Browser Errors — Root Cause Analysis & Fixes

**Observed:** 2026-10-18 on `https://epaper.dailysangram.com/2026-10-18/page-01/edition-01/post-1792255359027/`
**Reviewed & fixed:** 2026-10-20 (code read, live probes of production, local build + PHP harness)

| # | Error | Root cause | Fix |
|---|-------|------------|-----|
| 1 | SW `fetchAndCacheOnce` 504 on `index.csr.html` | 1 MB shell on a slow host; plugin rewrite broke the SW hash; shell cached for 1 h | Plugin re-pins the hash, inlines light state (1 MB → about 237 KB); header rule fixed |
| 2 | `[EditionCacheService] … Timeout has occurred` | REST timeout after the static snapshot failed on the same slow host | Retry static fetches once on 5xx / status 0, inside the existing budgets |
| 3 | "preloaded but not used" | Today's page-1 image preloaded on every route; latin-ext font preloaded but rarely rendered | Image preload limited to the routes that show it; latin-ext preload removed |
| 4 | GPT deprecations #170 / #171 | Deprecated `disableInitialLoad()` / `clearTargeting()` | Migrated to `setConfig`, keeping the old semantics |

---

## 1. Service Worker 504 on `index.csr.html`

### Mechanism

A navigation is answered from the SW's index. When that entry isn't in cache, `fetchAndCacheOnce` refetches it. Angular's SW raises a non-ok response as a plain `Error`, not `SwCriticalError`, so `Driver.handleFetch` rethrows it and the browser shows a network error (`ngsw-worker.js:531`, `:1825-1834`).

### Causes found live (2026-10-20)

1. **The shell is 1,017,648 bytes.** 1,007,574 bytes of it is the `dn-initial-state` blob, and 954 KB of that is article HTML for all 12 pages. LiteSpeed served it uncompressed in 14–40 s. A gateway timing out on that transfer is the 504.
2. **The SW hash check fails.** `ngsw.json` pins `/index.csr.html` to `9e04cbbe…`, but the live file hashes to `5a4286e2…` because `maybe_rewrite_index_html()` rewrites it on every publish. Every SW install or update fails with `Hash mismatch`, so the index never gets cached properly and the failure path above is hit.
3. **The shell is browser-cached for an hour.** The live response carries `cache-control: max-age=3600`. The `Header always set` no-cache rule for `index(.csr)?.html` isn't applied, while the plain `Header set` rule on `ngsw.json` is.

(The `index.html` → `index.csr.html` edit in `ngsw-config.json` is cosmetic. The builder already substitutes it, and the Oct 1 `dist/…/ngsw.json` had `"index": "/index.csr.html"` before the edit.)

### Fixes

- **Plugin, `write_index_html()` / `sync_ngsw_index_hash()`.** Every write of the served index updates the `hashTable` entry in the sibling `ngsw.json` to the new SHA-1. It also removes the stale `ngsw.json.br` / `.gz`, which `.htaccess` would otherwise serve first, and lets `atomic_write()` regenerate `.gz` (and `.br` when available). All three writers use it: the publish rewrite and both clear-on-disable handlers. A publish that leaves the index unchanged still re-pins the hash, so the current production mismatch heals on the next publish or "Regenerate snapshots now". The rewritten index now arrives as an ordinary SW app update.
- **Plugin, light inline state.** `initial-state.json` (the inlined blob) now holds `lightEditions` from `build_light_editions()`, which keeps article bodies for the first page only. Measured on the live data: the shell drops from 1,017,648 to about 236,500 bytes. The new key name means an app build without this change ignores the blob instead of caching stripped articles as full.
- **App, `BootstrapStateService` / `NewspaperDataService`.** The app accepts `lightEditions` and seeds only the date index from it, never the edition cache. The inline-gated first paint emits the light editions as `_partial`, so `loadData()` runs the existing `upgradePartialData()` background upgrade. Opening a stripped article before that finishes already goes through `getFullEditionsForDate()`.
- **`src/.htaccess` and `deploy.js`.** The index no-cache rule now uses `Header set` instead of `Header always set`, matching the `ngsw.json` rule that works on this host.

## 2. `EditionCacheService` "Timeout has occurred"

The warning is logged only by `_fetchFromRest()`, after its 10 s timeout. `_tryStatic()` swallows its own errors. So the static snapshot had already failed, and the REST fallback then timed out on the same slow host. With the shell 4× smaller, the host is under less pressure. On the client:

- **`_retryTransient()`**: one retry after 1 s, only for status 0 or ≥ 500. A 404 (no snapshot for the date) goes straight to the fallback.
- **`_tryStatic()`**: the retry plus `timeout(8000)` covering both attempts. Static (8 s) + REST (10 s) stays inside the 20 s granular-chain `timeout(20000)` in `NewspaperDataService`. The first attempt's `retry` + `timeout(12000)` would have reached 22 s and tripped that outer timeout.
- **`getEditionsForDateLight()`** (the public viewer's first fetch when nothing is inlined): the same retry, keeping its original `timeout(6000)`.

## 3. "Preloaded but not used"

`fetchpriority` has nothing to do with this warning, so the attempt to drop it was reverted. It's back to `fetchpriority="high"` for the LCP image. The real causes:

- **The image preload was emitted for every route**, but only `/` and today's first page (`/<date>/page-01/edition-NN…`) show that image. The reported URL was a 2026-10-18 article. The plugin now emits a small inline script inside the same `<!--dn-preload-->` markers. It checks `location.pathname` and adds the same `<link rel="preload">` tags only on those routes. URLs are JSON-encoded with `JSON_HEX_*` flags, so they can't break out of the script. If a CSP enforcing `script-src 'self'` is ever applied to the static shell, the script is blocked and the page simply loads without the preload.
- **`google-sans-latin-ext`** (`src/index.html`) was preloaded, but its `unicode-range` rarely appears on a Bengali page. The preload was removed; the `@font-face` still fetches it on demand.

## 4. GPT deprecations

- `ad.service.ts`: `pubads().disableInitialLoad()` → `googletag.setConfig({ disableInitialLoad: true })`, before `enableServices()` as the docs require.
- `gam.service.ts`: `clearTargeting()` + `setTargeting()` → `setConfig({ targeting: null })` then `setConfig({ targeting: clean })`. `Slot.setConfig({ targeting })` **merges per key**. A single call would keep a stale `section=x` after the reader closes a section. Clearing with `null` first matches the old behaviour exactly.

---

## Deploy

The order doesn't matter: each side tolerates the other's old version.

1. `npm run build`, then upload `dist/digital-newspaper/browser` (includes `.htaccess`, `ngsw.json` and its `.br`/`.gz`).
2. Update the WordPress plugin, then publish once or click **Regenerate snapshots now** to rewrite the shell and re-pin the hash.

## Verification

Done locally:

- `npx tsc --noEmit -p tsconfig.app.json`: clean. `npx ng build` (to a scratch dir): succeeds; `ngsw.json` has `index: /index.csr.html` with a hash matching the built file.
- `php -l` on the plugin: clean. A PHP harness running the extracted methods against a copy of the real `ngsw.json`:
  - the hash matches the written index;
  - only `hashTable["/index.csr.html"]` changed;
  - stale `.br` removed, `.gz` regenerated and matching;
  - preload script built with the correct path and escaped URLs;
  - light editions keep only the lowest-id page's content.
- Retry policy simulated (rxjs 7.8.2): 504→200 succeeds on attempt 2; 404 falls back after 1 attempt; 504×2 falls back after 2 attempts.

After deploy:

- `curl -sI https://epaper.dailysangram.com/index.csr.html`: expect `cache-control: no-cache, must-revalidate`. If LiteSpeed still sends `max-age=3600`, the host-level LiteSpeed "Expires" setting overrides `.htaccess` and must be changed in the hosting panel.
- `sha1sum` of the served `index.csr.html` must equal `hashTable["/index.csr.html"]` in the served `ngsw.json`.
- The shell should be about 240 KB, not about 1 MB.
- DevTools → Application → Service Workers: the SW activates without `Hash mismatch` in `/ngsw/state`.
- GPT console (`?google_console=1`): no stale `section` after closing a section. Re-measure §8.6 modal vs panel fill for one week (the `disableInitialLoad` lever).

## Residual risk

- The host itself is slow (ngsw.json, 17 KB, took about 11 s from an external probe). The changes cut what it has to serve, but a CDN in front of the static shell and `wp-content/dn-static/` is the durable fix.
- Angular's SW still turns a non-ok index refetch into a hard navigation error. With the hash fixed the index is cached at install, so this path should only occur after storage eviction.
