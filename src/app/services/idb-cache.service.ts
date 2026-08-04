import { Injectable, inject } from '@angular/core';
import { openDB, IDBPDatabase } from 'idb';
import { NewspaperEdition } from './newspaper-data.service';
import { DemoService } from './demo.service';

/**
 * IndexedDB-backed persistent cache for per-date edition payloads.
 *
 * Why IndexedDB over localStorage?
 * localStorage has a 5–10 MB per-origin quota (browser-dependent).
 * One year of edition data (365 dates × ~50 KB avg) is ~18 MB — well past
 * the localStorage limit.  IndexedDB supports hundreds of MB without
 * explicit permission prompts.
 *
 * This service sits between the in-memory Map (layer 1) and the HTTP call
 * (layer 3) in EditionCacheService, replacing/augmenting the localStorage
 * layer 2.  localStorage is kept as an additional fallback because IndexedDB
 * operations are always async, while localStorage can return synchronously
 * on the first render (useful for instant content paint on page load).
 *
 * Schema:
 *   DB name:   dn-edition-cache
 *   Version:   1
 *   Store:     editions
 *     key:     date string (YYYY-MM-DD)
 *     value:   { date, editions: NewspaperEdition[], storedAt: number }
 *
 * Eviction policy:
 *   Past dates are kept indefinitely — they are immutable once published.
 *   Today's date is never stored (admin may still be editing it).
 *   `clear()` wipes all entries (called after a full save or on demand).
 */

interface IdbEditionEntry {
  date: string;
  editions: NewspaperEdition[];
  storedAt: number;
}

const DB_NAME    = 'dn-edition-cache';
const DB_VERSION = 1;
const STORE_NAME = 'editions';

@Injectable({ providedIn: 'root' })
export class IdbCacheService {

  private _dbPromise: Promise<IDBPDatabase> | null = null;
  private readonly demo = inject(DemoService);

  /**
   * §3.4 — In demo mode the edition cache is namespaced per session token so a
   * buyer's cached (possibly edited) editions never leak to another buyer's tab
   * and repeat-load speed stays real WITHIN a session. Non-demo builds use the
   * shared golden cache exactly as before.
   */
  private _dbName(): string {
    if (this.demo.enabled) {
      const token = this.demo.getToken();
      return token ? `${DB_NAME}-demo-${token}` : DB_NAME;
    }
    return DB_NAME;
  }

  // ── DB access ──────────────────────────────────────────────────────────────

  /**
   * Lazy-open the database.  Returns null if IndexedDB is unavailable
   * (e.g. private-browsing in some browsers, or SSR environment).
   */
  private _db(): Promise<IDBPDatabase> | null {
    if (!this._isAvailable()) return null;
    if (!this._dbPromise) {
      this._dbPromise = openDB(this._dbName(), DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'date' });
          }
        },
        // If the DB is blocked (e.g. another tab has an older version open),
        // close this connection so the upgrade can proceed.
        blocked() {
          console.warn('[IdbCacheService] DB upgrade blocked by another tab.');
        },
        blocking: () => {
          // A newer tab is trying to upgrade — drop our reference so the next
          // _db() call opens a fresh connection against the new version.
          this._dbPromise = null;
        },
      }).catch(err => {
        console.warn('[IdbCacheService] Failed to open IndexedDB:', err?.message ?? err);
        this._dbPromise = null;
        throw err;
      });
    }
    return this._dbPromise;
  }

  private _isAvailable(): boolean {
    return typeof window !== 'undefined' && 'indexedDB' in window;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Retrieve editions for `date` from IndexedDB.
   * Returns `null` if the entry does not exist, the DB is unavailable,
   * or any error occurs.
   */
  async get(date: string): Promise<NewspaperEdition[] | null> {
    const dbP = this._db();
    if (!dbP) return null;
    try {
      const db = await dbP;
      const entry: IdbEditionEntry | undefined = await db.get(STORE_NAME, date);
      return entry?.editions ?? null;
    } catch (err) {
      console.warn(`[IdbCacheService] get(${date}) failed:`, err);
      return null;
    }
  }

  /**
   * Persist editions for `date`.
   * Only call for past dates — today's data must not be stale-cached.
   * Errors are silently swallowed so callers are never blocked on IDB writes.
   */
  async set(date: string, editions: NewspaperEdition[]): Promise<void> {
    const dbP = this._db();
    if (!dbP) return;
    try {
      const db = await dbP;
      const entry: IdbEditionEntry = { date, editions, storedAt: Date.now() };
      await db.put(STORE_NAME, entry);
    } catch (err) {
      console.warn(`[IdbCacheService] set(${date}) failed:`, err);
    }
  }

  /**
   * Remove the entry for `date` from IndexedDB.
   * Used when an edition is updated (though past dates are immutable by design).
   */
  async delete(date: string): Promise<void> {
    const dbP = this._db();
    if (!dbP) return;
    try {
      const db = await dbP;
      await db.delete(STORE_NAME, date);
    } catch (err) {
      console.warn(`[IdbCacheService] delete(${date}) failed:`, err);
    }
  }

  /**
   * Wipe all entries from the store.
   * Called after a full `POST /data` save where all dates may have changed.
   */
  async clear(): Promise<void> {
    const dbP = this._db();
    if (!dbP) return;
    try {
      const db = await dbP;
      await db.clear(STORE_NAME);
    } catch (err) {
      console.warn('[IdbCacheService] clear() failed:', err);
    }
  }

  /**
   * Returns the number of entries currently in the store.
   * Useful for diagnostics / the health endpoint page.
   */
  async count(): Promise<number> {
    const dbP = this._db();
    if (!dbP) return 0;
    try {
      const db = await dbP;
      return await db.count(STORE_NAME);
    } catch {
      return 0;
    }
  }
}
