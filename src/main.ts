import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, Routes, UrlSerializer, DefaultUrlSerializer, UrlTree } from '@angular/router';
import { AppComponent } from './app/app.component';
import { NewspaperComponent } from './app/newspaper.component';
import { AdminComponent } from './app/admin/admin.component';

const routes: Routes = [
  { path: '', component: NewspaperComponent },
  { path: 'admin', component: AdminComponent },
  { path: ':date', component: NewspaperComponent },
  { path: ':date/:section', component: NewspaperComponent },
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
    provideHttpClient(),
    provideRouter(routes),
    { provide: UrlSerializer, useClass: TrailingSlashUrlSerializer },
  ]
})
  .catch((err) => console.error(err));
