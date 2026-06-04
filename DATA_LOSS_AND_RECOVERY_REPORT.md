# Data Loss And Recovery Report

Date: 2026-06-02

## Purpose

This document explains the Digital Newspaper production data incident: why newspaper data disappeared from the Angular admin/frontend, why the missing article/section data could not be fully recovered from WordPress Media Library, what weaknesses existed in the previous implementation, and what has now been implemented to protect the data and improve recovery.

## Executive Summary

The Angular app depends on WordPress as the live backend. The actual newspaper structure was stored mainly in one WordPress option: `dn_data`. That option contained editions, dates, pages, section coordinates, titles, article bodies, image links, and settings.

During the incident, WordPress Media Library still had uploaded page and crop images, but the canonical `dn_data` option had been overwritten or reset to an empty dataset. Because Media Library files do not store the complete newspaper structure, the system could only recover page images, not the missing article/section metadata.

The incident exposed several important weaknesses:

- `dn_data` was a single fragile source of truth.
- There was no server-side backup history before overwrite.
- Empty or destructive saves were not blocked.
- The frontend could silently fall back to stale bundled JSON.
- Media Library upload files were treated as recoverable assets, but they were not a full database backup.
- There was no durable per-section mirror outside the `dn_data` option.

The implementation has now been improved with server-side backups, destructive-save protection, Media Library page fallback, cache/timeout fixes, deterministic filenames, private WordPress section mirror posts, and a rebuild mechanism from mirrored section posts.

## What Data Was Lost

The lost data was not primarily the uploaded images. The uploaded images were still present in WordPress Media Library.

The lost data was the structured newspaper metadata previously stored in `dn_data`, including:

- edition dates
- edition numbers and labels
- page ordering and labels
- page-to-section relationships
- section IDs
- section titles
- section content/body text
- section crop coordinates
- section cropped image URLs
- linked section relationships
- other admin-edited newspaper metadata

Without that structured JSON, the app cannot know which article belonged to which page, where the crop box was located, what title/body was entered, or how sections were linked.

## Why The Data Was Lost

The most likely root cause was that the WordPress option `dn_data` was overwritten, reset, or saved with an empty/invalid newspaper structure.

Before the fixes, the app and plugin allowed the main data object to be replaced without enough server-side safeguards. If a bad client state, fallback state, failed load, import mistake, or empty save reached the save endpoint, the backend could accept it as the new canonical data.

There were also cache and timeout behaviors that made the problem harder to see:

- The Angular service could time out too quickly when WordPress was slow.
- After timeout, the frontend could fall back to bundled static JSON.
- Stale cached API responses could make the app appear to have old data even when live WordPress data had changed.
- CORS/preflight issues made debugging confusing because the browser could fail requests before the actual API response was visible.

These behaviors did not create the missing metadata by themselves, but they increased the risk of stale or incomplete data being displayed or saved.

## Why We Could Not Fully Recover The Data

WordPress Media Library stores files and attachment metadata. It does not store the full Digital Newspaper article model.

From Media Library, we can infer some page images from filenames and upload records. However, Media Library cannot reliably restore:

- article titles
- article body text
- crop coordinates
- section order
- page/section mapping in all cases
- edition labels
- linked article relationships
- original admin intent

For example, an uploaded page image can show the newspaper page visually, but it does not contain structured JSON saying: "this rectangle is section X, its title is Y, its body is Z, and it belongs to edition A page B".

Because no previous durable backup or per-section mirror existed at the time of the incident, the lost section/content data could only be recovered from one of these sources:

- an old valid `dn_data` export
- a database backup containing the old `dn_data` option
- a hosting backup from before the overwrite/reset
- browser/local backup files if any were manually exported

Without one of those, the uploaded media files alone are insufficient for complete restoration.

## Previous Code And Architecture Gaps

### Single Fragile Canonical Store

The previous architecture treated `dn_data` as the only authoritative database for all newspaper structure. A single overwrite could remove all editions/pages/sections.

### No Server-Side Backup Before Save

The backend did not keep automatic previous versions before accepting a save. If valid data was overwritten, there was no built-in rollback list.

