# Demo / Showcase Mode — Implementation TODO

**Goal:** Let buyers try the full frontend + admin with *real* save behaviour, but every buyer's
edits are private to their browser session and are destroyed when they leave. The real newspaper
data (production options) is never touched.

**Core design:** Per-session, copy-on-write overlay over the existing storage layer, gated behind a
single opt-in flag. When the flag is OFF the codebase behaves **byte-for-byte identically** to today.

---

## 0. Guiding principles (read first)

1. **Opt-in, default OFF.** New flag `dn_demo_mode_enabled` (option) + `environment.demo` (Angular).
   Follow the existing pattern of the perf flags (`dn_static_snapshots_enabled`, etc.). If the flag
   is off, none of the new code paths execute. This is the single most important guarantee that no
   existing data/feature/functionality breaks.
2. **Never write to production option keys in demo mode.** All writes are redirected to
   session-namespaced keys. Add a defensive guard that hard-blocks writes to the real keys when a
   demo session is active.
3. **Copy-on-write, not copy-up-front.** Do NOT clone the whole dataset per buyer (editions can be
   large). Reads fall through to the real/seed data; only *changed* keys get a session copy.
4. **Ephemeral by construction.** Session token lives in `sessionStorage` (dies on tab/browser
   close) + server-side transients with a TTL + an unload beacon + a cron sweep. Belt and braces.
5. **Staging first.** Validate on staging with the flag ON before any production exposure. Confirm
   flag-OFF regression (production untouched) on every build.

---

## 1. Storage model (server / `digital-newspaper.php`)

Current authoritative storage (must all be covered by the overlay):
- `dn_data_index` (`OPTION_INDEX`) — date index
- `dn_edition_<date>` (`OPTION_EDITION_PREFIX` + date via `edition_option_key()`)
- `dn_settings` (`OPTION_SETTINGS`)
- `dn_data_backups` (`OPTION_BACKUPS`)
- `dn_data` (`OPTION_KEY`) — legacy blob / fallback
- `dn_activity_log` — activity log

### Tasks
- [ ] **1.1 Session token helper.** `dn_demo_session_id()`:
  - Read token from request header `X-DN-Demo-Session`.
  - Sanitize with a strict regex (e.g. `^[a-f0-9]{32}$`) and length cap — reject/ignore anything else
    (reuse the discipline of `sanitize_lock_resource()`).
  - Returns `''` when not in demo mode or header absent → callers treat as "no session".
- [ ] **1.2 Demo-active predicate.** `dn_demo_active()` = `dn_demo_mode_enabled` option is true
    **AND** a valid session token is present. Everything below keys off this.
- [ ] **1.3 Namespaced key resolver.** `dn_session_key(string $realKey): string`
    → `"dn_demo_{token}_{realKey}"`. Central — used everywhere data keys are read/written.
- [ ] **1.4 Copy-on-write READ wrapper.** `dn_get(string $realKey, $default)`:
    - If `dn_demo_active()`: if the session key exists → return it; else return `get_option($realKey)`
      (the golden/production value) **without** writing anything.
    - Else: plain `get_option($realKey, $default)`.
- [ ] **1.5 Copy-on-write WRITE wrapper.** `dn_set(string $realKey, $value)`:
    - If `dn_demo_active()`: `set_transient(dn_session_key($realKey), $value, DEMO_TTL)` and record the
      key in the session manifest (see 1.6). **Never** call `update_option($realKey)`.
    - Else: existing `update_option($realKey, ..., autoload=false)` behaviour, unchanged.
- [ ] **1.6 Session manifest** `dn_demo_{token}__keys` (transient): list of session keys written, so
    cleanup can delete them all. Refresh its TTL on every write.
- [ ] **1.7 Route existing storage calls through the wrappers.** Replace the direct
    `get_option`/`update_option` calls **for data keys only** (index, editions, settings, backups,
    legacy blob) with `dn_get`/`dn_set`. Do **not** touch plugin-config options (CORS, GAM, snapshot
    flags, index-html path, etc.) — those must stay global and are covered by the write-block in 1.8.
    Grep targets: `edition_option_key(` sites, `OPTION_INDEX`, `OPTION_SETTINGS`, `OPTION_BACKUPS`,
    `OPTION_KEY` read/write sites.
- [ ] **1.8 Defensive write-block.** In demo mode, a low-level guard that refuses `update_option()`
    on any production data key or plugin-config key (returns success-shaped response but no write),
    so a missed call site can never mutate real data. Log to error_log for detection during QA.
