# Performance Improvement To-Do List

Based on technical review of `epaper.dailyadin.com` vs this Angular app.  
**Rule: each task must not break existing functionality, UI, or features.**  
Tasks are ordered by impact and implementation safety. Complete phases in order.

---

## Phase 1 — Zero-Risk Quick Wins
*No breaking changes possible. Safe to do independently.*

---

### PERF-01: Self-host Google Fonts ⚡ Easy

**Why:** `index.html` loads Google Sans from `fonts.googleapis.com` — an external cross-origin request that blocks rendering until the font CSS resolves. On the first visit, this adds one extra network round trip before text is styled.

**What to do:**
1. Download Google Sans font files (woff2 format) from Google Fonts or use the `google-webfonts-helper` tool.
2. Place font files in `src/assets/fonts/`.
3. Create `src/assets/fonts/google-sans.css` with `@font-face` declarations pointing to the local files.
4. In `src/index.html`:
   - Remove the two `<link rel="preconnect" href="https://fonts.googleapis.com">` lines.
   - Remove the `<link href="https://fonts.googleapis.com/...">` stylesheet link.
   - Add `<link rel="stylesheet" href="assets/fonts/google-sans.css">` instead.
5. Add `assets/fonts/**` glob to the `angular.json` assets array (it already covers `src/assets/**` so may already be included — verify).

**Verification:** App fonts look identical. Network tab shows no request to `fonts.googleapis.com` or `fonts.gstatic.com`.

**Risk:** None — purely a font delivery change. If fonts look wrong, it's a CSS path issue, not a functional breakage.

---

### PERF-02: Run Bundle Analysis (Prerequisite for PERF-03)

**Why:** `main.js` is 616 KB uncompressed. Before reducing it, we need to know exactly what is inside it. The `xlsx` package (used for bulk XML import) is ~500 KB on its own — if it leaked into the main bundle instead of staying in the lazy-loaded admin chunk, that alone explains most of the bundle weight.

**What to do:**
1. Install webpack-bundle-analyzer:
   ```bash
   npm install --save-dev webpack-bundle-analyzer
   ```
2. Build with stats:
   ```bash
   ng build --configuration production --stats-json
   ```
3. Analyse:
   ```bash
   npx webpack-bundle-analyzer dist/digital-newspaper/stats.json
   ```
4. Look for:
   - `xlsx` / `quill` / `quill-delta` in the main chunk (they should only be in the admin lazy chunk `34.js`).
   - Any large date/utility libraries duplicated across chunks.
   - Any admin-only services or components included in the main bundle.
5. Document every large module found in `main.js` and its size.

**Verification:** No code changes yet — this is analysis only.

**Risk:** None (build-time analysis only).

---

### PERF-03: Fix Bundle Leaks (depends on PERF-02 findings)

**Why:** If PERF-02 finds that admin-only libraries (`xlsx`, Quill) appear in `main.js`, they need to be moved to the lazy admin chunk. Every KB removed from `main.js` directly reduces the JS that must parse before anything renders.

**What to do:**
1. Ensure `xlsx` is only imported inside `src/app/admin/` files. Scan for any import of `xlsx` outside the admin folder:
   ```bash
   grep -rn "from 'xlsx'" src/app/ --include="*.ts" | grep -v admin
   ```
2. Ensure `quill` / `ngx-quill` imports are only inside admin. Same grep pattern.
3. If any such import exists in a shared service used by both viewer and admin, refactor: create an admin-specific wrapper that imports the heavy library, and have the shared service accept an interface instead.
4. Rebuild and re-run bundle analyzer to confirm the leaking packages are gone from `main.js`.

**Verification:** `main.js` is measurably smaller. Admin still works exactly the same. Viewer (newspaper reader) unaffected.

**Risk:** Low — only moving imports between files. The admin chunk already lazy-loads correctly, so fixing the import location is low-risk if done carefully with TypeScript ensuring all types still resolve.

---

### PERF-04: Add `loading="lazy"` + `decoding="async"` to Viewer Page Images ⚡ Easy

