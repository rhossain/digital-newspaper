# Static Snapshots & Data Inlining — Operator Wiring Guide

**Companion to:** `PERFORMANCE_OPTIMIZATION_STRATEGY.md`, `PERFORMANCE_TODO_IMPLEMENTATION.md`
**Date:** 2026-06-21

This guide covers the two steps that are **deliberately not shipped as live edits**, because they change request routing / homepage HTML and depend on your specific Apache/LiteSpeed + two-WordPress-install layout, which cannot be validated in a sandbox. Everything else (RUM, idle prefetch, Brotli, the Angular inline-state reader, and the snapshot *generator*) is already implemented in the codebase.

> **Golden rule:** apply each block on **staging** first, run the validation checklist, then promote. Every step here is reversible by deleting the block you added.

---

## What's already implemented (no action needed)

- **Angular** reads a publish-time inline blob if present and seeds its caches (`src/app/services/bootstrap-state.service.ts`, wired in `newspaper-data.service.ts`). Harmless no-op until the blob exists.
- **Web Vitals RUM** collects TTFB/FCP/LCP/CLS/INP with zero dependencies (`src/app/services/web-vitals.service.ts`), exposed on `window.__dnWebVitals`, logged on tab-hide. Off-device beaconing is opt-in.
- **Idle prefetch** of the previous day's edition (`newspaper.component.ts`).
- **Brotli** block added to `src/.htaccess` (guarded; safe).
- **Snapshot generator** in the plugin writes flat JSON to `wp-content/dn-static/` on every save — **feature-flagged OFF**.

---

## Step 1 — Enable snapshot generation (additive, low risk)

The plugin already contains `maybe_regenerate_static_snapshots()`. It is gated behind an option and does nothing until you turn it on.

**Enable (run once, e.g. in `wp shell` or a tiny mu-plugin):**

```php
update_option('dn_static_snapshots_enabled', true);
```

**Then publish any edition** (or re-save settings) and confirm the files appear:

```
wp-content/dn-static/settings.json
wp-content/dn-static/dates.json
wp-content/dn-static/version.json
wp-content/dn-static/editions/<YYYY-MM-DD>.json
wp-content/dn-static/initial-state.json
```

These are reachable at `https://epaper.dailysangram.com/wp/wp-content/dn-static/...`. At this point nothing about request handling has changed — you've only produced files. **Validate the JSON matches the live API** for the same date (diff `editions/<today>.json` against `/wp-json/digital-newspaper/v1/data/editions/<today>`). If anything looks wrong, set the option back to `false` and the files stop updating.

**Backfill existing dates** (optional, one-time): re-save each date, or add a small admin action that loops known dates calling the same generator.

---

## Step 2 — Serve snapshots as static files (the scalability win)

This is the routing change. It makes Apache serve today's edition JSON **without booting PHP/MySQL**, which is what lets the origin absorb traffic spikes.

### 2a. Add a rewrite in the **`/wp/` `.htaccess`** (the WordPress install that owns `/wp-json/`)

Place this **inside `<IfModule mod_rewrite.c>`, immediately after `RewriteBase /` and BEFORE WordPress's own `index.php` catch-all**:

```apache
# Serve prebuilt Digital Newspaper JSON directly from disk when present.
# PHP/MySQL is only touched on a cache miss (file not yet generated).
# The trailing -f test guarantees we never mask a missing snapshot.
RewriteCond %{DOCUMENT_ROOT}/wp/wp-content/dn-static/editions/$1.json -f
RewriteRule ^wp-json/digital-newspaper/v1/data/editions/(\d{4}-\d{2}-\d{2})/?$ /wp/wp-content/dn-static/editions/$1.json [L]

RewriteCond %{DOCUMENT_ROOT}/wp/wp-content/dn-static/dates.json -f
RewriteRule ^wp-json/digital-newspaper/v1/data/dates/?$ /wp/wp-content/dn-static/dates.json [L]

RewriteCond %{DOCUMENT_ROOT}/wp/wp-content/dn-static/settings.json -f
RewriteRule ^wp-json/digital-newspaper/v1/data/settings/?$ /wp/wp-content/dn-static/settings.json [L]

RewriteCond %{DOCUMENT_ROOT}/wp/wp-content/dn-static/version.json -f
RewriteRule ^wp-json/digital-newspaper/v1/data/version/?$ /wp/wp-content/dn-static/version.json [L]
```

> Adjust the `%{DOCUMENT_ROOT}/wp/...` prefix to match where WordPress physically lives. If `/wp/` is its own docroot, drop the `/wp` segment. Confirm the real path with a quick `RewriteRule` test or `phpinfo()` `DOCUMENT_ROOT`.

**Important — these rules only catch the pretty-permalink form** (`/wp-json/...`). The client also uses the `/?rest_route=/...` fallback form in places (see `activity-log.service.ts`); those continue to hit PHP, which is fine — they're not the hot read path.

### 2b. Set correct cache headers on the static dir

Add a `wp-content/dn-static/.htaccess`:

