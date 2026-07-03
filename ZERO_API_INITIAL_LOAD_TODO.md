# Zero-API Initial Load — Ordered Implementation To-Do

_Plan only. No code changed yet. Companion to `INITIAL_LOAD_API_ANALYSIS.md`._

**Hard constraints honored throughout:** no new third-party plugin, no Node.js runtime, no CDN. Only the existing first-party WordPress plugin (PHP), the existing Angular app, and Apache `.htaccess` are touched. Every step is additive with a fallback, so **no existing feature, UI, or data is broken, and no data is lost** if a step is reverted.

**Golden rules applied to every task below:**
- The 5-minute **version poll stays on** as the correctness safety-net — any staleness introduced by static/inline data is auto-corrected.
- The **admin path is never made to depend on static/inline reads** — the editor always loads the authoritative REST payload, so saves can never write stale data (no data loss).
- Every read change is **static-first / inline-first with REST fallback** — if a file is missing/old, behavior is exactly as today.
- Each task is independently shippable and independently revertible.

---

## Phase 0 — Pre-flight (no behavior change)

- [ ] **0.1 Confirm deploy paths and write permissions.** Verify where the live `index.html` is served from on prod and staging, and whether the WordPress PHP process can write to it (it already writes `wp-content/dn-static/`). This decides whether Phase 4 (HTML injection) is done by the plugin directly or by the deploy step. _Done when:_ writable path confirmed on both environments, or a fallback owner for the write is chosen.
- [ ] **0.2 Establish rollback + flag strategy.** Each server-side change sits behind the existing static-snapshot feature flag (or a new sibling option, default OFF). Each Angular change behaves as today when the static/inline source is absent. _Done when:_ a one-line revert is documented for every task.

---

## Phase 1 — Fix the static `dates.json` regeneration bug (PHP, prerequisite)

> Must come first: Phase 3 makes the frontend trust the static dates index, so it has to be correct before that. Observed live: `dates.json.latestDate = 2026-06-21` while today's edition `2026-06-23` was already published and present in `initial-state.json`.

- [ ] **1.1 Make `dates.json` regenerate atomically with editions.** Ensure every publish/save path that writes an edition snapshot also rewrites `dates.json` (and `version.json`) in the same best-effort block, so the dates index can never lag the editions. Reuse the existing atomic-write helper.
- [ ] **1.2 Add a "regenerate snapshots" backfill check.** Confirm the existing "Regenerate snapshots now" admin button rewrites `dates.json` consistently; use it to repair the current staleness on staging/prod.
- [ ] **1.3 Verify** `dates.json`, `version.json`, `settings.json`, `initial-state.json`, and `editions/{latest}.json` all report the same `latestDate`/`dataVersion` after a publish.
- _No-break / no-loss:_ pure additive snapshot writes; REST endpoints unchanged; if a write fails it's logged and the REST path still serves truth.
- _Revert:_ none needed (bug fix); snapshots remain optional.

---

## Phase 2 — (covered by Phase 1) verify snapshot completeness

- [ ] **2.1** Confirm the plugin already emits `settings.json`, `dates.json`, `version.json`, `editions/*.json`, `*.light.json`, `initial-state.json` (verified live for settings/dates/initial-state). Spot-check that `version.json` and `*.light.json` exist for the current date. _Done when:_ all six file types return 200 as static JSON with no PHP.

---

## Phase 3 — Repoint settings/dates/version reads to static-first (Angular)

> Biggest cold-load win with the smallest blast radius: the snapshot files already exist, and a REST fallback preserves today's behavior exactly. Converts 3 WordPress/PHP calls into 3 flat-file fetches.

- [ ] **3.1 `SettingsService.fetch()` → static-first.** Try `wp-content/dn-static/settings.json`, fall back to the REST `/data/settings` on miss/empty/error. Mirror the existing `EditionCacheService._tryStatic()` pattern (timeout + `catchError` → fallback).
- [ ] **3.2 `DateIndexService.fetch()` → static-first.** Same pattern against `dates.json`, REST fallback. (Safe only because Phase 1 fixed `dates.json` freshness.)
- [ ] **3.3 Version probe → static-first.** Try `version.json`, fall back to `/data/version`.
- [ ] **3.4 Admin-safety guard.** Ensure the **admin editor still reads authoritative REST** for settings/dates (e.g. a `preferStatic=false` path when loading the full, save-bound payload), so the editor never saves from a stale snapshot. Public viewer uses static-first.
- _No-break / no-loss:_ every method already returns cached value on failure; static-first only adds a faster source before the identical REST call. Admin save path untouched.
- _Revert:_ flip each service back to REST-only (one line each).

---

## Phase 4 — Inline `initial-state.json` into `index.html` at publish (PHP + build)

> The decisive "zero API before first paint" step, and ~80% already built: `BootstrapStateService` reads `<script id="dn-initial-state">` and `NewspaperDataService` already seeds caches from it; the plugin already generates the blob.

