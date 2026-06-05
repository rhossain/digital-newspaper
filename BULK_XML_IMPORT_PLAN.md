# Bulk XML Import ("Add Bulk E-post") — Implementation Plan

**Feature:** Bulk XML import of newspaper posts via a multi-step wizard UI  
**Entry point:** "Add Bulk E-post" in the vintage header dropdown menu  
**Date created:** 2026-06-04  
**Status:** Pre-implementation planning — do not start coding until all Phase 1 items are checked off

---

## Architecture Summary

### What already exists (do not re-implement)
- `sync_section_posts_from_data()` in the PHP plugin — fires on every `save_data()` call and upserts all sections as `dn_section` WordPress custom posts with full meta (date, edition, page, crop coords, image URLs, section payload).
- `applyImport()`, `validateImportPayload()`, `buildImportPreview()` in `NewspaperDataService` — used by JSON import, can be referenced as patterns for XML import.
- `getOrCreateEdition()`, `addSection()`, `updateSection()` in `NewspaperDataService` — XML import will call these directly.
- `saveData()` → `persistAllData()` → `dataService.saveData()` chain — already triggers WP sync after any save.
- "Add Bulk E-post" placeholder menu item in `admin.component.html` — currently `vhdr-menu-item--soon`, needs activation only.

### What is new
- XML parser service method
- Stable deterministic section ID generation for XML rows
- Duplicate detection and per-row resolution
- Multi-step wizard modal component (4 steps)
- Two-panel review/assign UI
- `wpPostId` round-trip on `NewsSection`
- `dn_page_name` scalar meta in PHP plugin
- `imageStatus: 'pending'` flag on skeleton pages

---

## Phase 1 — Requirements Finalization & Contract

### 1.1 Define XML schema and write test fixtures

**Owner:** Confirm with team before implementation  
**Deliverable:** Normative schema + sample files stored in `src/assets/test-fixtures/xml/`

Canonical XML structure:

```xml
<newspaper>
  <post>
    <title>Post Title Here</title>
    <content><![CDATA[<p>HTML body content...</p>]]></content>
    <date>2026-06-04</date>
    <edition>1</edition>
    <page>2</page>
  </post>
</newspaper>
```

Field rules:

| Field | Required | Format | Notes |
|---|---|---|---|
| `title` | Yes | Plain text, max 255 chars | Stripped of HTML |
| `content` | No | HTML in CDATA | Sanitized on parse |
| `date` | Yes | `YYYY-MM-DD` | Must be parseable as a valid date |
| `edition` | No | Integer ≥ 1 | Defaults to `1` if absent |
| `page` | Yes | Integer ≥ 1 | Maps to `NewspaperPage.id` |

Test fixture files to create:

| File | Purpose |
|---|---|
| `happy-path.xml` | 10 posts, 2 dates, 2 editions, 3 pages |
| `new-pages.xml` | Posts whose page numbers don't exist yet |
| `duplicates.xml` | 3 posts matching existing section keys |
| `intra-file-dupe.xml` | 2 rows with the same derived key within one file |
| `invalid-dates.xml` | Non-YYYY-MM-DD date values |
| `malformed.xml` | Broken XML structure |
| `empty-content.xml` | All content fields empty or missing |
| `large-import.xml` | 500+ rows for performance profiling |

---

### 1.2 Confirm page assignment strategy

**Decision required before implementation — choose one:**

- [ ] **Option A (Recommended):** If XML page number matches an existing `NewspaperPage.id` in that edition → append sections to it. If no matching page exists → create a skeleton page (`thumbnail: ''`, `fullImage: ''`, `imageStatus: 'pending'`).
- [ ] **Option B:** Require all target pages to already exist; flag unmatched page numbers as errors in the wizard.

---

### 1.3 Define duplicate detection contract

A duplicate is a row whose derived section ID matches an existing `NewsSection.id` in the current data.

**Deterministic ID derivation for XML rows:**

```
xml-{date}-e{edition}-p{page}-{slugifiedTitle}
```

Slugify rules: lowercase → trim → replace spaces with `-` → strip non-alphanumeric except `-` → truncate slug to 40 chars.

