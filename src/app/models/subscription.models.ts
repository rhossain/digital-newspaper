/**
 * Subscription domain models.
 *
 * These types are shared by services, components, and the WordPress plugin API contracts.
 * Import from this file rather than redefining inline.
 */

// ---------------------------------------------------------------------------
// Package & access mode
// ---------------------------------------------------------------------------

/**
 * The feature tier purchased by the newspaper client.
 *
 * - 'starter'   — No subscription features; all content is freely accessible.
 * - 'publisher' — Full subscription features; access governed by AccessMode.
 */
export type ClientPackage = 'starter' | 'publisher';

/**
 * The access control model applied when ClientPackage is 'publisher'.
 *
 * - 'today_edition'  — "Today's Edition": Today's first page is always free.
 *                      A subscription (Daily/Monthly/Yearly) unlocks all pages of
 *                      today's edition. Past editions (archive) are fully locked and
 *                      not purchasable in this mode.
 * - 'archive_access' — "Full Archive": Today's first page is always free.
 *                      A subscription unlocks all pages of today's edition AND all
 *                      past editions. For clients monetising their archive content.
 */
export type AccessMode = 'today_edition' | 'archive_access';

// ---------------------------------------------------------------------------
// Subscription plans
// ---------------------------------------------------------------------------

/** A single purchasable subscription plan backed by a WooCommerce product. */
export interface SubscriptionPlan {
  /** WooCommerce product ID. */
  id: number;
  /** Human-readable plan name, e.g. "Monthly". */
  name: string;
  /** URL-safe slug, e.g. "monthly". */
  slug: string;
  /** Formatted price string, e.g. "199.00". */
  price: string;
  /** ISO 4217 currency code, e.g. "BDT". */
  currency: string;
  /** Subscription duration in calendar days (1 = day pass, 30 = monthly, 365 = annual). */
  durationDays: number;
  /** Optional short description shown on the plan card. */
  description?: string;
  /** Direct WooCommerce add-to-cart URL for this plan. */
  checkoutUrl: string;
  /**
   * The access mode this plan applies to.
   * - 'today_edition'  — shown only when the site runs in Today's Edition mode.
   * - 'archive_access' — shown only when the site runs in Full Archive mode.
   * - 'both'           — shown regardless of access mode (default / backward-compatible).
   * When absent, the plan is treated as 'both'.
   */
  accessMode?: AccessMode | 'both';
}

// ---------------------------------------------------------------------------
// Subscription status (per authenticated user)
// ---------------------------------------------------------------------------

/** The current subscription state for a logged-in user. */
export interface SubscriptionStatus {
  /** True when the user has a non-expired subscription. */
  hasActiveSubscription: boolean;
  /** Display name of the active plan, e.g. "Monthly". Absent when not subscribed. */
  plan?: string;
  /** Slug of the active plan. Absent when not subscribed. */
  planSlug?: string;
  /** ISO date string (YYYY-MM-DD) when the subscription expires. Absent when not subscribed. */
  expiresAt?: string;
  /** WooCommerce order ID that activated this subscription. Absent when not subscribed. */
  orderId?: number;
}

// ---------------------------------------------------------------------------
// Checkout request / response
// ---------------------------------------------------------------------------

/** Request body sent to POST /subscription/checkout. */
export interface CheckoutRequest {
  /** WooCommerce product ID of the chosen plan. */
  planId: number;
  /** The Angular app URL to redirect back to after payment. */
  returnUrl: string;
}

// ---------------------------------------------------------------------------
// Subscription orders (admin view)
// ---------------------------------------------------------------------------

/** A single row in the admin subscriptions list. */
export interface SubscriptionOrder {
  userId: number;
  username: string;
  email: string;
  name: string;
  plan: string;
  orderId: number | null;
  expiresAt: string;
  active: boolean;
}

/** Response body from POST /subscription/checkout. */
export interface CheckoutResponse {
  /** Full WooCommerce checkout URL to redirect the user to. */
  checkoutUrl: string;
}

// ---------------------------------------------------------------------------
// Subscription settings (embedded in GlobalSettings via the /data endpoint)
// ---------------------------------------------------------------------------

/**
 * Subscription configuration served from WordPress.
 * Allows operators to change access behaviour without a frontend re-deploy.
 */
export interface SubscriptionSettings {
  /** Whether subscription enforcement is active on this WordPress install. */
  enabled: boolean;
  /**
   * Access model in effect.
   * When present, this value takes precedence over the compile-time ACCESS_MODE constant.
   */
  accessMode: AccessMode;
  /** Currency code used for display purposes in the plan list, e.g. "BDT". */
  currency: string;
  /**
   * URL of the WordPress "My Account" / login page.
   * Used to build the login link shown in the subscription wall when the user is not logged in.
   */
  loginUrl?: string;
  /**
   * Package tier derived from the active WordPress license key.
   * When present, takes precedence over the compile-time CLIENT_PACKAGE constant.
   * null means no valid license is installed — Angular falls back to CLIENT_PACKAGE.
   */
  package?: ClientPackage | null;
  /**
   * Access modes permitted by the active license.
   * The admin UI will restrict the accessMode dropdown to these values.
   */
  allowedModes?: AccessMode[];
}