- [ ] **4.1 Add an empty placeholder to `src/index.html`:** `<script id="dn-initial-state" type="application/json"></script>` (no executable JS → no CSP `unsafe-inline` needed; `type="application/json"` is inert).
- [ ] **4.2 Plugin injects the fresh blob on publish.** On every snapshot regeneration, atomically rewrite the served `index.html`, replacing the placeholder script's contents with the `initial-state.json` payload. Escape `</script>` sequences and write atomically (temp file + rename) so a partial write can never serve broken HTML.
- [ ] **4.3 Fallback proof.** If the placeholder is empty or the blob is malformed, `BootstrapStateService.read()` already returns `null` and the network boot path runs unchanged. Confirm this with a deliberately emptied placeholder.
- _No-break / no-loss:_ inline state only **seeds caches**; the version poll still validates and corrects. Admin route ignores it (admin loads full REST payload). If the HTML rewrite is skipped or fails, the app behaves exactly as today.
- _Revert:_ stop injecting (leave placeholder empty) — instant, no rebuild required.

---

## Phase 5 — Gate the initial granular fetches on fresh state (Angular)

> This is what turns "data already in the page" into "zero API calls on initial load." Depends on Phase 3 (correct static sources) and Phase 4 (inline blob present).

- [ ] **5.1 Skip the blocking boot fetches when state is fresh.** In `loadDataFromGranular()` (public `lightFirst` path only), when a valid inline `dataVersion` is present, **defer** the settings/dates/version/edition network calls instead of running them in the blocking `forkJoin`. Render immediately from seeded caches.
- [ ] **5.2 Revalidate off the critical path.** Trigger one `requestIdleCallback` (or rely on the existing 5-min version poll) to fetch `version.json`; only refetch settings/dates/edition if `dataVersion` changed. Reuse the existing `remoteDataChanged$` → `reloadCurrentDateOnly()` machinery.
- [ ] **5.3 Public-only guard.** Gating applies only to the public viewer's `lightFirst` load; the admin full-payload load is never gated.
- _No-break / no-loss:_ if no fresh inline `dataVersion` exists, the current blocking fetch path runs exactly as today. Updates are still caught by the poll, so readers never get stuck on stale content.
- _Revert:_ remove the freshness gate → unconditional fetch (today's behavior).

---

## Phase 6 — Service-worker precache of the static snapshots (Angular)

> Makes repeat visits truly zero-network and offline-capable. Uses the first-party `@angular/service-worker` already configured (not a third-party add-on).

- [ ] **6.1 Add a `dataGroups` entry to `ngsw-config.json`** for `wp-content/dn-static/**` (settings/dates/version/editions). Use a **freshness** strategy with a short network timeout (fast fallback to cache) so a publish is picked up but offline/slow networks serve cache instantly.
- [ ] **6.2 Invalidation alignment.** Confirm the version poll + post-save eviction still surface new content promptly with the SW layer in place (avoid serving stale beyond one poll cycle).
- _No-break / no-loss:_ SW only caches GET reads of immutable/owned files; writes and auth never touched. Worst case is one poll-cycle of staleness, then auto-refresh.
- _Revert:_ remove the `dataGroups` entry and bump SW version.

---

## Phase 7 — Final polish (Apache `.htaccess` + `index.html`)

- [ ] **7.1 Verify snapshot cache headers.** Keep `dn-static/*.json` on `no-cache, must-revalidate` (tiny 304s via Last-Modified) so correctness holds; the SW (Phase 6) provides the instant-paint layer.
- [ ] **7.2 `index.html` head hints.** Add `rel="preconnect"` to the WordPress origin and `rel="preload"` for the main JS bundle; ensure the `#app-splash` is dismissed the instant inline content paints.
- _No-break / no-loss:_ headers/hints only; no logic change.

---

## Phase 8 — Verification & regression sign-off (do not skip)

Test matrix on **staging** before prod, covering both `epaper` and `nepaper`:

- [ ] **8.1 Cold load** (DevTools → clear SW + cache, hard reload): confirm **0 WordPress REST calls** before first paint; content from inline + static only.
- [ ] **8.2 Warm load:** confirm 0 network data calls before paint (SW-served).
- [ ] **8.3 Publish test (no data loss / freshness):** publish/edit an edition, confirm readers see the update within one poll cycle, and `dates.json`/`version.json`/`initial-state.json` stay consistent.
- [ ] **8.4 Admin test:** editor still loads the full authoritative payload, saves succeed, no stale-overwrite, atomic save paths unaffected.
- [ ] **8.5 Navigation/UI regression:** date picker, edition switch, page thumbnails, article/image modals, mobile + desktop layouts, language (bn/en), ads, share buttons — all unchanged.
- [ ] **8.6 Offline test:** returning visitor loads last-seen edition from SW with no network.
- [ ] **8.7 Failure-mode test:** empty the inline placeholder and delete a snapshot file — app must fall back to REST with no error to the user.
- [ ] **8.8 Independent review:** run a verification pass (ideally a separate review agent) over the diff for correctness, security (HTML injection escaping, CSP), and no-regression before deploy.

---

## Suggested shipping order (smallest risk → biggest payoff)

1. Phase 1 (fix `dates.json`) — foundational bug fix.
2. Phase 3 (static-first settings/dates/version) — big cold-load win, low blast radius.
3. Phase 6 (SW precache) — zero-network repeat visits.
4. Phase 4 (inline state into HTML) — zero-API cold first paint.
5. Phase 5 (gate fetches) — completes "zero API on initial load."
6. Phase 7 (polish) + Phase 8 (verify) — sign-off.

Phases 1, 3, and 6 already deliver most of the perceived speed-up on their own; 4 + 5 finish the "no API calls on initial load" goal. Each can be deployed and validated before starting the next.
