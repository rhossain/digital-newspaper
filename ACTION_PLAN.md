# Digital Newspaper — Action Plan

**Derived from:** [`CODEBASE_REVIEW.md`](./CODEBASE_REVIEW.md) and [`SEO_PERFORMANCE.md`](./SEO_PERFORMANCE.md) (15 Aug 2026)
**Status:** nothing here is implemented. This is the ordered backlog.

**How to read this.** Items are grouped P0–P4 by *urgency*, not by area. Within a group, the order given is the order to do them in — several have hard dependencies marked **⚠ blocked by**. `S` ≈ under an hour, `M` ≈ a day, `L` ≈ a week or more.

Every item carries a **Done when** line. If you can't tick it, the item isn't finished.

---

## Priority key

| | Meaning |
|---|---|
| **P0** | Live risk or a broken pipeline. Do this week. |
| **P1** | Large, cheap wins — mostly `S` effort with disproportionate payoff. Do next. |
| **P2** | Correctness, hygiene and the quality floor. Within the month. |
| **P3** | Structural refactors and the SEO build-out. This quarter. |
| **P4** | New product capability. Roadmap, not backlog. |

---

## P0 — Do this week

### Security

- [x] **P0-1 · Gate and sanitize `headScripts`** — `S`
  Require `unfiltered_html` (or `manage_options`) for the `headScripts` key specifically; `wp_kses_post()` every other settings string value.
  `digital-newspaper.php:2930-2937, 4629, 4634`
  **Why:** any Contributor can currently inject a `<script>` that executes for every reader and steals the admin JWT from `localStorage`.
  **Done when:** a user with only `edit_posts` gets a 403 on `PATCH /data/settings` with a `headScripts` payload, and an existing non-script settings save still round-trips unchanged.
  **Status: DONE** (15 Aug 2026) — `guard_and_sanitize_settings()` added and wired into *both* `patch_settings_endpoint()` and `post_data_endpoint_inner()` (POST /data was a second, unfiltered injection route). 200 insertions, 0 deletions, `php -l` clean, 44/44 unit assertions pass. **CSP deliberately untouched** — see the unnumbered note in the pre-work table; the `script-src` directive must gain `securepubads.g.doubleclick.net` before the mode is changed, or all ads break.

- [ ] **P0-2 · Rotate the FTP credentials and strip them from the repo** — `S`
  Rotate the Hostinger password first, *then* remove the literals from `deploy.js` (44-46), `deploy.config.js`, `monitor-env.sh`, `TROUBLESHOOTING.md`, `SITE_DOWNTIME_DEBUG.md`. Replace the auto-generation of `deploy.config.local.js` with a hard fail on missing env vars.
  **Why:** the password is in ≥5 commits of history; the `.gitignore` entry is cosmetic because the tracked generator contains the secret.
  **Done when:** `git grep -i "$OLD_PASSWORD" $(git rev-list --all)` returns only historical commits, no tracked file contains a credential literal, and `npm run deploy` fails with a clear message when `.env` is absent.
  **Note:** decide separately whether to rewrite history. If the repo is or may become shared, assume the old credential is permanently public regardless.

- [x] **P0-3 · Capability check on media delete and upload** — `S`
  Add `current_user_can('delete_post', $id)` to `delete_media_item`; require `upload_files` (not `edit_posts`) in `upload_media`.
  `digital-newspaper.php:7671-7682, 7552`
  **Why:** `wp_delete_attachment($id, true)` performs no capability check of its own — a Contributor looping `/media/1..N` permanently removes every page scan from disk.
  **Done when:** a Contributor gets 403 on both; an Editor/Admin is unaffected.
  **Status: DONE** (23 Aug 2026) — delete now requires `upload_files` + WordPress's own `delete_post` meta capability, and is restricted to *image* attachments so the endpoint can no longer be used to remove PDFs, exports or other plugins' files. Upload requires `upload_files`, widenable via the `dn_media_upload_capability` filter. 18 role-matrix assertions pass; the 44 P0-1 assertions still pass.

- [ ] **P0-4 · Rate-limit `/section-crop` and bound its output** — `S`
  Call `check_public_get_rate_limit()` in the handler, validate crop coordinates against the stored section list rather than accepting arbitrary floats, and cap the generated-file count.
  `digital-newspaper.php:3099-3105, 4232, 4297, 4342`
  **Why:** unauthenticated, unmetered, and writes a new JPEG per unique coordinate tuple — disk fill plus a full page-scan decode per request.
  **Done when:** the 121st request in 60 s returns 429, and a request with coordinates not matching a stored section is rejected rather than rendered.

### Build pipeline

- [ ] **P0-5 · Fix the `npm run build -- --flag` bug** — `S`
  Add `"build:prod": "ng build --configuration production --base-href / && node scripts/compress-dist.js"` and point `deploy.js:129`, `.github/workflows/deploy.yml:31` and `auto-deploy.sh:56` at it.
  **Why:** npm appends `--` args to the end of the `&&` chain, so the flag lands on `compress-dist.js` (which reads `argv[2]` as a directory) and exits 1. All three automation paths have failed since early July.
  **Done when:** `npm run build:prod` exits 0 and produces `.br`/`.gz` siblings; the GitHub workflow goes green.

