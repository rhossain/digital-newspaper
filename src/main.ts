import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, Routes, UrlSerializer, DefaultUrlSerializer, UrlTree } from '@angular/router';
import { AppComponent } from './app/app.component';
import { NewspaperComponent } from './app/newspaper.component';
import { wpApiInterceptor } from './app/interceptors/wp-api.interceptor';
import { loaderInterceptor } from './app/interceptors/loader.interceptor';
import { httpCacheInterceptor } from './app/interceptors/http-cache.interceptor';

const routes: Routes = [
  { path: '', component: NewspaperComponent },
  { path: 'admin', loadComponent: () => import('./app/admin/admin.component').then(m => m.AdminComponent) },
  { path: ':date/:page/:edition', component: NewspaperComponent },
  { path: ':date/:page/:edition/:section', component: NewspaperComponent },
  { path: '**', redirectTo: '' }
];

/** Ensure all URLs end with a trailing slash (e.g. /2026-02-07/ instead of /2026-02-07). */
class TrailingSlashUrlSerializer extends DefaultUrlSerializer {
  override serialize(tree: UrlTree): string {
    const path = super.serialize(tree);
    // Keep bare '/', don't double-slash query/fragment URLs
    const [base, rest] = path.split('?');
    const trailed = base === '/' ? base : base.replace(/\/?$/, '/');
    return rest !== undefined ? trailed + '?' + rest : trailed;
  }
}

bootstrapApplication(AppComponent, {
  providers: [
    // Interceptor execution order (innermost → outermost on response):
    //   1. httpCacheInterceptor  — short-circuits on cache hits before any network
    //   2. wpApiInterceptor      — URL rewrite + credentials + X-Requested-With
    //   3. loaderInterceptor     — shows/hides global loading overlay for writes
    provideHttpClient(withInterceptors([httpCacheInterceptor, wpApiInterceptor, loaderInterceptor])),
    provideRouter(routes),
    { provide: UrlSerializer, useClass: TrailingSlashUrlSerializer },
  ]
})
  .catch((err) => console.error(err));
