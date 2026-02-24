import { Pipe, PipeTransform } from '@angular/core';
import { TranslationService } from './translation.service';

/**
 * Usage in templates: {{ '2026-02-24' | localeDate:'full' }}
 * Formats a YYYY-MM-DD date string according to the active locale.
 * pure: false so it re-renders when the language changes at runtime.
 */
@Pipe({ name: 'localeDate', standalone: true, pure: false })
export class LocaleDatePipe implements PipeTransform {
  constructor(private ts: TranslationService) {}

  transform(dateStr: string, format: 'full' | 'long' | 'short' = 'long'): string {
    return this.ts.formatDate(dateStr, format);
  }
}
