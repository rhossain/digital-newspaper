# Instant First-Image Load — Implementation TODO

**Goal:** make the first page's image (the LCP element) start downloading during HTML
parse, before Angular boots, and serve all edition images instantly on repeat/offline
visits — **without bundling images into the app, without daily rebuilds, and without
touching any newspaper data.**

**Companion to:** `ZERO_API_IMPLEMENTATION_NOTES.md`, `STATIC_SNAPSHOTS_DEPLOY_GUIDE.md`,
`PERFORMANCE_OPTIMIZATION_STRATEGY.md`.

**Date:** 2026-06-26
**Origin/host facts (verified):** App and WordPress media share **one origin** in each
environment — prod `https://epaper.dailysangram.com` + `/wp/`, staging
`https://nepaper.dailysangram.com` + `/wp/`. Same scheme/host/port ⇒ **no `preconnect`,
no `crossorigin` on the preload** (a crossorigin preload would mismatch the non-crossorigin
`<img>` and download the image twice).

---

## Design principles (non-negotiable — these are what guarantee nothing breaks)

1. **Additive + feature-flagged, default OFF.** Every change is inert until an operator
   opts in. With flags off, behaviour is byte-for-byte identical to today. Mirrors the
   existing `dn_inline_index_enabled` pattern.
2. **Read-path only — zero data writes.** The only filesystem write is the atomic
   temp-file+rename of the *served* `index.html` (the exact mechanism already proven by
   `maybe_inject_inline_state()`). `dn_data` / `dn_settings` / snapshots are never written
   by this feature ⇒ **no possible data loss.**
3. **Match the rendered element exactly.** The preload must resolve to the identical URL
   Angular sets on the page-1 `<img>` (via `resolveImageUrl()`), or the browser fetches
   twice. See Task 2.
4. **Preload exactly one image.** Only page-1's main image. Preloading thumbnails or more
   pages would contend with the LCP image for the 6-connection pool — the very problem the
   existing IntersectionObserver thumbnail lazy-loading solves. Don't undo it.
5. **Each phase independently reversible**, validated on staging before prod.

---

## Phase 1 — Publish-time LCP preload injection (the main win)

### Task 1.1 — Add an inert placeholder to `src/index.html`
Insert a bounded, **fetch-free** marker in `<head>` (after the font preloads). A bare
`<link rel="preload">` with no `href` can resolve to the document URL and cause a stray
fetch, so use comment markers instead — they never fetch when empty:

```html
<!-- Publish-time LCP image preload. Empty by default (no fetch). The WordPress
     plugin rewrites the region between these markers with a single
     <link rel="preload" as="image"> for the latest edition's page-1 image when
     dn_preload_lcp_enabled is on. -->
<!--dn-lcp:start--><!--dn-lcp:end-->
```

- [ ] Add the marker block to `src/index.html`. Harmless no-op until filled.
- [ ] Confirm the app boots normally with the markers present and empty.

### Task 1.2 — Add the PHP injector (new, parallels `maybe_inject_inline_state`)
In `digital-newspaper.php`:

- [ ] New option constant `OPTION_PRELOAD_LCP = 'dn_preload_lcp_enabled'` (default **false**).
- [ ] New private method `maybe_inject_lcp_preload(array $latestEditions): void`:
  - [ ] No-op if `get_option(OPTION_PRELOAD_LCP)` is false. Never throws (wrap in try/catch
        + `error_log`, same as the existing injector).
  - [ ] Resolve the served `index.html` via the **existing** `resolve_index_html_path()`
        (reuse — do not re-implement). Bail quietly if not found/writable.
  - [ ] Extract page-1's image URL from `$latestEditions`: first edition, pages sorted by
        `id` ascending, take `pages[0]['fullImage']`. Bail if empty.
  - [ ] **Security guard:** accept the URL only if it matches the expected uploads pattern
        for the current origin (`#^https?://<wp-host>/wp/wp-content/uploads/.+\.(webp|jpe?g|png|avif)$#i`,
        or a site-relative `/wp/wp-content/uploads/...`). Reject anything else — never inject
        an arbitrary/attacker-influenced URL into `<head>`. Run through `esc_url()` then
        `esc_attr()` for the attribute context.
  - [ ] Build the replacement string:
        ```html
        <link rel="preload" as="image" fetchpriority="high" href="<ESCAPED_URL>">
        ```
  - [ ] Replace the region between `<!--dn-lcp:start-->` and `<!--dn-lcp:end-->`
        idempotently with `start + <link…> + end` (regex `#<!--dn-lcp:start-->.*?<!--dn-lcp:end-->#s`).
        When the flag is OFF (or on rollback) write back the **empty** region so the link is
        removed. Re-runnable on every publish.
  - [ ] Write via the **existing `atomic_write()`** (temp-file + `rename`, `LOCK_EX`) — never
        a partial write to the live `index.html`.
- [ ] Call `maybe_inject_lcp_preload($latestEd['editions'])` in
      `regenerate_static_snapshots()` immediately after the existing
      `maybe_inject_inline_state($initialStateJson)` call (same `if ($latest …)` block, so it
      reuses the already-loaded latest edition — no extra DB read).
- [ ] **Bug-for-bug consistency:** the placeholder must be blanked when the flag is disabled,
      exactly like the inline-state blob is blanked — so toggling off cleanly removes the link
      with no rebuild.

### Task 1.3 — Admin settings control
- [ ] Add a checkbox **"Preload latest page-1 image (faster first paint)"** bound to
      `dn_preload_lcp_enabled`, next to the existing **Inline Bootstrap State** control.
- [ ] Show the same "index.html status: writable / placeholder found" hint the inline-state
      control already renders (reuse `resolve_index_html_path()` + placeholder detection).

