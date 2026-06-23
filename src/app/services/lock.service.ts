import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject, of, interval, Subscription, EMPTY, timer } from 'rxjs';
import { catchError, map, retry, switchMap, takeUntil, takeWhile } from 'rxjs/operators';
import { AuthService } from './auth.service';
import { WP_BASE_URL } from '../config';

export interface LockInfo {
  resource: string;
  userId: number;
  displayName: string;
  lockedAt: number;
  expiresAt: number;
}

export interface AcquireResult {
  /** True when the resource is locked by ANOTHER user. */
  lockedByOther: boolean;
  heldBy?: string;
  expiresAt?: number;
}

/**
 * Service that manages optimistic page/section locking.
 *
 * Workflow:
 *  1. Call acquireLock(resourceId) when a user starts editing a page.
 *  2. If { lockedByOther: false } → lock is ours; start heartbeat.
 *  3. If { lockedByOther: true }  → show the "X is editing" banner.
 *  4. Call releaseLock() on save, cancel, or navigate away.
 *  5. pollLocks() returns an Observable for the admin lock-management panel.
 *     It emits LockInfo[] on success, null on 404 (endpoint not yet deployed),
 *     and auto-completes after the first null so the interval stops.
 */
@Injectable({ providedIn: 'root' })
export class LockService implements OnDestroy {
  private readonly apiBase = `${WP_BASE_URL}/wp-json/digital-newspaper/v1`;

  private heldResource: string | null = null;
  private heartbeatSub?: Subscription;
  private destroy$ = new Subject<void>();

  /** Heartbeat interval: 30 s (server TTL is 90 s). */
  private readonly HEARTBEAT_MS = 30_000;
  /** Poll interval for the admin lock-management panel: 15 s. */
  private readonly POLL_MS = 15_000;

  /** Poll interval for per-resource lock status (non-admin users): 10 s. */
  private readonly RESOURCE_POLL_MS = 10_000;

  constructor(private http: HttpClient, private auth: AuthService) {}

