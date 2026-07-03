import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

/**
 * Core Web Vitals collected this session.
 * All values are milliseconds except `cls` (unitless layout-shift score).
 */
export interface WebVitals {
  /** Time To First Byte (navigation responseStart). */
  ttfb?: number;
  /** First Contentful Paint. */
  fcp?: number;
  /** Largest Contentful Paint (latest candidate). */
  lcp?: number;
  /** Cumulative Layout Shift (session score, excluding user-initiated shifts). */
  cls?: number;
  /** Interaction to Next Paint (worst observed interaction). */
  inp?: number;
  /** DOM Content Loaded. */
  dcl?: number;
  /** Full load event. */
  load?: number;
}

/**
 * Dependency-free Real-User-Monitoring (RUM) for Core Web Vitals.
 *
 * Why no library?
 *   The project constraint forbids third-party tools/services. This uses only
 *   the browser-native `PerformanceObserver` / Navigation Timing APIs, so it
 *   ships zero extra bytes of dependency and sends nothing off-device by default.
 *
 * What it does:
 *   - Observes TTFB, FCP, LCP, CLS, INP for the current page.
 *   - Publishes the live snapshot on `window.__dnWebVitals` for inspection and
 *     logs a one-line summary to the console when the page is hidden/unloaded.
 *
 * Beaconing (OFF by default — high-traffic safe):
 *   Field collection is intentionally opt-in to avoid a per-pageview write
 *   hotspot on the origin (which would defeat the scalability goal). To enable,
 *   set BOTH a target URL and an optional sample rate before load, e.g.:
 *     window.__dnVitalsBeaconUrl  = '/wp/wp-json/digital-newspaper/v1/rum';
 *     window.__dnVitalsSampleRate = 0.05;   // 5% of sessions
 *   When a URL is present, a sampled `navigator.sendBeacon` fires once on
 *   visibilitychange→hidden. Until a validated endpoint exists, leave it unset.
 */
@Injectable({ providedIn: 'root' })
export class WebVitalsService {

  private readonly platformId = inject(PLATFORM_ID);
  private readonly vitals: WebVitals = {};
  private _started = false;

  /** Snapshot of the metrics collected so far. */
  get snapshot(): Readonly<WebVitals> {
    return { ...this.vitals };
  }

  /**
   * Begin observing. Idempotent and browser-only; safe to call from
   * AppComponent.ngOnInit. Never throws.
   */
  start(): void {
    if (this._started || !isPlatformBrowser(this.platformId)) return;
    this._started = true;

    try {
      this.collectNavigationTiming();
      this.observePaint();
      this.observeLcp();
      this.observeCls();
      this.observeInp();
      this.publish();

      // Flush a final snapshot when the user leaves / backgrounds the tab.
      document.addEventListener(
        'visibilitychange',
        () => { if (document.visibilityState === 'hidden') this.finalize(); },
        { once: false },
      );
    } catch {
      // RUM must never affect the app — swallow any environment quirk.
    }
  }

  // ── Collectors ─────────────────────────────────────────────────────────────

  private collectNavigationTiming(): void {
    try {
      const nav = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined;
      if (!nav) return;
      this.vitals.ttfb = round(nav.responseStart);
      this.vitals.dcl = round(nav.domContentLoadedEventEnd);
      this.vitals.load = round(nav.loadEventEnd);
    } catch { /* ignore */ }
  }

  private observePaint(): void {
    this.safeObserve('paint', list => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') {
          this.vitals.fcp = round(entry.startTime);
        }
      }
      this.publish();
    });
  }

  private observeLcp(): void {
    this.safeObserve('largest-contentful-paint', list => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) {
        this.vitals.lcp = round(last.startTime);
        this.publish();
      }
    }, { buffered: true } as PerformanceObserverInit);
  }

  private observeCls(): void {
    let cls = 0;
    this.safeObserve('layout-shift', list => {
      for (const entry of list.getEntries() as unknown as Array<{
        value: number; hadRecentInput: boolean;
      }>) {
        if (!entry.hadRecentInput) cls += entry.value;
      }
      this.vitals.cls = Math.round(cls * 1000) / 1000;
      this.publish();
    });
  }

  private observeInp(): void {
    let worst = 0;
    this.safeObserve('event', list => {
      for (const entry of list.getEntries() as PerformanceEntry[]) {
        const dur = (entry as PerformanceEntry & { duration: number }).duration;
        if (dur > worst) worst = dur;
      }
      this.vitals.inp = round(worst);
      this.publish();
    }, { durationThreshold: 40 } as PerformanceObserverInit);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private safeObserve(
    type: string,
    cb: (list: PerformanceObserverEntryList) => void,
    init: PerformanceObserverInit = {},
  ): void {
    try {
      if (typeof PerformanceObserver === 'undefined') return;
      const supported = (PerformanceObserver as unknown as {
        supportedEntryTypes?: string[];
      }).supportedEntryTypes;
      if (supported && !supported.includes(type)) return;
      const obs = new PerformanceObserver(cb);
      obs.observe({ type, buffered: true, ...init } as PerformanceObserverInit);
    } catch { /* unsupported entry type — skip */ }
  }

  private publish(): void {
    try {
      (window as unknown as { __dnWebVitals?: WebVitals }).__dnWebVitals =
        this.snapshot as WebVitals;
    } catch { /* ignore */ }
  }

  private _finalized = false;
  private finalize(): void {
    if (this._finalized) return;
    this._finalized = true;
    this.publish();

    try {
      // Always log a concise summary — gives an at-a-glance field baseline
      // in DevTools without any external dependency or network call.
      console.info('[WebVitals]', JSON.stringify(this.snapshot));
    } catch { /* ignore */ }

    // Opt-in, sampled beacon. Off unless a target URL is configured.
    try {
      const w = window as unknown as {
        __dnVitalsBeaconUrl?: string;
        __dnVitalsSampleRate?: number;
      };
      const url = w.__dnVitalsBeaconUrl;
      if (!url || typeof navigator.sendBeacon !== 'function') return;
      const rate = typeof w.__dnVitalsSampleRate === 'number' ? w.__dnVitalsSampleRate : 0;
      if (rate <= 0 || Math.random() > rate) return;
      const body = JSON.stringify({
        ...this.snapshot,
        url: location.pathname,
        ua: navigator.userAgent,
        ts: new Date().toISOString(),
      });
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    } catch { /* best-effort */ }
  }
}

function round(n: number | undefined): number | undefined {
  return typeof n === 'number' && isFinite(n) ? Math.round(n) : undefined;
}