- [ ] **P0-6 · Fix `auto-deploy.sh`'s index.html check** — `S`
  `auto-deploy.sh:59` does `find dist -name index.html`, which matches nothing since the SSR build switched to `index.csr.html`.
  ⚠ **blocked by** P0-5 (it fails earlier without it).
  **Done when:** the script's build-verification step passes on a real build.

**P0 exit criteria:** no Contributor-reachable destructive action, no credential in a tracked file, and `npm run deploy` + CI both complete end to end.

---

## P1 — Large, cheap wins

> Most of this tier is `S` effort. Together it is the single biggest user-visible improvement available, and item P1-3 is a checkbox in WP admin.

### The LCP chain — strict order

- [ ] **P1-1 · Add `.html` to the compression path** — `S`
  Three coordinated changes: `COMPRESSIBLE_EXT` in `scripts/compress-dist.js:39`; the `html` alternation in `.htaccess:36` and `:39`; and a `<FilesMatch "\.html\.(?:br|gz)$">` block setting `Content-Type: text/html` and `Cache-Control: no-cache` (the existing `^index(\.csr)?\.html$` match at `:120` will **not** match `index.csr.html.br`).
  **Done when:** `curl -sI -H 'Accept-Encoding: br' <site>/ | grep -i content-encoding` returns `br`.

- [ ] **P1-2 · Teach `atomic_write()` to compress `.html`** — `S`
  `digital-newspaper.php:1839` only writes `.br`/`.gz` siblings for `.json`, but `maybe_rewrite_index_html()` calls it on a `.html` path at `:2161`.
  ⚠ **blocked by** P1-1.
  **Why:** without this, the stale `.br` from the last `npm run build` is served *instead of* the freshly-inlined HTML — a silent correctness bug the moment both features are on.
  **Done when:** after a snapshot regeneration, the served HTML contains the current `dn-initial-state` payload, not the previous build's.

- [ ] **P1-3 · Defer `EditionCacheService._persistAll` off the boot path** — `S`
  Wrap in `requestIdleCallback` (with a `setTimeout` fallback) at `edition-cache.service.ts:213, 322, 345`.
  **Why:** harmless today, but P1-4 moves this synchronous ~50 KB `JSON.stringify` + `localStorage.setItem` into the service constructor, before first paint. **Do this before flipping the flag, not after.**
  **Done when:** no synchronous `localStorage` write occurs during `NewspaperDataService` construction.

- [ ] **P1-4 · Resolve the `epaper` vs `nepaper` contradiction** — `S`
  `src/app/config.ts:8` says production is `nepaper`; `environment.prod.ts:7` says `epaper`. Determine the deployed WordPress `home_url()` and make all three agree.
  **Why:** the plugin writes preload hrefs normalised to `home_url()`; Angular's `resolveImageUrl()` rewrites to `wpBaseUrl`'s origin. **If they disagree, every reader double-downloads the full page image once P1-5 is on.**
  **Done when:** the stale comment is corrected and `home_url()`, `wpBaseUrl` and `canonicalOrigin` all name the same host.

- [ ] **P1-5 · Turn on the four plugin flags** — `S`
  `OPTION_STATIC_SNAPSHOTS`, `OPTION_INLINE_INDEX`, `OPTION_PRELOAD_LCP`, `OPTION_UPLOADS_CACHE` (`digital-newspaper.php:394-397`, all default `false`).
  ⚠ **blocked by** P1-1, P1-2, P1-3, P1-4.
  **Why:** collapses the cold-load chain from 6 network round trips to 2. The code is already written, shipped and reviewed.
  **Done when:** `dn-initial-state` in the served HTML is non-empty, an LCP `<link rel=preload as=image>` is present, and the image request appears on round trip 2 in a cold-cache waterfall.
  **Rollback:** each flag is independently toggleable; `on_*_toggled` handlers strip their injected blocks on disable.

- [ ] **P1-6 · Fix the three bugs in `build_first_page_preload_block()`** — `M`
  (a) high-priority the full image, not the thumbnail; (b) emit `imagesrcset`/`imagesizes` when variants exist; (c) anchor the injection after the viewport meta rather than before `</head>`, so it lands ahead of the font preloads.
  `digital-newspaper.php:2179-2213, 2152`
  **Why:** as written it deprioritizes the LCP element, and it becomes a guaranteed full double-download the moment P2-1 populates `imageVariants`.
  **Done when:** the preload href matches exactly what `<picture>` selects, at `fetchpriority=high`, positioned before the font preloads.

### Front-end quick wins

