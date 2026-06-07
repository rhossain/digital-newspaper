import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { tap, map, switchMap } from 'rxjs';
import { WP_BASE_URL } from '../config';

interface LoginResponse {
  token: string;
  user: {
    id: number;
    username: string;
    email: string;
    displayName: string;
    role: string;
  };
}

interface MeResponse {
  id: number;
  username: string;
  email: string;
  displayName: string;
  role: string;
}

/** Shape of the user profile persisted in localStorage under `dn_wp_user`. */
interface StoredUser {
  displayName: string;
  role: string;
  userId: number;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly tokenKey = 'dn_wp_token';
  private readonly userKey  = 'dn_wp_user';
  private readonly wpBaseUrl = WP_BASE_URL;

  constructor(private http: HttpClient) {}

  login(username: string, password: string): Observable<LoginResponse> {
    const loginUrl = `${this.wpBaseUrl}/wp-json/digital-newspaper/v1/auth/login`;
    const body = new URLSearchParams({ username, password }).toString();
    return this.http.post<LoginResponse>(loginUrl, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      withCredentials: true,
    }).pipe(
      map((response) => {
        if (!response?.token) {
          // Detect host-level security block (Imunify360, ModSecurity, etc.).
          // These return HTTP 200 with a JSON body that has no 'token' field.
          const resp = response as unknown as Record<string, unknown>;
          const serverMsg = typeof resp['message'] === 'string' ? resp['message']
            : typeof resp['error'] === 'string' ? resp['error'] : '';
          if (AuthService.isWafBlockMessage(serverMsg)) {
            throw new Error('WAF_BLOCKED:' + serverMsg);
          }
          throw new Error('NO_TOKEN');
        }
        return response;
      }),
      tap((response) => {
        if (response?.token) {
          localStorage.setItem(this.tokenKey, response.token);
          localStorage.setItem(this.userKey, JSON.stringify({
            displayName: response.user?.displayName ?? '',
            role: response.user?.role ?? 'editor',
            userId: response.user?.id ?? 0,
          }));
        }
      })
    );
  }

  /** Returns true when the server message looks like a WAF / bot-protection block. */
  static isWafBlockMessage(msg: string): boolean {
    const lower = msg.toLowerCase();
    return lower.includes('imunify') || lower.includes('bot-protection')
      || lower.includes('access denied') || lower.includes('blocked')
      || lower.includes('modsecurity') || lower.includes('cloudflare')
      || lower.includes('captcha');
  }

  logout(): void {
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.userKey);
  }

  private getStoredUser(): StoredUser | null {
    const raw = localStorage.getItem(this.userKey);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  getUserDisplayName(): string {
    return this.getStoredUser()?.displayName ?? '';
  }

  getUserRole(): string {
    return this.getStoredUser()?.role ?? 'editor';
  }

  /** Returns the WordPress user ID of the currently stored session, or 0 if unknown. */
  getUserId(): number {
    return this.getStoredUser()?.userId ?? 0;
  }

  /** Returns true only when the authenticated user has the WordPress administrator role. */
  isAdmin(): boolean {
    return this.isAuthenticated() && this.getUserRole() === 'administrator';
  }

  getToken(): string | null {
    return localStorage.getItem(this.tokenKey);
  }

  isAuthenticated(): boolean {
    const token = this.getToken();
    if (!token) return false;
    // Check expiry client-side to avoid stale-token UI flicker before the
    // server round-trip in verifyToken() completes.
    try {
      const parts = token.split('.');
      if (parts.length !== 3) { this.logout(); return false; }
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload?.exp && Math.floor(Date.now() / 1000) > payload.exp) {
        this.logout(); // Clear the expired token immediately
        return false;
      }
      // Cross-validate: the JWT sub claim must match the stored userId.
      // Catches stale profile data from a previous user remaining in localStorage
      // while a different user's token is present (e.g. partial overwrite).
      // Skipped when userId is absent (pre-fix sessions) — backward compatible.
      const storedUserId = this.getStoredUser()?.userId;
      if (storedUserId && payload?.sub && Number(payload.sub) !== Number(storedUserId)) {
        this.logout();
        return false;
      }
    } catch {
      this.logout();
      return false;
    }
    return true;
  }

  getAuthHeaders(): Record<string, string> {
    const token = this.getToken();
    // Send token in both Authorization and X-Authorization.
    // Apache on shared hosting (cPanel, Hostinger) strips the Authorization header
    // before PHP sees it; X-Authorization is a custom header Apache always passes through.
    return token
      ? { Authorization: `Bearer ${token}`, 'X-Authorization': `Bearer ${token}` }
      : {};
  }

  verifyToken(): Observable<boolean> {
    const headers = this.getAuthHeaders();
    if (!headers['Authorization']) {
      return of(false);
    }
    const meUrl = `${this.wpBaseUrl}/wp-json/digital-newspaper/v1/auth/me`;
    return this.http.get<MeResponse>(meUrl, { headers, withCredentials: true }).pipe(
      switchMap((user) => {
        // Guard: the user ID returned by the server must match the sub claim in
        // the stored JWT. A mismatch means server-side cookie auth silently
        // overrode the Bearer token — force logout so the UI never shows the
        // wrong user's name.
        const token = this.getToken();
        if (token) {
          try {
            const parts = token.split('.');
            if (parts.length === 3) {
              const payload = JSON.parse(
                atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
              );
              if (payload?.sub && user?.id && Number(payload.sub) !== Number(user.id)) {
                this.logout();
                return throwError(() => new Error('IDENTITY_MISMATCH'));
              }
            }
          } catch {
            this.logout();
            return throwError(() => new Error('TOKEN_DECODE_FAILED'));
          }
        }
        // Identity confirmed — refresh stored profile (role may have changed).
        if (user?.displayName !== undefined) {
          localStorage.setItem(this.userKey, JSON.stringify({
            displayName: user.displayName ?? '',
            role: user.role ?? 'editor',
            userId: user.id ?? 0,
          }));
        }
        return of(true as boolean);
      })
    );
  }
}
