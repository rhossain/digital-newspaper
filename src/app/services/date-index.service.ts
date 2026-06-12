import { Injectable, signal, Signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { tap, map, catchError } from 'rxjs/operators';
import { WP_BASE_URL } from '../config';

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

  // ── State ──────────────────────────────────────────────────────────────────

  private readonly _availableDates = signal<string[]>([]);
  private readonly _latestDate     = signal<string>('');

  /**
   * Sorted list of dates that have at least one edition, newest-first.
   * Empty array until the first successful `fetch()`.
   */
  readonly availableDates: Signal<string[]> = this._availableDates.asReadonly();

  /**
   * The most-recently published date, or '' until first fetch.
   * Equivalent to `availableDates()[0]` for most use cases, but provided
   * directly from the server to avoid off-by-one errors when the in-memory
   * list is stale.
   */
  readonly latestDate: Signal<string> = this._latestDate.asReadonly();

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
   * @returns Observable<string[]> — the sorted list of available dates.
   */
  fetch(): Observable<string[]> {
    return this.http
      .get<{ dates: string[]; latestDate: string }>(this._endpoint)
      .pipe(
        tap(res => {
          const dates = Array.isArray(res.dates) ? res.dates : [];
          this._availableDates.set(dates);
          if (res.latestDate) {
            this._latestDate.set(res.latestDate);
          } else if (dates.length > 0) {
            // Derive latestDate from the list if the server omitted it
            this._latestDate.set([...dates].sort().reverse()[0]);
          }
        }),
        map(res => (Array.isArray(res.dates) ? res.dates : [])),
        catchError(err => {
          console.warn(
            '[DateIndexService] fetch failed — dates list unchanged. Reason:',
            err?.message ?? err
          );
          return of(this._availableDates());
        })
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
    if (merged.length > 0 && !this._latestDate()) {
      this._latestDate.set(merged[0]);
    }
  }
}
