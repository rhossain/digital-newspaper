import { environment } from '../environments/environment';

/**
 * Application-wide configuration constants.
 *
 * WP_BASE_URL is driven by the Angular environment file:
 *  - Development (`npm start`):  environment.ts → wpBaseUrl (currently epaper.dailysangram.com/wp)
 *  - Production build:           environment.prod.ts → wpBaseUrl (currently nepaper.dailysangram.com/wp)
 *
 * To deploy to a different WordPress host, update src/environments/environment.prod.ts.
 * All image URLs returned by the API are normalised server-side to match home_url(),
 * so they always align with wpBaseUrl without any hardcoded domain in Angular code.
 */

/** WordPress site root (no trailing slash). */
export const WP_BASE_URL = environment.wpBaseUrl;