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
}

export interface NewspaperData {
  settings?: GlobalSettings;
  editions: NewspaperEdition[];
}

@Injectable({
  providedIn: 'root'
})
export class NewspaperDataService {
  private static readonly SETTINGS_CACHE_KEY = 'dn_global_settings';

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
      timeout(10000),
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
    return this.getTodayDate();
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

  private loadCachedSettings(): GlobalSettings | null {
    return NewspaperDataService._readCachedSettings();
  }

  downloadJSON(): void {
    const data = this.getData();
    const date = this.getCurrentDate();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `newspaper-data-${date}.json`;
    link.click();
    window.URL.revokeObjectURL(url);
  }
}
