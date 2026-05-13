import {
  Component,
  OnInit,
  OnDestroy,
  Output,
  EventEmitter,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { SubscriptionService } from '../../services/subscription.service';
import { TranslationService } from '../../i18n/translation.service';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { CLIENT_PACKAGE } from '../../config';
import type { SubscriptionStatus } from '../../models/subscription.models';

/**
 * Header badge shown only for the 'publisher' package.
 * - Not logged in: shows a "Subscribe" prompt link.
 * - Logged in, no subscription: shows a "Subscribe" button.
 * - Active subscription: shows the plan name + expiry date.
 */
@Component({
  selector: 'app-subscription-status',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './subscription-status.component.html',
  styleUrls: ['./subscription-status.component.css'],
})
export class SubscriptionStatusComponent implements OnInit, OnDestroy {
  readonly isPublisherPackage = CLIENT_PACKAGE === 'publisher';

  /** Emitted when a non-subscriber clicks the badge. Parent should open the paywall. */
  @Output() openPaywall = new EventEmitter<void>();

  isLoggedIn = false;
  status: SubscriptionStatus | null = null;

  private subs: Subscription[] = [];

  constructor(
    private auth: AuthService,
    private subscriptionService: SubscriptionService,
    public ts: TranslationService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.isLoggedIn = this.auth.isAuthenticated();

    const sub = this.subscriptionService.status$.subscribe((status) => {
      this.status = status;
      this.isLoggedIn = this.auth.isAuthenticated();
      this.cdr.markForCheck();
    });
    this.subs.push(sub);
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  get hasActiveSubscription(): boolean {
    return this.status?.hasActiveSubscription === true;
  }

  get userName(): string {
    return this.auth.getDisplayName();
  }

  get expiryDisplay(): string {
    if (!this.status?.expiresAt) return '';
    const date = new Date(this.status.expiresAt + 'T00:00:00');
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
}
