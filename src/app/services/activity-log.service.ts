import { Injectable, OnDestroy, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AuthService } from './auth.service';
import { WP_BASE_URL } from '../config';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActivityLogEntry {
  id: string;
  userId: number;
  displayName: string;
  role: string;
  action: string;
  label: string;
  details: Record<string, string>;
  ip: string;
  createdAt: string;
}

export interface ActivityLogResponse {
  total: number;
  page: number;
  per_page: number;
  sort_by: string;
  sort_dir: string;
  entries: ActivityLogEntry[];
  users: { userId: number; displayName: string }[];
}

export interface ActivityLogFilters {
  action?: string;
  userId?: number;
  from?: string;        // YYYY-MM-DD
  to?: string;          // YYYY-MM-DD
  search?: string;      // display_name LIKE
  sort_by?: 'created_at' | 'user_id' | 'action' | 'display_name';
  sort_dir?: 'asc' | 'desc';
  page?: number;
  per_page?: number;
}

/** Queued client-side event (not yet flushed to server). */
interface QueuedEvent {
  action: string;
  label: string;
  details: Record<string, string>;
  timestamp: string;   // ISO-8601, client clock
}

// ─── Action label map ────────────────────────────────────────────────────────

export const ACTION_LABELS: Record<string, string> = {
  // Server-side actions
  login:                  'Logged in',
  logout:                 'Logged out',
  save_data:              'Saved newspaper data',
  restore_backup:         'Restored backup',
  rebuild_from_sections:  'Rebuilt from section posts',
  clear_activity_log:     'Cleared activity log',
  // Client-side navigation
  page_select:            'Opened page',
  page_edit:              'Edited page',
  page_add:               'Added new page',
  page_delete:            'Deleted page',
  page_save:              'Saved page',
  page_cancel:            'Cancelled page edit',
  section_add:            'Added news item',
  section_edit:           'Edited news item',
  section_delete:         'Deleted news item',
  section_save:           'Saved news item',
  section_cancel:         'Cancelled news item edit',
  cropper_open:           'Opened image cropper',
  cropper_apply:          'Applied crop',
  cropper_close:          'Closed cropper',
  image_upload:           'Uploaded image',
  image_upload_page:      'Uploaded page image',
  image_upload_thumb:     'Uploaded thumbnail',
  image_upload_logo:      'Uploaded logo',
  date_change:            'Changed date',
  edition_change:         'Changed edition',
  edition_add:            'Added new edition',
  edition_label_save:     'Saved edition labels',
  date_add:               'Added new date',
  export_download:        'Downloaded backup',
  import_applied:         'Imported backup',
  import_open:            'Opened import dialog',
  bulk_xml_import:        'Bulk XML/Excel import',
  settings_save:          'Saved settings',
  settings_open:          'Opened settings tab',
  view_viewer:            'Navigated to viewer',
  nav_to_pages:           'Navigated to pages',
  nav_to_sections:        'Navigated to sections',
  section_preview_open:   'Opened section preview',
  page_preview_open:      'Opened page preview',
  bulk_xml_open:          'Opened bulk import',
  rebuild_requested:      'Requested data rebuild',
  warm_cache_requested:   'Requested cache warm',
  lock_force_release:     'Force-released edit lock',
};

