import { HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { finalize } from 'rxjs/operators';
import { LoaderService } from '../services/loader.service';
import { WP_BASE_URL } from '../config';

/**
 * HTTP interceptor that automatically shows and hides the global loading overlay
 * for every authenticated write request to the WordPress REST API.
 *
 * Rules:
 *  - GET requests are NOT intercepted — background reads (e.g. polling locks)
 *    should not freeze the UI.
 *  - Public GET /data?_t=… (page load) is also excluded for the same reason.
 *  - Only requests to WP_BASE_URL are intercepted; assets, fonts, etc. are skipped.
 *  - The message is derived from the URL path so users see a clear status.
 */
export const loaderInterceptor: HttpInterceptorFn = (req, next) => {
  // Only intercept write requests to our own WordPress API
  if (req.method === 'GET') return next(req);
  if (!req.url.includes(WP_BASE_URL) && !req.url.includes('/?rest_route=')) return next(req);
  // Skip ALL lock operations — they are silent background checks and must never
  // set loader.isSaving = true, which would block autoSaveForVintage().
  if (req.url.includes('/locks/') || req.url.includes('/locks?')) return next(req);
  // Section atomic saves are fire-and-forget; skip the overlay to avoid flicker
  // on rapid section switches in the crop editor.
  if (req.url.includes('/data/section')) return next(req);
  // Activity log writes (silent, fire-and-forget)
  if (req.url.includes('/activity-log/batch')) return next(req);

  const loader = inject(LoaderService);
  const message = resolveMessage(req);
  loader.show(message);

  return next(req).pipe(
    finalize(() => loader.hide())
  );
};

function resolveMessage(req: HttpRequest<unknown>): string {
  const url = req.url;

  if (url.includes('/auth/login'))          return 'Signing in…';
  if (url.includes('/data/restore'))        return 'Restoring backup…';
  if (url.includes('/data/rebuild'))        return 'Rebuilding data…';
  if (url.includes('/warm-cache'))          return 'Warming cache…';
  if (url.includes('/media') && req.method === 'POST')   return 'Uploading image…';
  if (url.includes('/media') && req.method === 'DELETE') return 'Removing image…';
  if (url.includes('/data/page') && req.method === 'PUT')    return 'Saving page…';
  if (url.includes('/data/page') && req.method === 'DELETE') return 'Deleting page…';
  if (url.includes('/activity-log') && req.method === 'DELETE') return 'Clearing log…';
  if (url.includes('/data') && req.method === 'POST')    return 'Saving data…';

  return 'Please wait…';
}
