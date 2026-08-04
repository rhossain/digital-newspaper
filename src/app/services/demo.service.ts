import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { environment } from '../../environments/environment';
import { WP_BASE_URL } from '../config';

/**
 * Demo / Showcase Mode client controller (§3.2, §3.5, §3.8).
 *
 * Responsibilities:
 *  - Bootstrap a per-tab, ephemeral session token in `sessionStorage`
 *    (`dn_demo_sid`). sessionStorage dies on tab/browser close, satisfying the
 *    "destroyed after closing the browser" requirement.
 *  - Expose that token to the HTTP interceptor, which attaches it as the
 *    `X-DN-Demo-Session` header.
 *  - Track whether this session "has overrides" (has made any edit). §3.8: a
 *    clean session must NOT send the header on public read endpoints so the CDN
 *    can share-cache them exactly as in production; only edited sessions pay the
 *    reconcile cost, and only on their changed pages.
 *  - Fire a `DELETE /demo/session` beacon on unload (§3.5) and provide a
 *    `reset()` for the "Reset my demo" button (§4.2 / §3.6).
 *
 * Entirely inert when `environment.demo` is false — every method short-circuits
 * so non-demo builds are unaffected.
 */
@Injectable({ providedIn: 'root' })
export class DemoService {
  private readonly platformId = inject(PLATFORM_ID);
  private get isBrowser(): boolean { return isPlatformBrowser(this.platformId); }

  private readonly SID_KEY       = 'dn_demo_sid';
  private readonly OVERRIDES_KEY = 'dn_demo_has_overrides';

  /**
   * Whether the WordPress plugin has "Demo / Showcase Mode" turned ON.
   * null = not checked yet. Set by checkServerStatus(). The banner and any demo
   * UI should require this to be true so toggling the server flag OFF hides the
   * demo alert even on a demo build.
   */
  readonly serverDemoMode = signal<boolean | null>(null);

  /** True only in a demo build running in a browser. */
  get enabled(): boolean {
    return !!(environment as { demo?: boolean }).demo && this.isBrowser;
  }

  /** True when this is a demo build AND the server confirms demo mode is ON. */
  get active(): boolean {
    return this.enabled && this.serverDemoMode() === true;
  }

  /**
   * Ask the server whether demo mode is currently enabled and cache the result
   * in the `serverDemoMode` signal. Best-effort; on failure it leaves the last
   * known value. Called once on app start (see AppComponent).
   */
  async checkServerStatus(): Promise<void> {
    if (!this.enabled) { this.serverDemoMode.set(false); return; }
    const url = `${WP_BASE_URL}/wp-json/digital-newspaper/v1/demo/status`;
    try {
      const res = await fetch(url, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
      });
      if (!res.ok) { this.serverDemoMode.set(false); return; }
      const data = await res.json() as { demoMode?: boolean };
      this.serverDemoMode.set(!!data?.demoMode);
    } catch {
      // Network/CORS failure — assume OFF so we never show a stale demo alert.
      this.serverDemoMode.set(false);
    }
  }

  /**
   * The per-tab session token, generated on first access. 32 lowercase hex
   * chars (crypto-random) to match the server's strict validation.
   */
  getToken(): string {
    if (!this.enabled) return '';
    let sid = '';
    try {
      sid = sessionStorage.getItem(this.SID_KEY) ?? '';
    } catch {
      return '';
    }
    if (!/^[a-f0-9]{32}$/.test(sid)) {
      sid = this.generateToken();
      try { sessionStorage.setItem(this.SID_KEY, sid); } catch { /* private mode */ }
    }
    return sid;
  }

  /** §3.8 — has this session made any edit yet? */
  hasOverrides(): boolean {
    if (!this.enabled) return false;
    try { return sessionStorage.getItem(this.OVERRIDES_KEY) === '1'; }
    catch { return false; }
  }

  /** Mark the session as edited (called by the interceptor on any mutating call). */
  markOverride(): void {
    if (!this.enabled) return;
    try { sessionStorage.setItem(this.OVERRIDES_KEY, '1'); } catch { /* ignore */ }
  }

  /**
   * Decide whether to attach the session header to a given request (§3.8).
   *  - Non-GET (writes) → always attach so the edit is session-scoped.
   *  - GET on a public read endpoint → attach only once the session has edits,
   *    so a clean session's reads stay CDN-shareable.
   *  - GET on a private/admin endpoint → always attach.
   */
  shouldAttachHeader(url: string, method: string, isPublicRead: boolean): boolean {
    if (!this.enabled) return false;
    if (method !== 'GET') return true;
    if (!isPublicRead) return true;
    return this.hasOverrides();
  }

  /** §3.5 — register the unload beacon that destroys the server-side session. */
  registerUnloadBeacon(): void {
    if (!this.enabled) return;
    const fire = () => this.sendDestroyBeacon();
    // pagehide is the reliable modern signal (fires on bfcache + close);
    // keep beforeunload as a fallback for older browsers.
    window.addEventListener('pagehide', fire);
    window.addEventListener('beforeunload', fire);
  }

  private sendDestroyBeacon(): void {
    const token = this.getToken();
    if (!token || !this.hasOverrides()) return; // nothing to clean for a clean session
    const url = `${WP_BASE_URL}/wp-json/digital-newspaper/v1/demo/session`;
    try {
      // sendBeacon can't set custom headers, so pass the token as a query param;
      // the server accepts either the header or ?sid= for the beacon path.
      navigator.sendBeacon?.(`${url}?sid=${encodeURIComponent(token)}`);
    } catch { /* best-effort; TTL + cron are the backstop */ }
  }

  /**
   * §4.2 / §3.6 — "Reset my demo": destroy the server overlay and clear the
   * local override flag so reads fall back to the golden seed. Returns a promise
   * that resolves when the reset request completes (best-effort).
   */
  async reset(): Promise<void> {
    if (!this.enabled) return;
    const token = this.getToken();
    const url = `${WP_BASE_URL}/wp-json/digital-newspaper/v1/demo/session`;
    try {
      await fetch(url, {
        method: 'DELETE',
        headers: { 'X-DN-Demo-Session': token, 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
      });
    } catch { /* ignore — the TTL/cron will clean up */ }
    try { sessionStorage.removeItem(this.OVERRIDES_KEY); } catch { /* ignore */ }
  }

  private generateToken(): string {
    const bytes = new Uint8Array(16);
    (globalThis.crypto ?? (globalThis as unknown as { msCrypto?: Crypto }).msCrypto)
      ?.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
}
