# Admin Panel Guide

## Overview
The newspaper admin panel provides a comprehensive interface for managing newspaper pages and sections with an intuitive visual image cropper.

## Accessing the Admin Panel
Navigate to: `http://localhost:4200/admin`

Main viewer: `http://localhost:4200/`

## Features

### 1. Page Management
- **Add Page**: Click "+ Add Page" button in the sidebar
  - Enter page ID (number)
  - Provide full image URL (the complete newspaper page image)
  - Optionally provide thumbnail URL (defaults to full image)
  - Preview the image before saving

- **Edit Page**: Click the edit icon on any page card
  - Modify image URLs
  - Page ID cannot be changed after creation

- **Delete Page**: Click the trash icon on any page card
  - Warning: This will delete all sections associated with the page

### 2. Section Management
- **Add Section**: Select a page, then click "+ Add Section"
  - **Section ID**: Unique identifier (auto-generated if left empty)
  - **Title**: Section headline
  - **Position & Size**: Define section coordinates
    - Manual entry: X, Y, Width, Height (percentages)
    - **Visual Crop Selector**: Click the button to use interactive cropper
  - **Section Image URL** (optional): Pre-cropped image URL
    - Leave empty to auto-crop from full page image
  - **Content**: HTML content for the article
  - **Linked Sections**: Link related sections from other pages

- **Edit Section**: Click "Edit" on any section card
  - All fields can be modified
  - Section ID cannot be changed

- **Delete Section**: Click "Delete" on any section card

### 3. Visual Crop Selector (Smart Solution)
The visual crop selector is an interactive tool for defining section coordinates:

1. Click "Visual Crop Selector" button when editing a section
2. The full newspaper page image appears
3. **Click and drag** on the image to select the section area
4. A blue selection rectangle appears showing your selection
5. Coordinates are automatically calculated as **percentages**
6. Real-time display shows: X%, Y%, Width%, Height%
7. Click "Apply Selection" to use these coordinates

**Why percentages?**
- Responsive: Works with any screen size
- Consistent: Same relative position regardless of image resolution
- Easy to transfer: Can be used with different image sizes

### 4. Linked Sections
Cross-reference sections across multiple pages:
- When editing a section, scroll to "Linked Sections"
- Check boxes next to related sections
- Viewer automatically loads linked sections when displaying the article

### 5. Data Management
- **Save All**: Saves all changes to the data service (top-right button)
- **Download JSON**: Export current data as `newspaper-data.json`
- **Auto-sync**: Changes are reflected in the viewer immediately

## Workflow Example

### Adding a New Newspaper Page with Sections:

1. **Add the Page**
   - Click "+ Add Page"
   - ID: 4
   - Full Image: `https://example.com/page4.jpg`
   - Click "Save Page"

2. **Add First Section (Headline)**
   - Select Page 4 from sidebar
   - Click "+ Add Section"
   - Title: "Breaking News: City Celebrates"
   - Click "Visual Crop Selector"
   - Draw rectangle over the headline area
   - Click "Apply Selection"
   - Add content: `<h2>City Celebrates</h2><p>Article text...</p>`
   - Click "Save Section"

3. **Add Second Section (Related Article)**
   - Click "+ Add Section" again
   - Title: "Background Story"
   - Use Visual Crop Selector for different area
   - In "Linked Sections", check the first section
   - Click "Save Section"

4. **Save Everything**
   - Click "Save All" in header
   - Click "Download JSON" to backup

5. **View in App**
   - Click "Back to Viewer"
   - Navigate to Page 4
   - Click on sections to see them in the right panel
   - Linked sections appear automatically

## Tips & Best Practices

### Image Cropping
- Use the visual cropper for accuracy
- Start with larger areas and refine as needed
- Preview sections in the viewer to verify cropping

### Content Structure
- Use semantic HTML in content field
- Keep headlines clear and concise
- Test content in viewer to ensure proper formatting

### Linked Sections
- Link continuation articles
- Link related stories
- Link sections that reference each other

### Data Management
- Save frequently to avoid losing work
- Download JSON backups regularly
- Test changes in viewer before finalizing

## Technical Details

### Data Structure
All data is stored in `/assets/newspaper-data.json`:

```json
{
  "pages": [
    {
      "id": 1,
      "fullImage": "url",
      "thumbnail": "url",
      "sections": [
        {
          "id": "section1",
          "title": "Headline",
          "x": 10,
          "y": 15,
          "width": 45,
          "height": 30,
          "content": "<html>...</html>",
          "imageUrl": "optional-url",
          "linkedSectionIds": ["section2"]
        }
      ]
    }
  ]
}
```

### Coordinate System
- **X**: Horizontal position from left edge (0-100%)
- **Y**: Vertical position from top edge (0-100%)
- **Width**: Horizontal size (0-100%)
- **Height**: Vertical size (0-100%)

Example: `x:10, y:20, width:40, height:25` means:
- Section starts 10% from left, 20% from top
- Section is 40% of page width, 25% of page height

## Troubleshooting

### Section not displaying correctly
- Verify coordinates are within 0-100% range
- Check if imageUrl is valid (if provided)
- Ensure full page image URL is accessible

### Linked sections not loading
- Verify linked section IDs exist
- Check that sections are on different pages
- Ensure data is saved

### Changes not appearing in viewer
- Click "Save All" after making changes
- Refresh the viewer page
- Check browser console for errors

## Future Enhancements
- Image upload functionality
- Drag-and-drop section reordering
- Bulk edit operations
- Section templates
- Undo/redo functionality
- User authentication
