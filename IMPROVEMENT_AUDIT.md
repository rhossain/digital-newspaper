# Improvement Audit — Performance, Security & Code Quality

> Based on a full read of the Angular 21 frontend and WordPress plugin source.  
> Items are ordered by **impact / risk** within each section.  
> No implementation has been done yet — this is a planning document only.

---

## Quick Summary

| Category | Issues found | Critical | High | Medium | Low |
|----------|-------------|---------|------|--------|-----|
| Security | 8 | 2 | 3 | 2 | 1 |
| Performance | 9 | 1 | 3 | 3 | 2 |
| Code Quality | 8 | 0 | 2 | 4 | 2 |
| New Endpoints | 3 | — | — | — | — |

---

## 1. Security — To-Do List

### 🔴 CRITICAL

**SEC-01 — Hardcoded fallback JWT secret**

- **File:** `wordpress-plugin/digital-newspaper/digital-newspaper.php`, `get_secret()` (~line 6120)
- **Problem:** When neither `DN_JWT_SECRET` nor `AUTH_KEY` is defined in `wp-config.php`, the function returns the literal string `'dn_fallback_secret'`. Any attacker who reads the plugin source code (it is open on your server) can forge valid JWT tokens and authenticate as any user.
- **Fix:** Remove the `'dn_fallback_secret'` fallback entirely. If no key is configured, throw an exception or return a WP_Error that prevents login from completing. Force the admin to define `DN_JWT_SECRET` in `wp-config.php` before the plugin works at all.
- **Effort:** 30 min

---

**SEC-02 — Raw `innerHTML` assignment bypasses Angular XSS protection**

- **Files:**
  - `src/app/newspaper.component.ts` line ~1012: `articleEl.innerHTML = this.normalizeContent(content)`
  - `src/app/app.component.ts` line ~94: `container.innerHTML = html` (for `headScripts` setting)
- **Problem:** Both usages set `innerHTML` directly on DOM elements without going through Angular's `DomSanitizer`. The `normalizeContent()` function only strips `&nbsp;` — it does **not** sanitize HTML. If the section `content` field ever contains a `<script>` tag or an `onerror=` attribute (e.g. injected via bulk XML import or a compromised admin account), it executes in the viewer's context. The `headScripts` path in `AppComponent` is even more dangerous because it injects script tags by design.
- **Fix:**
  - For `newspaper.component.ts`: replace the DOM write with Angular's `[innerHTML]` binding and pipe through `DomSanitizer.sanitize(SecurityContext.HTML, content)`, or use the existing `NormalizeContentPipe` which is already used in `article-modal.component.html`.
  - For `app.component.ts`: the `headScripts` feature is intentionally for script injection, but it should be restricted to administrator role only at the API level, and the Angular side should log a visible warning in dev mode.
- **Effort:** 2 h

---

### 🟠 HIGH

**SEC-03 — Content-Security-Policy is Report-Only, never enforced**

- **File:** `digital-newspaper.php` ~line 264–317
- **Problem:** The plugin sends `Content-Security-Policy-Report-Only` which logs violations but **never blocks** them. The CSP has been report-only since it was written. Violations are visible in the browser console but XSS attacks still execute.
- **Fix:** Audit the report-only violations (check the browser console on your prod site), fix any legitimate `unsafe-inline` usages (Quill needs `unsafe-inline` for styles, which should be scoped to the admin route), then graduate the header to `Content-Security-Policy`.
- **Effort:** 4 h

---

**SEC-04 — Missing `Strict-Transport-Security` (HSTS) header**

- **File:** `digital-newspaper.php`, `add_public_security_headers()`
- **Problem:** The security headers function sets `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy` but omits `Strict-Transport-Security`. Without HSTS, browsers will not automatically upgrade HTTP connections to HTTPS, leaving the site vulnerable to SSL-stripping attacks. Since the site is production HTTPS-only, HSTS should be enforced.
- **Fix:** Add `header('Strict-Transport-Security: max-age=31536000; includeSubDomains');` to `add_public_security_headers()`. Also add to the `.htaccess` `<IfModule mod_headers.c>` block for non-PHP responses (JS, CSS, images).
- **Effort:** 30 min