- [ ] **1.9 dataVersion / conflict guard.** Keep it — it works per-session unchanged. Ensure the demo
    seed carries a `dataVersion` so the first session save doesn't 409. (`get_data()` already stamps
    one if absent — verify this runs on the session copy.)

> **Storage backend note:** transients may hit object-cache value-size limits (e.g. Memcached ~1 MB)
> if a single edition is very large. Because we're per-date (not the ~30 MB monolith) this is usually
> fine. If an edition exceeds the limit in staging, fall back to a dedicated custom table
> (`wp_dn_demo_sessions`: token, key, value LONGTEXT, expires) instead of transients. Decide after
> measuring on staging — don't pre-optimise.

---

## 2. Ancillary features (server)

- [ ] **2.1 Page locks.** Namespace the lock resource with the session token in demo mode
    (`{token}:{resource}`) so buyers never collide on the same lock, and a buyer can still demo the
    two-tab lock banner within their *own* session. Reuse `sanitize_lock_resource()`.
- [ ] **2.2 Activity log.** In demo mode write to a session-scoped transient log
    (`dn_demo_{token}_activity`) and read from it; never append to the real `dn_activity_log`. The log
    demo then shows the buyer's own actions and stays clean.
- [ ] **2.3 Import (bulk XML).** Already goes through the data write path → will land in the session
    overlay automatically once 1.7 is done. Add a size/row cap for demo to prevent abuse.
- [ ] **2.4 Export-full.** Reads through `dn_get` → naturally exports the session's data. No change
    beyond 1.4.
- [ ] **2.5 Block global/destructive endpoints in demo.** Return a friendly "disabled in demo"
    response for: restore-from-real-backup into production, clearing the *real* activity log,
    force-release of *other* sessions' locks, plugin-settings writes (CORS/GAM/snapshot toggles/
    index-html path), and any deploy/webhook trigger. (These are the irreversible ones.)

---

## 2A. Demo authentication (login credentials)

Admin auth today: `/auth/login` → `wp_authenticate()` → requires `manage_options` → issues a Bearer
token stored in `localStorage` (`dn_wp_token`). Key point: **login can be shared** — isolation comes
from the per-session *data* token (§3.2), not the account. Everyone logs in as `demo`; each tab still
gets its own private, ephemeral overlay.

- [ ] **2A.1 Auth strategy — pick one (recommended: scoped demo token).**
  - **Recommended — scoped demo token, no real admin account:** in demo mode, `login()` accepts the
    fixed demo credentials and mints a demo-scoped Bearer token *without* a real `manage_options`
    user. Token grants access only to the session overlay; global/destructive ops already blocked by
    §1.8 + §2.5. Safest — no privileged WP account exists to abuse.
  - **Alt — dedicated locked-down WP user:** real `demo` user with a custom `dn_demo_admin` role that
    just passes the `manage_options` check, hardened so it can't change its own password/email, toggle
    demo mode, edit plugin settings, or create users. Simplest on top of existing `wp_authenticate`.
  - **Avoid — full WP admin named `demo`:** only acceptable on a throwaway isolated WP install.
- [ ] **2A.2 Frictionless login UX.** Show credentials on the login screen (`demo` / `demo1234`) and a
    "Log in as demo" button that auto-fills + submits. Buyers shouldn't type.
- [ ] **2A.3 Harden the public login endpoint.** Rate-limit `/auth/login` (reuse existing
    retry/rate-limit logic) so the well-known demo password can't be used to brute-force; rotate the
    password periodically; keep the demo user's capabilities minimal.
- [ ] **2A.4 Bind auth to the data session.** The `localStorage` auth token (admin access) and the
    `sessionStorage` demo data token (§3.2, per-tab, ephemeral) are separate — ensure logout / tab
    close clears both, and that a demo token can't be replayed against a non-demo build.

## 3. Client (Angular)

- [ ] **3.1 Demo build config.** Add `environment.demo.ts` (`demo: true`) + an `angular.json`
    `demo` configuration + `serve:demo` / `build:demo` scripts. Production/staging builds unchanged.
- [ ] **3.2 Session token bootstrap.** On app start in demo mode: read `sessionStorage['dn_demo_sid']`;
    if absent, generate a 32-hex token (crypto random) and store it. `sessionStorage` is per-tab and
    cleared on tab/browser close → satisfies "destroyed after closing the browser".
- [ ] **3.3 Inject header in `wp-api.interceptor.ts`.** When `environment.demo`, add
    `X-DN-Demo-Session: <token>` to every WP API request. This is the only client change to the API
    layer and it's additive (a header), so non-demo builds are untouched.
