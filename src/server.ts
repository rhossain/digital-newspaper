import { APP_BASE_HREF } from '@angular/common';
import { CommonEngine } from '@angular/ssr/node';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import bootstrap from './main.server';

/**
 * How long (ms) the SSR render may run before we give up and return the CSR
 * shell instead.  Must be well under Nginx's proxy_read_timeout (typically
 * 60 s) so the browser never sees a 504 — it always gets a fast HTML response
 * and Angular hydrates / bootstraps on the client side.
 */
const SSR_TIMEOUT_MS = 8_000;

/**
 * Creates and configures the Express application.
 *
 * Static files are served from the `browser/` output folder with aggressive
 * cache headers (1 year).  All other requests are passed to Angular's
 * CommonEngine which runs the SSR render and returns pre-rendered HTML.
 */
export function app(): express.Express {
  const server = express();
  const serverDistFolder = dirname(fileURLToPath(import.meta.url));
  // Output structure: dist/digital-newspaper/{browser,server}/
  const browserDistFolder = resolve(serverDistFolder, '../browser');
  const indexHtml = join(serverDistFolder, 'index.server.html');

  const commonEngine = new CommonEngine();

  // CSR shell — served as an instant fallback when SSR times out or errors.
  // Read once at startup; the file is static between deployments.
  // Graceful degradation: if index.csr.html is missing (unusual build failure),
  // fall back to a minimal HTML shell so the server doesn't crash on startup.
  const csrShellPath = join(browserDistFolder, 'index.csr.html');
  const csrShell = existsSync(csrShellPath)
    ? readFileSync(csrShellPath, 'utf-8')
    : '<!doctype html><html><head><base href="/"></head><body><app-root></app-root></body></html>';

  server.set('view engine', 'html');
  server.set('views', browserDistFolder);

  // ── Static assets (JS, CSS, images, fonts) ─────────────────────────────────
  // Serve with a 1-year immutable cache — output-hashing in the Angular build
  // gives each file a unique hash, so stale-while-revalidate is not a concern.
  // `index: false` prevents Express from serving index.html for directories;
  // Angular handles all HTML responses below.
  server.get('*', express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
  }));

  // ── Angular SSR ─────────────────────────────────────────────────────────────
  // Routes not matched by the static middleware reach here.  The Angular
  // CommonEngine renders the route server-side and returns the full HTML string.
  // Admin routes are configured as RenderMode.Client in app.config.server.ts,
  // so they receive the app shell (index.html) without a full SSR render.
  //
  // The render is guarded by SSR_TIMEOUT_MS.  If the WordPress API is slow or
  // unavailable the SSR render would otherwise hang until Nginx's
  // proxy_read_timeout fires — returning a 504 to the browser.  Instead we
  // race the render against a timer: whichever resolves first wins.  On
  // timeout or error the CSR shell is sent so the browser always gets a fast
  // 200 and Angular boots on the client.
  server.get('*', (req, res, next) => {
    const { protocol, originalUrl, baseUrl, headers } = req;

    let settled = false;

    const fallbackTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[SSR] Render timeout for ${originalUrl} — serving CSR shell`);
      res.set('X-SSR-Fallback', 'timeout').send(csrShell);
    }, SSR_TIMEOUT_MS);

    commonEngine
      .render({
        bootstrap,
        documentFilePath: indexHtml,
        url: `${protocol}://${headers.host}${originalUrl}`,
        publicPath: browserDistFolder,
        providers: [{ provide: APP_BASE_HREF, useValue: baseUrl }],
      })
      .then((html) => {
        clearTimeout(fallbackTimer);
        if (settled) return; // timeout already fired — do not double-send
        settled = true;
        res.send(html);
      })
      .catch((err) => {
        clearTimeout(fallbackTimer);
        if (settled) return;
        settled = true;
        console.error(`[SSR] Render error for ${originalUrl} — serving CSR shell:`, err);
        res.set('X-SSR-Fallback', 'error').send(csrShell);
      });
  });

  return server;
}

function run(): void {
  const port = process.env['PORT'] || 4000;
  const server = app();
  server.listen(port, () => {
    console.log(
      `Digital Newspaper SSR server listening on http://localhost:${port}`,
    );
  });
}

run();