---

**SEC-05 — `xlsx` package at version 0.18.5 (known CVEs)**

- **File:** `package.json`
- **Problem:** `xlsx@0.18.5` (SheetJS Community Edition) has known prototype-pollution vulnerabilities. The package is imported in `xml-import.service.ts` which is part of the lazy-loaded admin bundle, so it does not affect the viewer. However, it is still a dependency that npm will flag and it runs in the admin's browser when parsing uploaded files.
- **Fix:** Upgrade to the latest SheetJS community release (`xlsx@latest` or pin to `0.20.x`), or replace with a smaller purpose-built library since only `.xlsx/.xls/.csv` reading is needed (no write path). Alternatively, offload Excel parsing to the server side and call a PHP endpoint.
- **Effort:** 2–4 h depending on API changes

---

### 🟡 MEDIUM

**SEC-06 — `GET /social` and `GET /social-image` have no rate limiting**

- **File:** `digital-newspaper.php`, route registration ~line 2018–2038
- **Problem:** Both endpoints are public and read the full editions dataset on every call. They use `check_public_get_rate_limit()` for `get_settings_endpoint()` and `get_dates_endpoint()` but **not** for social/social-image endpoints. A bot could hammer these to exhaust PHP memory on shared hosting.
- **Fix:** Add `$this->check_public_get_rate_limit()` at the top of both `get_social_endpoint()` and `get_social_image_endpoint()` callbacks.
- **Effort:** 30 min

---

**SEC-07 — `Permissions-Policy` header missing**

- **File:** `digital-newspaper.php`, `add_public_security_headers()`
- **Problem:** No `Permissions-Policy` header is set. This means the embedded Angular app has unrestricted access to browser features (camera, microphone, geolocation). While the app doesn't use them, defence-in-depth best practice is to disable what isn't needed.
- **Fix:** Add `header("Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()");`
- **Effort:** 15 min

---

### 🟢 LOW

**SEC-08 — Social endpoint user-agent detection is bypassable**

- **File:** `src/.htaccess`
- **Problem:** The `.htaccess` social rewrite only fires when `HTTP_USER_AGENT` matches a known list of crawler strings. A scraper using an unlisted agent string (or an empty UA) will reach the Angular SPA and get no OG tags.
- **Fix:** This is an accepted limitation for a client-rendered app, but consider a server-side OG meta tag injection via WordPress `wp_head` for all public page loads as a fallback (does not require JS). Or deploy a simple Node prerender proxy.
- **Effort:** 4–8 h

---

## 2. Performance — To-Do List

### 🔴 CRITICAL

**PERF-01 — `NewspaperComponent` uses default change detection with 15 manual `detectChanges()` calls**

- **File:** `src/app/newspaper.component.ts`
- **Problem:** The component does not declare `changeDetection: ChangeDetectionStrategy.OnPush`. Angular's default change detection runs on every browser event (click, keypress, scroll, timer tick, etc.) and checks the entire component tree. There are 15 `this.cdr.detectChanges()` calls scattered through the class — this is a symptom of fighting the default CD strategy instead of controlling it properly with OnPush. The result is unnecessary re-rendering on every event in a component that renders large images and dozens of thumbnail items.
- **Fix:** Add `changeDetection: ChangeDetectionStrategy.OnPush` to the `@Component` decorator. Convert mutable properties that trigger rendering to Angular signals (they already work with OnPush). The `detectChanges()` calls should then only be needed after truly async side-effects (image load callbacks, ResizeObserver). Most of them can be removed entirely once reactive state is used correctly.
- **Effort:** 6–8 h (careful refactor, test all interactions)

---

### 🟠 HIGH

**PERF-02 — Bootstrap requires 3–4 parallel HTTP requests; should be 1**

