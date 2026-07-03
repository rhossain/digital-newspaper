# WebP Image Format — Implementation Plan

Full codebase review completed before writing this plan.  
**Rule: no existing upload flow, crop tool, viewer UI, or admin feature may break.**  
All tasks are safe to implement in the listed order. Do not skip or reorder.

---

## How the feature works (design summary)

A new `imageFormat` field is added to **Global Settings** with two values:
- **`webp`** (default) — all newly uploaded and auto-generated images are encoded as WebP before being sent to WordPress.
- **`all`** — current behaviour: JPEG stays JPEG, PNG stays PNG, uploaded file formats are preserved.

The setting is persisted in WordPress alongside all other settings (`dn_settings` option). The admin toggles it in the **Settings → Image Format** section. All image-producing operations in `admin.component.ts` read this setting at the moment of encoding, so the switch takes effect immediately on the next upload without any migration of existing images.

**Existing stored images are never touched.** They continue to load normally regardless of which mode is active.

---

## Complete map of image-producing code (what this plan changes)

| Location | Operation | Currently outputs | Change in WebP mode |
|---|---|---|---|
| `image-resize.util.ts` → `resizeImageToWidth()` | Resize via Canvas | `image/jpeg` + `.jpg` | `image/webp` + `.webp` |
| `admin.component.ts` → `onFullImageFileSelected()` | 700px display resize | JPEG via `resizeImageToWidth` | WebP |
| `admin.component.ts` → `onFullImageFileSelected()` | 300px thumb auto-gen | JPEG via `resizeImageToWidth` | WebP |
| `admin.component.ts` → `onFullImageFileSelected()` | Hi-res original upload | Original format (no canvas) | **Unchanged — keep original** |
| `admin.component.ts` → `onFullImageHiResFileSelected()` | Hi-res manual upload | Original format (no canvas) | **Unchanged — keep original** |
| `admin.component.ts` → `onThumbnailFileSelected()` | 300px thumb resize | JPEG via `resizeImageToWidth` | WebP |
| `admin.component.ts` → `onImageFileSelected()` | Section manual image upload | Original format via FileReader | Re-encode via Canvas → WebP |
| `admin.component.ts` → `generateAndUploadCroppedImageFromFullSize()` | Section crop | `canvas.toDataURL('image/jpeg', 0.9)` | `canvas.toDataURL('image/webp', 0.9)` |
| `admin.component.ts` → `onLogoFileSelected()` | Logo upload | Original format | Re-encode via Canvas → WebP |
| **PHP GD** → `dn_fallback_social_image()` | OG fallback image | `imagejpeg()` | **Unchanged — keep JPEG** (social platform compatibility) |
| **PHP GD** → `dn_resize_for_social()` | OG resize | `imagejpeg()` | **Unchanged — keep JPEG** |
| **PHP GD** → `dn_crop_section_from_page()` | OG section crop | `imagejpeg()` | **Unchanged — keep JPEG** |

> **Why hi-res is kept as original format:** The hi-res file is the source image fed into the admin crop tool. It is never shown to readers. Forcing it through canvas re-encoding on upload would add unnecessary time for large scans (5–20 MB) without any reader-visible benefit.
>
> **Why PHP GD social images stay as JPEG:** These are only used in OG/Twitter meta tags for link previews. Several social platforms (LinkedIn crawlers, WhatsApp) have patchy WebP support. JPEG is the safest universal format here.
>
> **Why viewer `<img>` tags need no `<picture>` element:** New images will be `.webp` URLs; old ones are `.jpg` URLs. The browser picks the right decoder from the URL alone. All modern browsers (>97% global coverage) support WebP natively. No `<picture>` fallback needed.

---

## Tasks

---

### WEBP-01 — Add `imageFormat` to `GlobalSettings` interface and PHP defaults

**Files:** `src/app/services/newspaper-data.service.ts`, `wordpress-plugin/digital-newspaper/digital-newspaper.php`

**Angular — `GlobalSettings` interface:**
Add one optional field after `othersPageTitle`:
```typescript
/** Controls the encoding format for all new image uploads.
 *  'webp' (default) — encode everything as WebP before upload.
 *  'all'            — preserve original format (current behaviour).
 */
imageFormat?: 'webp' | 'all';
```

