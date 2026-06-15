import { Pipe, PipeTransform } from '@angular/core';

/**
 * Pure pipe that strips &nbsp; HTML entities and Unicode non-breaking spaces
 * (U+00A0) so that article text wraps naturally in the modal body.
 *
 * Declared as `pure: true` (the default) so Angular only re-evaluates it when
 * the input reference changes — much cheaper than calling a component method
 * which re-runs on every change-detection cycle.
 */
@Pipe({
  name: 'normalizeContent',
  standalone: true,
  pure: true,
})
export class NormalizeContentPipe implements PipeTransform {
  transform(content: string | undefined | null): string {
    if (!content) return '';
    return content
      .replace(/&nbsp;/g, ' ')
      .replace(/ /g, ' ');
  }
}