- **Files:** `src/app/services/newspaper-data.service.ts` `loadDataFromGranular()`, WordPress plugin
- **Problem:** On every page load the app fires a `forkJoin` of `GET /data/settings`, `GET /data/dates`, `GET /data/version`, then immediately follows with `GET /data/editions/{today}` (and often `GET /data/editions/{latestDate}`). That is 4–5 sequential + parallel round trips before the first page renders. On a shared-hosting server with 100–200 ms TTFB each, this adds 200–600 ms to Time-to-Interactive.
- **Fix:** Create a new `GET /data/bootstrap` endpoint (see §4 — New Endpoints). It returns `{settings, dates, dataVersion, todayEditions}` in one response. The Angular service calls this single endpoint on startup, then lazy-loads other dates on demand. Service Worker and HTTP interceptor caches can cache this response the same way they cache the individual endpoints today.
- **Effort:** Backend 3 h + Frontend 2 h

---

**PERF-03 — Google Fonts loaded from external CDN on every page load**

- **File:** `src/index.html` line 38
- **Problem:** `<link href="https://fonts.googleapis.com/css2?family=Google+Sans...">` adds 2 external DNS lookups and HTTP requests before the page renders. It also sends user IP addresses to Google and may be blocked in some corporate networks or countries. Font CSS itself is render-blocking.
- **Fix:** Self-host the font. Download the WOFF2 files (use `google-webfonts-helper.herokuapp.com` or similar), place them in `src/assets/fonts/`, and add `@font-face` rules to `styles.css`. Remove the Google Fonts `<link>` and the preconnect hints. This also removes the external privacy dependency.
- **Effort:** 2 h

---

**PERF-04 — No WebP/AVIF format for newspaper page images**

- **File:** `src/app/newspaper.component.html` (main image + thumbnails)
- **Problem:** Newspaper page images are large JPEGs (full broadsheet scans can be 500 KB–2 MB each). The viewer renders them with a plain `<img src="...jpg">` tag. No WebP or AVIF variants are served, despite WebP support being near-universal (97%+ of browsers). WebP at equivalent quality is typically 25–40% smaller.
- **Fix:**
  - Server-side: when an image is uploaded via `POST /media`, generate a `.webp` companion using WordPress's `imagejpeg` → `imagewebp` pipeline (requires PHP GD or Imagick with WebP support).
  - Frontend: replace `<img src="...jpg">` with `<picture><source srcset="...webp" type="image/webp"><img src="...jpg"></picture>` for both the main image and thumbnails.
  - Alternatively: if LiteSpeed or a CDN is in front, configure auto-WebP conversion there.
- **Effort:** Backend 4 h + Frontend 2 h

---

### 🟡 MEDIUM

**PERF-05 — `ArticleModalComponent` and `SectionOverlayComponent` are eagerly bundled with the viewer**

- **File:** `src/app/newspaper.component.ts` imports
- **Problem:** Both modal and overlay components are statically imported into `NewspaperComponent`. They are only needed after a user interaction (clicking a section), but their code is included in the initial JS bundle. `ArticleModalComponent` imports `ShareButtonsComponent` and `NormalizeContentPipe` as well.
- **Fix:** Use Angular's lazy component loading for `ArticleModalComponent`. Replace the static import with a dynamic `import()` inside `openContentModal()` / `openImageModal()`. `SectionOverlayComponent` is tiny and always visible, so it can stay eager.
- **Effort:** 2 h

---

**PERF-06 — Thumbnail loading blocks on a sequential JavaScript queue instead of native lazy loading**

- **File:** `src/app/newspaper.component.ts`, `queueThumbnailLoad()` / `loadNextThumbnail()`
- **Problem:** Thumbnails are loaded through a custom sequential JavaScript queue. While this prevents a burst of simultaneous requests on initial load, it means thumbnails below the fold are loaded serially instead of being browser-prioritised. Modern browsers handle this well natively with `loading="lazy"` on `<img>` tags, deferring off-screen images automatically.
- **Fix:** Remove the manual sequential queue. Mark thumbnail `<img>` tags with `loading="lazy" decoding="async"`. The browser will load visible thumbnails eagerly and off-screen ones lazily, which is both simpler and faster than the custom queue. Mark the first visible thumbnail (page 1) with `fetchpriority="high"`.
- **Effort:** 3 h (requires removing queue logic and verifying thumbnail rendering)

---

