import { Pipe, PipeTransform } from '@angular/core';
import { TranslationService } from './translation.service';

/**
 * Usage in templates: {{ 'viewer.noContent' | translate }}
 * pure: false so it re-renders when the language changes at runtime.
 */
@Pipe({ name: 'translate', standalone: true, pure: false })
export class TranslatePipe implements PipeTransform {
  constructor(private ts: TranslationService) {}

  transform(key: string): string {
    return this.ts.t(key);
  }
}
