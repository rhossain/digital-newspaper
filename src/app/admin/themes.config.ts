/**
 * Admin panel theme configuration
 * =================================
 * Change ADMIN_THEME to switch the look and feel for a specific client.
 * This is a build-time / code-level setting — no runtime UI is exposed.
 *
 * Available themes
 * ----------------
 *  'standard'  Modern blue – default corporate look (current default)
 *  'vintage'   Warm ink-brown / parchment – newspaper heritage feel
 *
 * How it works
 * ------------
 * AdminComponent reads this constant and sets [data-admin-theme] on its root
 * element.  Theme CSS in styles.css then overrides the CSS custom properties
 * scoped to that attribute, so every descendant picks up the new palette
 * automatically without touching component stylesheets.
 *
 * To add a new theme
 * ------------------
 * 1. Add the new name to the AdminTheme union below.
 * 2. Add a `[data-admin-theme="<name>"]` CSS block in styles.css (see the
 *    "Admin Panel Themes" section near the bottom of that file).
 * 3. Set ADMIN_THEME to the new name here.
 */

export type AdminTheme = 'standard' | 'vintage';

export const ADMIN_THEME: AdminTheme = 'standard';
