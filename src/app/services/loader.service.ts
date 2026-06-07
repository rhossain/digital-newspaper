import { Injectable } from '@angular/core';
import { BehaviorSubject, combineLatest } from 'rxjs';
import { map, distinctUntilChanged } from 'rxjs/operators';

export interface LoaderState {
  /** True while at least one operation is in progress. */
  isLoading: boolean;
  /** The most recently set message (may be empty). */
  message: string;
}

/**
 * Counter-based global loading indicator service.
 *
 * Multiple concurrent callers can each call show() / hide() independently;
 * the overlay stays visible until every caller has called hide().
 *
 * Usage:
 *   this.loader.show('Saving data…');
 *   doAsyncWork().finally(() => this.loader.hide());
 */
@Injectable({ providedIn: 'root' })
export class LoaderService {
  private count   = new BehaviorSubject<number>(0);
  private message = new BehaviorSubject<string>('');

  /** Emits the full loader state (isLoading + message). */
  readonly state$ = combineLatest([this.count, this.message]).pipe(
    map(([n, msg]) => ({ isLoading: n > 0, message: msg } as LoaderState)),
    distinctUntilChanged((a, b) => a.isLoading === b.isLoading && a.message === b.message)
  );

  /** Convenience observable: true while at least one operation is in progress. */
  readonly isLoading$ = this.count.pipe(map(n => n > 0), distinctUntilChanged());

  /**
   * Increment the active-operation counter and optionally set a status message.
   * @param message  Human-readable description shown in the overlay (e.g. "Saving data…")
   */
  show(message = ''): void {
    if (message) this.message.next(message);
    this.count.next(this.count.value + 1);
  }

  /**
   * Decrement the active-operation counter.
   * Clears the message automatically once the counter reaches zero.
   */
  hide(): void {
    const next = Math.max(0, this.count.value - 1);
    this.count.next(next);
    if (next === 0) this.message.next('');
  }

  /** Synchronous snapshot — true while at least one operation is active. */
  get isSaving(): boolean {
    return this.count.value > 0;
  }

  /**
   * Update the displayed message without changing the active-operation counter.
   * Use this to reflect progress within a single show/hide pair.
   */
  setMessage(message: string): void {
    this.message.next(message);
  }

  /** Force-reset: use when an unhandled error leaves the counter stuck. */
  reset(): void {
    this.count.next(0);
    this.message.next('');
  }
}