**PHP — `default_data()` method:**
Add to the `settings` array in `default_data()`:
```php
'imageFormat' => 'webp',
```

**Why `?` optional in TypeScript:** Existing saved settings in WordPress won't have this key. All callers must default to `'webp'` when the key is absent (`settings?.imageFormat || 'webp'`), not `'all'`, so the feature is active by default for existing installs.

**Verification:** TypeScript compiles with no errors. PHP `default_data()` returns the new key.

**Risk:** None — additive field, backward compatible.

---

### WEBP-02 — Add Settings UI to admin

**Files:** `src/app/admin/admin.component.ts`, `src/app/admin/admin.component.html`

**`admin.component.ts` — `settingsForm` initialization (`loadSettings()`):**
Add to the `settingsForm` object literal:
```typescript
imageFormat: (settings.imageFormat || 'webp') as 'webp' | 'all',
```

**`admin.component.ts` — `buildSettingsFromForm()`:**
Add to the returned `GlobalSettings` object:
```typescript
imageFormat: this.settingsForm.imageFormat || 'webp',
```

**`admin.component.html` — new Settings section:**
Insert a new `<div class="settings-section">` block after the "Viewer Options" section and before "Social Media Links". The block contains:
- Section heading: "Image Format"
- Two radio buttons bound to `[(ngModel)]="settingsForm.imageFormat"`:
  - Value `webp` — label: `WebP (Recommended)` — hint: modern format, 25–35% smaller files, supported by all current browsers
  - Value `all` — label: `All Formats (Legacy)` — hint: uploaded files keep their original format (JPEG, PNG, etc.)
- A `hint-text` paragraph explaining: "Applies to all new uploads and auto-generated images from this point forward. Existing images are not affected."
- A warning note (use the existing `settings-section--maintenance-active` style pattern or a plain info hint) when `all` is selected: "Legacy mode — new images will use larger JPEG/PNG formats."

**Verification:** Save settings with both options; verify the value is stored and reloaded correctly. No other settings fields are affected.

**Risk:** Low — new form field and UI block only.

---

### WEBP-03 — Update `image-resize.util.ts`

**File:** `src/app/shared/utils/image-resize.util.ts`

This is the central resize utility used by all page image and thumbnail uploads.

**Signature change:**
```typescript
export function resizeImageToWidth(
  file: File,
  targetWidth: number,
  quality = 0.92,
  outputMime: 'image/webp' | 'image/jpeg' = 'image/webp'  // ← new parameter
): Promise<File>
```

**Inside the function — two changes:**

1. `canvas.toBlob(...)` call: change the MIME type argument from the hardcoded `'image/jpeg'` to `outputMime`.

2. The output `File` constructor: change the filename from `${baseName}.jpg` to:
   ```typescript
   const ext = outputMime === 'image/webp' ? 'webp' : 'jpg';
   resolve(new File([blob], `${baseName}.${ext}`, { type: outputMime }));
   ```

3. The early-return path (image already ≤ targetWidth): currently returns the original file unchanged. This must still return the original unchanged — do NOT re-encode just to change the format when no resize was needed. The caller (WEBP-04) is responsible for format conversion in that case if needed. Add a comment explaining this.

**Backward compatibility:** The `outputMime` parameter has a default of `'image/webp'`. No existing callers break — they will now get WebP by default. But all callers will be explicitly updated in WEBP-04 anyway to be clear about intent.

**Verification:** Upload a large JPEG page image in WebP mode. Confirm the file delivered to WordPress is `.webp`. Upload a smaller image that doesn't need resizing and confirm the original is returned untouched.

**Risk:** Low — isolated utility, single responsibility.

---

### WEBP-04 — Add image format helpers to `admin.component.ts`

**File:** `src/app/admin/admin.component.ts`

Add three private getters immediately after the existing class properties, before `ngOnInit`:

```typescript
/** Current image output MIME type based on the active imageFormat setting. */
private get imageMime(): 'image/webp' | 'image/jpeg' {
  return (this.dataService.getSettings()?.imageFormat || 'webp') === 'webp'
    ? 'image/webp'
    : 'image/jpeg';
}

/** File extension matching the current image format (no dot). */
private get imageExt(): string {
  return this.imageMime === 'image/webp' ? 'webp' : 'jpg';
}

/** Quality value for canvas encoding. WebP uses 0.88 (slightly lower = same visual
 *  quality as JPEG 0.92 due to better codec efficiency). */
private get imageQuality(): number {
  return this.imageMime === 'image/webp' ? 0.88 : 0.92;
}
```