```apache
<IfModule mod_headers.c>
  # Apache auto-generates ETag/Last-Modified from file mtime, so conditional
  # GETs still produce 304s. no-cache forces revalidation, preserving the
  # plugin's "admins can correct past editions" guarantee — a regenerated file
  # gets a new mtime/ETag and the browser re-fetches.
  Header set Cache-Control "public, no-cache, must-revalidate"
</IfModule>
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE application/json
</IfModule>
```

This keeps the **exact freshness semantics** the PHP `editions` endpoint already enforces (`max-age=0, no-cache, must-revalidate` + ETag), while skipping PHP. The Angular HTTP cache interceptor's If-None-Match flow works unchanged — Apache answers the conditional request.

### 2c. Exclude static reads from the PHP rate limiter

No code change needed — static-served requests never reach PHP, so the limiter never sees them. Just confirm during load testing that spike traffic to `editions/<today>.json` returns 200/304 and is **not** 429'd.

### Validation checklist (Step 2)

- [ ] `curl -I https://.../wp-json/digital-newspaper/v1/data/editions/<today>` → 200, body matches PHP, served by Apache (no PHP `Set-Cookie`/`X-Powered-By`).
- [ ] Repeat with `If-None-Match` of the returned ETag → **304**.
- [ ] Correct a past edition in admin → its `editions/<date>.json` mtime changes → browser re-fetches (not stale).
- [ ] Request a date with **no** snapshot file → falls through to PHP, returns correctly (the `-f` guard).
- [ ] Social-crawler routing, `/admin`, `/wp-admin`, `/wp-login.php`, deep article URLs all still work.
- [ ] Load test `editions/<today>.json`: confirm PHP RPS drops and p95 TTFB falls vs the Phase-0 baseline.

**Rollback:** delete the rewrite block in 2a. Instant revert to the PHP path.

---

## Step 3 — Inline today's data into the homepage HTML (kills the first-visit spinner)

The Angular side is already done — it reads `<script id="dn-initial-state" type="application/json">…</script>` from the served HTML. You only need to **populate** that script tag. Pick ONE mechanism:

### Option A (recommended, no Node at runtime): PHP-rendered homepage

Route `/` to a tiny PHP shim that reads the prerendered shell and injects `initial-state.json` once. Because the file is regenerated on every publish, the homepage is always current without a per-request DB read.

Sketch (in a small mu-plugin or the theme, served for the root URL only):

```php
// Pseudocode — adapt paths to your docroot.
$shell = file_get_contents($docroot . '/index.html');           // prerendered shell
$state = file_get_contents($docroot . '/wp/wp-content/dn-static/initial-state.json');
if ($shell && $state) {
  $tag = '<script id="dn-initial-state" type="application/json">' . $state . '</script>';
  // Inject right before </head> (or before <app-root>).
  echo str_replace('</head>', $tag . '</head>', $shell);
  exit;
}
// else: fall through to the static index.html unchanged.
```

Then in the **root `.htaccess`**, route `/` to this shim **only for non-crawler GETs** (the social-bot block already exits earlier with `[L]`). Keep the existing `index.html` → `index.csr.html` fallback as the safety net if the shim is disabled.

> This puts a *single, file-only* PHP read in front of the homepage HTML (no MySQL). Under spike load you can additionally let LiteSpeed page-cache the shim output for ~60s.

### Option B (no runtime PHP at all): bake at publish via the existing webhook

Your `webhook-server.js` + SFTP deploy already exist. On the publish webhook, have the job read `initial-state.json`, inject the `<script>` into `index.html`, and upload it. Pure static at request time; freshness bounded by how reliably the webhook fires on publish.

### Validation checklist (Step 3)

- [ ] View-source the homepage → `<script id="dn-initial-state">` present with today's editions.
- [ ] Cold load with empty cache + SW unregistered → today's content paints with **no spinner**; DevTools shows **no** `editions/<today>` XHR before first paint.
- [ ] `window.__dnWebVitals` LCP improved vs baseline.
- [ ] Publish a correction → within ≤5 min the version poll refreshes the open page (`reloadCurrentDateOnly`).
- [ ] Disable the shim/bake → site still works via `index.html`/`index.csr.html` (fallback intact).

**Rollback:** point `/` back at `index.html`. The Angular reader silently returns to the network path.

---

## Optional — Enable field RUM beaconing later

Once you have a validated, **file-logging** (not DB-writing) collection endpoint, enable sampled beaconing by setting, before the app bundle loads:

```html
<script>
  window.__dnVitalsBeaconUrl  = '/wp/wp-json/digital-newspaper/v1/rum'; // your endpoint
  window.__dnVitalsSampleRate = 0.05; // 5% of sessions
</script>
```

Keep sampling low and **never** write RUM to `wp_options`/MySQL per pageview — that would reintroduce the write hotspot Step 2 just removed. A rotated file or a dedicated table with batched inserts is fine. Until then, `console.info('[WebVitals] …')` + `window.__dnWebVitals` give you the baseline.
