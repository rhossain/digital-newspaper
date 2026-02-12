import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject, from, of } from 'rxjs';
import { tap, map, catchError, switchMap } from 'rxjs/operators';
import { CacheService } from './cache.service';
import { CacheManagerService } from './cache-manager.service';

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
}

export interface NewspaperEdition {
  date: string; // Format: YYYY-MM-DD
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
}

export interface NewspaperData {
  settings?: GlobalSettings;
  editions: NewspaperEdition[];
}

@Injectable({
  providedIn: 'root'
})
export class NewspaperDataService {
  private dataSubject = new BehaviorSubject<NewspaperData>({
    settings: {
      defaultDateMode: 'current',
      socialLinks: {}
    },
    editions: []
  });
  private currentDateSubject = new BehaviorSubject<string>(this.getTodayDate());
  
  currentDate$ = this.currentDateSubject.asObservable();
  public data$ = this.dataSubject.asObservable();
  
  // Use relative path for production, works with any domain
  private assetsUrl = '/assets/newspaper-data.json';
  private apiBaseUrl: string = (window as any).__API_BASE_URL
    || (window.location.hostname === 'localhost' ? 'http://localhost:3000' : window.location.origin);
  private apiUrl = `${this.apiBaseUrl}/api/newspaper-data`;
  private backendApiUrl = `${this.apiBaseUrl}/api/newspaper-data`;

  constructor(
    private http: HttpClient,
    private cacheService: CacheService,
    private cacheManager: CacheManagerService
  ) {
    // Initialize cache maintenance
    this.initializeCacheMaintenance();
  }

