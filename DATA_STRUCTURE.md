# Newspaper Data Structure

This document describes the JSON data structure used for the newspaper application.

## Overview

The application loads newspaper data from `src/assets/newspaper-data.json` by default. This can be easily replaced with an API endpoint.

## Data Structure

### Root Object
```json
{
  "pages": [...]  // Array of NewspaperPage objects
}
```

### NewspaperPage Object
```json
{
  "id": number,              // Unique page identifier
  "thumbnail": "string",     // URL to thumbnail image
  "fullImage": "string",     // URL to full-size page image
  "sections": [...]          // Array of NewsSection objects
}
```

### NewsSection Object
```json
{
  "id": "string",                    // Unique section identifier
  "title": "string",                 // Section title/headline
  "x": number,                       // X position (percentage)
  "y": number,                       // Y position (percentage)
  "width": number,                   // Width (percentage)
  "height": number,                  // Height (percentage)
  "pageId": number,                  // Page this section belongs to
  "linkedSectionIds": ["string"],    // Optional: Array of linked section IDs
  "imageUrl": "string",              // Optional: Direct URL to section image
  "content": "string"                // HTML content of the article
}
```

## Position System

The position system uses percentages (0-100) to define section locations on the newspaper page:
- `x`: Horizontal position from left (0 = left edge, 100 = right edge)
- `y`: Vertical position from top (0 = top edge, 100 = bottom edge)
- `width`: Width of the section as percentage of page width
- `height`: Height of the section as percentage of page height

## Linked Sections

Sections can be linked across pages using the `linkedSectionIds` array. When a section is selected, all linked sections will be displayed in the "Related Sections" area, allowing users to navigate between related content.

## API Integration

To integrate with a third-party API:

1. Update `loadNewspaperData()` in `newspaper.component.ts`:

```typescript
loadNewspaperData() {
  const apiUrl = 'https://your-api-endpoint.com/api/newspaper/data';
  
  this.http.get<{ pages: NewspaperPage[] }>(apiUrl).subscribe({
    next: (data) => {
      this.pages = data.pages;
      if (this.pages.length > 0) {
        this.selectPage(this.pages[0]);
      }
    },
    error: (error) => {
      console.error('Error loading newspaper data from API:', error);
      this.pages = [];
    }
  });
}
```

2. Ensure your API returns data in the same format as described above.

3. Add authentication headers if needed:

```typescript
const headers = { 'Authorization': 'Bearer YOUR_TOKEN' };
this.http.get<{ pages: NewspaperPage[] }>(apiUrl, { headers }).subscribe(...);
```

## Example API Endpoints

Common API patterns you might implement:

- **Get all pages**: `GET /api/newspaper/pages`
- **Get specific page**: `GET /api/newspaper/pages/{pageId}`
- **Get specific section**: `GET /api/newspaper/sections/{sectionId}`
- **Get pages by date**: `GET /api/newspaper/pages?date=2026-02-03`
- **Get pages by edition**: `GET /api/newspaper/pages?edition=morning`

## Image URLs

The application supports two methods for displaying section images:

1. **Direct imageUrl**: Provide a pre-cropped image URL in the `imageUrl` field
2. **Canvas Cropping**: Leave `imageUrl` empty or omit it, and the app will crop the section from the full page image using the position coordinates

For better performance, using pre-cropped `imageUrl` values is recommended.

## Content Format

The `content` field accepts HTML markup. Common tags include:
- `<h2>` for titles
- `<p>` for paragraphs
- `<strong>` for author bylines
- `<em>` for emphasis

Ensure HTML is properly escaped when stored in JSON.