These getters are read at the moment of each upload operation, so if the admin changes the setting mid-session and saves, the next upload automatically uses the new format.

**Verification:** No compile errors. No behaviour change yet — these are just getters.

**Risk:** None.

---

### WEBP-05 — Update page image and thumbnail uploads in `admin.component.ts`

**File:** `src/app/admin/admin.component.ts`

This task updates three methods. Make changes exactly as described — do not alter any other logic.

**`onFullImageFileSelected()` — three changes:**

1. Display image resize (700px):
   ```typescript
   // Before:
   const displayFile = await resizeImageToWidth(originalFile, 700, 0.92);
   const displayFileName = this.buildPageImageFilename('jpg', 'full');

   // After:
   const displayFile = await resizeImageToWidth(originalFile, 700, this.imageQuality, this.imageMime);
   const displayFileName = this.buildPageImageFilename(this.imageExt, 'full');
   ```

2. Hi-res original upload — **no change**. Keep `hiResExt` from the original file:
   ```typescript
   const hiResExt = originalFile.name.split('.').pop()?.toLowerCase() || 'jpg';
   const hiResFileName = this.buildPageImageFilename(hiResExt, 'hires');
   // uploadMediaFile(originalFile, hiResFileName)  ← no change
   ```

3. Auto-thumbnail generation:
   ```typescript
   // Before:
   const thumbFile = await resizeImageToWidth(originalFile, 300, 0.92);
   const thumbFileName = this.buildPageImageFilename('jpg', 'thumb');

   // After:
   const thumbFile = await resizeImageToWidth(originalFile, 300, this.imageQuality, this.imageMime);
   const thumbFileName = this.buildPageImageFilename(this.imageExt, 'thumb');
   ```

**`onThumbnailFileSelected()` — one change:**
```typescript
// Before:
const thumbFile = await resizeImageToWidth(originalFile, 300, 0.92);
const fileName = this.buildPageImageFilename('jpg', 'thumb');

// After:
const thumbFile = await resizeImageToWidth(originalFile, 300, this.imageQuality, this.imageMime);
const fileName = this.buildPageImageFilename(this.imageExt, 'thumb');
```

**`onFullImageHiResFileSelected()` — no changes.** This method uploads the raw original file directly without canvas processing. Leave it exactly as it is.

**Verification:**
- Upload a page image in WebP mode → `fullImage`, `thumbnail` URLs end in `.webp`, hi-res URL keeps original extension.
- Upload in legacy mode → all URLs end in their original extension.
- The page image loads correctly in the viewer after saving.
- The crop tool works correctly on the hi-res image.

**Risk:** Medium — core upload path. Test thoroughly.

---

### WEBP-06 — Update section crop upload in `admin.component.ts`

**File:** `src/app/admin/admin.component.ts`

`generateAndUploadCroppedImageFromFullSize()` — two changes inside the `img.onload` callback:

1. Change the canvas encode call:
   ```typescript
   // Before:
   const croppedImageData = canvas.toDataURL('image/jpeg', 0.9);
   const fileName = this.buildSectionImageFilename('jpg');

   // After:
   const croppedImageData = canvas.toDataURL(this.imageMime, this.imageQuality);
   const fileName = this.buildSectionImageFilename(this.imageExt);
   ```

No other changes in this method.

**Note on `canvas.toDataURL` quality:** The quality argument (0–1) works for both `image/jpeg` and `image/webp`. WebP at 0.88 is visually equivalent to JPEG at 0.92 and produces a smaller file. Use `this.imageQuality` which already accounts for this.

**Verification:**
- Drag the crop handles in the admin and click "Save Crop".
- In WebP mode: the resulting section `imageUrl` stored in the data ends in `.webp`.
- In legacy mode: ends in `.jpg`.
- The section image displays correctly in the viewer modal.
- The auto-crop display in section overlays is unaffected (those use `canvas.toDataURL('image/png')` in `newspaper.component.ts` for client-side display only — not uploaded, not changed).

