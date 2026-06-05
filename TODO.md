# Digital Newspaper — Implementation To-Do List

> **Status:** Planning only. No implementation started.  
> **Scope:** Four requirements reviewed against full codebase (Angular app + WordPress plugin).

---

## ROOT-CAUSE ANALYSIS (read before implementing)

### Issue 1 — Post count discrepancy (10 added, only 6 visible)

**Primary cause: last-write-wins race condition on a single-blob store.**

The entire newspaper dataset is one JSON blob in `wp_options` (`dn_data`). PHP's `save_data()` calls `update_option()` unconditionally, replacing everything. Angular's `autoSaveForVintage()` is triggered silently after almost every UI action (add page, delete section, create edition, etc.), so if User B opened the admin **before** User A finished adding posts 7–10, User B's in-memory state is still at 6. When User B performs any save (even an innocent label edit), their stale 6-post blob overwrites User A's 10-post blob.

**Secondary causes:**
- No server-side version/timestamp guard on `POST /data` — the API accepts any payload without knowing if it is newer than the stored data.
- `autoSaveForVintage()` is a silent background save with no concurrency awareness.
- No client-side re-fetch before save to merge remote changes.

**Fix strategy:**
1. Add a `dataVersion` (unix timestamp or UUID) to the stored blob.
2. PHP endpoint rejects saves where the incoming `dataVersion` is older than stored (409 Conflict).
3. Angular re-fetches on conflict and prompts the user.
4. The page-locking feature (Issue 3) is the architectural fix that makes this safe.

---

## FEATURE 1 — Fix Post Count Discrepancy

### PHP Plugin changes (`digital-newspaper.php`)

- [ ] **1.1 Add `dataVersion` field to the stored blob.**  
  In `save_data()`, set `$data['dataVersion'] = microtime(true)` before `update_option()`.  
  In `get_data()`, include `dataVersion` in the returned array.

- [ ] **1.2 Add optimistic-concurrency guard to `post_data_endpoint()`.**  
  If the stored blob has a `dataVersion` and the incoming payload's `dataVersion` does not match (i.e., the client is working from a stale copy), return HTTP 409:
  ```json
  { "error": "conflict", "currentVersion": <server_version>, "message": "Data was modified by another user." }
  ```
  Add a `?force=1` bypass for the admin restore flow only.

- [ ] **1.3 Expand the existing 20-backup snapshot to capture the conflicting user's info.**  
  Store `editedBy` (user display name) alongside `createdAt` in `snapshot_current_data_before_save()` so admins can audit who overwrote what.

### Angular app changes

- [ ] **1.4 Store `dataVersion` from each `loadData()` response** in `NewspaperDataService` and include it in every `saveData()` payload.

- [ ] **1.5 Handle 409 Conflict in `persistAllData()`.**  
  Show a clear modal: "Another user saved while you were editing. Your changes and the server's version are shown side-by-side. Choose which to keep or discard." At minimum, offer: "Reload server data (discard my changes)" or "Force-save my version anyway."

- [ ] **1.6 Remove or gate `autoSaveForVintage()`.**  
  This method silently saves the entire in-memory state after every UI action. With multi-user editing, it is the primary data-loss vector. Options:
  - Remove it entirely (manual save only, consistent with how the non-vintage theme works).
  - Or: only call it when the user is the current lock holder (see Feature 3).

- [ ] **1.7 Re-fetch before save when `dataVersion` is absent from memory.**  
  If the service's in-memory `dataVersion` is undefined (app was open for a long time), call `loadData()` before saving and merge changes.

---

## FEATURE 2 — Freeze Admin UI During Backend Operations

**Current state:** `LoaderService` exists (counter-based, correct design), `LoaderComponent` renders the overlay, and some paths call `loader.show()/hide()`. However, the HTTP interceptor does not auto-trigger the loader, and several save paths (`persistAllData`, `persistRecoveredData`, the import flow, server backup restore) never call `loader.show()`.

### Angular app changes

- [ ] **2.1 Create a `LoaderHttpInterceptor` (new file: `src/app/interceptors/loader.interceptor.ts`).**  
  Intercept every outgoing HTTP request to `WP_BASE_URL`, call `loader.show()` before the request and `loader.hide()` in the `finalize()` operator. Register it in `app.config.ts` after `wpApiInterceptor`. This one change fixes all missed loader calls automatically.

