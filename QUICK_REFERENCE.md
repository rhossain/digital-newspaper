# Quick Reference Guide

## Common Tasks

### Add a New Page

```typescript
// In newspaper.component.ts, inside loadNewspaperData():
{
  id: 4,  // Unique page number
  thumbnail: '/assets/images/page4-thumb.jpg',
  fullImage: '/assets/images/page4-full.jpg',
  sections: [
    // Add sections here
  ]
}
```

### Add a New Section

```typescript
{
  id: 'unique-section-id',
  title: 'Section Title (shown on hover)',
  x: 10,      // Left position (%)
  y: 20,      // Top position (%)
  width: 40,  // Width (%)
  height: 30, // Height (%)
  content: `
    <h2>Article Headline</h2>
    <p>Article content...</p>
  `
}
```

### Calculate Percentages from Pixels

```javascript
// Formula:
x_percent = (x_pixels / image_width) * 100
y_percent = (y_pixels / image_height) * 100
width_percent = (width_pixels / image_width) * 100
height_percent = (height_pixels / image_height) * 100

// Example for 800x1100 image:
// Article at position (80, 110) with size (320, 220)
x = (80 / 800) * 100 = 10%
y = (110 / 1100) * 100 = 10%
width = (320 / 800) * 100 = 40%
height = (220 / 1100) * 100 = 20%
```

### Change Colors

```css
/* In newspaper.component.css */

/* Primary color */
.panel-header {
  background: linear-gradient(135deg, #YOUR_COLOR 0%, #YOUR_DARKER_COLOR 100%);
}

/* Section highlight */
.clickable-section:hover {
  background-color: rgba(YOUR_RGB, 0.15);
  border-color: #YOUR_COLOR;
}

/* Button colors */
.back-button {
  background-color: #YOUR_COLOR;
}
```

### Change Panel Widths

```css
/* In newspaper.component.css */
.left-panel {
  width: 250px;  /* Default: 200px */
}

.right-panel {
  width: 500px;  /* Default: 400px */
}
```

### Add Custom Fonts

```css
/* In styles.css */
@import url('https://fonts.googleapis.com/css2?family=Merriweather:wght@400;700&display=swap');

body {
  font-family: 'Merriweather', 'Georgia', serif;
}
```

### Format Article Content

```html
<!-- Headlines -->
<h2>Main Headline</h2>
<h3>Subheadline</h3>

<!-- Byline -->
<p><strong>By: Author Name</strong></p>
<p><em>Date: February 3, 2026</em></p>

<!-- Body text -->
<p>Regular paragraph text...</p>
<p>Another paragraph with <strong>bold text</strong> and <em>italic text</em>.</p>

<!-- Lists -->
<ul>
  <li>Bullet point 1</li>
  <li>Bullet point 2</li>
</ul>

<ol>
  <li>Numbered item 1</li>
  <li>Numbered item 2</li>
</ol>

<!-- Quotes -->
<blockquote>
  "This is a quote from someone important."
</blockquote>

<!-- Links -->
<p>Read more at <a href="https://example.com">this link</a>.</p>
```

## File Locations

```
newspaper-app/
├── src/app/newspaper.component.ts    ← Edit data here
├── src/app/newspaper.component.css   ← Edit styles here
├── src/app/newspaper.component.html  ← Edit layout here
└── src/assets/images/                ← Put images here
```

## Command Reference

```bash
# Start development server
npm start

# Build for production
npm run build

# Install dependencies
npm install

# Create new component
ng generate component component-name

# Run tests
ng test
```

## Browser DevTools

### Find Element Coordinates
1. Open DevTools (F12)
2. Click "Select Element" (Ctrl+Shift+C)
3. Hover over section in image
4. Check "Styles" panel for position and size

### Debug Section Positioning
1. Inspect `.clickable-section` element
2. Temporarily add background:
   ```css
   background-color: rgba(255, 0, 0, 0.3) !important;
   ```
3. Adjust x, y, width, height values
4. Refresh to see changes

### Check Image Loading
1. Open "Network" tab in DevTools
2. Reload page
3. Filter by "Img"
4. Check load times and sizes

## TypeScript Interfaces

```typescript
interface NewspaperPage {
  id: number;
  thumbnail: string;
  fullImage: string;
  sections: NewsSection[];
}

interface NewsSection {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
}
```

## CSS Classes Reference