  /**
   * Initialize cache maintenance routines
   */
  private initializeCacheMaintenance(): void {
    // Clean expired cache entries every hour
    setInterval(() => {
      this.cacheManager.performMaintenance();
    }, 3600000);
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

  // Data loading with backwards compatibility and caching
  loadData(): Observable<NewspaperData> {
    const cacheKey = 'data:newspaper-all';
    
    // Try cache first
    return from(this.cacheService.get<NewspaperData>(cacheKey, 'data')).pipe(
      switchMap(cachedData => {
        if (cachedData) {
          console.log('Loading newspaper data from cache');
          this.dataSubject.next(cachedData);
          return of(cachedData);
        }

        // Fetch from network
        console.log('Loading newspaper data from network');
        return this.http.get<NewspaperData | { pages: NewspaperPage[] }>(this.apiUrl).pipe(
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
            // Ensure settings exist
            const result = data as NewspaperData;
            if (!result.settings) {
              result.settings = {
                defaultDateMode: 'current',
                socialLinks: {}
              };
            }
            return result;
          }),
          tap((data: NewspaperData) => {
            this.dataSubject.next(data);
            // Cache the data (24 hour TTL)
            this.cacheService.set(cacheKey, data, { ttl: 86400000 }, 'data');
            // Preload current edition
            const currentDate = this.getCurrentDate();
            const currentEdition = data.editions.find(e => e.date === currentDate);
            if (currentEdition) {
              this.cacheManager.preloadEdition(currentDate, currentEdition.pages);
            }
          })
        );
      })
    );
  }

  getData(): NewspaperData {
    return this.dataSubject.value;
  }

  // Get edition for specific date
  getEditionByDate(date: string): NewspaperEdition | null {
    const data = this.getData();
    return data.editions.find(e => e.date === date) || null;
  }

  // Get current edition based on selected date
  getCurrentEdition(): NewspaperEdition | null {
    return this.getEditionByDate(this.getCurrentDate());
  }

  // Get all available dates
  getAvailableDates(): string[] {
    const data = this.getData();
    // Only return dates that have pages created
    return data.editions
      .filter(e => e.pages && e.pages.length > 0)
      .map(e => e.date)
      .sort()
      .reverse();
  }

  // Create or get edition for a date
  getOrCreateEdition(date: string): NewspaperEdition {
    const existing = this.getEditionByDate(date);
    if (existing) return existing;
    
    const newEdition: NewspaperEdition = {
      date,
      pages: []
    };
    
    const currentData = this.getData();
    const newEditions = [...currentData.editions, newEdition].sort((a, b) => 
      b.date.localeCompare(a.date)
    );
    
    this.dataSubject.next({ editions: newEditions });
    return newEdition;
  }

  saveData(data: NewspaperData): Observable<any> {
    // Update the local data
    this.dataSubject.next(data);
    
    // Invalidate main cache
    this.cacheService.delete('data:newspaper-all', 'data');
    
    // Save to backend API
    return this.http.post(this.backendApiUrl, data);
  }

  getApiBaseUrl(): string {
    return this.apiBaseUrl;
  }

  // Add page to current date's edition
  addPage(page: NewspaperPage, date?: string): void {
    const targetDate = date || this.getCurrentDate();
    const currentData = this.getData();
    
    let foundEdition = false;
    const newEditions = currentData.editions.map(edition => {
      if (edition.date === targetDate) {
        foundEdition = true;
        return { ...edition, pages: [...edition.pages, {...page, sections: [...page.sections]}] };
      }
      return edition;
    });
    
    // If edition doesn't exist, create it
    if (!foundEdition) {
      newEditions.push({
        date: targetDate,
        pages: [{...page, sections: [...page.sections]}]
      });
      newEditions.sort((a, b) => b.date.localeCompare(a.date));
    }
    
    this.dataSubject.next({ ...currentData, editions: newEditions });
    
    // Invalidate cache for this date
    this.cacheManager.onPageAdded(page.id, targetDate);
  }

  updatePage(pageId: number, updatedPage: NewspaperPage, date?: string): void {
    const targetDate = date || this.getCurrentDate();
    const currentData = this.getData();
    
    const newEditions = currentData.editions.map(edition => {
      if (edition.date === targetDate) {
        const newPages = edition.pages.map(page => 
          page.id === pageId ? { ...updatedPage, sections: [...updatedPage.sections] } : page
        );
        return { ...edition, pages: newPages };
      }
      return edition;
    });
    
    this.dataSubject.next({ ...currentData, editions: newEditions });
    
    // Invalidate cache for this page
    this.cacheManager.onPageUpdated(pageId, targetDate);
  }

  deletePage(pageId: number, date?: string): void {
    const targetDate = date || this.getCurrentDate();
    const currentData = this.getData();
    
    const newEditions = currentData.editions.map(edition => {
      if (edition.date === targetDate) {
        return { ...edition, pages: edition.pages.filter(p => p.id !== pageId) };
      }
      return edition;
    });
    
    this.dataSubject.next({ ...currentData, editions: newEditions });
    
    // Invalidate cache for this page
    this.cacheManager.onPageDeleted(pageId, targetDate);
  }

  addSection(pageId: number, section: NewsSection, date?: string): void {
    const targetDate = date || this.getCurrentDate();
    const currentData = this.getData();
    
    const newEditions = currentData.editions.map(edition => {
      if (edition.date === targetDate) {
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
    
    // Invalidate cache for this section
    this.cacheManager.onSectionAdded(section.id, pageId, targetDate);
  }

  updateSection(pageId: number, sectionId: string, updatedSection: NewsSection, date?: string): void {
    const targetDate = date || this.getCurrentDate();
    const currentData = this.getData();
    
    const newEditions = currentData.editions.map(edition => {
      if (edition.date === targetDate) {
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
    
    // Invalidate cache for this section
    this.cacheManager.onSectionUpdated(sectionId, pageId, targetDate);
  }

  deleteSection(pageId: number, sectionId: string, date?: string): void {
    const targetDate = date || this.getCurrentDate();
    const currentData = this.getData();
    
    const newEditions = currentData.editions.map(edition => {
      if (edition.date === targetDate) {
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
    
    // Invalidate cache for this section
    this.cacheManager.onSectionDeleted(sectionId, pageId, targetDate);
  }

  getNextPageId(date?: string): number {
    const targetDate = date || this.getCurrentDate();
    const edition = this.getEditionByDate(targetDate);
    if (!edition || edition.pages.length === 0) return 1;
    return Math.max(...edition.pages.map(p => p.id)) + 1;
  }

  // Global Settings Management
  getSettings(): GlobalSettings {
    const data = this.getData();
    return data.settings || {
      defaultDateMode: 'current',
      socialLinks: {}
    };
  }

  updateSettings(settings: GlobalSettings): void {
    const currentData = this.getData();
    this.dataSubject.next({
      ...currentData,
      settings
    });
    
    // Invalidate settings cache
    this.cacheManager.onSettingsUpdated();
  }

  getDefaultDate(): string {
    const settings = this.getSettings();
    if (settings.defaultDateMode === 'specific' && settings.specificDate) {
      return settings.specificDate;
    }
    return this.getTodayDate();
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
