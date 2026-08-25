import { ApplicationConfig, Injectable, isDevMode } from '@angular/core';
import {
  provideHttpClient,
  withInterceptors,
  withFetch,
} from '@angular/common/http';
import {
  provideRouter,
  withPreloading,
  PreloadingStrategy,
  Route,
  Routes,
  UrlSerializer,
  DefaultUrlSerializer,
  UrlTree,
} from '@angular/router';
import { Observable, EMPTY } from 'rxjs';
import { provideServiceWorker } from '@angular/service-worker';
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
 * Only preload the admin lazy chunk for authenticated users.
 *
 * PreloadAllModules would download the ~689 KB admin bundle in the background
 * for every public reader, even though they never visit /admin. This strategy
 * checks for the auth token in localStorage and only preloads when the user
 * is logged in — saving bandwidth for the vast majority of readers.
 */
@Injectable({ providedIn: 'root' })
class AuthAwarePreloadingStrategy implements PreloadingStrategy {
  preload(route: Route, load: () => Observable<unknown>): Observable<unknown> {
    const isAuthenticated =
      typeof localStorage !== 'undefined' &&
      !!localStorage.getItem('dn_wp_token');
    return isAuthenticated && route.path === 'admin' ? load() : EMPTY;
  }
}

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
    // No provideClientHydration(): there is no SSR and no prerender (P2-2), so
    // the app always boots from an empty <app-root> and its HTTP transfer cache
    // — which only ever holds responses captured during a server render — is
    // always empty. The plugin's inline bootstrap state is unaffected; it is
    // read by element id, not through TransferState.
    provideHttpClient(
      withFetch(),
      withInterceptors([httpCacheInterceptor, wpApiInterceptor, loaderInterceptor]),
    ),

    // AuthAwarePreloadingStrategy only preloads the admin lazy chunk when the
    // user has an auth token — public readers don't pay the bandwidth cost.
    provideRouter(routes, withPreloading(AuthAwarePreloadingStrategy)),

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
