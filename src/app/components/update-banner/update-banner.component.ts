import { Component, Output, EventEmitter, ChangeDetectionStrategy } from '@angular/core';

/**
 * A slim sticky banner shown when a new service-worker version is ready.
 *
 * Usage (in AppComponent template):
 *   @if (updateAvailable) {
 *     <app-update-banner (dismissed)="applyUpdate()" />
 *   }
 *
 * The parent is responsible for calling `swUpdate.activateUpdate()` and
 * `location.reload()` when `dismissed` fires.
 */
@Component({
  selector: 'app-update-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="update-banner" role="alert" aria-live="polite">
      <span class="update-banner__text">
        নতুন সংস্করণ পাওয়া গেছে।
      </span>
      <button class="update-banner__btn" (click)="dismiss()">
        রিলোড করুন
      </button>
    </div>
  `,
  styles: [`
    .update-banner {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 100000;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: 10px 16px;
      background: #1976d2;
      color: #fff;
      font-size: 14px;
      font-family: inherit;
      box-shadow: 0 -2px 8px rgba(0,0,0,.18);
    }

    .update-banner__btn {
      padding: 5px 14px;
      border: 1.5px solid #fff;
      border-radius: 4px;
      background: transparent;
      color: #fff;
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;
    }

    .update-banner__btn:hover {
      background: rgba(255,255,255,.15);
    }
  `]
})
export class UpdateBannerComponent {
  /** Fires when the user clicks the reload button. */
  @Output() dismissed = new EventEmitter<void>();

  dismiss(): void {
    this.dismissed.emit();
  }
}
