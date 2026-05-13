import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap, map, timeout, catchError, throwError, TimeoutError } from 'rxjs';
import { WP_BASE_URL } from '../config';
import { SubscriptionService } from './subscription.service';

interface LoginResponse {
  token: string;
  user: {
    id: number;
    username: string;
    email: string;
    displayName: string;
    isAdmin?: boolean;
    subscription?: {
      hasActiveSubscription: boolean;
      expiresAt?: string | null;
      plan?: string | null;
      planSlug?: string | null;
    };
  };
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly tokenKey = 'dn_wp_token';
  private readonly usernameKey = 'dn_wp_displayname';
  private readonly wpBaseUrl = WP_BASE_URL;

  constructor(
    private http: HttpClient,
    private subscriptionService: SubscriptionService,
  ) {}

  login(username: string, password: string): Observable<LoginResponse> {
    const loginUrl = `${this.wpBaseUrl}/wp-json/digital-newspaper/v1/auth/login`;
    return this.http.post<LoginResponse>(loginUrl, { username, password }).pipe(
      timeout(15_000),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(() => ({ type: 'timeout' }));
        }
        return throwError(() => err);
      }),
      tap((response) => {
        if (response?.token) {
          localStorage.setItem(this.tokenKey, response.token);
          localStorage.setItem(this.usernameKey, response.user?.displayName || response.user?.username || '');
          // If the login response already carries subscription info (from /auth/me
          // extension), seed the cache immediately so components don't have to wait
          // for a separate /subscription/status call.
          if (response.user?.subscription) {
            // Login response now carries the full subscription shape — seed the
            // cache immediately so no extra /subscription/status call is needed.
            this.subscriptionService.setStatus({
              hasActiveSubscription: response.user.subscription.hasActiveSubscription,
              expiresAt:   response.user.subscription.expiresAt  ?? undefined,
              plan:        response.user.subscription.plan       ?? undefined,
              planSlug:    response.user.subscription.planSlug   ?? undefined,
            });
          } else {
            // Fallback (older plugin versions): fetch status in background.
            this.subscriptionService.loadStatus().subscribe({ error: () => {} });
          }
        }
      })
    );
  }

  logout(): void {
    const token = this.getToken();
    // Clear local state immediately so the UI reacts without waiting for the server.
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.usernameKey);
    this.subscriptionService.clearStatus();

    // Tell WordPress to invalidate the browser session cookie (fire-and-forget).
    if (token) {
      const logoutUrl = `${this.wpBaseUrl}/wp-json/digital-newspaper/v1/auth/logout`;
      this.http
        .post(logoutUrl, {}, { headers: { Authorization: `Bearer ${token}` } })
        .subscribe({ error: () => {} });
    }
  }

  register(username: string, email: string, password: string): Observable<LoginResponse> {
    const url = `${this.wpBaseUrl}/wp-json/digital-newspaper/v1/auth/register`;
    return this.http.post<LoginResponse>(url, { username, email, password }).pipe(
      timeout(15_000),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(() => ({ type: 'timeout' }));
        }
        return throwError(() => err);
      }),
      tap((response) => {
        if (response?.token) {
          localStorage.setItem(this.tokenKey, response.token);
          localStorage.setItem(this.usernameKey, response.user?.displayName || response.user?.username || '');
          // New accounts have no subscription — seed cache immediately.
          this.subscriptionService.setStatus({ hasActiveSubscription: false });
        }
      })
    );
  }

  getToken(): string | null {
    return localStorage.getItem(this.tokenKey);
  }

  getDisplayName(): string {
    return localStorage.getItem(this.usernameKey) || '';
  }

  isAuthenticated(): boolean {
    return !!this.getToken();
  }

  getAuthHeaders(): Record<string, string> {
    const token = this.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /**
   * Verifies the stored token against WordPress and resolves to `true` only if
   * the token is valid AND the user has editor/admin capabilities (`edit_posts`).
   * Resolves to `false` for valid tokens belonging to subscriber-only accounts.
   * Errors (network, 401) propagate to the caller's `error:` handler.
   */
  verifyToken(): Observable<boolean> {
    const headers = this.getAuthHeaders();
    if (!headers['Authorization']) {
      return new Observable<boolean>((observer) => {
        observer.next(false);
        observer.complete();
      });
    }
    const meUrl = `${this.wpBaseUrl}/wp-json/digital-newspaper/v1/auth/me`;
    return this.http.get<{ isAdmin?: boolean }>(meUrl, { headers }).pipe(
      map((res) => res?.isAdmin === true)
    );
  }
}
