import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, Routes } from '@angular/router';
import { HTTP_INTERCEPTORS } from '@angular/common/http';
import { AppComponent } from './app/app.component';
import { NewspaperComponent } from './app/newspaper.component';
import { AdminComponent } from './app/admin/admin.component';
import { HttpCacheInterceptor } from './app/services/http-cache.interceptor';
import { CacheService } from './app/services/cache.service';
import { ImageCacheService } from './app/services/image-cache.service';
import { CacheManagerService } from './app/services/cache-manager.service';

const routes: Routes = [
  { path: '', component: NewspaperComponent },
  { path: 'admin', component: AdminComponent },
  { path: ':date', component: NewspaperComponent },
  { path: ':date/:section', component: NewspaperComponent },
  { path: '**', redirectTo: '' }
];

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(),
    provideRouter(routes),
    CacheService,
    ImageCacheService,
    CacheManagerService,
    {
      provide: HTTP_INTERCEPTORS,
      useClass: HttpCacheInterceptor,
      multi: true
    }
  ]
})
  .catch((err) => console.error(err));