> **Dependency note (must verify before shipping):** today `imageVariants` carries only
> `width`/`height`; the `avif`/`webp` srcset arrays are empty, so Angular renders the plain
> `<img [src]="fullImage">` and that single URL **is** the LCP. The preload therefore needs
> **no `imagesrcset`/`imagesizes`**. **If/when** the WebP/AVIF variant arrays start being
> populated (see `WEBP_IMPLEMENTATION_PLAN.md`), the `<picture><source>` will win over the
> `<img>` and this preload must be upgraded to carry matching `imagesrcset` + `imagesizes`
> (`(max-width: 1024px) 100vw, 1600px`) — otherwise it preloads a variant the browser won't
> use. Add a code comment at both the injector and `updateMainImageSources()` cross-linking
> this constraint.

---

## Phase 2 — Service-worker image caching (instant repeat + offline)

The current `assets` assetGroup matches only `/assets/**` and root-level images — **not**
`/wp/wp-content/uploads/**`, so edition images are re-fetched from the network every visit.
WP upload filenames are unique and immutable, so `cacheFirst` is safe (a new edition has new
filenames; stale images can't be served).

### Task 2.1 — Add an image dataGroup to `ngsw-config.json`
- [ ] Append to `dataGroups`:
      ```json
      {
        "name": "wp-edition-images",
        "urls": ["/wp/wp-content/uploads/**"],
        "cacheConfig": {
          "strategy": "performance",
          "maxSize": 250,
          "maxAge": "30d",
          "timeout": "10s"
        }
      }
      ```
  - `strategy: performance` = cacheFirst (instant when cached, network on miss).
  - `maxSize` caps stored images (LRU eviction) so storage can't grow unbounded — tune to
    typical pages-per-edition × a few editions.
- [ ] Confirm `navigationUrls`' `!/wp/**` is unaffected — it governs **navigation** routing
      only, not dataGroup matching, so image caching still applies.

### Task 2.2 — Bump the SW so clients pick up the new config
- [ ] Rebuild so `ngsw.json` regenerates; verify the new cache group appears under
      DevTools → Application → Cache Storage after one reload.

---

## Phase 3 — Immutable cache headers on uploads (optional, return-visit polish)

Long-lived headers let even non-SW return visits (and the SW revalidation) skip re-download.
Safe because upload filenames are unique per image.

- [ ] In the **`/wp/` `.htaccess`** (or server config), add a guarded block for
      `wp-content/uploads/` image types:
      ```apache
      <IfModule mod_headers.c>
        <FilesMatch "\.(webp|avif|jpe?g|png|gif)$">
          Header set Cache-Control "public, max-age=31536000, immutable"
        </FilesMatch>
      </IfModule>
      ```
- [ ] Apply on **staging first**; confirm response headers on an uploads image; confirm no
      regression to admin uploads/crop flows.

---

## Verification checklist (run on staging before prod)

- [ ] **Build clean:** `npm run build:staging` completes; `tsc` typecheck passes.
- [ ] **Flags OFF = no change:** with `dn_preload_lcp_enabled` off, `index.html` shows the
      empty `<!--dn-lcp:start--><!--dn-lcp:end-->` region, no preload link, behaviour identical.
- [ ] **Cold load, flag ON** (DevTools → clear storage + unregister SW, hard reload):
      Network panel shows the page-1 image request **initiated by the parser/preload**, not by
      Angular — it starts in parallel with the JS bundle. LCP drops vs. baseline.
- [ ] **No double-download:** the preloaded image and the `<img>` are the **same** Network
      entry (the `<img>` is served "from preload cache"); the image is fetched exactly once.
- [ ] **URL match:** preload `href` === the URL Angular sets on the page-1 `<img>` (compare
      against `resolveImageUrl(currentPage.fullImage)`).
- [ ] **Publish refresh:** publish a new latest edition → served `index.html`'s preload `href`
      updates to the new page-1 image automatically (no rebuild).
- [ ] **Repeat visit (Phase 2):** second load serves edition images from the SW cache (0 image
      network requests before paint); works **offline** for a previously viewed edition.
- [ ] **Security:** confirm the injector rejects a non-uploads / off-host URL (temporarily
      point page-1 at a foreign URL in a test record → no link injected, error logged).
- [ ] **UI regression sweep (must be unchanged):** date picker, edition switch, thumbnail
      panel + lazy-load, article/image modals, print/download, ads, share, mobile + desktop,
      bn/en.
- [ ] **Admin untouched:** editor still loads authoritative REST, uploads/crop/save all work,
      no stale overwrite, no preload logic on the admin path.
- [ ] **Data integrity:** `dn_data`, `dn_settings`, and all `dn-static/*.json` byte-identical
      before/after a publish that only toggles these features (diff to confirm zero data write).

---

## Rollback (each independent, no rebuild needed for 1 & 3)

- **Preload injection:** untick **Preload page-1 image** → next publish blanks the region.
  To remove immediately without a publish, run the regenerate action or clear the region.
- **SW image cache:** remove the `wp-edition-images` dataGroup and bump the SW.
- **Cache headers:** delete the `.htaccess` block.

---

## Why NOT bundle images into the app (rationale, for the record)

Bundling page-1's image into `src/assets` ships it inside the Angular build. The latest
edition changes **every day**, so it would force a rebuild + redeploy on every publish, plus
cache-busting churn — all to achieve what a publish-time `<link rel="preload">` already does
with zero rebuilds. The images already live as static files under `wp-content/uploads/`
served by Apache without PHP; the only missing piece was **early discovery** (Phase 1) and
**repeat-visit caching** (Phase 2), which this plan adds.
