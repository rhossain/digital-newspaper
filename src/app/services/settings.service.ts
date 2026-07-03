import { Injectable, signal, Signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { tap, map, catchError, timeout } from 'rxjs/operators';
import { GlobalSettings } from './newspaper-data.service';
import { WP_BASE_URL } from '../config';

/**
 * Dedicated service for global settings (logo, social links, language, etc.).
 *
 * Why separate from NewspaperDataService?
 * Settings change rarely — maybe once a month — while edition data changes daily.
 * A separate endpoint (`/data/settings`) allows the CDN to cache settings for up
 * to 1 hour independently of news content. The HTTP cache interceptor (TTL 1 hr)
 * handles network-level caching; this service handles in-process and localStorage
 * persistence.
 *
 * Backward compatibility:
 * Uses the SAME localStorage key ('dn_global_settings') as NewspaperDataService.
 * Both services read and write the same slot, so neither can corrupt the other's
 * view of settings. When NewspaperDataService is eventually slimmed down this
 * key will migrate entirely here.
 *
 * Usage:
 *   inject(SettingsService).settings()   // synchronous Signal read
 *   inject(SettingsService).fetch()      // trigger a network refresh
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {

  /**
   * Shared localStorage key — intentionally the same as
   * `NewspaperDataService.SETTINGS_CACHE_KEY` for cross-service compatibility.
   */
  static readonly CACHE_KEY = 'dn_global_settings';

  private readonly _endpoint =
    `${WP_BASE_URL}/wp-json/digital-newspaper/v1/data/settings`;

  /**
   * Static snapshot of the same payload, written by the WordPress plugin on
   * every publish and served by Apache with NO PHP. Public readers fetch this
   * first (see `fetch(preferStatic=true)`) and fall back to the authoritative
   * REST endpoint above on any miss/empty/error. Same `{ settings, dataVersion }`
   * shape as the REST endpoint, so parsing is identical.
   */
  private readonly _staticUrl =
    `${WP_BASE_URL}/wp-content/dn-static/settings.json`;

  // ── State ──────────────────────────────────────────────────────────────────

  private readonly _settings = signal<GlobalSettings>(
    SettingsService._readFromStorage() ?? SettingsService._defaults()
  );

  /**
   * Read-only signal of the current global settings.
   * Initialised from localStorage on first injection; updated by `fetch()` or `apply()`.
   */
  readonly settings: Signal<GlobalSettings> = this._settings.asReadonly();

  constructor(private readonly http: HttpClient) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Fetch settings from `/data/settings` and update the signal.
   *
   * The HTTP cache interceptor transparently handles ETags and the 1-hour TTL,
   * so this method hits the network only when the cache is cold or evicted.
   * On network failure the signal retains its current (cached) value.
   *
   * @param preferStatic When true (public viewer), try the static snapshot
   *   first and fall back to REST on miss/error. When false (admin editor), go
   *   straight to the authoritative REST endpoint so the editor never reads —
   *   and therefore never saves from — a possibly-stale snapshot.
   * @returns Observable<GlobalSettings> for callers that need to chain work.
   */
  fetch(preferStatic = false): Observable<GlobalSettings> {
    // Authoritative REST read, with the original cached-fallback behaviour.
    const rest$ = this._get(this._endpoint).pipe(
      catchError(err => {
        console.warn(
          '[SettingsService] fetch failed — serving cached settings. Reason:',
          err?.message ?? err
        );
        return of(this._settings());
      })
    );

    if (!preferStatic) return rest$;

    // Static-first: a 404 / empty / timeout on the snapshot throws and falls
    // through to the identical REST read above. The static file shares the exact
    // `{ settings, dataVersion }` shape, so no special-casing is needed.
    return this._get(this._staticUrl).pipe(catchError(() => rest$));
  }

  /**
   * Low-level GET that fetches, normalises, and persists settings.
   * Errors propagate (no catchError here) so `fetch()` can decide whether to
   * fall back from the static snapshot to REST, or serve the cached value.
   */
  private _get(url: string): Observable<GlobalSettings> {
    return this.http
      .get<{ settings: GlobalSettings; dataVersion: number }>(url)
      .pipe(
        // Per-request timeout: fail fast so a single slow endpoint doesn't
        // exhaust the 20 s granular-chain budget in NewspaperDataService.
        timeout(10000),
        map(res => this._normalise(res.settings ?? SettingsService._defaults())),
        tap(settings => {
          this._settings.set(settings);
          SettingsService._persist(settings);
        })
      );
  }

  /**
   * Synchronous snapshot of the current settings.
   * Equivalent to calling `this.settings()` but useful in non-reactive contexts.
   */
  get(): GlobalSettings {
    return this._settings();
  }

  /**
   * Apply an externally-sourced settings object (e.g. after an admin save).
   * Updates the signal and persists to localStorage — keeps both services in sync
   * while NewspaperDataService is still the primary write path.
   */
  apply(settings: GlobalSettings): void {
    const normalised = this._normalise(settings);
    this._settings.set(normalised);
    SettingsService._persist(normalised);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Apply full null-safety normalization so all callers — including
   * NewspaperDataService.getSettings() — can trust every sub-object exists.
   *
   * Mirrors the normalization that NewspaperDataService.getSettings() applied
   * inline. Keeping it here means SettingsService is the single authority on
   * what a "safe" GlobalSettings object looks like.
   */
  private _normalise(settings: GlobalSettings): GlobalSettings {
    return {
      ...settings,
      // PHP serializes empty arrays as [] — normalize to {}
      socialLinks: (settings.socialLinks && !Array.isArray(settings.socialLinks))
        ? settings.socialLinks
        : {},
      // Ensure sub-objects always exist so callers don't need null-checks
      logo:    settings.logo    ?? { url: '', alt: 'Digital Newspaper' },
      address: settings.address ?? {},
      editor:  settings.editor  ?? '',
      language: settings.language || 'en',
    };
  }

  private static _defaults(): GlobalSettings {
    return {
      defaultDateMode: 'current',
      socialLinks: {},
      logo:    { url: '', alt: 'Digital Newspaper' },
      address: {},
      editor:  '',
      language: 'en',
    };
  }

  private static _readFromStorage(): GlobalSettings | null {
    if (typeof localStorage === 'undefined') return null; // SSR — no localStorage
    try {
      const raw = localStorage.getItem(SettingsService.CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as GlobalSettings;
      // Apply the same normalization as _normalise() — static version
      // (cannot call the instance method here, so replicate the guards).
      if (parsed.socialLinks && Array.isArray(parsed.socialLinks)) {
        parsed.socialLinks = {};
      }
      if (!parsed.logo)     parsed.logo    = { url: '', alt: 'Digital Newspaper' };
      if (!parsed.address)  parsed.address = {};
      if (parsed.editor  === undefined) parsed.editor  = '';
      if (!parsed.language) parsed.language = 'en';
      return parsed;
    } catch {
      return null; // corrupt storage — start fresh
    }
  }

  private static _persist(settings: GlobalSettings): void {
    if (typeof localStorage === 'undefined') return; // SSR — no localStorage
    try {
      localStorage.setItem(SettingsService.CACHE_KEY, JSON.stringify(settings));
    } catch {
      // Quota exceeded or private browsing — silently ignore.
      // The signal still holds the current value in memory.
    }
  }
}
