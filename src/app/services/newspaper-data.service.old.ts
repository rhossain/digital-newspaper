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
  // Backwards compatibility
  pages?: NewspaperPage[];
}

@Injectable({
  providedIn: 'root'
})
export class NewspaperDataService {
  private dataSubject = new BehaviorSubject<NewspaperData>({ editions: [] });
  private currentDateSubject = new BehaviorSubject<string>(this.getTodayDate());
  
  currentDate$ = this.currentDateSubject.asObservable();
  public data$ = this.dataSubject.asObservable();
  
  private apiUrl = 'http://localhost:3000/api/newspaper-data';

  constructor(private http: HttpClient) {}

  loadData(): Observable<NewspaperData> {
    return this.http.get<NewspaperData>(this.apiUrl).pipe(
      tap(data => this.dataSubject.next(data))
    );
  }

  getData(): NewspaperData {
    return this.dataSubject.value;
  }

  saveData(data: NewspaperData): Observable<any> {
    // Update the local data
    this.dataSubject.next(data);
    
    // Save to backend
    return this.http.post(this.apiUrl, data);
  }

  addPage(page: NewspaperPage): void {
    const currentData = this.getData();
    const newData = { 
      pages: [...currentData.pages, { ...page, sections: [...page.sections] }] 
    };
    this.dataSubject.next(newData);
  }

  updatePage(pageId: number, updatedPage: NewspaperPage): void {
    const currentData = this.getData();
    const newPages = currentData.pages.map(p => 
      p.id === pageId ? { ...updatedPage, sections: [...updatedPage.sections] } : p
    );
    this.dataSubject.next({ pages: newPages });
  }

  deletePage(pageId: number): void {
    const currentData = this.getData();
    const newPages = currentData.pages.filter(p => p.id !== pageId);
    this.dataSubject.next({ pages: newPages });
  }

  addSection(pageId: number, section: NewsSection): void {
    const currentData = this.getData();
    const newPages = currentData.pages.map(page => {
      if (page.id === pageId) {
        return { ...page, sections: [...page.sections, { ...section }] };
      }
      return page;
    });
    this.dataSubject.next({ pages: newPages });
  }

  updateSection(pageId: number, sectionId: string, updatedSection: NewsSection): void {
    const currentData = this.getData();
    const newPages = currentData.pages.map(page => {
      if (page.id === pageId) {
        const newSections = page.sections.map(s => 
          s.id === sectionId ? { ...updatedSection } : s
        );
        return { ...page, sections: newSections };
      }
      return page;
    });
    this.dataSubject.next({ pages: newPages });
  }

  deleteSection(pageId: number, sectionId: string): void {
    const currentData = this.getData();
    const newPages = currentData.pages.map(page => {
      if (page.id === pageId) {
        return { ...page, sections: page.sections.filter(s => s.id !== sectionId) };
      }
      return page;
    });
    this.dataSubject.next({ pages: newPages });
  }

  getNextPageId(): number {
    const currentData = this.getData();
    if (currentData.pages.length === 0) return 1;
    return Math.max(...currentData.pages.map(p => p.id)) + 1;
  }

  downloadJSON(): void {
    const data = this.getData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'newspaper-data.json';
    link.click();
    window.URL.revokeObjectURL(url);
  }
}
