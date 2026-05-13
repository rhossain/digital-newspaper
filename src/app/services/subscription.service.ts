import { Injectable, Injector } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, of, throwError, TimeoutError } from 'rxjs';
import { catchError, map, tap, timeout } from 'rxjs/operators';
import { WP_BASE_URL } from '../config';
import { AuthService } from './auth.service';
import type {
  SubscriptionPlan,
  SubscriptionStatus,
  SubscriptionOrder,
  CheckoutRequest,
  CheckoutResponse,
} from '../models/subscription.models';

/**
 * Manages subscription plans and per-user subscription status.
 *
 * Status is cached in sessionStorage (cleared on tab close) so a returning
 * user never sees stale access granted from a previous session, while
 * avoiding redundant API calls within the same browsing session.
 *
 * Plans are cached in memory for the lifetime of the application.
 */
@Injectable({
  providedIn: 'root',
})
export class SubscriptionService {
  private readonly plansUrl          = `${WP_BASE_URL}/wp-json/digital-newspaper/v1/subscription/plans`;
  private readonly statusUrl         = `${WP_BASE_URL}/wp-json/digital-newspaper/v1/subscription/status`;
  private readonly checkoutUrl       = `${WP_BASE_URL}/wp-json/digital-newspaper/v1/subscription/checkout`;
  private readonly ordersUrl         = `${WP_BASE_URL}/wp-json/digital-newspaper/v1/subscription/orders`;
  private readonly settingsUrl       = `${WP_BASE_URL}/wp-json/digital-newspaper/v1/subscription/settings`;
  private readonly checkoutTokenUrl  = `${WP_BASE_URL}/wp-json/digital-newspaper/v1/auth/checkout-token`;

  private readonly STATUS_CACHE_KEY = 'dn_sub_status';

  /** In-memory plan cache — plans change rarely; no need to re-fetch per navigation. */
  private plansCache: SubscriptionPlan[] | null = null;

  /**
   * Current subscription status for the logged-in user.
   * Starts as null (unknown / not yet fetched).
   * Set to { hasActiveSubscription: false } when the user is not authenticated.
   */
  readonly status$ = new BehaviorSubject<SubscriptionStatus | null>(
    this.readCachedStatus()
  );

  constructor(private http: HttpClient, private injector: Injector) {}

  /** Lazy getter — resolves AuthService only when first called, avoiding the constructor-level circular dep. */
  private get auth(): AuthService {
    return this.injector.get(AuthService);
  }

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  /**
   * Filters a plan list to only those applicable to a given access mode.
   * Plans with no accessMode (or 'both') are shown for every mode.
   * This is a pure static helper so the subscription wall and admin panel
   * can both use it without injecting the full service.
   */
  static filterForMode(plans: SubscriptionPlan[], mode: import('../models/subscription.models').AccessMode): SubscriptionPlan[] {
    return plans.filter(p => !p.accessMode || p.accessMode === 'both' || p.accessMode === mode);
  }