- [ ] **2.2 Visually block ALL user interaction while loading — not just show a spinner.**  
  The current `LoaderComponent` may already do this; verify that:
  - The overlay `z-index` is above all modals and the section editor.
  - Pointer events are disabled on the entire admin while `isLoading$ | async` is `true`.
  - Keyboard shortcuts (save, delete, etc.) are ignored while loading.

- [ ] **2.3 Add a meaningful status message to the loader overlay.**  
  `LoaderService` should accept an optional message string: `loader.show('Saving data…')` / `loader.show('Uploading image…')`. The overlay renders the message so users know what is happening, not just that something is happening.

- [ ] **2.4 Add a timeout warning.**  
  If `isLoading$` stays `true` for more than 30 seconds, surface a non-blocking warning toast: "This is taking longer than expected. The server may be slow — please wait or check your connection." Do not auto-cancel the request.

- [ ] **2.5 Audit all call sites and add explicit messages.**  
  Key places to audit:
  - `persistAllData()` → "Saving newspaper data…"
  - `persistRecoveredData()` → "Saving recovered data…"
  - `uploadMediaFile()` / `uploadCroppedImage()` → "Uploading image…"
  - `generateAndUploadCroppedImageFromFullSize()` → "Generating crop…"
  - `importBackup()` → "Importing backup…" (after FileReader reads the file)
  - `onBulkXmlImportCompleted()` reload → "Reloading data…"
  - Server backup restore → "Restoring backup…"

---

## FEATURE 3 — Page/Post Locking (One Editor at a Time)

This is the architectural fix that prevents the race condition in Feature 1 and satisfies the UX requirement.

### PHP Plugin additions

- [ ] **3.1 Register new REST routes** in `register_routes()`:
  ```
  POST   /digital-newspaper/v1/locks/{resourceType}/{resourceId}   → acquire_lock
  DELETE /digital-newspaper/v1/locks/{resourceType}/{resourceId}   → release_lock
  GET    /digital-newspaper/v1/locks                               → list_locks
  POST   /digital-newspaper/v1/locks/{resourceType}/{resourceId}/heartbeat → heartbeat_lock
  ```
  All require `auth_required`. Parameter `{resourceType}` can be `page` or `edition`; `{resourceId}` is `{date}:{editionNumber}:{pageId}` or `{date}:{editionNumber}`.

- [ ] **3.2 Implement lock storage using WordPress transients.**  
  Lock key pattern: `dn_lock_{resourceType}_{resourceId}` (sanitize slashes/colons to underscores). Lock value:
  ```json
  { "userId": 5, "displayName": "Sazzad", "lockedAt": 1717600000, "expiresAt": 1717600060 }
  ```
  TTL = 90 seconds (renewed by heartbeat every 30 seconds). Transients are auto-cleaned by WordPress on expiry.

- [ ] **3.3 `acquire_lock` endpoint logic:**
  - Read existing transient. If it exists and belongs to a different user and `expiresAt` is in the future → return 423 (Locked) with the lock holder's display name and `lockedAt`.
  - If it exists and belongs to the **same** user → refresh TTL (re-acquire).
  - If absent or expired → set transient, return 200 with the lock data.

- [ ] **3.4 `release_lock` endpoint logic:**
  - Only the lock holder can release their own lock. Validate `userId` matches the authenticated user. Delete the transient.

- [ ] **3.5 `heartbeat_lock` endpoint logic:**
  - Refresh the transient TTL if the caller is the current lock holder. Returns 200 or 404 if the lock no longer exists (e.g., was stolen by an admin force-release).

- [ ] **3.6 `list_locks` endpoint:**
  - Admin-only. Returns all active locks by scanning WordPress transients with prefix `dn_lock_` using `get_option()` on the options table (or use a custom `dn_active_locks` option that tracks active lock keys). Used by the admin lock-management UI.

- [ ] **3.7 Admin force-release lock** — add `DELETE /locks/{type}/{id}?force=1` for `admin_required`. Logs the forced release in the activity log (Feature 4).

