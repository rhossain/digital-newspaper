import { Injectable, Signal, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { HttpClient, HttpResponse } from '@angular/common/http';
import { Observable, BehaviorSubject, Subject, Subscription, timer, forkJoin, interval, of, throwError } from 'rxjs';
import { tap, map, catchError, timeout, retry, switchMap, exhaustMap, debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { AuthService } from './auth.service';
import { WP_BASE_URL } from '../config';
import { clearHttpCache, evictEditionCache, evictSettingsCache, markForBrowserCacheBypass } from '../interceptors/http-cache.interceptor';
import { SettingsService } from './settings.service';
import { DateIndexService } from './date-index.service';
import { EditionCacheService } from './edition-cache.service';

export interface NewsSection {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
  imageUrl?: string;
  pageId?: number;
  linkedSectionIds?: string[];
  /**
   * The ID of the primary (main article) section within this section's link group.
   * Set automatically when the admin saves explicit linked sections — the earliest-created
   * linked section becomes the primary. Used by the viewer for deterministic ordering:
   * the primary always appears first in the right panel and modal, regardless of which
   * section is currently selected. Absent on old data → viewer falls back to ID-timestamp sort.
   */
  linkedSectionPrimary?: string;
  showCaption?: boolean;
  /** WordPress post ID returned by the PHP plugin after sync. Read-only from Angular. */
  wpPostId?: number;
  /** Origin of this section — 'xml' for bulk-imported, 'manual' for admin-created. */
  importSource?: 'xml' | 'manual';
}

export interface NewspaperPage {
  id: number;
  thumbnail: string;
  fullImage: string;
  /** Optional high-resolution image used in the crop selector. Falls back to fullImage if absent. */
  fullImageHiRes?: string;
  sections: NewsSection[];
  /** Multilingual page name keyed by language code, e.g. { en: 'Sports', bn: 'খেলাধুলা' } */
  pageLabels?: { [lang: string]: string };
  /** 'pending' = skeleton page created by XML import, no image yet. Absent or 'ready' = has image. */
  imageStatus?: 'pending' | 'ready';
}

export interface NewspaperEdition {
  date: string;          // Format: YYYY-MM-DD
  edition?: number;      // 1 = 1st edition (default), 2 = 2nd, etc.
  /** Multilingual labels keyed by language code, e.g. { en: 'Morning', bn: 'সকাল' } */
  editionLabels?: { [lang: string]: string };
  /** @deprecated Use editionLabels. Kept for backward compatibility with older data. */
  editionLabel?: string;
  pages: NewspaperPage[];
}

export interface GlobalSettings {
  logo?: {
    url: string;
    alt?: string;
    link?: string;
  };
  socialLinks?: {
    facebook?: string;
    twitter?: string;
    linkedin?: string;
    whatsapp?: string;
    instagram?: string;
    youtube?: string;
  };
  defaultDateMode: 'current' | 'specific';
  specificDate?: string; // Format: YYYY-MM-DD
  editor?: string;
  /** Multilingual editor name keyed by language code, e.g. { en: 'John Smith', bn: 'জন স্মিথ' } */
  editorLabels?: { [lang: string]: string };
  address?: {
    line1?: string;
    /** Multilingual Address Line 1 */
    line1Labels?: { [lang: string]: string };
    line2?: string;
    /** Multilingual Address Line 2 */
    line2Labels?: { [lang: string]: string };
    phone?: string;
    /** Multilingual phone display */
    phoneLabels?: { [lang: string]: string };
    email?: string;
    website?: string;
  };
  language?: 'en' | 'bn';
  showPagePagination?: boolean;
  showBetaBadge?: boolean;
  /** When true, the viewer shows an Under Maintenance page instead of normal content. */
  underMaintenance?: boolean;
  /** Custom message displayed on the Under Maintenance page. */
  maintenanceMessage?: string;
  /** Raw HTML string of <script> / <noscript> tags to inject into <head> (e.g. Google Analytics). */
  headScripts?: string;
  /** Site name appended to individual post/section page titles, e.g. "দৈনিক সংগ্রাম ই-পেপার". */
  othersPageTitle?: string;
  /**
   * Controls the encoding format for all new image uploads and auto-generated images.
   *  'webp' (default) — encode as WebP before upload (smaller files, same quality).
   *  'all'            — preserve the original file format (current/legacy behaviour).
   */
  imageFormat?: 'webp' | 'all';
}

export interface NewspaperData {
  settings?: GlobalSettings;
  editions: NewspaperEdition[];
  /**
   * Monotonically-increasing float timestamp stamped by PHP on every save.
   * Angular reads it on load and echoes it back on save; the server uses it
   * to detect concurrent-edit conflicts (optimistic concurrency control).
   */
  dataVersion?: number;
}

interface WpMediaItem {
  id: number;
  date?: string;
  source_url: string;
  title?: { rendered?: string };
  alt_text?: string;
}

interface MediaPageCandidate {
  date: string;
  pageNumber: number;
  url: string;
  label: string;
}

// ─── Export / Import types ───────────────────────────────────────────────────

export const SCHEMA_VERSION = 2;

export interface ExportMeta {
  exportedAt: string;
  schemaVersion: number;
  sourceUrl: string;
  exportScope: 'full' | 'current-date' | 'date-range';
  exportType: 'full' | 'settings-only' | 'editions-only';
  editionCount: number;
  dateRange?: { from: string; to: string };
}

export interface ExportPayload {
  meta: ExportMeta;
  settings?: GlobalSettings;
  editions?: NewspaperEdition[];
}

export interface ExportOptions {
  exportType: ExportMeta['exportType'];
  exportScope: ExportMeta['exportScope'];
  dateFrom?: string;
  dateTo?: string;
  currentDate?: string;
}

export interface BackupHistoryEntry {
  id: string;
  exportedAt: string;
  filename: string;
  exportScope: ExportMeta['exportScope'];
  exportType: ExportMeta['exportType'];
  editionCount: number;
  sizeKb: number;
  sourceUrl: string;
}

export interface ServerDataBackupSummary {
  index: number;
  createdAt: string;
  editionCount: number;
  pageCount: number;
  sectionCount: number;
  latestDates: string[];
}

export interface SaveDataOptions {
  allowRecoveredData?: boolean;
  forceEmptyOverwrite?: boolean;
  /** Bypass the optimistic-concurrency version check (admin force-save). */
  forceVersionOverwrite?: boolean;
}

export interface ImportValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ImportPreview {
  sourceUrl: string;
  currentUrl: string;
  urlMismatch: boolean;
  exportedAt: string;
  schemaVersion: number;
  exportType: ExportMeta['exportType'] | 'unknown';
  exportScope: ExportMeta['exportScope'] | 'unknown';
  incomingEditionCount: number;
  currentEditionCount: number;
  incomingDateRange: { from: string; to: string } | null;
  newEditions: string[];
  conflictingEditions: string[];
  hasSettings: boolean;
  hasEditions: boolean;
}

export interface ImportOptions {
  importSettings: boolean;
  importEditions: boolean;
  mergeMode: 'overwrite-all' | 'add-new' | 'add-and-replace';
  rewriteUrls: boolean;
  oldBaseUrl?: string;
  newBaseUrl?: string;
}

// ─── XML Import types ─────────────────────────────────────────────────────────

export interface XmlImportRow {
  title: string;
  content: string;
  date: string;           // YYYY-MM-DD
  edition: number;        // default 1
  page: number;
  derivedId: string;      // deterministic ID
  duplicateStatus: 'new' | 'duplicate-exact' | 'duplicate-key';
  importAction: 'skip' | 'overwrite' | 'import-as-new';
  assignedPageId: number; // may differ from XML page after manual reassignment
  rowIndex: number;
  rawTitle: string;       // pre-sanitization, for display
}

export interface XmlParseError {
  rowIndex: number;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface XmlImportResult {
  rows: XmlImportRow[];
  errors: XmlParseError[];
  totalRows: number;
  newCount: number;
  duplicateCount: number;
  errorCount: number;
  dateRange: { min: string; max: string };
}

export interface XmlImportSummary {
  created: number;
  updated: number;
  skipped: number;
  skeletonPagesCreated: number;
}

@Injectable({
  providedIn: 'root'
})
export class NewspaperDataService {
  private static readonly SETTINGS_CACHE_KEY = 'dn_global_settings';
  private static readonly BACKUP_HISTORY_KEY = 'dn_backup_history';
  private static readonly EMERGENCY_DRAFT_KEY = 'dn_emergency_local_draft';
  private static readonly MAX_HISTORY_ENTRIES = 20;

  private dataSubject!: BehaviorSubject<NewspaperData>;
  private currentDateSubject!: BehaviorSubject<string>;

  currentDate$!: Observable<string>;
  public data$!: Observable<NewspaperData>;

  /**
   * Signal-based read of `data$`.
   *
   * Components that have already migrated to Angular Signals can read
   * `dataService.data()` directly in templates — no `async` pipe or manual
   * `.subscribe()` / `.unsubscribe()` required.
   *
   * The `!` assertion is sound: both signals are initialised synchronously
   * inside the constructor (immediately after their source BehaviorSubjects),
   * before any external code can call into the service.
   *
   * Existing `data$.subscribe()` consumers continue to work unchanged —
   * these signals are purely additive.
   */
  data!: Signal<NewspaperData>;

  /**
   * Signal-based read of `currentDate$`.
   * @see data for the design rationale.
   */
  currentDate!: Signal<string>;

  /**
   * Emits the server's new dataVersion whenever the version poll detects
   * a remote change. Components subscribe to decide whether to silently
   * reload or warn the user before doing so.
   */
  readonly remoteDataChanged$ = new Subject<number>();

  private versionPollSub?: Subscription;
  private readonly versionUrl = `${WP_BASE_URL}/wp-json/digital-newspaper/v1/data/version`;
  
  // WordPress REST API base
  private assetsUrl = '/assets/newspaper-data.json';
  private readonly wpBaseUrl = WP_BASE_URL;
  private readonly apiUrl = `${WP_BASE_URL}/wp-json/digital-newspaper/v1/data`;
  private readonly mediaApiUrl = `${WP_BASE_URL}/wp-json/wp/v2/media`;
  private dataRecoveredFromMediaLibrary = false;

  private readonly platformId = inject(PLATFORM_ID);
  private get isBrowser(): boolean { return isPlatformBrowser(this.platformId); }

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private settingsService: SettingsService,
    private dateIndexService: DateIndexService,
    private editionCacheService: EditionCacheService,
  ) {
    const cachedSettings = NewspaperDataService._readCachedSettings();
    this.dataSubject = new BehaviorSubject<NewspaperData>({
      settings: cachedSettings || {
        defaultDateMode: 'current',
        socialLinks: {}
      },
      editions: []
    });
    this.currentDateSubject = new BehaviorSubject<string>(this.getTodayDate());
    this.currentDate$ = this.currentDateSubject.asObservable();
    this.data$ = this.dataSubject.asObservable();

    // ── Signal bridges (toSignal requires an active injection context) ────────
    // BehaviorSubject always emits synchronously so requireSync is safe here.
    // `initialValue` is set explicitly to avoid the `undefined` union type that
    // the overload without requireSync would add.
    this.data        = toSignal(this.data$,        { initialValue: this.dataSubject.value });
    this.currentDate = toSignal(this.currentDate$, { initialValue: this.currentDateSubject.value });

    // Debounce emergency-draft writes: atomic saves fire rapidly; serialising
    // the full dataset to JSON on every emission is expensive. 2 s is enough
    // to capture any crash that happens during active editing.
    this.dataSubject.pipe(debounceTime(2000)).subscribe(data => this.cacheEmergencyDraft(data));
  }

  // Date helper methods
  getTodayDate(): string {
    const today = new Date();
    // Use local date components instead of toISOString() which returns UTC and
    // would show the previous day for UTC+ timezones between midnight and their
    // UTC offset hour (e.g. Bangladesh UTC+6 would show the wrong date until 6 AM).
    const year  = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day   = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  formatDisplayDate(dateStr: string): string {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
  }

  setCurrentDate(date: string): void {
    this.currentDateSubject.next(date);
  }

  /**
   * Lazy hydration for a date whose editions aren't yet in the in-memory
   * `data.editions` array.
   *
   * Background: `loadDataFromGranular()` only hydrates editions for
   * `latestDate` + today for speed.  When the admin switches to an older
   * date via the date picker, the in-memory array doesn't contain its
   * editions, so `getEditionsByDate()` returns []. This helper fetches the
   * missing date via the granular `/data/editions/:date` endpoint (which
   * goes through `EditionCacheService`'s 4-layer cache) and merges the
   * result into `dataSubject` so all the synchronous `getEditionsByDate`/
   * `getEditionByDateAndNumber` reads "just work".
   *
   * Safe to call repeatedly — returns immediately if the date already has
   * editions in memory.  Emits and completes without modifying state on
   * any HTTP error so the caller can degrade gracefully.
   */
  /**
   * Force-evict a date from in-memory state and re-fetch from the server.
   * Use after an atomic save error: the server may have committed the write
   * before the HTTP response failed, so the in-memory view could be stale.
   * evictDateCache() must have been called first (removes HTTP + service caches).
   */
  reloadDate(date: string): Observable<void> {
    if (!date) return of(void 0);
    // Drop the date from the data subject so hydrateDateIfMissing will re-fetch.
    const current = this.dataSubject.value;
    this.dataSubject.next({
      ...current,
      editions: current.editions.filter(e => e.date !== date),
    });
    return this.hydrateDateIfMissing(date);
  }

  hydrateDateIfMissing(date: string): Observable<void> {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return of(void 0);
    }
    const current = this.dataSubject.value;
    const alreadyHas = current.editions.some(e => e.date === date);
    if (alreadyHas) {
      return of(void 0);
    }
    return this.editionCacheService.getEditionsForDate(date).pipe(
      tap(editions => {
        if (!Array.isArray(editions) || editions.length === 0) {
          return;
        }
        const next = this.dataSubject.value;
        // Defensive: re-filter in case another hydration raced.
        const otherEditions = next.editions.filter(e => e.date !== date);
        const merged = [...otherEditions, ...editions].sort((a, b) => {
          const d = b.date.localeCompare(a.date);
          return d !== 0 ? d : ((a.edition ?? 1) - (b.edition ?? 1));
        });
        this.dataSubject.next({ ...next, editions: merged });
      }),
      map(() => void 0),
      catchError(err => {
        console.warn('[NewspaperDataService] hydrateDateIfMissing failed for', date, err?.message ?? err);
        return of(void 0);
      })
    );
  }

  getCurrentDate(): string {
    return this.currentDateSubject.value;
  }

  /**
   * Primary data load — tries the fast granular endpoints first, then falls
   * back to the legacy monolithic blob endpoint.
   *
   * ── Why granular-first? ──────────────────────────────────────────────────
   * The legacy /data endpoint returns the ENTIRE dataset as one serialized
   * blob.  On a newspaper with 1+ years of editions that blob can exceed
   * 30–50 MB, causing PHP to exceed max_execution_time before returning a
   * response.  The granular endpoints are O(1) per option read and each
   * response is a few KB.
   *
   * ── Strategy ────────────────────────────────────────────────────────────
   * 1. Try `loadDataFromGranular()`:
   *      - GET /data/settings  (settings + dataVersion)
   *      - GET /data/dates     (list of all available dates)
   *      - GET /data/editions/{latestDate}  (today's / most-recent edition)
   *    Total payload: ~5–50 KB regardless of dataset size.
   *
   * 2. If ANY granular call fails (endpoint not found, timeout, WAF block),
   *    fall back to the legacy /data blob.  This preserves backward
   *    compatibility with servers that have an older plugin version.
   *
   * 3. If the legacy call also fails after 2 retries, serve the bundled
   *    empty asset so the UI shows a clear empty state rather than a crash.
   */
  loadData(): Observable<NewspaperData> {
    return this.loadDataFromGranular().pipe(
      catchError((granularErr) => {
        console.warn(
          '[NewspaperDataService] Granular endpoints failed — falling back to legacy /data blob. Reason:',
          granularErr?.message ?? granularErr
        );
        return this.loadDataFromLegacyBlob();
      }),
      catchError((err) => this.loadEmergencyDraftAfterApiFailure(err)),
      tap((data: NewspaperData) => {
        this.dataSubject.next(data);
        if (data.settings) {
          this.settingsService.apply(data.settings);
        }
        if (data.editions?.length) {
          this.dateIndexService.syncFromEditions(data.editions);
          this.editionCacheService.seedFromLoadedData(data.editions);
        }
      })
    );
  }

  /**
   * Fast granular load via the per-resource cacheable endpoints.
   *
   * Fetches settings + dates in parallel, then fetches editions for the
   * most-recent date (and today, if it differs).  Total request count: 3–4
   * tiny requests instead of one huge blob.
   *
   * Throws on any error so `loadData()` can fall back to the legacy path.
   */
  private loadDataFromGranular(): Observable<NewspaperData> {
    // Step 1: settings + dates index + current server version in parallel.
    // The version endpoint is tiny (~30 B) and must be fetched here so the
    // local dataVersion is NEVER reset to 0.  Resetting to 0 causes the
    // version poll to immediately fire remoteDataChanged$ on the very next
    // tick (because serverVersion > 0 is always true), producing the false
    // "Content updated by another user" toast on every reload.
    return forkJoin({
      settings: this.settingsService.fetch(),
      dates:    this.dateIndexService.fetch(),
      version:  this.http
        .get<{ dataVersion: number }>(this.versionUrl)
        .pipe(catchError(() => of({ dataVersion: 0 }))),
    }).pipe(
      // Step 2: load editions for the dates needed for initial display
      switchMap(({ settings, dates, version }) => {
        const today      = this.getTodayDate();
        const latestDate = dates[0] ?? today;

        // Load the most-recent date and today in parallel (often the same date).
        const datesToLoad = [...new Set([latestDate, today])].filter(Boolean);

        if (datesToLoad.length === 0) {
          // Granular /data/dates returned an empty list — migration is
          // incomplete or the granular options are not yet populated.
          // Throw so loadData()'s catchError falls back to the legacy blob.
          throw new Error('Granular dates list is empty — falling back to legacy blob');
        }

        return forkJoin(
          datesToLoad.reduce((acc, date) => {
            acc[date] = this.editionCacheService.getEditionsForDate(date);
            return acc;
          }, {} as Record<string, Observable<NewspaperEdition[]>>)
        ).pipe(
          map((editionsByDate): NewspaperData => {
            const editions: NewspaperEdition[] = Object.values(editionsByDate).flat();
            // If all edition options came back empty the granular options were
            // not yet written (partial migration: index exists but dn_edition_*
            // options don't).  Throw so catchError falls back to the legacy blob.
            if (editions.length === 0) {
              throw new Error('Granular edition options are empty — falling back to legacy blob');
            }
            return { settings, editions, dataVersion: version.dataVersion ?? 0 };
          })
        );
      }),
      // 15 s total — tighter than the 20 s legacy timeout so we can still
      // attempt the legacy fallback within a reasonable overall wait time.
      timeout(15000),
      switchMap((data) => {
        this.dataRecoveredFromMediaLibrary = false;
        return this.hasAnyPages(data) ? of(data) : this.loadDataFromMediaLibrary(data);
      })
    );
  }

  /**
   * Legacy monolithic blob load — backward-compatible with older plugin versions.
   * Used as a fallback when the granular endpoints are unavailable.
   */
  private loadDataFromLegacyBlob(): Observable<NewspaperData> {
    const cacheBuster = `?_t=${Date.now()}`;
    return this.http.get<unknown>(this.apiUrl + cacheBuster).pipe(
      timeout(20000),
      retry({
        count: 2,
        delay: (_err, retryCount) => timer(retryCount * 1500),
      }),
      catchError((err) => {
        console.warn(
          '[NewspaperDataService] Legacy /data blob also unreachable — serving empty fallback. Reason:',
          err?.message ?? err
        );
        return this.http.get<unknown>(this.assetsUrl);
      }),
      map((data): NewspaperData => this.normalizeData(this.assertValidNewspaperResponse(data))),
      switchMap((data) => {
        this.dataRecoveredFromMediaLibrary = false;
        return this.hasAnyPages(data) ? of(data) : this.loadDataFromMediaLibrary(data);
      })
    );
  }

  /**
   * Targeted reload for the viewer — refreshes only one date's editions and
   * the available-dates index, rather than fetching the full /data blob.
   *
   * Called by the version-poll subscriber when a remote change is detected.
   * Using the granular /data/editions/:date and /data/dates endpoints means
   * the HTTP cache interceptor can still serve a 304 if nothing relevant changed,
   * making the "check" essentially free most of the time.
   *
   * Falls back to the full loadData() if either granular fetch fails, so
   * existing behaviour is preserved in degraded environments.
   *
   * @param date  The currently-displayed date (YYYY-MM-DD) whose edition to refresh.
   */
  reloadCurrentDateOnly(date: string): Observable<void> {
    // Evict both cache layers for this date so the next fetch is fresh.
    this.evictDateCache(date);

    return forkJoin({
      editions: this.editionCacheService.getEditionsForDate(date),
      // Refreshes the DateIndexService signal and returns the updated list.
      // This also handles the case where a new edition date was just published.
      dates:    this.dateIndexService.fetch(),
      // Re-fetch global settings so that settings changes made by an admin in
      // another tab/session (logo, maintenance mode, language, etc.) are picked
      // up immediately when the version poll detects a remote change — without
      // requiring a full page reload.  The HTTP interceptor cache applies a
      // 1-hour TTL with ETag validation, so this is a cheap conditional GET
      // when settings have not changed, and a full fetch only when they have.
      settings: this.settingsService.fetch(),
    }).pipe(
      tap(({ editions, settings }) => {
        const current = this.dataSubject.value;
        // Preserve all dates except the one we just refreshed.
        const otherEditions = current.editions.filter(e => e.date !== date);
        const merged = [...otherEditions, ...editions].sort((a, b) => {
          const d = b.date.localeCompare(a.date);
          return d !== 0 ? d : ((a.edition ?? 1) - (b.edition ?? 1));
        });
        // Apply both refreshed editions AND refreshed settings so the viewer
        // reflects any settings changes (e.g. maintenance mode, logo) without
        // requiring a full page reload.
        this.dataSubject.next({ ...current, settings, editions: merged });
      }),
      map(() => void 0),
      catchError(err => {
        // Granular endpoints unavailable — fall back to the full reload.
        console.warn(
          '[NewspaperDataService] reloadCurrentDateOnly failed, falling back to loadData(). Reason:',
          err?.message ?? err
        );
        return this.loadData().pipe(map(() => void 0));
      })
    );
  }

  private assertValidNewspaperResponse(data: unknown): NewspaperData | { pages: NewspaperPage[] } {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid newspaper API response: expected a JSON object.');
    }

    const candidate = data as Partial<NewspaperData> & { pages?: NewspaperPage[]; message?: unknown; error?: unknown };
    if (Array.isArray(candidate.editions) || Array.isArray(candidate.pages)) {
      return candidate as NewspaperData | { pages: NewspaperPage[] };
    }

    const serverMessage = typeof candidate.message === 'string'
      ? candidate.message
      : (typeof candidate.error === 'string' ? candidate.error : 'missing editions/pages');

    // Distinguish host-level WAF blocks from genuine plugin errors so the
    // calling code can surface a helpful, actionable message to the admin.
    if (AuthService.isWafBlockMessage(serverMessage)) {
      throw new Error(`WAF_BLOCKED:${serverMessage}`);
    }
    throw new Error(`Invalid newspaper API response: ${serverMessage}`);
  }

  private loadEmergencyDraftAfterApiFailure(error: unknown): Observable<NewspaperData> {
    const draft = this.readEmergencyDraft();
    if (draft && this.hasAnyPages(draft)) {
      console.warn(
        '[NewspaperDataService] Live API returned an invalid response; using emergency browser-local draft. Reason:',
        error instanceof Error ? error.message : error
      );
      return of(draft);
    }

    return throwError(() => error);
  }

  private cacheEmergencyDraft(data: NewspaperData): void {
    if (!this.isBrowser) return; // SSR — no localStorage
    if (this.dataRecoveredFromMediaLibrary) return;
    if (!this.hasAnyPages(data)) return;
    // Only write emergency drafts in authenticated admin sessions.
    // Public readers never edit content, so serialising their full JSON
    // state every 2 s is pure waste.
    if (!this.auth.getToken()) return;
    try {
      localStorage.setItem(
        NewspaperDataService.EMERGENCY_DRAFT_KEY,
        JSON.stringify({ createdAt: new Date().toISOString(), data })
      );
    } catch (error) {
      console.warn('[NewspaperDataService] Failed to cache emergency local draft:', error);
    }
  }

  private readEmergencyDraft(): NewspaperData | null {
    if (!this.isBrowser) return null; // SSR — no localStorage
    try {
      const raw = localStorage.getItem(NewspaperDataService.EMERGENCY_DRAFT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { data?: unknown };
      return this.normalizeData(this.assertValidNewspaperResponse(parsed.data));
    } catch (error) {
      console.warn('[NewspaperDataService] Failed to read emergency local draft:', error);
      return null;
    }
  }

  private normalizeData(data: NewspaperData | { pages: NewspaperPage[] }): NewspaperData {
    // Backwards compatibility: convert old format to new format
    if ('pages' in data && !('editions' in data)) {
      const todayDate = this.getTodayDate();
      return this.normalizeData({
        settings: {
          defaultDateMode: 'current',
          socialLinks: {}
        },
        editions: [{
          date: todayDate,
          pages: data.pages
        }]
      });
    }

    // Ensure settings exist and are normalized
    const result = data as NewspaperData;
    if (!Array.isArray(result.editions)) {
      result.editions = [];
    }
    if (!result.settings) {
      result.settings = {
        defaultDateMode: 'current',
        socialLinks: {},
        logo: { url: '', alt: 'Digital Newspaper' }
      };
    } else {
      // PHP empty array [] serializes to JSON []; normalize to object {}
      if (!result.settings.socialLinks || Array.isArray(result.settings.socialLinks)) {
        result.settings.socialLinks = {};
      }
      // Ensure logo object always exists
      if (!result.settings.logo) {
        result.settings.logo = { url: '', alt: 'Digital Newspaper' };
      }
      // Ensure address object always exists
      if (!result.settings.address) {
        result.settings.address = {};
      }
      // Ensure editor field always exists
      if (result.settings.editor === undefined) {
        result.settings.editor = '';
      }
      // Ensure language field always exists
      if (!result.settings.language) {
        result.settings.language = 'en';
      }
    }
    // Cache settings for offline / quick-startup use AND keep SettingsService in sync.
    // This is the single place normalizeData writes settings, so every code path that
    // produces a NewspaperData value (loadData, import, emergency draft) ends up here.
    if (result.settings) {
      this.cacheSettings(result.settings);
      // `settingsService.apply()` normalises and pushes to the signal — keeps
      // SettingsService.settings() consistent with dataSubject for all callers.
      this.settingsService.apply(result.settings);
    }
    // Normalize page fields: PHP serializes empty/unset strings as [] (empty
    // array) which is truthy in JS, causing *ngIf guards to pass while
    // [src] bindings receive a non-string and silently resolve to "".
    result.editions.forEach(edition => {
      edition.pages = Array.isArray(edition.pages) ? edition.pages.map(page => ({
        ...page,
        thumbnail: typeof page.thumbnail === 'string' ? page.thumbnail : '',
        fullImage: typeof page.fullImage === 'string' ? page.fullImage : '',
        sections: Array.isArray(page.sections) ? page.sections.map(section => ({
          ...section,
          imageUrl: typeof section.imageUrl === 'string' ? section.imageUrl : undefined,
        })) : [],
      })).sort((a, b) => a.id - b.id) : [];
    });
    return result;
  }

  private hasAnyPages(data: NewspaperData): boolean {
    return data.editions.some(edition => Array.isArray(edition.pages) && edition.pages.length > 0);
  }

  private loadDataFromMediaLibrary(baseData: NewspaperData): Observable<NewspaperData> {
    return this.getAllWordPressMedia().pipe(
      map((mediaItems) => this.buildDataFromMediaLibrary(baseData, mediaItems)),
      catchError((err) => {
        console.warn(
          '[NewspaperDataService] Digital Newspaper API has no pages and Media Library recovery failed. Reason:',
          err?.message ?? err
        );
        return of(baseData);
      })
    );
  }

  private getAllWordPressMedia(): Observable<WpMediaItem[]> {
    const firstPageUrl = this.buildMediaUrl(1);
    return this.http.get<WpMediaItem[]>(firstPageUrl, { observe: 'response' }).pipe(
      timeout(20000),
      switchMap((response: HttpResponse<WpMediaItem[]>) => {
        const firstPageItems = response.body || [];
        const totalPages = Number(response.headers.get('X-WP-TotalPages') || 1);
        if (!Number.isFinite(totalPages) || totalPages <= 1) {
          return of(firstPageItems);
        }

        const remainingRequests: Observable<WpMediaItem[]>[] = [];
        for (let page = 2; page <= totalPages; page += 1) {
          remainingRequests.push(this.http.get<WpMediaItem[]>(this.buildMediaUrl(page)).pipe(timeout(20000)));
        }

        return forkJoin(remainingRequests).pipe(
          map((pages) => [firstPageItems, ...pages].flat())
        );
      })
    );
  }

  private buildMediaUrl(page: number): string {
    return `${this.mediaApiUrl}?media_type=image&per_page=100&page=${page}&orderby=date&order=desc&_fields=id,date,source_url,title,alt_text`;
  }

  private buildDataFromMediaLibrary(baseData: NewspaperData, mediaItems: WpMediaItem[]): NewspaperData {
    const candidates = mediaItems
      .map(item => this.toMediaPageCandidate(item))
      .filter((candidate): candidate is MediaPageCandidate => candidate !== null);

    if (candidates.length === 0) {
      return baseData;
    }

    const grouped = new Map<string, MediaPageCandidate[]>();
    candidates.forEach(candidate => {
      const existing = grouped.get(candidate.date) || [];
      existing.push(candidate);
      grouped.set(candidate.date, existing);
    });

    const recoveredEditions: NewspaperEdition[] = Array.from(grouped.entries())
      .map(([date, dateCandidates]) => {
        const uniqueByPage = new Map<number, MediaPageCandidate>();
        dateCandidates
          .sort((a, b) => b.pageNumber - a.pageNumber)
          .forEach(candidate => uniqueByPage.set(candidate.pageNumber, candidate));

        return {
          date,
          edition: 1,
          pages: Array.from(uniqueByPage.values())
            .sort((a, b) => a.pageNumber - b.pageNumber)
            .map((candidate, index): NewspaperPage => ({
              id: index + 1,
              thumbnail: candidate.url,
              fullImage: candidate.url,
              sections: [],
              pageLabels: { en: candidate.label, bn: '' }
            }))
        };
      })
      .filter(edition => edition.pages.length > 0)
      .sort((a, b) => b.date.localeCompare(a.date));

    if (recoveredEditions.length === 0) {
      return baseData;
    }

    console.warn(
      `[NewspaperDataService] Digital Newspaper API returned no pages; recovered ${recoveredEditions.length} edition(s) from WordPress Media Library.`
    );
    this.dataRecoveredFromMediaLibrary = true;

    return this.normalizeData({
      ...baseData,
      editions: recoveredEditions
    });
  }

  private toMediaPageCandidate(item: WpMediaItem): MediaPageCandidate | null {
    if (!item.source_url || !this.isSupportedImageUrl(item.source_url)) {
      return null;
    }

    const filename = decodeURIComponent(item.source_url.split('/').pop() || '');
    if (!this.isRecoverableFullPageImage(filename)) {
      return null;
    }

    const date = this.parseNewspaperDate(filename);
    const pageNumber = this.parsePageNumber(filename);
    if (!date || !pageNumber) {
      return null;
    }

    return {
      date,
      pageNumber,
      url: item.source_url,
      label: `Page ${pageNumber}`
    };
  }

  private isRecoverableFullPageImage(filename: string): boolean {
    const normalized = filename.toLowerCase();
    if (
      /^page-\d{1,2}-s-/.test(normalized)
      || /^page-\d{1,2}-e-\d{1,2}-\d{1,2}-\d{1,2}-\d{4}-s-/.test(normalized)
      || /^page-\d{1,2}-e-\d{1,2}-\d{1,2}-\d{1,2}-\d{4}-post-/.test(normalized)
    ) {
      return false;
    }
    if (/^page-\d{1,2}-e-/.test(normalized)) {
      return true;
    }

    return normalized.includes('page')
      && !normalized.includes('post-')
      && !normalized.includes('_post')
      && !normalized.includes('dn-social-resize');
  }

  private parseNewspaperDate(filename: string): string | null {
    const matches = Array.from(filename.matchAll(/(?:^|[^\d])(\d{1,2})[_-](\d{1,2})[_-](\d{2,4})(?:[^\d]|$)/g));
    for (const match of matches) {
      const day = Number.parseInt(match[1], 10);
      const month = Number.parseInt(match[2], 10);
      const year = this.normalizeFilenameYear(match[3]);

      if (!year || day < 1 || day > 31 || month < 1 || month > 12) {
        continue;
      }

      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    return null;
  }

  private normalizeFilenameYear(value: string): string | null {
    if (value.length === 2) {
      const yearSuffix = Number.parseInt(value, 10);
      return yearSuffix >= 20 ? `20${value}` : null;
    }

    if (value === '0206') {
      return '2026';
    }

    const year = Number.parseInt(value, 10);
    return year >= 2020 && year <= 2099 ? String(year) : null;
  }

  private parsePageNumber(filename: string): number | null {
    if (/frist-page/i.test(filename) || /first-page/i.test(filename)) {
      return 1;
    }

    const patterns = [
      /^page-(\d{1,2})-e-/i,
      /page[_-]?(\d{1,2})(?=[_-])/i,
      /page[_-]?(\d)(?=\d{2}[_-]\d{2}[_-]\d{2})/i,
    ];

    for (const pattern of patterns) {
      const match = filename.match(pattern);
      if (match) {
        const pageNumber = Number.parseInt(match[1], 10);
        if (Number.isFinite(pageNumber) && pageNumber > 0 && pageNumber <= 32) {
          return pageNumber;
        }
      }
    }

    return null;
  }

  private isSupportedImageUrl(url: string): boolean {
    return /\.(jpe?g|png|webp)(\?.*)?$/i.test(url);
  }

  getData(): NewspaperData {
    return this.dataSubject.value;
  }

  /** Returns true when an edition record matches a given date and edition number. */
  private editionMatches(e: NewspaperEdition, date: string, editionNumber: number): boolean {
    return e.date === date && (e.edition || 1) === editionNumber;
  }

  /** All editions for a date, sorted by edition number ascending. */
  getEditionsByDate(date: string): NewspaperEdition[] {
    const data = this.getData();
    return data.editions
      .filter(e => e.date === date)
      .sort((a, b) => (a.edition || 1) - (b.edition || 1));
  }

  /** Get a specific edition for a date by its number (1-based). */
  getEditionByDateAndNumber(date: string, editionNumber: number = 1): NewspaperEdition | null {
    const data = this.getData();
    return data.editions.find(e => this.editionMatches(e, date, editionNumber)) || null;
  }

  // Get edition for specific date (returns 1st edition – kept for backward compat)
  getEditionByDate(date: string): NewspaperEdition | null {
    return this.getEditionByDateAndNumber(date, 1);
  }

  // Get current edition based on selected date and edition number
  getCurrentEdition(editionNumber: number = 1): NewspaperEdition | null {
    return this.getEditionByDateAndNumber(this.getCurrentDate(), editionNumber);
  }

  // Get all available dates (unique, deduped across multiple editions)
  getAvailableDates(): string[] {
    const data = this.getData();
    const datesWithPages = data.editions
      .filter(e => e.pages && e.pages.length > 0)
      .map(e => e.date);
    // Union with DateIndexService so callers see EVERY date the server knows
    // about, not just the ones whose editions happen to be loaded in memory.
    // loadDataFromGranular() only hydrates editions for latestDate + today
    // for speed — without this union, getAvailableDates() would only return
    // those 1-2 dates and the date picker would hide every older edition.
    const indexed = this.dateIndexService.get();
    return [...new Set([...datesWithPages, ...indexed])].sort().reverse();
  }

  /**
   * Returns every edition date that exists in the data, including newly-created
   * editions that have no pages yet. Use this in the admin date-picker so that
   * a fresh empty date doesn't disappear from the list on the next reload.
   *
   * Unlike getAvailableDates(), this method does NOT filter by page count.
   * It is intentionally separate so the public/reader view can still call
   * getAvailableDates() and only see dates that have actual content.
   */
  getAllEditionDates(): string[] {
    const data = this.getData();
    // Union with DateIndexService so the admin date picker sees EVERY date,
    // not just the latestDate + today that loadDataFromGranular() hydrates.
    // See getAvailableDates() above for the full reasoning.
    const indexed = this.dateIndexService.get();
    return [...new Set([...data.editions.map(e => e.date), ...indexed])].sort().reverse();
  }

  // Create or get edition for a date (and optional edition number)
  getOrCreateEdition(date: string, editionNumber: number = 1): NewspaperEdition {
    const existing = this.getEditionByDateAndNumber(date, editionNumber);
    if (existing) return existing;
    
    const newEdition: NewspaperEdition = {
      date,
      edition: editionNumber,
      pages: []
    };
    
    const currentData = this.getData();
    const newEditions = [...currentData.editions, newEdition].sort((a, b) => {
      const dateDiff = b.date.localeCompare(a.date);
      if (dateDiff !== 0) return dateDiff;
      return (a.edition || 1) - (b.edition || 1);
    });
    
    this.dataSubject.next({ ...currentData, editions: newEditions });
    return newEdition;
  }

  /**
   * Returns the display label for a page in the given language.
   * Falls back to another available language, then empty string.
   */
  getPageDisplayLabel(page: NewspaperPage, lang: string): string {
    if (page.pageLabels) {
      const label = page.pageLabels[lang];
      if (label) return label;
      const fallback = Object.values(page.pageLabels).find(v => v);
      if (fallback) return fallback;
    }
    return '';
  }

  /**
   * Returns the display label for an edition in the given language.
   * Falls back to: other language → deprecated editionLabel string → empty string.
   */
  getEditionDisplayLabel(edition: NewspaperEdition, lang: string): string {
    if (edition.editionLabels) {
      const label = edition.editionLabels[lang];
      if (label) return label;
      // Fall back to any available language
      const fallback = Object.values(edition.editionLabels).find(v => v);
      if (fallback) return fallback;
    }
    // Backward compat with old single-string field
    if (edition.editionLabel) return edition.editionLabel;
    return '';
  }

  /**
   * Generic helper: returns the best localized value for a settings field.
   * Falls back to: requested lang → any available lang → base scalar fallback.
   */
  getLocalizedSetting(
    labels: { [lang: string]: string } | undefined,
    fallback: string | undefined,
    lang: string
  ): string {
    if (labels) {
      const val = labels[lang];
      if (val) return val;
      const anyVal = Object.values(labels).find(v => v);
      if (anyVal) return anyVal;
    }
    return fallback || '';
  }

  // ─── Atomic (granular) save methods ─────────────────────────────────────
  // Each method posts only the changed record to a dedicated PHP endpoint that
  // does a server-side read-modify-write.  Two users editing DIFFERENT pages
  // can now save simultaneously without overwriting each other's work.

  private readonly pageAtomicUrl    = `${this.wpBaseUrl}/wp-json/digital-newspaper/v1/data/page`;
  private readonly sectionAtomicUrl = `${this.wpBaseUrl}/wp-json/digital-newspaper/v1/data/section`;

  // Client-side timeout for atomic mutations. Set above the typical gateway
  // timeout (~30 s on cPanel / Hostinger) so the server has a chance to return
  // 504 before we abort locally; but bounded so a hung connection eventually
  // fires the error handler instead of leaving the UI in a half-saved state.
  private readonly atomicSaveTimeoutMs = 45000;

  private patchDataVersion(res: any): void {
    if (res?.newDataVersion) {
      this.dataSubject.next({ ...this.dataSubject.value, dataVersion: res.newDataVersion });
    }
  }

  /** Publicly patch the local dataVersion (used by the admin component to
   *  pre-adopt a version emitted by remoteDataChanged$ before loadData()
   *  completes, preventing a spurious second poll-triggered reload). */
  patchDataVersionPublic(version: number): void {
    if (version && version > (this.dataSubject.value.dataVersion ?? 0)) {
      this.dataSubject.next({ ...this.dataSubject.value, dataVersion: version });
    }
  }

  /**
   * Invalidate every client-side cache layer in one call.
   *
   * Use after bulk operations that may affect any number of dates
   * (bulk XML import, data restore, full rebuild) so the subsequent
   * loadData() call always fetches fresh data from the server instead
   * of returning stale in-memory, localStorage, or IndexedDB entries.
   *
   * Does NOT trigger a reload — the caller is responsible for calling
   * loadData() afterward.
   */
  clearAllCaches(): void {
    clearHttpCache();
    this.editionCacheService.clearMemory();
  }

  /**
   * After any atomic write, evict the cache entry for the affected date so
   * the next fetch of /data/editions/:date returns the server's updated data.
   * Also clears /data/dates in case page counts changed.
   */
  private evictDateCache(date: string): void {
    // Evict from the HTTP-level interceptor cache (handles ETag slots + /data/dates)
    evictEditionCache(date);
    // Mark this date to bypass the browser's native HTTP cache on the very next
    // request.  The browser may hold a stale response with max-age=86400 from
    // before the server-side fix; adding Cache-Control: no-cache to the outgoing
    // request forces revalidation regardless of the cached max-age.
    markForBrowserCacheBypass(date);
    // Also evict from the EditionCacheService in-memory Map so the next
    // getEditionsForDate(date) call re-fetches from the network.
    this.editionCacheService.evict(date);
  }

  /** Atomically upsert a single page on the server (PUT /data/page). */
  savePageAtomically(page: NewspaperPage, date: string, edition: number): Observable<any> {
    const headers = this.auth.getAuthHeaders();
    return this.http.put<any>(this.pageAtomicUrl, { date, edition, page }, { headers }).pipe(
      timeout(this.atomicSaveTimeoutMs),
      tap({
        next: (res) => {
          this.patchDataVersion(res);
          this.evictDateCache(date);
        },
        error: () => {
          // Evict cache even on error: the server may have committed the write
          // before the response failed (e.g. sync timeout kills the response
          // after update_option succeeds). Without this eviction the frontend
          // keeps serving stale cached data that doesn't include the new page.
          this.evictDateCache(date);
        },
      })
    );
  }

  /** Atomically delete a single page on the server (DELETE /data/page). */
  deletePageAtomically(pageId: number, date: string, edition: number): Observable<any> {
    const headers = this.auth.getAuthHeaders();
    return this.http.delete<any>(this.pageAtomicUrl, { headers, body: { date, edition, pageId } }).pipe(
      timeout(this.atomicSaveTimeoutMs),
      tap({
        next: (res) => {
          this.patchDataVersion(res);
          this.evictDateCache(date);
        },
        error: () => { this.evictDateCache(date); },
      })
    );
  }

  /**
   * Atomically upsert a single section on the server (PUT /data/section).
   * @param originalSectionId  The section's ID before any normalization/rename.
   *                           Pass the same value as section.id if unchanged.
   */
  saveSectionAtomically(
    pageId: number, section: NewsSection, originalSectionId: string, date: string, edition: number
  ): Observable<any> {
    const headers = this.auth.getAuthHeaders();
    return this.http.put<any>(this.sectionAtomicUrl,
      { date, edition, pageId, originalSectionId, section }, { headers }
    ).pipe(
      timeout(this.atomicSaveTimeoutMs),
      tap({
        next: (res) => {
          this.patchDataVersion(res);
          this.evictDateCache(date);
        },
        error: () => { this.evictDateCache(date); },
      })
    );
  }

  /** Atomically delete a single section on the server (DELETE /data/section). */
  deleteSectionAtomically(pageId: number, sectionId: string, date: string, edition: number): Observable<any> {
    const headers = this.auth.getAuthHeaders();
    return this.http.delete<any>(this.sectionAtomicUrl,
      { headers, body: { date, edition, pageId, sectionId } }
    ).pipe(
      timeout(this.atomicSaveTimeoutMs),
      tap({
        next: (res) => {
          this.patchDataVersion(res);
          this.evictDateCache(date);
        },
        error: () => { this.evictDateCache(date); },
      })
    );
  }

  /**
   * Atomically save ALL editions for a single date (PUT /data/editions-for-date).
   *
   * Used by the vintage theme's auto-save after structural changes such as
   * creating a new edition, renaming edition labels, creating a new date, or
   * deleting an edition.
   *
   * Unlike the full POST /data save, this endpoint:
   *   - Only writes the targeted dn_edition_{date} option and the index.
   *   - Never writes the dn_data blob (no memory spike, no blob growth).
   *   - Is NOT subject to the shrinking-overwrite guard that blocks full saves
   *     when the in-memory Angular state only contains 1-2 dates.
   */
  saveEditionsForDateAtomically(date: string): Observable<any> {
    const headers = this.auth.getAuthHeaders();
    const url = `${this.wpBaseUrl}/wp-json/digital-newspaper/v1/data/editions-for-date`;
    // Send only edition structural metadata (date, edition number, labels).
    // Pages are already managed by savePageAtomically / saveSectionAtomically;
    // sending them here would (a) bloat the payload and (b) risk overwriting
    // server-side page changes made after this client last synced.
    // The PHP endpoint restores pages from dn_edition_{date} before saving.
    const editions = this.dataSubject.value.editions
      .filter(e => e.date === date)
      .map(({ pages: _pages, ...meta }) => meta);
    return this.http.put<any>(url, { date, editions }, { headers }).pipe(
      timeout(this.atomicSaveTimeoutMs),
      tap({
        next: (res) => {
          this.patchDataVersion(res);
          this.evictDateCache(date);
        },
        error: () => { this.evictDateCache(date); },
      })
    );
  }

  saveData(data: NewspaperData, options: SaveDataOptions = {}): Observable<any> {
    if (this.dataRecoveredFromMediaLibrary && !options.allowRecoveredData) {
      return throwError(() => new Error(
        'Save blocked: the current pages were temporarily recovered from WordPress Media Library and do not include cropped sections/content. Restore the original Digital Newspaper JSON backup before saving.'
      ));
    }

    // Update the local data
    this.dataSubject.next(data);

    // Persist settings to localStorage for cross-window availability
    if (data.settings) {
      this.cacheSettings(data.settings);
      this.settingsService.apply(data.settings);
    }

    // Save to backend API.
    // Include the current dataVersion so the server can detect concurrent edits.
    // ?force=1 bypasses both the empty-overwrite guard and the version check.
    const headers = this.auth.getAuthHeaders();
    const forceParam = (options.forceEmptyOverwrite || options.forceVersionOverwrite)
      ? '?force=1'
      : '';
    const saveUrl = `${this.apiUrl}${forceParam}`;

    return this.http.post<unknown>(saveUrl, data, { headers }).pipe(
      map((response) => this.assertSaveAccepted(response)),
      tap((response: any) => {
        if (options.allowRecoveredData) {
          this.dataRecoveredFromMediaLibrary = false;
        }
        // Update local dataVersion to what the server stamped, so the NEXT save
        // carries the correct version and won't trip the conflict guard.
        if (response?.newDataVersion) {
          const current = this.dataSubject.value;
          this.dataSubject.next({ ...current, dataVersion: response.newDataVersion });
        }
        // Invalidate the HTTP cache so the next read fetches fresh data from
        // the server.  A full save may affect multiple dates, so clear all entries.
        clearHttpCache();
        // Also clear the EditionCacheService in-memory store — a full save may
        // have modified any date, so we cannot evict selectively.
        this.editionCacheService.clearMemory();
      }),
      catchError((err) => {
        // On any save failure, silently fetch the server's current dataVersion
        // and patch it into the local state.  If the save actually reached
        // WordPress but the HTTP response was blocked (e.g. by Imunify360 WAF),
        // the server will have advanced its version.  Without this refresh the
        // next save attempt sends the old version and gets a false 409 Conflict.
        this.http.get<{ dataVersion: number }>(this.versionUrl)
          .pipe(catchError(() => of(null)))
          .subscribe(res => {
            if (res?.dataVersion) {
              const cur = this.dataSubject.value;
              if (res.dataVersion !== cur.dataVersion) {
                this.dataSubject.next({ ...cur, dataVersion: res.dataVersion });
              }
            }
          });
        return throwError(() => err);
      })
    );
  }

  /**
   * Saves only the global settings object via PATCH /data/settings, without
   * sending any editions data.  This avoids the shrinking-overwrite guard that
   * fires when the admin edits settings while only a subset of editions are
   * loaded in the browser.
   */
  saveSettingsOnly(settings: GlobalSettings): Observable<any> {
    this.cacheSettings(settings);
    this.settingsService.apply(settings);

    const headers = this.auth.getAuthHeaders();
    const settingsUrl = `${this.apiUrl}/settings`;

    return this.http.patch<{ success: boolean; newDataVersion: number; settings: GlobalSettings }>(
      settingsUrl,
      { settings },
      { headers }
    ).pipe(
      tap((response) => {
        if (response?.newDataVersion) {
          const current = this.dataSubject.value;
          this.dataSubject.next({ ...current, dataVersion: response.newDataVersion, settings });
        }
        // Only evict the settings cache — edition entries are still valid.
        // Using clearHttpCache() here was wasteful: it forced readers to
        // re-download every cached edition after any settings change.
        evictSettingsCache();
      })
    );
  }

  /**
   * patching wpPostId onto every matching NewsSection in the in-memory data.
   * The map key format is "{date}:{editionNumber}:{pageId}:{sectionId}".
   */
  private patchWpPostIds(sectionPostIds: Record<string, number>): void {
    if (!sectionPostIds || typeof sectionPostIds !== 'object') return;
    const currentData = this.getData();
    const newEditions = currentData.editions.map(edition => {
      const date = edition.date;
      const edNum = edition.edition ?? 1;
      return {
        ...edition,
        pages: edition.pages.map(page => ({
          ...page,
          sections: page.sections.map(section => {
            const key = `${date}:${edNum}:${page.id}:${section.id}`;
            const wpPostId = sectionPostIds[key];
            return wpPostId ? { ...section, wpPostId } : section;
          }),
        })),
      };
    });
    this.dataSubject.next({ ...currentData, editions: newEditions });
  }

  private assertSaveAccepted(response: unknown): unknown {
    if (response && typeof response === 'object' && (response as { success?: unknown }).success === true) {
      // Patch wpPostIds if the PHP plugin returned them
      const payload = response as { sectionPostIds?: Record<string, number> };
      if (payload.sectionPostIds) {
        this.patchWpPostIds(payload.sectionPostIds);
      }
      return response;
    }

    const payload = response && typeof response === 'object'
      ? response as { message?: unknown; error?: unknown }
      : {};
    const serverMessage = typeof payload.error === 'string'
      ? payload.error
      : (typeof payload.message === 'string' ? payload.message : 'server did not confirm success');

    // Host-level WAF block — distinguish from a plugin-level rejection.
    if (AuthService.isWafBlockMessage(serverMessage)) {
      throw new Error(`WAF_BLOCKED:${serverMessage}`);
    }
    throw new Error(`Save was not confirmed by WordPress: ${serverMessage}`);
  }

  listServerBackups(): Observable<ServerDataBackupSummary[]> {
    const headers = this.auth.getAuthHeaders();
    return this.http.get<{ backups: ServerDataBackupSummary[] }>(`${this.apiUrl}/backups`, { headers }).pipe(
      map(response => response.backups || [])
    );
  }

  restoreServerBackup(index: number): Observable<any> {
    const headers = this.auth.getAuthHeaders();
    return this.http.post(`${this.apiUrl}/restore`, { index }, { headers }).pipe(
      tap(() => {
        // Invalidate all cache layers so the restored data is immediately
        // visible — both the HTTP interceptor cache and the EditionCacheService
        // in-memory + IDB stores.  Without this, the admin and viewer would
        // continue serving pre-restore edition data until the next page reload.
        clearHttpCache();
        this.editionCacheService.clearMemory();
      }),
      switchMap((result) =>
        // Re-hydrate the in-memory dataSubject from the server so the admin
        // UI reflects the restored content without requiring a manual refresh.
        this.loadData().pipe(map(() => result))
      )
    );
  }

  rebuildDataFromSectionPosts(): Observable<{ success: boolean; editionCount: number; pageCount: number; sectionCount: number }> {
    const headers = this.auth.getAuthHeaders();
    return this.http.post<{ success: boolean; editionCount: number; pageCount: number; sectionCount: number }>(
      `${this.apiUrl}/rebuild-from-sections`,
      {},
      { headers }
    ).pipe(
      tap(() => {
        // Invalidate all cache layers before the caller's loadData() call so
        // rebuilt editions are fetched fresh from the server.  Without this,
        // past-date entries already in IDB / localStorage would be returned by
        // EditionCacheService instead of the freshly rebuilt data.
        clearHttpCache();
        this.editionCacheService.clearMemory();
      })
    );
  }

  getApiBaseUrl(): string {
    return this.wpBaseUrl;
  }

  // Add page to current date's edition
  addPage(page: NewspaperPage, date?: string, editionNumber: number = 1): void {
    const targetDate = date || this.getCurrentDate();
    const currentData = this.getData();
    
    let foundEdition = false;
    const newEditions = currentData.editions.map(edition => {
      if (this.editionMatches(edition, targetDate, editionNumber)) {
        foundEdition = true;
        const sorted = [...edition.pages, {...page, sections: [...page.sections]}]
          .sort((a, b) => a.id - b.id);
        return { ...edition, pages: sorted };
      }
      return edition;
    });
    
    // If edition doesn't exist, create it
    if (!foundEdition) {
      newEditions.push({
        date: targetDate,
        edition: editionNumber,
        pages: [{...page, sections: [...page.sections]}]
      });
      newEditions.sort((a, b) => {
        const dateDiff = b.date.localeCompare(a.date);
        if (dateDiff !== 0) return dateDiff;
        return (a.edition || 1) - (b.edition || 1);
      });
    }
    
    this.dataSubject.next({ ...currentData, editions: newEditions });
    
  }

  updatePage(pageId: number, updatedPage: NewspaperPage, date?: string, editionNumber: number = 1): void {
    const targetDate = date || this.getCurrentDate();
    const currentData = this.getData();
    
    const newEditions = currentData.editions.map(edition => {
      if (this.editionMatches(edition, targetDate, editionNumber)) {
        const newPages = edition.pages.map(page => 
          page.id === pageId ? { ...updatedPage, sections: [...updatedPage.sections] } : page
        );
        return { ...edition, pages: newPages };
      }
      return edition;
    });
    
    this.dataSubject.next({ ...currentData, editions: newEditions });
    
  }

  deletePage(pageId: number, date?: string, editionNumber: number = 1): void {
    const targetDate = date || this.getCurrentDate();
    const currentData = this.getData();
    
    const newEditions = currentData.editions.map(edition => {
      if (this.editionMatches(edition, targetDate, editionNumber)) {
        return { ...edition, pages: edition.pages.filter(p => p.id !== pageId) };
      }
      return edition;
    });
    
    this.dataSubject.next({ ...currentData, editions: newEditions });
    
  }

  addSection(pageId: number, section: NewsSection, date?: string, editionNumber: number = 1): void {
    const targetDate = date || this.getCurrentDate();
    const currentData = this.getData();
    
    const newEditions = currentData.editions.map(edition => {
      if (this.editionMatches(edition, targetDate, editionNumber)) {
        const newPages = edition.pages.map(page => {
          if (page.id === pageId) {
            return { ...page, sections: [...page.sections, {...section}] };
          }
          return page;
        });
        return { ...edition, pages: newPages };
      }
      return edition;
    });
    
    this.dataSubject.next({ ...currentData, editions: newEditions });
    
  }

  updateSection(pageId: number, sectionId: string, updatedSection: NewsSection, date?: string, editionNumber: number = 1): void {
    const targetDate = date || this.getCurrentDate();
    const currentData = this.getData();
    const nextSectionId = updatedSection.id;
    
    const newEditions = currentData.editions.map(edition => {
      if (this.editionMatches(edition, targetDate, editionNumber)) {
        const newPages = edition.pages.map(page => {
          const newSections = page.sections.map(s => {
            if (s.id === sectionId && page.id === pageId) {
              return { ...updatedSection };
            }

            // When the ID is not changing, no cross-references need updating.
            if (sectionId === nextSectionId) return s;

            // Update any references to the renamed section in linkedSectionIds and linkedSectionPrimary.
            const hasLinkedRef = s.linkedSectionIds?.includes(sectionId) ?? false;
            const hasPrimaryRef = s.linkedSectionPrimary === sectionId;
            if (!hasLinkedRef && !hasPrimaryRef) return s;

            return {
              ...s,
              ...(hasLinkedRef && {
                linkedSectionIds: (s.linkedSectionIds ?? []).map(id => id === sectionId ? nextSectionId : id)
              }),
              ...(hasPrimaryRef && { linkedSectionPrimary: nextSectionId }),
            };
          });

          return { ...page, sections: newSections };
        });
        return { ...edition, pages: newPages };
      }
      return edition;
    });
    
    this.dataSubject.next({ ...currentData, editions: newEditions });
    
  }

  deleteSection(pageId: number, sectionId: string, date?: string, editionNumber: number = 1): void {
    const targetDate = date || this.getCurrentDate();
    const currentData = this.getData();
    
    const newEditions = currentData.editions.map(edition => {
      if (this.editionMatches(edition, targetDate, editionNumber)) {
        const newPages = edition.pages.map(page => {
          if (page.id === pageId) {
            return { ...page, sections: page.sections.filter(s => s.id !== sectionId) };
          }
          return page;
        });
        return { ...edition, pages: newPages };
      }
      return edition;
    });
    
    this.dataSubject.next({ ...currentData, editions: newEditions });
    
  }

  getNextPageId(date?: string, editionNumber: number = 1): number {
    const targetDate = date || this.getCurrentDate();
    const edition = this.getEditionByDateAndNumber(targetDate, editionNumber);
    if (!edition || edition.pages.length === 0) return 1;
    return Math.max(...edition.pages.map(p => p.id)) + 1;
  }

  // Global Settings Management

  /**
   * Returns the current global settings with all null-safety guards applied.
   *
   * Delegates to SettingsService so there is exactly one normalisation path.
   * SettingsService is kept in sync from:
   *   • loadData() tap → settingsService.apply()
   *   • normalizeData() → settingsService.apply()   (covers import + emergency draft)
   *   • saveData() tap  → settingsService.apply()
   *   • updateSettings() → settingsService.apply()
   *
   * The localStorage key ('dn_global_settings') is intentionally shared by both
   * services — both can read/write it without conflict.
   */
  getSettings(): GlobalSettings {
    return this.settingsService.get();
  }

  updateSettings(settings: GlobalSettings): void {
    const currentData = this.getData();
    this.dataSubject.next({
      ...currentData,
      settings
    });
    // Persist to localStorage so new windows pick it up immediately
    this.cacheSettings(settings);
    // Keep SettingsService in sync (it reads the same localStorage key,
    // but updating the signal directly avoids a localStorage round-trip).
    this.settingsService.apply(settings);
  }

  /**
   * Replace the editions array in the in-memory store without a server round-trip.
   * Use this for admin-side operations (edition label edits, edition deletion)
   * that modify editions directly and rely on a subsequent saveAllData() or
   * autoSaveForVintage() to persist the change.
   *
   * Prefer specific service methods (addPage, updateSection, …) for targeted edits.
   */
  updateEditions(editions: NewspaperEdition[]): void {
    this.dataSubject.next({ ...this.dataSubject.value, editions });
  }

  // ─── Remote-change detection (version polling) ────────────────────────────

  /**
   * Start polling the lightweight /data/version endpoint every `intervalMs`
   * milliseconds (default 30 s).
   *
   * When the server's dataVersion is newer than the locally cached one,
   * `remoteDataChanged$` emits the new version. The caller decides whether to
   * auto-reload silently or warn the user first (e.g., if they are mid-edit).
   *
   * Calling this a second time stops any existing poll before starting a new one.
   */
  startVersionPoll(intervalMs = 30_000): void {
    this.stopVersionPoll();
    // exhaustMap: if the previous version check hasn't resolved by the time
    // the next interval fires, the new tick is ignored — no request stacking.
    this.versionPollSub = interval(intervalMs).pipe(
      exhaustMap(() =>
        this.http.get<{ dataVersion: number }>(this.versionUrl).pipe(
          catchError(() => of(null)) // network error → skip silently
        )
      )
    ).subscribe(res => {
      if (!res) return;
      const local = this.dataSubject.value.dataVersion ?? 0;
      if (res.dataVersion > local) {
        this.remoteDataChanged$.next(res.dataVersion);
      }
    });
  }

  stopVersionPoll(): void {
    this.versionPollSub?.unsubscribe();
    this.versionPollSub = undefined;
  }

  getDefaultDate(): string {
    const settings = this.getSettings();
    if (settings.defaultDateMode === 'specific' && settings.specificDate) {
      return settings.specificDate;
    }
    // 'current' mode: use today, but fall back to the most recent date with
    // pages if today's edition has no pages yet.
    const today = this.getTodayDate();
    const todayHasPages = this.getEditionsByDate(today).some(e => e.pages && e.pages.length > 0);
    if (!todayHasPages) {
      // getAvailableDates() already filters for dates with pages, sorted newest-first
      const availableDates = this.getAvailableDates();
      const fallback = availableDates.find(d => d < today) ?? availableDates[0];
      if (fallback) return fallback;
    }
    return today;
  }

  // --- localStorage settings cache ---
  private cacheSettings(settings: GlobalSettings): void {
    if (!this.isBrowser) return; // SSR — no localStorage
    try {
      localStorage.setItem(
        NewspaperDataService.SETTINGS_CACHE_KEY,
        JSON.stringify(settings)
      );
    } catch (_e) { /* quota exceeded or private mode – silently ignore */ }
  }

  /** Static helper so it can be called before the instance is fully constructed. */
  private static _readCachedSettings(): GlobalSettings | null {
    if (typeof localStorage === 'undefined') return null; // SSR — no localStorage
    try {
      const raw = localStorage.getItem(NewspaperDataService.SETTINGS_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as GlobalSettings;
        // Normalize just like we do for API data
        if (parsed.socialLinks && Array.isArray(parsed.socialLinks)) {
          parsed.socialLinks = {};
        }
        return parsed;
      }
    } catch (_e) { /* corrupt data – ignore */ }
    return null;
  }

  private triggerFileDownload(json: string, filename: string): void {
    if (!this.isBrowser) return; // download only makes sense in the browser
    // BANGLA SAFETY: charset=utf-8 is explicit so the browser and any
    // downstream tool that opens the file knows to interpret the bytes as
    // UTF-8.  Without it, some OS file-open dialogs default to the system
    // locale (often Windows-1252) and misread multi-byte Bangla codepoints.
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.URL.revokeObjectURL(url);
  }

  /**
   * Download a COMPLETE, authoritative backup by fetching directly from the
   * server's /data/export-full endpoint.
   *
   * Unlike downloadExport() which serialises in-memory Angular state (only
   * 1-2 dates hydrated at load time), this method pulls from the PHP plugin's
   * granular per-date options (dn_edition_YYYY-MM-DD), which are the single
   * source of truth for ALL dates including those never loaded into the browser.
   *
   * BANGLA SAFETY: the server responds with Content-Type: application/json;
   * charset=UTF-8 and JSON_UNESCAPED_UNICODE, so Bangla characters arrive as
   * literal UTF-8 bytes.  We write them to a Blob with explicit charset=utf-8
   * and trigger the file download — no encoding conversion at any step.
   *
   * @returns Observable that emits { filename, sizeKb } on success.
   */
  downloadExportFull(): Observable<{ filename: string; sizeKb: number }> {
    const headers = this.auth.getAuthHeaders();
    const exportUrl = `${this.wpBaseUrl}/wp-json/digital-newspaper/v1/data/export-full`;

    // Request as text so we forward the exact UTF-8 byte stream the server
    // produced — no JSON.parse() / JSON.stringify() round-trip that could
    // escape Bangla characters as \uXXXX sequences.
    return this.http.get(exportUrl, { headers, responseType: 'text' }).pipe(
      timeout(120000), // 2 min: large archives can be slow to assemble server-side
      map((raw: string) => {
        // Validate the response is parseable JSON before writing the file.
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error('Server export-full returned non-JSON response. Check server logs.');
        }
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Server export-full returned an invalid structure.');
        }
        const editionCount: number = Array.isArray(parsed.editions) ? parsed.editions.length : 0;
        const today = this.getTodayDate();
        const filename = `newspaper-backup-full-${today}.json`;

        // Write the RAW bytes from the server — not re-serialised — so
        // Bangla characters stay as their original UTF-8 codepoints.
        this.triggerFileDownload(raw, filename);

        const sizeKb = Math.round((raw.length / 1024) * 10) / 10;
        this.addBackupHistoryEntry({
          id: Date.now().toString(),
          exportedAt: parsed.meta?.exportedAt ?? new Date().toISOString(),
          filename,
          exportScope: 'full',
          exportType: 'full',
          editionCount,
          sizeKb,
          sourceUrl: parsed.meta?.sourceUrl ?? this.wpBaseUrl,
        });
        return { filename, sizeKb };
      })
    );
  }

  buildExportPayload(options: ExportOptions): { payload: ExportPayload; filename: string } {
    const allData = this.getData();
    let filteredEditions: NewspaperEdition[] = allData.editions || [];

    if (options.exportType !== 'settings-only') {
      if (options.exportScope === 'current-date' && options.currentDate) {
        filteredEditions = filteredEditions.filter(e => e.date === options.currentDate);
      } else if (options.exportScope === 'date-range' && options.dateFrom && options.dateTo) {
        filteredEditions = filteredEditions.filter(
          e => e.date >= options.dateFrom! && e.date <= options.dateTo!
        );
      }
    } else {
      filteredEditions = [];
    }

    const sortedDates = filteredEditions.map(e => e.date).sort();
    const dateRange = sortedDates.length > 0
      ? { from: sortedDates[0], to: sortedDates[sortedDates.length - 1] }
      : undefined;

    const meta: ExportMeta = {
      exportedAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      sourceUrl: this.wpBaseUrl,
      exportScope: options.exportType === 'settings-only' ? 'full' : options.exportScope,
      exportType: options.exportType,
      editionCount: filteredEditions.length,
      dateRange,
    };

    const payload: ExportPayload = { meta };
    if (options.exportType !== 'editions-only') {
      payload.settings = allData.settings;
    }
    if (options.exportType !== 'settings-only') {
      payload.editions = filteredEditions;
    }

    const today = this.getTodayDate();
    let suffix = '';
    if (options.exportType === 'settings-only') suffix = '-settings';
    else if (options.exportType === 'editions-only') suffix = '-editions';
    if (options.exportScope === 'current-date') suffix += `-${options.currentDate ?? today}`;
    else if (options.exportScope === 'date-range') suffix += `-${options.dateFrom}-to-${options.dateTo}`;

    const filename = `newspaper-backup${suffix}-${today}.json`;
    return { payload, filename };
  }

  downloadExport(options: ExportOptions): { filename: string; sizeKb: number } {
    const { payload, filename } = this.buildExportPayload(options);
    const json = JSON.stringify(payload, null, 2);
    this.triggerFileDownload(json, filename);
    const sizeKb = Math.round((json.length / 1024) * 10) / 10;
    this.addBackupHistoryEntry({
      id: Date.now().toString(),
      exportedAt: payload.meta.exportedAt,
      filename,
      exportScope: payload.meta.exportScope,
      exportType: payload.meta.exportType,
      editionCount: payload.meta.editionCount,
      sizeKb,
      sourceUrl: payload.meta.sourceUrl,
    });
    return { filename, sizeKb };
  }

  /** Backward-compatible alias – triggers a full export with metadata envelope. */
  downloadJSON(): void {
    this.downloadExport({ exportType: 'full', exportScope: 'full' });
  }

  // ─── Backup History ───────────────────────────────────────────────────────

  getBackupHistory(): BackupHistoryEntry[] {
    if (!this.isBrowser) return []; // SSR — no localStorage
    try {
      const raw = localStorage.getItem(NewspaperDataService.BACKUP_HISTORY_KEY);
      if (raw) return JSON.parse(raw) as BackupHistoryEntry[];
    } catch { /* ignore */ }
    return [];
  }

  private addBackupHistoryEntry(entry: BackupHistoryEntry): void {
    try {
      const history = this.getBackupHistory();
      history.unshift(entry);
      if (history.length > NewspaperDataService.MAX_HISTORY_ENTRIES) {
        history.splice(NewspaperDataService.MAX_HISTORY_ENTRIES);
      }
      localStorage.setItem(NewspaperDataService.BACKUP_HISTORY_KEY, JSON.stringify(history));
    } catch { /* quota exceeded – ignore */ }
  }

  clearBackupHistory(): void {
    if (!this.isBrowser) return; // SSR — no localStorage
    localStorage.removeItem(NewspaperDataService.BACKUP_HISTORY_KEY);
  }

  // ─── Import Validation & Preview ─────────────────────────────────────────

  validateImportPayload(parsed: any): ImportValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (typeof parsed !== 'object' || parsed === null) {
      errors.push('File is not a valid JSON object.');
      return { valid: false, errors, warnings };
    }

    const hasEditions = Array.isArray(parsed.editions);
    const hasSettings = typeof parsed.settings === 'object' && parsed.settings !== null;

    if (!hasEditions && !hasSettings) {
      errors.push('File does not contain "editions" array or "settings" object — not a valid backup.');
      return { valid: false, errors, warnings };
    }

    if (!parsed.meta) {
      warnings.push('This backup has no metadata (created with an older version). Limited validation available.');
    } else if (parsed.meta.schemaVersion > SCHEMA_VERSION) {
      warnings.push(
        `Backup schema version (${parsed.meta.schemaVersion}) is newer than this app supports (${SCHEMA_VERSION}). Some fields may be ignored.`
      );
    }

    if (hasEditions) {
      const datePattern = /^\d{4}-\d{2}-\d{2}$/;
      (parsed.editions as any[]).forEach((edition, i) => {
        if (!edition.date || !datePattern.test(edition.date)) {
          errors.push(`Edition at index ${i} has an invalid date: "${edition.date}" (expected YYYY-MM-DD).`);
        }
        if (!Array.isArray(edition.pages)) {
          errors.push(`Edition "${edition.date}" (index ${i}) is missing a "pages" array.`);
        } else {
          (edition.pages as any[]).forEach((page, pi) => {
            if (page.id === undefined || page.id === null) {
              errors.push(`Page at index ${pi} in edition "${edition.date}" is missing an "id".`);
            }
            if (!page.fullImage && !page.thumbnail) {
              warnings.push(`Page ${page.id ?? pi} in edition "${edition.date}" has no image URL.`);
            }
            if (!Array.isArray(page.sections)) {
              errors.push(`Page ${page.id ?? pi} in edition "${edition.date}" is missing a "sections" array.`);
            }
          });
        }
      });
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  buildImportPreview(parsed: any): ImportPreview {
    const currentData = this.getData();
    const currentEditions = currentData.editions || [];
    const currentDatesSet = new Set(currentEditions.map(e => e.date));

    const hasEditions = Array.isArray(parsed.editions);
    const hasSettings = typeof parsed.settings === 'object' && parsed.settings !== null;
    const incomingEditions: NewspaperEdition[] = hasEditions ? parsed.editions : [];
    const incomingDates = incomingEditions.map(e => e.date);

    const newEditions = [...new Set(incomingDates.filter(d => !currentDatesSet.has(d)))];
    const conflictingEditions = [...new Set(incomingDates.filter(d => currentDatesSet.has(d)))];
    const sortedIncoming = [...incomingDates].sort();
    const incomingDateRange = sortedIncoming.length > 0
      ? { from: sortedIncoming[0], to: sortedIncoming[sortedIncoming.length - 1] }
      : null;

    const meta: ExportMeta | null = parsed.meta ?? null;
    const sourceUrl = meta?.sourceUrl ?? '';
    const currentUrl = this.wpBaseUrl;
    const inferredType: ExportMeta['exportType'] =
      hasEditions && hasSettings ? 'full' : hasEditions ? 'editions-only' : 'settings-only';

    return {
      sourceUrl: sourceUrl || 'Unknown (older backup format)',
      currentUrl,
      urlMismatch: !!sourceUrl && sourceUrl !== currentUrl,
      exportedAt: meta?.exportedAt ?? 'Unknown',
      schemaVersion: meta?.schemaVersion ?? 1,
      exportType: meta?.exportType ?? inferredType,
      exportScope: meta?.exportScope ?? 'unknown',
      incomingEditionCount: incomingEditions.length,
      currentEditionCount: currentEditions.length,
      incomingDateRange,
      newEditions,
      conflictingEditions,
      hasSettings,
      hasEditions,
    };
  }

  // ─── Image URL Rewriting ─────────────────────────────────────────────────

  rewriteImageUrls(data: NewspaperData, oldBase: string, newBase: string): NewspaperData {
    const rewrite = (url: string | undefined): string | undefined => {
      if (!url || typeof url !== 'string') return url;
      return url.startsWith(oldBase) ? newBase + url.slice(oldBase.length) : url;
    };

    return {
      ...data,
      settings: data.settings ? {
        ...data.settings,
        logo: data.settings.logo ? {
          ...data.settings.logo,
          url: rewrite(data.settings.logo.url) ?? '',
        } : data.settings.logo,
      } : data.settings,
      editions: (data.editions || []).map(edition => ({
        ...edition,
        pages: edition.pages.map(page => ({
          ...page,
          thumbnail: rewrite(page.thumbnail) ?? '',
          fullImage: rewrite(page.fullImage) ?? '',
          fullImageHiRes: rewrite(page.fullImageHiRes),
          sections: page.sections.map(section => ({
            ...section,
            imageUrl: rewrite(section.imageUrl),
          })),
        })),
      })),
    };
  }

  // ─── Apply Import ─────────────────────────────────────────────────────────

  applyImport(parsed: any, options: ImportOptions): NewspaperData {
    const currentData = this.getData();

    let importedEditions: NewspaperEdition[] = Array.isArray(parsed.editions) ? [...parsed.editions] : [];
    let importedSettings: GlobalSettings | undefined = parsed.settings ?? undefined;

    // Normalize imported settings (backward compat)
    if (importedSettings) {
      if (!importedSettings.logo) {
        importedSettings = { ...importedSettings, logo: { url: '', alt: 'Digital Newspaper' } };
      }
      if (!importedSettings.socialLinks || Array.isArray(importedSettings.socialLinks)) {
        importedSettings = { ...importedSettings, socialLinks: {} };
      }
    }

    // URL rewriting
    if (options.rewriteUrls && options.oldBaseUrl && options.newBaseUrl && options.oldBaseUrl !== options.newBaseUrl) {
      const temp: NewspaperData = { settings: importedSettings, editions: importedEditions };
      const rewritten = this.rewriteImageUrls(temp, options.oldBaseUrl, options.newBaseUrl);
      importedEditions = rewritten.editions;
      importedSettings = rewritten.settings;
    }

    const resultSettings = options.importSettings && importedSettings
      ? importedSettings
      : currentData.settings;

    let resultEditions = currentData.editions;
    if (options.importEditions && importedEditions.length > 0) {
      if (options.mergeMode === 'overwrite-all') {
        resultEditions = importedEditions;
      } else if (options.mergeMode === 'add-new') {
        const currentKeys = new Set(currentData.editions.map(e => `${e.date}:${e.edition ?? 1}`));
        const newOnly = importedEditions.filter(e => !currentKeys.has(`${e.date}:${e.edition ?? 1}`));
        resultEditions = [...currentData.editions, ...newOnly].sort((a, b) => {
          const d = b.date.localeCompare(a.date);
          return d !== 0 ? d : (a.edition ?? 1) - (b.edition ?? 1);
        });
      } else {
        // add-and-replace
        const map = new Map(currentData.editions.map(e => [`${e.date}:${e.edition ?? 1}`, e]));
        importedEditions.forEach(e => map.set(`${e.date}:${e.edition ?? 1}`, e));
        resultEditions = Array.from(map.values()).sort((a, b) => {
          const d = b.date.localeCompare(a.date);
          return d !== 0 ? d : (a.edition ?? 1) - (b.edition ?? 1);
        });
      }
    }

    return { settings: resultSettings, editions: resultEditions };
  }
}
