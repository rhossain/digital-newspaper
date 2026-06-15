import { mergeApplicationConfig, ApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes, RenderMode } from '@angular/ssr';
import type { ServerRoute } from '@angular/ssr';
import { appConfig } from './app.config';

// Server-side routing rules:
//   /admin/**  — client-only (heavy browser APIs: canvas, localStorage, IndexedDB,
//                file upload). The server sends the SPA shell; Angular takes over
//                on the client. Not public-facing so SSR gain is negligible.
//   /**        — full SSR. Server renders HTML with real newspaper content so
//                users see the page immediately instead of a loading spinner.
const serverRoutes: ServerRoute[] = [
  { path: 'admin', renderMode: RenderMode.Client },
  { path: '**',    renderMode: RenderMode.Server },
];

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes)),
  ],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