**Risk:** Medium — crop is a key admin feature. Test with multiple crop boxes.

---

### WEBP-07 — Update section manual image upload in `admin.component.ts`

**File:** `src/app/admin/admin.component.ts`

`onImageFileSelected()` — currently reads the file via `FileReader.readAsDataURL()` then calls `dataUrlToFile()`. In WebP mode, we need to re-encode via Canvas instead.

**Replace the body of `onImageFileSelected()` after the validation checks:**

```typescript
// In legacy mode ('all'), keep existing FileReader path (no canvas overhead).
if (this.imageMime === 'image/jpeg') {
  const reader = new FileReader();
  reader.onload = () => {
    const imageData = reader.result as string;
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const fileName = this.buildSectionImageFilename(ext);
    this.uploadImageFile(imageData, fileName);
  };
  reader.onerror = () => this.toaster.error('Failed to read image file');
  reader.readAsDataURL(file);
  return;
}

// In WebP mode: re-encode via Canvas before uploading.
this.loader.show('Converting to WebP…');
const objectUrl = URL.createObjectURL(file);
const img = new Image();
img.onload = () => {
  URL.revokeObjectURL(objectUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    this.loader.hide();
    this.toaster.error('Failed to convert image');
    return;
  }
  ctx.drawImage(img, 0, 0);
  const imageData = canvas.toDataURL('image/webp', this.imageQuality);
  const fileName = this.buildSectionImageFilename('webp');
  this.uploadImageFile(imageData, fileName);
};
img.onerror = () => {
  URL.revokeObjectURL(objectUrl);
  this.loader.hide();
  this.toaster.error('Failed to load image for conversion');
};
img.src = objectUrl;
```

**Verification:**
- Upload a JPEG or PNG as a section image in WebP mode → stored URL ends in `.webp`.
- Upload in legacy mode → stored URL keeps original extension.
- Section image displays correctly in viewer overlay and modal.

**Risk:** Medium — replaces FileReader with canvas. The canvas approach is functionally equivalent plus re-encodes. Ensure the loader/error states are properly handled.

---

### WEBP-08 — Update logo upload in `admin.component.ts`

**File:** `src/app/admin/admin.component.ts`

`onLogoFileSelected()` — currently uses `uploadMediaFile(this.logoFile, fileName)` directly without canvas. In WebP mode, re-encode via Canvas (WebP supports transparency, making it a safe replacement for PNG logos).

**Replace the body of `onLogoFileSelected()` after the file assignment:**

```typescript
const file = input.files[0];
this.logoFile = file;

if (this.imageMime === 'image/jpeg') {
  // Legacy mode: upload as-is, keep original extension.
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
  const fileName = `logo_${Date.now()}.${ext}`;
  this.loader.show('Uploading logo…');
  this.activityLog.track('image_upload_logo', { fileName });
  this.uploadMediaFile(file, fileName)
    .then((url) => { /* existing success handler */ })
    .catch((error) => { /* existing error handler */ })
    .finally(() => this.loader.hide());
  return;
}

// WebP mode: re-encode via Canvas.
this.loader.show('Converting logo to WebP…');
const objectUrl = URL.createObjectURL(file);
const img = new Image();
img.onload = () => {
  URL.revokeObjectURL(objectUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) { this.loader.hide(); this.toaster.error('Failed to convert logo'); return; }
  ctx.drawImage(img, 0, 0);
  const dataUrl = canvas.toDataURL('image/webp', this.imageQuality);
  const fileName = `logo_${Date.now()}.webp`;
  this.activityLog.track('image_upload_logo', { fileName });
  const logoFileConverted = this.dataUrlToFile(dataUrl, fileName);
  this.uploadMediaFile(logoFileConverted, fileName)
    .then((url) => {
      if (this.settingsForm.logo) { this.settingsForm.logo.url = url; }
      this.onSettingsFormChanged();
      this.cdr.detectChanges();
      this.toaster.success('Logo uploaded');
    })
    .catch((error) => {
      console.error('Error uploading logo:', error);
      this.toaster.error('Failed to upload logo');
    })
    .finally(() => this.loader.hide());
};
img.onerror = () => {
  URL.revokeObjectURL(objectUrl);
  this.loader.hide();
  this.toaster.error('Failed to load logo for conversion');
};
img.src = objectUrl;
```

