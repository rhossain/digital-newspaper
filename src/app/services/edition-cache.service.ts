import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { tap, map, catchError } from 'rxjs/operators';
import { NewspaperEdition } from './newspaper-data.service';
import { WP_BASE_URL } from '../config';

/**
 * Per-date edition cache with a three-layer storage hierarchy.
 *
 * Layer 1 — In-memory Map<date, entry>
 *   Fastest. Zero serialisation cost. Lives for the lifetime of the page.
 *   Past dates: never expire (immutable data).
 *   Today's date: 5-minute TTL (may still be updated by the admin).
 *
 * Layer 2 — localStorage (past dates only)
 *   Survives page reloads. Allows offline reading of previously visited dates.
 *   Past dates only — today's data is never written here so stale content
 *   can't linger across sessions.
 *   Key pattern: `dn_edition_YYYY-MM-DD`
 *
 * Layer 3 — HTTP (`/data/editions/:date`)
 *   The HTTP cache interceptor applies its own ETag / TTL rules before the
 *   request reaches the network, so a cache hit at this layer is still
 *   zero-network — just slightly slower than layers 1 and 2 (Map lookup vs
 *   interceptor traversal).
 *
 * Why not use the HTTP cache interceptor alone?
 * The interceptor is in-memory and scoped to the current Angular injector
 * instance. localStorage gives us persistence across reloads for past dates
 * (which the server caches for 24 h but the browser may evict at any time).
 *
 * Cache invalidation (after admin atomic saves):
 *   Call `evict(date)` — removes the memory entry for that date so the next
 *   `getEditionsForDate(date)` call re-fetches. The http-cache interceptor's
 *   `evictEditionCache(date)` is called separately by NewspaperDataService.
 */

interface MemCacheEntry {
  editions:  NewspaperEdition[];
  fetchedAt: number;
  /** Number of pages across all editions — used as a quick sanity check. */
  pageCount: number;
}

@Injectable({ providedIn: 'root' })
export class EditionCacheService {

  private static readonly LS_PREFIX = 'dn_edition_';
  /** Today's edition entries expire after 5 minutes (admin may still be editing). */
  private static readonly TODAY_TTL_MS = 5 * 60 * 1000;

  private readonly _endpoint =
    `${WP_BASE_URL}/wp-json/digital-newspaper/v1/data/editions`;

  private readonly _memCache = new Map<string, MemCacheEntry>();

  constructor(private readonly http: HttpClient) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Get editions for a specific date.
   *
   * Resolution order:
   *   1. Memory (fresh) → return synchronously via `of()`
   *   2. localStorage (past dates, any age) → populate memory, return via `of()`
   *   3. HTTP → populate memory + localStorage (past only), return via Observable
   *
   * @param date  ISO-8601 date string, e.g. '2026-06-07'
   */
  getEditionsForDate(date: string): Observable<NewspaperEdition[]> {
    // ── Layer 1: memory ──────────────────────────────────────────────────────
    const memEntry = this._memCache.get(date);
    if (memEntry && this._isMemFresh(date, memEntry)) {
      return of(memEntry.editions);
    }

    // ── Layer 2: localStorage (past dates only) ──────────────────────────────
    if (this._isPastDate(date)) {
      const lsEditions = this._readFromStorage(date);
      if (lsEditions) {
        this._setMem(date, lsEditions);
        return of(lsEditions);
      }
    }

    // ── Layer 3: HTTP ────────────────────────────────────────────────────────
    return this.http
      .get<{ date: string; editions: NewspaperEdition[]; dataVersion: number }>(
        `${this._endpoint}/${date}`
      )
      .pipe(
        map(res => Array.isArray(res.editions) ? res.editions : []),
        tap(editions => {
          this._setMem(date, editions);
          this._persistToStorage(date, editions);
        }),
        catchError(err => {
          console.warn(
            `[EditionCacheService] Failed to fetch editions for ${date}. Reason:`,
            err?.message ?? err
          );
          // Return whatever stale data we have rather than throwing
          return of(memEntry?.editions ?? []);
        })
      );
  }

  /**
   * Pre-populate the memory cache from editions already loaded by
   * NewspaperDataService.loadData().  Calling this avoids a redundant HTTP
   * request the first time a component asks for a date's editions.
   *
   * @param allEditions  Full list of editions from the NewspaperData response.
   */
  seedFromLoadedData(allEditions: NewspaperEdition[]): void {
    if (!allEditions?.length) return;

    // Group editions by date
    const byDate = new Map<string, NewspaperEdition[]>();
    for (const edition of allEditions) {
      if (!edition.date) continue;
      const existing = byDate.get(edition.date) ?? [];
      byDate.set(edition.date, [...existing, edition]);
    }

    byDate.forEach((editions, date) => {
      // Only seed if not already in cache (don't overwrite a fresh HTTP entry)
      if (!this._memCache.has(date)) {
        this._setMem(date, editions);
        this._persistToStorage(date, editions);
      }
    });
  }

  /**
   * Evict a specific date from the in-memory cache.
   * Called after an atomic page/section save for that date.
   * localStorage is NOT cleared — past dates are immutable; today's date is
   * never written to localStorage so there is nothing to clear there.
   */
  evict(date: string): void {
    this._memCache.delete(date);
  }

  /** Wipe the entire in-memory cache. Does not touch localStorage. */
  clearMemory(): void {
    this._memCache.clear();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _today(): string {
    const d = new Date();
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-');
  }

  private _isPastDate(date: string): boolean {
    return date < this._today();
  }

  private _isMemFresh(date: string, entry: MemCacheEntry): boolean {
    if (this._isPastDate(date)) {
      return true; // Past dates never expire in memory
    }
    return Date.now() - entry.fetchedAt < EditionCacheService.TODAY_TTL_MS;
  }

  private _setMem(date: string, editions: NewspaperEdition[]): void {
    this._memCache.set(date, {
      editions,
      fetchedAt: Date.now(),
      pageCount: editions.reduce((sum, e) => sum + (e.pages?.length ?? 0), 0),
    });
  }

  private _lsKey(date: string): string {
    return EditionCacheService.LS_PREFIX + date;
  }

  private _readFromStorage(date: string): NewspaperEdition[] | null {
    try {
      const raw = localStorage.getItem(this._lsKey(date));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { editions?: NewspaperEdition[] };
      return Array.isArray(parsed.editions) ? parsed.editions : null;
    } catch {
      return null; // corrupt entry — fall through to HTTP
    }
  }

  private _persistToStorage(date: string, editions: NewspaperEdition[]): void {
    // Only persist past dates; today's data must always be re-validated
    if (!this._isPastDate(date)) return;
    if (!editions.length) return;
    try {
      localStorage.setItem(this._lsKey(date), JSON.stringify({ editions }));
    } catch {
      // Quota exceeded — silently skip. Memory cache is still populated.
    }
  }
}
