import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription, timer } from 'rxjs';
import { switchMap, take } from 'rxjs/operators';
import { AuthService } from '../../services/auth.service';
import { SubscriptionService } from '../../services/subscription.service';
import { NewspaperDataService } from '../../services/newspaper-data.service';
import { TranslationService } from '../../i18n/translation.service';
import { TranslatePipe } from '../../i18n/translate.pipe';
import type { SubscriptionPlan, AccessMode } from '../../models/subscription.models';
import { WP_BASE_URL } from '../../config';

@Component({
  selector: 'app-subscription-wall',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './subscription-wall.component.html',
  styleUrls: ['./subscription-wall.component.css'],
})
export class SubscriptionWallComponent implements OnInit, OnDestroy {
  /** Controls the headline copy shown in the paywall ('today_edition' or 'archive_access'). */
  @Input() accessMode: AccessMode = 'today_edition';

  /** Emitted after the user logs in or subscription status is refreshed. */
  @Output() subscriptionRefreshed = new EventEmitter<void>();

  // View state machine
  view: 'login' | 'plans' | 'loading' | 'redirecting' = 'loading';

  // Login / Register tab toggle (within 'login' view)
  authMode: 'login' | 'register' = 'login';

  // Login form
  username = '';
  password = '';
  loginError = '';
  loginLoading = false;

  // Register form
  regUsername = '';
  regEmail = '';
  regPassword = '';
  regConfirmPassword = '';
  registerError = '';
  registerLoading = false;

  // Plans
  plans: SubscriptionPlan[] = [];
  plansLoading = false;
  plansError = false;
  plansErrorType: 'timeout' | 'other' | null = null;
  checkoutError = '';

  // Post-payment refresh
  refreshLoading = false;

  private subs: Subscription[] = [];

