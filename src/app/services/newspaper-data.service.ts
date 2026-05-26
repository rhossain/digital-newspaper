import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject } from 'rxjs';
import { tap, map, catchError, timeout } from 'rxjs/operators';
import { AuthService } from './auth.service';
import { WP_BASE_URL } from '../config';

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
  showCaption?: boolean;
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
  /** Raw HTML string of <script> / <noscript> tags to inject into <head> (e.g. Google Analytics). */
  headScripts?: string;
}

export interface NewspaperData {
  settings?: GlobalSettings;
  editions: NewspaperEdition[];
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

@Injectable({
  providedIn: 'root'
})
export class NewspaperDataService {
  private static readonly SETTINGS_CACHE_KEY = 'dn_global_settings';
  private static readonly BACKUP_HISTORY_KEY = 'dn_backup_history';
  private static readonly MAX_HISTORY_ENTRIES = 20;

  private dataSubject!: BehaviorSubject<NewspaperData>;
  private currentDateSubject!: BehaviorSubject<string>;
  
  currentDate$!: Observable<string>;
  public data$!: Observable<NewspaperData>;
  
  // WordPress REST API base
  private assetsUrl = '/assets/newspaper-data.json';
  private readonly wpBaseUrl = WP_BASE_URL;
  private readonly apiUrl = `${WP_BASE_URL}/wp-json/digital-newspaper/v1/data`;

  constructor(private http: HttpClient, private auth: AuthService) {
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
  }

  // Date helper methods
  getTodayDate(): string {
    const today = new Date();
    return today.toISOString().split('T')[0]; // YYYY-MM-DD
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

  getCurrentDate(): string {
    return this.currentDateSubject.value;
  }

  // Data loading with backwards compatibility (no caching)
  loadData(): Observable<NewspaperData> {
    return this.http.get<NewspaperData | { pages: NewspaperPage[] }>(this.apiUrl).pipe(
      timeout(5000),
      catchError(() => this.http.get<NewspaperData | { pages: NewspaperPage[] }>(this.assetsUrl)),
      map((data): NewspaperData => {
        // Backwards compatibility: convert old format to new format
        if ('pages' in data && !('editions' in data)) {
          const todayDate = this.getTodayDate();
          return {
            settings: {
              defaultDateMode: 'current',
              socialLinks: {}
            },
            editions: [{
              date: todayDate,
              pages: data.pages
            }]
          };
        }
        // Ensure settings exist and are normalized
        const result = data as NewspaperData;
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
        // Cache settings from the API for offline / quick-startup use
        if (result.settings) {
          this.cacheSettings(result.settings);
        }
        // Normalize page fields: PHP serializes empty/unset strings as [] (empty
        // array) which is truthy in JS, causing *ngIf guards to pass while
        // [src] bindings receive a non-string and silently resolve to "".
        result.editions.forEach(edition => {
          edition.pages = edition.pages.map(page => ({
            ...page,
            thumbnail: typeof page.thumbnail === 'string' ? page.thumbnail : '',
            fullImage: typeof page.fullImage === 'string' ? page.fullImage : '',
            sections: Array.isArray(page.sections) ? page.sections.map(section => ({
              ...section,
              imageUrl: typeof section.imageUrl === 'string' ? section.imageUrl : undefined,
            })) : [],
          }));
        });
        return result;
      }),
      tap((data: NewspaperData) => {
        this.dataSubject.next(data);
      })
    );
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
    return [...new Set(datesWithPages)].sort().reverse();
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

  saveData(data: NewspaperData): Observable<any> {
    // Update the local data
    this.dataSubject.next(data);
    
    // Persist settings to localStorage for cross-window availability
    if (data.settings) {
      this.cacheSettings(data.settings);
    }
    
    // Save to backend API
    const headers = this.auth.getAuthHeaders();
    return this.http.post(this.apiUrl, data, { headers });
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
        return { ...edition, pages: [...edition.pages, {...page, sections: [...page.sections]}] };
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
    
    const newEditions = currentData.editions.map(edition => {
      if (this.editionMatches(edition, targetDate, editionNumber)) {
        const newPages = edition.pages.map(page => {
          if (page.id === pageId) {
            const newSections = page.sections.map(s =>
              s.id === sectionId ? { ...updatedSection } : s
            );
            return { ...page, sections: newSections };
          }
          return page;
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
  getSettings(): GlobalSettings {
    const data = this.getData();
    const raw = data.settings;
    if (!raw) {
      return {
        defaultDateMode: 'current',
        socialLinks: {},
        logo: { url: '', alt: 'Digital Newspaper' },
        editor: '',
        address: {},
        language: 'en'
      };
    }
    // Ensure every sub-object exists so callers don't have to null-check
    return {
      ...raw,
      logo: raw.logo || { url: '', alt: 'Digital Newspaper' },
      socialLinks: (raw.socialLinks && !Array.isArray(raw.socialLinks))
        ? raw.socialLinks
        : {},
      address: raw.address || {},
      editor: raw.editor ?? '',
      language: raw.language || 'en'
    };
  }

  updateSettings(settings: GlobalSettings): void {
    const currentData = this.getData();
    this.dataSubject.next({
      ...currentData,
      settings
    });
    // Persist to localStorage so new windows pick it up immediately
    this.cacheSettings(settings);
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
    try {
      localStorage.setItem(
        NewspaperDataService.SETTINGS_CACHE_KEY,
        JSON.stringify(settings)
      );
    } catch (_e) { /* quota exceeded or private mode – silently ignore */ }
  }

  /** Static helper so it can be called before the instance is fully constructed. */
  private static _readCachedSettings(): GlobalSettings | null {
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
    const blob = new Blob([json], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.URL.revokeObjectURL(url);
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
