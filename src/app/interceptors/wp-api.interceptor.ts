import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { DemoService } from '../services/demo.service';

/**
 * Intercepts every WordPress REST API request and applies WAF-bypass
 * techniques that work entirely from the browser side.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 1. URL rewrite  /wp-json/<path>  →  /?rest_route=/<path>
 * ──────────────────────────────────────────────────────────────────────────────
 * WordPress supports two equivalent URL forms for its REST API:
 *   Pretty:   /wp/wp-json/digital-newspaper/v1/data
 *   Index:    /wp/?rest_route=/digital-newspaper/v1/data
 *
 * Host-level WAF modules (Imunify360, ModSecurity) target the literal
 * `/wp-json/` path string.  The index form bypasses those rules while
 * WordPress routes the request identically.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 2. X-Requested-With: XMLHttpRequest
 * ──────────────────────────────────────────────────────────────────────────────
 * The OWASP Core Rule Set ships built-in exemptions for AJAX requests.
 * This header activates those exemptions for all API calls.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 3. withCredentials (conditional — see below)
 * ──────────────────────────────────────────────────────────────────────────────
 * Imunify360 bot-protection sets a verification cookie on first site visit.
 * withCredentials: true ensures that cookie is sent so WAF does not classify
 * API calls as bot traffic.
 *
 * IMPORTANT — public read-only endpoints:
 *   The new cacheable endpoints (/data/settings, /data/dates, /data/editions/:date,
 *   /data/version) do NOT send credentials.  CDNs and proxies refuse to cache
 *   responses to credentialed requests (CORS spec), so setting withCredentials on
 *   these endpoints would permanently prevent caching.  These endpoints are fully
 *   public and do not require the bot-protection cookie.
 *
 * The WordPress plugin sends `Access-Control-Allow-Credentials: true` and a
 * specific `Access-Control-Allow-Origin` (not wildcard) for authenticated paths,
 * so CORS pre-flight succeeds for cross-origin dev requests.
 */

/**
 * Paths that are public, read-only, and should be CDN-cacheable.
 * Requests to these endpoints do NOT send cookies (withCredentials = false).
 * This allows CDN/LiteSpeed/browser to cache the responses.
 */
const PUBLIC_READ_PATHS = [
  '/data/settings',
  '/data/dates',
  '/data/editions/',
  '/data/version',
  '/ads/config',
] as const;

function isPublicReadEndpoint(url: string, method: string): boolean {
  // Only treat as public/no-credentials for GET requests.
  // PATCH/POST/PUT/DELETE to the same paths (e.g. PATCH /data/settings)
  // require authentication and must send credentials.
  if (method !== 'GET') return false;
  return PUBLIC_READ_PATHS.some(path => url.includes(path));
}

export const wpApiInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.includes('/wp-json/')) {
    return next(req);
  }

  // ── Demo / Showcase Mode (§3.3, §3.8) ──────────────────────────────────────
  // Attach the per-tab session token so every edit lands in the private,
  // ephemeral server-side overlay. Gated so a clean (un-edited) session sends
  // NO header on public read endpoints, keeping them CDN-shareable exactly as in
  // production. Entirely inert on non-demo builds (demoService.enabled === false).
  let demoHeaders: Record<string, string> | undefined;
  const demo = inject(DemoService);
  if (demo.enabled) {
    const publicRead = isPublicReadEndpoint(req.url, req.method);
    // Any mutating call marks the session as "has overrides" so subsequent
    // reads reconcile against the session copy (stale-while-revalidate).
    if (req.method !== 'GET') {
      demo.markOverride();
    }
    if (demo.shouldAttachHeader(req.url, req.method, publicRead)) {
      demoHeaders = { 'X-DN-Demo-Session': demo.getToken() };
    }
  }

  // Split off any existing query string before rewriting so we don't end up
  // with two '?' characters in the final URL.
  // e.g. /wp/wp-json/digital-newspaper/v1/data?_t=123
  //   →  /wp/?rest_route=/digital-newspaper/v1/data&_t=123
  const qIndex = req.url.indexOf('?');
  const urlPath = qIndex !== -1 ? req.url.substring(0, qIndex) : req.url;
  const queryString = qIndex !== -1 ? req.url.substring(qIndex + 1) : '';

  const rewrittenBase = urlPath.replace('/wp-json/', '/?rest_route=/');
  const rewrittenUrl = queryString ? `${rewrittenBase}&${queryString}` : rewrittenBase;

  // Always send credentials so the Imunify360 verification cookie is included.
  // The original logic skipped credentials on public GET endpoints to allow CDN
  // caching, but Imunify360 on this shared host blocks any request that arrives
  // without its cookie — so all calls must send credentials.
  // If a CDN is added in future, revisit: CDNs cannot cache credentialed responses.
  const sendCredentials = true;

  req = req.clone({
    url: rewrittenUrl,
    withCredentials: sendCredentials,
    setHeaders: {
      'X-Requested-With': 'XMLHttpRequest',
      ...(demoHeaders ?? {}),
    },
  });

  return next(req);
};
