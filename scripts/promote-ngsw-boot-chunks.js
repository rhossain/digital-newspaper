#!/usr/bin/env node
/**
 * Move the boot-critical esbuild chunks out of the lazy `app-chunks` group in
 * the generated `ngsw.json` and into the prefetched `app-shell` group.
 *
 * Why this exists:
 *   `ngsw-config.json` keeps `/chunk-*.js` in a lazy group so the ~214 KiB
 *   (brotli) admin/editor chunks are not background-downloaded by every reader
 *   on install and on every release. But esbuild also emits SHARED chunks that
 *   `main-*.js` imports statically — the shell `<link rel="modulepreload">`s
 *   them — and a lazy asset group caches NOTHING on a fresh install:
 *   `LazyAssetGroup.initializeFully()` in ngsw-worker.js starts with
 *   `if (updateFrom === undefined) return;`.
 *
 *   Consequence without this script: a reader whose service worker installed on
 *   visit 1 (registration is deferred until the app is stable, so those chunk
 *   requests never pass through the SW) and who then goes offline gets the
 *   cached shell and `main-*.js`, whose static `import "./chunk-XXXX.js"` misses
 *   the cache, fails on the network, and throws SwCriticalError — a white
 *   screen. `updateMode: prefetch` does not save it either: on a new release the
 *   rebuilt chunk has a NEW hashed filename, so it is not in the previous
 *   version's cache and is never pre-fetched.
 *
 * The chunk names are content-hashed, so they cannot be listed statically in
 * `ngsw-config.json`. The shell's modulepreload links are the build's own record
 * of which chunks the initial module graph needs, so they are the source of
 * truth here.
 *
 * Safety: only URLs already present in `ngsw.json` are moved between groups, and
 * `hashTable` is left untouched — the generator hashes every matched file
 * regardless of which group claimed it, so no hash needs recomputing.
 *
 * Must run AFTER `ng build` and BEFORE `scripts/compress-dist.js`, or the
 * `.br`/`.gz` siblings of `ngsw.json` would hold the pre-edit bytes.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const browserDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'dist', 'digital-newspaper', 'browser');

const PREFETCH_GROUP = 'app-shell';
const LAZY_GROUP = 'app-chunks';

function fail(message) {
  // Loud, non-zero exit: shipping a build whose offline boot is broken is worse
  // than failing the build.
  console.error(`[promote-ngsw-boot-chunks] ${message}`);
  process.exit(1);
}

const ngswPath = path.join(browserDir, 'ngsw.json');
if (!fs.existsSync(ngswPath)) {
  // Service worker not enabled for this configuration (e.g. a dev build).
  console.log('[promote-ngsw-boot-chunks] no ngsw.json — nothing to do.');
  process.exit(0);
}

const shellPath = ['index.csr.html', 'index.html']
  .map(name => path.join(browserDir, name))
  .find(candidate => fs.existsSync(candidate));
if (!shellPath) fail(`no index.csr.html or index.html in ${browserDir}`);

const shellHtml = fs.readFileSync(shellPath, 'utf8');

// Every module the initial graph needs: modulepreload links plus the entry
// scripts themselves (the latter are already in app-shell, harmless to include).
const referenced = new Set();
const linkRe = /<link[^>]+rel=["']modulepreload["'][^>]*>/gi;
const hrefRe = /(?:href|src)=["']([^"']+)["']/i;
for (const tag of shellHtml.match(linkRe) ?? []) {
  const href = tag.match(hrefRe)?.[1];
  if (href) referenced.add(href.replace(/^\.?\//, ''));
}

const ngsw = JSON.parse(fs.readFileSync(ngswPath, 'utf8'));
const groups = new Map((ngsw.assetGroups ?? []).map(group => [group.name, group]));
const prefetch = groups.get(PREFETCH_GROUP);
const lazy = groups.get(LAZY_GROUP);

if (!prefetch) fail(`ngsw.json has no "${PREFETCH_GROUP}" asset group`);
if (!lazy) {
  console.log(`[promote-ngsw-boot-chunks] no "${LAZY_GROUP}" group — nothing to do.`);
  process.exit(0);
}

const promote = lazy.urls.filter(url => referenced.has(url.replace(/^\//, '')));

// A build whose shell modulepreloads nothing is possible in principle, but a
// build where the shell references chunks that ngsw.json does not list is not —
// that would mean the boot graph is entirely unavailable offline.
const unlisted = [...referenced].filter(
  ref => /^chunk-/.test(ref) &&
    !lazy.urls.includes(`/${ref}`) &&
    !prefetch.urls.includes(`/${ref}`)
);
if (unlisted.length) fail(`shell references chunks absent from ngsw.json: ${unlisted.join(', ')}`);

if (!promote.length) {
  console.log('[promote-ngsw-boot-chunks] no boot chunks in the lazy group — nothing to do.');
  process.exit(0);
}

lazy.urls = lazy.urls.filter(url => !promote.includes(url));
prefetch.urls = [...prefetch.urls, ...promote].sort();

fs.writeFileSync(ngswPath, JSON.stringify(ngsw, null, 2) + '\n');
console.log(
  `[promote-ngsw-boot-chunks] prefetching ${promote.length} boot chunk(s): ${promote.join(', ')}`
);
console.log(`[promote-ngsw-boot-chunks] left ${lazy.urls.length} chunk(s) lazy: ${lazy.urls.join(', ')}`);