**PERF-07 — `quill.snow.css` loaded globally**

- **File:** `angular.json` → `styles` array
- **Problem:** `node_modules/quill/dist/quill.snow.css` is listed in the global `styles` array, meaning it is bundled into the main CSS file that loads on every page — including the public viewer where Quill is never used (Quill is admin-only).
- **Fix:** Remove it from the global `styles` array. Instead, import it inside `admin.component.ts` using a dynamic `import('quill/dist/quill.snow.css')` at module load time, or add it to the lazy-loaded admin component's own `styleUrls`. This saves ~10–15 KB of CSS on every viewer page load.
- **Effort:** 1 h

---

### 🟢 LOW

**PERF-08 — `newspaper-data.service.old.ts` — dead file compiled into the project**

- **File:** `src/app/services/newspaper-data.service.old.ts` (145 lines)
- **Problem:** The file is listed in `tsconfig.json`'s compiled source (not excluded despite the `"exclude": ["**/*.old.ts"]` pattern — check if this applies at runtime). Even if tree-shaken, it pollutes the codebase and may confuse the build toolchain.
- **Fix:** Delete the file. If needed for reference, store it in git history and reference the commit SHA in a comment.
- **Effort:** 5 min

---

**PERF-09 — Dead `NewspaperPageThumbnailComponent` in the component tree**

- **File:** `src/app/components/newspaper-page-thumbnail.component.ts`
- **Problem:** This component was built with `OnPush`, `ImageCacheService`, and a thumbnail caching layer — but is **not imported or used anywhere in the current template**. The viewer renders thumbnails inline in `newspaper.component.html` using `pageThumbnailSrcs[]` state. The component is dead code.
- **Fix:** Either delete it (if the inline approach is permanent) or replace the inline thumbnail rendering with this component (which would properly encapsulate loading state and apply `OnPush` to each thumbnail independently).
- **Effort:** Delete: 5 min. Migrate to component: 3 h.

---

## 3. Code Quality — To-Do List

### 🟠 HIGH

**CQ-01 — `admin.component.ts` is 3 822 lines — monolithic god class**

- **File:** `src/app/admin/admin.component.ts`
- **Problem:** The admin component handles authentication UI, page management, section editing, settings, backups, lock management, activity log, bulk import coordination, and version polling — all in one class with one template. At 3 822 TS + 2 474 HTML = 6 296 lines, it is impossible to reason about in isolation and will become increasingly hard to maintain.
- **Recommended split:**
  - `AdminShellComponent` — router outlet, auth guard, theme
  - `PageEditorComponent` — page list, add/delete, lock state
  - `SectionEditorComponent` — section form, Quill editor, crop tool, image upload
  - `SettingsComponent` — global settings form
  - `BackupRestoreComponent` — backup list, restore, export
  - `ActivityLogComponent` — log table, filters, pagination
  - All communicate via a shared `AdminStateService` (signals-based)
- **Effort:** 2–3 days

---

**CQ-02 — Zero unit tests**

- **Problem:** No `.spec.ts` files exist anywhere in the project. The caching logic (`EditionCacheService` 4-layer eviction), the JWT validation logic (`AuthService.isAuthenticated()`), the shrinking-overwrite guard (PHP), and the `saveSectionAtomically` cache-invalidation chain are all business-critical paths with no test coverage. A regression in any of them causes data loss or auth bypass without any automated detection.
- **Fix:** Start with the highest-risk units:
  1. `EditionCacheService` — test all 4 cache layers + eviction
  2. `AuthService.isAuthenticated()` — test expiry, sub mismatch, corrupt token
  3. `NewspaperDataService.saveSectionAtomically()` — test cache eviction ordering
  4. PHP: `put_section_endpoint` lock validation and `post_data_endpoint` Guards 1–3
- **Effort:** 3–5 days for meaningful coverage

---

### 🟡 MEDIUM

**CQ-03 — `NewspaperComponent` uses manual `Subscription[]` array instead of `takeUntilDestroyed`**

