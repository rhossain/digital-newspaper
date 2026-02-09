import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject } from 'rxjs';
import { tap, map } from 'rxjs/operators';

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

export interface NewspaperData {
  editions: NewspaperEdition[];
}

@Injectable({
  providedIn: 'root'
})
export class NewspaperDataService {
  private dataSubject = new BehaviorSubject<NewspaperData>({ editions: [] });
  private currentDateSubject = new BehaviorSubject<string>(this.getTodayDate());
  
  currentDate$ = this.currentDateSubject.asObservable();
  public data$ = this.dataSubject.asObservable();
  
  // Use relative path for production, works with any domain
  private apiUrl = '/assets/newspaper-data.json';

  constructor(private http: HttpClient) {}

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

  // Data loading with backwards compatibility
  loadData(): Observable<NewspaperData> {
    return this.http.get<NewspaperData | { pages: NewspaperPage[] }>(this.apiUrl).pipe(
      map((data): NewspaperData => {
        // Backwards compatibility: convert old format to new format
        if ('pages' in data && !('editions' in data)) {
          const todayDate = this.getTodayDate();
          return {
            editions: [{
              date: todayDate,
              pages: data.pages
            }]
          };
        }
        return data as NewspaperData;
      }),
      tap((data: NewspaperData) => this.dataSubject.next(data))
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
    return data.editions.map(e => e.date).sort().reverse();
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
    
    // Save to backend
    return this.http.post(this.apiUrl, data);
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
    
    this.dataSubject.next({ editions: newEditions });
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
    
    this.dataSubject.next({ editions: newEditions });
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
    
    this.dataSubject.next({ editions: newEditions });
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
    
    this.dataSubject.next({ editions: newEditions });
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
    
    this.dataSubject.next({ editions: newEditions });
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
    
    this.dataSubject.next({ editions: newEditions });
  }

  getNextPageId(date?: string): number {
    const targetDate = date || this.getCurrentDate();
    const edition = this.getEditionByDate(targetDate);
    if (!edition || edition.pages.length === 0) return 1;
    return Math.max(...edition.pages.map(p => p.id)) + 1;
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
