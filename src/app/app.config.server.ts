import { mergeApplicationConfig, ApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes, RenderMode } from '@angular/ssr';
import type { ServerRoute } from '@angular/ssr';
import { appConfig } from './app.config';

// Server-side routing rules:
//
//   ''         — PRERENDER. At `ng build` time, Node.js renders the homepage
//                with real WordPress data and writes a static index.html.
//                Apache serves this immediately — user sees full newspaper content
//                without waiting for JS to load or API calls to complete.
//                HTTP Transfer Cache (provideClientHydration) stores the API
//                responses in the HTML so Angular hydrates with the same data
//                (no duplicate requests, no content flash).
//                Version polling (startVersionPoll) detects new editions after
//                hydration and refreshes — content is always current after ~30 s.
//
//                WORKFLOW: rebuild + redeploy whenever a new edition is published
//                so the prerendered HTML reflects the current edition at deploy time.
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
  { path: '',      renderMode: RenderMode.Prerender },
  { path: 'admin', renderMode: RenderMode.Client },
  { path: '**',    renderMode: RenderMode.Server },
];

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes)),
  ],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
