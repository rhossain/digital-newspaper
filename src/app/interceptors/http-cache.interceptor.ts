import { HttpInterceptorFn, HttpRequest, HttpResponse, HttpEvent } from '@angular/common/http';
import { Observable, of, tap } from 'rxjs';

/**
 * In-memory HTTP response cache for the Digital Newspaper public read endpoints.
 *
 * Cached endpoints and their TTLs:
 *   /data/settings   — 1 hour   (rarely changes: logo, theme, social links)
 *   /data/dates      — 5 min    (new edition published at most once per day)
 *   /data/editions/* — 24 hours for past dates; 5 min for today
 *   /data/version    — 30 s     (lightweight probe — honour existing poll interval)
 *
 * ETag support:
 *   When the server returns an ETag header, the interceptor stores it and sends
 *   If-None-Match on subsequent requests.  A 304 Not Modified response refreshes
 *   the cached entry's TTL without re-downloading the body.
 *
 * Why in-memory instead of localStorage?
 *   — No serialisation overhead on every hit (critical for large edition payloads).
 *   — No quota limit issues.
 *   — The cache is intentionally cleared on page reload — readers always see a
 *     fresh load after a browser refresh, which matches user expectations.
 *
 * Non-breaking guarantee:
 *   Only the four cacheable paths listed above are intercepted.  All other
 *   requests (auth, admin writes, media, locks, social) pass through unchanged.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  /** The full response object stored for cache hits. */
  response: HttpResponse<unknown>;
  /** Unix timestamp (ms) when this entry was stored or last validated. */
  cachedAt: number;
  /** How long (ms) this entry remains fresh. */
  ttlMs: number;
  /** ETag from the last server response, used for If-None-Match requests. */
  etag?: string;
}

// ─── Configuration ────────────────────────────────────────────────────────────

/** Entries in order of specificity — first match wins. */
const TTL_RULES: Array<{ pattern: RegExp; ttlMs: number }> = [
  // Settings: 1 hour.
  { pattern: /\/data\/settings(\?|$)/, ttlMs: 60 * 60 * 1000 },
  // Available dates: 5 minutes.
  { pattern: /\/data\/dates(\?|$)/, ttlMs: 5 * 60 * 1000 },
  // Edition by date: past dates 24 h, today 5 min — handled dynamically below.
  { pattern: /\/data\/editions\/\d{4}-\d{2}-\d{2}(\?|$)/, ttlMs: -1 /* dynamic */ },
  // Version probe: 30 s (kept short to stay in sync with the poll interval).
  { pattern: /\/data\/version(\?|$)/, ttlMs: 30 * 1000 },
];

/**
 * Returns the TTL (ms) for the given URL, or null if it should not be cached.
 * For edition-by-date URLs, TTL is based on whether the date is in the past.
 */
