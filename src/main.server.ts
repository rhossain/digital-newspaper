import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { config } from './app/app.config.server';

/**
 * Server-side bootstrap function.
 *
 * Exported as default so the Angular SSR CommonEngine can import and call it
 * for each incoming request, producing a pre-rendered HTML string.
 */
const bootstrap = () => bootstrapApplication(AppComponent, config);

export default bootstrap;
