import { Injectable, computed, signal, Signal, inject, PLATFORM_ID } from '@angular/core';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { catchError, map, Observable, of, retry, tap, timer } from 'rxjs';
import { WP_BASE_URL } from '../config';
import { AuthService } from './auth.service';

/**
 * One responsive size rule: from `viewport` [width, height] upward, request
 * `sizes`. GPT applies the rule with the largest viewport the browser fits.
 */
export interface SizeMappingRule {
  viewport: [number, number];
  sizes: number[][];
}

/** Single ad slot definition, mirroring the PHP gam_ad_slots() structure. */
export interface AdSlot {
  /** Stable identifier used as Angular input (e.g. 'desktop_page_left'). */
  id: string;
  /** GAM ad unit path (e.g. '/22062727803/TDSEV3_Desktop_Page_Left-01'). */
  unit: string;
  /** All declared sizes [[w, h], ...] — same as defineSlot sizes. */
  sizes: number[][];
  /** The div ID GAM expects (e.g. 'div-gpt-ad-1781436865448-0'). */
  div: string;
  /** Minimum container width in px (from GAM slot HTML snippet). */
  min_width: number;
  /** Minimum container height in px (from GAM slot HTML snippet). */
  min_height: number;
  /** Whether this specific slot is enabled (persisted via OPTION_GAM_SLOT_STATES). */
  enabled: boolean;
  /**
   * Optional per-viewport sizes. When present, the slot asks only for the sizes
   * that fit the current screen; `sizes` must be their union. Optional so a
   * backend predating the field keeps working with plain `sizes`.
   */
  size_mapping?: SizeMappingRule[];
}

interface AdsConfigResponse {
  enabled: boolean;
  slots: AdSlot[];
  /** Optional — absent on a backend predating the field, which falls back to the default. */
  no_fill_retries?: number;
}

/** The GPT surface used for bootstrapping only. Slot APIs live in GamService. */
interface GptBootstrap {
  cmd: Array<() => void>;
  setConfig(config: { singleRequest?: boolean; disableInitialLoad?: boolean }): void;
  enableServices(): void;
}

/**
 * AdService — fetches Google Ad Manager configuration from the WordPress
 * REST API (/ads/config) once on startup and exposes it as Angular signals.
 *
 * Usage in a component:
 *   private readonly adService = inject(AdService);
 *
 *   // Check if ads are globally enabled
 *   adService.enabled()
 *
 *   // Check if a specific slot is enabled (global AND per-slot)
 *   adService.slotEnabledMap().get('desktop_page_left')
 *
 *   // Look up a single slot by its stable ID
 *   adService.getSlot('desktop_page_left')
 *
 * The endpoint is public and CDN-cacheable (no credentials sent on GET).
 * On network failure the service silently stays disabled — no ads shown.
 */
@Injectable({ providedIn: 'root' })
export class AdService {

  private static readonly ENDPOINT =
    `${WP_BASE_URL}/wp-json/digital-newspaper/v1/ads/config`;

  private static readonly GPT_SRC =
    'https://securepubads.g.doubleclick.net/tag/js/gpt.js';

  // ── DI ─────────────────────────────────────────────────────────────────────

  private readonly platformId = inject(PLATFORM_ID);
  private readonly document   = inject(DOCUMENT);

  // ── State signals ───────────────────────────────────────────────────────────

  /**
   * Retries a slot may spend re-requesting an ad after an empty response, used
   * when the backend does not send `no_fill_retries`.
   *
   * Matches the plugin's own default so an older backend behaves like a current
   * one rather than silently dropping the retry.
   */
  private static readonly DEFAULT_NO_FILL_RETRIES = 2;

  /** Upper bound mirroring the plugin's clamp — a hostile response cannot loop a slot. */
  private static readonly MAX_NO_FILL_RETRIES = 5;

  private readonly _enabled        = signal<boolean>(false);
  private readonly _slots          = signal<AdSlot[]>([]);
  private readonly _ready          = signal<boolean>(false);
  private readonly _noFillRetries  = signal<number>(AdService.DEFAULT_NO_FILL_RETRIES);

  /** True once the GPT library tag has been injected and services enabled. */
  private _gptBooted = false;

