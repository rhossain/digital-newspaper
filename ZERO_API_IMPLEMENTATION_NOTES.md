# Zero-API Initial Load — Implementation Notes

_What was changed, how to turn it on, and what to verify. Companion to `INITIAL_LOAD_API_ANALYSIS.md` and `ZERO_API_INITIAL_LOAD_TODO.md`._

All changes are **additive and backward-compatible**. With the new feature flags OFF (their default), behaviour is identical to before. No data migration, no UI change, no breaking change.

## Files changed

1. **`wordpress-plugin/digital-newspaper/digital-newspaper.php`**
   - **Phase 1 — resilient snapshot regeneration.** `regenerate_static_snapshots()` now isolates each date's edition write in its own `try/catch`, so one malformed edition can no longer abort the run and leave `initial-state.json` out of sync with `dates.json` (the live inconsistency observed on staging). Critical index files (`settings/dates/version/initial-state`) now report write failures to the error log.
   - **Phase 4 — inline bootstrap injection.** New opt-in flag `dn_inline_index_enabled` (default OFF) plus optional `dn_index_html_path`. On publish, when enabled and a writable `index.html` containing the placeholder is found, the plugin rewrites `<script id="dn-initial-state">` with the current `initial-state.json` (safe `</script>` escaping, atomic temp-file+rename). Auto-detects the `index.html` path from the docroot / WordPress install; overridable via the setting or the `dn_index_html_path` filter. Disabling the flag blanks the inlined blob. New controls added to the existing settings page.

2. **`src/index.html`** — added one inert placeholder before `<app-root>`:
   `<script id="dn-initial-state" type="application/json"></script>`. Harmless when empty; the app boots normally.

3. **`src/app/services/settings.service.ts`** — `fetch(preferStatic = false)`. Public viewer reads `wp-content/dn-static/settings.json` first, REST fallback. Admin keeps authoritative REST.

4. **`src/app/services/date-index.service.ts`** — `fetch(preferStatic = false)`, same static-first/REST-fallback pattern against `dates.json`.

5. **`src/app/services/newspaper-data.service.ts`**
   - Version probe is static-first (`version.json`) on the public path; admin stays REST.
   - `loadDataFromGranular()` passes `preferStatic = lightFirst` to settings/dates/version.
   - **Phase 5 — zero-API gate.** When a complete inline blob was present (seeded in the constructor), the public initial load emits that data directly and **skips the blocking settings/dates/version/edition network batch** — zero API calls before first paint. A one-shot, idle-time `scheduleInlineRevalidation()` checks `version.json` and refreshes via the authoritative reload path only if the server is newer; the existing 5-minute version poll remains the ongoing safety net. The gate is public-only and consumed once.

6. **`ngsw-config.json`** — **Phase 6.** Added `dataGroups` for `wp-content/dn-static/**` (settings, dates, version, initial-state, editions) with a `freshness` strategy and short network timeouts, so repeat visits serve instantly from the service-worker cache and work offline.

## How the pieces combine

- **First-ever / SW-cold visit, inline ON:** content arrives inside the HTML → 0 API calls before paint.
- **First-ever visit, inline OFF (default):** 3 static-file reads (`settings/dates/version.json`, Apache, no PHP) + 1 static edition — no WordPress PHP on the read path.
- **Returning visit:** service worker serves shell + data from cache → 0 network before paint; revalidate in background.
- **Correctness:** the version poll + the one-shot inline revalidation refresh any stale static/inline data; the admin editor always reads authoritative REST, so saves never persist stale data.

## How to enable (staging first)

1. WordPress admin → Digital Newspaper Settings:
   - Tick **Static JSON Snapshots** (if not already on).
   - Click **Regenerate snapshots now** (this also repairs the stale `dates.json`).
2. Deploy the rebuilt Angular app (`npm run build:staging`) so the new `index.html` placeholder, services, and `ngsw-config` ship. **A new build is required** — the sandbox here could not run the full SSR bundle to completion, so run it on your machine/CI.
3. (Optional, for true zero-API cold paint) tick **Inline Bootstrap State**. Confirm the "index.html status" line shows a writable placeholder was found; if not, set the absolute `index.html` path. Publish once to fill the blob.

## Verification checklist (run on staging before prod)

- [ ] `npm run build:staging` completes clean (the only check not run here — sandbox was too slow for the full SSR bundle; `tsc` typecheck passed).
- [ ] **Cold load** (DevTools → Application → clear storage + unregister SW, hard reload): with inline ON, 0 WordPress REST calls before first paint; with inline OFF, only static `dn-static/*.json` reads (no `/wp-json/...`).
- [ ] **Warm/return load:** 0 data network calls before paint (SW-served).
- [ ] **Publish test:** edit/publish an edition → `dates.json`, `version.json`, `initial-state.json` all reflect the new latest date; readers update within one poll cycle (or immediately via the inline revalidation).
- [ ] **Admin test:** editor loads the full authoritative payload, saves succeed, no stale overwrite.
- [ ] **UI regression:** date picker, edition switch, thumbnails, article/image modals, mobile + desktop, bn/en, ads, share — unchanged.
- [ ] **Offline:** returning visitor loads last edition from SW with no network.
- [ ] **Failure-mode:** empty the placeholder / delete a snapshot file → app falls back to REST, no user-visible error.

## Rollback (each independent)

- Inline injection: untick **Inline Bootstrap State** (blanks the blob immediately; no rebuild needed).
- Static-first reads / gate: revert the three service files (each method falls back to REST-only).
- SW precache: remove the `static-*` `dataGroups` and bump the SW.
- Snapshot resilience (Phase 1) is a pure bug fix with no flag.