**Why:** The newspaper viewer loads ALL page thumbnails on mount, even pages the user hasn't scrolled to yet. Lazy loading defers off-screen image fetching until the user scrolls near them.

**What to check first:** `newspaper-page-thumbnail.component.ts` already has `loading="lazy"` on its `<img>`. Verify the main newspaper page image (the large full-page view) and any other inline `<img>` tags in `newspaper.component.html` also have `loading="lazy"` and `decoding="async"`.

**What to do:**
1. Search `src/app/` for `<img` tags missing `loading="lazy"`:
   ```bash
   grep -rn "<img" src/app/ --include="*.html" | grep -v 'loading='
   ```
2. For each result that is not a logo or critical above-the-fold image, add `loading="lazy" decoding="async"`.
3. The first visible newspaper page image (the one the user sees on load) should have `loading="eager"` (or no attribute — eager is the default). Do NOT lazy-load the first visible image.

**Verification:** Page layout and all images appear correctly. Network tab shows off-screen images not fetched until scrolled into view.

**Risk:** None — a browser hint only; browsers ignore it safely if unsupported.

---

### PERF-05: Preload the First Newspaper Page Image

**Why:** Currently the browser discovers the first page's image URL only after Angular boots and renders the component. With a `<link rel="preload">`, the browser can start fetching the image in parallel while JS is still loading — shaving off one full round trip.

**What to do:**
1. In `src/index.html`, after the existing meta tags and before the scripts, add:
   ```html
   <!-- The Angular app will override this href dynamically if needed -->
   <link id="first-page-preload" rel="preload" as="image" href="">
   ```
2. In `NewspaperComponent.ngOnInit()` or in the data subscription where the first page is resolved, inject `DOCUMENT` and update the preload `href`:
   ```typescript
   const preload = this.document.getElementById('first-page-preload') as HTMLLinkElement;
   if (preload && firstPageThumbnailUrl) {
     preload.href = firstPageThumbnailUrl;
   }
   ```
3. On SSR (PERF-07), the server can set this URL directly in the rendered HTML.

**Verification:** Network tab shows the first page image begins downloading before Angular finishes bootstrapping (on second+ visits, service worker handles this; this helps on first visit).

**Risk:** Low — an additive `<link>` tag. Worst case it's a no-op if the URL isn't available early enough.

---

## Phase 2 — Backend: Reduce API Waterfall
*Requires changes to the WordPress plugin AND Angular service. Test thoroughly in staging.*

---

### PERF-06: Add a Combined `/init` API Endpoint (WordPress Plugin)

**Why:** On first load, Angular makes at least 3 sequential API calls to WordPress — settings, dates index, and today's edition. Each call is a separate HTTP round trip to the server. Combining them into one halves the network wait time on first render.

**What to do (WordPress Plugin side — `wordpress-plugin/`):**
1. Register a new REST route:
   ```
   GET /wp-json/digital-newspaper/v1/data/init
   ```
2. This endpoint returns a single JSON object:
   ```json
   {
     "settings": { ... },
     "dates": [ "2026-06-13", "2026-06-12", ... ],
     "todayEditions": [ { "date": "...", "pages": [...] } ]
   }
   ```
3. Reuse the existing logic from the individual endpoints — no duplication of business logic, just one controller that calls the same internal functions.
4. Set proper `Cache-Control` headers: `no-cache` (since "today" changes daily) or `max-age=300` with a tag-based invalidation approach.
5. Keep all existing individual endpoints exactly as-is (backward compatibility, admin panel uses them).

**What to do (Angular side — `NewspaperDataService`):**
1. Add a `loadInit()` method that calls `/data/init`.
2. In `NewspaperComponent.ngOnInit()`, call `loadInit()` first instead of the separate `loadData()` + settings calls.
3. Populate settings, dates, and today's edition from the single response.
4. Keep the existing fallback: if `/init` returns an error, fall back to the current multi-call flow.
5. Update `ngsw-config.json` to add a cache entry for the new `/init` URL with a `freshness` strategy and short TTL (5 minutes).

**Verification:**
- Network tab on first load shows only ONE call to `/data/init` instead of 3.
- Settings, date picker, and all editions still load and display correctly.
- Admin panel (uses separate endpoints) is completely unaffected.
- Service worker caches the new endpoint correctly on second visit.