Collision within the same file: append `-2`, `-3`, etc.

**Per-row resolution actions:**

| Action | Behaviour |
|---|---|
| **Skip** | Do not import this row; keep existing section unchanged |
| **Overwrite** | Replace existing section's `title` and `content` only; preserve crop and image fields |
| **Import as New** | Generate a new unique ID with timestamp suffix; create a fresh section |

Default assignments:

- Same derived key + identical content → default **Skip**
- Same derived key + different content → default **Overwrite**
- No matching key → **New** (no decision needed)

---

### 1.4 Confirm WordPress sync scope

The following fields are **already stored** by `sync_section_posts_from_data()` on every save — no changes required for these:

| Required field | Already stored as meta key |
|---|---|
| WordPress post ID | The `dn_section` post's `ID` itself |
| Post title | `post_title` |
| Post content | `post_content` |
| Cropped image URL | `dn_cropped_image_url` |
| Image position x/y/w/h | `dn_crop_x`, `dn_crop_y`, `dn_crop_w`, `dn_crop_h` |
| Edition number | `dn_edition_number` |
| Page number/ID | `dn_page_id` |
| Page date | `dn_newspaper_date` |
| Page thumbnail URL | `dn_page_thumbnail` |
| Page full image URL | `dn_page_full_image` |

**Confirmed gaps (new work required):**

- `dn_page_name` — plain text scalar for page title (currently only stored as JSON blob `dn_page_labels`) → see Todo 6.1
- `wpPostId` round-trip on `NewsSection` — WP post ID not currently returned to Angular → see Todo 3.1

---

### 1.5 Decide draft vs. immediate-publish policy for XML import

**Decision required:**

- [ ] **Option A (Recommended):** Import fires `saveData()` immediately after mutations. WP sync runs at save time. Sections with no crop coords appear in admin but have `x=y=w=h=0` and are hidden from the public viewer until a crop is applied.
- [ ] **Option B:** Hold import result in memory; require the user to manually save after reviewing.

---

## Phase 2 — Data Model Changes

### 2.1 Add `wpPostId` to `NewsSection` interface

**File:** `src/app/services/newspaper-data.service.ts`

Add optional field to `NewsSection`:
```typescript
wpPostId?: number;
```

The PHP plugin's `upsert_section_post()` response must include the WP post ID. The `saveData()` response and `loadData()` normalizer must preserve this field.

---

### 2.2 Add `imageStatus` to `NewspaperPage` interface

**File:** `src/app/services/newspaper-data.service.ts`

Add optional field to `NewspaperPage`:
```typescript
imageStatus?: 'pending' | 'ready';
```

- Pages created by XML import with no `fullImage` get `imageStatus: 'pending'`.
- Pages with a valid `fullImage` URL get `imageStatus: 'ready'` (or field absent = ready).

---

### 2.3 Add `importSource` to `NewsSection` interface

**File:** `src/app/services/newspaper-data.service.ts`

Add optional field to `NewsSection`:
```typescript
importSource?: 'xml' | 'manual';
```

XML-imported sections get `'xml'`; manually created sections get `'manual'` or field absent.

---

### 2.4 Add `XmlImportRow` and `XmlImportResult` interfaces

**File:** `src/app/services/newspaper-data.service.ts` (or a new `src/app/services/xml-import.service.ts`)

```typescript
export interface XmlImportRow {
  title: string;
  content: string;
  date: string;           // YYYY-MM-DD
  edition: number;        // default 1
  page: number;
  derivedId: string;      // deterministic ID
  duplicateStatus: 'new' | 'duplicate-exact' | 'duplicate-key';
  importAction: 'skip' | 'overwrite' | 'import-as-new';
  assignedPageId: number; // may differ from XML page after manual reassignment in wizard
  rowIndex: number;
  rawTitle: string;       // pre-sanitization, for display
}

export interface XmlParseError {
  rowIndex: number;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface XmlImportResult {
  rows: XmlImportRow[];
  errors: XmlParseError[];
  totalRows: number;
  newCount: number;
  duplicateCount: number;
  errorCount: number;
  dateRange: { min: string; max: string };
}
```

