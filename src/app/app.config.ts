import { ApplicationConfig, isDevMode } from '@angular/core';
import {
  provideHttpClient,
  withInterceptors,
  withFetch,
} from '@angular/common/http';
import {
  provideRouter,
  withPreloading,
  PreloadAllModules,
  Routes,
  UrlSerializer,
  DefaultUrlSerializer,
  UrlTree,
} from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { provideClientHydration } from '@angular/platform-browser';
import { NewspaperComponent } from './newspaper.component';
import { wpApiInterceptor } from './interceptors/wp-api.interceptor';
import { loaderInterceptor } from './interceptors/loader.interceptor';
import { httpCacheInterceptor } from './interceptors/http-cache.interceptor';

const routes: Routes = [
  { path: '', component: NewspaperComponent },
  {
    path: 'admin',
    loadComponent: () =>
      import('./admin/admin.component').then((m) => m.AdminComponent),
  },
  { path: ':date/:page/:edition', component: NewspaperComponent },
  { path: ':date/:page/:edition/:section', component: NewspaperComponent },
  { path: '**', redirectTo: '' },
];

/**
 * Ensures all URLs end with a trailing slash.
 * e.g. /2026-02-07 → /2026-02-07/
 */
class TrailingSlashUrlSerializer extends DefaultUrlSerializer {
  override serialize(tree: UrlTree): string {
    const path = super.serialize(tree);
    const [base, rest] = path.split('?');
    const trailed = base === '/' ? base : base.replace(/\/?$/, '/');
    return rest !== undefined ? trailed + '?' + rest : trailed;
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    // Hydration: HTTP transfer cache is enabled by default in provideClientHydration().
    // Use withNoHttpTransferCache() here only if you want to opt out.
    provideClientHydration(),

    // HTTP client with fetch (required for SSR — XMLHttpRequest does not exist
    // on Node.js) and the existing interceptor stack.
    provideHttpClient(
      withFetch(),
      withInterceptors([httpCacheInterceptor, wpApiInterceptor, loaderInterceptor]),
    ),

    // PreloadAllModules silently fetches the admin lazy chunk in the background
    // after the viewer loads, so /admin navigation is instant for users who
    // visit the viewer first.
    provideRouter(routes, withPreloading(PreloadAllModules)),

    { provide: UrlSerializer, useClass: TrailingSlashUrlSerializer },

    provideServiceWorker('ngsw-worker.js', {
      // Only register the SW in production — dev mode uses live-reload instead.
      // SwUpdate.isEnabled already returns false on the server, but isDevMode()
      // covers the browser-dev case.
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