### No Destructive Save Guard

The backend did not reject a request that attempted to replace an existing populated dataset with an empty page dataset.

### Unsafe Fallback Risk

The Angular app could fall back to static bundled data when the live API timed out or failed. This could hide the real backend state and create confusion about whether data was live or stale.

### Incomplete Recovery Source

Media Library fallback was not available before, and even with it, media can only recover page visibility. It cannot recover full article data.

### No Independent Section Records

Individual sections/articles were not mirrored as WordPress records. That meant WordPress did not have a second structured representation of each section outside the `dn_data` option.

### Save UI Was Always Available

The Save All button was previously active even when there were no local changes. That increased the chance of unnecessary or accidental saves.

## What We Implemented To Keep Data Safe

### 1. Server-Side Data Backups

The WordPress plugin now stores automatic snapshots in `dn_data_backups` before saves/restores.

Implemented behavior:

- before updating `dn_data`, the current valid data is copied into backup history
- backup history is capped to the latest 20 entries
- admin can list available backups
- admin can restore a backup
- restore also syncs section mirror posts

Relevant backend concepts:

- `OPTION_BACKUPS = 'dn_data_backups'`
- backup list endpoint: `/wp-json/digital-newspaper/v1/data/backups`
- restore endpoint: `/wp-json/digital-newspaper/v1/data/restore`

### 2. Destructive Empty-Save Protection

The WordPress save endpoint now compares current page count and incoming page count.

If current data has pages and the incoming payload has zero pages, the server rejects the save with HTTP `409` unless the request explicitly uses `force=1`.

This protects production from accidental empty overwrites.

### 3. Explicit Recovered-Data Save Protection

The Angular service tracks when data was recovered only from Media Library.

By default, saving media-only recovered data is blocked because it does not include sections/content. Admin must explicitly confirm recovered-data saving.

This prevents a page-only recovery state from accidentally replacing a richer valid dataset.

### 4. Live API Cache And Timeout Fixes

The Angular service now:

- uses a cache-buster query parameter for live data requests
- waits longer for WordPress cold starts
- retries transient failures before fallback
- avoids custom no-cache request headers that cause CORS preflight problems

The WordPress data endpoint now sends no-cache/no-store headers to prevent CDN/browser/LiteSpeed stale responses.

This reduces false fallback and stale-data display.

### 5. Empty Bundled Fallback Instead Of Stale News

The local fallback asset is no longer treated as a current source of news. If live WordPress is unreachable, the UI should not present old bundled news as if it were live production data.

This makes failures visible instead of misleading.

### 6. Media Library Page Recovery

If live `dn_data` has no pages but WordPress Media Library contains page images, Angular can recover a page-only view from media.

Important limitation: this is a visibility fallback, not a full data recovery.

It helps show page images but cannot restore article sections/content.

### 7. Deterministic Filenames

Uploaded page and cropped post images now use predictable filenames that include date/page/edition/post context.

This improves:

- traceability
- manual audit
- media cleanup
- future recovery heuristics

Example page image style:

```text
page-01-e-01-01-06-2026.jpg
```

Example cropped post image style:

```text
page-01-e-01-01-06-2026-post-01-50.1724-30.8662-16.4655-21.2171.jpg
```

### 8. Crop URL Regeneration And Old Crop Cleanup

When crop coordinates change, the cropped image is regenerated and the section URL is updated. Old generated cropped media is deleted after replacement.

This keeps section data and crop image files aligned.

### 9. Private WordPress Section Mirror Posts

The plugin now registers a private custom post type: `dn_section`.

Each newspaper section/post is mirrored into WordPress as its own structured record. These records are private and not publicly queryable.

This creates a second durable source of structured section data outside the single `dn_data` option.

The mirror stores section-related metadata such as:

- newspaper date
- edition number
- page ID
- page labels
- page image URLs
- section ID
- section title/content
- coordinates
- section image URL
- ordering/linking metadata

### 10. Rebuild From Section Posts

A new authenticated endpoint can rebuild `dn_data` from mirrored `dn_section` posts.

Endpoint:

```text
/wp-json/digital-newspaper/v1/data/rebuild-from-sections
```

