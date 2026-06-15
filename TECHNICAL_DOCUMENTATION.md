# Digital Newspaper — Technical Documentation

> **Stack:** Angular 21 (standalone components, signals, RxJS) + WordPress REST API plugin  
> **Environments:** Dev → `epaper.dailysangram.com/wp` | Prod → `nepaper.dailysangram.com/wp`  
> **REST namespace:** `digital-newspaper/v1` (all routes below are relative to `/wp-json/digital-newspaper/v1`)

---

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Authentication](#2-authentication)
3. [REST API Endpoints (complete)](#3-rest-api-endpoints)
4. [Data Models](#4-data-models)
5. [Database & WordPress Storage](#5-database--wordpress-storage)
6. [Caching System (4-layer)](#6-caching-system)
7. [Angular Services](#7-angular-services)
8. [Viewer Component — Buttons & Workflows](#8-viewer-component--buttons--workflows)
9. [Admin Component — Buttons & Workflows](#9-admin-component--buttons--workflows)
10. [Data Flow: Load Sequence](#10-data-flow-load-sequence)
11. [Data Flow: Save Sequence](#11-data-flow-save-sequence)
12. [Locking System](#12-locking-system)
13. [Activity Log](#13-activity-log)
14. [Image Proxy & Media Upload](#14-image-proxy--media-upload)
15. [PWA & Version Polling](#15-pwa--version-polling)
16. [Security & Hosting Compatibility](#16-security--hosting-compatibility)

---

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Angular SPA (Client)                         │
│                                                                 │
│  NewspaperComponent (viewer)   AdminComponent (editor)         │
│         │                              │                        │
│  NewspaperDataService  ←──────  EditionCacheService            │
│         │                              │                        │
│  HttpCacheInterceptor  ←──── IdbCacheService (IndexedDB)       │
│         │                                                       │
│  AuthService (JWT in localStorage)                             │
│         │                                                       │
└─────────────────┬───────────────────────────────────────────────┘
                  │  HTTPS + Bearer JWT
┌─────────────────▼───────────────────────────────────────────────┐
│              WordPress REST API Plugin                          │
│                                                                 │
│  digital-newspaper.php (Class Digital_Newspaper_API)           │
│         │                                                       │
│  ┌──────┴──────────────────────────────────────────┐           │
│  │  wp_options table (primary data store)          │           │
│  │  • dn_settings          — global settings       │           │
│  │  • dn_data_index        — date list + version   │           │
│  │  • dn_edition_YYYY-MM-DD — per-date editions    │           │
│  │  • dn_data              — legacy full blob      │           │
│  │  • dn_data_backups      — rotation snapshots    │           │
│  └─────────────────────────────────────────────────┘           │
│  ┌──────────────────────────────────────────────────┐           │
│  │  wp_posts (dn_section custom post type)          │           │
│  │  dn_activity_log (custom DB table)               │           │
│  │  wp_options transients  (locks, rate limits)     │           │
│  └──────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Authentication

### Flow

1. User submits login form → `AuthService.login(username, password)`
2. `POST /auth/login` with `Content-Type: application/x-www-form-urlencoded`
3. Server calls `wp_authenticate()`, checks rate limit (5 attempts / 10 min per IP)
4. On success: generates HS256 JWT (TTL 86 400 s = 24 h), sets WordPress auth cookie (`wp_set_auth_cookie`)
5. Angular stores `token → localStorage["dn_wp_token"]` and `{displayName, role, userId} → localStorage["dn_wp_user"]`
6. All subsequent authenticated requests add:
   - `Authorization: Bearer <token>`
   - `X-Authorization: Bearer <token>` ← Apache strips `Authorization` on shared hosting; this is the fallback

### Token Validation (client-side)

`AuthService.isAuthenticated()`:
- Splits JWT, base64-decodes payload, checks `exp` field
- Cross-validates `payload.sub` vs `localStorage["dn_wp_user"].userId`
- Calls `logout()` (removes both localStorage keys) on any mismatch

### Token Verification (server-side)

`GET /auth/me` → server reads current WP user via cookie or Bearer token, returns `{id, username, email, displayName, role}`. Angular calls this on admin bootstrap to confirm the session is still valid.

### Role-based Access

| Role | Capabilities |
|------|-------------|
| `administrator` | Full access: settings, backups, restore, lock-force, bulk import |
| `editor` | Data read/write, media upload, lock acquire/release |
| Public (unauthenticated) | Read-only: `GET /data`, `GET /data/*`, `GET /proxy` |

---

## 3. REST API Endpoints

All routes: `https://{host}/wp-json/digital-newspaper/v1{path}`

### 3.1 Data — Read

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/data` | Public | Legacy full blob. Returns `{editions[], settings, dataVersion}`. Falls back to monolith `dn_data` option. Cached by HTTP interceptor for 5 min (today) / 24 h (past). |
| `GET` | `/data/version` | Public | Lightweight version check. Returns `{dataVersion, updatedAt}`. HTTP cache: 30 s. Used by version poll. |
| `GET` | `/data/settings` | Public | Global settings only. Returns `{settings, dataVersion}`. ETag-based, HTTP cache: 1 h. |
| `GET` | `/data/dates` | Public | Returns `{dates: string[], dataVersion}`. HTTP cache: 5 min. Reads `dn_data_index`. |
| `GET` | `/data/editions/{date}` | Public | Per-date editions. Returns `{date, editions[], dataVersion}`. HTTP cache: 5 min (today) / 24 h (past). Reads `dn_edition_{date}` option. |
| `GET` | `/data/health` | Public | Diagnostics: storage stats, PHP memory, option sizes. |
| `GET` | `/data/export-full` | Auth (editor+) | Full JSON export. 2-minute timeout. Returns entire dataset as JSON file. |
| `GET` | `/data/backups` | Auth (editor+) | Returns list of up to 20 rotation snapshots from `dn_data_backups`. |

### 3.2 Data — Write

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/data` | Auth (editor+) | Full dataset save. Body: `{editions[], settings, dataVersion}`. Clears all caches. Writes `dn_data` (legacy blob), all `dn_edition_*` options, `dn_settings`, `dn_data_index`. Syncs all `dn_section` posts. Takes full backup snapshot. |
| `PATCH` | `/data/settings` | Auth (editor+) | Settings-only save. Body: `{settings}`. Writes only `dn_settings` + bumps `dn_data_index.dataVersion`. No edition data touched. |
| `PUT` | `/data/page` | Auth (editor+) | Atomic page upsert. Body: `{date, edition, page}`. Read-modify-write on `dn_edition_{date}` only. Lock enforced. |
| `DELETE` | `/data/page` | Auth (editor+) | Atomic page delete. Body: `{date, edition, pageId}`. Read-modify-write on `dn_edition_{date}`. Lock enforced. Syncs `dn_section` posts. |
| `PUT` | `/data/section` | Auth (editor+) | Atomic section upsert. Body: `{date, edition, pageId, section, originalSectionId?}`. Single `upsert_section_post()` call (O(1) vs full sync). Lock enforced. |
| `DELETE` | `/data/section` | Auth (editor+) | Atomic section delete. Body: `{date, edition, pageId, sectionId}`. Lock enforced. |
| `PUT` | `/data/editions-for-date` | Auth (editor+) | Replace all editions for a given date. Body: `{date, editions[]}`. Used when adding/removing editions. |
| `POST` | `/data/restore` | Auth (admin) | Restore a backup. Body: `{index}`. Loads snapshot from `dn_data_backups[index]`, writes all storage options. |
| `POST` | `/data/rebuild-from-sections` | Auth (admin) | Reconstructs edition data from `dn_section` WP posts. Used as a recovery tool. |

### 3.3 Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/login` | Public | Body: form-urlencoded `{username, password}`. Rate-limited: 5 attempts/10 min. Returns `{token, user}`. Sets WP auth cookie. |
| `GET` | `/auth/me` | Auth | Returns `{id, username, email, displayName, role}` for the token bearer. |

### 3.4 Locking

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/locks/{resource}` | Auth | Check if a resource is locked. Returns `{locked, heldBy, expiresAt}`. |
| `POST` | `/locks/{resource}` | Auth | Acquire lock. Returns 200 if acquired, 423 if held by another user. Resource format: `{date}:{edition}:{pageId}`. |
| `DELETE` | `/locks/{resource}` | Auth | Release lock. Only holder may release; admin can add `?force=1`. |
| `POST` | `/locks/{resource}/heartbeat` | Auth | Renew lock TTL (call every 30 s). Server TTL is 90 s. |
| `GET` | `/locks` | Auth (admin) | List all active locks (for admin lock management panel). |

### 3.5 Media

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/media` | Auth (editor+) | Upload image file. Multipart form-data. Returns `{id, url, filename}`. Writes to WP Media Library. |
| `DELETE` | `/media/{id}` | Auth (editor+) | Delete media item from WP Media Library by attachment ID. |

### 3.6 Activity Log

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/activity-log` | Auth (editor+) | Paginated activity log. Query params: `page`, `per_page`, `action`, `user`, `date_from`, `date_to`, `sort`, `order`. |
| `POST` | `/activity-log/batch` | Auth (editor+) | Log multiple events in one request. Body: `{events[]}`. |

### 3.7 Social & Utilities

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/proxy` | Public | Image proxy for CORS canvas cropping. Query: `?url=...`. Validates against allowed hosts. Returns image bytes. Fast path: serves directly from local uploads directory. |
| `GET` | `/social` | Public | Returns social share metadata for a section (OG tags). |
| `GET` | `/social-image` | Public | Returns or generates OG image for a section. |
| `POST` | `/warm-cache` | Auth (admin) | Pre-warms edition cache on server. |

### 3.8 Diagnostics

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/diag/last-fatal` | Auth (admin) | Returns last PHP fatal error recorded by the plugin's shutdown handler. |
| `GET` | `/diag/sample-section` | Auth (admin) | Returns a sample section from the dataset (for debugging). |
| `GET` | `/diag/scan-broken` | Auth (admin) | Scans for broken/missing image URLs across all editions. |

---

## 4. Data Models

### GlobalSettings

```typescript
interface GlobalSettings {
  logo?: string;                  // URL
  siteName?: string;
  socialLinks?: { platform: string; url: string }[];
  language?: string;              // e.g. "bn", "en"
  underMaintenance?: boolean;     // Triggers maintenance page in viewer
  headScripts?: string;           // Raw HTML injected into <head>
  allowedOrigins?: string[];
  domainAliases?: string[];
  defaultDate?: string;
  // ... other UI config fields
}
```

### NewspaperEdition

```typescript
interface NewspaperEdition {
  date: string;                  // YYYY-MM-DD
  edition: number;               // 1-based
  editionLabels?: string[];
  pages: NewspaperPage[];
}
```

### NewspaperPage

```typescript
interface NewspaperPage {
  id: number;                    // 1–9999
  pageLabels?: string[];
  imageUrl?: string;             // Full page image URL
  thumbnailUrl?: string;
  sections: NewsSection[];
}
```

### NewsSection

```typescript
interface NewsSection {
  id: string;                   // Unique within page
  title?: string;
  content?: string;             // HTML (Quill output)
  imageUrl?: string;            // Cropped/standalone image URL
  x?: number;                   // Crop region (0–100 %)
  y?: number;
  width?: number;
  height?: number;
  linkedSections?: string[];    // IDs of related sections
  // ... other display metadata
}
```

### NewspaperData (full response shape)

```typescript
interface NewspaperData {
  editions: NewspaperEdition[];
  settings: GlobalSettings;
  dataVersion: number;          // Float, monotonically increasing
}
```

---

## 5. Database & WordPress Storage

### wp_options (primary key-value store)

| Option Key | Type | Contents | Written By |
|------------|------|----------|-----------|
| `dn_settings` | JSON object | GlobalSettings | `PATCH /data/settings`, `POST /data` |
| `dn_data_index` | JSON object | `{dates: string[], dataVersion: float}` | Every write operation |
| `dn_edition_YYYY-MM-DD` | JSON array | `NewspaperEdition[]` for that date | Every atomic/full save for that date |
| `dn_data` | JSON object | Full legacy blob (all editions + settings) | `POST /data` full saves only |
| `dn_data_backups` | JSON array | Up to 20 rotation snapshots | Every full save (throttled: 1 per 5 min for atomic ops) |
| `dn_allowed_origins` | JSON array | CORS allowed origin list | Admin settings save |
| `dn_domain_aliases` | JSON array | Domain alias pairs | Admin settings save |
| `dn_storage_migrated_v2` | bool | Migration flag (granular format adopted) | One-time migration |

> **Granular vs Legacy:** The plugin writes per-date options (`dn_edition_*`) on every save and also writes the full `dn_data` blob only on full `POST /data` saves. Atomic endpoint reads (`PUT /data/page`, `PUT /data/section`) use `get_data_scoped_to_date()` which reads only the target date's option — dramatically reducing MySQL payload from ~30–50 MB to a few hundred KB.

### wp_posts — `dn_section` custom post type

Every section is mirrored as a WordPress post of type `dn_section`. This enables:
- WordPress search indexing of section content
- Social OG meta tag injection
- Potential REST/GraphQL queries via standard WP post APIs

Post meta fields store: `date`, `edition`, `pageId`, `sectionId`, `editionLabels`, `pageLabels`, `sectionIndex`.

`sync_posts` flag controls whether a save triggers full post sync (O(N) — all sections) or targeted single-section upsert (O(1)). Atomic section saves always use the targeted path.

### Custom DB Table — Activity Log

Created by `maybe_create_activity_table()` on plugin activation:

```sql
CREATE TABLE {prefix}dn_activity_log (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  action      VARCHAR(100),
  message     TEXT,
  context     LONGTEXT,        -- JSON
  user_id     BIGINT UNSIGNED,
  user_name   VARCHAR(255),
  user_role   VARCHAR(100),
  ip_address  VARCHAR(100),
  created_at  DATETIME
)
```

### wp_options Transients (ephemeral)

| Transient Key Pattern | Purpose | TTL |
|----------------------|---------|-----|
| `dn_lock_{resource}` | Page/section edit lock | 90 s (renewed via heartbeat) |
| `dn_login_attempts_{ip_hash}` | Brute-force rate limiting | 600 s (10 min) |

---

## 6. Caching System

The app uses a **4-layer cache** for edition data and a separate **HTTP-level interceptor** for all API responses.

### 6.1 Edition Cache — 4 Layers (EditionCacheService)

```
Request for date's editions
         │
         ▼
┌─────────────────────────────────┐
│ Layer 1: In-memory Map          │  sync, fastest
│ Past dates: never expire        │
│ Today: 5-min TTL                │
└────────────┬────────────────────┘
             │ miss
             ▼
┌─────────────────────────────────┐
│ Layer 2a: localStorage          │  sync, ~5–10 MB
│ Key: dn_edition_YYYY-MM-DD      │  past dates only
│ Format: { editions: [...] }     │
└────────────┬────────────────────┘
             │ miss
             ▼
┌─────────────────────────────────┐
│ Layer 2b: IndexedDB             │  async, ~GB quota
│ DB: dn-edition-cache            │  past dates only
│ Store: editions                 │
│ Key: date string                │
│ (write-back to LS on hit)       │
└────────────┬────────────────────┘
             │ miss
             ▼
┌─────────────────────────────────┐
│ Layer 3: HTTP GET               │  async, network
│ /data/editions/{date}           │
│ (HTTP interceptor may serve     │
│  from its own TTL/ETag store)   │
└─────────────────────────────────┘
```

**Today's data** is never persisted to localStorage or IndexedDB — it skips layers 2a/2b entirely and goes direct to HTTP every time (TTL expires in 5 min in memory).

**Cache invalidation:**
- `evict(date)` — called after every atomic write for that date. Removes from all 3 layers (mem + localStorage + IDB).
- `clearMemory()` — called after full `POST /data` save. Clears memory + fires async IDB clear.
- `seedFromLoadedData()` — pre-populates memory from the initial `loadData()` response to avoid redundant HTTP calls.

### 6.2 HTTP Cache Interceptor (HttpCacheInterceptor)

Sits in the Angular HTTP pipeline. Uses an in-memory Map of `{ body, etag, expiresAt }` keyed by URL.

| URL Pattern | TTL | Notes |
|-------------|-----|-------|
| `/data/settings` | 60 min | ETag stored; sends `If-None-Match`; 304 refreshes TTL |
| `/data/dates` | 5 min | ETag-backed |
| `/data/editions/{date}` | 5 min (today) / 24 h (past) | Dynamic TTL from date comparison |
| `/data/version` | 30 s | Lightweight poll endpoint |

On cache hit: returns stored body immediately, no network call.  
On ETag hit (304 from server): refreshes TTL without re-parsing body.

**Cache invalidation:**
- `clearHttpCache()` — called after full `POST /data` save. Wipes all entries.
- `evictEditionCache(date)` — removes editions + dates entries for a specific date. Called before and after atomic writes.

### 6.3 Crop Cache (in-memory, component-level)

`cropCache: Map<string, string>` in `NewspaperComponent`. Key: `{pageId}:{sectionId}`. Value: PNG data URL from Canvas API crop. Lives only for the page session.

### 6.4 Resolved URL Cache (in-memory, component-level)

`resolvedUrlCache: Map<string, string>` — caches proxy URL resolutions to avoid repeated `/proxy?url=` calls for the same image.

---

## 7. Angular Services

### NewspaperDataService (2055 lines)

Central data orchestrator. Manages load, save, cache coordination.

**Key methods:**

| Method | Description |
|--------|-------------|
| `loadData()` | Tries granular API (3–4 small requests), falls back to legacy blob, then emergency draft from localStorage |
| `hydrateDateIfMissing(date)` | Loads editions for a date if not already in memory |
| `saveData(data)` | `POST /data` full save — clears all caches post-save |
| `saveSettingsOnly(settings)` | `PATCH /data/settings` |
| `savePageAtomically(page, date, edition)` | `PUT /data/page` + cache eviction |
| `saveSectionAtomically(...)` | `PUT /data/section` + cache eviction |
| `deletePageAtomically(...)` | `DELETE /data/page` + cache eviction |
| `deleteSectionAtomically(...)` | `DELETE /data/section` + cache eviction |
| `saveEditionsForDateAtomically(date)` | `PUT /data/editions-for-date` |
| `startVersionPoll(intervalMs)` | Polls `/data/version`, emits `remoteDataChanged` signal |
| `downloadExportFull()` | `GET /data/export-full` (2-min timeout) |
| `listServerBackups()` | `GET /data/backups` |
| `restoreServerBackup(index)` | `POST /data/restore` |
| `rebuildDataFromSectionPosts()` | `POST /data/rebuild-from-sections` |

**localStorage keys used:**

| Key | Contents |
|-----|----------|
| `dn_global_settings` | Settings cache (used for offline fallback) |
| `dn_backup_history` | Local backup history log |
| `dn_emergency_local_draft` | Emergency fallback when server is unreachable |
| `dn_wp_token` | JWT Bearer token |
| `dn_wp_user` | `{displayName, role, userId}` |
| `dn_edition_YYYY-MM-DD` | Per-date edition cache (past dates) |

### EditionCacheService

See §6.1. Manages the 4-layer edition cache.

### IdbCacheService

Thin wrapper over IndexedDB. DB: `dn-edition-cache`, version 1, object store: `editions`.  
Methods: `get(date)`, `set(date, editions)`, `delete(date)`, `clear()`, `count()`.

### AuthService

See §2. Manages JWT lifecycle. Key: `getAuthHeaders()` returns dual-header object for all authenticated requests.

### LockService

See §12. Manages optimistic page locking.

---

## 8. Viewer Component — Buttons & Workflows

### Date Navigation

| Button / Control | Handler | What happens |
|-----------------|---------|-------------|
| **← Previous Day** | `previousDay()` | Decrements current date, calls `onDateChange()` → `loadCurrentEdition()` → fetches editions for new date via cache/HTTP |
| **→ Next Day** | `nextDay()` | Increments current date, same flow |
| **Date Picker** (`app-date-picker`) | `onDatePickerChange(date)` | Sets selected date, same flow |
| **Edition dropdown** | `onEditionChange(n)` | Sets `currentEdition`, calls `loadCurrentEdition()` with new edition number |

### Page Navigation

| Button / Control | Handler | What happens |
|-----------------|---------|-------------|
| **Page thumbnail** (left panel) | `onPageClick(page)` | Calls `selectPage(page)` — sets `currentPage`, queues main image load, starts 8 s slow-connection timer |
| **Page dropdown** (toolbar) | `onPageDropdownChange(id)` | Finds page by ID, calls `selectPage()` |
| **Pagination bar** arrows | `selectPage(prev/next)` | Sequential page navigation |

### Section Interaction

| Button / Control | Handler | What happens |
|-----------------|---------|-------------|
| **Section overlay click** (`app-section-overlay`) | `selectSection(section)` | Sets `selectedSection`, loads linked sections, tries canvas crop or falls back to `section.imageUrl`, calls `updateUrl()` and `updateMetaTags()` |
| **Close section** (right panel ×) | `closeSection()` | Clears `selectedSection`, restores URL |
| **Read Article** | `openContentModal()` | Opens `app-article-modal` with section content (Quill HTML) |
| **Section image click** | `openImageModal()` | Opens image modal with full-size cropped or section image |

### Print & Download

| Button | Handler | What happens |
|--------|---------|-------------|
| **Print page** | `printContent()` | Opens blank `window.open('')`, writes `<img>` HTML, calls `win.print()` |
| **Print image** | `printImage()` | Same but targeted at the section/page image |
| **Print all (modal)** | `printAllModalImages()` | Prints all images currently open in modal |
| **Download image** | `downloadImage()` | Fetches blob (direct or via `/proxy`), creates `<a download>` element, triggers click |

### URL & Meta

After any section selection, `updateUrl()` sets `location.replaceState()` to:
```
/{date}/page-{N}/edition-{N}/post-{sectionId}/
```

`updateMetaTags(section)` updates `<meta property="og:*">` and `<meta name="twitter:*">` tags in the DOM for social sharing.

### Hamburger Menu (mobile)

| Button | Handler | What happens |
|--------|---------|-------------|
| **☰ Menu toggle** | `toggleMobileHeaderMenu()` | Toggles `mobileMenuOpen` signal, shows/hides mobile nav drawer |

---

## 9. Admin Component — Buttons & Workflows

### Authentication

| Button | Handler | What happens |
|--------|---------|-------------|
| **Login** | `onLogin()` | Calls `AuthService.login()` → `POST /auth/login`. On success: stores JWT + user, initializes admin data. On WAF block: shows specific error. On rate limit (429): shows lockout timer. |
| **Logout** | `onLogout()` | Calls `AuthService.logout()` (removes localStorage keys), resets admin state |

### Page Management

| Button | Handler | What happens |
|--------|---------|-------------|
| **+ Add Page** | `addPage()` | Creates new `NewspaperPage` object with auto-incremented ID, pushes to current edition, calls `savePageAtomically()` → `PUT /data/page` |
| **✏ Edit Page** | `editPage(page)` | Sets `editingPage`, acquires lock via `LockService.acquireLock()` → `POST /locks/{resource}`, starts heartbeat |
| **🗑 Delete Page** | `deletePage(page)` | Confirms, calls `deletePageAtomically()` → `DELETE /data/page`, releases lock |
| **↑↓ Reorder Pages** | drag-and-drop / arrow buttons | Updates page order in local array, calls `saveEditionsForDateAtomically()` → `PUT /data/editions-for-date` |
| **Save Page** | `saveCurrentPage()` | Calls `savePageAtomically(page, date, edition)` → `PUT /data/page`. Shows success/error toast. |

### Section Management

| Button | Handler | What happens |
|--------|---------|-------------|
| **+ Add Section** | `addSection()` | Creates new `NewsSection`, pushes to `editingPage.sections`, calls `saveSectionAtomically()` → `PUT /data/section` |
| **✏ Edit Section** | `editSection(section)` | Opens section editor, loads Quill for rich text content |
| **🗑 Delete Section** | `deleteSection(section)` | Calls `deleteSectionAtomically()` → `DELETE /data/section` |
| **Save Section** | `saveSection()` | Calls `saveSectionAtomically(pageId, section, originalId, date, edition)` → `PUT /data/section`. `originalSectionId` handles ID renames. |
| **Crop Image** | canvas crop tool | Uses HTML5 Canvas to define crop region; stores `{x, y, width, height}` on section; saved with section on `saveSectionAtomically()` |
| **Image URL / File toggle** | `imageInputMode = 'url' | 'file'` | Switches between direct URL entry and file upload via `POST /media` |

### Edition Management

| Button | Handler | What happens |
|--------|---------|-------------|
| **+ Add Edition** | `addEdition()` | Pushes new edition to current date, calls `saveEditionsForDateAtomically()` → `PUT /data/editions-for-date` |
| **🗑 Delete Edition** | `deleteEdition(n)` | Filters edition from array, calls `saveEditionsForDateAtomically()` |
| **Switch Edition** | edition tab/dropdown | Updates `currentEdition`, loads pages for that edition |

### Settings

| Button | Handler | What happens |
|--------|---------|-------------|
| **Save Settings** | `saveSettings()` | Calls `NewspaperDataService.saveSettingsOnly(settings)` → `PATCH /data/settings`. Updates `dn_settings` option only. |
| **Full Save** | `saveAll()` | Calls `dataService.saveData(fullData)` → `POST /data`. Full dataset write. Clears all client caches. |

### Backups & Restore

| Button | Handler | What happens |
|--------|---------|-------------|
| **List Backups** | `loadBackups()` | `GET /data/backups` → displays up to 20 snapshots |
| **Restore** | `restoreBackup(index)` | `POST /data/restore` with backup index. Server writes snapshot to all storage options. |
| **Export** | `exportData()` | `GET /data/export-full` → triggers browser download of full JSON |

### Bulk XML Import

| Button | Handler | What happens |
|--------|---------|-------------|
| **Import XML** | `importXml()` | Opens file picker, parses XML client-side via `XmlImportService`, maps to `NewspaperData` shape, calls `saveData()` with merged result |

### Admin Lock Management

| Button | Handler | What happens |
|--------|---------|-------------|
| **View Active Locks** | `loadActiveLocks()` | `GET /locks` → displays table of all current locks with holder name and expiry |
| **Force Release Lock** | `forceReleaseLock(resource)` | `DELETE /locks/{resource}?force=1` (admin only) |

### Activity Log

| Control | Handler | What happens |
|---------|---------|-------------|
| **Filter / Search** | `filterActivityLog()` | Calls `GET /activity-log` with query params for action type, user, date range |
| **Sort columns** | `sortActivityLog(col)` | Re-fetches with updated sort params |
| **Pagination** | `activityLogPage++/--` | Re-fetches next/prev page |

---

## 10. Data Flow: Load Sequence

### Viewer Bootstrap

```
ngOnInit()
  │
  ├─► loadNewspaperData()
  │     │
  │     └─► NewspaperDataService.loadData()
  │           │
  │           ├─ [Granular path — primary]
  │           │   forkJoin([
  │           │     GET /data/settings,
  │           │     GET /data/dates,
  │           │     GET /data/version
  │           │   ])
  │           │   → loads editions for latestDate + today
  │           │   → GET /data/editions/{date}  (one per date needed)
  │           │
  │           └─ [Legacy fallback]
  │               GET /data?_t={timestamp}
  │               (monolith blob, one request)
  │
  ├─► populateAvailableDates(dates)
  │
  ├─► loadCurrentEdition(today)
  │     │
  │     └─► EditionCacheService.getEditionsForDate(date)
  │           ├─ L1: memory hit? → return immediately
  │           ├─ L2a: localStorage hit? → return + seed memory
  │           ├─ L2b: IndexedDB hit? → return + write-back to LS
  │           └─ L3: GET /data/editions/{date}
  │
  └─► renderCurrentEdition()
        │
        ├─► sorts pages by page number
        ├─► queues sequential thumbnail loads
        └─► selectPage(firstPage)
```

### Version Poll (viewer: every 5 min, admin: every 30 s)

```
interval(300_000 or 30_000)
  │
  └─► GET /data/version
        │
        ├─ server version > local version?
        │     └─► emits remoteDataChanged signal
        │           │
        │           └─► reloadCurrentDateOnly(date)
        │                 │
        │                 ├─ evictEditionCache(date) [HTTP + EditionCacheService]
        │                 └─ re-fetches editions for date
        │
        └─ versions match → no action
```

---

## 11. Data Flow: Save Sequence

### Atomic Section Save

```
Admin edits section content, clicks "Save Section"
  │
  ├─► LockService: lock must be held for {date}:{edition}:{pageId}
  │
  └─► NewspaperDataService.saveSectionAtomically(pageId, section, originalId, date, edition)
        │
        ├─► evictEditionCache(date) [pre-save: prevents stale reads mid-save]
        │
        ├─► PUT /data/section
        │   Body: { date, edition, pageId, section, originalSectionId }
        │   Headers: Authorization + X-Authorization
        │   │
        │   └─ Server (put_section_endpoint):
        │        ├─ validate inputs (date format, pageId, section payload)
        │        ├─ check lock ownership
        │        ├─ get_data_scoped_to_date(date) → reads dn_edition_{date} ONLY
        │        ├─ find page by pageId, find section by id (or originalSectionId)
        │        ├─ upsert section in array
        │        ├─ save_data($data, ..., only_date=$date)
        │        │   → update_option('dn_edition_' . $date, $editions)
        │        │   → update_option('dn_data_index', bumped version)
        │        │   → throttled snapshot (1 per 5 min max)
        │        │   → does NOT write dn_data legacy blob
        │        ├─ upsert_section_post() → single dn_section WP post
        │        ├─ log_auth_user_action('section_save', ...)
        │        └─ return { success: true, newDataVersion: float }
        │
        ├─► evictEditionCache(date) [post-save: forces fresh read on next load]
        │
        └─► show success toast
```

### Full Save

```
Admin clicks "Save All" (or full save trigger)
  │
  └─► NewspaperDataService.saveData(fullData)
        │
        ├─► clearHttpCache() [HTTP interceptor cache wiped]
        ├─► EditionCacheService.clearMemory() [memory + IDB cleared]
        │
        ├─► POST /data
        │   Body: { editions[], settings, dataVersion }
        │   │
        │   └─ Server (post_data_endpoint):
        │        ├─ validate dataVersion (optimistic concurrency check)
        │        ├─ for each date in editions:
        │        │   update_option('dn_edition_' . date, editions_for_date)
        │        ├─ update_option('dn_settings', settings)
        │        ├─ update_option('dn_data_index', { dates, dataVersion })
        │        ├─ update_option('dn_data', full_blob) [legacy compat]
        │        ├─ sync_section_posts() [O(N) full dn_section post sync]
        │        ├─ take_backup_snapshot() [pushes to dn_data_backups rotation]
        │        └─ return { success: true, newDataVersion }
        │
        └─► show success toast / handle error
```

---

## 12. Locking System

Prevents concurrent edits of the same page by different admin users.

### Lock Resource Format

`{date}:{edition}:{pageId}` e.g. `2026-06-13:1:3`

### Workflow

1. Admin opens a page for editing → `LockService.acquireLock(resource)` → `POST /locks/{resource}`
2. Server stores lock in WP transient `dn_lock_{resource}` with TTL = 90 s
3. If lock is held by another user → 423 response → Angular shows "X is currently editing this page" banner. `isPageLockedByOther = true`, `lockHeldByName` shown in UI
4. Client sends heartbeat every 30 s → `POST /locks/{resource}/heartbeat` → renews TTL
5. On save, cancel, or navigate away → `LockService.releaseLock(resource)` → `DELETE /locks/{resource}`
6. Admin can force-release any lock via `DELETE /locks/{resource}?force=1`

### Server Enforcement

Every atomic write endpoint (`PUT /data/page`, `DELETE /data/page`, `PUT /data/section`, `DELETE /data/section`) calls `lock_belongs_to_current_user(resource)` and returns 423 if the caller is not the lock holder.

---

## 13. Activity Log

All admin actions are logged to the `{prefix}dn_activity_log` custom DB table.

### Logged Events

| Action | Trigger |
|--------|---------|
| `login` | Successful login |
| `login_blocked` | Rate-limited login attempt |
| `page_save` | `PUT /data/page` |
| `page_delete` | `DELETE /data/page` |
| `section_save` | `PUT /data/section` |
| `section_delete` | `DELETE /data/section` |
| `settings_save` | `PATCH /data/settings` |
| `full_save` | `POST /data` |
| `restore` | `POST /data/restore` |

Each entry: `{action, message, context (JSON), user_id, user_name, user_role, ip_address, created_at}`.

Admin component fetches log via `GET /activity-log` with pagination, filtering (by action type, user, date range), and sort controls.

---

## 14. Image Proxy & Media Upload

### Image Proxy (`GET /proxy?url=...`)

Needed because the Canvas API cannot `drawImage()` cross-origin images (CORS taint). Flow:

1. `NewspaperComponent.cropSectionImage()` detects image is cross-origin
2. Calls `/proxy?url={encodedUrl}` to fetch image server-side
3. Server `proxy_image()`:
   - Normalizes URL (handles `//` protocol-relative, relative paths)
   - **Fast path:** tries to resolve URL to local uploads directory path and serves directly via `file_get_contents()` — avoids HTTP round-trip for local images
   - **Remote path:** validates host against `$allowed_hosts` (site domain + www variant)
   - Fetches via `wp_remote_get()` (timeout: 20 s, 5 redirects)
   - Returns image bytes with `Content-Type` from response
   - SVG responses get `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`

### Media Upload (`POST /media`)

1. Admin selects image file (file input mode in section editor)
2. Angular sends multipart `POST /media` with auth headers
3. Server calls `wp_handle_upload()` + `wp_insert_attachment()` — image stored in WP Media Library under `/wp-content/uploads/`
4. Returns `{id, url, filename}`
5. URL stored on section as `imageUrl`

### Media Delete (`DELETE /media/{id}`)

Calls `wp_delete_attachment(id, true)` — removes file from disk and DB.

---

## 15. PWA & Version Polling

### Service Worker Updates (AppComponent)

On SW update detected: shows update notification bar. User clicks "Reload" → `window.location.reload()` loads new SW-controlled assets.

### Version Polling

Two polling intervals run in parallel:

| Context | Interval | Endpoint | Action on change |
|---------|----------|----------|-----------------|
| Viewer | 300 000 ms (5 min) | `GET /data/version` | `reloadCurrentDateOnly(date)` — evicts cache + re-fetches this date's editions |
| Admin | 30 000 ms (30 s) | `GET /data/version` | Emits `remoteDataChanged` — admin can choose to reload or continue editing |

`/data/version` returns only `{dataVersion, updatedAt}` — extremely lightweight, never triggers full data load unless version differs.

---

## 16. Security & Hosting Compatibility

### WAF / ModSecurity Bypass

Plugin injects `.htaccess` rules to pass `Authorization` headers through to PHP and to whitelist the Angular app's endpoints from WAF inspection. `X-Authorization` header duplicates the Bearer token for hosts that strip standard `Authorization`.

### CORS

Plugin sets `Access-Control-Allow-Origin` for each request based on `dn_allowed_origins` option. Preflight `OPTIONS` requests get the appropriate CORS headers.

### Rate Limiting

- Login: 5 failed attempts / 10 min per IP (WP transient)
- Public read endpoints: request rate limiting via `check_public_get_rate_limit()`

### Optimistic Concurrency

`POST /data` accepts `dataVersion` float. Server compares with current `dn_data_index.dataVersion`. If client version is stale, server rejects with conflict error to prevent data loss from concurrent editors saving simultaneously.

### Fatal Error Handling

Every write endpoint wraps logic in `try/catch(\Throwable)` and registers a `register_shutdown_function` handler. PHP fatals (OOM, max execution) return structured JSON `{error, message, file, line, peakMem}` instead of WordPress's HTML error page — Angular can surface these as readable error messages.

### Memory Optimization

Atomic endpoints (`PUT /data/page`, `PUT /data/section`, etc.) call `get_data_scoped_to_date()` which reads only the target date's `dn_edition_*` option. The full `dn_data` blob (30–50 MB serialized) is never loaded. Both limits are bumped at the start of any endpoint that may need to handle a larger dataset: `@ini_set('memory_limit', '512M')`, `@set_time_limit(120)`.