export const ACTION_COLOR: Record<string, string> = {
  login: 'log-blue', logout: 'log-blue', save_data: 'log-green',
  restore_backup: 'log-amber', rebuild_from_sections: 'log-amber',
  clear_activity_log: 'log-red', page_delete: 'log-red', section_delete: 'log-red',
  page_save: 'log-green', section_save: 'log-green', settings_save: 'log-green',
  image_upload: 'log-green', image_upload_page: 'log-green',
  image_upload_thumb: 'log-green', image_upload_logo: 'log-green',
  export_download: 'log-blue', import_applied: 'log-amber',
  bulk_xml_import: 'log-green', lock_force_release: 'log-red',
};

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ActivityLogService implements OnDestroy {
  private readonly apiBase = `${WP_BASE_URL}/wp-json/digital-newspaper/v1`;

  /** Stable browser session ID — persists for the life of the tab. */
  private readonly sessionId = this.makeSessionId();

  /** Client-side event queue — flushed every 30 s or when ≥ 10 events. */
  private queue: QueuedEvent[] = [];
  private flushTimer?: ReturnType<typeof setInterval>;

  /** Tracks which display_names we know, for filter dropdown. */
  knownUsers: { userId: number; displayName: string }[] = [];

  /** Bound reference so we can call removeEventListener in ngOnDestroy. */
  private readonly onUnload = () => this.flushSync();

  private readonly platformId = inject(PLATFORM_ID);
  private get isBrowser(): boolean { return isPlatformBrowser(this.platformId); }

  constructor(private http: HttpClient, private auth: AuthService) {
    // Auto-flush on a 30 s interval (browser only — server has no persistent state)
    if (this.isBrowser) {
      this.flushTimer = setInterval(() => this.flush(), 30_000);
      // Flush remaining events when the browser tab is closed
      window.addEventListener('beforeunload', this.onUnload);
    }
  }

  ngOnDestroy(): void {
    if (this.isBrowser) {
      window.removeEventListener('beforeunload', this.onUnload);
    }
    clearInterval(this.flushTimer);
    this.flush();   // flush any remaining queued events before the service is torn down
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Queue a user action.  Does NOT make an HTTP request immediately.
   * The queue is flushed automatically.
   *
   * @param action  Machine-readable key (see ACTION_LABELS)
   * @param details Optional extra context shown in the log table
   */
  track(action: string, details: Record<string, string> = {}): void {
    if (!this.auth.isAuthenticated()) return;
    this.queue.push({
      action,
      label: ACTION_LABELS[action] ?? action,
      details,
      timestamp: new Date().toISOString(),
    });
    // Flush immediately when queue is full (10 events)
    if (this.queue.length >= 10) this.flush();
  }

  /** Alias for backward compatibility with existing logClientEvent() calls. */
  logClientEvent(action: string, details: Record<string, string> = {}): void {
    this.track(action, details);
  }

  /** Flush all queued events to the server now (async, fire-and-forget). */
  flush(): void {
    if (!this.queue.length || !this.auth.isAuthenticated()) return;
    const events = this.queue.splice(0);
    const headers = this.auth.getAuthHeaders();
    this.http.post(
      `${this.apiBase}/activity-log/batch`,
      { sessionId: this.sessionId, events },
      { headers }
    ).pipe(catchError(() => of(null))).subscribe();
  }

  /**
   * Flush remaining events synchronously using keepalive fetch (survives tab close).
   *
   * sendBeacon is NOT used here because it cannot carry custom request headers —
   * the JWT Authorization token would be stripped, causing the server to return
   * 401 Unauthorized and silently discard all queued events.
   *
   * fetch with keepalive:true supports headers and is kept alive by the browser
   * even after the page unloads.  It is supported in all modern browsers.
   */
  private flushSync(): void {
    if (!this.queue.length || !this.auth.isAuthenticated()) return;
    const events = this.queue.splice(0);
    const headers = this.auth.getAuthHeaders();
    // Use /?rest_route= form so the WAF interceptor rewrite also applies here
    const url = `${this.apiBase}/activity-log/batch`.replace('/wp-json/', '/?rest_route=/');
    const body = JSON.stringify({ sessionId: this.sessionId, events });
    try {
      fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body,
        keepalive: true,      // browser keeps this request alive after page unload
        credentials: 'include',
      }).catch(() => { /* best-effort — ignore failures on unload */ });
    } catch { /* silently ignore */ }
  }

  // ─── Server queries ──────────────────────────────────────────────────────

  getLogs(filters: ActivityLogFilters = {}): Observable<ActivityLogResponse> {
    const headers = this.auth.getAuthHeaders();
    const params: Record<string, string> = {};
    if (filters.action)   params['action']   = filters.action;
    if (filters.userId)   params['userId']   = String(filters.userId);
    if (filters.from)     params['from']     = filters.from;
    if (filters.to)       params['to']       = filters.to;
    if (filters.search)   params['search']   = filters.search;
    if (filters.sort_by)  params['sort_by']  = filters.sort_by;
    if (filters.sort_dir) params['sort_dir'] = filters.sort_dir;
    if (filters.page)     params['page']     = String(filters.page);
    if (filters.per_page) params['per_page'] = String(filters.per_page);

    const qs = new URLSearchParams(params).toString();
    const url = `${this.apiBase}/activity-log${qs ? '?' + qs : ''}`;

    return this.http.get<ActivityLogResponse>(url, { headers }).pipe(
      catchError(() => of({
        total: 0, page: 1, per_page: 50, sort_by: 'created_at', sort_dir: 'DESC',
        entries: [], users: []
      }))
    );
  }

  clearLogs(): Observable<{ cleared: boolean }> {
    const headers = this.auth.getAuthHeaders();
    return this.http.delete<{ cleared: boolean }>(
      `${this.apiBase}/activity-log`, { headers }
    ).pipe(catchError(() => of({ cleared: false })));
  }

  /** Client-side CSV export of whatever is currently shown in the table. */
  exportCsv(entries: ActivityLogEntry[]): void {
    if (!this.isBrowser) return;
    const cols = ['Date/Time', 'User', 'Role', 'Action', 'Details', 'IP'];
    const rows = entries.map(e => [
      e.createdAt,
      e.displayName,
      e.role,
      e.label || (ACTION_LABELS[e.action] ?? e.action),
      Object.entries(e.details ?? {}).map(([k, v]) => `${k}=${v}`).join('; '),
      e.ip,
    ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));

    const csv = [cols.join(','), ...rows].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `user-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  getActionLabel(action: string): string {
    return ACTION_LABELS[action] ?? action;
  }

  getActionColor(action: string): string {
    return ACTION_COLOR[action] ?? 'log-default';
  }

  private makeSessionId(): string {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) {
      // SSR — generate a throwaway ID; this service is not used server-side.
      return Math.random().toString(36).slice(2);
    }
    try {
      let id = sessionStorage.getItem('dn_sid');
      if (!id) {
        id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem('dn_sid', id);
      }
      return id;
    } catch { return Math.random().toString(36).slice(2); }
  }
}
