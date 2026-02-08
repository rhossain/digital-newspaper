# Optional Caption Feature

## Overview
Section captions (title and page number) can now be toggled on/off from the admin panel. This gives you control over whether to display captions below cropped images in the viewer.

## How to Use

### In Admin Panel

1. **Navigate to a page** and select a section to edit (or create a new section)
2. **Find the "Show caption in viewer" checkbox** in the section form
3. **Check/uncheck** to control caption visibility:
   - ✅ **Checked** (default): Caption will be displayed in the viewer
   - ⬜ **Unchecked**: Caption will be hidden in the viewer
4. **Save** the section to apply changes

### In Viewer

- When `showCaption` is enabled (or not set), the caption displays:
  - **Section title** (h3 heading)
  - **Page number** (small text)
  - Styled with blue theme (#1976d2)

- When `showCaption` is disabled:
  - Caption area is completely hidden
  - More focus on the cropped image itself

## Technical Details

### Data Structure
```typescript
interface NewsSection {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
  imageUrl?: string;
  pageId?: number;
  linkedSectionIds?: string[];
  showCaption?: boolean;  // NEW: Controls caption visibility
}
```

### Default Behavior
- **New sections**: `showCaption` defaults to `true`
- **Existing sections**: If `showCaption` is undefined, it's treated as `true` (backward compatible)
- This ensures existing data continues to work without modification

### HTML Implementation
```html
<!-- Caption only displays when showCaption !== false -->
<div class="section-image-caption" *ngIf="selectedSection.showCaption !== false">
  <div class="caption-header">
    <div class="caption-text">
      <h3>{{ selectedSection.title }}</h3>
      <p>Page {{ currentPage.id }}</p>
    </div>
    <!-- Read Article button (if content exists) -->
  </div>
</div>
```

## Use Cases

### Show Caption (Default)
Perfect for:
- News articles that need context
- Sections where title is important
- Educational content
- Reference material

### Hide Caption
Ideal for:
- Pure visual content (photos, infographics)
- Minimalist design approach
- When space is limited
- Artistic/creative presentations

## Examples

### With Caption
```
┌─────────────────────────┐
│                         │
│   [Cropped Image]       │
│                         │
├─────────────────────────┤
│ Breaking News           │
│ Page 1                  │
└─────────────────────────┘
```

### Without Caption
```
┌─────────────────────────┐
│                         │
│   [Cropped Image]       │
│                         │
└─────────────────────────┘
```

## Files Modified

1. **newspaper-data.service.ts**: Added `showCaption?: boolean` to `NewsSection` interface
2. **newspaper.component.html**: Added `*ngIf="selectedSection.showCaption !== false"` to caption div
3. **admin.component.ts**: 
   - Added `showCaption: true` to default sectionForm
   - Added logic to preserve showCaption in saveSection method
4. **admin.component.html**: Added checkbox control with label and help text
5. **admin.component.css**: Added styling for checkbox label and help text

## Migration

No migration needed! Existing sections without the `showCaption` property will automatically show captions (default behavior).

If you want to hide captions for existing sections:
1. Open admin panel
2. Edit each section
3. Uncheck "Show caption in viewer"
4. Save changes

## Future Enhancements

Potential additions:
- Bulk toggle for all sections on a page
- Custom caption templates
- Caption positioning options (top/bottom/overlay)
- Caption styling customization
- Auto-hide caption on small screens