- **File:** `src/app/newspaper.component.ts`
- **Problem:** Three subscriptions are managed via a `subscriptions: Subscription[]` array with a `forEach(sub => sub.unsubscribe())` in `ngOnDestroy`. Angular 16+ provides `takeUntilDestroyed()` which is cleaner, requires no array, and can't be forgotten. The component already targets Angular 21.
- **Fix:** Replace the array pattern:
  ```typescript
  // Before
  this.subscriptions.push(this.route.paramMap.subscribe(...));
  // After
  this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(...);
  ```
- **Effort:** 1 h

---

**CQ-04 — `normalizeContent` is duplicated: pipe + component method**

- **Files:** `src/app/shared/pipes/normalize-content.pipe.ts`, `src/app/newspaper.component.ts` line ~1028
- **Problem:** The same logic (replace `&nbsp;` and ` `) is implemented twice. The pipe is pure and correct. The component method is used only for the print window, but if the normalisation rules ever change, both copies must be updated.
- **Fix:** In `newspaper.component.ts`, remove the private `normalizeContent()` method. For the print path, inject `NormalizeContentPipe` and call `pipe.transform(content)`.
- **Effort:** 30 min

---

**CQ-05 — `CommonModule` imported in `admin.component.ts` instead of specific directives**

- **File:** `src/app/admin/admin.component.ts`
- **Problem:** `CommonModule` is imported in the standalone component. Since Angular 17+, `CommonModule` re-exports the entire set of common directives. In a standalone component, only the specific directives used (`NgIf`, `NgFor`, `AsyncPipe`, etc.) should be imported. `CommonModule` prevents proper tree-shaking of unused directives.
- **Fix:** Remove `CommonModule` from `imports`. Add only what is actually used in the template: the new `@if`/`@for` control flow syntax (Angular 17) does not require `NgIf`/`NgFor` imports at all, so likely only `AsyncPipe` (if used) is needed.
- **Effort:** 1 h (search/replace + template verification)

---

**CQ-06 — `console.log/warn/error` calls not gated by `isDevMode()`**

- **Files:** 45 occurrences across `src/app/`
- **Problem:** Development log statements reach the browser console in production builds. While many are `console.warn` (appropriate for caught errors), several are informational logs that should only fire in development. They can leak internal state information to end users with open devtools.
- **Fix:** For informational logs, wrap in `if (isDevMode())`. For error logs in `catchError` handlers, keep them as `console.warn` since they signal real runtime issues. Consider adding a `Logger` service that wraps `console` and gates on `isDevMode()`.
- **Effort:** 2 h

---

### 🟢 LOW

**CQ-07 — `NewspaperComponent` implements `AfterViewChecked` unnecessarily**

- **File:** `src/app/newspaper.component.ts` lines 216–234
- **Problem:** `AfterViewChecked` runs after every single change detection cycle to check whether `paginationBarRef` exists yet in the DOM. Once the `ResizeObserver` is attached it stops doing anything, but Angular still calls it on every CD cycle for the component's lifetime. This is a known anti-pattern.
- **Fix:** Move the `ResizeObserver` setup into `ngAfterViewInit()` with a `@ViewChild` setter (`set paginationBarRef(el)`). Angular calls the setter whenever the element enters/leaves the DOM, eliminating the need for `AfterViewChecked` entirely.
- **Effort:** 1 h

---

**CQ-08 — Admin component uses zero Angular signals despite running Angular 21**

- **File:** `src/app/admin/admin.component.ts`
- **Problem:** The admin component has 1 signal usage (inherited via `ADMIN_THEME` config). It still uses `BehaviorSubject`, manual `detectChanges()` calls (`ChangeDetectorRef` is injected), and mutable class properties for all state. Angular 21 signals are stable and provide better reactivity, tree-shakeable state, and automatic change detection without `ChangeDetectorRef`.
- **Fix:** When the component is split (CQ-01), write the new sub-components using signals from the start. This is a natural migration path — do not attempt a big-bang refactor.
- **Effort:** Covered by CQ-01

---

## 4. New Endpoints — Should You Create Them?

**Yes — one new endpoint has a clear, high-value case. The other two are optional.**

---

### EP-01 — `GET /data/bootstrap` ✅ Recommended

