import { environment } from '../environments/environment';

/**
 * Application-wide configuration constants.
 *
 * WP_BASE_URL is driven by the Angular environment file:
 *  - Development (`npm start`):        environment.ts         → epaper.dailysangram.com/wp
 *  - Production build (default):       environment.prod.ts    → epaper.dailysangram.com/wp
 *  - Staging (`--configuration staging`): environment.staging.ts → nepaper.dailysangram.com/wp
 *
 * PRODUCTION IS epaper. Only the staging configuration points at nepaper.
 * An earlier version of this comment claimed production used nepaper; it never
 * did, and that error sent a live outage investigation down the wrong path.
 * Before shipping a build, confirm which host it targets:
 *   grep -rl "nepaper" dist/digital-newspaper/browser/*.js   # any output = STAGING build
 *
 * To deploy to a different WordPress host, update src/environments/environment.prod.ts.
 * All image URLs returned by the API are normalised server-side to match home_url(),
 * so they always align with wpBaseUrl without any hardcoded domain in Angular code.
 */

/** WordPress site root (no trailing slash). */
export const WP_BASE_URL = environment.wpBaseUrl;