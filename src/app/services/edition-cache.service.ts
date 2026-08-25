import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Observable, of, from } from 'rxjs';
import { tap, map, catchError, switchMap, timeout } from 'rxjs/operators';
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
 *   Survives page reloads.
 *   Past dates: permanent (no TTL) — content is immutable once published.
 *   Today: 30-minute TTL stored as `fetchedAt` in the JSON payload.
 *   Backed by evict() which clears the key on admin save — so a reload
 *   after a content edit always fetches fresh data from HTTP.
 *
 * Layer 2b — IndexedDB store `dn-edition-cache` via IdbCacheService (async, ~GB quota)
 *   Fallback when localStorage quota is exhausted. A year of edition data
 *   (~18 MB) fits here with room to spare.
 *   Past dates only — today's data is handled by the localStorage TTL.
 *
 * Layer 3 — HTTP GET `/data/editions/:date`                   (async, network)
 *   The HTTP cache interceptor may short-circuit before the network if its
 *   in-memory ETag / TTL entry is still fresh.
 *
 * Cache invalidation:
 *   `evict(date)`   — removes entry from all layers for that date. Must be
 *                     called after any admin save so the next read is fresh.
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
  /** Today's edition expires from in-memory cache after 5 minutes. */
  private static readonly TODAY_TTL_MS = 5 * 60 * 1000;
  /**
   * Today's edition expires from localStorage after 30 minutes.
   *
   * Why 30 min?  A daily newspaper publishes once in the morning; content is
   * stable for the rest of the day.  The 5-minute version-poll detects any
   * admin edit that happens within the 30-min window and triggers a targeted
   * reload — so readers are never more than 5 minutes behind even if they
   * hit the localStorage cache.
   *
   * Why persist at all?  The in-memory cache lives only for the page session.
   * Without localStorage persistence, every page reload requires a full HTTP
   * round-trip before any content is visible — causing the several-second
   * blank / skeleton state that motivated this change.
   */
  private static readonly TODAY_LS_TTL_MS = 30 * 60 * 1000;

  private readonly _endpoint =
    `${WP_BASE_URL}/wp-json/digital-newspaper/v1/data/editions`;

  /**
   * Static JSON snapshot directory written by the WordPress plugin on every
   * publish (feature-flagged server-side). These files are served directly by
   * Apache with no PHP/MySQL, so reading them first removes the origin from the
   * hot path under load and makes today's edition load near-instantly.
   *
   * The shape is identical to the REST endpoint
   * (`{ date, editions, dataVersion }`), so the two are interchangeable. When a
   * snapshot is absent (feature disabled, or a date not yet generated) the
   * static GET 404s and we transparently fall back to the REST endpoint — so
   * this optimisation is always safe and self-healing.
   */
  private readonly _staticBase =
    `${WP_BASE_URL}/wp-content/dn-static/editions`;

  private readonly _memCache = new Map<string, MemCacheEntry>();

  /**
   * date → cancel fn for a persist that has been scheduled but not yet run.
   * Without this, an eviction cannot stop an already-queued write, and the write
   * would restore the pre-eviction editions seconds later.
   */
  private readonly _pendingPersists = new Map<string, () => void>();

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
   *   1. Memory (5-min TTL for today, permanent for past dates)
   *   2a. localStorage (30-min TTL for today, permanent for past dates)
   *   2b. IndexedDB (past dates only — today is covered by localStorage TTL)
   *   3. HTTP
   *
   * @param date  ISO-8601 date string, e.g. '2026-06-07'
   */
  getEditionsForDate(date: string): Observable<NewspaperEdition[]> {
    // ── Layer 1: memory ──────────────────────────────────────────────────────
    const memEntry = this._memCache.get(date);
    if (memEntry && this._isMemFresh(date, memEntry)) {
      return of(memEntry.editions);
    }

    // ── Layer 2a: localStorage (all dates; TTL enforced for today) ───────────
    // Past dates are cached permanently. Today is cached with a 30-minute TTL
    // (fetchedAt stored in the JSON payload). On a cache hit we seed the
    // in-memory layer and return immediately — no HTTP needed.
    const lsEditions = this._readFromStorage(date);
    if (lsEditions) {
      this._setMem(date, lsEditions);
      return of(lsEditions);
    }

    // ── Layer 2b: IndexedDB (past dates only, async) ─────────────────────────
    // Only consulted when localStorage misses (quota exceeded or entry cleared).
    // Today's date uses localStorage TTL; IDB is skipped to avoid the async
    // overhead on every first-of-session access to today's content.
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

    // ── Layer 3: HTTP (today localStorage miss / future dates) ──────────────
    return this._fetchFromHttp(date, memEntry);
  }

  /**
   * First-paint variant used for the very first edition load. Returns the
   * smaller `<date>.light.json` (article bodies stripped from all but the first
   * page) when no full copy is already cached locally, so the initial render is
   * fast even on hosts that don't compress JSON. The caller upgrades to the full
   * payload in the background.
   *
   * Resolution:
   *   1. Fresh in-memory full copy → return it (light not needed).
   *   2. localStorage full copy    → return it (light not needed).
   *   3. `<date>.light.json`       → return light (NOT cached as full).
   *   4. Fall back to the full path (`getEditionsForDate`).
   *
   * The returned `light` flag tells the caller whether a background upgrade to
   * the full payload is required. Light editions are intentionally never written
   * to the shared cache layers, so they can't mask the full content later.
   */
  getEditionsForDateLight(
    date: string,
  ): Observable<{ editions: NewspaperEdition[]; light: boolean }> {
    const memEntry = this._memCache.get(date);
    if (memEntry && this._isMemFresh(date, memEntry)) {
      return of({ editions: memEntry.editions, light: false });
    }
    const lsEditions = this._readFromStorage(date);
    if (lsEditions) {
      this._setMem(date, lsEditions);
      return of({ editions: lsEditions, light: false });
    }
    return this.http
      .get<{ editions: NewspaperEdition[] }>(`${this._staticBase}/${date}.light.json`)
      .pipe(
        timeout(6000),
        map(res => (Array.isArray(res?.editions) ? res.editions : [])),
        switchMap(editions =>
          editions.length > 0
            ? of({ editions, light: true })
            : this.getEditionsForDate(date).pipe(map(full => ({ editions: full, light: false }))),
        ),
        catchError(() =>
          this.getEditionsForDate(date).pipe(map(full => ({ editions: full, light: false }))),
        ),
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
        this._persistAllDeferred(date, editions);
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
    // FIRST: kill any queued write for this date. Persisting is deferred to an
    // idle callback, so a write scheduled before this save is still pending and
    // would re-create the localStorage key below — with a fresh fetchedAt, i.e.
    // a full TTL on pre-save data. That is the exact "new page isn't saving"
    // failure this method exists to prevent.
    this._cancelPendingPersist(date);
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
   * Called after a full `POST /data` save, restore, or rebuild.
   *
   * Today's localStorage entry is also cleared: since we now persist today's
   * edition to localStorage with a 30-minute TTL, a full-memory clear must
   * also evict it — otherwise the next loadDataFromGranular() speculative
   * fetch would hit the stale LS entry and serve pre-save data to readers
   * who reload the page within the TTL window.
   *
   * Past-date LS entries are left intact: they are treated as immutable and
   * were already a pre-existing concern for restore/rebuild operations.
   */
  clearMemory(): void {
    // Same reasoning as evict(): a queued persist would outlive the clear.
    for (const date of [...this._pendingPersists.keys()]) this._cancelPendingPersist(date);
    this._memCache.clear();
    // Evict today's localStorage entry so the next read goes to HTTP.
    if (this.isBrowser) {
      try {
        localStorage.removeItem(this._lsKey(this._today()));
      } catch {
        // ignore — best-effort
      }
    }
    // Fire-and-forget — don't block the save flow on IDB clearing.
    void this.idbCache.clear();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Layer 3 fetch. Tries the static snapshot first (served by Apache, no PHP),
   * then falls back to the authoritative REST endpoint when the snapshot is
   * missing, empty, or errors. Both sources share the same response shape and
   * both seed the in-memory + persistent layers identically, so callers are
   * unaffected by which one served the data.
   */
  private _fetchFromHttp(
    date: string,
    staleMemEntry: MemCacheEntry | undefined,
  ): Observable<NewspaperEdition[]> {
    // Static snapshot first (served by Apache/LiteSpeed with no PHP), REST
    // fallback when it's missing/empty/errors. Stable URL (no cache-buster): the
    // snapshot .htaccess sends `Cache-Control: no-cache, must-revalidate`, so the
    // browser revalidates via Last-Modified and gets a tiny 304 when unchanged,
    // fresh bytes after a publish.
    return this._tryStatic(date).pipe(
      switchMap(editions =>
        editions.length > 0 ? of(editions) : this._fetchFromRest(date, staleMemEntry),
      ),
    );
  }

  /**
   * Fetch the static snapshot for a date. Returns the editions on success (and
   * seeds the cache layers), or an empty array on miss/error so the caller can
   * fall through to REST. Never throws.
   */
  private _tryStatic(date: string): Observable<NewspaperEdition[]> {
    return this.http
      .get<{ date: string; editions: NewspaperEdition[]; dataVersion: number }>(
        `${this._staticBase}/${date}.json`,
      )
      .pipe(
        timeout(6000),
        map(res => (Array.isArray(res?.editions) ? res.editions : [])),
        tap(editions => {
          if (editions.length > 0) {
            this._setMem(date, editions);
            this._persistAllDeferred(date, editions);
          }
        }),
        catchError(() => of([] as NewspaperEdition[])),
      );
  }

  /**
   * Authoritative REST fetch (original layer-3 behaviour, unchanged). Used
   * directly when the static snapshot is unavailable.
   */
  private _fetchFromRest(
    date: string,
    staleMemEntry: MemCacheEntry | undefined,
  ): Observable<NewspaperEdition[]> {
    return this.http
      .get<{ date: string; editions: NewspaperEdition[]; dataVersion: number }>(
        `${this._endpoint}/${date}`
      )
      .pipe(
        // Per-request timeout: fail fast so a stalled edition fetch doesn't
        // exhaust the outer granular-chain budget. On timeout the catchError
        // below returns stale data rather than throwing, so the granular path
        // can still complete with whatever data is available.
        timeout(10000),
        map(res => Array.isArray(res.editions) ? res.editions : []),
        tap(editions => {
          this._setMem(date, editions);
          this._persistAllDeferred(date, editions);
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

  /**
   * Best-effort, STATIC-ONLY warm of a date's editions for idle prefetch.
   *
   * Unlike getEditionsForDate(), this deliberately NEVER falls back to the REST
   * endpoint: a speculative background prefetch must not trigger an expensive
   * WordPress/PHP request. If the static snapshot is missing (e.g. an old date
   * not yet backfilled) the prefetch simply does nothing — the date will still
   * load on demand (static-first, REST fallback) if the reader navigates to it.
   *
   * Fire-and-forget: returns void, self-subscribes, and swallows all errors.
   */
  prefetchStatic(date: string): void {
    if (!date || this._memCache.has(date)) return;   // already warm or invalid
    // Static-only (never REST — a non-urgent warm-up must not trigger PHP).
    // _tryStatic seeds the caches on success.
    this._tryStatic(date).subscribe();
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
      const parsed = JSON.parse(raw) as { editions?: NewspaperEdition[]; fetchedAt?: number };
      if (!Array.isArray(parsed.editions)) return null;
      // Today's cached entry has a fetchedAt timestamp; treat as stale (and
      // re-fetch from HTTP) if the entry is older than TODAY_LS_TTL_MS.
      // Past dates have no fetchedAt and are treated as permanently valid.
      if (!this._isPastDate(date)) {
        if (parsed.fetchedAt === undefined) return null; // old-format entry — must re-fetch
        if (Date.now() - parsed.fetchedAt >= EditionCacheService.TODAY_LS_TTL_MS) {
          return null; // expired — fall through to HTTP
        }
      }
      return parsed.editions;
    } catch {
      return null; // corrupt entry — fall through to IDB / HTTP
    }
  }

  /**
   * Persist editions to localStorage AND (for past dates) IndexedDB.
   *
   * Today's editions are now persisted to localStorage with a 30-minute TTL
   * so that returning visitors get instant content on page reload without
   * waiting for an HTTP round-trip.  The 5-minute version-poll guarantees
   * any admin edits are detected and applied within that window regardless.
   *
   * Past dates continue to be persisted to both localStorage (permanent,
   * no TTL) and IndexedDB (overflow backstop for large datasets).
   */
  /**
   * Schedule _persistAll() off the critical path.
   *
   * Persisting an edition is a synchronous JSON.stringify plus localStorage
   * write of ~50 KB — 5-20 ms of blocking main-thread work on a low-end phone.
   * The in-memory cache set alongside it is what the first paint actually reads;
   * persistence is purely a next-visit optimisation, so it has no business
   * running before the page has painted.
   *
   * This matters most once the inline-bootstrap flag is enabled, because
   * seedFromLoadedData() then runs inside NewspaperDataService's constructor —
   * i.e. during dependency injection, before anything renders at all.
   */
  private _persistAllDeferred(date: string, editions: NewspaperEdition[]): void {
    if (!this.isBrowser) return; // SSR — nothing to persist

    // Supersede any write still queued for this date. Two reasons this is not
    // optional: a queued callback holds a reference to the OLD editions array and
    // would overwrite newer data, and evict() must be able to cancel it — see
    // _cancelPendingPersist().
    this._cancelPendingPersist(date);

    const run = () => {
      this._pendingPersists.delete(date);
      this._persistAll(date, editions);
    };

    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (typeof w.requestIdleCallback === 'function') {
      const handle = w.requestIdleCallback(run, { timeout: 2000 });
      this._pendingPersists.set(date, () => w.cancelIdleCallback?.(handle));
    } else {
      // No requestIdleCallback (Safari before 17.4 — precisely the low-end
      // devices this deferral exists for). A bare setTimeout(0) is a macrotask
      // that still runs BEFORE first paint, so it would not defer anything;
      // rAF fires just before a paint, so a timeout scheduled from inside it
      // lands just after that paint.
      let inner = 0;
      const frame = requestAnimationFrame(() => { inner = window.setTimeout(run, 0); });
      this._pendingPersists.set(date, () => {
        cancelAnimationFrame(frame);
        clearTimeout(inner);
      });
    }
  }

  /** Drop a queued persist for `date`, if any. Safe to call unconditionally. */
  private _cancelPendingPersist(date: string): void {
    const cancel = this._pendingPersists.get(date);
    if (!cancel) return;
    cancel();
    this._pendingPersists.delete(date);
  }

  private _persistAll(date: string, editions: NewspaperEdition[]): void {
    if (!editions.length) return;
    // localStorage: all dates (TTL enforced for today inside _persistToLocalStorage).
    this._persistToLocalStorage(date, editions);
    // IDB: past dates only — today is handled by the localStorage 30-min TTL.
    if (this._isPastDate(date)) {
      // IDB write is async and non-blocking; errors are handled inside IdbCacheService.
      void this.idbCache.set(date, editions);
    }
  }

  private _persistToLocalStorage(date: string, editions: NewspaperEdition[]): void {
    if (!this.isBrowser) return; // SSR — no localStorage
    if (!editions.length) return;
    try {
      if (this._isPastDate(date)) {
        // Past dates: no TTL — content is immutable once published.
        localStorage.setItem(this._lsKey(date), JSON.stringify({ editions }));
      } else {
        // Today: include fetchedAt so _readFromStorage can enforce the TTL.
        localStorage.setItem(this._lsKey(date), JSON.stringify({ editions, fetchedAt: Date.now() }));
      }
    } catch {
      // Quota exceeded — silently skip. IDB write in _persistAll is the backstop
      // for past dates; today's data will be re-fetched from HTTP on the next visit.
    }
  }
}