### Angular app additions

- [ ] **3.8 Create `LockService` (`src/app/services/lock.service.ts`).**  
  Responsibilities:
  - `acquireLock(type, id): Observable<LockResult>` — calls the acquire endpoint.
  - `releaseLock(type, id): Observable<void>` — calls the release endpoint.
  - `startHeartbeat(type, id)` — starts a `setInterval` every 30 seconds calling the heartbeat endpoint.
  - `stopHeartbeat()` — clears the interval.
  - `pollForLocks(type, id): Observable<LockInfo | null>` — polls `list_locks` every 10 seconds to show the "User X is editing" banner to read-only users.
  - On window `beforeunload`, call `releaseLock()` synchronously via `navigator.sendBeacon`.

- [ ] **3.9 Integrate `LockService` into `AdminComponent`.**  
  - When a user opens a page for editing (`selectPage()`, `editPage()`, `newSection()`, `editSection()`), call `acquireLock('page', lockId)`.
  - On cancel/save/navigate away, call `releaseLock()`.
  - While editing, run the heartbeat.
  - If `acquireLock()` returns 423, show a blocking warning: "**[User Name] is currently editing this page.** You can view sections but cannot make changes." Disable all edit/delete/save buttons for that page.

- [ ] **3.10 Read-only mode enforcement.**  
  Create `isEditingLocked: boolean` component state. When `true`:
  - All "Edit", "Delete", "Save", "New Section", "New Page" buttons are `[disabled]="isEditingLocked"`.
  - The save-all button shows "Locked — [User] is editing" tooltip.
  - The image cropper cannot be opened.

- [ ] **3.11 Show "who is editing" banner on read-only pages.**  
  Above the sections list for a locked page, display:
  ```
  🔒 Sazzad is currently editing this page. (Locked since 2 min ago)
  ```
  Refresh this status every 10 seconds via the poll. If the lock expires naturally (heartbeat stopped), the banner disappears and full editing resumes automatically.

- [ ] **3.12 Admin lock management panel (admin-only tab).**  
  Show a list of all active locks: resource, lock holder, time locked, with a "Force Release" button per lock.

- [ ] **3.13 Handle lock expiry during editing.**  
  If the `heartbeat_lock` call returns 404 (lock was force-released by admin), show a toast: "Your editing lock was released by an administrator. Save your work immediately." Stop the heartbeat and set `isEditingLocked = true` until the user re-acquires.

---

## FEATURE 4 — Activity Log (Admin-Only)

### PHP Plugin additions

- [ ] **4.1 Create activity log storage.**  
  Use a WordPress option `dn_activity_log` (array, max 500 entries, newest-first, older entries pruned on write). Each entry:
  ```json
  {
    "id":          "uuid-or-microtime",
    "timestamp":   "2026-06-05T10:30:00Z",
    "userId":      5,
    "displayName": "Sazzad",
    "role":        "administrator",
    "action":      "save_data",
    "details":     { "editionCount": 3, "pageCount": 10, "sectionCount": 47 },
    "ip":          "192.168.1.1",
    "userAgent":   "Mozilla/5.0 ..."
  }
  ```
  Keep IP and user-agent for security auditing. Prune to 500 entries (configurable constant) on each write.

- [ ] **4.2 Create a private `log_activity(string $action, array $details = [])` method in the plugin class.**  
  Reads stored user from the JWT-authenticated request context (`wp_get_current_user()`), appends a new log entry, and writes back.

- [ ] **4.3 Call `log_activity()` in all write endpoints:**
  - `post_data_endpoint()` → `"save_data"` with page/section counts and `dataVersion`.
  - `restore_data_backup_endpoint()` → `"restore_backup"` with backup index and `createdAt`.
  - `rebuild_data_from_sections_endpoint()` → `"rebuild_from_sections"`.
  - `upload_media()` → `"upload_media"` with filename.
  - `delete_media_item()` → `"delete_media"` with media ID.
  - `login()` (on success) → `"login"`.
  - Lock acquire → `"lock_acquired"` with resource ID.
  - Lock force-release → `"lock_force_released"` with resource ID and target user.
  - Log **failed** save attempts (data version conflict, WAF block) as `"save_failed"` with reason.

