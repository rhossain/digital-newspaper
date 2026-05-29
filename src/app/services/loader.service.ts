import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Counter-based global loading indicator service.
 *
 * Multiple concurrent callers can each call `show()` and `hide()` independently;
 * the spinner stays visible until every caller has hidden it.
 *
 * Usage:
 *   this.loader.show();
 *   doAsyncWork().finally(() => this.loader.hide());
 */
@Injectable({ providedIn: 'root' })
export class LoaderService {
  private count = new BehaviorSubject<number>(0);

  /** Observable that is `true` while at least one operation is in progress. */
  readonly isLoading$ = this.count.pipe(map(n => n > 0));

  /** Increment the active-operation counter (show spinner). */
  show(): void {
    this.count.next(this.count.value + 1);
  }

  /** Decrement the active-operation counter (hide spinner when counter reaches 0). */
  hide(): void {
    this.count.next(Math.max(0, this.count.value - 1));
  }
}