**Risk:** Medium — new endpoint is additive (no existing code removed), Angular fallback ensures graceful degradation. WordPress plugin tests needed.

---

## Phase 3 — Angular SSR (Biggest Performance Win)
*Highest complexity. Implement on a separate branch. Requires thorough testing of every feature.*

---

### PERF-07: Add Angular SSR (`@angular/ssr`)

**Why:** This is the single biggest performance improvement. Without SSR, the user sees a spinner until ~650 KB of JS downloads, parses, and executes, then makes API calls. With SSR, the server sends pre-rendered HTML and the user sees the newspaper page immediately — just like the competitor site.

**What to do:**

**Step 1 — Add SSR package:**
```bash
ng add @angular/ssr
```
This auto-generates `src/app/app.config.server.ts` and `src/server.ts`. Review the generated code before proceeding.

**Step 2 — Guard all browser-only APIs with `PLATFORM_ID`:**

The following services/components use browser-only APIs that will crash on the server if unguarded. Each needs `isPlatformBrowser()` wrapping:

| File | Browser API Used | Fix |
|------|-----------------|-----|
| `idb-cache.service.ts` | IndexedDB | Already has `_isAvailable()` check — verify it returns `false` on server |
| `edition-cache.service.ts` | localStorage | Wrap localStorage reads in `isPlatformBrowser()` |
| `http-cache.interceptor.ts` | May use `window`/`document` | Audit and guard |
| `newspaper.component.ts` | `document.baseURI`, `document.getElementById()` | Inject `DOCUMENT` token (already done partially — verify all usages) |
| `app.component.ts` | `document.getElementById('app-splash')` | Already uses `@Inject(DOCUMENT)` ✅ — verify |
| `share-buttons.component.ts` | `navigator`, `window` | Wrap all `navigator`/`window` calls |
| `image-resize.util.ts` | Potentially canvas/DOM | Audit |
| `auth.service.ts` | `localStorage`/`sessionStorage` | Wrap in `isPlatformBrowser()` |
| `settings.service.ts` | Potentially `localStorage` | Audit |
| `lock.service.ts` | Browser lock API? | Audit |
| `activity-log.service.ts` | `localStorage`? | Audit |

Pattern to use:
```typescript
import { isPlatformBrowser } from '@angular/common';
import { PLATFORM_ID, inject } from '@angular/core';

private platformId = inject(PLATFORM_ID);

someMethod() {
  if (!isPlatformBrowser(this.platformId)) return;
  // browser-only code here
}
```

**Step 3 — Scope SSR to the viewer route only:**

The admin panel (`/admin`) must remain CSR-only (it has heavy browser dependencies and is not public-facing). In `app.config.server.ts`, configure the server to skip SSR for `/admin/**` routes and serve the regular SPA shell for those.

**Step 4 — Handle service worker on server:**

`SwUpdate` and `provideServiceWorker()` must be browser-only. They already check `isDevMode()` — add an additional `isPlatformBrowser()` guard in `app.component.ts` around the SW subscription.

**Step 5 — Implement Angular TransferState (prevents double data fetch):**

Without TransferState, the server fetches data to render HTML, then the client boots and fetches the same data again — wasting a round trip. With TransferState, the server embeds its fetched data in the HTML, and the client rehydrates from it without refetching.

In `NewspaperDataService`:
```typescript
import { TransferState, makeStateKey } from '@angular/core';

const INIT_DATA_KEY = makeStateKey<InitData>('initData');

// On server: after fetching, store in TransferState
this.transferState.set(INIT_DATA_KEY, data);

// On browser: check TransferState before making HTTP call
const cached = this.transferState.get(INIT_DATA_KEY, null);
if (cached) {
  this.transferState.remove(INIT_DATA_KEY);
  // use cached data directly
  return;
}
// otherwise fetch normally
```

**Step 6 — Build and test:**
```bash
ng build --configuration production
node dist/digital-newspaper/server/server.mjs
```

**Verification checklist (test every item):**