  /** Whether GAM is globally enabled on the WordPress side. */
  readonly enabled: Signal<boolean> = this._enabled.asReadonly();

  /** Full slot list (empty until the fetch resolves). */
  readonly slots: Signal<AdSlot[]> = this._slots.asReadonly();

  /**
   * How many times a slot may re-request an ad after GAM answered it empty.
   *
   * Server-controlled because it is a network-policy call, not an app one — see
   * `gam_no_fill_retries()` in the plugin. 0 disables retries.
   */
  readonly noFillRetries: Signal<number> = this._noFillRetries.asReadonly();

  /**
   * True once the initial /ads/config fetch has settled (success OR error).
   * Components should gate ad-vs-content branching on this flag so they never
   * render a content fallback that immediately gets swapped out for an ad.
   */
  readonly ready: Signal<boolean> = this._ready.asReadonly();

  /**
   * Reactive map of slot-id → effective enabled state.
   * Returns empty map when global GAM is disabled (so no slots are shown).
   * Components can read this in templates for conditional rendering; Angular
   * will re-render the template whenever the signal changes.
   */
  readonly slotEnabledMap = computed<Map<string, boolean>>(() => {
    if (!this._enabled()) return new Map();
    return new Map(this._slots().map(s => [s.id, s.enabled === true]));
  });

  // ── Constructor ─────────────────────────────────────────────────────────────

  constructor(
    private readonly http: HttpClient,
    private readonly auth: AuthService,
  ) {
    this._fetch();
  }

  // ── GPT bootstrap ───────────────────────────────────────────────────────────

