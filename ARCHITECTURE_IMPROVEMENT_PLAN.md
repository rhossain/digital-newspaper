# Architecture Improvement Plan — Digital Newspaper

**Date:** 2026-06-07  
**Scope:** Performance, security, code quality — no breaking changes to existing functionality

---

## Codebase Findings (What Exists Today)

Before planning changes, here is what was found in the current codebase:

| Concern | Current State |
|---|---|
| Data storage | All editions in a single `wp_options` key (`dn_data`) — one unbounded JSON blob |
| Public API load | `GET /data?_t=Date.now()` loads ALL editions on every page view |
| HTTP caching | `?_t=` cache-buster actively defeats CDN, LiteSpeed, and browser caching |
| Settings | Embedded inside every `/data` response; no separate endpoint |
| Version change detection | `/data/version` polls every 30 s — admin only; viewer doesn't use it |
| Angular caching | Only emergency draft + settings stored in `localStorage`; no in-memory HTTP cache |
| State management | `BehaviorSubject` in `NewspaperDataService`; no signals store, no NgRx |
| Service worker / PWA | Not installed |
| Rate limiting | Login only (5 attempts / 10 min); no rate limiting on public GET endpoints |
| Security headers | CORS and WAF bypass in place; no HSTS / `X-Content-Type-Options` / `X-Frame-Options` from plugin |
| `NewspaperDataService` | ~1 500 lines; handles loading, saving, caching, backup, export, media — too many responsibilities |
| `newspaper.component.ts` | God component — viewer logic, modal state, pagination, SEO all in one |
| Admin module | Already lazy-loaded ✓ |
| Atomic saves | Page and section atomic endpoints already exist ✓ |
| JWT auth | Client-side expiry check + sub-claim cross-validation already in place ✓ |

---

## Section 1 — Recommended API Endpoint Structure

### 1.1 Current vs. Target Routes

| Purpose | Current | Target |
|---|---|---|
| All data | `GET /data` (monolith) | *(keep for backward compat; deprecate long-term)* |
| Global settings | Embedded in `/data` | `GET /data/settings` |
| List available dates | None | `GET /data/dates` |
| Single edition by date | None | `GET /data/editions/:date` |
| Multi-edition date (e.g. morning/evening) | None | `GET /data/editions/:date?edition=2` |
| Data version probe | `GET /data/version` ✓ | Keep; add `ETag` header |
| Auth login | `POST /auth/login` ✓ | Keep; add per-IP rate limit to public GET too |
| Admin writes | `/data`, `/data/page`, `/data/section` ✓ | Keep all atomic endpoints |

### 1.2 New Endpoint Specifications

**`GET /data/settings`**
- Returns only the `settings` object from `dn_data`
- Response: `{ settings: GlobalSettings, dataVersion: number }`
- Cache headers: `Cache-Control: public, max-age=3600, s-maxage=3600` (1 hour)
- ETag: hash of settings JSON
- Purpose: Settings change rarely (logo, theme, social links). Separating them allows aggressive caching independent of daily news content.

**`GET /data/dates`**
- Returns sorted list of available edition dates
- Response: `{ dates: string[], latestDate: string }`
- Cache headers: `Cache-Control: public, max-age=300, s-maxage=300` (5 min — new editions published daily)
- Purpose: Lets Angular know which dates exist before fetching edition data. Small payload (~1 KB for 365 dates/year).

**`GET /data/editions/:date`**
- Returns only the editions for a single date (one or more editions for that day)
- Response: `{ date: string, editions: NewspaperEdition[], dataVersion: number }`
- Cache headers: `Cache-Control: public, max-age=86400, s-maxage=86400` (24 hours — past dates never change)
  - Exception: today's date should use `max-age=300` since it may still be updated
- ETag: `"dn-{date}-{dataVersion}"`
- `Last-Modified` header
- Supports `If-None-Match` / `If-Modified-Since` for 304 responses
- Purpose: Core of the incremental fetching strategy. Angular fetches only what it needs.

**`GET /data/version`** *(existing — extend)*
- Already exists and works
- Add `ETag` response header so Angular can use `If-None-Match` to get a true 304 with zero payload

### 1.3 Backend Data Storage Migration

The root cause of the scalability problem is storing all data in a single `wp_options` key. Two migration paths:

