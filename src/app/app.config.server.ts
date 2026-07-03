import { mergeApplicationConfig, ApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes, RenderMode } from '@angular/ssr';
import type { ServerRoute } from '@angular/ssr';
import { appConfig } from './app.config';

// Server-side routing rules:
//
//   ''         — CLIENT. Angular emits a static index.html app shell at build
//                time — no WordPress API call required, so the build never fails
//                due to Imunify360 cookie requirements or API unavailability.
//                The browser fetches live data on hydration exactly as before.
//                .htaccess serves index.html for root; other routes get index.csr.html.
//
//                WHY not RenderMode.Prerender?
//                Prerendering calls loadNewspaperData() at build time, which hits
//                the WordPress API. The build machine has no Imunify360 session
//                cookie, so the API request fails, prerendering throws, and Angular
//                silently emits prerendered-routes.json = {"routes":{}}.  No
//                index.html is written → Apache 404s on the root URL.
//
//   /admin/**  — client-only (heavy browser APIs: canvas, localStorage, IndexedDB,
//                file upload). The server sends the SPA shell; Angular takes over
//                on the client. Not public-facing so SSR gain is negligible.
//
//   /**        — Server-rendered for date/page/edition routes. On shared hosting
//                (no Node.js server) Apache serves index.csr.html for these routes
//                and Angular bootstraps as CSR. Full SSR activates automatically
//                if the app is ever moved to a Node.js server.
const serverRoutes: ServerRoute[] = [
  { path: '',      renderMode: RenderMode.Client },
  { path: 'admin', renderMode: RenderMode.Client },
  { path: '**',    renderMode: RenderMode.Server },
];

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes)),
  ],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
