import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, Routes } from '@angular/router';
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

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(),
    provideRouter(routes)
  ]
})
  .catch((err) => console.error(err));
