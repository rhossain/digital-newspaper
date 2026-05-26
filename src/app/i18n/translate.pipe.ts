import { Pipe, PipeTransform } from '@angular/core';
import { TranslationService } from './translation.service';

/**
 * Usage in templates: {{ 'viewer.noContent' | translate }}
 * pure: false so it re-renders when the language changes at runtime.
 */
@Pipe({ name: 'translate', standalone: true, pure: false })
export class TranslatePipe implements PipeTransform {
  private cache = new Map<string, string>();
  private cachedLang = '';

  constructor(private ts: TranslationService) {}

  transform(key: string): string {
    const lang = this.ts.language;
    if (lang !== this.cachedLang) {
      this.cache.clear();
      this.cachedLang = lang;
    }
    let value = this.cache.get(key);
    if (value === undefined) {
      value = this.ts.t(key);
      this.cache.set(key, value);
    }
    return value;
  }
}
