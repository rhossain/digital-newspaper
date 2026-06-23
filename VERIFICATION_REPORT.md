# Verification Report — Session Changes

What was verified automatically here, and what you should confirm live after
deploying. No unit tests exist in the repo, so verification is: full production
build (AOT template type-check, budgets, SSR/prerender), compression integrity
check, and a full diff/data-loss review.

## Automated results (all passing)

- **Production build** (`ng build`, default config): ✅ "Application bundle
  generation complete", no errors, no budget violations. Initial bundle 592 KB
  raw / 146 KB transfer. Admin stays lazy-loaded. Prerender did 0 routes only
  because the WP API isn't reachable from the build sandbox (expected).
- **Compression integrity**: ✅ `compress-dist.js` produced `.br`/`.gz` for 10
  assets (~1.2 MB saved); every Brotli file decompresses byte-identical to its
  source. Serve-rules + SW no-cache `.br/.gz` match present in the shipped
  `dist/browser/.htaccess`.
- **Lock service / admin / viewer / data-service**: ✅ all compile under
  production AOT (template type-checking included).

## Change-by-change risk + what to check live

| Area | Change | Data-loss risk | Live check |
|---|---|---|---|
| Viewer image | `<picture>` wrapper + intrinsic `width/height`; falls back to original `<img src=fullImage>` when no variants | None (render-only) | Page image renders; **section click hot-zones still align**; zoom/print/download use full-res |
| Plugin PHP | `dn_attach_page_dimensions()` injects `imageVariants.{w,h}` at `/data/editions/:date` | None — writes **only transients**, never options/post_meta | Network tab: editions response has `imageVariants`; Lighthouse CLS ↓ |
| Static compression | `deploy.js` + `scripts/compress-dist.js` + `src/.htaccess` | None — originals kept; `-f` guard falls back | `curl -I -H "Accept-Encoding: br,gzip" …/main-*.js` → `content-encoding: br` |
| Admin preview | Cache-busted preview src; stored URL stays clean | None | Upload→Cancel→re-upload shows the **new** image |
| Admin uploads | Unique per-upload filenames; session media tracked, orphans deleted on cancel/save | Low — deletes **only** this-session uploads, keeps saved refs; pre-existing media never touched | Add page, replace image, Save → only final image kept; Cancel → uploads removed |
| Section crop | Title-guarded `saveSection`; removed redundant `saveAllData` | None — atomic save still persists | Crop before/after title: no "Missing required fields"; no spurious 409 |
| Lock heartbeat | Retry transient resets ×2; 404/force-release unchanged | None | Edit a page; heartbeat survives a blip; admin force-release still ejects editor |

## Data-loss assessment: clear

- No change writes destructively to `dn_data`, per-date options, or post_meta.
- Stored image URLs remain clean (cache-buster is preview-only) — so the crop
  tool, public viewer, proxy, and the new `getimagesize` all keep resolving.
- Media deletion is bounded to current-session uploads not referenced by the
  saved page; pre-existing images are never auto-deleted.

## Manual smoke test (recommended, ~5 min on staging)

1. Public viewer: open today + navigate dates, switch edition/page, click a
   section, open linked sections, zoom modal, print, download, share.
2. Admin: add a page (upload, cancel, re-add, save); add a section (crop image
   before and after typing a title); edit an existing page; force-release a lock
   from the lock panel.
3. Save All once and confirm no unexpected conflict modal.

## Deploy reminders

- Build with `npm run build` (not bare `ng build`) so `.br/.gz` are generated.
- Upload `dist/digital-newspaper/browser` (includes the updated `.htaccess`).
- Re-zip / re-deploy the plugin folder so the `digital-newspaper.php` changes
  ship (the tracked `.zip` is not auto-rebuilt).