- [ ] **4.4 Register log REST routes:**
  ```
  GET  /digital-newspaper/v1/activity-log            → list_activity_log (admin only)
  DELETE /digital-newspaper/v1/activity-log          → clear_activity_log (admin only)
  ```

- [ ] **4.5 `list_activity_log` endpoint:**
  - `admin_required` permission.
  - Supports `?page=1&per_page=50&action=save_data&userId=5&from=2026-06-01&to=2026-06-05` query params for filtering.
  - Returns paginated results with total count.

### Angular app additions

- [ ] **4.6 Create `ActivityLogService` (`src/app/services/activity-log.service.ts`).**  
  - `getLogs(filters): Observable<ActivityLogEntry[]>` — calls `list_activity_log`.
  - `clearLogs(): Observable<void>` — calls `clear_activity_log`.
  - Also log client-side actions that don't necessarily reach the server (e.g., export/download, import preview viewed, login failed). These can be sent as a fire-and-forget POST to a lightweight `POST /activity-log/client` endpoint or folded into existing calls.

- [ ] **4.7 Add "Activity Log" tab/section to the admin panel (admin-only, hidden from non-admins).**  
  Display:
  - Filterable table: Date/Time, User, Action, Details.
  - Colour-code by action type: saves (green), deletes (red), logins (blue), errors/failures (orange).
  - Pagination (50 entries per page).
  - Date-range filter + user filter + action type filter.
  - "Export as CSV" button (client-side, no server call needed).
  - "Clear log" button (confirmation required, admin only).

- [ ] **4.8 Log client-side events:**  
  Call `log_activity()` or the client endpoint for:
  - Successful login / logout.
  - Export downloaded (action + filename).
  - Import applied (action + file name + edition count imported).
  - Bulk XML import completed.

---

## CROSS-CUTTING SECURITY & PERFORMANCE NOTES

- [ ] **S1 — Sanitize `resourceId` in lock endpoints.**  
  The lock key is built from user-supplied `date`, `editionNumber`, `pageId`. Use regex validation (`/^\d{4}-\d{2}-\d{2}:\d+:\d+$/`) before building the transient key to prevent key injection.

- [ ] **S2 — Rate-limit the lock and log endpoints.**  
  Add a simple counter transient per IP (`dn_ratelimit_{ip}`, TTL 60 s, max 120 requests/min). Return 429 if exceeded. Prevents log flooding or lock-polling DoS.

- [ ] **S3 — Ensure `log_activity()` never throws.**  
  Wrap in `try/catch`; a log write failure must never break the main endpoint response.

- [ ] **S4 — IP anonymization option for GDPR compliance.**  
  Store only the first 3 octets of IPv4 (e.g., `192.168.1.*`) or the /48 prefix of IPv6. Add a constant `DN_LOG_ANONYMIZE_IP = true` that can be toggled by the site admin.

- [ ] **S5 — Validate `dataVersion` is a numeric timestamp.**  
  The conflict guard in `post_data_endpoint()` must reject non-numeric or negative `dataVersion` values to prevent bypass via type confusion.

- [ ] **P1 — The loader interceptor must skip `GET /data` (the public read endpoint).**  
  Loading the page data on app boot should not show the admin overlay; only authenticated write operations should freeze the UI.

- [ ] **P2 — Lock polling should use exponential back-off on repeated 404/5xx errors.**  
  If `list_locks` returns three consecutive errors, increase the poll interval to 60 s to avoid hammering a struggling server.

- [ ] **P3 — Activity log writes are synchronous inside `post_data_endpoint()`.**  
  If logging causes latency, move it to a `shutdown` action (`add_action('shutdown', ...)`) so it runs after the HTTP response is sent.

---

## IMPLEMENTATION ORDER (recommended)

1. **Feature 2** (loader freeze) — lowest risk, self-contained, immediate UX improvement.
2. **Feature 1** (`dataVersion` + conflict detection) — fixes the data-loss bug.
3. **Feature 3** (locking) — depends on Feature 1 being in place first; the lock is only meaningful if saves also respect the version guard.
4. **Feature 4** (activity log) — builds on the infrastructure from the others; lowest urgency.