- [ ] **3.4 Frontend read path — keep performance, make data caches session-aware.**
    Do **not** disable the perf stack. Instead:
    - Namespace client caches (`idb-cache.service`, `http-cache.interceptor`) by session token so
      repeat-load speed is real *within* a session but never leaks across buyers.
    - Keep static snapshots ON (generated from the golden seed): a cold/first visit gets the full
      snapshot speed. If the session has overrides, the app does a small live fetch for the *changed*
      per-date keys and reconciles on top of the instant paint. Un-edited buyers pay nothing.
    - For the ngsw **data** group: either vary its cache by a token query-param or skip just that
      group in demo and rely on the token-namespaced IDB/http-cache for repeat speed. Keep the ngsw
      **asset + image** groups ON globally (shared, safe).
    - See the Performance-parity section (§3.7) for the full ON/session-aware split.
- [ ] **3.5 Unload beacon.** On `beforeunload`/`pagehide`, `navigator.sendBeacon` a
    `DELETE /demo/session` (reuse the existing `releaseOnUnload` pattern from `LockService`) to
    proactively destroy the server-side session. TTL is the backstop if the beacon is missed.
- [ ] **3.6 Demo UX.** Persistent banner "Demo mode — your changes are private and reset when you
    leave", on-screen demo credentials, a "Reset my demo" button (calls 4.2), and a "Buy now" CTA.
    Hide the admin controls blocked in 2.5.
- [ ] **3.7 Performance parity — buyers must feel the *real* site speed.**
    Sort every perf feature into two buckets; keep bucket A ON, make bucket B session-aware. Never
    turn a perf feature fully OFF for demo.

    **Bucket A — keep fully ON (content-neutral, identical perf for every visitor):**
    - SW image cache for `/**/wp-content/uploads/**` (`ngsw-config.json` `wp-edition-images`).
    - Immutable upload cache headers (`dn_uploads_cache_headers_enabled`).
    - Gzip/Brotli compression (`compress-dist.js`) + CDN-served JS/CSS bundles.
    - LCP image preload (`dn_preload_lcp_enabled`) — seed's first page is shared until edited.
    - ngsw **asset** group (app-shell JS/CSS).

    **Bucket B — keep ON but session-scoped (bakes *data* in → must not leak):**
    - Static HTML snapshots — served from golden seed for instant cold paint; live reconcile only for
      a session's edited per-date keys (see §3.4).
    - ngsw **data** group + `http-cache.interceptor` + `idb-cache.service` — namespace by token.

    Result: cold browsing = real snapshot/CDN/preload speed; repeat loads = real cache speed per
    session; admin edits still reflect. Same performance, same features, edits stay private.
- [ ] **3.8 Load-time parity — keep the demo as fast as production.**
    Note: demo data lives in **server-side session transients**, not the browser; only the token is in
    `sessionStorage`. Load-time delta by case:
    - *Un-edited session / pure browsing:* **identical** to production — same snapshot, preload, CDN,
      image cache; reads fall through to the seed, no extra fetch.
    - *Pages the buyer has edited:* one small per-date reconcile fetch on next load (tens–low-hundreds
      ms, changed pages only), then client-cached. Not the whole dataset, not every page.
    - **Gate the session header + live-reconcile behind "session has overrides."** A clean session
      sends no session header on the public read endpoints (`/data/settings`, `/data/dates`,
      `/data/editions/:date`) so the CDN can still share-cache them exactly as in production. Only
      sessions with edits attach the header and pay the reconcile cost — on their changed pages only.
    - **Stale-while-revalidate reconcile:** paint the seed snapshot instantly, fetch the session
      version in the background, swap it in on arrival → perceived load time matches production even on
      edited pages. The only real delta is a background fetch on pages the buyer changed.

---

## 4. Lifecycle & cleanup (server)

- [ ] **4.1 TTL constant** `DEMO_TTL` (e.g. 2–3 h) applied to every session transient; refreshed on
    each write so an active session never expires mid-use.
- [ ] **4.2 `DELETE /demo/session` endpoint.** Reads the manifest (1.6), deletes every session
    transient + the manifest + session locks + session activity log. Idempotent. Also used by the
    "Reset my demo" button (which then re-seeds by simply clearing overrides → reads fall back to the
    golden seed).
- [ ] **4.3 wp-cron sweep.** Hourly job deleting expired/orphaned `dn_demo_*` transients as a
    backstop against missed beacons. Cap total concurrent demo sessions if needed.
- [ ] **4.4 Golden seed.** Curate the demo dataset once (fictional paper, 2–3 editions, real-looking
    articles) as the normal production options on the demo site. Because reads fall through to these,
    they *are* the seed — no separate copy needed. Keep a JSON export checked in for re-seeding.