  ngOnDestroy(): void {
    this.stopHeartbeat();
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ─── Lock acquire / release ───────────────────────────────────────────────

  /**
   * Attempt to acquire a lock on the given resource.
   *
   * Returns:
   *  { lockedByOther: false } — lock acquired (or feature not deployed — fail-open).
   *  { lockedByOther: true  } — another user holds the lock.
   */
  acquireLock(resourceId: string): Observable<AcquireResult> {
    const headers = this.auth.getAuthHeaders();
    const url = `${this.apiBase}/locks/${encodeURIComponent(resourceId)}`;

    return this.http.post<any>(url, {}, { headers }).pipe(
      map(res => ({ lockedByOther: false, expiresAt: res.expiresAt } as AcquireResult)),
      catchError(err => {
        if (err?.status === 423) {
          // Another user holds the lock
          return of({
            lockedByOther: true,
            heldBy:     err.error?.heldBy ?? 'Another user',
            expiresAt:  err.error?.expiresAt,
          } as AcquireResult);
        }
        if (err?.status === 404) {
          // Plugin endpoint not deployed yet — fail open (allow editing)
          return of({ lockedByOther: false } as AcquireResult);
        }
        // Network / server error — fail open for usability
        console.warn('[LockService] acquireLock error (failing open):', err?.message ?? err);
        return of({ lockedByOther: false } as AcquireResult);
      })
    );
  }

  /** Release the held lock. Safe to call when no lock is held. */
  releaseLock(resourceId: string): Observable<void> {
    if (!resourceId) return of(void 0);
    const headers = this.auth.getAuthHeaders();
    const url = `${this.apiBase}/locks/${encodeURIComponent(resourceId)}`;

    return this.http.delete<any>(url, { headers }).pipe(
      map(() => void 0),
      catchError(() => of(void 0))   // silently ignore — release is best-effort
    );
  }

  // ─── Heartbeat ────────────────────────────────────────────────────────────

  /** Start sending heartbeats every 30 s to keep the lock alive. */
  startHeartbeat(resourceId: string): void {
    this.stopHeartbeat();
    this.heldResource = resourceId;
    const headers = this.auth.getAuthHeaders();
    const url = `${this.apiBase}/locks/${encodeURIComponent(resourceId)}/heartbeat`;

    this.heartbeatSub = interval(this.HEARTBEAT_MS)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.http.post<any>(url, {}, { headers }).pipe(
          // Transient connection-level failures (ERR_CONNECTION_RESET from
          // Imunify360 / LiteSpeed rate-limiting, brief network drops) surface
          // as status 0. Retry those a couple of times within the same beat so a
          // single blip doesn't let the 90 s lock TTL lapse. A real 404 (lock
          // gone / admin force-release) is rethrown immediately — never retried —
          // so force-release still takes effect promptly.
          retry({
            count: 2,
            delay: (err) => {
              if (err?.status === 404) throw err;
              return timer(4000);
            },
          }),
          catchError(err => {
            if (err?.status === 404) {
              // Lock was force-released by an admin (or expired server-side).
              console.warn('[LockService] Lock was released externally — stopping heartbeat.');
              this.stopHeartbeat();
            }
            // Transient errors after retries are exhausted: keep the interval
            // alive so the next scheduled beat tries again.
            return of(null);
          })
        ).subscribe();
      });
  }

  /** Stop the heartbeat (call on save / cancel / navigate-away). */
  stopHeartbeat(): void {
    this.heartbeatSub?.unsubscribe();
    this.heartbeatSub = undefined;
    this.heldResource = null;
  }

  // ─── Admin poll ───────────────────────────────────────────────────────────

  /**
   * Check the current lock status of a single resource WITHOUT acquiring it.
   * Returns LockInfo if locked by someone, null if free or endpoint not found.
   */
  checkLock(resourceId: string): Observable<LockInfo | null> {
    const headers = this.auth.getAuthHeaders();
    const url = `${this.apiBase}/locks/${encodeURIComponent(resourceId)}`;

    return this.http.get<any>(url, { headers }).pipe(
      map(res => {
        if (res?.locked && res.heldBy) {
          return {
            resource:    resourceId,
            userId:      res.userId ?? 0,
            displayName: res.heldBy,
            lockedAt:    res.lockedAt ?? 0,
            expiresAt:   res.expiresAt ?? 0,
          } as LockInfo;
        }
        return null;
      }),
      catchError(() => of(null))
    );
  }

  /**
   * Polls the lock status of a single resource every 10 s.
   * Used by non-admin users to detect when a locked page becomes free.
   * Emits LockInfo while locked, null when free or on error.
   * Completes when takeUntil(destroy$) fires.
   */
  pollResourceLock(resourceId: string): Observable<LockInfo | null> {
    return interval(this.RESOURCE_POLL_MS).pipe(
      takeUntil(this.destroy$),
      switchMap(() => this.checkLock(resourceId))
    );
  }

  /**
   * Polls the server every 15 s for all active locks.
   * Used by the admin lock-management panel.
   *
   * Emits:
   *  LockInfo[]  — current list of active locks (may be empty).
   *  null        — endpoint returned 404 (plugin not yet deployed on the server).
   *                After emitting null the Observable completes automatically,
   *                so the subscriber's interval stops without any further requests.
   *
   * Other errors (network failure, 403, 500) emit [] and keep retrying.
   */
  pollLocks(): Observable<LockInfo[] | null> {
    const headers = this.auth.getAuthHeaders();
    const url     = `${this.apiBase}/locks`;

    return interval(this.POLL_MS).pipe(
      takeUntil(this.destroy$),
      switchMap(() =>
        this.http.get<{ locks: LockInfo[] }>(url, { headers }).pipe(
          map(res => res.locks ?? [] as LockInfo[]),
          catchError(err => {
            if (err?.status === 404) {
              // Endpoint not found — plugin needs to be deployed.
              // Return null as a stop signal; takeWhile below will complete.
              return of(null as null);
            }
            // Transient errors: keep polling, emit empty list
            return of([] as LockInfo[]);
          })
        )
      ),
      // Emit null once (inclusive) then complete — stops the interval automatically.
      takeWhile((result): result is LockInfo[] => result !== null, /* inclusive */ true)
    );
  }

  // ─── Admin force-release ──────────────────────────────────────────────────

  /** Force-release any lock on a resource (admin only). */
  forceReleaseLock(resourceId: string): Observable<void> {
    const headers = this.auth.getAuthHeaders();
    const url = `${this.apiBase}/locks/${encodeURIComponent(resourceId)}?force=1`;
    return this.http.delete<any>(url, { headers }).pipe(
      map(() => void 0),
      catchError(() => of(void 0))
    );
  }

  // ─── Tab-close cleanup ────────────────────────────────────────────────────

  /**
   * Release the held lock via a keepalive fetch that survives page unload.
   * Call this from window.beforeunload.
   */
  releaseOnUnload(resourceId: string): void {
    if (!resourceId) return;
    const headers = this.auth.getAuthHeaders();
    // Use ?rest_route= form — WAF interceptor doesn't run on native fetch
    const url = `${this.apiBase}/locks/${encodeURIComponent(resourceId)}`
      .replace('/wp-json/', '/?rest_route=/');
    try {
      fetch(url, {
        method: 'DELETE',
        headers: { ...headers, 'X-Requested-With': 'XMLHttpRequest' },
        keepalive: true,
        credentials: 'include',
      }).catch(() => { /* best-effort */ });
    } catch {
      // silently ignore if browser doesn't support keepalive
    }
  }
}