---

## Phase 3 — PHP Plugin Changes

### 3.1 Add `dn_page_name` scalar meta field

**File:** `wordpress-plugin/digital-newspaper/digital-newspaper.php`

In `upsert_section_post()`, after writing `dn_page_labels`, add:

```php
// Plain-text page name for easy querying (best-effort from labels array)
$page_name = '';
if (!empty($page_labels)) {
  $labels_arr = is_string($page_labels) ? json_decode($page_labels, true) : $page_labels;
  if (is_array($labels_arr)) {
    $page_name = reset($labels_arr) ?: '';
  }
}
update_post_meta($post_id, 'dn_page_name', sanitize_text_field($page_name));
```

---

### 3.2 Return `wpPostId` in the save response

**File:** `wordpress-plugin/digital-newspaper/digital-newspaper.php`

After `sync_section_posts_from_data($data)` in `save_data()`, collect the upserted post IDs and include them in the REST response payload. The Angular `saveData()` response handler should read this map and patch the in-memory `NewsSection` objects.

Minimal response addition:
```php
return new WP_REST_Response([
  'success' => true,
  'sectionPostIds' => $this->get_section_post_id_map($data), // [ sectionKey => wpPostId ]
], 200);
```

---

### 3.3 (Optional) Consider enabling `show_in_rest` on `dn_section` post type

**Decision:** Currently `show_in_rest: false`. Only change this if future requirements need the WP REST API to expose `dn_section` posts to authenticated external consumers. Not required for Phase 1.

---

## Phase 4 — XML Parser & Import Service

### 4.1 Create `XmlImportService`

**File:** `src/app/services/xml-import.service.ts`

Methods to implement:

```typescript
// Step 1: Parse raw XML string into structured rows
parseXml(xmlString: string): XmlImportResult

// Step 2: Detect duplicates against current data
detectDuplicates(rows: XmlImportRow[], currentData: NewspaperData): XmlImportRow[]

// Step 3: Apply import (pure — returns mutated data, does not save)
applyXmlImport(
  rows: XmlImportRow[],
  currentData: NewspaperData
): { data: NewspaperData; summary: XmlImportSummary }
```

Implementation notes:

- Use browser-native `DOMParser` — no external XML library needed.
- Parse each `<post>` element individually; invalid rows produce an `XmlParseError` and are excluded from valid rows.
- Date validation: use `Date.parse()` + format check regex `^\d{4}-\d{2}-\d{2}$`.
- Content sanitization: strip `<script>`, `<iframe>`, `<style>`, all `on*` attributes, `javascript:` href values before storing. A simple regex whitelist approach is sufficient; use `DOMParser` to parse the HTML fragment and walk the DOM.
- `applyXmlImport` groups rows by `date + edition`, calls `getOrCreateEdition()`, then per page calls `getOrCreatePage()`, then per row calls `addSection()` or `updateSection()` based on `importAction`.
- Returns the mutated `NewspaperData` object and a `XmlImportSummary { created, updated, skipped, skeletonPagesCreated }`.
- Does **not** call `saveData()` — the wizard component handles saving after the user confirms.

---

### 4.2 Implement stable ID generation

**File:** `src/app/services/xml-import.service.ts`

