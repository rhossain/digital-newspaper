import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap, map } from 'rxjs';

interface LoginResponse {
  token: string;
  user: {
    id: number;
    username: string;
    email: string;
    displayName: string;
  };
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly tokenKey = 'dn_wp_token';

  private get wpBaseUrl(): string {
    return ((window as any).__WP_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
  }

  constructor(private http: HttpClient) {}

  login(username: string, password: string): Observable<LoginResponse> {
    const loginUrl = `${this.wpBaseUrl}/wp-json/digital-newspaper/v1/auth/login`;
    return this.http.post<LoginResponse>(loginUrl, { username, password }).pipe(
      tap((response) => {
        if (response?.token) {
          localStorage.setItem(this.tokenKey, response.token);
        }
      })
    );
  }

  logout(): void {
    localStorage.removeItem(this.tokenKey);
  }

  getToken(): string | null {
    return localStorage.getItem(this.tokenKey);
  }

  isAuthenticated(): boolean {
    return !!this.getToken();
  }

  getAuthHeaders(): Record<string, string> {
    const token = this.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  verifyToken(): Observable<boolean> {
    const headers = this.getAuthHeaders();
    if (!headers['Authorization']) {
      return new Observable<boolean>((observer) => {
        observer.next(false);
        observer.complete();
      });
    }
    const meUrl = `${this.wpBaseUrl}/wp-json/digital-newspaper/v1/auth/me`;
    return this.http.get(meUrl, { headers }).pipe(
      map(() => true)
    );
  }
}