---

## 5. Risks & gotchas (specific to this codebase)

- **Static snapshots + service worker** (`index.csr.html`, `ngsw-config.json`): the perf stack stays
  ON so buyers feel the real speed — but the *data-bearing* layers (snapshots, ngsw data group, HTTP/
  IDB client caches) must be session-aware, or they'll *hide* a buyer's edits / leak across buyers.
  See §3.4 + §3.7 for the ON vs session-scoped split. Verify the served entry file behaviour noted in
  the repo (`index.csr.html`, not `index.html`). Confirm the live-reconcile-after-edit path so a
  buyer's changes appear on the frontend without sacrificing cold-load speed.
- **Config vs data options:** only *data* keys get the overlay; *config* keys stay global and are
  write-blocked in demo (§1.8). Don't accidentally namespace CORS/GAM/snapshot flags — that would
  break the demo site itself.
- **Object-cache size limits** for large editions in transients — measure on staging, fall back to a
  custom table if needed (§1 note).
- **Auth:** buyers need an admin session to reach the admin. Use a dedicated low-privilege demo WP
  user; ensure demo mode can't be toggled off or plugin settings changed by that user.
- **Concurrency:** many simultaneous buyers = many transients. TTL + cron sweep + optional session
  cap keep it bounded.

---

## 6. Verification (staging-first — do all before production)

- [ ] **6.1 Flag-OFF regression:** with `dn_demo_mode_enabled` OFF, confirm reads/writes hit the real
  options exactly as before (diff behaviour vs current build; production data untouched).
- [ ] **6.2 Two-browser isolation:** edits in browser A never appear for browser B; both differ from
  the golden seed; real options unchanged after both sessions.
- [ ] **6.3 Ephemerality:** close tab → beacon fires → session transients gone; and without the
  beacon, transients expire after TTL; cron sweep removes orphans.
- [ ] **6.4 Feature coverage in demo:** save + conflict guard, page-lock two-tab banner, bulk XML
  import, export-full, activity log — all operate on session data only.
- [ ] **6.5 Frontend reflects session edits** with the perf stack ON: cold visit gets full snapshot/
  CDN/preload speed on seed content, and after an edit the changed pages reconcile live — while real
  frontend/production stays unaffected. Measure demo load times ≈ real-site load times (§3.7).
- [ ] **6.6 `php -l`** on the plugin + Angular `build:demo` succeed; no new console/network errors.
- [ ] **6.7 (High-stakes) code review pass** focused on: any un-wrapped data write, any config key
  accidentally namespaced, and the write-block guard actually firing.

---

## 7. Security review (demo-specific)