```typescript
private deriveXmlSectionId(row: Partial<XmlImportRow>, existingIds: Set<string>): string {
  const slug = row.title!
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .substring(0, 40);
  const base = `xml-${row.date}-e${row.edition}-p${row.page}-${slug}`;
  let candidate = base;
  let counter = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}-${counter++}`;
  }
  existingIds.add(candidate);
  return candidate;
}
```

---

### 4.3 Implement intra-file duplicate detection

Before comparing against existing data in `detectDuplicates()`, first scan within the parsed rows themselves:

```typescript
const seenKeys = new Set<string>();
for (const row of rows) {
  if (seenKeys.has(row.derivedId)) {
    row.duplicateStatus = 'duplicate-exact';
    row.importAction = 'skip';
    // add a warning: 'Duplicate within this file — only first occurrence will be imported'
  }
  seenKeys.add(row.derivedId);
}
```

---

## Phase 5 — Wizard Modal Component

### 5.1 Create `BulkXmlImportComponent`

**File:** `src/app/admin/bulk-xml-import/bulk-xml-import.component.ts`  
**Template:** `src/app/admin/bulk-xml-import/bulk-xml-import.component.html`  
**Styles:** `src/app/admin/bulk-xml-import/bulk-xml-import.component.css`

Standalone component. Activated by clicking "Add Bulk E-post" in the vintage header menu.

State properties:
```typescript
currentStep: 1 | 2 | 3 | 4 = 1;
xmlFile: File | null = null;
parseResult: XmlImportResult | null = null;
isParsingFile = false;
importRows: XmlImportRow[] = [];
selectedRowIds = new Set<string>();
assignedPageMap: Map<string, number> = new Map(); // derivedId → assignedPageId
importOptions = { mergeMode: 'add-new', duplicateDefault: 'skip' };
isImporting = false;
importSummary: XmlImportSummary | null = null;
```

---

### 5.2 Implement Step 1 — Upload & Parse

**Template section for Step 1:**

- Large drag-and-drop zone with `(drop)`, `(dragover)`, `(dragleave)` handlers.
- Click zone triggers a hidden `<input type="file" accept=".xml">`.
- On file selected: call `xmlImportService.parseXml(fileContent)` and store result.
- Show summary banner on success: "X posts found across Y editions and Z dates" with `New: N`, `Duplicate: N`, `Errors: N` pill badges.
- Show scrollable error list if `parseResult.errors` contains `severity: 'error'` items. Disable Next until no fatal errors remain.
- "Clear file" link resets `xmlFile` and `parseResult`.

---

### 5.3 Implement Step 2 — Review & Assign

**Two-panel layout:**

**Left panel (60% width) — Post Queue:**

- Group rows by `date → edition → page` with collapsible group headers.
- Each group header has a "Select all" checkbox and a row count badge.
- Each row shows:
  - Checkbox (toggles individual selection in `selectedRowIds`)
  - Post title (bold), content preview (first 80 chars, italic, muted text)
  - "Page X" chip from `row.page` value
  - Status badge: `New` (green) / `Duplicate – overwrite` (amber) / `Duplicate – skip` (grey) / `Error` (red)
  - Overflow menu (three dots): "Edit title" / "Mark skip" / "Force overwrite" / "Preview content" (opens a small inline popover)
- "Select all / Deselect all" button at the panel top with "X of Y selected" counter.
- Unassigned rows (page number not found in existing edition) shown in a collapsible amber "Unassigned" bucket at the bottom.
- Filter bar: "All | New only | Duplicates only | Errors only" pill filter.

**Right panel (40% width) — Page Browser:**

- Date + edition selector at the top (synced to the active left-panel group; changes update the page list below).
- Pages displayed as vertical cards. Each card shows:
  - Page number badge and page name label.
  - Thumbnail image or placeholder silhouette.
  - "X posts queued" pill in green.
  - "+ Assign selected" button (visible when rows are checked); clicking assigns all checked left-panel rows to this page.
  - Highlight border when a row on the left is currently focused/hovered (visual pairing).
- A "Create new page" card at the bottom (dashed border, `+` icon). Creates a skeleton `NewspaperPage` and adds it to the page list.
- Skeleton page cards show a "Needs page image" amber chip.

---

### 5.4 Implement Step 3 — Duplicate Resolution (conditional)

Only rendered when `parseResult.duplicateCount > 0`.

- Compact table with columns: Post title | Existing match (date/edition/page) | Action dropdown.
- Action dropdown options per row: **Skip** / **Overwrite content only** / **Import as new entry**.
- "Apply same action to all" toggle at the top.
- A banner: "X duplicates — Y will be skipped, Z will overwrite" (updates live as dropdowns change).

---

### 5.5 Implement Step 4 — Confirm & Import

**Impact summary card:**

```
Posts to create:           14
Posts to update:            3
Posts to skip:              2
Editions affected:          2
Pages affected:             5
Skeleton pages created:     1  ← needs image upload
```

- "Auto-backup before import (recommended)" checkbox — checked and locked by default. On confirm, calls `downloadExport()` before proceeding.
- Primary "Import" button (full width, green).
- During import: replace button with progress bar + status text stages: `"Parsing…"` → `"Merging data…"` → `"Saving to WordPress…"` → `"Done"`.
- **On success:** Transition to a success screen:
  - Confirmation message with counts.
  - "Go to Content" button — navigates admin to the first imported date.
  - "Set page images now" button — navigates to the page editor for the first skeleton page.
  - "Import another file" button — resets wizard to Step 1.
  - Collapsible list of skeleton pages still needing images.

---

### 5.6 Activate "Add Bulk E-post" menu item

**File:** `src/app/admin/admin.component.html`

Change the menu item from `vhdr-menu-item--soon` to active and bind its click to `openBulkXmlImport()`.

**File:** `src/app/admin/admin.component.ts`

Add:
```typescript
showBulkXmlImport = false;

