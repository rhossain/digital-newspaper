# Demo / Showcase Mode — Implementation Progress

Tracks work against `DEMO_MODE_TODO.md`.
Server: `wordpress-plugin/digital-newspaper/digital-newspaper.php`.
Client: `src/` (Angular).

Everything is gated behind the default-OFF `dn_demo_mode_enabled` option and, on
the client, `environment.demo`. With the flag off and no demo build, behaviour is
byte-for-byte identical to before.

---

## ✅ Phase 1 — Storage overlay + write-block guard (server)

Transparent copy-on-write overlay via WordPress option filters (no read-site
edits); data-key *writes* routed through `dn_get`/`dn_set`/`dn_delete`.
Helpers: `dn_demo_session_id` (32-hex header validation, reentrancy-guarded),
`dn_demo_active`, `dn_session_key`, manifest, `demo_filter_pre_option`,
`demo_guard_pre_update_option` (blocks real data + config keys). Deletes use
tombstones. Global side-effects (snapshot regen, section-post sync, migration
marker) disabled in demo. Admin toggle on the settings page.

## ✅ Phase 2 — Ancillary scoping (server)

- **Locks (§2.1):** `lock_transient_key` namespaced by session token; lock index
  session-scoped; force-release disabled in demo (§2.5).
- **Activity log (§2.2):** writes go to a per-session transient log
  (`log_activity`, `log_client_batch`); `list_activity_log` reads it with full
  filter/sort/paginate; `clear_activity_log` clears only the session log. Real
  `dn_activity_log` table is never touched.
- **Import/save cap (§2.3/§7.6):** `post_data_endpoint_inner` enforces demo caps
  (30 editions / 400 pages / 4000 sections / 8 MB) → 413.
- **Destructive endpoints (§2.5):** config writes blocked by the guard; restore
  and backups operate on session data automatically (they read/write through the
  overlay); force-release blocked.

## ✅ Phase 2A — Demo authentication (scoped demo token)

- Fixed login `demo` / `demo1234` (constants). While demo mode is on, `login`
  mints a **demo-scoped JWT** (`demo:true`, `sub:0`) — no real WP account.
- `authenticate_rest_request` / `auth_required` accept it **only while demo mode
  is enabled** (rejected on non-demo builds, §2A.4).
- `demo_grant_caps` (a `user_has_cap` filter) grants just `manage_options` +
  content caps for the request and **hard-denies** user/plugin/theme management.
- `me()` and `log_auth_user_action` report/log the demo identity.

## ✅ Phase 3 — Client (Angular)

- `environment.demo.ts` + `angular.json` `demo` config + `build:demo` /
  `serve:demo` scripts. **Point `wpBaseUrl` at the isolated demo WP install.**
- `DemoService`: per-tab `sessionStorage` token (§3.2), override-gating (§3.8),
  unload beacon (§3.5), `reset()` (§4.2).
- `wp-api.interceptor`: attaches `X-DN-Demo-Session` — **gated** so a clean
  session sends no header on public reads (stays CDN-shareable); edited sessions
  attach it and reconcile (§3.3/§3.8).
- Caches session-aware: IndexedDB namespaced per token; in-memory HTTP cache key
  namespaced for edited sessions (§3.4/§3.7).
- `DemoBannerComponent`: persistent banner, credentials, "Reset my demo",
  "Buy now" CTA (§3.6). Bootstrapped in `AppComponent`.

## ✅ Phase 4 — Lifecycle & cleanup (server)

- `DEMO_TTL` (3 h) on every session transient, refreshed on write (§4.1).
- `GET /demo/status`, `DELETE /demo/session` (header **or** `?sid=` beacon),
  idempotent; destroys manifest transients, session log, session locks, and
  session media (§4.2).
- Hourly `dn_demo_cron_sweep` removes expired demo transients + orphaned demo
  media (§4.3).
- **TODO (ops, §4.4):** curate the golden seed on the demo install and check in a
  JSON export for re-seeding — content task, not code.

## ✅ Phase 7 (partial) — Media handling (§7.1, top priority)

Session-tagged uploads (7.1b): per-session cap (25), `_dn_demo_session` post
meta, swept on session destroy + cron; `list_media` hides other sessions'
uploads; `delete_media_item` restricted to the session's own uploads.

---

## Verification done here
- Whole plugin parses with **no syntax errors** (php-parser AST; sandbox has no PHP).
- 19-assertion overlay simulation passes (flag-off parity, copy-on-write,
  two-session isolation, tombstones, config write-block).
- `ng build --configuration demo` **succeeds** (AOT templates compiled).

## ⛔ You must do on the isolated demo/staging host (§6, §7)
1. `php -l` on the plugin (real PHP version).
2. **Flag-OFF regression (§6.1):** with the box unchecked + a normal build,
   confirm admin + frontend are unchanged. **Gate before production.**
3. **Two-browser isolation, ephemerality, feature matrix (§6.2–6.5).**
4. **§7.3/§7.4/§7.7:** isolated WP+DB, no deploy secrets in the demo build,
   `noindex` the demo host, GAM/analytics in test mode.
5. Curate the seed (§4.4/§8.1) and set `wpBaseUrl` in `environment.demo.ts`.

## Not yet built (optional polish)
- §8.2 guided tour, §8.5 visible perf proof, §2A.2 auto-fill "Log in as demo"
  button on the login screen (banner already shows the credentials).