**Already hardened in the plugin (verify still true, don't rebuild):** `/proxy` restricts remote
fetch to an own-domain allowlist (`dn_proxy_allowed_hosts`) — not an open SSRF; `/media` caps at
10 MB with content-based MIME validation (JPEG/PNG/GIF/WebP only); `/auth/login` has per-IP
brute-force limiting (5/10 min) and there's a public-GET rate limiter (`check_public_get_rate_limit`).

**Demo-specific gaps to close:**
- [ ] **7.1 Uploaded media are NOT ephemeral (top priority).** The session overlay covers *data
    options only*. Files uploaded via `/media` persist in `wp-content/uploads` permanently, shared
    across sessions, surviving cleanup. Risks: disk fill, orphaned files, and — serious — a public
    login lets anyone host arbitrary/abusive/illegal images on your domain. **Fix (pick one):**
    (a) *Recommended:* disable uploads in demo; buyers pick from a pre-seeded media library.
    (b) Allow uploads but tag each file with the session token, cap count/session, sweep on
    session-cleanup + cron, and adopt a content-moderation posture.
- [ ] **7.2 Known public password.** Rate limit protects volume, not post-login abuse. Keep the demo
    user's caps minimal and destructive actions blocked (§2A, §2.5). Rotate the password periodically.
- [ ] **7.3 No secrets in the demo build.** Audit `environment.demo` + the JS bundle for real deploy
    creds, webhook secrets, ad/GAM IDs, API keys. Ensure deploy tooling (`webhook-server.js`,
    `auto-deploy.sh`, deploy configs) is NOT reachable/enabled on the demo host.
- [ ] **7.4 Isolated install.** Run the demo on a separate WordPress + DB so nothing there can reach
    production data or credentials.
- [ ] **7.5 Unguessable tokens.** Session data token = crypto-random 32-hex (so no buyer can read/
    write another's overlay by guessing the key). Demo Bearer token must be scoped + unforgeable, and
    rejected by non-demo builds (§2A.4).
- [ ] **7.6 Abuse/DoS caps.** Cap XML-import size/rows; cap concurrent sessions; keep public
    image-gen endpoints (`/section-crop`, `/social-image`, `/social-thumb`) behind the existing rate
    limiter. Monitor disk + transient count on the demo host.
- [ ] **7.7 noindex + analytics isolation.** `noindex` the demo (robots + meta) so fake content and
    the downloadable frontend bundle aren't indexed/scraped as a free product; keep GAM/analytics in
    test mode so demo traffic doesn't pollute reporting.
- [ ] **7.8 Restore/backups scoped.** Confirm `/data/restore` in demo only restores *session*
    backups, never production (overlay §1 + block §2.5).

## 8. Other (non-security) considerations

- [ ] **8.1 Seed content quality** — the single biggest sales lever; make it look like a real paper.
- [ ] **8.2 Guided tour / tooltips** on first load (Shepherd.js / Intro.js).
- [ ] **8.3 Mobile responsiveness** of the demo verified.
- [ ] **8.4 Showcase i18n / language switching** (`translation.service.ts`).
- [ ] **8.5 Visible perf proof** — a "loaded in X ms" or cold-vs-warm moment to sell the speed.
- [ ] **8.6 Reliable "Reset my demo"** + clear expiry messaging.
- [ ] **8.7 Monitoring/alerting** on the demo host (disk, error log, session count).
- [ ] **8.8 Conversion path** — prominent "Buy now / contact sales" + short demo disclaimer/ToS.

---

## 9. Buyer requirements → design mapping (must-haves)

**R1 — Master demo data must never be lost or changed.** Guaranteed by copy-on-write: all data
writes redirect to session transients; real/seed options are read-only reference; `update_option` on
data keys is hard-blocked in demo (§1.4, §1.5, §1.8). The seed is untouchable.

**R2 — Every user sees their own version; no cross-overwrite.** Guaranteed by per-tab crypto-random
token (§3.2) + token-namespaced keys (§1.3): two buyers read/write different option keys, so neither
can see or overwrite the other. `dataVersion` conflict guard adds a second layer within a session.

**R3 — Maximum admin features testable.** Rule: anything that writes *data* stays functional on the
session overlay; only *global config* + *irreversible* actions are blocked.

### Admin feature test matrix

| Admin area | Demo behaviour |
|---|---|
| Content: dates/editions, create/edit pages | ✅ session-scoped |
| Section define + crop (`/section-crop`) | ✅ session-scoped |
| Rich-text article editing (Quill), captions | ✅ session-scoped |
| Save (conflict guard + loader) | ✅ session-scoped |
| Page locking (two-tab live demo) | ✅ session-namespaced resource (§2.1) |
| Activity log: view / filter / CSV export | ✅ session log (§2.2) |
| Theme switch (Settings) | ✅ session-scoped |
| Bulk XML import | ✅ session-scoped, size/row capped (§2.3, §7.6) |
| Export-full download | ✅ reads session data (§2.4) |
| Backups: create + restore | ✅ session only, never prod (§7.8) |
| Rebuild-from-sections | ✅ session-scoped |
| **Media upload** | ✅ **enable session-tagged + swept (§7.1b)** — keep testable |
| **Ads / GAM config** | ✅ **session-scoped or test-mode** — preview without real ad serving |
| CORS / origins / domain aliases | 🚫 global config — blocked (§2.5) |
| Perf flags (snapshots/preload/cache/inline) | 🚫 global config — blocked |
| index-html path, deploy/webhook triggers | 🚫 irreversible — blocked |
| Clear the *real* activity log | 🚫 blocked (session log only) |
| Force-release *other* sessions' locks | 🚫 blocked |
| Toggle demo mode / plugin settings | 🚫 blocked (demo user lacks caps) |

> **Decision flipped for R3:** because buyers should test as much as possible, prefer **§7.1b
> (uploads enabled, session-tagged + swept)** over disabling uploads, and run **Ads/GAM session-scoped
> or in test mode** rather than hiding them. Both keep core features testable while staying isolated.

---

## Suggested sequencing

1. §1 storage overlay + §1.8 guard (the foundation; nothing else is safe without it)
2. §6.1 flag-OFF regression check (prove no breakage before going further)
3. §7.1 media handling decision (uploads off or session-tagged) — do early, it's the main gap
4. §2 ancillary scoping
5. §3 client wiring
6. §4 lifecycle/cleanup
7. §7 security review + §6 full verification on staging → then production demo host