openBulkXmlImport(): void {
  this.closeMenu();
  this.showBulkXmlImport = true;
}
```

---

## Phase 6 — Admin UI Enhancements (Post-Import State)

### 6.1 Show "Needs image" badge on skeleton pages in the admin page editor

**File:** `src/app/admin/admin.component.html`

For pages where `page.imageStatus === 'pending'`, show a visible amber badge next to the page name in the page list and in the page editor header.

---

### 6.2 Show a persistent "draft sections" warning banner in admin

If any edition in the current data has pages with `imageStatus: 'pending'`, show a sticky banner at the top of the admin content tab:

> ⚠ **X pages are missing images.** These pages' sections are saved but won't display in the viewer until you upload a page image and set crop coordinates. [Set now →]

---

### 6.3 Surface WordPress post ID in the section edit panel

**File:** `src/app/admin/admin.component.html`

In the section edit form, add a read-only field that shows `section.wpPostId` if present:

```html
<div *ngIf="sectionForm.wpPostId" class="wp-post-id-badge">
  WP Post ID: {{ sectionForm.wpPostId }}
</div>
```

---

## Phase 7 — Public Viewer Protection

### 7.1 Hide sections with zero crop coordinates from the public viewer

**File:** `src/app/newspaper.component.html`

Wrap section overlay render in a guard:

```html
<ng-container *ngFor="let section of currentPage.sections">
  <div *ngIf="section.width > 0 && section.height > 0"
       class="section-overlay"
       [style.left.%]="section.x"
       ...>
  </div>
</ng-container>
```

Sections imported via XML will have `x=y=w=h=0` until manually cropped. This prevents invisible/unclickable zero-size overlays from being rendered.

---

## Phase 8 — Testing & Acceptance

### 8.1 Unit tests for `XmlImportService`

Test each method with the fixture files from Phase 1:

- `parseXml` with valid, partial, and malformed inputs.
- `detectDuplicates` with exact matches, key-only matches, and no matches.
- `applyXmlImport` for add-new, overwrite, skip, and skeleton-page-creation paths.
- Intra-file duplicate detection.
- Re-import idempotency (same file twice = zero net diff).

---

### 8.2 Integration test: full import → save → WP sync

Manual test steps:

1. Run import using `happy-path.xml`.
2. Confirm Angular data store contains correct editions/pages/sections.
3. Confirm `saveData()` call is made once (not per section).
4. Open WordPress admin → Tools → Newspaper Sections.
5. Confirm expected number of `dn_section` posts exist with correct meta (`dn_newspaper_date`, `dn_edition_number`, `dn_crop_x/y/w/h`, `dn_page_name`, etc.).
6. Repeat using `duplicates.xml` with Overwrite → confirm existing posts are updated, not duplicated.
7. Repeat using `duplicates.xml` with Skip → confirm existing posts are unchanged.

---

### 8.3 Acceptance criteria checklist

Before marking this feature complete:

- [ ] Upload + parse returns correct row count and error list
- [ ] Two-panel wizard groups posts by date/edition correctly
- [ ] Page assignment works (click "+ Assign selected" → row gets page ID)
- [ ] Intra-file duplicates flagged before save
- [ ] Duplicate detection against existing data correctly identifies matches by derived key
- [ ] Import applies section mutations to the correct edition and page
- [ ] `saveData()` called once after all mutations
- [ ] WordPress `dn_section` posts exist in WP admin with correct meta after import
- [ ] `dn_page_name` meta populated for all sections
- [ ] `wpPostId` visible in admin section form after save
- [ ] Skeleton pages show "Needs image" badge in admin
- [ ] Admin persistent warning banner appears for pages with `imageStatus: 'pending'`
- [ ] Sections with `w=0 h=0` are not rendered as overlays in the public viewer
- [ ] Re-importing the same file causes zero net change to data
- [ ] Auto-backup is downloaded before any import save
- [ ] Large import (500+ rows) completes within acceptable time (<10s on average hardware)
- [ ] Add Post / Edit Post WP sync still works normally (no regression)

---

## Implementation Order

```
Phase 1 — Requirements (all decisions made before writing any code)
    1.1  XML schema spec + test fixtures
    1.2  Page assignment strategy decision
    1.3  Duplicate detection contract finalized
    1.4  WP sync gap confirmed
    1.5  Draft vs. immediate-publish decision

