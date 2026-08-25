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

- [x] **P0-4 · Rate-limit `/section-crop` and bound its output** — `S`
  Call `check_public_get_rate_limit()` in the handler, validate crop coordinates against the stored section list rather than accepting arbitrary floats, and cap the generated-file count.
  `digital-newspaper.php:3099-3105, 4232, 4297, 4342`
  **Why:** unauthenticated, unmetered, and writes a new JPEG per unique coordinate tuple — disk fill plus a full page-scan decode per request.
  **Done when:** the 121st request in 60 s returns 429, and a request with coordinates not matching a stored section is rejected rather than rendered.
  **Status: DONE** (23 Aug 2026) — implemented slightly differently, and more safely, than specified. Cache hits are never throttled (no DB, no limiter) so readers are unaffected. On a cache miss the rectangle is resolved from the `dn_section` mirror and the caller's coordinates are discarded; the filename formula is unchanged so **no existing cached crop is invalidated**. When no stored section matches, the caller's `id` is dropped from the filename (it was a second unbounded dimension the original spec missed) and the rectangle is quantised, then generation is limited to 60/IP/min plus a site-wide 200/hour ceiling. Measured: 200 attack requests produced 3 files instead of 200; a coordinate sweep is rejected 240/300 with `Retry-After: 60`. 14 assertions; the 62 earlier P0-1/P0-3 assertions still pass.

### Build pipeline

- [ ] **P0-5 · Fix the `npm run build -- --flag` bug** — `S`
  Add `"build:prod": "ng build --configuration production --base-href / && node scripts/compress-dist.js"` and point `deploy.js:129`, `.github/workflows/deploy.yml:31` and `auto-deploy.sh:56` at it.
  **Why:** npm appends `--` args to the end of the `&&` chain, so the flag lands on `compress-dist.js` (which reads `argv[2]` as a directory) and exits 1. All three automation paths have failed since early July.
  **Done when:** `npm run build:prod` exits 0 and produces `.br`/`.gz` siblings; the GitHub workflow goes green.

- [ ] **P0-6 · Fix `auto-deploy.sh`'s index.html check** — `S`
  `auto-deploy.sh:59` does `find dist -name index.html`, which matches nothing since the SSR build switched to `index.csr.html`.
  ↻ **Premise removed by P2-2:** SSR is gone and the build emits `index.html` again, so this `find` now matches. The check is no longer broken — verify against a real build and close it, or harden it to accept either name.
  ⚠ **blocked by** P0-5 (it fails earlier without it).
  **Done when:** the script's build-verification step passes on a real build.

**P0 exit criteria:** no Contributor-reachable destructive action, no credential in a tracked file, and `npm run deploy` + CI both complete end to end.

---

## P1 — Large, cheap wins

> Most of this tier is `S` effort. Together it is the single biggest user-visible improvement available, and item P1-3 is a checkbox in WP admin.

### Verification pass over P1-1 … P1-14 (25 Aug 2026)

Five independent read-only reviews, then every finding re-traced by hand before any edit. **Nine real defects found; seven fixed, two need a decision from you.**

**Fixed — regressions introduced by this tier**
1. **Offline boot was broken by P1-8** (worst of the batch). `main-*.js` statically imports two `chunk-*.js` files that the shell `modulepreload`s, and a lazy asset group caches *nothing* on a fresh install — `LazyAssetGroup.initializeFully()` in `ngsw-worker.js` opens with `if (updateFrom === undefined) return;`. A reader whose SW installed on visit 1 and then went offline got the cached shell plus a `main.js` whose import missed the cache → `SwCriticalError` → white screen. `updateMode: prefetch` did not save it either: a rebuilt chunk has a new hashed name, so it is never in the old version's cache. Fixed by `scripts/promote-ngsw-boot-chunks.js`, wired into all three build scripts: it moves exactly the chunks the shell `modulepreload`s from `app-chunks` into `app-shell`, leaving the admin/editor chunks (717 KB + 205 KB raw) lazy. Hash-name-proof, idempotent, and it exits non-zero rather than ship a build whose offline boot is broken. Verified: `app-shell` gained the two boot chunks, `app-chunks` kept exactly the two admin ones.
2. **P1-12 reverted.** Its premise — "nothing else aliases them" — is false. Those section objects are live inside the data service's `BehaviorSubject` and `EditionCacheService`'s memory cache (JSON-stringified to localStorage/IndexedDB *later*, i.e. after the stamp), and `admin.component.ts:3826/3846/3857` spread the same objects into save payloads that the plugin stores without a field whitelist. In-place stamping wrote a viewer-derived field into persisted data and into canonical server JSON, and made the admin's page labels depend on whether the reader route ran first. The spread is back, with a comment saying why it must stay.
3. **Fonts (P1-9): latin was needed after all.** `TranslationService` starts at `'en'` and only switches once settings resolve, so the *entire* first paint is ASCII — dropping the latin preload meant FOUT plus a fallback-metrics reflow across the whole UI. Latin is preloaded again but at `fetchpriority="low"`, so it no longer outranks the LCP image. latin-ext stays unpreloaded. Preload budget at Highest priority is still 75,712 B (down from 133,328 B).
4. **P1-13 could strand an update forever.** `applyPendingRemoteChange()` had exactly one caller (the visibility transition), so a reader who never backgrounds the tab never saw new content, and a version deferred by the modal guard was never retried. Now also applied on date navigation and on both modal closes.
5. **Leaked `MutationObserver` per ad slot** (pre-existing, adjacent to P1-11): the component had no `ngOnDestroy` at all, and the right-panel slot is destroyed on every section click. Added a `DestroyRef.onDestroy` that runs `_cleanupObserver`.

**Fixed — defects in earlier items, found while verifying them**
6. **`$` in an article body silently corrupted the inlined bootstrap state** (P1-2/P1-6 injection path). `preg_replace` interprets `$1`/`\1` *in the replacement*, and the replacement is the state JSON. Demonstrated: `"Costs $100 and $2 more"` was rewritten to `"Costs 0 and  more"` — still valid JSON, so it fails silently and readers see corrupted article text on first paint. Both injection sites now use `preg_replace_callback`.
7. **P1-3's deferral could resurrect data a save had just evicted.** `_persistAllDeferred()` kept no handle, so `evict()` could not cancel a queued write; the callback then re-created the localStorage key from the *pre-save* editions and stamped a fresh `fetchedAt`, i.e. a full 30-minute TTL on stale data — the exact "new page isn't saving" failure `evict()` was written to prevent. Pending writes are now tracked per date, cancelled by `evict()`/`clearMemory()`, and coalesced. The no-`requestIdleCallback` fallback (Safari < 17.4 — the devices this exists for) was a bare `setTimeout(0)` that still ran before first paint; it is now rAF-then-timeout, which lands after it.
8. **P1-6 could still double-download the LCP image** once `imageVariants` is populated. Three fixes: variant srcsets are now all-or-nothing (a partly-filtered srcset let the browser preload the 800w candidate while `<picture>` rendered the 1600w one); when variants exist but cannot be expressed safely, **no** image preload is emitted at all rather than falling back to the plain `fullImage` href; and preload URLs now go through `normalize_preload_url()`, which mirrors `resolveImageUrl()` by re-homing any `/wp-content/uploads/` URL onto the site origin — `normalize_domain_urls()` only rewrites hosts in the alias option, so a CDN host reached the preload verbatim while the `<img>` requested the re-homed URL. The srcset validator also now rejects embedded whitespace and commas, which `esc_attr` would have preserved into an unparseable srcset.
9. **P1-6 first-page selection diverged from the viewer.** PHP required an `edition` key to be present while the viewer treats missing/0 as edition 1, and id-less pages sorted *first* in PHP versus last elsewhere — either could point the preload at a page that is never rendered. Both aligned.

