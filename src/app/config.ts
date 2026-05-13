/**
 * Application-wide configuration constants.
 *
 * ⚠️  IMPORTANT: Set WP_BASE_URL to your WordPress site root.
 *     This is the ONLY place you need to set it — every service reads from here.
 *     Example: 'https://your-wordpress-site.com'  (no trailing slash)
 */

import type { ClientPackage, AccessMode } from './models/subscription.models';

/** WordPress site root (no trailing slash). */
export const WP_BASE_URL = 'https://wp.rshossain.me';

/**
 * Client package tier.
 *
 * - 'starter'   — All content is freely accessible; subscription UI is never shown.
 * - 'publisher' — Subscription features are active; access is governed by ACCESS_MODE.
 *
 * Set this to the package purchased by the newspaper client.
 */
export const CLIENT_PACKAGE: ClientPackage = 'publisher';

/**
 * Access control model (only relevant when CLIENT_PACKAGE === 'publisher').
 *
 * - 'today_edition'  — "Today's Edition": Today's first page is free; subscribing
 *                      unlocks all pages of today's newspaper. Past editions (archive)
 *                      are fully locked and not available in this mode.
 * - 'archive_access' — "Full Archive": Today's first page is free; subscribing unlocks
 *                      all pages of today's edition AND all past editions.
 *
 * This value can also be overridden at runtime by the `settings.subscription.accessMode`
 * field served from the WordPress `/data` endpoint, allowing remote configuration changes
 * without a frontend re-deploy.
 */
export const ACCESS_MODE: AccessMode = 'today_edition';