  /** Fetches the list of available subscription plans. Uses in-memory cache. */
  loadPlans(): Observable<SubscriptionPlan[]> {
    if (this.plansCache !== null && this.plansCache.length > 0) {
      return of(this.plansCache);
    }
    return this.http.get<SubscriptionPlan[]>(this.plansUrl).pipe(
      timeout(15_000),
      tap((plans) => {
        if (plans.length > 0) { this.plansCache = plans; }
      }),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(() => ({ type: 'timeout' }));
        }
        return throwError(() => err);
      })
    );
  }

  /** Always fetches from the server (no cache). Used by admin panel. */
  loadPlansForAdmin(): Observable<SubscriptionPlan[]> {
    return this.http.get<SubscriptionPlan[]>(this.plansUrl).pipe(
      timeout(15_000),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(() => ({ type: 'timeout' }));
        }
        return throwError(() => err);
      })
    );
  }

  /** Saves the full plan list via the admin REST endpoint. Requires auth. */
  savePlans(plans: SubscriptionPlan[]): Observable<SubscriptionPlan[]> {
    const headers = this.auth.getAuthHeaders();
    return this.http
      .post<{ success: boolean; plans: SubscriptionPlan[] }>(this.plansUrl, plans, { headers })
      .pipe(
        timeout(15_000),
        map((res) => res.plans),
        catchError((err) => {
          if (err instanceof TimeoutError) {
            return throwError(() => ({ type: 'timeout' }));
          }
          return throwError(() => err);
        })
      );
  }

  /** Saves subscription access-control settings via the dedicated REST endpoint. */
  saveAccessSettings(payload: { combinedMode: string; currency: string; loginUrl: string }): Observable<void> {
    const headers = this.auth.getAuthHeaders();
    return this.http.post<void>(this.settingsUrl, payload, { headers }).pipe(
      timeout(15_000),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(() => ({ type: 'timeout' }));
        }
        return throwError(() => err);
      })
    );
  }

  /** Clears the in-memory plan cache so the next loadPlans() refetches. */
  clearPlansCache(): void {
    this.plansCache = null;
  }

  /** Fetches all subscriber records for the admin dashboard. Requires admin auth. */
  loadOrders(): Observable<SubscriptionOrder[]> {
    const headers = this.auth.getAuthHeaders();
    return this.http.get<SubscriptionOrder[]>(this.ordersUrl, { headers }).pipe(
      timeout(15_000),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(() => ({ type: 'timeout' }));
        }
        return throwError(() => err);
      })
    );
  }

  /** Revokes a user's active subscription. Requires admin auth. */
  deleteSubscription(userId: number): Observable<void> {
    const headers = this.auth.getAuthHeaders();
    return this.http.delete<void>(`${this.ordersUrl}/${userId}`, { headers }).pipe(
      timeout(15_000),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(() => ({ type: 'timeout' }));
        }
        return throwError(() => err);
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Subscription status
  // ---------------------------------------------------------------------------

  /**
   * Fetches the subscription status for the currently authenticated user from
   * WordPress and updates status$.
   *
   * Callers should subscribe only when the user is authenticated.
   * Returns an observable that emits the status once and completes.
   */
  loadStatus(): Observable<SubscriptionStatus> {
    const headers = this.auth.getAuthHeaders();
    if (!headers['Authorization']) {
      const unauthenticated: SubscriptionStatus = { hasActiveSubscription: false };
      this.setStatus(unauthenticated);
      return of(unauthenticated);
    }

    return this.http
      .get<SubscriptionStatus>(this.statusUrl, { headers })
      .pipe(
        tap((status) => this.setStatus(status)),
        catchError((err) => {
          // On 401 the token has expired; clear it and reset status.
          if (err?.status === 401) {
            this.auth.logout();
          }
          // Always ensure status is non-null after this call completes so any
          // caller waiting on status$ (e.g. the startup edition-load gate) is
          // unblocked and the app can render.  Do not overwrite a value that
          // was already set (e.g. from sessionStorage) — only fill nulls.
          if (this.status$.value === null) {
            this.setStatus({ hasActiveSubscription: false });
          }
          return throwError(() => err);
        })
      );
  }

  /**
   * Convenience getter: returns the current cached status without an API call.
   * Returns null when status has not yet been fetched this session.
   */
  getStatus(): SubscriptionStatus | null {
    return this.status$.value;
  }

  /** True only when an active subscription is confirmed. */
  hasActiveSubscription(): boolean {
    return this.status$.value?.hasActiveSubscription === true;
  }

  // ---------------------------------------------------------------------------
  // Checkout
  // ---------------------------------------------------------------------------

  /**
   * Requests a WooCommerce checkout URL for the given plan.
   * The Angular app should redirect the user to the returned checkoutUrl.
   *
   * @param planId   WooCommerce product ID of the chosen plan.
   * @param returnUrl  The URL to return to after payment (must be in WP allowed origins).
   */
  getCheckoutUrl(planId: number, returnUrl: string): Observable<string> {
    const headers = this.auth.getAuthHeaders();
    const body: CheckoutRequest = { planId, returnUrl };
    return this.http
      .post<CheckoutResponse>(this.checkoutUrl, body, { headers })
      .pipe(map((res) => res.checkoutUrl));
  }

  /**
   * Requests a short-lived, one-time auto-login token from WordPress.
   * Append the returned token as ?dn_token=… to any checkout URL so that
   * WordPress recognises the Angular-authenticated user without requiring a
   * separate WP browser session.
   */
  getCheckoutToken(): Observable<string> {
    const headers = this.auth.getAuthHeaders();
    return this.http
      .post<{ token: string }>(this.checkoutTokenUrl, {}, { headers })
      .pipe(
        timeout(10_000),
        map((res) => res.token),
        catchError((err) => {
          if (err instanceof TimeoutError) {
            return throwError(() => ({ type: 'timeout' }));
          }
          return throwError(() => err);
        })
      );
  }

  // ---------------------------------------------------------------------------
  // Session cache management
  // ---------------------------------------------------------------------------

  /** Writes a new status to both the BehaviorSubject and sessionStorage. */
  setStatus(status: SubscriptionStatus): void {
    try {
      sessionStorage.setItem(this.STATUS_CACHE_KEY, JSON.stringify(status));
    } catch {
      // Storage unavailable (e.g. private browsing with strict settings) — ignore.
    }
    this.status$.next(status);
  }

  /**
   * Clears the cached subscription status.
   * Called by AuthService on logout so a subsequent login starts fresh.
   */
  clearStatus(): void {
    try {
      sessionStorage.removeItem(this.STATUS_CACHE_KEY);
    } catch {
      // ignore
    }
    this.plansCache = null;
    this.status$.next(null);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private readCachedStatus(): SubscriptionStatus | null {
    try {
      const raw = sessionStorage.getItem(this.STATUS_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // Minimal validation: must have the hasActiveSubscription boolean.
      if (typeof parsed?.hasActiveSubscription !== 'boolean') return null;
      return parsed as SubscriptionStatus;
    } catch {
      return null;
    }
  }
}