  /**
   * Loads the Google Publisher Tag library and enables the pubads service.
   *
   * This is necessary because this is a headless Angular SPA — WordPress's PHP
   * `wp_head` action never fires in the browser, so `inject_gam_head_script()`
   * is dead code for this app. Without this call `googletag` is undefined and
   * every `googletag.cmd.push(...)` throws a ReferenceError. This method is the
   * *only* GPT bootstrap in the application.
   *
   * It deliberately does **not** define any slots. Slot definition is owned by
   * GamService, which pairs each `defineSlot` with a matching `destroySlots`
   * when the container unmounts. Defining slots up front here is what made
   * recreated containers (modal reopen, right panel reopen) render permanently
   * blank: their second `display()` was silently ignored by GPT because the slot
   * was already displayed and had never been destroyed.
   *
   * Two secondary benefits of moving definition out:
   *
   *  - No server-supplied value is concatenated into executable JavaScript any
   *    more. The previous version string-interpolated `unit` and `div` from the
   *    REST response into an inline <script>, which was a script-injection
   *    surface if the WordPress options were ever tampered with.
   *  - `enableServices()` runs once here, not per slot.
   *
   * `singleRequest: true` is kept: when several containers mount in the same
   * tick (the modal mounts two slots at once) GPT batches them into one request.
   * Because slots are now defined lazily rather than all up front, batching only
   * covers slots that mount together, which is the intended behaviour.
   *
   * Called once on the first successful /ads/config fetch when enabled === true.
   * Safe to call multiple times — the `_gptBooted` guard prevents double-init.
   */
  private _bootGpt(): void {
    if (!isPlatformBrowser(this.platformId)) return; // SSR guard
    if (this._gptBooted) return;
    this._gptBooted = true;

    const libScript = this.document.createElement('script');
    libScript.async = true;
    libScript.crossOrigin = 'anonymous';
    libScript.src = AdService.GPT_SRC;
    this.document.head.appendChild(libScript);

    // Configure via a real function rather than an injected <script> element.
    const w = this.document.defaultView as (Window & { googletag?: GptBootstrap }) | null;
    if (!w) return;

    const gt = w.googletag ?? ({ cmd: [] } as unknown as GptBootstrap);
    w.googletag = gt;

    gt.cmd.push(() => {
      // Deprecated: pubads().enableSingleRequest(). See https://goo.gle/gpt-message#170
      gt.setConfig({ singleRequest: true });

      // Detach the ad *fetch* from `display()`, so GamService owns when every
      // request goes out and — the point — what correlator it carries.
      //
      // Measured (§8.6): with the fetch riding on `display()`, a slot that mounts
      // mid-session joins the correlator the page already has, and is therefore
      // judged against an auction the slots mounted earlier already won. The
      // article modal's `desktop_post_middle` filled 0/16 that way while the
      // right panel's `desktop_post_preview_middle` — same 300x250 demand — filled
      // 30/30. Disabling the preview slots took the modal slot to 14/14.
      //
      // With initial load disabled, GamService issues every first fetch as an
      // explicit `refresh(..., { changeCorrelator: true })`, so each mount is its
      // own pageview and competes for inventory on its own terms.
      //
      // This makes `display()` necessary but no longer sufficient: a slot whose
      // refresh never fires now shows nothing at all. `_scheduleInitialFetch()`
      // in GamService is the only thing standing between a mounted container and
      // a permanently empty one.
      //
      // Deprecated: pubads().disableInitialLoad(). See https://goo.gle/gpt-message#170
      // Must run before enableServices(). Same setting, new API — but it is the
      // §8.6 lever, so re-check modal vs panel fill after deploying.
      gt.setConfig({ disableInitialLoad: true });

      gt.enableServices();
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Return the slot definition for the given stable ID, or undefined if not
   * yet loaded or the ID does not exist.
   */
  getSlot(id: string): AdSlot | undefined {
    return this._slots().find(s => s.id === id);
  }

  /**
   * Toggle GAM on or off and optionally update per-slot states via
   * POST /ads/config (admin-only, requires JWT).
   * Updates the in-memory signals immediately on success.
   *
   * @param enabled      New global enabled flag.
   * @param slotStates   Map of slotId → enabled for per-slot configuration.
   *                     Only provided slots are updated; omitting this param
   *                     leaves existing per-slot states unchanged on the server.
   * @returns Observable<boolean> — the new global enabled value confirmed by the server.
   */
  setEnabled(
    enabled: boolean,
    slotStates: Record<string, boolean> = {},
  ): Observable<boolean> {
    const headers = this.auth.getAuthHeaders();
    return this.http
      .post<AdsConfigResponse>(
        AdService.ENDPOINT,
        { enabled, slot_states: slotStates },
        { headers },
      )
      .pipe(
        tap(res => {
          this._enabled.set(res.enabled === true);
          this._noFillRetries.set(AdService._clampRetries(res.no_fill_retries));
          if (Array.isArray(res.slots)) this._slots.set(res.slots);
        }),
        map(res => res.enabled === true),
        catchError(err => {
          console.error('[AdService] Failed to update ads config.', err?.message ?? err);
          throw err; // re-throw so callers can handle it
        })
      );
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Coerce the server's retry budget into the supported range.
   *
   * A missing or non-numeric value falls back to the default rather than 0: the
   * field is optional, and an older backend that never sends it should keep the
   * behaviour a current one has, not lose it silently.
   */
  private static _clampRetries(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return AdService.DEFAULT_NO_FILL_RETRIES;
    }
    return Math.max(0, Math.min(AdService.MAX_NO_FILL_RETRIES, Math.floor(value)));
  }

  private _fetch(): void {
    this.http
      .get<AdsConfigResponse>(AdService.ENDPOINT)
      .pipe(
        // Retry up to 2 times with exponential back-off (1.5 s, 3 s) to ride
        // out transient 504 Gateway Timeout errors on shared hosting without
        // leaving ads permanently disabled for the session.
        retry({
          count: 2,
          delay: (_err, attempt) => timer(attempt * 1500),
        }),
        catchError(err => {
          console.warn('[AdService] Failed to fetch ads config — ads disabled.', err?.message ?? err);
          return of(null);
        })
      )
      .subscribe(res => {
        if (res) {
          this._enabled.set(res.enabled === true);
          this._noFillRetries.set(AdService._clampRetries(res.no_fill_retries));
          const slots = Array.isArray(res.slots) ? res.slots : [];
          this._slots.set(slots);

          // Load GPT when ads are enabled. Individual slots are defined by
          // GamService as their containers mount.
          if (res.enabled === true && slots.length > 0) {
            this._bootGpt();
          }
        }
        // Mark ready regardless of success/failure so UI doesn't stay blank.
        this._ready.set(true);
      });
  }
}
