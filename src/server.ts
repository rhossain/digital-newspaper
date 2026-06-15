import { APP_BASE_HREF } from '@angular/common';
import { CommonEngine } from '@angular/ssr/node';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import bootstrap from './main.server';

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
  server.get('*', (req, res, next) => {
    const { protocol, originalUrl, baseUrl, headers } = req;

    commonEngine
      .render({
        bootstrap,
        documentFilePath: indexHtml,
        url: `${protocol}://${headers.host}${originalUrl}`,
        publicPath: browserDistFolder,
        providers: [{ provide: APP_BASE_HREF, useValue: baseUrl }],
      })
      .then((html) => res.send(html))
      .catch((err) => next(err));
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
