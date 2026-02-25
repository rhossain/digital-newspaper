import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { EN } from './translations/en';
import { BN } from './translations/bn';

export type Language = 'en' | 'bn';
export type Translations = typeof EN;

const BANGLA_DIGITS: string[] = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

@Injectable({ providedIn: 'root' })
export class TranslationService {
  private lang$ = new BehaviorSubject<Language>('en');
  private translations: Record<Language, Translations> = { en: EN, bn: BN };

  get language(): Language {
    return this.lang$.getValue();
  }

  setLanguage(lang: Language): void {
    this.lang$.next(lang);
  }

  /** Resolve a dot-separated key like 'viewer.noContent' */
  t(key: string): string {
    const keys = key.split('.');
    let value: any = this.translations[this.language];
    for (const k of keys) {
      value = value?.[k];
    }
    return typeof value === 'string' ? value : key;
  }

  get dates(): Translations['dates'] {
    return this.translations[this.language].dates;
  }

  /** Convert ASCII digits to Bangla digits when language is 'bn'. */
  toLocaleDigits(num: string | number): string {
    if (this.language !== 'bn') return String(num);
    return String(num).replace(/[0-9]/g, (d) => BANGLA_DIGITS[+d]);
  }

  /**
   * Returns the ordinal edition name for a given 1-based number in the active language.
   * e.g. 1 → "First Edition" / "প্রথম সংস্করণ"
   * Falls back to "<edition-word> N" for numbers beyond the list.
   */
  getEditionName(num: number): string {
    const names = this.translations[this.language].viewer.editionNames;
    return names[num - 1] ?? `${this.t('viewer.edition')} ${this.toLocaleDigits(num)}`;
  }

  /**
   * Format a YYYY-MM-DD string according to the active locale.
   * format:
   *   'full'  → weekday + day + month + year  (e.g. "Friday, 24 February 2026")
   *   'long'  → day + month + year            (e.g. "24 February 2026")
   *   'short' → day + short-month + year      (e.g. "24 Feb 2026")
   */
  formatDate(dateStr: string, format: 'full' | 'long' | 'short' = 'long'): string {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const { months, shortMonths, days } = this.dates;
    const dayName = days[date.getDay()];
    const monthName = format === 'short' ? shortMonths[m - 1] : months[m - 1];
    const dayStr = this.toLocaleDigits(d);
    const yearStr = this.toLocaleDigits(y);

    if (format === 'full') {
      return `${dayName}, ${dayStr} ${monthName} ${yearStr}`;
    }
    if (format === 'short') {
      return `${dayStr} ${monthName} ${yearStr}`;
    }
    // 'long'
    return `${dayStr} ${monthName} ${yearStr}`;
  }
}
