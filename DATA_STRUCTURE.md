# Data Structure & API Contract

**Plugin:** digital-newspaper/v1  
**Angular:** 21  
**Last updated:** 2026-06-07

---

## WordPress Option Keys

| Option key | Type | Description |
|---|---|---|
| `dn_data` | JSON blob | Legacy monolith — all editions + settings. Primary write target; read by `GET /data`. |
| `dn_settings` | JSON object | Global settings only (logo, language, social links, headScripts). Read by `GET /data/settings`. |
| `dn_data_index` | JSON object | `{ dates: string[], latestDate: string, dataVersion: number }`. Updated on every save. |
| `dn_edition_YYYY-MM-DD` | JSON object | Editions for that date: `{ editions: NewspaperEdition[], dataVersion: number }`. |
| `dn_data_backups` | JSON array | Rolling array of up to 10 backup snapshots. |
| `dn_allowed_origins` | string | Newline-separated list of permitted CORS origins. |
| `dn_allow_credentials` | bool | Whether `Access-Control-Allow-Credentials: true` is emitted. |
| `dn_domain_aliases` | JSON array | URL prefixes to normalise on image URLs (e.g. `["https://old.domain.com"]`). |
| `dn_storage_migrated_v2` | bool | Set `true` after the one-time v2 storage migration completes. |

### Storage migration (v1 → v2)

On the first `save_data()` or `GET /data/settings` after plugin update, `maybe_migrate_storage()` runs once:

1. Reads legacy `dn_data` blob.
2. Writes `dn_settings` from `blob.settings`.
3. Writes `dn_data_index` from `blob.editions` (dates list + dataVersion).
4. Writes one `dn_edition_YYYY-MM-DD` key per unique date found in `blob.editions`.
5. Sets `dn_storage_migrated_v2 = true` — migration is skipped on all subsequent requests.

A 60-second transient lock (`dn_migration_lock`) prevents concurrent migration races.

Subsequent `save_data()` calls **dual-write**: update `dn_data` (backward compat) AND call `write_per_date_storage()` (non-fatal — failure is logged but never fails the save).

**Rolling back to v1:** Revert the plugin PHP file. `dn_data` blob is intact — no data loss.

---

## REST API Endpoints

**Base URL:** `https://your-wordpress.com/wp-json/digital-newspaper/v1`  
**WAF bypass:** `?rest_route=/digital-newspaper/v1{path}` — use this if Imunify360 / ModSecurity blocks the standard WP REST path.

### Public Read Endpoints

These endpoints require no authentication and are CDN-cacheable. The Angular `wpApiInterceptor` sets `withCredentials: false` for all paths listed here.

---

#### `GET /data/settings`

Returns global settings only.

```json
{
  "settings": {
    "logoUrl": "https://...",
    "language": "bn",
    "defaultDateMode": "current",
    "socialLinks": { "facebook": "https://...", "twitter": "https://..." },
    "headScripts": ""
  },
  "dataVersion": 1749300000.123
}
```

| Header | Value |
|---|---|
| `Cache-Control` | `public, max-age=3600, s-maxage=3600` |
| `ETag` | `"dn-settings-{md5}"` |
| `Vary` | `Origin` |

Returns **304 Not Modified** when `If-None-Match` header matches current ETag.  
Returns **429 Too Many Requests** if rate limit exceeded (120 req / 60 s per IP).

---

#### `GET /data/dates`

Returns the sorted list of available edition dates.

```json
{
  "dates": ["2026-06-07", "2026-06-06", "2026-06-05"],
  "latestDate": "2026-06-07"
}
```

| Header | Value |
|---|---|
| `Cache-Control` | `public, max-age=300, s-maxage=300` |
| `Vary` | `Origin` |

---

#### `GET /data/editions/:date`

Returns all editions for a single calendar date. `:date` must be `YYYY-MM-DD`.

```json
{
  "date": "2026-06-07",
  "editions": [
    {
      "date": "2026-06-07",
      "edition": 1,
      "pages": [
        {
          "pageNumber": 1,
          "imagePath": "https://...",
          "sections": [
            {
              "id": "s-001",
              "title": "খবর শিরোনাম",
              "x": 10.5,
              "y": 5.0,
              "width": 30.0,
              "height": 15.0,
              "content": "<p>...</p>",
              "imageUrl": "https://...",
              "linkedSectionIds": ["s-002"]
            }
          ]
        }
      ]
    }
  ],
  "dataVersion": 1749300000.123
}
```

**Cache TTL by date:**

| Date | `Cache-Control` |
|---|---|
| Past (< today) | `public, max-age=86400, s-maxage=86400` (24 h — immutable) |
| Today | `public, max-age=300, s-maxage=300` (5 min — still editable) |

| Header | Value |
|---|---|
| `ETag` | `"dn-{date}-{shortHash}"` — hash covers `date + dataVersion` |
| `Last-Modified` | RFC 7231 datetime |
| `Vary` | `Origin` |

Returns **304** on `If-None-Match` / `If-Modified-Since` match.  
Returns **422 Unprocessable Entity** for invalid date format:
```json
{ "error": "Invalid date format.", "fields": { "date": "Expected YYYY-MM-DD." } }
```

---

#### `GET /data` (legacy — kept for backward compat)

Returns the full `dn_data` blob (all editions + settings in one payload).  
Used by `NewspaperDataService.loadData()` as the primary load path until granular reads are fully adopted.

---

#### `GET /data/version`

Returns the current `dataVersion` scalar. Used by version-poll.

```json
{ "dataVersion": 1749300000.123 }
```

| Header | Value |
|---|---|
| `ETag` | `"dn-version-{dataVersion}"` |
| `Cache-Control` | `public, max-age=30, s-maxage=30` |