- [ ] **P1-7 · Fix the `fetchpriority` inversion and the opacity ramp** — `S`
  Swap `fetchpriority` between `newspaper.component.html:621` (placeholder → `low`) and `:662` (main image → `high`); replace `[style.opacity]` at `:668` with a `visibility`-based class; delete `transition: opacity 0.3s ease` from `newspaper.component.css:1021`.
  **Why:** an element at `opacity: 0` is not an LCP candidate at all, so Chrome currently measures the *blurred placeholder*, and the 300 ms ramp adds pure measurement penalty.
  **Done when:** a Lighthouse trace names `.main-page-image` as the LCP element.

- [ ] **P1-8 · Stop the service worker prefetching the admin bundle** — `S`
  Split the `app-shell` group in `ngsw-config.json:19-29`; move `/chunk-*.js` into a separate `installMode: lazy` group. Delete the dead `/index.html` entry at `:24` while you're in there.
  **Why:** the `/*.js` glob expands to both admin chunks — ~214 KiB brotli background-downloaded by every reader on install *and* on every release, exactly undoing `AuthAwarePreloadingStrategy`.
  **Done when:** the generated `ngsw.json` `app-shell.urls` contains no `chunk-GDV5J4TR` / `chunk-5HGGXWUV`.
  **Trade-off, accept knowingly:** `chunk-3E2P4WFJ.js` (Angular core) also moves to lazy. Identical on first visit — it's on the critical path anyway.

- [ ] **P1-9 · Trim the font preloads** — `S`
  Drop `latin-ext` (21,412 B — covers Latin Ext-A/B and IPA, which this site never renders); drop the `latin` *preload* and let it load from CSS; subset the Bengali variable font and instance the `wght` axis.
  `index.html:42-44`, `styles.css:8-33`
  **Why:** 133,328 B currently sits at *Highest* priority, above the module scripts that trigger the LCP image request.
  **Done when:** the preload budget is ~55 KB and no glyph renders in a fallback font on the reader route.
  ⚠ **Watch out:** fonts are deliberately *not* content-hashed and carry a 1-year cache — version the path (`/assets/fonts/v2/…`) or returning visitors are stranded on the old file. See P2-8.

- [ ] **P1-10 · Reserve ad-slot height before `/ads/config` resolves** — `S`
  Render a placeholder with the slot's declared dimensions in the `!adService.ready()` branch, using a static map mirroring `gam_ad_slots()` (`digital-newspaper.php:594-685`). Remove `!slot()` from the `dn-ad--hidden` host binding at `ad-slot.component.ts:54` or the placeholder itself gets `display: none`.
  **Why:** slots render 0 px then jump to 250 px — likely the single largest CLS contributor.
  **Done when:** CLS attribution no longer names an ad container.

- [ ] **P1-11 · Move the ad `MutationObserver` outside the Angular zone** — `S`
  `ad-slot.component.ts:167-186` — wrap in `zone.runOutsideAngular()`, re-enter with `zone.run()` only for the signal write.
  **Why:** `{childList: true, subtree: true}` on a GPT container fires dozens to hundreds of times during SafeFrame construction, each triggering a full app tick.
  **Done when:** a performance profile during ad load shows no change-detection cycle per mutation.

- [ ] **P1-12 · Stop cloning ~1,000 sections per render** — `S`
  `newspaper.component.ts:540-545` — set `pageId` in place and store the reference instead of `{ ...section, pageId }`. Safe: the objects come straight from `JSON.parse` and nothing else aliases them.
  **Done when:** `renderCurrentEdition()` allocates no per-section copies.

- [ ] **P1-13 · Gate the version poll on `visibilityState`** — `S`
  `newspaper.component.ts:322-336` — don't re-render while the tab is visible and the user is reading; stop the poll entirely while hidden.
  **Why:** every 5 minutes a reader mid-article can take a 50–150 ms long task, and a backgrounded tab fires ~96 pointless requests per 8 hours.
  **Done when:** no reload fires while the tab is visible and a modal-free read is in progress; the interval is cleared on `visibilitychange` → hidden.

- [ ] **P1-14 · `manifest.webmanifest`: `display: "standalone"`** — `S`
  Also add `id`, `scope`, `orientation`, `screenshots`, `shortcuts`, and split the icon set into separate `any` and `maskable` entries.
  **Why:** one field is suppressing `beforeinstallprompt` despite 8 correct icons, a working service worker and an update banner all being in place.
  **Done when:** Chrome offers the install prompt.

### SEO — the two that actually matter

- [ ] **P1-15 · Add search crawlers to the prerender UA set; remove `Googlebot-Image`** — `S`
  Define the UA sets once via `mod_setenvif` (the list is currently duplicated verbatim five times at `.htaccess:16, 17, 59, 64, 69`), then replace the three `RewriteCond %{HTTP_USER_AGENT}` lines with `RewriteCond %{ENV:IS_PRERENDER_BOT} =1`. Widen `Vary: User-Agent` to *all* responses, not just bot ones (`:222-224`).
  ⚠ **Do not ship without P1-16.**
  **Why:** Googlebot currently receives a 9,728-byte shell with zero content words on every URL; Googlebot-Image receives a `noarchive` redirect page, which is a cloaking signal *and* blocks Google Images.
  **Done when:** `curl -A 'Googlebot/2.1' <article-url>` returns real article text.