**Not fixed — needs your decision**
- **`deploy.js` overwrites the deployed `.htaccess` with a divergent 108-line inline copy** (`deploy.js:158-269`), so *every* `.htaccess` fix in this plan is discarded at deploy time. That copy has no `html` in either compression alternation, no `.html.(br|gz)` Content-Type/Cache-Control block, no `E=no-gzip:1`, and still routes SPA fallbacks to `/index.html` — a filename the SSR build no longer produces. It also carries a third `COMPRESSIBLE_EXT` (`deploy.js:295`) lacking `.html`. Consolidating on `src/.htaccess` is the right fix, but that file would then have to carry the unscoped `SecRuleEngine Off` / `SecFilterEngine Off` block that only exists in deploy.js's copy — which disables the host WAF for the whole document root, not just `/wp/wp-json/` as its comment claims. **Changing what arms that bypass is your call, not a side effect of a compression fix.**
- **Live evidence that P1-1 is not in effect:** `curl -sI https://epaper.dailysangram.com/` returns `cache-control: max-age=3600, must-revalidate` — LiteSpeed's default (see the comment at `.htaccess:122`), not the `no-cache, must-revalidate` that both `<FilesMatch "^index(\.csr)?\.html$">` and the new `.html.(br|gz)` block set. The `content-encoding: br` on that response is consistent with LiteSpeed compressing HTML on the fly, so it does not prove the precompressed shell is being served. Worth checking the deployed file directly.

**Refuted** — one review claimed `maybe_rewrite_index_html()` leaves stale `.br`/`.gz` siblings beside the freshly injected shell. It does not: the rewrite goes through `atomic_write()` (`:2190`), which deletes both siblings and regenerates them for `html` as well as `json` (`:1863-1877`). P1-2 covered it.

**Still unverifiable from code** — the LCP element (P1-7), the ad-load change-detection profile (P1-11) and the install prompt (P1-14) all need a real browser session against the live site.

### The LCP chain — strict order

- [x] **P1-1 · Add `.html` to the compression path** — `S`
  Three coordinated changes: `COMPRESSIBLE_EXT` in `scripts/compress-dist.js:39`; the `html` alternation in `.htaccess:36` and `:39`; and a `<FilesMatch "\.html\.(?:br|gz)$">` block setting `Content-Type: text/html` and `Cache-Control: no-cache` (the existing `^index(\.csr)?\.html$` match at `:120` will **not** match `index.csr.html.br`).
  **Done when:** `curl -sI -H 'Accept-Encoding: br' <site>/ | grep -i content-encoding` returns `br`.

  **Status: DONE** (23 Aug 2026) — `.html` added to `compress-dist.js`, to both `.htaccess` rewrite alternations, and to the `Content-Encoding`/`Vary` blocks; a new `*.html.(br|gz)` block sets `Content-Type: text/html` **and repeats `Cache-Control: no-cache`** (the existing `^index(\.csr)?\.html$` block does not match `.br`, and a stale-cached shell is the blank-page failure). `E=no-gzip:1` added so the server cannot re-compress already-compressed bytes — the existing `SetEnvIf` only sees the original request URI and cannot cover an internal rewrite. No duplicated fallback rules were needed: mod_rewrite re-runs the ruleset on the rewritten URI, so `/` and SPA routes reach the negotiation on the second pass; on a host that does not re-enter, nothing matches and the plain shell is served.
- [x] **P1-2 · Teach `atomic_write()` to compress `.html`** — `S`
  `digital-newspaper.php:1839` only writes `.br`/`.gz` siblings for `.json`, but `maybe_rewrite_index_html()` calls it on a `.html` path at `:2161`.
  ⚠ **blocked by** P1-1.
  **Why:** without this, the stale `.br` from the last `npm run build` is served *instead of* the freshly-inlined HTML — a silent correctness bug the moment both features are on.
  **Done when:** after a snapshot regeneration, the served HTML contains the current `dn-initial-state` payload, not the previous build's.

  **Status: DONE** (23 Aug 2026) — switched from a `substr(-5) === '.json'` test to a `pathinfo()` extension check covering `json` and `html`. Siblings are now **deleted before** the fresh ones are written: a stale `.br` beside fresh content is worse than none, because the negotiation would serve the stale one whereas a missing one falls back to the plain file. This also fixes the same latent bug for JSON. Verified no runaway recursion on `.gz`/`.br` paths.
- [x] **P1-3 · Defer `EditionCacheService._persistAll` off the boot path** — `S`
  Wrap in `requestIdleCallback` (with a `setTimeout` fallback) at `edition-cache.service.ts:213, 322, 345`.
  **Why:** harmless today, but P1-4 moves this synchronous ~50 KB `JSON.stringify` + `localStorage.setItem` into the service constructor, before first paint. **Do this before flipping the flag, not after.**
  **Done when:** no synchronous `localStorage` write occurs during `NewspaperDataService` construction.

  **Status: DONE** (23 Aug 2026) — added `_persistAllDeferred()` (requestIdleCallback with a setTimeout fallback and an SSR guard) and switched all three call sites. The in-memory cache is still set synchronously, so nothing a render depends on changed.
- [x] **P1-4 · Resolve the `epaper` vs `nepaper` contradiction** — `S`
  `src/app/config.ts:8` says production is `nepaper`; `environment.prod.ts:7` says `epaper`. Determine the deployed WordPress `home_url()` and make all three agree.
  **Why:** the plugin writes preload hrefs normalised to `home_url()`; Angular's `resolveImageUrl()` rewrites to `wpBaseUrl`'s origin. **If they disagree, every reader double-downloads the full page image once P1-5 is on.**
  **Done when:** the stale comment is corrected and `home_url()`, `wpBaseUrl` and `canonicalOrigin` all name the same host.

  **Status: DONE** (23 Aug 2026) — the *code* was already correct: `environment.ts` and `environment.prod.ts` both point at epaper, `environment.staging.ts` at nepaper. Only the comment in `config.ts` was wrong. Corrected, with the staging line added and the grep command for checking which host a built bundle targets. No behaviour change.