**Option A — Per-date option keys (simpler):**
Store each edition as `dn_data_edition_2025-06-07` in `wp_options`. Settings stay as `dn_settings`. A separate `dn_data_index` key holds the dates list and `dataVersion`. Low risk, backward compatible.

**Option B — Custom DB table (more scalable):**
Create a `{prefix}dn_editions` table with columns `(date VARCHAR(10), edition INT, data LONGTEXT, updated_at DATETIME)`. Indexed on `date`. Allows `SELECT` by date without loading all editions into PHP memory.

**Recommendation:** Start with Option A (per-date option keys). It is non-breaking (the existing `/data` endpoint can still reconstruct the full blob by reading all per-date keys), it requires no DB schema migration, and it eliminates the memory spike from loading a 10 MB+ options blob on every request.

---

## Section 2 — Angular Caching Architecture

### 2.1 Caching Strategy by Data Type

| Data | Change frequency | Cache location | TTL | Invalidation |
|---|---|---|---|---|
| Global settings | Rarely (admin change) | `localStorage` + in-memory | Until version bump | On admin save: bump `settingsVersion` |
| Date index (`/data/dates`) | Daily (new edition published) | In-memory `Map` | 5 min | `startVersionPoll` already detects changes |
| Past edition data | Never | `localStorage` / IndexedDB | Permanent | None needed — past dates immutable |
| Today's edition | Every admin save | In-memory `BehaviorSubject` | 5 min | `remoteDataChanged$` already triggers reload |
| `dataVersion` | Every save | In-memory | N/A | Already polled every 30 s |

### 2.2 New Angular Services (split from `NewspaperDataService`)

The current `NewspaperDataService` is ~1 500 lines with too many responsibilities. Split it:

**`SettingsService`**
- Owns `GlobalSettings`: fetch from `/data/settings`, cache in `localStorage`
- Exposes `settings$: Observable<GlobalSettings>`
- Cache invalidation: listen to `dataVersion` bump on settings save

**`EditionCacheService`**
- Owns per-date edition data
- In-memory `Map<string, NewspaperEdition[]>` keyed by date
- For past dates: check `localStorage` first → HTTP request only on miss
- For today: always re-validate with `ETag` / `If-None-Match`
- Exposes `getEditionsForDate(date: string): Observable<NewspaperEdition[]>`

**`DateIndexService`**
- Fetches `/data/dates`; holds sorted list of available dates
- TTL 5 minutes in-memory
- Exposes `availableDates$: Observable<string[]>`

**`NewspaperDataService` (slimmed)**
- Keeps: save operations, backup/restore, export/import, atomic page/section mutations
- Delegates all read operations to the three services above
- Keeps: `remoteDataChanged$`, `startVersionPoll()`, emergency draft logic

### 2.3 HTTP Cache Interceptor

Create `src/app/interceptors/http-cache.interceptor.ts`:

```typescript
// Pseudocode — illustrates the caching pattern
export const httpCacheInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.method !== 'GET') return next(req);
  if (!isCacheable(req.url)) return next(req);

  const cached = cacheStore.get(req.url);
  if (cached && !isExpired(cached)) {
    // Return from in-memory cache — zero network round-trip
    return of(new HttpResponse({ body: cached.body, status: 200 }));
  }

  // Add ETag for conditional request (304 = free validation)
  const conditionalReq = cached?.etag
    ? req.clone({ setHeaders: { 'If-None-Match': cached.etag } })
    : req;

  return next(conditionalReq).pipe(
    tap(event => {
      if (event instanceof HttpResponse) {
        if (event.status === 304) { /* refresh TTL, keep body */ }
        if (event.status === 200) { cacheStore.set(req.url, { body: event.body, etag: event.headers.get('ETag'), cachedAt: Date.now() }); }
      }
    })
  );
};

function isCacheable(url: string): boolean {
  return url.includes('/data/settings')
    || url.includes('/data/dates')
    || url.includes('/data/editions/')
    || url.includes('/data/version');
}
```

**Interceptor registration order** (important): `httpCacheInterceptor` → `wpApiInterceptor` → `loaderInterceptor`

### 2.4 Cache Invalidation Strategy

Three triggers already exist or are easy to add:

1. **Admin save** → server returns `newDataVersion` → Angular updates `dataSubject` → emit on `remoteDataChanged$` → `EditionCacheService` evicts the date that was saved
2. **`startVersionPoll()`** → version probe returns higher version → `remoteDataChanged$` emits → viewer silently reloads today's edition from network (bypassing cache)
3. **Manual hard refresh** — add a `clearCache()` method to `EditionCacheService` that wipes both in-memory Map and `localStorage` entries

**For the public viewer (non-admin):** Use the version poll at a longer interval (5 minutes instead of 30 seconds). Emit a soft notification ("New edition available — click to reload") rather than forcing a reload.

### 2.5 PWA / Service Worker

Add `@angular/pwa` to enable the Angular Service Worker:

```bash
ng add @angular/pwa
```

Configure `ngsw-config.json` with two cache strategies:

- **`/data/settings`**: `freshness` strategy (try network first, fall back to cache) — ensures users see fresh logo/theme
- **`/data/editions/:date`**: `performance` strategy for past dates (cache first, network never), `freshness` for today
- **Static assets** (JS, CSS, fonts): `performance` (cache forever, busted by build hash)

This gives offline support for past editions for free — once a user has opened a past date, it works without network.

### 2.6 State Management Recommendation

**Recommendation: Angular Signals-based store (no external library)**

Given the stack (Angular 21, no existing NgRx, small team, ~5 services), a Signals-based store is the right call:

- Angular 21 has mature `signal()`, `computed()`, `effect()` — no extra dependencies
- NgRx adds ~50 KB bundle overhead and significant boilerplate for a read-heavy display app
- The existing `BehaviorSubject` pattern maps cleanly to `signal()` + `computed()`

Pattern to adopt:
```typescript
// In EditionCacheService
readonly currentDate = signal<string>(this.getTodayDate());
readonly currentEditions = computed(() =>
  this.editionMap()[this.currentDate()] ?? []
);
readonly currentPages = computed(() =>
  this.currentEditions()[this.currentEditionIndex()] ?? null
);
```
Components use `{{ currentPages() }}` — no async pipe, no subscribe/unsubscribe.

---

## Section 3 — Security Checklist

### 3.1 WordPress Plugin (PHP)

- [ ] **Add HTTP security headers** to all public GET responses:
  ```php
  header('X-Content-Type-Options: nosniff');
  header('X-Frame-Options: SAMEORIGIN');
  header('Referrer-Policy: strict-origin-when-cross-origin');
  // Only add HSTS if the site is exclusively HTTPS:
  // header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
  ```
  Add these in `get_data_endpoint()`, `get_data_version_endpoint()`, and `get_settings_endpoint()` (new).

- [ ] **Rate limit public GET `/data` and `/data/editions/:date`**: Currently only login is rate-limited. A scraper calling `/data` in a tight loop would hammer the WordPress DB on every request. Add a lightweight transient-based rate limit: max 60 requests / 60 s per IP on public GETs.

- [ ] **Remove `SecRuleEngine Off` from .htaccess WAF bypass**: The current `.htaccess` rule disables ModSecurity for ALL requests to the plugin paths. Replace with targeted rule IDs to disable only the specific rules that block the REST API, not the entire engine:
  ```apache
  <IfModule mod_security2.c>
    SecRuleRemoveById 920170 920180 921110 949110
  </IfModule>
  ```
  This preserves injection/XSS protection while allowing the REST API through.

- [ ] **Scope the JWT secret**: The JWT is signed with `AUTH_KEY` from `wp-config.php`. Consider a dedicated constant `DN_JWT_SECRET` so rotating it doesn't affect WordPress cookie auth.

- [ ] **Add `Vary: Origin` to all CORS responses**: Already present on preflight; ensure it is on all actual responses so CDN doesn't serve the wrong origin's cached response.

- [ ] **Validate and sanitize all REST API input parameters**: The atomic endpoints (`PUT /data/page`, `PUT /data/section`) accept large JSON payloads. Add explicit schema validation (required fields, type checks, max string lengths) rather than relying on implicit casting.