- [ ] **P1-16 · Make `/social` a legitimate dynamic-rendering endpoint** — `M`
  For search-bot UAs: emit the real article body, drop the `window.location.replace()` (`digital-newspaper.php:3546`), drop `X-Robots-Tag: noarchive` (`:3354`), add `<meta name="description">` and a canonical.
  ⚠ **hard dependency of** P1-15 — shipping P1-15 alone means serving crawlers a redirect stub, which is worse than the status quo.
  **Why:** Google sanctions dynamic rendering when the content matches what the SPA renders. Serving structured data and then bouncing the crawler is cloaking.
  **Done when:** the bot response and the rendered SPA page contain equivalent text.

**P1 exit criteria:** cold-load LCP image on round trip 2; Googlebot receives real HTML; CLS free of ad-slot jumps; PWA installable.

---

## P2 — Correctness, hygiene, quality floor

### The biggest remaining perf item

- [ ] **P2-1 · Generate server-side AVIF/WebP width variants** — `M`
  On upload, produce 2–3 widths (800/1200/1600) via `wp_get_image_editor` (Imagick is already used in the social path) and write them into `imageVariants`.
  **Why:** the client-side `<picture>` pipeline at `newspaper.component.html:649-670` is **fully dead code** — nothing populates `.avif`/`.webp`, so `<source>` renders empty and every device downloads the single full-size scan. The front end lights up with **zero client changes**.
  **Done when:** `imageVariants.webp` is non-empty for a newly uploaded page and a narrow viewport downloads a smaller file than a wide one.
  ⚠ **Coordinate with P1-6(b)** — once variants exist, the preload must be variant-aware or it becomes a wasted full download.

### Deploy correctness

- [ ] **P2-2 · Decide SSR: delete it or prerender `/`** — `M`
  Either remove `server.ts`, `main.server.ts`, `app.config.server.ts`, the SSR `angular.json` keys and the 6 unused server deps (`express`, `cors`, `helmet`, `compression`, `express-rate-limit`, `@types/express` — four of which are imported nowhere) — or commit to P3-6.
  **Why:** currently built and shipped every deploy, never executed. Honest either way; the middle ground is pure cost.
  **Done when:** either `dist/` has no `server/` directory, or a Node process actually serves it.

- [ ] **P2-3 · Point deploy at `dist/digital-newspaper/browser`** — `S`
  `deploy.js:136, 153, 412` and `.github/workflows/deploy.yml` currently copy the whole `dist/digital-newspaper` wholesale, so `browser/` and `server/` land as subdirectories of the web root. Also stop overwriting `src/.htaccess` with the hardcoded copy in `deploy.js:204` (which rewrites to a nonexistent `/index.html`), and drop the dead chmod loop at `:386`.
  **Done when:** the remote root contains `index.csr.html` at top level and no `server/`.

### Remaining security

- [ ] **P2-4 · Fix the rate-limiter IP source** — `S`
  Use `REMOTE_ADDR` unless the request arrives from a configured trusted proxy; additionally key the login counter on username.
  `digital-newspaper.php:7349, 816-818`
  **Why:** `X-Forwarded-For` is trusted unconditionally and the *entire* header is the transient key — one extra character per attempt gives an unlimited fresh 5-attempt bucket. The comment at `:816` ("leftmost … to prevent spoofing") is backwards.
  **Done when:** varying `X-Forwarded-For` no longer resets the counter.

- [ ] **P2-5 · `wp_kses_post()` section `content` at the storage boundary** — `S`
  In `put_section_endpoint` / `post_data_endpoint`. The WP-post *mirror* at `:2792` already does this; the `dn_edition_*` copy the app actually reads does not.
  **Done when:** a section saved with `<img onerror=…>` stores sanitized markup.

- [ ] **P2-6 · Check `normalize-content.pipe.ts`** — `S`
  **This file was not in the reviewed snapshot.** If the on-screen article modal renders via `[innerHTML]`, Angular's sanitizer covers it and the print path is the only gap. If it uses `bypassSecurityTrustHtml`, escalate to P0.
  Also sanitize `newspaper.component.ts:1528` (`articleEl.innerHTML` in the print path — `normalizeContent` only replaces `&nbsp;`).
  **Done when:** you've read the file and either confirmed it's safe or filed the escalation.

- [ ] **P2-7 · `realpath()` containment on `/social-thumb`; validate stored image URLs** — `S`
  `digital-newspaper.php:3923-3936` — `basename()` runs on the still-encoded path so `%2e%2e%2f` survives it. The sibling `proxy_image` at `:7462-7464` already does this correctly; copy the pattern. Separately, validate `logo.url` and `section.imageUrl` against the uploads base / an allowlisted host before any `wp_remote_get` (`:4083, 4150`).
  **Done when:** a traversal-encoded filename resolves outside uploads and is rejected.

