import { environment } from '../environments/environment';

/**
 * Application-wide configuration constants.
 *
 * WP_BASE_URL is now driven by the Angular environment file so that:
 *  - Development (`npm start`):  '/wp' — route requests through the Angular CLI
 *    dev-server proxy configured in proxy.conf.js.
 *  - Production build:  'https://epaper.dailysangram.com/wp' — same origin as
 *    the Angular app, so no CORS either.
 *
 * To deploy to a different WordPress host, update src/environments/environment.prod.ts.
 */

/** WordPress site root (no trailing slash). */
export const WP_BASE_URL = environment.wpBaseUrl;