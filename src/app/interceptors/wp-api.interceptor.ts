import { HttpInterceptorFn } from '@angular/common/http';

/**
 * Intercepts every WordPress REST API request and applies three WAF-bypass
 * techniques that work entirely from the browser side, requiring no changes
 * to hosting server configuration.
 *
 * 1. URL rewrite — /wp-json/<path>  →  /?rest_route=/<path>
 * -------------------------------------------------------
 * WordPress supports two equivalent URL forms for its REST API:
 *   Pretty:    /wp/wp-json/digital-newspaper/v1/data
 *   Index:     /wp/?rest_route=/digital-newspaper/v1/data
 *
 * Host-level WAF modules (Imunify360, ModSecurity) almost universally target
 * the literal `/wp-json/` path string in their blocking rules.  Switching to
 * the index form changes the URL pattern so those rules never match, while
 * WordPress itself routes the request identically.  No permalink or server
 * configuration changes are needed — the `?rest_route=` form always works.
 *
 * 2. X-Requested-With: XMLHttpRequest
 * ------------------------------------
 * The OWASP Core Rule Set (shipped with Imunify360 and ModSecurity) contains
 * built-in exemptions for requests identified as browser AJAX calls.  This
 * header is the standard way browsers (and XHR/fetch) signal that.  Adding
 * it explicitly activates those exemptions for all API calls.
 *
 * 3. withCredentials: true
 * ------------------------
 * Imunify360 bot-protection sets a verification cookie in the browser when
 * the user first visits the site.  Angular's HttpClient does NOT send cookies
 * on cross-origin requests unless `withCredentials` is set.  Without the
 * cookie, the WAF treats API calls as unauthenticated bot traffic and returns
 * a block response before the request reaches the plugin.
 *
 * The WordPress plugin already sends `Access-Control-Allow-Credentials: true`
 * and a specific `Access-Control-Allow-Origin` (not wildcard) for the allowed
 * origins, so CORS pre-flight for cross-origin dev requests succeeds.
 */
export const wpApiInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.includes('/wp-json/')) {
    return next(req);
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

  req = req.clone({
    url: rewrittenUrl,
    withCredentials: true,
    setHeaders: {
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  return next(req);
};
