import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { GlobalSettings, NewspaperEdition } from './newspaper-data.service';

/**
 * Publish-time inlined bootstrap state.
 *
 * Shape of the JSON embedded in the served `index.html` as:
 *   <script id="dn-initial-state" type="application/json">{…}</script>
 *
 * The WordPress plugin writes this blob whenever an editor publishes, so the
 * page Apache serves already contains today's primary content. Reading it on
 * boot lets the app seed its synchronous caches (settings + dates + today's
 * editions) BEFORE the first HTTP request — eliminating the cold-start network
 * round-trip that causes the first-visit loading spinner, even though the host
 * has no Node.js to run SSR.
 */
export interface InlineBootstrapState {
  settings?: GlobalSettings;
  /** Sorted list of available dates, newest-first (optional convenience copy). */
  dates?: string[];
  /** Editions for the inlined date(s) — typically today / latest. */
  editions?: NewspaperEdition[];
  /** Server dataVersion at the moment the blob was generated. */
  dataVersion?: number;
  /** ISO-8601 generation timestamp (diagnostic only). */
  generatedAt?: string;
}

/**
 * Reads the publish-time inlined bootstrap state from the DOM.
 *
 * Design guarantees (non-breaking):
 *   - Browser-only. Returns null on the server.
 *   - Returns null when the `<script id="dn-initial-state">` element is absent
 *     (the normal case until the plugin-side injection is deployed), so the
 *     existing network-fetch boot path runs unchanged.
 *   - Never throws: any parse/validation error degrades silently to null.
 *   - Reads at most once per page; the result is memoised.
 */
@Injectable({ providedIn: 'root' })
export class BootstrapStateService {

  private static readonly ELEMENT_ID = 'dn-initial-state';

  private readonly platformId = inject(PLATFORM_ID);
  private _cached: InlineBootstrapState | null | undefined = undefined;

  /**
   * Returns the parsed inline state, or null when unavailable/invalid.
   * Memoised after the first call.
   */
  read(): InlineBootstrapState | null {
    if (this._cached !== undefined) return this._cached;
    this._cached = this._readOnce();
    return this._cached;
  }

  private _readOnce(): InlineBootstrapState | null {
    if (!isPlatformBrowser(this.platformId)) return null;
    try {
      const el = document.getElementById(BootstrapStateService.ELEMENT_ID);
      const raw = el?.textContent?.trim();
      if (!raw) return null;

      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;

      const state = parsed as InlineBootstrapState;

      // Minimal structural validation — only accept shapes we can safely use.
      const editionsOk = state.editions === undefined || Array.isArray(state.editions);
      const datesOk = state.dates === undefined || Array.isArray(state.dates);
      const settingsOk =
        state.settings === undefined ||
        (state.settings !== null && typeof state.settings === 'object');

      if (!editionsOk || !datesOk || !settingsOk) return null;

      return state;
    } catch {
      // Malformed JSON or unexpected DOM — fall back to the network path.
      return null;
    }
  }
}