- [ ] **P1-5 · Turn on the four plugin flags** — `S`
  `OPTION_STATIC_SNAPSHOTS`, `OPTION_INLINE_INDEX`, `OPTION_PRELOAD_LCP`, `OPTION_UPLOADS_CACHE` (`digital-newspaper.php:394-397`, all default `false`).
  ⚠ **blocked by** P1-1, P1-2, P1-3, P1-4.
  **Why:** collapses the cold-load chain from 6 network round trips to 2. The code is already written, shipped and reviewed.
  **Done when:** `dn-initial-state` in the served HTML is non-empty, an LCP `<link rel=preload as=image>` is present, and the image request appears on round trip 2 in a cold-cache waterfall.
  **Rollback:** each flag is independently toggleable; `on_*_toggled` handlers strip their injected blocks on disable.
  **Status: BLOCKED ON SAZZAD** (23 Aug 2026) — every code prerequisite (P1-1, P1-2, P1-3, P1-4) plus P1-6 is shipped, so this is now four checkboxes in **WP Admin → Settings → Digital Newspaper**. Enable in this order, checking the site after each: (1) *Static JSON Snapshots* — the other two depend on it; (2) *Image Cache Headers*; (3) *Preload First-Page Image*; (4) *Inline Bootstrap State* — biggest win and biggest payload change, so last. Verified in code: `resolve_index_html_path()` already detects `index.csr.html`, so the injection will find the served shell.

- [x] **P1-6 · Fix the three bugs in `build_first_page_preload_block()`** — `M`
  (a) high-priority the full image, not the thumbnail; (b) emit `imagesrcset`/`imagesizes` when variants exist; (c) anchor the injection after the viewport meta rather than before `</head>`, so it lands ahead of the font preloads.
  `digital-newspaper.php:2179-2213, 2152`
  **Why:** as written it deprioritizes the LCP element, and it becomes a guaranteed full double-download the moment P2-1 populates `imageVariants`.
  **Done when:** the preload href matches exactly what `<picture>` selects, at `fetchpriority=high`, positioned before the font preloads.
  **Status: DONE** (23 Aug 2026) — (a) the full-page image is now emitted FIRST at `fetchpriority="high"`; (b) when `imageVariants.avif`/`.webp` are populated the block emits `imagesrcset` + `imagesizes` + `type` instead of the plain href, so the preload resolves to the same candidate `<picture>` picks and cannot double-download (AVIF wins when both exist, matching source order; unsafe srcset entries fall back to the plain href); (c) injection moved from just before `</head>` to immediately after the viewport meta — verified against the real `src/index.html`, it now lands at byte 314 instead of after the font preloads. Also corrected a comment left stale by P1-2.
  **Deliberate deviation:** the spec said to demote the thumbnail to `fetchpriority="low"`. It is left at **default** instead. Until P1-7 lands, the main image still renders at `opacity: 0` until load, so it is not an LCP candidate at all and the *thumbnail* is what LCP measures — demoting it would have made LCP worse. Once P1-7 ships, lowering the thumbnail to `low` becomes safe and is worth doing. **Resolved 24 Aug 2026 as part of P1-7** — the thumbnail preload is now `fetchpriority="low"`.
  24 assertions; the 82 earlier P0-1/P0-3/P0-4/P1-2 assertions still pass.

### Front-end quick wins

- [x] **P1-7 · Fix the `fetchpriority` inversion and the opacity ramp** — `S`
  Swap `fetchpriority` between `newspaper.component.html:621` (placeholder → `low`) and `:662` (main image → `high`); replace `[style.opacity]` at `:668` with a `visibility`-based class; delete `transition: opacity 0.3s ease` from `newspaper.component.css:1021`.
  **Why:** an element at `opacity: 0` is not an LCP candidate at all, so Chrome currently measures the *blurred placeholder*, and the 300 ms ramp adds pure measurement penalty.
  **Done when:** a Lighthouse trace names `.main-page-image` as the LCP element.
  **Status: DONE** (24 Aug 2026) — blur-up thumbnail now `fetchpriority="low"`; the main `<img>` is unconditionally `fetchpriority="high"` (the old `mainThumbSrc ? 'auto' : 'high'` expression deprioritized it in exactly the case that matters). `[style.opacity]` replaced by `[class.is-pending]="!imageLoaded"` → `.main-page-image.is-pending { visibility: hidden }`, and the `transition: opacity 0.3s ease` is gone. The placeholder keeps its 0.4 s fade-*out*, so the reveal still looks like a crossfade. Error paths are unaffected: both `onImageError()` exits set `imageLoaded = true`, so the `is-unavailable` fallback is visible. Also completed the P1-6 deviation below — the thumbnail *preload* (`digital-newspaper.php:2268`) is now `fetchpriority="low"`, which is safe now that the main image is a real LCP candidate.
  **Verify in the browser:** a Lighthouse/DevTools trace must name `.main-page-image` (not `.main-page-thumb-placeholder`) as the LCP element — not verifiable from code alone.