function resolveTtl(url: string): number | null {
  for (const rule of TTL_RULES) {
    if (rule.pattern.test(url)) {
      if (rule.ttlMs === -1) {
        // Dynamic TTL for /data/editions/:date
        const dateMatch = url.match(/\/data\/editions\/(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) return null;
        const requestDate = dateMatch[1];
        const today = new Date();
        const todayStr = [
          today.getFullYear(),
          String(today.getMonth() + 1).padStart(2, '0'),
          String(today.getDate()).padStart(2, '0'),
        ].join('-');
        // Past dates: 24 hours. Today: 5 minutes.
        return requestDate < todayStr ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000;
      }
      return rule.ttlMs;
    }
  }
  return null;
}

// ─── Cache store (module-level singleton) ─────────────────────────────────────

/**
 * The cache lives at module scope so it is shared across all interceptor
 * invocations within an Angular application instance, and cleared on page reload.
 */
const _cache = new Map<string, CacheEntry>();

/**
 * Dates that need their next HTTP request to bypass the browser's native cache.
 *
 * After an admin save, Angular evicts its own in-memory _cache entry via
 * evictEditionCache(). However, the browser's native HTTP cache (below Angular)
 * may still hold a stale response — it previously had Cache-Control: max-age=86400
 * for past dates, so the browser returns it without ever contacting the server.
 * Marking a date here causes the interceptor to add "Cache-Control: no-cache" to
 * the next outgoing request for that date, which forces the browser to revalidate
 * regardless of the cached max-age. The marker is consumed on first use.
 */
const _bypassBrowserCache = new Set<string>();

/**
 * Mark a specific date's edition URL to bypass the browser's native HTTP cache
 * on the next request. Call this alongside evictEditionCache() after a save so
 * users with old max-age=86400 cached responses still get fresh data immediately.
 */
export function markForBrowserCacheBypass(date: string): void {
  _bypassBrowserCache.add(date);
}

/**
 * Clear all entries — call this after an admin save so stale responses
 * are not served to the same user in the same session.
 */
export function clearHttpCache(): void {
  _cache.clear();
}

/**
 * Evict only the entries for a specific date's edition.
 * Called after an atomic page/section save to keep the cache consistent.
 */
export function evictEditionCache(date: string): void {
  for (const key of Array.from(_cache.keys())) {
    if (key.includes(`/data/editions/${date}`)) {
      _cache.delete(key);
    }
  }
  // Also evict /data/dates since the available-dates list may have changed.
  for (const key of Array.from(_cache.keys())) {
    if (key.includes('/data/dates')) {
      _cache.delete(key);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalise the cache key: strip the _t= cache-buster that the legacy
 * loadData() call appends, so different calls to the same endpoint share
 * a single cache slot.
 */
function toCacheKey(url: string): string {
  return url.replace(/([?&])_t=\d+(&|$)/, (_, prefix, suffix) =>
    suffix ? prefix : ''
  );
}

function isExpired(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt > entry.ttlMs;
}

// ─── Interceptor ─────────────────────────────────────────────────────────────

export const httpCacheInterceptor: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: (req: HttpRequest<unknown>) => Observable<HttpEvent<unknown>>
): Observable<HttpEvent<unknown>> => {
  // Only cache GET requests; never intercept write operations.
  if (req.method !== 'GET') {
    return next(req);
  }

  const ttlMs = resolveTtl(req.url);
  if (ttlMs === null) {
    // URL not in the cacheable list — pass through without touching.
    return next(req);
  }

  const cacheKey = toCacheKey(req.url);
  const cached = _cache.get(cacheKey);

  // ── Cache hit (fresh) ────────────────────────────────────────────────────
  if (cached && !isExpired(cached)) {
    return of(cached.response.clone());
  }

  // ── Conditional GET (stale or missing — try ETag validation) ────────────
  let outReq = req;
  if (cached?.etag) {
    // Add If-None-Match so the server can return 304 instead of a full response.
    outReq = req.clone({ setHeaders: { 'If-None-Match': cached.etag } });
  }

  // ── Browser-cache bypass (post-save eviction) ─────────────────────────────
  // After a save, evictEditionCache() clears our _cache Map but cannot clear
  // the browser's native HTTP cache.  If the browser previously stored this
  // response with max-age=86400 it will return the stale copy at the network
  // layer without consulting the server.  Adding Cache-Control: no-cache in
  // the REQUEST header overrides that and forces the browser to revalidate.
  // The marker is set by markForBrowserCacheBypass() and consumed here once.
  const dateMatch = req.url.match(/\/data\/editions\/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch && _bypassBrowserCache.has(dateMatch[1])) {
    _bypassBrowserCache.delete(dateMatch[1]);
    outReq = outReq.clone({ setHeaders: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } });
  }

  return (next(outReq) as Observable<HttpEvent<unknown>>).pipe(
    tap((event: HttpEvent<unknown>) => {
      if (!(event instanceof HttpResponse)) return;

      const resolvedTtl = resolveTtl(req.url) ?? 0;

      if (event.status === 200) {
        // Store fresh response with its ETag (if provided).
        _cache.set(cacheKey, {
          response: event as HttpResponse<unknown>,
          cachedAt: Date.now(),
          ttlMs: resolvedTtl,
          etag: (event as HttpResponse<unknown>).headers.get('ETag') ?? undefined,
        });
      } else if (event.status === 304 && cached) {
        // 304 Not Modified — server confirmed the cached copy is still current.
        // Refresh the TTL so we don't hit the server again for another cycle.
        _cache.set(cacheKey, { ...cached, cachedAt: Date.now() });
      }
    })
  );
};
