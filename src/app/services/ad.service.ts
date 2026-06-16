import { Injectable, computed, signal, Signal, inject, PLATFORM_ID } from '@angular/core';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { catchError, map, Observable, of, tap } from 'rxjs';
import { WP_BASE_URL } from '../config';
import { AuthService } from './auth.service';

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
}

interface AdsConfigResponse {
  enabled: boolean;
  slots: AdSlot[];
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

  private readonly _enabled = signal<boolean>(false);
  private readonly _slots   = signal<AdSlot[]>([]);
  private readonly _ready   = signal<boolean>(false);

  /** True once the GPT library tag and defineSlot init block have been injected. */
  private _gptInitialized = false;

  /** Whether GAM is globally enabled on the WordPress side. */
  readonly enabled: Signal<boolean> = this._enabled.asReadonly();

  /** Full slot list (empty until the fetch resolves). */
  readonly slots: Signal<AdSlot[]> = this._slots.asReadonly();

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

  // ── GPT head-script injection ───────────────────────────────────────────────

  /**
   * Injects the Google Publisher Tag library and slot-definition init block
   * into <head>, mirroring exactly what the WordPress wp_head hook does.
   *
   * This is necessary because this is a headless Angular SPA — WordPress's
   * PHP `wp_head` action never fires in the browser.  Without this call,
   * `googletag` is undefined and every `googletag.cmd.push(...)` in
   * AdSlotComponent throws a ReferenceError.
   *
   * Called once on the first successful /ads/config fetch when enabled === true.
   * Safe to call multiple times — the `_gptInitialized` guard prevents double-init.
   *
   * Script structure mirrors the PHP inject_gam_head_script() output:
   *
   *   <script async src="gpt.js" crossorigin="anonymous"></script>
   *   <script>
   *     window.googletag = window.googletag || {cmd: []};
   *     googletag.cmd.push(function() {
   *       googletag.defineSlot('/unit', [sizes], 'div').addService(googletag.pubads());
   *       ...
   *       googletag.pubads().enableSingleRequest();
   *       googletag.enableServices();
   *     });
   *   </script>
   *
   * @param slots  Full slot list from /ads/config (all slots, not just enabled ones —
   *               GPT SRP requires all slots to be defined up front).
   */
  private _initGpt(slots: AdSlot[]): void {
    if (!isPlatformBrowser(this.platformId)) return; // SSR guard
    if (this._gptInitialized) return;
    this._gptInitialized = true;

    const head = this.document.head;

    // 1. Async GPT library tag (equivalent to the <script async src="gpt.js"> in wp_head)
    const libScript = this.document.createElement('script');
    libScript.async = true;
    libScript.crossOrigin = 'anonymous';
    libScript.src = AdService.GPT_SRC;
    head.appendChild(libScript);

    // 2. Inline init block: defineSlot for every slot + enableSingleRequest + enableServices
    //    All slots are defined regardless of their per-slot `enabled` flag because
    //    enableSingleRequest() batches the ad call for all defined slots at once.
    //    Per-slot visibility is controlled by whether display() is called (AdSlotComponent).
    const defineLines = slots.map(s => {
      const sizesJson = JSON.stringify(s.sizes);
      return `  googletag.defineSlot('${s.unit}', ${sizesJson}, '${s.div}').addService(googletag.pubads());`;
    }).join('\n');

    const initScript = this.document.createElement('script');
    initScript.text = [
      'window.googletag = window.googletag || {cmd: []};',
      'googletag.cmd.push(function() {',
      defineLines,
      '  googletag.pubads().enableSingleRequest();',
      '  googletag.enableServices();',
      '});',
    ].join('\n');
    head.appendChild(initScript);
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

  private _fetch(): void {
    this.http
      .get<AdsConfigResponse>(AdService.ENDPOINT)
      .pipe(
        catchError(err => {
          console.warn('[AdService] Failed to fetch ads config — ads disabled.', err?.message ?? err);
          return of(null);
        })
      )
      .subscribe(res => {
        if (res) {
          this._enabled.set(res.enabled === true);
          const slots = Array.isArray(res.slots) ? res.slots : [];
          this._slots.set(slots);

          // Inject GPT library + defineSlot init into <head> when ads are enabled.
          // This is the headless-Angular equivalent of WordPress's wp_head hook.
          if (res.enabled === true && slots.length > 0) {
            this._initGpt(slots);
          }
        }
        // Mark ready regardless of success/failure so UI doesn't stay blank.
        this._ready.set(true);
      });
  }
}