Admin UI now includes a "Rebuild From Posts" action.

If `dn_data` is damaged in the future but `dn_section` mirror posts exist, the system can reconstruct editions, pages, and sections from those posts.

### 11. Safer Save All Button

The Save All button is now disabled unless the admin has actual unsaved changes.

After successful save/load/import/rebuild, the button returns to a clean `Saved` state.

This reduces accidental writes to production.

## New Recovery Criteria

The recovery strategy now has multiple levels. Which recovery path is possible depends on what data remains available.

### Recovery Level 1: Normal Restore From Server Backup

Use this when `dn_data` was recently overwritten but `dn_data_backups` still contains a valid previous snapshot.

Criteria:

- WordPress plugin with backup support is deployed
- the damaging save happened after backup support was deployed
- a valid backup exists in `dn_data_backups`

Expected result:

- full recovery of editions, pages, sections, article content, coordinates, and settings from the selected backup

### Recovery Level 2: Rebuild From Mirrored Section Posts

Use this when `dn_data` is missing/corrupt but private `dn_section` posts exist.

Criteria:

- WordPress plugin with `dn_section` mirror support was deployed before the data loss
- valid newspaper data was saved at least once after mirror support was deployed
- mirrored section posts were not deleted/truncated

Expected result:

- rebuild `dn_data` from private section records
- restore pages and sections represented by mirrored posts

Limitations:

- only sections that were previously mirrored can be rebuilt
- if the mirror was never populated before the incident, it cannot recover older lost data

### Recovery Level 3: Media Library Page Recovery

Use this when `dn_data` has no pages but WordPress Media Library still has uploaded page images.

Criteria:

- Media Library contains identifiable newspaper page images
- filenames or metadata are sufficient to infer date/page context

Expected result:

- page images can be shown again in a limited page-only state

Limitations:

- cannot restore article titles
- cannot restore body content
- cannot restore section coordinates reliably
- cannot restore section/page relationships completely

### Recovery Level 4: External Hosting Or Database Backup

Use this when internal app backups and section mirrors are unavailable.

Criteria:

- hosting provider has a database backup from before the incident
- database backup includes the WordPress options table with valid `dn_data`

Expected result:

- full recovery is possible if the old `dn_data` option is intact

### Recovery Level 5: Manual Reconstruction

Use this only when no structured backup exists.

Criteria:

- page images are available
- admins manually recreate sections and content from source material

Expected result:

- partial or full reconstruction depending on manual effort

Limitations:

- slow
- human-error prone
- not guaranteed to match the original data exactly

## Important Limitations After The Fix

The new recovery mechanisms protect future saves. They cannot magically recover section metadata that was already lost before backups or mirrored section posts existed.

Specifically:

- `dn_data_backups` only contains snapshots created after the backup feature was deployed.
- `dn_section` posts only exist for data saved after the mirror feature was deployed.
- Media Library recovery remains page-image-only.
- Full recovery of old missing content still requires an old valid export or database backup.

## Operational Recommendations

To keep production safe:

1. Deploy the updated WordPress plugin before relying on backup/rebuild features.
2. After deployment, save one known-good dataset so `dn_data_backups` and `dn_section` mirrors are populated.
3. Export a manual backup after major admin changes.
4. Keep hosting/database backups enabled.
5. Do not force-save empty datasets unless intentionally resetting the site.
6. Treat Media Library recovery as emergency visibility only, not a full restore.
7. Use "Rebuild From Posts" only when `dn_data` is damaged and mirrored section posts are expected to exist.
8. Verify frontend and admin after restore/rebuild before making additional saves.

## Current Safety Model

The system now uses layered protection:

```text
Admin edits
  -> Angular dirty-state Save All guard
  -> Angular recovered-data save guard
  -> WordPress destructive empty-save guard
  -> WordPress backup snapshot before save
  -> WordPress dn_data canonical snapshot
  -> WordPress private dn_section mirror records
  -> Rebuild/restore endpoints for recovery
```

This means future data loss should be much harder to trigger, easier to detect, and recoverable through at least one structured path if the updated plugin had already been running with valid data.