- [ ] **P2-8 · Security headers at the Apache layer** — `S`
  HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy` in `.htaccess` after `:123`.
  **Why:** the plugin sets these inside `add_public_security_headers()` (REST callbacks only) and its CSP via `send_headers` — **neither fires for a file Apache serves directly**. The entire security-header story is dead for the actual application.
  **Done when:** `curl -sI <site>/` shows all five.
  ⚠ Hold `includeSubDomains` until every `*.dailysangram.com` host is HTTPS-only.

- [ ] **P2-9 · `?force=1` lock release needs a capability check** — `S`
  `digital-newspaper.php:8433-8440` — the comment promises an admin check that doesn't exist, so any editor can steal another's page lock.
  **Done when:** `force` is ignored for non-`manage_options` users.

- [ ] **P2-10 · Move `dn-last-fatal.log` out of the web root** — `S`
  Write to `wp-content/uploads/dn-private/` with a deny rule (`:6888-6893`). Strip `file`/`line`/`message` from client-facing 500 bodies (`:5531, 6441-6443, 7029-7035`).
  **Done when:** `GET /wp-content/dn-last-fatal.log` 404s.

- [ ] **P2-11 · Make the `.htaccess` WAF-disable block opt-in and scoped** — `S`
  `digital-newspaper.php:212-215` writes an unscoped `<IfModule mod_security.c> SecFilterEngine Off` into the *root* `.htaccess` on `admin_init`, removing POST inspection for the whole WordPress install.
  **Done when:** the block is behind a setting and scoped to the plugin's own routes.

### Caching and headers

- [ ] **P2-12 · Explicit `immutable` on hashed assets** — `S`
  Don't rely on `mod_expires` resolving `application/javascript` through the `.br` extension — set `Cache-Control: public, max-age=31536000, immutable` via `<FilesMatch "-[A-Z0-9]{8}\.(?:js|css)(\.(?:br|gz))?$">`. Also hoist a global `Vary: Accept-Encoding` (currently only emitted on the compressed path, leaving the plain response poisonable) and set `FileETag MTime Size`.
  `.htaccess:126-139, 174-198`
  **Done when:** `curl -sI` on a hashed `.js` shows `immutable` regardless of encoding.

- [ ] **P2-13 · Version the font path** — `S`
  Fonts are deliberately not content-hashed but carry a 1-year cache.
  ⚠ **blocked by** P1-9 — re-subsetting without this strands returning visitors for up to a year.
  **Done when:** the new subset is at a new path.

- [ ] **P2-14 · LRU eviction on edition localStorage keys** — `S`
  `edition-cache.service.ts:464-467` writes one key per date with no TTL and no eviction; `evict()` only runs on admin save or same-day invalidation.
  **Why:** a daily reader accumulates a key per day forever until quota fills — after which *all* localStorage writes, including the auth token at `auth.service.ts:75`, start throwing into empty catches.
  **Done when:** a byte/key cap is enforced with oldest-first eviction.

- [ ] **P2-15 · Add a `swUpdate.unrecoverableState` handler** — `S`
  A client whose cache references a purged hash currently gets a broken app with no self-heal. One subscription → `location.reload()`.

- [ ] **P2-16 · Add bundle budgets** — `S`
  `{"type":"bundle","name":"admin",…}` and `{"type":"allScript",…}` in `angular.json`. The `initial` budget is currently the only one, leaving the ~900 KB admin payload unbounded. Add a comment explaining why `optimization.fonts: false` is correct so nobody "fixes" it.

### SEO head tags

- [ ] **P2-17 · `<html lang="bn">`** — `S`
  `index.html:2`, plus dynamic sync in `refreshSettings()` (`newspaper.component.ts:471`), `og:locale`, and `getPrintDocument()` at `:1509` (currently emits `<html>` with no lang).
  **Why:** the plugin already emits `lang="bn"` in `/social`, so social crawlers and Googlebot currently disagree by construction.

- [ ] **P2-18 · `<meta name="description">`** — `S`
  Four sites: `index.html:13` (static fallback), and the three branches of `updateMetaTags()` (`newspaper.component.ts:2001, 2029, 2050`). Plus the `/social` heredoc at `digital-newspaper.php:3527`.
  **Why:** the string is already computed at `:1996` and discarded. Google does not use `og:description` for snippets.

- [ ] **P2-19 · `robots.txt`** — `S`
  Create `src/robots.txt` and register it in `angular.json`'s assets array. Do **not** blanket-disallow `/wp/` — the `/social*` routes and `/wp-content/uploads/` are the only crawler-readable content. Disallow `/admin`, the WP admin paths, and `/wp/wp-content/dn-static/`.
  **Why:** `/robots.txt` currently returns the app shell as `text/html` via the catch-all.

- [ ] **P2-20 · Canonical + host-alias 301s** — `M`
  Add `canonicalOrigin` to both environment files; build canonical from that constant (never `location.origin`) and reuse it for `og:url`/`twitter:url` at `newspaper.component.ts:1975`. Then 301 the aliases in `.htaccess` after `:23`, before the compression block.
  **Why:** six hosts (`epaper`/`nepaper`/`www` × http/https) serve identical content, and `og:url` currently inherits whichever alias the visitor landed on.
  ⚠ **blocked by** P1-4 (you need to know the real canonical host first).

### Process and hygiene

- [ ] **P2-21 · ESLint + Prettier + pre-commit + `php -l` in CI** — `M`
  `ng add @angular/eslint`, add Prettier and `lint-staged`, add a lint/test gate to the workflow.
  **Why:** zero `.spec.ts`, no linter, no formatter, and the only CI gate (the build) has been failing since July. Highest-leverage process item on a codebase with a 4,413-line component.

- [ ] **P2-22 · First characterisation tests** — `M`
  Start with the three pure-logic units: `xml-import.service.ts` (**9 XML fixtures already ship in `src/assets/test-fixtures/xml/` and no test consumes them**), `page-label.util.ts`, and the `http-cache.interceptor.ts` TTL rules.
  ⚠ **blocked by** P2-21.

- [ ] **P2-23 · Repo cleanup** — `S`
  `git rm -r --cached dist.bak wordpress-plugin/*.zip src/assets/cropped` and add to `.gitignore`; move `src/assets/test-fixtures/` out of the assets glob; scope the glob to `{icons,fonts}/**/*` plus explicit files; delete `proxy.conf.js` + `proxy.conf.json` (neither is referenced — `angular.json`'s serve target has no `proxyConfig`) and `deploy-old.js`; prune merged branches.
  **Numbers:** 7.3 MB of unused JPEGs shipped in every build, `dist.bak/` at 9.1 MB tracked, `.git` at 156 MB for 253 files.

- [ ] **P2-24 · Consolidate the 36 root markdown docs** — `S`
  488 KB with heavy overlap (4 `PERFORMANCE_*.md`, 3 `DEPLOY*.md`). Move to `docs/`, add a dated index, delete the superseded ones.

- [ ] **P2-25 · Replace the deny-list XML sanitizer** — `M`
  `xml-import.service.ts:15, 583-633` — `svg`, `math`, `base`, `link`, `meta`, `template` all pass the current block-list, and the URL check only catches a literal lowercase `javascript:` after `trim()`. Use an allow-list or `DomSanitizer.sanitize(SecurityContext.HTML, …)`. Also add an explicit `formats` array to the Quill config (`admin.component.ts:249-260`).

- [ ] **P2-26 · Resolve `xlsx@0.18.5`** — `M`
  Unpatched prototype-pollution and ReDoS advisories with no fix on npm (the maintained line moved to `cdn.sheetjs.com`). Either switch to the CDN tarball or drop the dependency — you already have a hand-rolled XML importer, and removing it deletes a 716 KB chunk.

- [ ] **P2-27 · Global `ErrorHandler` + error callbacks on post-mutation reloads** — `M`
  42 of 71 `subscribe()` calls have no error callback; the consequential ones are the `reloadDate()` calls at `admin.component.ts:406, 661, 1537, 1549, 1615, 1847, 1901, 2385`, where a failure leaves the editor showing stale data with no signal.

- [ ] **P2-28 · Admin CD quick wins** — `S`
  Cache `isAdmin`/`isAuthenticated` as fields instead of getters (`admin.component.ts:514, 518` — currently ~30 `localStorage` reads + 19 `atob()` + 30 `JSON.parse()` per change-detection cycle, i.e. per keystroke in Quill); change `track opt` → `track opt.id` at `admin.component.html:584`; memoise `pageIdOptions`.

- [ ] **P2-29 · `canMatch` guard on `/admin`** — `S`
  Not a security fix — the server enforces `auth_required`. It stops the ~900 KB chunk downloading and the component constructing for anonymous visitors, and lets you delete `AuthAwarePreloadingStrategy`.

- [ ] **P2-30 · Remaining CLS sources** — `M`
  Reserve the ~41 px pagination bar; `contain-intrinsic-size: auto 290px` (currently `0 200px` against a real ~290 px); make the centre-panel skeleton geometrically match real content; metric-matched `@font-face` fallback with measured `size-adjust`/`ascent-override`; reconsider the Heavy-Ad collapse, which *creates* a shift to fix a blank.

**P2 exit criteria:** lint + tests running in CI, no unbounded caches, security headers live, responsive images actually served.

---

## P3 — Structural

- [ ] **P3-1 · Sitemap index + monthly children + news sitemap** — `M`
  Three routes next to `/data/dates` (`digital-newspaper.php:2942`). Month-partition to stay under the 50,000-URL limit (~10,850 per month at 14 pages × 25 sections). URL shapes must match `updateUrl()` and the `.htaccess` regex at `:65` **byte-for-byte with trailing slashes** — emit whatever `getEditionSlug()` produces rather than hand-guessing. Alias in `.htaccess` **above** the catch-all.
  **Why:** the only mechanism that gets ~128,000 article URLs discovered.
  **Done when:** Search Console accepts the index and reports discovered URLs climbing.

- [ ] **P3-2 · Server-side JSON-LD in `/social`** — `M`
  `NewsArticle` + `NewsMediaOrganization` + `BreadcrumbList` as an `@graph`. Note the data model has **no per-section author** (fall back to the Organization) and **no publication time** (`T00:00:00+06:00` is the honest representation). Add the paper's ISSN if it has one — a strong News signal.
  ⚠ **blocked by** P1-16.

- [ ] **P3-3 · Make navigation controls real `<a href>`** — `M`
  Prev/next day (`newspaper.component.html:56, 67`), pagination (`:583`), thumbnails (`:383`), and section overlays (`section-overlay.component.ts:29` — these are the URLs carrying actual article text). Keep the existing `(click)` handlers, add `$event.preventDefault()`.
  **Why:** zero `routerLink` in the app and `location.replaceState()` for URL updates means Google's crawl graph is a single node.
  **Bonus:** middle-click and "open in new tab" start working.

- [ ] **P3-4 · Crawlable archive index** — `M`
  A `<nav>` of `<a>` for the last 30 dates plus a full-archive link, or an `/archive/` route emitted by the plugin (it already holds `dn_data_index.dates`), linked from the footer.

- [ ] **P3-5 · Split `AdminComponent`** — `L`
  4,413 lines, 228 methods. The file already self-segregates by comment banner — extract in this order: image cropper (`:1932-3110`, ~1,180 lines → presentational component), `MediaUploadService` (`:2695-3028`, ~330 lines — **also removes the `wafBypassFetch` duplication** with `wp-api.interceptor.ts:73-93`), activity log (`:821-988`), backup panel (`:3294-3556`), locking (`:679-820` → fold into `LockService`). Then convert to `OnPush` with a `_viewDestroyed` guard (the pattern already exists at `newspaper.component.ts:163`).
  Also extract `DataExportImportService` from the contiguous `newspaper-data.service.ts:2201-2527`.
  **Done when:** the admin shell is ~600–800 lines and `detectChanges()` calls are `markForCheck()`.

- [ ] **P3-6 · Real build-time prerender** — `L`
  Feed `getPrerenderParams` from `wp-content/dn-static/editions/*.json` on disk instead of the REST API — this sidesteps the Imunify360 problem that killed `RenderMode.Prerender` (documented at `app.config.server.ts:14-19`).
  **Why:** makes P1-15, P1-16, P3-2 and P3-3 largely redundant, and gives real HTML to every crawler plus a sub-1 s LCP.
  ⚠ Mutually exclusive with the "delete SSR" branch of P2-2.

- [ ] **P3-7 · Accessibility pass** — `L`
  24 modal containers in `admin.component.html` and exactly one has dialog semantics. **`.focus()` appears nowhere in any `.ts` or `.html` file** — no focus trap, no focus-on-open, no focus-restore. Escape closes 2 of ~26 modals. 16 non-semantic clickables, including `newspaper.component.html:815, 866` — the *primary* article-image affordances, unreachable by keyboard. The 977-line public viewer has 6 `aria-*` attributes total.
  Start with the viewer (legal exposure), then the admin modals.

- [ ] **P3-8 · Zoneless** — `L`
  `provideZonelessChangeDetection()`, drop `zone.js` from polyfills. All reader components are already `OnPush` and the manual CD calls are already explicit. Needs an audit of the 9 `setTimeout` sites first.
  ⚠ **blocked by** P3-5 (AdminComponent must be OnPush).
  **Payoff:** −11.3 KB brotli, plus elimination of every zone tick from `img.onload` (~42/edition), the resize debounce (which ticks twice), the document click handler and the ad observer.

- [ ] **P3-9 · Move the `:root` token block to an admin-only stylesheet** — `M`
  ~60 custom properties, almost all consumed by `admin.component.css`, currently inlined into every reader's critical CSS.

- [ ] **P3-10 · Analytics instrumentation + the missing `/rum` endpoint** — `M`
  The app fires **zero** events — no page_view, article_open, share or date_change. Separately, `web-vitals.service.ts:42` beacons to `/digital-newspaper/v1/rum`, which **does not exist** in the plugin, so those beacons 404.

**P3 exit criteria:** crawl graph exists, article URLs indexed, AdminComponent maintainable, viewer keyboard-navigable.

---

## P4 — New capability (roadmap)

Ordered by product value. Each is a project, not a task.

- [ ] **P4-1 · Full-text search** — `L` · The single biggest product gap. The archive is reachable only by knowing a date. No search route exists in 32 REST endpoints and no reader-facing search UI exists.
- [ ] **P4-2 · PDF export** — `L` · Per-page and full-edition. Table stakes for an e-paper; currently zero `pdf` references anywhere.
- [ ] **P4-3 · Reader zoom and pan** — `M` · The `.zoom-indicator` magnifier is decorative — it only opens a modal. No pinch, no wheel, no drag. On a phone, reading a broadsheet without zoom is the core UX problem.
- [ ] **P4-4 · Push notifications / newsletter** — `L` · Nothing currently brings a reader back tomorrow.
- [ ] **P4-5 · Draft/scheduled publishing** — `L` · `upsert_section_post()` hard-codes `post_status => 'publish'`; there is **no WP-Cron usage at all**. Editions go live the instant they're saved. This also fixes the "everything is synchronous" root cause behind the memory-defensive PHP.
- [ ] **P4-6 · Roles beyond the two tiers** — `M` · Editor/contributor/reviewer with per-date or per-page ownership. This is what makes P0-1 and P0-3 severe in the first place.
- [ ] **P4-7 · Page/article versioning and diff** — `M` · The CPT declares `'revisions'` support but the plugin never reads or writes one — cost without benefit. The activity log records *that* a section changed, never *what* changed.
- [ ] **P4-8 · Web Share API, keyboard shortcuts, dark mode, font-size controls, bookmarks** — `M` each · Reader-experience batch.
- [ ] **P4-9 · Taxonomy, bylines, related articles** — `L` · No categories, no authors, no keywords; cross-linking is manual via `linkedSectionIds`.
- [ ] **P4-10 · Fix the hard-coded print imprint** — `S` · `newspaper.component.ts:1644, 1648` writes a fixed Daily Sangram editor line and publisher block instead of reading `settings.editor`/`settings.address`, which the on-screen footer *does* use. Any other deployment prints the wrong imprint. **Cheap — pull forward if you ever white-label.**

---

## Pre-work: ten things that need a live request

None of these are tasks in themselves, but several P1/P2 items depend on the answers. The Chrome extension was not connected during the review, so all ten are unverified.

| # | Question | Command | Blocks |
|---|---|---|---|
| 1 | Is `index.csr.html` served compressed? | `curl -sI -H 'Accept-Encoding: br,gzip' <site>/ \| grep -i content-encoding` | validates P1-1 |
| 2 | Does `mod_expires` resolve types through `.br`? | `curl -sI <site>/main-<hash>.js \| grep -i cache-control` | P2-12 (moot if done) |
| 3 | HTTP/2 or /3? | `curl -sI --http2 <site>/ -o /dev/null -w '%{http_version}\n'` | changes P1-9 severity — on HTTP/1.1 the font block is far worse |
| 4 | Which element does Chrome pick as LCP? | add a `PerformanceObserver` logging `entry.element` | validates P1-7 |
| 5 | How many published dates? | `curl -s '<site>/wp/wp-json/digital-newspaper/v1/data/dates'` | sizes P3-1 |
| 6 | Live values of the four feature flags | check `wp_options` | P1-5 — note `:2292` flips `STATIC_SNAPSHOTS` true whenever anyone clicks "Regenerate snapshots" |
| 7 | Real size of the inline bootstrap blob | after enabling P1-5 | validates P1-1's necessity |
| 8 | Is `home_url()` `epaper` or `nepaper`? | WP admin → Settings → General | **P1-4, P2-20** |
| 9 | Is `static.dailysangram.com` a live CDN? | DNS + a fetch | if live, `resolveImageUrl()` (`newspaper.component.ts:1418`) rewrites its URLs back to the WP origin and **defeats it entirely** |
| 10 | Is the PHP `brotli` extension present? | `php -m \| grep -i brotli` | ~15–20% on JSON snapshots |

**One more, unnumbered:** the plugin's CSP (`digital-newspaper.php:798`) has `script-src 'self'` with **no `securepubads.g.doubleclick.net`**. It's Report-Only *and* never fires for the SPA, so nobody sees the violation reports — but if it were ever promoted to enforced, **all ads would break instantly.** Fix the directive before touching the CSP mode in P0-1.

---

## Dependency graph (the ones that bite)

```
P0-5 ──→ P0-6

P1-1 ──→ P1-2 ─┐
P1-3 ──────────┼─→ P1-5 ──→ P1-6 ──→ P2-1
P1-4 ──────────┘              (variant-aware preload)
P1-4 ──→ P2-20

P1-15 ─── must ship with ──→ P1-16 ──→ P3-2

P1-9 ──→ P2-13   (version the font path, or strand cached clients)

P2-21 ──→ P2-22

P3-5 ──→ P3-8

P2-2 ──── mutually exclusive with ──── P3-6
```

**Three traps worth repeating:**

1. **P1-5 before P1-1/P1-2** ships ~60 KB uncompressed *and* can serve stale HTML.
2. **P1-15 without P1-16** serves crawlers a redirect stub — worse than today.
3. **P1-9 without P2-13** strands returning visitors on the old font for up to a year.