- [ ] Home page (`/`) renders full newspaper content with JavaScript disabled (proves SSR works).
- [ ] Date navigation (`/:date/:page/:edition`) SSR-renders the correct edition.
- [ ] Section modal opens correctly after client-side hydration.
- [ ] Admin panel (`/admin`) loads and all admin features work (edit, save, upload, bulk import).
- [ ] Share buttons function correctly.
- [ ] Date picker selects correctly.
- [ ] Service worker registers and caches on second visit.
- [ ] No `window is not defined` or `document is not defined` errors in server logs.
- [ ] No hydration mismatch warnings in browser console.
- [ ] Under-maintenance mode still works.
- [ ] Multi-language (EN/BN) toggle works.
- [ ] Article modal / section overlay opens correctly.
- [ ] Image cropping in admin still works.

**Risk:** High complexity, but the risk is contained to a separate branch. Existing CSR build remains as fallback. The primary SSR risk areas are the `idb-cache` (IndexedDB), `edition-cache` (localStorage), and any direct `window`/`document` access — all of which are addressable with `isPlatformBrowser()` guards.

---

## Phase 4 — Image Delivery (Backend + CDN)
*Independent of Angular changes. Can be done in parallel with any phase.*

---

### PERF-08: Serve WebP Instead of JPEG for Newspaper Page Images

**Why:** WebP images are typically 25–35% smaller than JPEG at the same visual quality. Since newspaper page images are the heaviest assets (full-page scans), this directly reduces the data the user has to download to see the paper.

**What to do (WordPress/backend side):**
1. Configure WordPress image uploads to auto-generate WebP versions (WordPress 5.8+ does this natively if the server's `gd` or `imagick` extension supports WebP).
2. Update the WordPress plugin's image-serving endpoint to return WebP when the `Accept: image/webp` request header is present, falling back to JPEG otherwise.

**What to do (Angular side):**
1. In the `<img>` tags used for newspaper pages, wrap with a `<picture>` element:
   ```html
   <picture>
     <source [srcset]="page.webpUrl" type="image/webp">
     <img [src]="page.fullImage" [alt]="..." loading="lazy" decoding="async">
   </picture>
   ```
2. The `NewspaperPage` interface in `newspaper-data.service.ts` already has `fullImage` and `fullImageHiRes`. Add an optional `webpUrl` field.
3. If the backend doesn't provide a `webpUrl` yet, derive it by convention: replace `.jpg`/`.jpeg` extension with `.webp`.

**Verification:** Images visually identical. Network tab shows `.webp` files being loaded (in Chrome/Firefox). Safari falls back to JPEG (via `<picture>` fallback). Admin image upload and crop tool still works — WebP is a display-only change; the source image in admin can remain JPEG.

**Risk:** Low on Angular side (additive `<picture>` wrapper). Medium on WordPress side — test image generation thoroughly.

---

## Summary Table

| Task | Phase | Effort | Impact | Risk |
|------|-------|--------|--------|------|
| PERF-01: Self-host fonts | 1 | 1h | Low-Medium | None |
| PERF-02: Bundle analysis | 1 | 30min | — (info only) | None |
| PERF-03: Fix bundle leaks | 1 | 2–4h | Medium | Low |
| PERF-04: Lazy image attrs | 1 | 30min | Low-Medium | None |
| PERF-05: Preload first image | 1 | 1h | Low | Low |
| PERF-06: Combined /init API | 2 | 4–6h | Medium | Medium |
| PERF-07: Angular SSR | 3 | 2–3 days | **Very High** | High |
| PERF-08: WebP images | 4 | 4–8h | Medium | Low-Medium |

**Expected cumulative improvement after all phases:**
- Phase 1 alone: ~0.3–0.5s faster first paint (font + bundle + image hints).
- Phase 2 added: ~0.3–0.5s faster (fewer API round trips).
- Phase 3 (SSR) added: **1.5–3s faster first contentful paint** (user sees real content instead of spinner while JS loads).
- Phase 4 added: ~20–30% reduction in image transfer size.

**Implementation order: 1 → 2 → 3 → 4. Do not skip phases.**
