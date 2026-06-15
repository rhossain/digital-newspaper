import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Observable, of, from } from 'rxjs';
import { tap, map, catchError, switchMap } from 'rxjs/operators';
import { NewspaperEdition } from './newspaper-data.service';
import { WP_BASE_URL } from '../config';
import { IdbCacheService } from './idb-cache.service';

/**
 * Per-date edition cache with a four-layer storage hierarchy.
 *
 * Layer 1 — In-memory Map<date, entry>                        (sync, fastest)
 *   Lives for the page lifetime. Past dates never expire; today: 5-min TTL.
 *
 * Layer 2a — localStorage key `dn_edition_YYYY-MM-DD`         (sync, ~5-10 MB quota)
 *   Survives page reloads. Checked synchronously so the first render is instant.
 *   Past dates only — today's data is never written here.
 *
 * Layer 2b — IndexedDB store `dn-edition-cache` via IdbCacheService (async, ~GB quota)
 *   Fallback when localStorage quota is exhausted. A year of edition data
 *   (~18 MB) fits here with room to spare.
 *   Past dates only — same policy as localStorage.
 *
 * Layer 3 — HTTP GET `/data/editions/:date`                   (async, network)
 *   The HTTP cache interceptor may short-circuit before the network if its
 *   in-memory ETag / TTL entry is still fresh.
 *
 * Cache invalidation:
 *   `evict(date)`   — removes memory entry for that date (layer 1 only;
 *                     past dates in 2a/2b are immutable — no need to clear).
 *   `clearMemory()` — wipes layer 1 + schedules async clear of layer 2b.
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

  private readonly platformId = inject(PLATFORM_ID);
  private get isBrowser(): boolean { return isPlatformBrowser(this.platformId); }

  constructor(
    private readonly http: HttpClient,
    private readonly idbCache: IdbCacheService,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Get editions for a specific date.
   *
   * Resolution order:
   *   1. Memory (fresh, sync)
   *   2a. localStorage (past dates only, sync)
   *   2b. IndexedDB (past dates only, async — larger quota than localStorage)
   *   3. HTTP (network, async)
   *
   * @param date  ISO-8601 date string, e.g. '2026-06-07'
   */
  getEditionsForDate(date: string): Observable<NewspaperEdition[]> {
    // ── Layer 1: memory ──────────────────────────────────────────────────────
    const memEntry = this._memCache.get(date);
    if (memEntry && this._isMemFresh(date, memEntry)) {
      return of(memEntry.editions);
    }

    // ── Layer 2a: localStorage (past dates only, synchronous) ────────────────
    if (this._isPastDate(date)) {
      const lsEditions = this._readFromStorage(date);
      if (lsEditions) {
        this._setMem(date, lsEditions);
        return of(lsEditions);
      }
    }

    // ── Layer 2b: IndexedDB (past dates only, async) ─────────────────────────
    // Only consulted when localStorage misses (e.g. quota exceeded or cleared).
    if (this._isPastDate(date)) {
      return from(this.idbCache.get(date)).pipe(
        switchMap(idbEditions => {
          if (idbEditions && idbEditions.length > 0) {
            this._setMem(date, idbEditions);
            // Write-back to localStorage so future reads are synchronous again.
            this._persistToLocalStorage(date, idbEditions);
            return of(idbEditions);
          }
          // ── Layer 3: HTTP (IDB miss) ──────────────────────────────────────
          return this._fetchFromHttp(date, memEntry);
        }),
        catchError(() => this._fetchFromHttp(date, memEntry))
      );
    }

    // ── Layer 3: HTTP (today / future, skip persistence layers) ─────────────
    return this._fetchFromHttp(date, memEntry);
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
        this._persistAll(date, editions);
      }
    });
  }

  /**
   * Evict a specific date from ALL cache layers (memory + localStorage + IDB).
   *
   * Called after an atomic page/section save for that date so the next read
   * re-fetches from the network.
   *
   * CRITICAL DATA-SYNC FIX:
   *   The previous implementation cleared only the in-memory map, on the
   *   assumption that past dates are "immutable".  That assumption is FALSE
   *   in this app: admins routinely edit past editions, and today's edition
   *   becomes "past" tomorrow.  Without clearing layers 2a (localStorage)
   *   and 2b (IndexedDB) here, the very next read after a save would hit the
   *   stale persisted copy and silently return the OLD editions — making
   *   the newly-added page appear to have never been saved after a reload
   *   or date re-visit.  This was the root cause of the recurring
   *   "new page isn't saving / not syncing with backend" complaint.
   */
  evict(date: string): void {
    this._memCache.delete(date);
    // Layer 2a: localStorage — synchronous, safe to call even if the key
    // doesn't exist (no-op).  Errors (private-browsing mode, quota issues)
    // are silently swallowed so they never break the save flow.
    if (this.isBrowser) {
      try {
        localStorage.removeItem(this._lsKey(date));
      } catch {
        // ignore — eviction is best-effort
      }
    }
    // Layer 2b: IndexedDB — async, fire-and-forget.  IdbCacheService.delete()
    // already swallows its own errors internally.
    void this.idbCache.delete(date);
  }

  /**
   * Wipe the entire in-memory cache and schedule an async clear of IndexedDB.
   * Called after a full `POST /data` save.
   * Does not touch localStorage (past-date entries are still valid).
   */
  clearMemory(): void {
    this._memCache.clear();
    // Fire-and-forget — don't block the save flow on IDB clearing.
    void this.idbCache.clear();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** HTTP fetch helper shared by all code paths that reach layer 3. */
  private _fetchFromHttp(
    date: string,
    staleMemEntry: MemCacheEntry | undefined,
  ): Observable<NewspaperEdition[]> {
    return this.http
      .get<{ date: string; editions: NewspaperEdition[]; dataVersion: number }>(
        `${this._endpoint}/${date}`
      )
      .pipe(
        map(res => Array.isArray(res.editions) ? res.editions : []),
        tap(editions => {
          this._setMem(date, editions);
          this._persistAll(date, editions);
        }),
        catchError(err => {
          console.warn(
            `[EditionCacheService] Failed to fetch editions for ${date}. Reason:`,
            err?.message ?? err
          );
          // Return whatever stale data we have rather than throwing
          return of(staleMemEntry?.editions ?? []);
        })
      );
  }

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
    if (!this.isBrowser) return null; // SSR — no localStorage
    try {
      const raw = localStorage.getItem(this._lsKey(date));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { editions?: NewspaperEdition[] };
      return Array.isArray(parsed.editions) ? parsed.editions : null;
    } catch {
      return null; // corrupt entry — fall through to IDB / HTTP
    }
  }

  /**
   * Persist editions to localStorage (sync) AND IndexedDB (async, fire-and-forget).
   *
   * Only past dates are persisted: today's editions are still being edited
   * by admins, so caching them on disk would mean a refresh could surface a
   * version that's seconds-to-minutes out of date relative to the server.
   * (This matches _persistToLocalStorage's own guard, which was already in
   * place — IDB now applies the same rule for consistency.)
   */
  private _persistAll(date: string, editions: NewspaperEdition[]): void {
    if (!this._isPastDate(date)) return;
    if (!editions.length) return;
    this._persistToLocalStorage(date, editions);
    // IDB write is async and non-blocking; errors are handled inside IdbCacheService.
    void this.idbCache.set(date, editions);
  }

  private _persistToLocalStorage(date: string, editions: NewspaperEdition[]): void {
    if (!this.isBrowser) return; // SSR — no localStorage
    // Only persist past dates; today's data must always be re-validated.
    if (!this._isPastDate(date)) return;
    if (!editions.length) return;
    try {
      localStorage.setItem(this._lsKey(date), JSON.stringify({ editions }));
    } catch {
      // Quota exceeded — silently skip. IDB write above is the backstop.
    }
  }
}