- [x] **P1-8 · Stop the service worker prefetching the admin bundle** — `S`
  Split the `app-shell` group in `ngsw-config.json:19-29`; move `/chunk-*.js` into a separate `installMode: lazy` group. Delete the dead `/index.html` entry at `:24` while you're in there.
  **Why:** the `/*.js` glob expands to both admin chunks — ~214 KiB brotli background-downloaded by every reader on install *and* on every release, exactly undoing `AuthAwarePreloadingStrategy`.
  **Done when:** the generated `ngsw.json` `app-shell.urls` contains no `chunk-GDV5J4TR` / `chunk-5HGGXWUV`.
  **Trade-off, accept knowingly:** `chunk-3E2P4WFJ.js` (Angular core) also moves to lazy. Identical on first visit — it's on the critical path anyway.
  **Status: DONE** (24 Aug 2026) — `app-shell` keeps `/*.css` + `/*.js` but now ends with `!/chunk-*.js` (the generator's glob matcher supports `!` negation, and negations must follow the positives they subtract from); a new `app-chunks` group takes `/chunk-*.js` at `installMode: lazy`. Group order matters — the generator claims files for the first matching group, so `app-shell` must stay above `app-chunks`. Dead `/index.html` entry removed; the surviving `"index": "/index.html"` at `:3` is **not** dead — the builder rewrites it, and the generated `ngsw.json` reads `index: /index.csr.html`.
  **Verified** against a real production build: `app-shell.urls` is now `index.csr.html`, `main-*.js`, `polyfills-*.js`, `styles-*.css` and the three icons — no `chunk-*`. The two admin/editor chunks that every reader used to background-download are **167,510 B + 51,705 B brotli (~214 KiB, matching the estimate)**; they are now never fetched unless someone actually opens the admin route.
  **One deviation:** `updateMode` is `prefetch`, not `lazy`. With `installMode: lazy` a chunk that was never requested is never cached and therefore never updated, so readers still never see the admin chunks — but the Angular-core chunk, once cached, keeps updating eagerly on each release instead of decaying to a network fetch. Mirrors the existing `assets` group.
  **Known nuance, not a regression:** on a *first* visit the core chunk is requested before the SW controls the page, so it lands in the cache on visit 2. A user who visits exactly once and then goes offline gets the shell but not the core chunk. Previously the install prefetch covered this — at the cost of ~214 KiB of admin JS for every reader on every release.

- [x] **P1-9 · Trim the font preloads** — `S`
  Drop `latin-ext` (21,412 B — covers Latin Ext-A/B and IPA, which this site never renders); drop the `latin` *preload* and let it load from CSS; subset the Bengali variable font and instance the `wght` axis.
  `index.html:42-44`, `styles.css:8-33`
  **Why:** 133,328 B currently sits at *Highest* priority, above the module scripts that trigger the LCP image request.
  **Done when:** the preload budget is ~55 KB and no glyph renders in a fallback font on the reader route.
  ⚠ **Watch out:** fonts are deliberately *not* content-hashed and carry a 1-year cache — version the path (`/assets/fonts/v2/…`) or returning visitors are stranded on the old file. See P2-8.
  **Status: DONE as scoped** (24 Aug 2026) — preloads trimmed; **the subsetting half of this item is withdrawn, it has no headroom.** `index.html` now preloads *only* the bengali face; the latin and latin-ext `@font-face` rules are untouched in `styles.css`, so those files are still served — just discovered from the stylesheet and fetched only when a glyph in their `unicode-range` actually renders. Preload budget: **133,328 B → 75,712 B (−57,616 B, −43%)**, verified in the built `index.csr.html`, which now contains exactly one preload link. No font bytes changed, so **P2-13 does not apply to this change** — nothing to version, no cached client stranded.
  **Why the ~55 KB target is unreachable** (measured with fontTools 4.63 against the real files):
  - `google-sans-bengali-wght-normal.woff2` has **421 glyphs but only 101 cmap entries** — the other 320 are conjuncts reached through GSUB, i.e. exactly what Bengali shaping needs. Re-subsetting to the CSS `unicode-range` yields **75,712 → 73,824 B (−2.5%)**; adding `--no-hinting --drop-tables+=STAT,avar` gets 73,568 B. Not worth a committed binary, a regeneration script and a versioned path for 2 KB.
  - The `wght` axis is **already** `400–700`, matching the `font-weight: 400 700` declaration, so there is nothing to instance — restricting it to `400:700` produces 75,636 B, i.e. no change.
  - `wght` is also already the smallest fontsource variant: `grad` 76,136 B, `standard`/`opsz` 120,912 B, `full` 121,500 B.
  **The one way to reach ~43 KB — rejected 24 Aug 2026, do not revisit without new evidence:** pin static instances (bengali **wght 400 = 43,644 B**, **wght 700 = 46,028 B**), preload 400, let 700 load from CSS. Rejected because:
  1. `.newspaper-title` (`newspaper.component.css:94-98`) is the 28 px bold Bengali masthead, above the fold. It would render in a fallback face on every cold load until the second file landed — the largest text on the page, reflowing when the swap happens. That is a **CLS regression traded for an LCP gain**, while P1-10/P1-11 are simultaneously trying to pull CLS down. 18 more bold/600 declarations exist in the same stylesheet.
  2. The 32 KB "saved" is mostly bookkeeping: the bold file is not preloaded but is still requested during first layout, so it lands inside the same window as the image — one priority tier lower, not one round trip later.
  3. Total bytes go **up** ~14 KB for any reader who sees bold text, which is all of them.
  The single variable file stays. `-43%` on the preload budget is the win this item ships.

- [x] **P1-10 · Reserve ad-slot height before `/ads/config` resolves** — `S`
  Render a placeholder with the slot's declared dimensions in the `!adService.ready()` branch, using a static map mirroring `gam_ad_slots()` (`digital-newspaper.php:594-685`). Remove `!slot()` from the `dn-ad--hidden` host binding at `ad-slot.component.ts:54` or the placeholder itself gets `display: none`.
  **Why:** slots render 0 px then jump to 250 px — likely the single largest CLS contributor.
  **Done when:** CLS attribution no longer names an ad container.
  **Status: DONE** (25 Aug 2026) — the placeholder lives inside `AdSlotComponent`, so it covers every call site at once. `RESERVED_SIZES` (`ad-slot.component.ts:17-38`) mirrors all nine `gam_ad_slots()` entries; the template's new `@else if (!adService.ready() && reservedSize())` branch renders a box with the same `dn-ad-container` class and the declared min-width/min-height, deliberately **without** the `#adContainer` ref so the GPT display script can never be injected into it. Host binding is now `adService.ready() && (!slot() || !slot()!.enabled) || removedByBrowser()`.
  **Verified against the live endpoint** (`/ads/config`, 25 Aug 2026): all nine ids and both dimensions match the static map exactly. In a headless Chrome measurement the reserved box and the real container render **identical 100 px heights**, so the swap at `ready()` is shift-free.
  **Scope correction — the reader route was already handled, the middle column was not.** `newspaper.component.html:360` already gates `desktop_page_left` on `!adService.ready()` and renders nothing, and `:928` renders a `.placeholder` for `desktop_page_right`; both sit in fixed-width columns (`.left-panel` is `width: 200px; overflow-y: auto`), so neither could shift page content anyway. The slots that actually expand in flow are the five `desktop_post_*` ones in `.section-image-container` and the article modal — and per the live config **all five are enabled**, so the placeholder is never wasted reservation. The three disabled slots cannot cause a reserve-then-collapse shift: `desktop_page_left` never renders `<app-ad-slot>` pre-ready, and `mobile_post_top` / `mobile_post_middle` are not referenced by any template.
  **Bug found and fixed in passing:** `:host(.dn-ad--hidden)` was `(0,2,0)`-specific and sat *above* the equally-specific `@media (min-width: 768px) { :host(.dn-ad--desktop) { display: block } }`, so it lost on source order. Every slot on this site is a `desktop_` slot, which means **the Heavy Ad Intervention collapse path (`removedByBrowser`) never worked on desktop** — measured: a hidden desktop slot computed `display: block` and held 250 px of blank space. Now `:host(.dn-ad--hidden.dn-ad--desktop)` / `.dn-ad--mobile` compounds take it to `(0,3,0)`; re-measured at `display: none`, 0 px.
  **Verify in the browser:** the done-when (CLS attribution no longer naming an ad container) needs a field/Lighthouse trace on the real site.

- [x] **P1-11 · Move the ad `MutationObserver` outside the Angular zone** — `S`
  `ad-slot.component.ts:167-186` — wrap in `zone.runOutsideAngular()`, re-enter with `zone.run()` only for the signal write.
  **Why:** `{childList: true, subtree: true}` on a GPT container fires dozens to hundreds of times during SafeFrame construction, each triggering a full app tick.
  **Done when:** a performance profile during ad load shows no change-detection cycle per mutation.
  **Status: DONE** (25 Aug 2026) — `_observeForHeavyAdRemoval()` now constructs and starts the observer inside `zone.runOutsideAngular()`, which is what matters: zone.js binds a `MutationObserver` callback to whichever zone was current *at construction*, not at fire time. The only re-entry is `zone.run(() => this.removedByBrowser.set(true))` on the Heavy-Ad path, and `observer.disconnect()` moved above it so the observer is already detached when the tick runs.
  **Verify in the browser:** a performance profile during a live ad load — not observable from code.

- [ ] **P1-12 · Stop cloning ~1,000 sections per render** — `S` — **WON'T DO, see the verification pass above**
  `newspaper.component.ts:540-545` — set `pageId` in place and store the reference instead of `{ ...section, pageId }`. Safe: the objects come straight from `JSON.parse` and nothing else aliases them.
  **Done when:** `renderCurrentEdition()` allocates no per-section copies.
  **Status: REVERTED** (25 Aug 2026) — shipped, then backed out the same day when verification showed the "nothing else aliases them" premise is false. Details in the verification pass above. The spread stays, with a comment on the loop explaining why it must not be optimised away. What follows is the original, now-obsolete status note: — the loop now does `section.pageId = page.id` and stores the reference. Two checks before committing to the mutation: a repo-wide grep for assignments to any `NewsSection` field found **exactly one** (the new line — nothing else in the component tree writes to section objects, so nothing can leak through the shared reference), and **the server already sends `pageId` on every section** (`digital-newspaper.php:1464`), so no new field is introduced and the admin save path is untouched. `pageId?: number` was already part of the `NewsSection` model.

- [x] **P1-13 · Gate the version poll on `visibilityState`** — `S`
  `newspaper.component.ts:322-336` — don't re-render while the tab is visible and the user is reading; stop the poll entirely while hidden.
  **Why:** every 5 minutes a reader mid-article can take a 50–150 ms long task, and a backgrounded tab fires ~96 pointless requests per 8 hours.
  **Done when:** no reload fires while the tab is visible and a modal-free read is in progress; the interval is cleared on `visibilitychange` → hidden.
  **Status: DONE** (25 Aug 2026) — three parts:
  1. `remoteDataChanged$` no longer reloads. It records the version in `_pendingRemoteVersion`; `applyPendingRemoteChange()` spends it on the next hidden → visible transition, still behind the existing modal guard (guarded versions stay pending and retry on the following return).
  2. `visibilitychange` → hidden calls `stopVersionPoll()`; → visible restarts it. The initial `startVersionPoll()` is now also gated on `visibilityState !== 'hidden'`, so a tab opened in the background (cmd-click, session restore) never polls until it is looked at.
  3. Returning readers would otherwise wait a full 5 minutes for the restarted interval's first tick, so `NewspaperDataService` gained `checkVersionNow()` — a one-shot check that emits on `remoteDataChanged$` exactly like a poll tick and resolves when settled. The poll and the one-shot now share one private `checkRemoteVersion()`. `startVersionPoll(intervalMs)` keeps its signature, so `admin.component.ts:653` is unaffected.
  Cleanup: the listener is removed and the in-flight check unsubscribed in `ngOnDestroy`; a second focus cancels a still-pending check rather than stacking subscriptions.
  ⚠ **Behaviour change, accepted:** a reader who never backgrounds the tab now never auto-refreshes. For a daily e-paper that is the right trade — new editions arrive on any tab switch, navigation or reload — but it *is* a change from "refreshes silently every 5 minutes".
  **Verify in the browser:** switch tabs with the network panel open — no `/data/version` while hidden, one immediately on return.

- [x] **P1-14 · `manifest.webmanifest`: `display: "standalone"`** — `S`
  Also add `id`, `scope`, `orientation`, `screenshots`, `shortcuts`, and split the icon set into separate `any` and `maskable` entries.
  **Why:** one field is suppressing `beforeinstallprompt` despite 8 correct icons, a working service worker and an update banner all being in place.
  **Done when:** Chrome offers the install prompt.
  **Status: DONE** (25 Aug 2026) — `display: "browser"` → `"standalone"`, plus `id: "/"`, `scope: "/"`, `orientation: "any"` (an e-paper should never lock rotation — readers turn the device to read a full page). Verified in the built output: `display: standalone`, 192 px and 512 px icons both present at `purpose: any`, which is Chrome's installability bar.
  **`screenshots` are real captures, not placeholders:** `src/assets/screenshots/reader-wide.jpg` (1280×800, `form_factor: wide`) and `reader-narrow.jpg` (390×844, `narrow`), taken from the live site in headless Chrome and encoded at JPEG q65 (232 KB + 129 KB). Both aspect ratios sit inside Chrome's 2.3:1 limit for the richer install dialog, and the declared `sizes` match the files. They land in the service worker's lazy `assets` group, so no reader downloads them unless the install dialog opens. They will date — re-shoot when the reader UI changes materially.
  **`shortcuts` has one entry** ("সর্বশেষ সংখ্যা" → `/`). There is no second useful target: the only other routes are `:date/:page/:edition`, which is inherently dynamic and cannot be a static shortcut, and `/admin`, which has no business in a reader's app menu.
  **Deviation — the `maskable` half is deliberately dropped, and the previous state was worse than "missing".** All eight icons were declared `purpose: "maskable any"`, but the asset is a full-width wordmark ("সংগ্রাম / THE DAILY SANGRAM") that runs edge to edge horizontally on white. Under a maskable safe zone — content inside the centre 80% circle — Android was cropping the first and last glyphs of the logo. All eight are now plain `purpose: "any"`, which costs nothing for installability and stops the cropping. A true maskable icon needs a **designed** asset (mark or monogram inset into the safe zone on a brand-colour field); mechanically shrinking the wordmark to ~56% to fit the circle would make it illegible at 192 px. Asset task, not a code task.
  **Verify in the browser:** Chrome should now offer the install prompt, and DevTools → Application → Manifest should list both screenshots with no warnings.

### SEO — the two that actually matter

- [x] **P1-15 · Add search crawlers to the prerender UA set; remove `Googlebot-Image`** — `S`
  Define the UA sets once via `mod_setenvif` (the list is currently duplicated verbatim five times at `.htaccess:16, 17, 59, 64, 69`), then replace the three `RewriteCond %{HTTP_USER_AGENT}` lines with `RewriteCond %{ENV:IS_PRERENDER_BOT} =1`. Widen `Vary: User-Agent` to *all* responses, not just bot ones (`:222-224`).
  ⚠ **Do not ship without P1-16.**
  **Why:** Googlebot currently receives a 9,728-byte shell with zero content words on every URL; Googlebot-Image receives a `noarchive` redirect page, which is a cloaking signal *and* blocks Google Images.
  **Done when:** `curl -A 'Googlebot/2.1' <article-url>` returns real article text.
  **Status: DONE** (25 Aug 2026), shipped together with P1-16 as required. Five duplicated UA lists collapsed into **three `SetEnvIfNoCase` lines**: `IS_SOCIAL_BOT`, `IS_SEARCH_BOT`, and their union `IS_PRERENDER_BOT` (built in two passes — `SetEnvIf` cannot read an env var set by the same directive). The rewrite conditions are now `%{ENV:IS_…}`, each `[OR]`-chained with its `REDIRECT_IS_…` twin so the rules still match if the ruleset re-enters after an internal rewrite. `Googlebot-Image` is in **neither** set: an image crawler needs image bytes, so it now falls through to normal static handling instead of getting a noarchive redirect stub.
  **Two deliberate narrowings of the spec:**
  - The **homepage rule stays social-only.** Sending a search crawler to a site-level OG stub with no article text in it would be a thin indexable page; the existing root handling (prerendered `index.html` if present, app shell otherwise) is strictly better. The item's own done-when is about an *article* URL.
  - `Vary: User-Agent` was added to the **shell responses** (`^index(\.csr)?\.html$` and `\.html\.(?:br|gz)$`) rather than literally every response. Those are the URLs whose body now depends on UA; adding it to 1-year-cached hashed assets would only cost CDN efficiency, and `/social` already sets the header itself.
  **Bug found by the UA test, pre-existing:** the social list contained a bare `Xbot`, which — matched case-insensitively — also matches **Yande**`xBot`. Yandex has been receiving the social OG stub with `Cache-Control: no-store` instead of indexing the site. Now `\bXbot`.
  **Verified:** a 19-case table of real crawler UA strings (Googlebot desktop/mobile/News, AdsBot, Googlebot-Image, bingbot, Applebot, YandexBot, DuckDuckBot, Baiduspider, Yahoo Slurp, facebookexternalhit, WhatsApp, Twitterbot, Xbot, LinkedInBot, TelegramBot, plus real Chrome and Safari) is classified correctly, with **no UA in both sets**, and the PHP-side test agrees with the `.htaccess` sets on every row. Both regexes are read out of the two files at test time, so the test cannot drift from them. Container tags balanced, no dangling `RewriteCond`.
  ⚠ **Smoke-test right after deploy — this is the one part I cannot verify from here.** `%{ENV:…}` in a `RewriteCond` depends on the host honouring `SetEnvIf` before the rewrite phase; on LiteSpeed a failure would be **silent**, and the symptom is broken WhatsApp/Facebook link previews. Check both kinds immediately:
  `curl -sA 'facebookexternalhit/1.1' <site>/ | grep -c og:image` → expect ≥1
  `curl -sA 'Googlebot/2.1' <article-url> | grep -c '<article>'` → expect 1
  If the social one returns 0, revert to literal `RewriteCond %{HTTP_USER_AGENT} "…"` conditions (the UA lists in the `SetEnvIf` block are the source to copy from) — the PHP side needs no change.

- [x] **P1-16 · Make `/social` a legitimate dynamic-rendering endpoint** — `M`
  For search-bot UAs: emit the real article body, drop the `window.location.replace()` (`digital-newspaper.php:3546`), drop `X-Robots-Tag: noarchive` (`:3354`), add `<meta name="description">` and a canonical.
  ⚠ **hard dependency of** P1-15 — shipping P1-15 alone means serving crawlers a redirect stub, which is worse than the status quo.
  **Why:** Google sanctions dynamic rendering when the content matches what the SPA renders. Serving structured data and then bouncing the crawler is cloaking.
  **Done when:** the bot response and the rendered SPA page contain equivalent text.
  **Status: DONE** (25 Aug 2026). `social_sharing_endpoint()` now builds **two** documents for an article URL, chosen by `dn_is_search_crawler()`:
  - *Search crawlers* get `<article>` with an `<h1>`, the date, the section image as a `<figure>`, and the real body — the section's own `content` HTML run through `wp_kses_post()` (the endpoint is publicly reachable by anyone sending a crawler UA, so the admin-entered markup is sanitised rather than echoed raw), falling back to the plain-text copy when the markup strips to nothing. Plus `<meta name="description">` and `<link rel="canonical">`. **No `window.location.replace()`**, and `dn_serve_social_html()`'s new third argument suppresses `X-Robots-Tag: noarchive` for this variant only.
  - *Card crawlers* get byte-for-byte what they got before, redirect stub and `noarchive` included. They never run JS, and their OG-tag path was already correct — there was nothing to gain by changing it and a live link-preview regression to lose.
  **Three things the naive version would have got wrong, all fixed:**
  1. **The transient key now includes the bot kind.** Without it a cached card-crawler stub would be served to Googlebot — content-free *and* carrying a JS redirect, i.e. precisely the cloaking this item exists to remove.
  2. **The cached entry carries its own `indexable` flag** (`['html' => …, 'indexable' => bool]`, with plain strings honoured as legacy non-indexable entries). Re-deriving indexability from the UA on a cache hit would have served a *stub* without `noarchive` whenever the cached search-variant request had failed to find its section.
  3. **`$found && $body !== ''` guards the indexable branch.** The site-level fallback path leaves the title as the site name and the body empty; emitting that as archivable would add a thin, duplicate URL to the index for every mistyped slug. Those fall through to the ordinary noarchive stub.
  **Verified** by extracting the emitted template straight from the plugin source and rendering it with realistic Bengali values: `<h1>`, real body text, `<meta name="description">`, `<link rel="canonical">`, `og:type=article`, no unsubstituted `{$var}` placeholders, and **no** `window.location.replace` — 22 words of visible body text where the shell previously had zero. The only parse complaints are libxml2's HTML4 parser not knowing `<article>`, `<time>` and `<figure>`; real crawlers parse HTML5.
  **Verify against the live site after deploy:** `curl -A 'Googlebot/2.1' <article-url>` should return the article text, and Search Console's URL Inspection should render it. Google's own guidance is that the crawler copy must match what users see — if the SPA's article text ever diverges from `section.content`, this endpoint diverges with it.

**P1 exit criteria:** cold-load LCP image on round trip 2; Googlebot receives real HTML; CLS free of ad-slot jumps; PWA installable.

---

## P2 — Correctness, hygiene, quality floor

### The biggest remaining perf item

- [x] **P2-1 · Generate server-side AVIF/WebP width variants** — `M`
  On upload, produce 2–3 widths (800/1200/1600) via `wp_get_image_editor` (Imagick is already used in the social path) and write them into `imageVariants`.
  **Why:** the client-side `<picture>` pipeline at `newspaper.component.html:649-670` is **fully dead code** — nothing populates `.avif`/`.webp`, so `<source>` renders empty and every device downloads the single full-size scan. The front end lights up with **zero client changes**.
  **Done when:** `imageVariants.webp` is non-empty for a newly uploaded page and a narrow viewport downloads a smaller file than a wide one.
  ⚠ **Coordinate with P1-6(b)** — once variants exist, the preload must be variant-aware or it becomes a wasted full download.

  **Status: DONE, with a different ladder than specified** (25 Aug 2026). The `<picture>` pipeline is now live and every device profile downloads fewer bytes than before. Zero client changes beyond one `sizes` correction.

  **The 800/1200/1600 ladder was wrong and was not built.** It assumed readers download the original scan. They do not: `admin.component.ts:3996` already resizes the display copy to **700px** (`resizeImageToWidth(originalFile, 700, …)`) before upload, so 1200/1600 could only come from upscaling — and even sourced from the hi-res original they'd make the LCP element *heavier* than today. Shipped instead (`DN_VARIANT_LADDER`): **AVIF 400/600/800 @ q58, WebP 400/600/700 @ q80**. WebP stops at 700 deliberately — 800w WebP is 297 KB, *more* than the 271 KB those same browsers download today.

  **Measured, 2400×3400 dense-text Bengali page** (baseline = today's single 700w WebP q88 = **271 KB**):

  | width | AVIF q58 | WebP q80 |
  |---|---|---|
  | 400w | 65 KB | 79 KB |
  | 600w | 143 KB | 172 KB |
  | 700w | 185 KB | 226 KB |
  | 800w | **245 KB** | 297 KB ✗ |

  Rejected with numbers: **1100w = 300 KB (+11%)**, **1400w = 540 KB (+99%)**. The ladder stops at 800 because the desktop centre panel is 800 CSS px (1600 site − 200 left panel, then 12/21 of the remainder). Retina screens are deliberately served below their device-pixel count; closing that gap costs 2× on the LCP element. The zoom modal remains the path to full detail.

  **Real-browser verification** (Chrome 151 via CDP `setDeviceMetricsOverride`, 11 device profiles, emulated `innerWidth` asserted to match). Every profile is under the 271 KB baseline:

  | profile | slot × DPR | picked | bytes |
  |---|---|---|---|
  | narrow DPR1 380css | 380 | `dnv400.avif` | 65 KB (**−76%**) |
  | Android DPR1.5 360css | 540 | `dnv600.avif` | 143 KB (**−47%**) |
  | iPhone SE 375×2 | 750 | `dnv800.avif` | 245 KB (−10%) |
  | iPhone 14 Pro 393×3 | 1179 | `dnv800.avif` | 245 KB (−10%) |
  | Android DPR1.75/2 412css | 721/824 | `dnv800.avif` | 245 KB (−10%) |
  | iPad 768×2 / 1024×2 | 1506/2018 | `dnv800.avif` | 245 KB (−10%) |
  | laptop/desktop DPR1 & retina | 800/1600 | `dnv800.avif` | 245 KB (−10%) |

  **The 600 rung exists because of this emulation.** The first implementation shipped 400/800 only; emulation showed **every mainstream device took the 800w file** and the 400 rung won on nothing, because a browser needs `slot-CSS-px × DPR` (≥ 540 on the narrowest phone still sold). Bytes scale with pixel count, so the gap was a cliff, not a ladder. 600 covers the whole DPR-1.5 phone band at 143 KB instead of 245 KB — a 42% cut for a large slice of real traffic that 400/800 missed entirely. 400 is kept for the DPR-1 tail (narrow desktop windows, DPR-1 webviews), which the `narrow DPR1` row confirms is real.

  **`sizes` was wrong on both sides and is fixed:** `1600px` → `900px` in `newspaper.component.ts` (`updateMainImageSources()`) and in the plugin's `dn_build_preload_links()`. `1600px` described the whole site, not the image's slot, making the browser ask for a candidate twice the size it renders. 900px is the real upper bound (centre panel with the left panel collapsed). These two must stay in step with each other and with the CSS.

  **Security hardening found while testing:** `dn_uploads_url_to_path_any_host()` returns `basedir . '/../../../etc/passwd'` for a crafted URL, which still passes a `$baseDir . '/'` string-prefix test — an authenticated editor could have written `-dnv400.avif` siblings outside the uploads tree, or re-encoded any server-readable image into a public URL via `fullImageHiRes`. New `dn_uploads_relative_path()` uses `realpath()` + `is_file()` + prefix test, applied to **both** `fullImage` and `fullImageHiRes`. Proved with a real 1200px JPEG decoy planted outside uploads and an assertion that nothing was written there.

  **Where it runs:** `put_page_endpoint()`, after the lock check (a rejected save spends no CPU encoding). Client-supplied `imageVariants` is discarded outright — srcsets may only name files this server wrote. Best-effort throughout: any failure yields fewer entries and the viewer falls back to the plain `<img src>`. Generation is idempotent (`file_exists` short-circuit): **1327 ms first save, ~1 ms on re-save** (GD locally; the host has Imagick).

  ⚠ **Backfill:** only pages saved through `PUT /data/page` get variants. Historical pages keep serving the single image until re-saved — no regression, just no gain.

  **Tests:** 38/38 assertions across three suites (happy path + byte assertions, edge cases, path traversal), run against the real methods extracted from the plugin. `php -l` clean.
  **Not verified:** the WebP-only path in a real non-AVIF browser (selection math is format-independent and the 226 KB worst case is asserted by file size); Imagick-vs-GD encode time on the production host.

### Deploy correctness

- [x] **P2-2 · Decide SSR: delete it or prerender `/`** — `M`
  Either remove `server.ts`, `main.server.ts`, `app.config.server.ts`, the SSR `angular.json` keys and the 6 unused server deps (`express`, `cors`, `helmet`, `compression`, `express-rate-limit`, `@types/express` — four of which are imported nowhere) — or commit to P3-6.
  **Why:** currently built and shipped every deploy, never executed. Honest either way; the middle ground is pure cost.
  **Done when:** either `dist/` has no `server/` directory, or a Node process actually serves it.

  **Status: DONE — deleted** (25 Aug 2026)

  **Decision: delete, not prerender.** Prerendering `/` cannot be done inside this item, and SSR could never have contributed anything:
  - `app.config.server.ts` routed `''` and `admin` at `RenderMode.Client` — only `**` was `RenderMode.Server`. The root route, the only one that matters for LCP or SEO, was explicitly opted *out* of server rendering. A comment there claimed Client mode "emits a static index.html app shell"; it does not — it emits the same empty shell, renamed.
  - The build reported **"Prerendered 0 static routes"** and `prerendered-routes.json` was `{"routes":{}}`.
  - The host is shared LiteSpeed/WordPress with no Node process, so `server/` (3.0 MB of bundles) was uploaded into the public web root every deploy and never executed.
  - Prerender is blocked on the Imunify360 cookie: prerendering calls `loadNewspaperData()` → the WordPress API → the build machine has no cookie → empty routes. That is **P3-6, size `L`** — it cannot be smuggled into an `M`.

  **Measured:**

  | | before | after |
  |---|---|---|
  | `npm run build` (warm cache) | 85.37 s | **16.23 s** (−81%) |
  | `dist/**/server/` | 3.0 MB | **absent** |
  | `3rdpartylicenses.txt` | 144 K | **58 034 B** (−60%) |
  | initial transfer | 147.25 kB | **144.22 kB** (−3.03 kB) |
  | locked packages | 999 | **995** |

  Client bundles are byte-identical across the SSR removal itself; the −3.03 kB comes from also dropping the now-dead `provideClientHydration()` (`app.config.ts`) — with no server render its HTTP transfer cache is always empty, and the plugin's inline bootstrap state is read by element id, not through `TransferState`.

  **Deviation — `express` is NOT unused, so 5 packages were removed, not 6.** `webhook-server.js:1` does `require('express')`, so it stays in `package.json`. Removed: `@angular/ssr`, `@angular/platform-server`, `helmet`, `cors`, `compression`, `express-rate-limit`, `@types/express` as *direct* deps. The last four remain in the tree as transitive deps of the toolchain (`cors`/`express-rate-limit` ← `@angular/cli` → `@modelcontextprotocol/sdk`; `compression`/`@types/express` ← `build-angular` → `webpack-dev-server`), so only `@angular/ssr`, `@angular/platform-server`, `helmet` and `xhr2` (platform-server's dep) actually left `node_modules`.

  **Consequence the plan didn't mention — the shell is renamed.** With `ssr.entry` present the builder renames the browser shell to `index.csr.html`; without it the shell is emitted as `index.html`. Fixed in `src/.htaccess` (root rule, catch-all, `FilesMatch`, br/gz comments), `ngsw-config.json:24`, and `tsconfig.app.json`. Verified first that `deploy.js:386`, `scripts/promote-ngsw-boot-chunks.js` and the plugin's `resolve_index_html_path()` already tolerate both names. The `.htaccess` root block also collapsed from two tiers to one: it used to prefer a "prerendered" `index.html` over an `index.csr.html` fallback, but the `-f` guard could never pass because nothing ever wrote a prerendered file.

  **Fixed in passing: `npm ci` was already broken at HEAD.** The committed lock was internally inconsistent — `@angular/platform-server@21.2.17` requires peer `@angular/common@21.2.17` but the lock pinned `common@21.1.3`, so `npm ci --dry-run` on a pristine `git show HEAD:` checkout fails with ERESOLVE today, independent of this change. Removing platform-server removes that conflict. `npm install`/`npm prune` could not prune around it, so the lock was regenerated; a plain re-resolve moved the **entire** Angular toolchain 21.1.3 → 21.2.21 (permitted by `^21.0.0`, 999 → 1022 packages), which is an unrelated framework upgrade and was **rejected** — a `--legacy-peer-deps` reinstall from the original lock produced the surgical result instead: 4 packages removed, **0 added, 0 version changes**.
  ⚠ **One pre-existing skew remains and still breaks `npm ci`:** `@angular/service-worker@21.2.16` needs peer `core@21.2.16`, but core is 21.1.3. Not fixed here — `ngsw-worker.js` ships to readers, so re-pinning it belongs in its own verified change, not as a rider on an SSR deletion. Fix is either pinning service-worker to 21.1.3 or taking the whole toolchain to 21.2.x deliberately.

  **Verified:** `dist/` has no `server/`; shell is `browser/index.html`; `ngsw.json` references only `/index.html`; `.htaccess` passes `httpd -t`; real Apache serves `/`, deep article routes and `/admin/` as the shell while serving real assets directly, crawler UAs still rewrite to the WordPress `/social` endpoint, and Brotli + `no-cache` still apply to `index.html`; headless Chrome boots the app with **0 uncaught exceptions** (`app-root` populated, splash hidden, title set).
  **Not verified:** production deploy — and it cannot help until **P2-3**, because `deploy.js:159-269` overwrites the deployed `.htaccess` with its own divergent inline copy.
  **Leftover, deliberately untouched:** the builder still emits an 18-byte `dist/digital-newspaper/prerendered-routes.json` (`{"routes":{}}`) with no SSR config at all. Harmless, and it was there before.

- [ ] **P2-3 · Point deploy at `dist/digital-newspaper/browser`** — `S`
  `deploy.js:136, 153, 412` and `.github/workflows/deploy.yml` currently copy the whole `dist/digital-newspaper` wholesale, so `browser/` lands as a subdirectory of the web root. Also stop overwriting `src/.htaccess` with the hardcoded copy in `deploy.js:159-269`, and drop the dead chmod loop at `:386`.
  ↻ Updated by **P2-2**: `server/` no longer exists, so this is now purely about the `browser/` nesting and the `.htaccess` overwrite. The inline copy's `/index.html` target is no longer wrong — it is now the *correct* name — but it still diverges from `src/.htaccess` in every other respect, so the real `.htaccess` work still never reaches production.
  **Done when:** the remote root contains `index.html` at top level and no `browser/` subdirectory.

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
  **Not needed yet** (24 Aug 2026) — P1-9 shipped by trimming preloads only; no font file changed, so no client is stranded. Do this the moment anyone re-subsets or swaps a face.

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
  ↻ **P2-2 took the "delete SSR" branch**, so this item now starts by *re-adding* SSR rather than repairing it: `ng add @angular/ssr`, then set the root route to `RenderMode.Prerender` (it was `RenderMode.Client` before, which is why prerender produced nothing even when it ran). The `app.config.server.ts:14-19` reference is dead — that file was deleted; the Imunify360 rationale it documented is preserved in P2-2's status block above. Note that re-adding SSR renames the shell back to `index.csr.html`, which reverses the `.htaccess` / `ngsw-config.json` edits P2-2 made.

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
| 1 | Is `index.html` served compressed? (was `index.csr.html` before P2-2) | `curl -sI -H 'Accept-Encoding: br,gzip' <site>/ \| grep -i content-encoding` | validates P1-1 |
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

P1-9 ──→ P2-13   (moot: P1-9 shipped without changing any font bytes)

P2-21 ──→ P2-22

P3-5 ──→ P3-8

P2-2 ──── mutually exclusive with ──── P3-6
```

**Three traps worth repeating:**

1. **P1-5 before P1-1/P1-2** ships ~60 KB uncompressed *and* can serve stale HTML.
2. **P1-15 without P1-16** serves crawlers a redirect stub — worse than today.
3. **P1-9 without P2-13** strands returning visitors on the old font for up to a year.