- [ ] **Restrict `proxy_image` endpoint**: `GET /proxy` is currently public and accepts an arbitrary URL parameter. This is an open redirect / SSRF vector. Add an allowlist of permitted image domains (the site's own uploads URL + known CDN domains).

- [ ] **Review `warm_cache_permission`**: Currently just `auth_required`. Consider adding `admin_required` since warming the cache triggers heavy GD image processing.

### 3.2 Angular (Client)

- [ ] **Remove JWT from `localStorage` (long-term)**: JWTs in `localStorage` are accessible to any JavaScript on the page (XSS risk). Prefer `httpOnly` cookies for the token. Short-term mitigation: keep current approach but ensure `Content-Security-Policy` is set server-side to prevent script injection.

- [ ] **Add `Content-Security-Policy` header**: The PHP plugin should emit a CSP header on the main WordPress page that serves the Angular app. At minimum:
  ```
  Content-Security-Policy: default-src 'self'; script-src 'self'; img-src 'self' data: https://epaper.dailysangram.com;
  ```

- [ ] **Sanitize `headScripts` injection**: The `GlobalSettings.headScripts` field (raw HTML injected into `<head>`) is an XSS vector if an attacker can write to settings. Ensure only admin-role users can update settings, and consider stripping anything other than `<script>` and `<noscript>` tags on the server.

- [ ] **Add `withCredentials: false` for the new public read-only endpoints**: The `wpApiInterceptor` sets `withCredentials: true` on all requests. This is only needed for admin write operations. Public GET requests (`/data/settings`, `/data/editions/:date`) should not send credentials — it prevents CDN caching (CDNs refuse to cache credentialed responses).

---

## Section 4 — Angular Project Structure Recommendations

### 4.1 Proposed Folder Structure

```
src/app/
├── core/                          # Singleton services, app-level providers
│   ├── services/
│   │   ├── settings.service.ts        # NEW — GlobalSettings fetch + cache
│   │   ├── date-index.service.ts      # NEW — /data/dates
│   │   ├── edition-cache.service.ts   # NEW — per-date edition cache
│   │   ├── newspaper-data.service.ts  # SLIM — write ops, backup, export only
│   │   ├── auth.service.ts            # Keep as-is
│   │   ├── loader.service.ts          # Keep as-is
│   │   ├── lock.service.ts            # Keep as-is
│   │   └── activity-log.service.ts    # Keep as-is
│   └── interceptors/
│       ├── wp-api.interceptor.ts      # Keep as-is
│       ├── loader.interceptor.ts      # Keep as-is
│       └── http-cache.interceptor.ts  # NEW
├── features/
│   ├── viewer/                    # Public newspaper viewer
│   │   ├── viewer.component.ts    # Rename from newspaper.component.ts
│   │   ├── viewer.component.html
│   │   ├── viewer.component.css
│   │   └── components/            # Dumb components split out from viewer
│   │       ├── page-thumbnail/    # Extract from newspaper.component
│   │       ├── article-modal/     # Extract — modal display logic
│   │       ├── linked-articles/   # Extract — right panel with linked sections
│   │       └── section-overlay/  # Extract — section click overlays
│   └── admin/                     # Already lazy-loaded ✓
│       └── ...
├── shared/
│   ├── components/
│   │   ├── date-picker/           # Keep as-is
│   │   ├── loader/                # Keep as-is
│   │   └── share-buttons/         # Keep as-is
│   ├── directives/                # Keep action-tracker
│   ├── pipes/                     # Keep translate, locale-date
│   └── utils/                     # Keep image-resize
└── i18n/                          # Keep as-is
```

### 4.2 Smart / Dumb Component Split for Viewer

`newspaper.component.ts` is currently a smart god component. Split responsibility:

**Smart (container) — `ViewerComponent`:**
- Injects `EditionCacheService`, `SettingsService`, `DateIndexService`
- Holds `currentDate` signal, `selectedSection` signal, `showModal` signal
- Handles routing params (`date`, `page`, `edition`, `section`)
- Dispatches user actions to services

**Dumb (presentational) — child components:**
- `PageThumbnailComponent` — receives `@Input() page`, emits `(pageSelected)`
- `ArticleModalComponent` — receives `@Input() section`, `@Input() linkedSections`; emits `(close)`
- `SectionOverlayComponent` — receives `@Input() sections`, `@Input() pageImageSize`; emits `(sectionClick)`
- `DateNavComponent` — receives `@Input() dates`, `@Input() currentDate`; emits `(dateChange)`

This makes each component independently testable and eliminates the 200+ line `ngAfterViewChecked` / event handler block in the current component.

### 4.3 Signals Migration Path (Non-Breaking)

Do not rewrite everything at once. Migrate one service at a time:

1. `SettingsService` (new) — write with signals from day one
2. `DateIndexService` (new) — write with signals
3. `EditionCacheService` (new) — write with signals
4. `NewspaperDataService` (slimmed) — keep `BehaviorSubject` for now; migrate to `toSignal()` wrapper first, then inline signals in a later pass

`toSignal()` from `@angular/core/rxjs-interop` bridges existing Observable streams to signals with zero behaviour change.

---

## Master To-Do List

Items are grouped by area and ordered by priority. **Do not start implementation until this plan is reviewed.**

---

### 🔴 Priority 1 — Backend: Data Layer (Highest Impact)

- [ ] **WP-1** Split `wp_options` storage: migrate from single `dn_data` blob to per-date option keys (`dn_data_edition_YYYY-MM-DD`) + separate `dn_settings` key + `dn_data_index` (dates list + dataVersion). Keep the existing `get_data()` method working by assembling the full blob from per-date keys for backward compatibility.

- [ ] **WP-2** Add `GET /data/settings` endpoint: returns only `dn_settings`, with `Cache-Control: public, max-age=3600` and `ETag` header.

- [ ] **WP-3** Add `GET /data/dates` endpoint: returns sorted array of available dates from `dn_data_index`. `Cache-Control: public, max-age=300`.

- [ ] **WP-4** Add `GET /data/editions/:date` endpoint: returns only the requested date's editions from `dn_data_edition_YYYY-MM-DD`. `Cache-Control: public, max-age=86400` for past dates, `max-age=300` for today. Add `ETag` and `Last-Modified` headers. Support `If-None-Match` / `If-Modified-Since` for 304 responses.

- [ ] **WP-5** Update all admin write endpoints (`POST /data`, `PUT /data/page`, `PUT /data/section`) to write to the new per-date storage structure and update `dn_data_index`.

- [ ] **WP-6** Add `ETag` header to the existing `/data/version` endpoint response.

---

### 🔴 Priority 1 — Backend: Security

- [ ] **SEC-1** Add `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and `Referrer-Policy: strict-origin-when-cross-origin` headers to all public GET endpoint responses in the plugin.

- [ ] **SEC-2** Replace `SecRuleEngine Off` WAF bypass with targeted `SecRuleRemoveById` for specific ModSecurity rule IDs. Keep protection active for everything else.

- [ ] **SEC-3** Add allowlist validation to the `proxy_image` endpoint — only permit image URLs from the site's own `home_url()` and known CDN domains. Return 403 for any other domain.

- [ ] **SEC-4** Add rate limiting (transient-based) to public GET endpoints: max 120 requests / 60 s per IP. Return 429 with `Retry-After` header on breach.

---

### 🟡 Priority 2 — Angular: Caching & Services

- [ ] **NG-1** Create `src/app/core/services/settings.service.ts`: fetches `/data/settings`, caches in `localStorage` with version key, exposes `settings: Signal<GlobalSettings>`. Invalidates when `NewspaperDataService.remoteDataChanged$` emits a new version after a settings save.

- [ ] **NG-2** Create `src/app/core/services/date-index.service.ts`: fetches `/data/dates`, 5-minute in-memory TTL, exposes `availableDates: Signal<string[]>`.

- [ ] **NG-3** Create `src/app/core/services/edition-cache.service.ts`: per-date edition data. In-memory `Map` + `localStorage` for past dates. Fetches from `/data/editions/:date`. Exposes `getEditionsForDate(date): Observable<NewspaperEdition[]>`.

- [ ] **NG-4** Create `src/app/core/interceptors/http-cache.interceptor.ts`: in-memory response cache with ETag support for `/data/settings`, `/data/dates`, `/data/editions/*`. Register it before `wpApiInterceptor`.

- [ ] **NG-5** Update `wpApiInterceptor`: do NOT set `withCredentials: true` on requests to the new public read-only endpoints (`/data/settings`, `/data/dates`, `/data/editions/:date`). Only set it for write endpoints and `/data` (existing). This enables CDN caching of public responses.

- [ ] **NG-6** Update `NewspaperDataService.loadData()`: replace the monolithic load with a parallel `forkJoin` of `SettingsService.load()` + `DateIndexService.load()` + `EditionCacheService.getEditionsForDate(defaultDate)`. Keep the existing fallback chain (media library, emergency draft) intact.

- [ ] **NG-7** Update `startVersionPoll()` in `NewspaperDataService`: apply 5-minute interval for public viewer (currently 30 s — too aggressive for non-admin sessions), keep 30 s for admin sessions.

---

### 🟡 Priority 2 — PWA

- [ ] **PWA-1** Add `@angular/pwa` and `@angular/service-worker` via `ng add @angular/pwa`.

- [ ] **PWA-2** Configure `ngsw-config.json`:
  - `dataGroups`: `freshness` for `/data/settings` and `/data/dates`; `performance` for `/data/editions/*` (past dates)
  - `assetGroups`: `performance` for app shell (JS/CSS)

- [ ] **PWA-3** Add a service-worker update notification in `AppComponent`: when a new app version is deployed, show a toast "App updated — click to reload" using `SwUpdate.versionUpdates`.

---

### 🟡 Priority 2 — Angular: Code Quality

- [ ] **CQ-1** Refactor `newspaper.component.ts` → `ViewerComponent`: extract `ArticleModalComponent`, `SectionOverlayComponent`, `PageThumbnailComponent` as dumb `@Input`/`@Output` components. The viewer component's current length (~900 lines) should reduce to ~300.

- [ ] **CQ-2** Migrate `NewspaperDataService` to delegate reads to the three new services. After NG-1 through NG-3 are done, strip the load/cache/settings-read code from `NewspaperDataService`. Target size: ~500 lines (write ops only).

- [ ] **CQ-3** Replace `BehaviorSubject`-based state in the new services with `signal()` + `computed()` (Angular Signals). Do not rewrite the existing `NewspaperDataService` signals until new services are stable — use `toSignal()` as a bridge.

- [ ] **CQ-4** Add explicit input validation to `put_page_endpoint` and `put_section_endpoint` in the PHP plugin: check required field presence, type, and string max-lengths before processing. Return 422 with field-level error messages on invalid input.

- [ ] **CQ-5** Move hardcoded domain aliases in `normalize_domain_urls()` to a WordPress option (`dn_domain_aliases`) so they can be updated from the admin panel without code changes.

---

### 🟢 Priority 3 — Polish & Future-Proofing

- [ ] **FP-1** Add `Content-Security-Policy` header on the WordPress page that serves the Angular app shell. Start in report-only mode (`Content-Security-Policy-Report-Only`) to audit violations before enforcing.

- [ ] **FP-2** Move JWT secret from `AUTH_KEY` to a dedicated `DN_JWT_SECRET` constant in `wp-config.php`. Document how to rotate it.

- [ ] **FP-3** Add an `IndexedDB`-backed cache (via `idb` library, ~1.3 KB) for large edition payloads. `localStorage` has a 5–10 MB limit; a year of edition data with images will exceed it. `IndexedDB` supports gigabytes.

- [ ] **FP-4** Document the new endpoint contract in `DATA_STRUCTURE.md` and update `BACKEND_SETUP.md` with migration steps.

- [ ] **FP-5** Add a `/data/health` endpoint that returns plugin version, PHP version, data store stats (edition count, option size), and last-backup timestamp. Useful for monitoring.

---

## Implementation Order Summary

```
Phase 1 (Backend foundation — WP plugin):
  WP-1 → WP-2 → WP-3 → WP-4 → WP-5 → WP-6
  SEC-1 → SEC-2 → SEC-3 → SEC-4

Phase 2 (Angular services — parallel with Phase 1 if /data still works):
  NG-1 → NG-2 → NG-3 → NG-4 → NG-5 → NG-6 → NG-7

Phase 3 (PWA):
  PWA-1 → PWA-2 → PWA-3

Phase 4 (Code quality — can be done incrementally):
  CQ-1 → CQ-2 → CQ-3 → CQ-4 → CQ-5

Phase 5 (Polish):
  FP-1 through FP-5
```

---

## Non-Breaking Guarantee

Every item above maintains backward compatibility:

- The existing `GET /data` endpoint is never removed — only deprecated. Angular can fall back to it if the new endpoints are unavailable.
- The `emergency draft` localStorage key is preserved.
- The `dn_settings_cache` localStorage key is preserved and becomes the backing store for `SettingsService`.
- JWT format, token TTL, and auth headers are unchanged.
- All existing admin atomic endpoints remain in place.
- The `?rest_route=` WAF bypass in `wpApiInterceptor` continues to work for all endpoints.