Phase 2 — Data model changes (small, foundational)
    2.1  Add `wpPostId` to NewsSection
    2.2  Add `imageStatus` to NewspaperPage
    2.3  Add `importSource` to NewsSection
    2.4  Add XmlImportRow + XmlImportResult interfaces

Phase 3 — PHP plugin changes (minimal)
    3.1  Add `dn_page_name` scalar meta
    3.2  Return `sectionPostIds` map in save response

Phase 4 — XML parser + import service (backend-independent, testable)
    4.1  XmlImportService skeleton
    4.2  Stable ID derivation
    4.3  XML parse method
    4.4  Intra-file duplicate detection
    4.5  Cross-data duplicate detection
    4.6  Content sanitization
    4.7  applyXmlImport method

Phase 5 — Wizard modal component (largest unit)
    5.1  Component scaffold
    5.2  Step 1: Upload & Parse UI
    5.3  Step 2: Review & Assign (two-panel)
    5.4  Step 3: Duplicate Resolution
    5.5  Step 4: Confirm & Import
    5.6  Activate menu item in admin

Phase 6 — Admin UI enhancements
    6.1  Skeleton page "Needs image" badge
    6.2  Persistent warning banner
    6.3  WP Post ID display in section form

Phase 7 — Viewer protection
    7.1  Guard zero-crop sections in newspaper.component.html

Phase 8 — Testing
    8.1  Unit tests for XmlImportService
    8.2  Integration test (import → save → WP sync)
    8.3  Acceptance checklist sign-off
```

---

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| XML from different source systems may not match the expected schema | High | Define schema strictly in Phase 1.1; surface per-row errors in Step 1 of the wizard |
| Content CDATA may contain malicious HTML | High | Phase 4.6 content sanitization is mandatory; PHP already uses `wp_kses_post` |
| `applyXmlImport` mutates data in memory before save; crash between apply and save would lose progress | Medium | Auto-backup before every import save (Step 4 mandatory) |
| Large imports (500+ rows) may block the UI thread during `DOMParser` parse | Medium | Wrap parsing in a `setTimeout` tick or use `requestIdleCallback` |
| `Date.now()` ID collisions in existing `addSection()` path for same-ms bulk inserts | Low (existing bug) | XML import uses deterministic IDs instead; `addSection()` from admin is single-row so not affected |
| PHP `upsert_section_post()` has N+1 query pattern for large imports | Low for normal use, medium for 500+ row imports | Out of scope for Phase 1; batch meta update is a future optimisation |
| Browser `DOMParser` strictness varies across versions for malformed XML | Low | All major browsers handle this identically; document minimum supported browser version |

---

*End of plan — do not start implementation until all Phase 1 decisions are checked off.*