  constructor(
    private auth: AuthService,
    private subscriptionService: SubscriptionService,
    private dataService: NewspaperDataService,
    public ts: TranslationService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.determineView();
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  // ---------------------------------------------------------------------------
  // Public helpers used in the template
  // ---------------------------------------------------------------------------

  /** WordPress "My Account" / login URL configured in plugin settings. */
  get loginUrl(): string {
    return this.dataService.getData().settings?.subscription?.loginUrl
      || `${WP_BASE_URL}/my-account/`;
  }

  /**
   * Registration URL — WooCommerce "My Account" page shows both login and
   * register forms. Append /register/ so the user lands on the register tab.
   */
  get registerUrl(): string {
    return this.loginUrl.replace(/\/$/, '') + '/register/';
  }

  /** Display name of the currently authenticated user (from localStorage). */
  get currentUsername(): string {
    return this.auth.getDisplayName();
  }

  /** Current subscription status from the service cache. */
  get currentStatus() {
    return this.subscriptionService.getStatus();
  }

  /** Formatted expiry date string, e.g. "31 Dec 2026". Empty string if unavailable. */
  get activeUntilDisplay(): string {
    const expiresAt = this.subscriptionService.getStatus()?.expiresAt;
    if (!expiresAt) return '';
    const date = new Date(expiresAt + 'T00:00:00');
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** Duration label for a plan card, e.g. "1-Day Access", "Monthly". */
  planDurationLabel(plan: SubscriptionPlan): string {
    if (plan.durationDays === 1)  return this.ts.t('subscription.wall.dayPass');
    if (plan.durationDays <= 31) return this.ts.t('subscription.wall.monthly');
    return this.ts.t('subscription.wall.annual');
  }

  /** Per-unit label shown under the price, e.g. "/ month". */
  planPeriodLabel(plan: SubscriptionPlan): string {
    if (plan.durationDays === 1)  return this.ts.t('subscription.wall.perDay');
    if (plan.durationDays <= 31) return this.ts.t('subscription.wall.perMonth');
    return this.ts.t('subscription.wall.perYear');
  }

  /** Returns true if this plan matches the user's current active subscription. */
  isActivePlan(plan: SubscriptionPlan): boolean {
    const status = this.currentStatus;
    if (!status?.hasActiveSubscription) return false;
    // 1. Slug match — most reliable when both sides have a slug.
    //    A match is conclusive; a mismatch is NOT — always fall through to name.
    if (status.planSlug && plan.slug && plan.slug === status.planSlug) return true;
    // 2. Exact case-insensitive name match.
    if (status.plan && plan.name && plan.name.toLowerCase() === status.plan.toLowerCase()) return true;
    // 3. Contains match: WC product names are often longer than DN plan names
    //    (e.g. "Monthly Subscription Package" vs "Monthly"). If the DN plan name
    //    appears as a word-boundary substring of status.plan, accept it — but
    //    only when there is a single matching plan to avoid false positives.
    if (status.plan && plan.name) {
      const sp = status.plan.toLowerCase();
      const pn = plan.name.toLowerCase();
      if (sp.includes(pn) || pn.includes(sp)) {
        // Only use the fuzzy match when exactly one plan would be highlighted.
        const fuzzyMatches = this.plans.filter(p => {
          const s2 = sp, p2 = p.name.toLowerCase();
          return s2.includes(p2) || p2.includes(s2);
        });
        if (fuzzyMatches.length === 1) return true;
      }
    }
    // 4. Last resort: user is subscribed and only one plan exists — must be this one.
    if (this.plans.length === 1) return true;
    return false;
  }

  /** Returns true for the plan with the most days — shown as "Best Value". */
  isBestValue(plan: SubscriptionPlan): boolean {
    if (this.plans.length < 2) return false;
    return plan.durationDays === Math.max(...this.plans.map(p => p.durationDays));
  }

  /** Log the current user out and return to the login view. */
  onLogout(): void {
    this.auth.logout();
    this.username = '';
    this.password = '';
    this.loginError = '';
    this.view = 'login';
    this.cdr.markForCheck();
  }

  // ---------------------------------------------------------------------------
  // View routing
  // ---------------------------------------------------------------------------

  private determineView(): void {
    if (!this.auth.isAuthenticated()) {
      this.view = 'login';
      this.cdr.markForCheck();
      return;
    }

    const cached = this.subscriptionService.getStatus();
    if (cached !== null) {
      // Show plans immediately from cache — no spinner for returning users.
      this.view = 'plans';
      this.loadPlans();
      this.cdr.markForCheck();

      // Refresh status in the background so plan/planSlug are accurate for
      // isActivePlan() highlighting. detectChanges() (not markForCheck()) is
      // used so the template re-evaluates immediately inside the HTTP callback.
      const refreshSub = this.subscriptionService.loadStatus().subscribe({
        next: () => this.cdr.detectChanges(),
        error: () => {},
      });
      this.subs.push(refreshSub);
      return;
    }

    // No cached status (fresh session) — show spinner while fetching.
    this.view = 'loading';
    this.cdr.markForCheck();

    const statusSub = this.subscriptionService.loadStatus().subscribe({
      next: () => {
        this.view = 'plans';
        this.loadPlans();
        this.cdr.markForCheck();
      },
      error: () => {
        this.view = 'plans';
        this.loadPlans();
        this.cdr.markForCheck();
      },
    });
    this.subs.push(statusSub);
  }

  private loadPlans(): void {
    this.plansLoading = true;
    this.plansError = false;
    this.plansErrorType = null;
    this.cdr.markForCheck();
    const sub = this.subscriptionService.loadPlans().subscribe({
      next: (plans) => {
        // Only show plans that apply to the current access mode.
        // Plans with no accessMode or accessMode === 'both' are always shown.
        this.plans = SubscriptionService.filterForMode(plans, this.accessMode);
        this.plansLoading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.plansLoading = false;
        this.plansError = true;
        this.plansErrorType = err?.type === 'timeout' ? 'timeout' : 'other';
        this.cdr.markForCheck();
      },
    });
    this.subs.push(sub);
  }

  retryLoadPlans(): void {
    this.loadPlans();
  }

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  onLogin(): void {
    if (!this.username || !this.password || this.loginLoading) return;
    this.loginLoading = true;
    this.loginError = '';
    this.cdr.markForCheck();

    const sub = this.auth.login(this.username, this.password).subscribe({
      next: () => {
        this.loginLoading = false;
        // Always close the modal immediately after a successful login.
        // The parent newspaper component will re-evaluate access control and
        // re-open the paywall only if the content still requires a subscription.
        this.subscriptionRefreshed.emit();
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loginLoading = false;
        this.loginError = err?.type === 'timeout'
          ? this.ts.t('subscription.loginErrorTimeout')
          : this.ts.t('subscription.loginError');
        this.cdr.markForCheck();
      },
    });
    this.subs.push(sub);
  }

  switchAuthMode(mode: 'login' | 'register'): void {
    this.authMode = mode;
    this.loginError = '';
    this.registerError = '';
    this.cdr.markForCheck();
  }

  // ---------------------------------------------------------------------------
  // Register
  // ---------------------------------------------------------------------------

  onRegister(): void {
    if (!this.regUsername || !this.regEmail || !this.regPassword || this.registerLoading) return;

    if (this.regPassword !== this.regConfirmPassword) {
      this.registerError = this.ts.t('subscription.wall.passwordMismatch');
      this.cdr.markForCheck();
      return;
    }

    this.registerLoading = true;
    this.registerError = '';
    this.cdr.markForCheck();

    const sub = this.auth.register(this.regUsername, this.regEmail, this.regPassword).subscribe({
      next: () => {
        this.registerLoading = false;
        this.cdr.markForCheck();
        // New account → always go to plans (no active subscription yet)
        this.view = 'plans';
        this.loadPlans();
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.registerLoading = false;
        if (err?.type === 'timeout') {
          this.registerError = this.ts.t('subscription.loginErrorTimeout');
        } else {
          // Use server error message when available (username taken, etc.)
          this.registerError = err?.error?.error
            || this.ts.t('subscription.wall.registerError');
        }
        this.cdr.markForCheck();
      },
    });
    this.subs.push(sub);
  }

  // ---------------------------------------------------------------------------
  // Checkout
  // ---------------------------------------------------------------------------

  onSelectPlan(plan: SubscriptionPlan): void {
    this.checkoutError = '';

    // Guard: re-check active subscription before proceeding (handles the case
    // where the user logged in during this session and already has a plan).
    const status = this.subscriptionService.getStatus();
    if (status?.hasActiveSubscription) {
      this.checkoutError = this.buildAlreadySubscribedMessage(status.expiresAt);
      this.cdr.markForCheck();
      return;
    }

    this.view = 'redirecting';
    this.cdr.markForCheck();

    const base = window.location.href.split('?')[0];
    const returnUrl = `${base}?sub=pending`;

    // Fetch a one-time checkout token so WordPress can auto-login the user on
    // the checkout page, even if the browser has no active WP session (or has
    // an admin session that would otherwise prefill the form with wrong data).
    const tokenSub = this.subscriptionService.getCheckoutToken().subscribe({
      next: (otp) => this.navigateToCheckout(plan, returnUrl, otp),
      error: () => {
        // Token fetch failed (e.g. network error).  Fall back to direct
        // navigation — WP checkout will handle auth in the traditional way.
        this.navigateToCheckout(plan, returnUrl, null);
      },
    });
    this.subs.push(tokenSub);
  }

  private navigateToCheckout(plan: SubscriptionPlan, returnUrl: string, otp: string | null): void {
    const withOtp = (url: string): string => {
      if (!otp) return url;
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}dn_token=${encodeURIComponent(otp)}`;
    };

    if (plan.checkoutUrl) {
      const sep = plan.checkoutUrl.includes('?') ? '&' : '?';
      window.location.href = withOtp(
        `${plan.checkoutUrl}${sep}dn_return=${encodeURIComponent(returnUrl)}`
      );
      return;
    }

    const sub = this.subscriptionService.getCheckoutUrl(plan.id, returnUrl).subscribe({
      next: (url) => {
        window.location.href = withOtp(url);
      },
      error: (err) => {
        this.view = 'plans';
        if (err?.status === 409 || err?.error?.error === 'already_subscribed') {
          this.checkoutError = this.buildAlreadySubscribedMessage(err?.error?.expiresAt);
        } else {
          this.checkoutError = this.ts.t('subscription.checkoutError');
        }
        this.cdr.markForCheck();
      },
    });
    this.subs.push(sub);
  }

  private buildAlreadySubscribedMessage(expiresAt?: string | null): string {
    if (expiresAt) {
      const date = new Date(expiresAt + 'T00:00:00').toLocaleDateString('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric',
      });
      return this.ts.t('subscription.alreadySubscribedUntil').replace('{date}', date);
    }
    return this.ts.t('subscription.alreadySubscribed');
  }

  // ---------------------------------------------------------------------------
  // Post-payment refresh (with retry)
  // ---------------------------------------------------------------------------

  /**
   * WooCommerce order processing can take a few seconds after redirect.
   * Poll up to 3 times at 2-second intervals before giving up.
   */
  onRefreshSubscription(): void {
    if (this.refreshLoading) return;
    this.refreshLoading = true;
    this.checkoutError = '';
    this.cdr.markForCheck();

    const MAX_ATTEMPTS = 3;
    const INTERVAL_MS  = 2000;
    let attempt = 0;

    const poll = timer(0, INTERVAL_MS).pipe(
      take(MAX_ATTEMPTS),
      switchMap(() => {
        attempt++;
        return this.subscriptionService.loadStatus();
      })
    );

    const sub = poll.subscribe({
      next: (status) => {
        if (status.hasActiveSubscription) {
          this.refreshLoading = false;
          this.subscriptionRefreshed.emit();
          this.cdr.markForCheck();
        } else if (attempt >= MAX_ATTEMPTS) {
          this.refreshLoading = false;
          this.checkoutError = this.ts.t('subscription.notYetActive');
          this.cdr.markForCheck();
        }
      },
      error: () => {
        this.refreshLoading = false;
        this.checkoutError = this.ts.t('subscription.checkoutError');
        this.cdr.markForCheck();
      },
    });
    this.subs.push(sub);
  }
}
