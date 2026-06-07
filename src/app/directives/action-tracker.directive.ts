import { Directive, Input, HostListener, ElementRef } from '@angular/core';
import { ActivityLogService } from '../services/activity-log.service';

/**
 * Attribute directive that logs a user action to the activity log
 * whenever the host element is clicked.
 *
 * Usage:
 *   <button (click)="savePage()" dnTrack="page_save" [dnDetails]="{pageId: '3'}">Save</button>
 *
 * The [dnTrack] value is a machine-readable action key from ACTION_LABELS.
 * [dnDetails] is an optional key→value map shown in the detail column.
 *
 * The directive automatically suppresses logging when:
 *  - The host element has a truthy `disabled` attribute/property
 *  - [dnTrackDisabled]="true" is explicitly set
 *  - The action string is empty
 */
@Directive({
  selector: '[dnTrack]',
  standalone: true,
})
export class ActionTrackerDirective {
  @Input('dnTrack')         action   = '';
  @Input('dnDetails')       details: Record<string, string> = {};
  @Input('dnTrackDisabled') trackDisabled = false;

  constructor(
    private log: ActivityLogService,
    private el: ElementRef<HTMLElement>,
  ) {}

  @HostListener('click')
  onClick(): void {
    if (!this.action) return;
    if (this.trackDisabled) return;
    // Guard: don't log clicks on disabled buttons (some browsers fire click
    // events on disabled elements in certain conditions, e.g. via keyboard).
    const el = this.el.nativeElement;
    if ((el as HTMLButtonElement).disabled) return;
    if (el.getAttribute('disabled') !== null && el.getAttribute('disabled') !== 'false') return;
    this.log.track(this.action, this.details ?? {});
  }
}