**Polling intervals:**
- Public viewer: every **5 minutes** (`startVersionPoll(300_000)`)
- Admin panel: every **30 seconds**

---

### Authenticated Write Endpoints

All require `Authorization: Bearer {JWT}`. `Content-Type: application/json`.

---

#### `POST /data` — full save

Saves the entire `NewspaperData` object. Dual-writes to `dn_data` + per-date option keys.

Response: `{ "success": true, "newDataVersion": 1749300001.456, ... }`  
`Cache-Control: no-store` on all admin write responses.

---

#### `PUT /data/page` — atomic page save

Saves one page within one edition of one date. Invalidates the affected date's HTTP and in-memory caches.

Request:
```json
{
  "date": "2026-06-07",
  "edition": 1,
  "pageNumber": 3,
  "page": { "pageNumber": 3, "imagePath": "...", "sections": [] }
}
```

Validation rules (422 on failure):
- `date`: required, `YYYY-MM-DD`
- `edition`: required, integer 1–99
- `pageNumber`: required, positive integer
- `page`: required object

Response: `{ "success": true, "newDataVersion": float }`

---

#### `PUT /data/section` — atomic section save

Saves one section within one page.

Request:
```json
{
  "date": "2026-06-07",
  "edition": 1,
  "pageNumber": 3,
  "sectionIndex": 0,
  "section": { "id": "s-001", "title": "...", "content": "...", "x": 0, "y": 0, "width": 30, "height": 15 }
}
```

Validation: all fields required; `sectionIndex` must be a non-negative integer.

---

#### `GET /data/health` — admin-only

Requires WordPress `administrator` role. Returns plugin health stats.

```json
{
  "status": "ok",
  "pluginVersion": "3.x",
  "phpVersion": "8.2",
  "wpVersion": "6.x",
  "storageMode": "per-date",
  "editionCount": 365,
  "pageCount": 3650,
  "sectionCount": 50000,
  "blobSizeBytes": 1234567,
  "lastBackupAt": "2026-06-07T10:00:00+00:00",
  "backupCount": 10
}
```

---

## Section Coordinate System

All position fields use **percentages of the page image dimensions** (0–100):

| Field | Description |
|---|---|
| `x` | Left edge of section, % of page width |
| `y` | Top edge of section, % of page height |
| `width` | Section width, % of page width |
| `height` | Section height, % of page height |

At render time the Angular viewer multiplies these by the rendered image size to position `<div>` overlays precisely over the newspaper image.

---

## Angular Cache Architecture

### Three-Layer Edition Cache (`EditionCacheService`)

```
Layer 1: In-memory Map<date, entry>       (fastest, in-process)
  ├─ Past dates: never expire             (data is immutable)
  └─ Today: 5-minute TTL

Layer 2: localStorage key dn_edition_YYYY-MM-DD  (past dates only)
  └─ Survives page reload
  └─ Today's date is NEVER written here

Layer 3: HTTP GET /data/editions/:date
  └─ HTTP cache interceptor may short-circuit before network
```

Eviction: `evict(date)` removes the memory entry. `clearMemory()` wipes all.  
`seedFromLoadedData(allEditions)` pre-populates layers 1 + 2 from the initial `GET /data` load.

### HTTP Cache Interceptor (`http-cache.interceptor.ts`)

| Endpoint | In-memory TTL | ETag |
|---|---|---|
| `/data/settings` | 1 hour | yes |
| `/data/dates` | 5 minutes | no |
| `/data/editions/*` | 5 min (today) / ∞ (past) | yes |
| `/data/version` | 30 seconds | yes |

Cache key strips `?_t=` cache-busters before keying.

**Invalidation triggers:**
- Full `POST /data` save → `clearHttpCache()` (wipes all)
- Atomic `PUT /data/page` or `/data/section` → `evictEditionCache(date)` (targeted)

### Settings Cache (`SettingsService`)

- Seeded from `localStorage['dn_global_settings']` at startup
- Network refresh via `GET /data/settings` (1-hour HTTP cache TTL)
- Exposed as `settings: Signal<GlobalSettings>` — synchronous reactive reads

### Date Index (`DateIndexService`)

- `availableDates: Signal<string[]>`, `latestDate: Signal<string>`
- Seeded from `loadData()` via `syncFromEditions()` — no extra HTTP call on startup
- Refreshed on demand via `GET /data/dates`

---

## JWT Authentication

| Property | Value |
|---|---|
| Algorithm | HS256 |
| Secret lookup | `DN_JWT_SECRET` → `AUTH_KEY` → `LOGGED_IN_KEY` |
| Claims | `sub` (username), `iat`, `exp` |
| Storage | `localStorage['dn_admin_jwt']` |

**Adding `DN_JWT_SECRET` to `wp-config.php`:**
```php
define( 'DN_JWT_SECRET', 'your-strong-random-secret-here-min-32-chars' );
```
Rotating this constant invalidates all existing admin JWTs but does not affect WordPress cookie sessions.

---

## Security Notes

- Public GET endpoints apply **120 requests / 60 s per IP** rate limiting (WordPress transient-based). Violations return 429 with `Retry-After: 60`.
- WAF bypass is scoped via `<LocationMatch "...(wp-json/digital-newspaper|rest_route=/digital-newspaper)...">` — not site-wide.
- `warm_cache` requires `administrator` role (triggers heavy GD image processing).
- `headScripts` (raw HTML injected into `<head>`) is an XSS vector — only admin-role users can write it.
- Public endpoints use `withCredentials: false` in Angular — required for CDN to cache responses (credentialed requests are never cached per the CORS spec).
- `Content-Security-Policy-Report-Only` header emitted on the WordPress page that serves the Angular app shell (audit mode — no blocking).