**Problem it solves:** Currently, the Angular app fires 3–4 HTTP requests in `loadDataFromGranular()` before it can render anything. On shared hosting with 150–200 ms TTFB, this adds 450–800 ms to Time-to-Interactive.

**Proposed shape:**
```json
GET /data/bootstrap

Response:
{
  "settings":     { ...GlobalSettings },
  "dates":        ["2026-06-13", "2026-06-12", ...],
  "dataVersion":  1234.5,
  "todayEditions": [ ...NewspaperEdition[] for today ],
  "latestEditions": [ ...NewspaperEdition[] for latestDate ] // if different from today
}
```

**Implementation:** Server reads `dn_settings`, `dn_data_index`, and `dn_edition_{today}` (3 `get_option()` calls) and returns them in one JSON response. ETag derived from `dataVersion`. HTTP cache: 5 min (same as today's editions).

**Angular change:** Replace the `forkJoin` in `loadDataFromGranular()` with a single `GET /data/bootstrap` call. The seeding path for `EditionCacheService.seedFromLoadedData()` stays the same.

**Saves:** ~300–600 ms on initial load. ~3 fewer HTTP round trips.

---

### EP-02 — `GET /data/editions-range?from=DATE&count=N` 🟡 Optional

**Problem it solves:** When a user navigates to a past date, the app calls `GET /data/editions/{date}` for each date they visit. If they click back 3 days quickly, 3 serial requests fire.

**Proposed shape:**
```json
GET /data/editions-range?from=2026-06-10&count=5

Response:
{
  "editions": {
    "2026-06-10": [ ...NewspaperEdition[] ],
    "2026-06-09": [ ...NewspaperEdition[] ],
    ...
  }
}
```

**When to implement:** Only worthwhile if analytics show users frequently browse many past dates in a single session. Not a priority currently.

---

### EP-03 — `GET /data/sitemap` 🟡 Optional

**Problem it solves:** The app has no XML sitemap. Google cannot discover article URLs (since they are hash/state-based Angular routes). The social `.htaccess` rewrite handles social crawlers for known URLs, but Googlebot does not use that path.

**Proposed shape:** Returns a minimal XML sitemap listing every `/{date}/page-{N}/edition-{N}/post-{sectionId}/` URL across all dates and sections.

**When to implement:** If SEO/Google indexing of individual articles is a goal. Not relevant for a subscription or app-only product.

---

## 5. How to Make the Frontend Load as Fast as Possible

Combining the above items into a prioritised loading-speed roadmap:

### Phase 1 — Quick wins (< 1 day total)

1. **Delete `quill.snow.css` from global styles** (PERF-07) — saves ~15 KB on viewer load
2. **Add `Strict-Transport-Security` header** (SEC-04) — eliminates HTTPS upgrade delay
3. **Delete dead files** (PERF-08, PERF-09) — cleaner build, marginally smaller output
4. **Add `Permissions-Policy` header** (SEC-07) — 15 min

### Phase 2 — Medium effort, significant impact (1–3 days)

5. **Create `GET /data/bootstrap`** (EP-01) — single biggest LCP improvement
6. **Self-host Google Fonts** (PERF-03) — eliminates external blocking request
7. **Add `OnPush` to `NewspaperComponent`** (PERF-01) — smoothest scrolling/interaction
8. **Fix `innerHTML` XSS paths** (SEC-02) — security + use existing pipe

### Phase 3 — Bigger refactors (3–7 days)

9. **Replace thumbnail queue with native lazy loading** (PERF-06) — simpler + faster
10. **WebP image generation on upload** (PERF-04) — biggest bandwidth saving for readers
11. **Lazy-load `ArticleModalComponent`** (PERF-05) — smaller initial bundle
12. **Split `admin.component.ts`** (CQ-01) — foundation for signals migration

### Phase 4 — Long-term health

13. **Write tests for cache/auth/save paths** (CQ-02) — safety net for all future changes
14. **Enforce CSP** (SEC-03) — after running report-only long enough to audit violations
15. **Angular signals migration in admin** (CQ-08) — covered naturally by CQ-01 split
