#!/usr/bin/env node
/**
 * Pre-compress the built Angular browser bundle into Brotli (.br) and Gzip (.gz)
 * siblings, so a static host that does NOT compress JS/CSS/JSON on the fly
 * (e.g. LiteSpeed on shared cPanel) can still serve small payloads.
 *
 * Why this exists:
 *   On this host, `.htaccess` `mod_deflate` / `mod_brotli` AddOutputFilterByType
 *   directives are ignored for static files, so the bundle ships uncompressed
 *   (~164 KB main.js). Instead, we ship the already-compressed bytes and let
 *   `src/.htaccess` serve them by content negotiation (see the
 *   "Serve pre-compressed static assets" block there).
 *
 * Design notes:
 *   - Uses Node's BUILT-IN `zlib` only — no dependency, no runtime service.
 *   - Purely additive: the original uncompressed file is always kept. If a
 *     `.br`/`.gz` is missing, the `.htaccess` `-f` guard serves the plain file.
 *   - Idempotent: re-running overwrites siblings with identical output.
 *   - Best-effort per file: a failure on one file never aborts the build.
 *
 * Usage:
 *   node scripts/compress-dist.js            # default: dist/digital-newspaper/browser
 *   node scripts/compress-dist.js <dir>      # compress a specific directory
 *
 * Wired into package.json `build` / `build:staging` so a normal
 * `npm run build` produces the compressed siblings automatically.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Extensions worth compressing. Images (png/jpg/webp/avif) and fonts (woff2)
// are already compressed and are intentionally excluded. This set is kept in
// lock-step with the rewrite/header rules in src/.htaccess — only files those
// rules can serve are compressed, so no orphan .br/.gz are produced.
const COMPRESSIBLE_EXT = new Set(['.js', '.mjs', '.css', '.json', '.svg', '.webmanifest']);

// Files below this size don't benefit enough to justify the extra request shape.
const MIN_BYTES = 1024;

const targetDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'dist', 'digital-newspaper', 'browser');

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function compressFile(full) {
  const buf = fs.readFileSync(full);
  if (buf.length < MIN_BYTES) return { skipped: true };

  const result = { saved: 0 };

  // Brotli (best ratio for text; quality 11 is fine at build time).
  const br = zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
  if (br.length < buf.length) {
    fs.writeFileSync(full + '.br', br);
    result.saved = buf.length - br.length;
  }

  // Gzip fallback for the rare client without Brotli support.
  const gz = zlib.gzipSync(buf, { level: 9 });
  if (gz.length < buf.length) {
    fs.writeFileSync(full + '.gz', gz);
  }

  return result;
}

function main() {
  if (!fs.existsSync(targetDir)) {
    console.error(`[compress-dist] Target directory not found: ${targetDir}`);
    console.error('[compress-dist] Build first (e.g. `ng build`), or pass the browser dir as an argument.');
    process.exit(1);
  }

  let count = 0;
  let totalSaved = 0;

  for (const full of walk(targetDir)) {
    if (full.endsWith('.br') || full.endsWith('.gz')) continue;
    if (!COMPRESSIBLE_EXT.has(path.extname(full).toLowerCase())) continue;
    try {
      const r = compressFile(full);
      if (r && !r.skipped) {
        count++;
        totalSaved += r.saved || 0;
      }
    } catch (err) {
      // Best-effort: keep the original, skip this file.
      console.warn(`[compress-dist] Skipped ${path.relative(targetDir, full)}: ${err.message}`);
    }
  }

  console.log(`[compress-dist] Compressed ${count} asset(s) in ${path.relative(process.cwd(), targetDir) || targetDir}`);
  console.log(`[compress-dist] Brotli saved ~${(totalSaved / 1024).toFixed(0)} KB across those files.`);
}

main();