**Special note on PNG logos with transparency:** The Canvas API preserves alpha channel when encoding to `image/webp`. The logo will display correctly whether it is originally a PNG with transparency or a JPEG without.

**Verification:**
- Upload a PNG logo in WebP mode → URL ends in `.webp`, logo appears correctly in header.
- Upload in legacy mode → URL keeps original extension.
- Transparent PNG logo renders without white background artifacts.

**Risk:** Low — logo upload is a Settings-only operation, not in the main editing flow.

---

## What is NOT changed

| Item | Reason |
|---|---|
| `newspaper.component.ts` → `cropSectionImage()` (PNG data URL) | Client-side display crop only, never uploaded. PNG is correct here (lossless, no double compression). |
| `newspaper.component.ts` → `downloadImage()` | Extension derived from blob MIME type; already handles any format correctly. |
| PHP GD: `dn_fallback_social_image()`, `dn_resize_for_social()`, `dn_crop_section_from_page()` | OG/social images only. JPEG is safer for crawlers (LinkedIn, WhatsApp). Separate concern. |
| `upload_media()` PHP endpoint | Already accepts WebP. No changes needed. |
| Viewer `<img>` tags | New URLs will end in `.webp`, old ones `.jpg`. Both load correctly. No `<picture>` element needed. |
| Service worker `ngsw-config.json` | Already caches `*.webp` files. No change needed. |
| `isImageUrl` regex in `newspaper-data.service.ts` | Already includes `webp` in the pattern. No change needed. |

---

## Implementation order

```
WEBP-01 → WEBP-02 → WEBP-03 → WEBP-04 → WEBP-05 → WEBP-06 → WEBP-07 → WEBP-08
```

Each task is a prerequisite for the next. WEBP-04 must be done before 05–08 because the getters are used in those methods.

---

## Full verification checklist (run after all tasks complete)

### Settings
- [ ] Open Admin → Settings → Image Format section is visible.
- [ ] Radio "WebP (Recommended)" is selected by default on a fresh install.
- [ ] Changing to "All Formats" and saving persists correctly.
- [ ] Changing back to "WebP" and saving persists correctly.

### Page image upload (WebP mode)
- [ ] Upload a JPEG page image → `fullImage` URL ends in `.webp`.
- [ ] The auto-generated thumbnail URL ends in `.webp`.
- [ ] The hi-res URL ends in `.jpg` (or whatever the original was).
- [ ] The page image loads correctly in the viewer center panel.
- [ ] The thumbnail appears correctly in the left sidebar.

### Page image upload (legacy mode)
- [ ] Upload a JPEG → all URLs end in `.jpg`.
- [ ] Upload a PNG → all URLs end in `.png`.

### Thumbnail-only upload
- [ ] Upload a thumbnail in WebP mode → URL ends in `.webp`.
- [ ] Image displays correctly in the sidebar.

### Section crop
- [ ] Open a page with a hi-res image, draw a crop box, click Save Crop.
- [ ] In WebP mode: section `imageUrl` ends in `.webp`.
- [ ] Section image displays correctly in the section overlay.
- [ ] Section image displays correctly in the article modal.
- [ ] "Auto-crop" mode (no dedicated section image) still works correctly — the client-side PNG crop in the viewer is unaffected.

### Section manual image upload
- [ ] In the section editor, choose "Upload" and select a JPEG in WebP mode → URL ends in `.webp`.
- [ ] Image displays in the section editor preview.
- [ ] Image displays in the viewer modal.

### Logo upload
- [ ] Upload a PNG logo in WebP mode → URL ends in `.webp`.
- [ ] Logo appears in the viewer header without visual differences.
- [ ] Upload a transparent PNG logo → no white background in viewer.

### Existing content
- [ ] Open an edition with existing JPEG images — all load correctly (no regressions).
- [ ] Article modal for a section with an existing JPEG `imageUrl` → image loads correctly.
- [ ] Date picker, edition tabs, all viewer navigation unaffected.

### Admin panel
- [ ] Save All, Restore Backup, Bulk XML Import, activity log — all unaffected.
- [ ] Settings save and reload does not reset any other settings field.
