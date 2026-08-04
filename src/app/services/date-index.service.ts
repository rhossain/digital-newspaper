import { Injectable, signal, Signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { tap, map, catchError, timeout } from 'rxjs/operators';
import { WP_BASE_URL } from '../config';
import { DemoService } from './demo.service';

/**
 * Manages the list of available edition dates from `/data/dates`.
 *
 * Why separate?
 * The dates list is a tiny payload (~1 KB for a year of data) that updates
 * at most once per day. Fetching it independently — rather than as part of the
 * full `/data` blob — lets the HTTP cache interceptor apply a 5-minute CDN TTL
 * and lets the viewer know which dates exist before deciding which edition to load.
 *
 * Usage:
 *   inject(DateIndexService).availableDates()    // Signal<string[]>
 *   inject(DateIndexService).latestDate()        // Signal<string>
 *   inject(DateIndexService).fetch()             // trigger network refresh
 */
@Injectable({ providedIn: 'root' })
export class DateIndexService {

  private readonly _endpoint =
    `${WP_BASE_URL}/wp-json/digital-newspaper/v1/data/dates`;

  /**
   * Static snapshot of the same `{ dates, latestDate }` payload, written by the
   * WordPress plugin on every publish and served by Apache with NO PHP. Public
   * readers fetch this first (see `fetch(preferStatic=true)`) and fall back to
   * the authoritative REST endpoint above on any miss/empty/error.
   */
  private readonly _staticUrl =
    `${WP_BASE_URL}/wp-content/dn-static/dates.json`;

  /**
   * localStorage key for the most-recently-published date.
   *
   * Persisting latestDate lets NewspaperDataService initialize
   * currentDateSubject with the correct date before any HTTP request
   * fires — eliminating the visible "today → latestDate" jump on page load
   * for returning visitors when the newspaper hasn't published today yet.
   */
  static readonly LATEST_DATE_CACHE_KEY = 'dn_latest_date';

  // ── State ──────────────────────────────────────────────────────────────────

  private readonly _availableDates = signal<string[]>([]);
  /**
   * Initialized from localStorage so the value is available synchronously
   * at app startup, before fetch() has completed its HTTP request.
   * NewspaperDataService reads this in its constructor to pre-warm
   * currentDateSubject with the correct date.
   */
  private readonly _latestDate = signal<string>(DateIndexService._readLatestDateFromStorage());

  /**
   * Sorted list of dates that have at least one edition, newest-first.
   * Empty array until the first successful `fetch()`.
   */
  readonly availableDates: Signal<string[]> = this._availableDates.asReadonly();

  /**
   * The most-recently published date.
   * Pre-warmed from localStorage on service init; updated to the server
   * value after fetch() completes. Returns '' on the very first ever visit
   * (no localStorage entry yet).
   */
  readonly latestDate: Signal<string> = this._latestDate.asReadonly();

  private readonly demo = inject(DemoService);

  constructor(private readonly http: HttpClient) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Fetch the available dates from the server and update both signals.
   *
   * The HTTP cache interceptor applies a 5-minute TTL with ETag validation,
   * so subsequent calls within the TTL window return a cached Observable
   * without hitting the network.
   *
   * On failure the signals retain their previous values (empty list on first
   * load) and the error is logged — callers should fall back to
   * `NewspaperDataService.getAvailableDates()` for now.
   *
   * @param preferStatic When true (public viewer), try the static snapshot
   *   first and fall back to REST on miss/error. When false (admin editor), go
   *   straight to authoritative REST so the editor's date picker can never lag
   *   the real data.
   * @returns Observable<string[]> — the sorted list of available dates.
   */
  fetch(preferStatic = false): Observable<string[]> {
    // §3.8 — an edited demo session must read live REST (not the golden dates
    // snapshot) so a newly-created date appears in navigation.
    if (this.demo.enabled && this.demo.hasOverrides()) {
      preferStatic = false;
    }
    // Authoritative REST read, with the original "list unchanged" fallback.
    const rest$ = this._get(this._endpoint).pipe(
      catchError(err => {
        console.warn(
          '[DateIndexService] fetch failed — dates list unchanged. Reason:',
          err?.message ?? err
        );
        return of(this._availableDates());
      })
    );

    if (!preferStatic) return rest$;

    // Static-first: a 404 / empty / timeout on the snapshot throws and falls
    // through to the identical REST read above. Same `{ dates, latestDate }` shape.
    return this._get(this._staticUrl).pipe(catchError(() => rest$));
  }

  /**
   * Low-level GET that fetches dates, updates both signals, and persists
   * latestDate. Errors propagate (no catchError here) so `fetch()` can decide
   * whether to fall back from the static snapshot to REST.
   */
  private _get(url: string): Observable<string[]> {
    return this.http
      .get<{ dates: string[]; latestDate: string }>(url)
      .pipe(
        // Per-request timeout: fail fast so a single slow endpoint doesn't
        // exhaust the 20 s granular-chain budget in NewspaperDataService.
        timeout(10000),
        tap(res => {
          const dates = Array.isArray(res.dates) ? [...res.dates].sort().reverse() : [];
          this._availableDates.set(dates);
          const latest = res.latestDate || (dates.length > 0 ? [...dates].sort().reverse()[0] : '');
          if (latest) {
            this._latestDate.set(latest);
            // Persist so the next page load can pre-warm currentDateSubject
            // without waiting for this HTTP request to complete.
            DateIndexService._persistLatestDate(latest);
          }
        }),
        map(res => (Array.isArray(res.dates) ? [...res.dates].sort().reverse() : [])),
      );
  }

  /**
   * Synchronous snapshot of the available dates.
   * Returns an empty array if `fetch()` has not yet completed.
   */
  get(): string[] {
    return this._availableDates();
  }

  /**
   * Update the dates list from an already-loaded NewspaperData object.
   * Called by NewspaperDataService after loadData() succeeds so that
   * DateIndexService stays in sync without an extra network request.
   *
   * IMPORTANT: this UNIONs with the existing list — it never shrinks the
   * available dates.  loadDataFromGranular() only hydrates editions for
   * latestDate + today, so passing those 1-2 dates here used to clobber
   * the full list returned by fetch() — silently hiding every older date
   * from the admin date picker.
   *
   * @param editions  Loaded editions (each has a `date` field).
   */
  syncFromEditions(editions: { date: string }[]): void {
    if (!editions?.length) return;
    const incoming = editions.map(e => e.date).filter(Boolean);
    const merged = [...new Set([...this._availableDates(), ...incoming])]
      .sort()
      .reverse();
    this._availableDates.set(merged);
    // Update latestDate whenever the merged list has a newer date than the
    // currently-cached value (not just when the cache is empty).  This covers
    // the case where a stale inline bootstrap blob was loaded — its editions
    // only span up to the build date, so the cached latestDate can lag behind
    // a freshly-fetched edition list.
    if (merged.length > 0 && merged[0] > (this._latestDate() ?? '')) {
      const latest = merged[0];
      this._latestDate.set(latest);
      DateIndexService._persistLatestDate(latest);
    }
  }

  // ── localStorage helpers (static — called from signal initializer and tap) ──

  /**
   * Read the cached latestDate from localStorage.
   * Returns '' on SSR or if no entry exists yet.
   */
  private static _readLatestDateFromStorage(): string {
    if (typeof localStorage === 'undefined') return ''; // SSR guard
    try {
      return localStorage.getItem(DateIndexService.LATEST_DATE_CACHE_KEY) ?? '';
    } catch {
      return '';
    }
  }

  /**
   * Persist latestDate to localStorage so the next page load can read it
   * synchronously before any HTTP request fires.
   */
  private static _persistLatestDate(date: string): void {
    if (typeof localStorage === 'undefined') return; // SSR guard
    try {
      localStorage.setItem(DateIndexService.LATEST_DATE_CACHE_KEY, date);
    } catch {
      // Quota exceeded or private browsing — silently ignore.
    }
  }
}
