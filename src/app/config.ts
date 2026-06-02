import { environment } from '../environments/environment';

/**
 * Application-wide configuration constants.
 *
 * WP_BASE_URL is driven by the Angular environment file:
 *  - Development (`npm start`):  'https://epaper.dailysangram.com/wp' — direct
 *    browser requests, no Node proxy.  Browser requests include host-security
 *    cookies automatically; the Node proxy path did not and was blocked by WAF.
 *  - Production build:  'https://epaper.dailysangram.com/wp' — same origin as
 *    the Angular app, no CORS overhead.
 *
 * To deploy to a different WordPress host, update src/environments/environment.prod.ts.
 */

/** WordPress site root (no trailing slash). */
export const WP_BASE_URL = environment.wpBaseUrl;