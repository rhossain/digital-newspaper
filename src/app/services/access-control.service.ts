import { Injectable } from '@angular/core';
import { CLIENT_PACKAGE, ACCESS_MODE } from '../config';
import { NewspaperDataService, NewspaperPage, NewspaperEdition } from './newspaper-data.service';
import { SubscriptionService } from './subscription.service';
import type { AccessMode } from '../models/subscription.models';

/**
 * Single source of truth for access control decisions.
 *
 * Logic summary:
 *  - If CLIENT_PACKAGE === 'starter' → everything is free, paywall never shown.
 *  - If CLIENT_PACKAGE === 'publisher':
 *      - accessMode 'today_edition': Today's first page is always free; subscribing
 *        unlocks all pages of today's edition. Past editions (archive) are fully locked
 *        and cannot be unlocked by this subscription type.
 *      - accessMode 'archive_access': Today's first page is always free; subscribing
 *        unlocks all pages of today's edition AND all past editions.
 *  - Subscription feature can also be disabled at runtime via GlobalSettings
 *    (settings.subscription.enabled === false) — treated identically to 'starter'.
 */
@Injectable({
  providedIn: 'root',
})
export class AccessControlService {
  constructor(
    private dataService: NewspaperDataService,
    private subscriptionService: SubscriptionService,
  ) {}

  // ---------------------------------------------------------------------------
  // Feature flags
  // ---------------------------------------------------------------------------

  /**
   * Returns true when the subscription feature is active.
   *
   * Checks (in priority order):
   * 1. settings.subscription.package from the server license — when present, this is authoritative.
   * 2. CLIENT_PACKAGE compile-time constant — fallback when no valid license is installed.
   * 3. settings.subscription.enabled from the server — must be true for publisher installs.
   */
  isSubscriptionEnabled(): boolean {
    const settings = this.dataService.getData().settings;

    // package === null means the server explicitly signals "no valid license installed".
    // In that case, never enforce subscriptions regardless of other settings.
    if (settings?.subscription !== undefined && settings.subscription.package === null) {
      return false;
    }

    // Determine effective package: server license takes precedence over compile-time constant.
    const serverPackage = settings?.subscription?.package;
    const effectivePackage: string = (serverPackage != null) ? serverPackage : CLIENT_PACKAGE;

    if (effectivePackage !== 'publisher') {
      return false;
    }
    // If the server has sent subscription settings, honour the enabled flag.
    if (settings?.subscription !== undefined) {
      return settings.subscription.enabled === true;
    }
    // Server hasn't sent the block yet (e.g. data not loaded) — default to enabled
    // for publisher package so the paywall is shown until settings are confirmed.
    return true;
  }

  /**
   * Returns the effective access mode.
   * Server-side settings take precedence over the compile-time constant.
   * Migrates legacy mode names to the current naming.
   */
  getEffectiveAccessMode(): AccessMode {
    const settings = this.dataService.getData().settings;
    const raw = settings?.subscription?.accessMode as string | undefined;
    if (raw) {
      // Migrate legacy names: today_only → today_edition, first_page_free → archive_access
      if (raw === 'today_only' || raw === 'today_edition') return 'today_edition';
      if (raw === 'first_page_free' || raw === 'archive_access') return 'archive_access';
    }
    // Migrate compile-time constant if it still holds a legacy value.
    const fallback = ACCESS_MODE as string;
    if (fallback === 'today_only') return 'today_edition';
    if (fallback === 'first_page_free') return 'archive_access';
    return ACCESS_MODE;
  }

  // ---------------------------------------------------------------------------
  // Access decisions
  // ---------------------------------------------------------------------------

  /**
   * Returns true when the given page is accessible to the current visitor.
   *
   * @param page      The page being requested.
   * @param allPages  All pages in the current edition, in display order.
   *                  The first element (index 0) is always free.
   */
  canAccessPage(page: NewspaperPage, allPages: NewspaperPage[]): boolean {
    if (!this.isSubscriptionEnabled()) {
      return true;
    }
    // Both modes keep the first page free; gate all others.
    if (allPages.length === 0 || page.id === allPages[0].id) {
      return true;
    }
    // 'today_edition': non-first pages of today's edition require subscription.
    //   (edition-level check — canAccessEdition — already blocks past editions.)
    // 'archive_access': non-first pages of any edition require subscription.
    return this.subscriptionService.hasActiveSubscription();
  }

  /**
   * Returns true when the given edition is accessible to the current visitor.
   *
   * @param edition  The edition being requested.
   */
  canAccessEdition(edition: NewspaperEdition): boolean {
    if (!this.isSubscriptionEnabled()) {
      return true;
    }
    // Today's edition is always accessible in both modes.
    const today = this.dataService.getTodayDate();
    if (edition.date === today) {
      return true;
    }
    const mode = this.getEffectiveAccessMode();
    // 'today_edition': past editions are FULLY locked — this plan does not cover archive.
    if (mode === 'today_edition') {
      return false;
    }
    // 'archive_access': past editions are unlocked by an active subscription.
    return this.subscriptionService.hasActiveSubscription();
  }

  /**
   * Returns true when the given date (YYYY-MM-DD) has any paywalled content.
   * Used to display lock icons on archived date entries.
   */
  isDateLocked(date: string): boolean {
    if (!this.isSubscriptionEnabled()) {
      return false;
    }
    const today = this.dataService.getTodayDate();
    if (date === today) {
      return false;
    }
    const mode = this.getEffectiveAccessMode();
    // 'today_edition': past dates are always locked (archive not available in this mode).
    if (mode === 'today_edition') {
      return true;
    }
    // 'archive_access': past dates locked only when the user has no active subscription.
    return !this.subscriptionService.hasActiveSubscription();
  }

  /**
   * Returns true when the user is allowed to navigate to past dates.
   * When false, the prev-day button and date picker should be disabled for past dates.
   *
   * - Subscription disabled (starter / no license) → always true (everything free).
   * - 'today_edition' mode → always false (archive never available in this mode).
   * - 'archive_access' mode → true only when the user has an active subscription.
   */
  canAccessPastDates(): boolean {
    if (!this.isSubscriptionEnabled()) {
      return true;
    }
    const mode = this.getEffectiveAccessMode();
    if (mode === 'today_edition') {
      return false;
    }
    // archive_access: requires active subscription
    return this.subscriptionService.hasActiveSubscription();
  }

  /**
   * Returns true when a page thumbnail should show a lock icon overlay.
   * Used by NewspaperPageThumbnailComponent.
   *
   * @param pageIndex   0-based index of the page in the current edition.
   */
  isPageLocked(pageIndex: number): boolean {
    if (!this.isSubscriptionEnabled()) {
      return false;
    }
    // Page-level locking: first page is always free in both modes.
    if (pageIndex === 0) {
      return false;
    }
    return !this.subscriptionService.hasActiveSubscription();
  }
}