### Component Classes
- `.newspaper-container` - Main container
- `.left-panel` - Thumbnail panel
- `.center-panel` - Main display panel
- `.right-panel` - Article panel
- `.thumbnail-item` - Individual thumbnail
- `.thumbnail-item.active` - Selected thumbnail
- `.main-page-image` - Full page image
- `.clickable-section` - Interactive section
- `.section-label` - Section title on hover
- `.article-content` - Article display area

### State Classes
- `.active` - Selected state
- `.open` - Panel open state
- `.selected` - Selected section

## Common HTML Patterns

### Image Tag
```html
<img [src]="imagePath" [alt]="description" />
```

### Conditional Display
```html
<div *ngIf="condition">Content</div>
```

### Loop Through Array
```html
<div *ngFor="let item of items">{{ item.name }}</div>
```

### Click Handler
```html
<button (click)="methodName()">Click Me</button>
```

### Dynamic Classes
```html
<div [class.active]="isActive">Content</div>
```

### Inline Styles
```html
<div [style.width.px]="widthValue">Content</div>
```

## Keyboard Shortcuts

### VS Code
- `Ctrl+P` - Quick file open
- `Ctrl+Shift+F` - Search in all files
- `F12` - Go to definition
- `Alt+Click` - Multi-cursor
- `Ctrl+D` - Select next match

### Browser
- `F12` - Open DevTools
- `Ctrl+Shift+C` - Select element
- `Ctrl+Shift+R` - Hard refresh
- `F5` - Refresh page

## Image Optimization Commands

### Using ImageMagick
```bash
# Resize image
convert input.jpg -resize 800x output.jpg

# Create thumbnail
convert input.jpg -resize 150x200 output-thumb.jpg

# Compress image
convert input.jpg -quality 85 output.jpg

# Convert to WebP
convert input.jpg -quality 85 output.webp
```

### Using FFmpeg
```bash
# Resize
ffmpeg -i input.jpg -vf scale=800:-1 output.jpg

# Compress
ffmpeg -i input.jpg -q:v 3 output.jpg
```

## Deployment Commands

### Netlify
```bash
npm run build
netlify deploy --prod --dir=dist/newspaper-app
```

### Vercel
```bash
npm run build
vercel --prod
```

### Firebase
```bash
npm run build
firebase deploy
```

### GitHub Pages
```bash
ng build --base-href="https://username.github.io/repo/"
npx angular-cli-ghpages --dir=dist/newspaper-app
```

## Performance Tips

### Image Optimization
- JPEG: 70-85% quality for photos
- PNG: Use for graphics with transparency
- WebP: Modern format, better compression
- Target: < 200KB per full image

### Loading Optimization
- Use thumbnails (< 20KB each)
- Implement lazy loading
- Compress all images
- Use CDN for large deployments

### Code Optimization
- Build with production flag
- Enable Ahead-of-Time (AOT) compilation
- Tree shake unused code
- Minify CSS and JavaScript

## Troubleshooting

### Problem: Images don't load
```
✓ Check file paths are correct
✓ Verify files exist in assets folder
✓ Check file extensions match
✓ Clear browser cache
```

### Problem: Sections not clickable
```
✓ Verify imageLoaded is true
✓ Check section coordinates
✓ Inspect z-index values
✓ Check for JavaScript errors
```

### Problem: Mobile layout broken
```
✓ Test responsive breakpoints
✓ Check viewport meta tag
✓ Verify touch events work
✓ Test on actual devices
```

### Problem: Slow performance
```
✓ Optimize images
✓ Check network tab
✓ Reduce DOM elements
✓ Use production build
```

## Best Practices

1. **Always use version control (Git)**
2. **Test on multiple browsers**
3. **Optimize images before adding**
4. **Use meaningful IDs and names**
5. **Comment complex code**
6. **Keep backups of data**
7. **Test responsive design**
8. **Validate HTML structure**

## Resources

- Angular Docs: https://angular.io/docs
- TypeScript: https://www.typescriptlang.org/
- CSS Guide: https://developer.mozilla.org/en-US/docs/Web/CSS
- HTML Reference: https://developer.mozilla.org/en-US/docs/Web/HTML
- Image Optimization: https://squoosh.app/

---

**Quick Help**: If stuck, check README.md and IMPLEMENTATION_GUIDE.md for detailed explanations.
