<?php
/**
 * Plugin Name: Digital Newspaper API
 * Description: Headless WordPress REST API for Digital Newspaper data and authentication.
 * Version: 1.1.0
 * Author: Digital Newspaper
 */

if (!defined('ABSPATH')) {
  exit;
}

class Digital_Newspaper_API {
  const OPTION_KEY = 'dn_data';
  const OPTION_BACKUPS = 'dn_data_backups';
  const OPTION_ORIGINS = 'dn_allowed_origins';
  const OPTION_ALLOW_CREDENTIALS = 'dn_allow_credentials';
  const SECTION_POST_TYPE = 'dn_section';
  const TOKEN_TTL = 86400; // 24 hours

  // ── Per-date storage keys (WP-1) ─────────────────────────────────────────
  // These granular option keys replace the single dn_data blob for read paths.
  // dn_data is still written on every save for backward compatibility until a
  // future version removes it.
  /** Stores only the GlobalSettings object (logo, social links, language…). */
  const OPTION_SETTINGS = 'dn_settings';
  /** Stores {dates: string[], dataVersion: float} — the available-dates index. */
  const OPTION_INDEX    = 'dn_data_index';
  /** Prefix for per-date edition option keys; append YYYY-MM-DD. */
  const OPTION_EDITION_PREFIX = 'dn_edition_';
  /** Set to true once the one-time migration from the monolith blob is done. */
  const OPTION_MIGRATED_V2 = 'dn_storage_migrated_v2';
  /** Stores an array of domain alias strings for URL normalisation (CQ-5). */
  const OPTION_DOMAIN_ALIASES = 'dn_domain_aliases';

  public function __construct() {
    add_action('init', [$this, 'handle_cors_preflight'], 1);
    add_action('init', [$this, 'register_section_post_type']);
    add_action('rest_api_init', [$this, 'register_routes']);
    add_filter('rest_authentication_errors', [$this, 'authenticate_rest_request']);
    add_action('admin_menu', [$this, 'register_settings_page']);
    add_action('admin_init', [$this, 'register_settings']);
    // Ensure the activity-log DB table exists on every admin load (handles the
    // case where the plugin file was updated via FTP without re-activating it).
    add_action('admin_init', [$this, 'maybe_create_activity_table']);
    add_filter('rest_pre_serve_request', [$this, 'add_cors_headers'], 10, 4);
    // Ensure ModSecurity bypass rules are in .htaccess so the REST API is not
    // blocked by host-level WAF (e.g. Imunify360 on Hostinger shared hosting).
    add_action('admin_init', [$this, 'ensure_htaccess_rules']);
    register_activation_hook(__FILE__, [$this, 'ensure_htaccess_rules']);
    // Emit Content-Security-Policy-Report-Only on front-end page loads only
    // (not on REST API or wp-admin responses — those have their own headers).
    add_action('send_headers', [$this, 'add_csp_report_only_header']);
    // Non-REST diagnostics handler.  WP REST API requires a nonce for cookie
    // auth, which makes diag URLs unusable from a plain browser tab even
    // when logged into wp-admin.  This handler runs on every WP load and
    // responds when ?dn_diag=… is present (after a current_user_can check).
    add_action('init', [$this, 'maybe_handle_diag_query'], 5);
  }

  /**
   * Write ModSecurity bypass rules into the WordPress .htaccess file.
   *
   * Host-level WAF modules (Imunify360, ModSecurity on Hostinger/cPanel shared
   * hosting) can block legitimate POST requests to WordPress REST API endpoints
   * before they ever reach PHP, causing login and save operations to fail even
   * for users with valid credentials.
   *
   * This method uses WordPress's own insert_with_markers() to add targeted
   * bypass rules for only the Digital Newspaper REST API paths, so the rest of
   * the site continues to receive WAF protection.
   *
   * The rules are idempotent — calling this method multiple times will update
   * the block in-place without duplicating it.
   */
  public function ensure_htaccess_rules(): void {
    if (!function_exists('insert_with_markers')) {
      require_once ABSPATH . 'wp-admin/includes/misc.php';
    }

    $htaccess = get_home_path() . '.htaccess';
    if (!is_writable($htaccess)) {
      // Not writable — skip silently; the admin will need to add rules manually.
      return;
    }

    $rules = [
      '# ── Digital Newspaper REST API — WAF bypass rules ────────────────────────',
      '# These paths handle admin login and newspaper data saves.  The rules below',
      '# are needed on shared hosting (Hostinger, cPanel) where Imunify360 and',
      '# ModSecurity can block legitimate authenticated POST requests.',
      '',
      '# 1. Scope the ModSecurity disable to ONLY the Digital Newspaper REST API',
      '#    paths — not the entire site.  This preserves WAF protection for all',
      '#    other WordPress routes while allowing our plugin to function.',
      '#',
      '#    Two URL forms are matched:',
      '#      a) Pretty permalinks:  /wp-json/digital-newspaper/...',
      '#      b) Index (WAF-bypass):  /?rest_route=/digital-newspaper/...',
      '#',
      '#    <LocationMatch> is an Apache 2.4 directive. If the server runs',
      '#    Apache 2.2 (rare on modern shared hosts) these rules are silently',
      '#    ignored by the IfVersion guard below, and the broader fallback',
      '#    SecFilterEngine Off handles legacy mod_security v1.',
      '<IfVersion >= 2.4>',
      '  <IfModule mod_security2.c>',
      '    <LocationMatch "(wp-json/digital-newspaper|rest_route=/digital-newspaper)">',
      '      SecRuleEngine Off',
      '    </LocationMatch>',
      '  </IfModule>',
      '</IfVersion>',
      '',
      '# 2. Legacy mod_security v1 (no LocationMatch support in this version).',
      '#    Disable POST scanning site-wide only when mod_security v1 is active.',
      '#    mod_security2 (v2+) is handled above with path-scoped rules.',
      '<IfModule mod_security.c>',
      '  SecFilterEngine Off',
      '  SecFilterScanPOST Off',
      '</IfModule>',
      '',
      '# 3. Mark REST API requests with an environment variable so Apache',
      '#    access-control rules can explicitly allow them.',
      '#    Covers both the pretty (/wp-json/) and index (?rest_route=) URL forms.',
      'SetEnvIf Request_URI "wp-json" dn_api_request=1',
      'SetEnvIf Query_String "rest_route" dn_api_request=1',
    ];
    // NOTE: <IfModule mod_rewrite.c> / RewriteRule blocks are intentionally
    // omitted here. A RewriteRule with [L] inside the Digital Newspaper marker
    // block would stop WordPress's own rewrite rules from running (the markers
    // appear before the # BEGIN WordPress block). SetEnvIf above is sufficient
    // for environment-variable marking without touching the rewrite chain.

    insert_with_markers($htaccess, 'Digital Newspaper API', $rules);
  }

  public function handle_cors_preflight(): void {
    $origin = isset($_SERVER['HTTP_ORIGIN']) ? sanitize_text_field($_SERVER['HTTP_ORIGIN']) : '';
    if (!$origin) return;

    $allowed = $this->get_allowed_origins();
    if (!$allowed || !in_array($origin, $allowed, true)) return;

    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Authorization, X-Authorization, Content-Type, X-Requested-With');
    if (get_option(self::OPTION_ALLOW_CREDENTIALS, true)) {
      header('Access-Control-Allow-Credentials: true');
    }

    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
      status_header(200);
      exit;
    }
  }

  public static function default_data(): array {
    return [
      'settings' => [
        'defaultDateMode' => 'current',
        'socialLinks' => new \stdClass(),
        'logo' => [
          'url' => '',
          'alt' => 'Digital Newspaper'
        ],
        'editor' => '',
        'address' => [
          'line1'   => '',
          'line2'   => '',
          'phone'   => '',
          'email'   => '',
          'website' => ''
        ]
      ],
      'editions' => []
    ];
  }

  public function register_settings_page(): void {
    add_options_page(
      'Digital Newspaper',
      'Digital Newspaper',
      'manage_options',
      'digital-newspaper-settings',
      [$this, 'render_settings_page']
    );
  }

  public function register_settings(): void {
    register_setting('digital_newspaper_settings', self::OPTION_ORIGINS, [
      'type' => 'string',
      'sanitize_callback' => [$this, 'sanitize_origins'],
      'default' => ''
    ]);

    register_setting('digital_newspaper_settings', self::OPTION_ALLOW_CREDENTIALS, [
      'type' => 'boolean',
      'sanitize_callback' => function ($value) {
        return (bool) $value;
      },
      'default' => true
    ]);
  }

  public function render_settings_page(): void {
    if (!current_user_can('manage_options')) {
      return;
    }

    $origins = esc_textarea(get_option(self::OPTION_ORIGINS, ''));
    $allow_credentials = (bool) get_option(self::OPTION_ALLOW_CREDENTIALS, true);
    ?>
    <div class="wrap">
      <h1>Digital Newspaper Settings</h1>
      <form method="post" action="options.php">
        <?php settings_fields('digital_newspaper_settings'); ?>
        <table class="form-table" role="presentation">
          <tr>
            <th scope="row"><label for="dn_allowed_origins">Allowed Origins</label></th>
            <td>
              <textarea id="dn_allowed_origins" name="<?php echo esc_attr(self::OPTION_ORIGINS); ?>" rows="4" cols="50" class="large-text"><?php echo $origins; ?></textarea>
              <p class="description">Comma-separated list of allowed origins for the Angular app (e.g. https://app.example.com, http://localhost:4200).</p>
            </td>
          </tr>
          <tr>
            <th scope="row">Allow Credentials</th>
            <td>
              <label>
                <input type="checkbox" name="<?php echo esc_attr(self::OPTION_ALLOW_CREDENTIALS); ?>" value="1" <?php checked($allow_credentials); ?> />
                Send Access-Control-Allow-Credentials header
              </label>
            </td>
          </tr>
        </table>
        <?php submit_button(); ?>
      </form>
    </div>
    <?php
  }

  public function sanitize_origins($value): string {
    $parts = array_filter(array_map('trim', explode(',', (string) $value)));
    $parts = array_map(function ($origin) {
      return esc_url_raw($origin);
    }, $parts);
    return implode(', ', $parts);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SECURITY & RATE LIMITING HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Add standard security headers to public GET REST responses.
   * Call at the top of every public endpoint callback.
   */
  private function add_public_security_headers(): void {
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: SAMEORIGIN');
    header('Referrer-Policy: strict-origin-when-cross-origin');
  }

  /**
   * Emit a Content-Security-Policy-Report-Only header on front-end page loads.
   *
   * REPORT-ONLY means violations are logged to the browser console (and to
   * any report-uri endpoint) but NEVER blocked. This is safe to run in
   * production — it audits what a future enforced CSP would block before you
   * commit to enforcement.
   *
   * To move to enforcement later, change the header name to
   * Content-Security-Policy and remove directives that still report violations.
   *
   * Only fires on front-end (non-admin, non-REST) responses — the `send_headers`
   * hook runs before WordPress outputs the page, and we guard against admin
   * and REST contexts explicitly.
   *
   * Sources explained:
   *   script-src  'self'                   — Angular bundle (no inline scripts needed by default)
   *   style-src   'self' 'unsafe-inline'   — Angular adds inline <style> blocks; Quill also injects styles
   *               fonts.googleapis.com     — Google Fonts CSS @import
   *   font-src    'self' fonts.gstatic.com — Google Fonts woff2 files
   *               data:                    — some icon fonts embed as data URIs
   *   img-src     'self' data: blob:       — in-app canvas thumbnails use data:/blob: URLs
   *               static.dailysangram.com  — CDN for newspaper images and logo
   *               epaper.dailysangram.com  — the app origin itself (absolute img URLs)
   *               dailysangram.com         — root domain images
   *   connect-src 'self' {site_url}        — Angular HTTP calls to the WP REST API
   *   frame-ancestors 'none'               — prevent framing (stronger than X-Frame-Options)
   *   object-src  'none'                   — no Flash / plugins
   *   base-uri    'self'                   — prevent base-tag injection
   */
  public function add_csp_report_only_header(): void {
    // Skip REST API requests — they have their own headers.
    if (defined('REST_REQUEST') && REST_REQUEST) {
      return;
    }
    // Skip wp-admin pages.
    if (is_admin()) {
      return;
    }

    $site = rtrim(site_url(), '/');

    $directives = implode('; ', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https://static.dailysangram.com https://epaper.dailysangram.com https://dailysangram.com",
      "connect-src 'self' " . esc_url_raw($site),
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
    ]);

    header('Content-Security-Policy-Report-Only: ' . $directives);
  }

  /**
   * Lightweight transient-based rate limiter for public (unauthenticated) GET requests.
   * Allows up to 120 requests per IP per 60 seconds.
   * Returns true when the request is within limits, false when it should be rejected.
   * Silently passes when transients are unavailable (e.g. object-cache flush race).
   */
  private function check_public_get_rate_limit(): bool {
    // Resolve client IP — respect X-Forwarded-For from trusted proxies.
    $raw_ip = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? '';
    // Only use the first (leftmost) IP in X-Forwarded-For to prevent spoofing.
    $client_ip = trim(explode(',', (string)$raw_ip)[0]);
    if ($client_ip === '') {
      return true; // Cannot determine IP — allow through.
    }
    $key   = 'dn_pub_rate_' . md5($client_ip);
    $count = (int) get_transient($key);
    if ($count >= 120) {
      return false;
    }
    // set_transient with 60-second TTL acts as a sliding window.
    // We deliberately do NOT check the return value: a failed set (race condition
    // or full object cache) is safer than a false rejection.
    set_transient($key, $count + 1, 60);
    return true;
  }

  public function register_section_post_type(): void {
    register_post_type(self::SECTION_POST_TYPE, [
      'labels' => [
        'name'          => 'Newspaper Sections',
        'singular_name' => 'Newspaper Section',
        'menu_name'     => 'Newspaper Sections',
      ],
      'public'              => false,
      'show_ui'             => true,
      'show_in_menu'        => 'tools.php',
      'show_in_rest'        => false,
      'exclude_from_search' => true,
      'publicly_queryable'  => false,
      'supports'            => ['title', 'editor', 'revisions'],
      'capability_type'     => 'post',
      'map_meta_cap'        => true,
      'menu_icon'           => 'dashicons-media-document',
    ]);
  }

  public function get_data(): array {
    global $wpdb;

    // ── MEM-OPT: Decide whether normalize_domain_urls() is actually needed ──
    // The normalisation step json_encodes the entire dataset and json_decodes
    // it back — for a 35 MB blob that costs ~185 MB of peak RAM in addition to
    // the already-deserialised PHP array.  On shared hosting with a 256 MB
    // memory_limit this is the single biggest cause of the GET /data endpoint
    // crashing with WordPress's generic "critical error" (a PHP fatal due to
    // memory exhaustion).
    //
    // The vast majority of installations have already saved their data using
    // the canonical production origin, so the round-trip is a pure no-op.  We
    // can detect that condition cheaply by reading the RAW option_value as a
    // string from MySQL (no unserialize) and scanning it for any alias that
    // differs from the canonical origin.  If none are present we skip the
    // round-trip entirely and save ~185 MB peak RAM.
    $needs_normalize = true;
    $raw = $wpdb->get_var($wpdb->prepare(
      "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
      self::OPTION_KEY
    ));
    if (is_string($raw) && $raw !== '') {
      $parsed = wp_parse_url(home_url());
      $canonical_origin = ($parsed['scheme'] ?? 'https') . '://' . ($parsed['host'] ?? '');

      $defaults = [
        'https://epaper.dailysangram.com',
        'http://epaper.dailysangram.com',
        'https://www.epaper.dailysangram.com',
        'https://nepaper.dailysangram.com',
        'http://nepaper.dailysangram.com',
        'https://www.nepaper.dailysangram.com',
      ];
      $saved = get_option(self::OPTION_DOMAIN_ALIASES, null);
      $known_aliases = (is_array($saved) && !empty($saved)) ? $saved : $defaults;

      $needs_normalize = false;
      foreach ($known_aliases as $alias) {
        if ($alias !== $canonical_origin && strpos($raw, $alias) !== false) {
          $needs_normalize = true;
          break;
        }
      }
    }
    unset($raw); // free the raw serialised string before deserialising again

    $data = get_option(self::OPTION_KEY);
    if (!is_array($data)) {
      $data = self::default_data();
    }
    if ($needs_normalize) {
      // Normalize all stored domain aliases to the current WordPress origin
      $data = $this->normalize_domain_urls($data);
    }

    // Ensure every response includes a dataVersion so Angular can detect
    // concurrent-edit conflicts. Generate one inline for the response if the
    // stored blob pre-dates this feature — but do NOT write back here.
    // Calling update_option() inside a GET request causes an unnecessary write
    // on every page load. The version will be persisted on the next save.
    if (empty($data['dataVersion'])) {
      $data['dataVersion'] = microtime(true);
    }

    return $data;
  }

  // ── Per-date storage helpers (WP-1) ───────────────────────────────────────

  /** Returns the wp_options key for a single date's edition array. */
  private function edition_option_key(string $date): string {
    return self::OPTION_EDITION_PREFIX . $date;
  }

  /**
   * Load a $data-shaped slice containing ONLY the settings and the editions
   * for a single date.  Used by atomic page/section endpoints so they don't
   * have to deserialise the full ~30 MB dn_data blob just to mutate one page.
   *
   * Returned shape matches what save_data() expects:
   *   [
   *     'dataVersion' => float,            // taken from dn_data_index
   *     'settings'    => array,            // from dn_settings (or defaults)
   *     'editions'    => array,            // ONLY the editions for $date
   *   ]
   *
   * IMPORTANT: this is a SLICE, not the full archive — callers MUST pass
   * $only_date=$date to save_data() so write_per_date_storage() knows to
   * preserve other dates in the index and skip the legacy blob write.
   */
  private function get_data_scoped_to_date(string $date): array {
    // Settings (small, autoloaded) — fall back to defaults on a fresh install.
    $settings = get_option(self::OPTION_SETTINGS);
    if (!is_array($settings) || empty($settings)) {
      $settings = self::default_data()['settings'];
    }

    // Just this date's editions (≤ a few MB, not autoloaded).
    $editions = get_option($this->edition_option_key($date), []);
    if (!is_array($editions)) {
      $editions = [];
    }

    // dataVersion comes from the lightweight index; ensure it's a float so
    // downstream code that compares versions doesn't get bitten by string
    // semantics.
    $index       = get_option(self::OPTION_INDEX);
    $dataVersion = (is_array($index) && isset($index['dataVersion']))
      ? (float) $index['dataVersion']
      : (float) microtime(true);

    return [
      'dataVersion' => $dataVersion,
      'settings'    => $settings,
      'editions'    => array_values($editions),
    ];
  }

  /**
   * Cheap content fingerprint for a per-date editions array.  Used by
   * write_per_date_storage() to distinguish "update_option returned false
   * because the value is unchanged" (benign) from "update_option returned
   * false because the DB write failed" (data loss — must throw).
   *
   * We hash the JSON serialisation rather than serialising arrays directly so
   * the comparison is insensitive to PHP's serializer keying differences
   * between identical-content array copies.
   */
  private function edition_array_signature(array $editions): string {
    $json = json_encode($editions, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    return is_string($json) ? md5($json) : '';
  }

  /**
   * One-time migration: split the dn_data blob into per-date option keys.
   *
   * Safe to call on every request — exits immediately after the first run.
   * Uses a short-lived transient to prevent concurrent migration races.
   * The existing dn_data blob is PRESERVED — it remains the authoritative
   * store until WP-5 is fully rolled out and verified.
   */
  private function maybe_migrate_storage(): void {
    if (get_option(self::OPTION_MIGRATED_V2)) {
      // Flag is set, but verify the index actually has data.
      // If it is empty the migration timed out after setting the flag but
      // before writing the index — allow a single re-run to recover.
      // (MIGS-3: idempotent recovery guard)
      $index = get_option(self::OPTION_INDEX);
      if (is_array($index) && !empty($index['dates'])) {
        return; // Fully migrated — nothing to do.
      }
      // Index missing or empty → incomplete migration. Reset flag and re-run.
      delete_option(self::OPTION_MIGRATED_V2);
      error_log('[DigitalNewspaper] maybe_migrate_storage: dn_data_index is empty after migration flag was set — re-running migration to recover real data from dn_data blob.');
    }

    // ── CRITICAL (MIGS-1): Set the flag FIRST ─────────────────────────────
    // Previously the flag was set at the END of migration.  On large datasets
    // PHP timed out before reaching that line, so the flag was never set, and
    // every subsequent request retried the expensive migration — creating an
    // infinite timeout loop that took the entire API offline.
    //
    // Setting it upfront breaks the loop.  Migration below is best-effort:
    // if it partially completes, the granular read helpers will fall back to
    // writing defaults on their first call, and a full save from the admin
    // panel will re-populate all granular keys correctly.
    update_option(self::OPTION_MIGRATED_V2, true);

    // Prevent concurrent migration (e.g. multiple simultaneous first requests)
    if (get_transient('dn_migration_v2_lock')) {
      return;
    }
    set_transient('dn_migration_v2_lock', 1, 300); // Extended to 5 min for large datasets

    // ── Time-budget guard (MIGS-2) ────────────────────────────────────────
    // Abort migration gracefully before PHP's max_execution_time kicks in.
    // We reserve 8 s of headroom so the response can still be sent.
    $php_max  = (int) @ini_get('max_execution_time');
    $budget_s = ($php_max > 15) ? ($php_max - 8) : 22; // default 22 s when limit unknown
    $start    = microtime(true);

    $blob = get_option(self::OPTION_KEY);
    if (!is_array($blob)) {
      // Nothing to migrate (fresh install)
      delete_transient('dn_migration_v2_lock');
      return;
    }

    $dataVersion = isset($blob['dataVersion']) ? (float) $blob['dataVersion'] : (float) microtime(true);

    // ── 1. Migrate settings ────────────────────────────────────────────────
    if (!empty($blob['settings']) && is_array($blob['settings'])) {
      update_option(self::OPTION_SETTINGS, $blob['settings'], false);
    } else {
      update_option(self::OPTION_SETTINGS, self::default_data()['settings'], false);
    }

    // ── 2. Migrate per-date editions ───────────────────────────────────────
    $editions_by_date = [];
    foreach (($blob['editions'] ?? []) as $edition) {
      $date = (string) ($edition['date'] ?? '');
      if ($date === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        continue;
      }
      $editions_by_date[$date][] = $edition;
    }

    foreach ($editions_by_date as $date => $editions) {
      // Abort if we are running close to the PHP time limit.
      if ((microtime(true) - $start) >= $budget_s) {
        error_log('[DigitalNewspaper] maybe_migrate_storage: time budget exceeded — migration partial. Remaining dates will be populated on next admin save.');
        break;
      }
      update_option($this->edition_option_key($date), $editions, false);
    }

    // ── 3. Write the dates index ───────────────────────────────────────────
    $dates = array_keys($editions_by_date);
    rsort($dates);
    update_option(self::OPTION_INDEX, [
      'dates'       => $dates,
      'dataVersion' => $dataVersion,
    ], false);

    delete_transient('dn_migration_v2_lock');
  }

  /**
   * Read global settings from the granular dn_settings option.
   *
   * Falls back to the monolith blob if the per-date storage hasn't been
   * initialised yet (fresh install before first save).
   *
   * @return array{settings: array, dataVersion: float}
   */
  private function get_settings_granular(): array {
    $this->maybe_migrate_storage();

    $index = get_option(self::OPTION_INDEX);
    $dataVersion = is_array($index) && isset($index['dataVersion'])
                   ? (float) $index['dataVersion']
                   : 0.0;

    $settings = get_option(self::OPTION_SETTINGS);
    if (!is_array($settings)) {
      // ── RECOVERY: dn_settings missing → read from blob ────────────────────
      // Previously this path was guarded by "if migrated, write defaults" — which
      // silently overwrote real user settings with empty defaults whenever the
      // granular settings option happened to be missing.  The blob is always
      // safe to consult; only fall through to defaults when the blob itself
      // doesn't have settings either.
      $blob     = $this->get_data();
      $settings = (isset($blob['settings']) && is_array($blob['settings']))
                  ? $blob['settings']
                  : self::default_data()['settings'];
      if (!$dataVersion) {
        $dataVersion = (float) ($blob['dataVersion'] ?? microtime(true));
      }
      // Lazy write-through so the next request hits the fast path.  Only do
      // this when we actually recovered real settings from the blob — never
      // persist the empty defaults (that would just re-create the bug).
      if (!empty($blob['settings']) && is_array($blob['settings'])) {
        update_option(self::OPTION_SETTINGS, $blob['settings'], false);
      }
      unset($blob);
    }

    return [
      'settings'    => $this->normalize_domain_urls($settings),
      'dataVersion' => $dataVersion,
    ];
  }

  /**
   * Read the available-dates index from the granular dn_data_index option.
   *
   * Falls back to assembling from the blob when the index doesn't exist.
   *
   * @return array{dates: string[], latestDate: string}
   */
  private function get_dates_granular(): array {
    $this->maybe_migrate_storage();

    $index = get_option(self::OPTION_INDEX);
    $indexed = is_array($index) && !empty($index['dates'])
      ? array_values(array_filter((array) $index['dates']))
      : [];

    // ── RECOVERY: union dates from every place data could survive ─────────
    // The index can be incomplete if maybe_migrate_storage() hit its time
    // budget; the blob itself can be trimmed if a previous trimmed save
    // overwrote it.  But dn_edition_YYYY-MM-DD options and dn_section
    // custom posts can each independently hold dates the others have lost.
    // We union all four sources so the admin always sees every date that
    // exists anywhere on the install.
    //
    // All four scans are cheap:
    //   • index               : single option read (already done above)
    //   • blob regex          : single option read + regex on raw string
    //   • per-date option keys: single SQL on wp_options (LIKE 'dn_edition_%')
    //   • section post meta   : single SQL on wp_postmeta (meta_key = 'dn_newspaper_date')
    $blobDates    = $this->extract_dates_from_raw_blob();
    $perDateDates = $this->extract_dates_from_per_date_options();
    $sectionDates = $this->extract_dates_from_section_posts();

    $merged = array_values(array_unique(array_merge(
      $indexed,
      $blobDates,
      $perDateDates,
      $sectionDates
    )));
    // Drop anything that isn't a valid YYYY-MM-DD just to be safe.
    $merged = array_values(array_filter($merged, static function ($d) {
      return is_string($d) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $d);
    }));
    rsort($merged);

    if (!empty($merged)) {
      // Log only when the index was missing something so the admin knows a
      // recovery happened.
      if (count($merged) !== count($indexed)) {
        $missing = array_values(array_diff($merged, $indexed));
        error_log('[DigitalNewspaper] get_dates_granular: recovered ' . count($missing) . ' date(s) missing from dn_data_index (blob/per-date/section sources). Sample: ' . implode(', ', array_slice($missing, 0, 10)));
      }
      return [
        'dates'      => $merged,
        'latestDate' => $merged[0] ?? '',
      ];
    }

    // Truly nothing anywhere — fresh install.
    return ['dates' => [], 'latestDate' => ''];
  }

  /**
   * Extract distinct YYYY-MM-DD edition dates from the raw dn_data
   * option_value bytes WITHOUT deserialising the option.
   *
   * The option_value is PHP-serialised; for an edition entry
   * `['date' => '2025-12-31', ...]` the bytes contain the literal substring
   * `s:4:"date";s:10:"2025-12-31"`.  We match exactly that pattern so we
   * never confuse the edition date with timestamp-like strings (createdAt,
   * etc.) that have a YYYY-MM-DD prefix.
   *
   * @return string[]  Distinct YYYY-MM-DD strings, unsorted.
   */
  private function extract_dates_from_raw_blob(): array {
    global $wpdb;
    $raw = $wpdb->get_var($wpdb->prepare(
      "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
      self::OPTION_KEY
    ));
    if (!is_string($raw) || $raw === '') {
      return [];
    }
    // PHP-serialised edition entries store the date as: s:4:"date";s:10:"YYYY-MM-DD"
    if (!preg_match_all('/s:4:"date";s:10:"(\d{4}-\d{2}-\d{2})"/', $raw, $m)) {
      // Fallback: also match JSON-style "date":"YYYY-MM-DD" in case the option
      // is stored as a JSON string on some legacy installations.
      preg_match_all('/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/', $raw, $m);
    }
    $dates = $m[1] ?? [];
    return array_values(array_unique($dates));
  }

  /**
   * Extract distinct YYYY-MM-DD edition dates from per-date `dn_edition_*`
   * option keys.  These options survive even when the dn_data blob has been
   * truncated by a buggy save, so they are a critical recovery source.
   *
   * @return string[]  Distinct YYYY-MM-DD strings, unsorted.
   */
  private function extract_dates_from_per_date_options(): array {
    global $wpdb;
    $like = $wpdb->esc_like(self::OPTION_EDITION_PREFIX) . '%';
    $names = $wpdb->get_col($wpdb->prepare(
      "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s",
      $like
    ));
    if (!is_array($names) || empty($names)) {
      return [];
    }
    $prefixLen = strlen(self::OPTION_EDITION_PREFIX);
    $dates = [];
    foreach ($names as $name) {
      $candidate = substr((string) $name, $prefixLen);
      if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $candidate)) {
        $dates[$candidate] = true;
      }
    }
    return array_keys($dates);
  }

  /**
   * Extract distinct YYYY-MM-DD edition dates from `dn_section` custom posts
   * via their `dn_newspaper_date` postmeta.  These posts are the most
   * authoritative source — they hold every section ever saved and survive
   * even when both dn_data and dn_edition_* options have been wiped.
   *
   * @return string[]  Distinct YYYY-MM-DD strings, unsorted.
   */
  private function extract_dates_from_section_posts(): array {
    global $wpdb;
    $rows = $wpdb->get_col($wpdb->prepare(
      "SELECT DISTINCT meta_value FROM {$wpdb->postmeta} WHERE meta_key = %s",
      'dn_newspaper_date'
    ));
    if (!is_array($rows) || empty($rows)) {
      return [];
    }
    $dates = [];
    foreach ($rows as $val) {
      $val = (string) $val;
      if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $val)) {
        $dates[$val] = true;
      }
    }
    return array_keys($dates);
  }

  /**
   * Read editions for a single date from the granular dn_edition_{date} option.
   *
   * Performs a consistency check: if the stored dataVersion doesn't match the
   * index's dataVersion it means the per-date key is stale; falls back to the
   * monolith blob in that case.
   *
   * @return array{editions: array, dataVersion: float}
   */
  private function get_edition_for_date_granular(string $date): array {
    $this->maybe_migrate_storage();

    $index       = get_option(self::OPTION_INDEX);
    $indexVersion = is_array($index) ? (float) ($index['dataVersion'] ?? 0.0) : 0.0;

    $stored = get_option($this->edition_option_key($date));
    if (is_array($stored) && !empty($stored)) {
      // Per-date key exists.  Use indexVersion if present, otherwise stamp a
      // version from the blob/microtime so the client still sees a monotonic
      // value (some legacy installs never wrote dataVersion into the index).
      return [
        'editions'    => $this->normalize_domain_urls(array_values($stored)),
        'dataVersion' => $indexVersion > 0.0 ? $indexVersion : (float) microtime(true),
      ];
    }

    // ── RECOVERY 1: per-date key missing — fall back to filtering the blob ──
    $data         = $this->get_data();
    $all_editions = $data['editions'] ?? [];
    $dataVersion  = (float) ($data['dataVersion'] ?? 0.0);

    $date_editions = array_values(array_filter($all_editions, static function ($ed) use ($date) {
      return isset($ed['date']) && (string) $ed['date'] === $date;
    }));

    // If the blob also lacks this date, try rebuilding from section posts.
    if (empty($date_editions)) {
      unset($data, $all_editions);
      $rebuilt = $this->build_date_editions_from_section_posts($date);
      if (!empty($rebuilt)) {
        // Lazy write-through so the next request gets the fast path.
        update_option($this->edition_option_key($date), $rebuilt, false);
        error_log('[DigitalNewspaper] get_edition_for_date_granular: rebuilt ' . $date . ' from ' . count($rebuilt) . ' section post group(s).');
        return [
          'editions'    => $this->normalize_domain_urls($rebuilt),
          'dataVersion' => $dataVersion > 0.0 ? $dataVersion : (float) microtime(true),
        ];
      }
      return [
        'editions'    => [],
        'dataVersion' => $dataVersion > 0.0 ? $dataVersion : (float) microtime(true),
      ];
    }

    // Lazy write-through: cache this date's editions into the per-date option
    // so the next request hits the fast path.  Use the RAW (un-normalised)
    // editions from $data so we don't double-rewrite the URLs.
    $raw_editions = array_values(array_filter($data['editions'] ?? [], static function ($ed) use ($date) {
      return isset($ed['date']) && (string) $ed['date'] === $date;
    }));
    if (!empty($raw_editions)) {
      update_option($this->edition_option_key($date), $raw_editions, false);
    }

    unset($data, $all_editions);
    return [
      'editions'    => $date_editions,
      'dataVersion' => $dataVersion > 0.0 ? $dataVersion : (float) microtime(true),
    ];
  }

  /**
   * Last-resort recovery: rebuild a single date's editions array from the
   * `dn_section` custom posts.  Mirrors the logic of
   * build_data_from_section_posts() but scoped to one date for speed
   * (uses a meta_query, not a full table scan).
   *
   * @return array<int,array>  Editions array (possibly empty).
   */
  private function build_date_editions_from_section_posts(string $date): array {
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
      return [];
    }

    // RECOVERY: include 'trash' so we can resurrect data trashed by a buggy
    // shrunken-save.  When such posts are found we untrash them so the next
    // sync_section_posts_from_data() round-trips them cleanly without
    // creating duplicates.
    //
    // Order by post_modified DESC so when duplicate posts exist for the same
    // section key (a legacy artefact of pre-fix saves that re-inserted instead
    // of updating), the newest version wins in the dedup pass below.
    $posts = get_posts([
      'post_type'      => self::SECTION_POST_TYPE,
      'post_status'    => ['publish', 'draft', 'private', 'pending', 'trash'],
      'posts_per_page' => -1,
      'no_found_rows'  => true,
      'orderby'        => 'modified',
      'order'          => 'DESC',
      'meta_query'     => [
        [
          'key'     => 'dn_newspaper_date',
          'value'   => $date,
          'compare' => '=',
        ],
      ],
    ]);

    if (empty($posts)) {
      return [];
    }

    // NOTE: when this is called from the rebuild endpoint, bulk_untrash has
    // already restored trashed posts.  When called from the per-date lazy
    // recovery path (get_edition_for_date_granular) we still want trashed
    // posts to contribute to the rebuild, but we DON'T per-post untrash here
    // — wp_untrash_post() per-post fires status-transition hooks that OOM
    // on shared hosting when many posts exist.  The user can hit the
    // /data/rebuild-from-sections endpoint once to make the recovery
    // permanent.

    // DEDUP: collapse duplicate section posts (same _dn_section_key) keeping
    // the most-recently-modified one.  Posts are already sorted DESC so the
    // first occurrence wins.  Duplicates can exist because of bugs in the
    // sync path (pre-fix it would wp_insert_post when find_section_post_id()
    // didn't match a trashed post, leaving the trashed copy + new copy).
    $seenSectionKeys = [];
    $editionMap = [];
    foreach ($posts as $post) {
      $sectionKey = (string) get_post_meta($post->ID, '_dn_section_key', true);
      if ($sectionKey === '') {
        // Fall back to a synthesised key so payloads without _dn_section_key
        // still get deduplicated by (date, edition, page, section_id).
        $sectionKey = $date
          . ':' . max(1, (int) get_post_meta($post->ID, 'dn_edition_number', true))
          . ':' . max(1, (int) get_post_meta($post->ID, 'dn_page_id', true))
          . ':' . (string) get_post_meta($post->ID, 'dn_section_id', true);
      }
      if (isset($seenSectionKeys[$sectionKey])) {
        continue; // newer copy already taken — skip this older duplicate
      }
      $seenSectionKeys[$sectionKey] = true;

      $editionNumber = max(1, (int) get_post_meta($post->ID, 'dn_edition_number', true));
      $pageId = max(1, (int) get_post_meta($post->ID, 'dn_page_id', true));
      $editionKey = $date . ':' . $editionNumber;
      $pageKey = (string) $pageId;

      if (!isset($editionMap[$editionKey])) {
        $editionLabels = json_decode((string) get_post_meta($post->ID, 'dn_edition_labels', true), true);
        $editionMap[$editionKey] = [
          'date'          => $date,
          'edition'       => $editionNumber,
          'editionLabels' => is_array($editionLabels) ? $editionLabels : [],
          '_pages'        => [],
        ];
      }

      if (!isset($editionMap[$editionKey]['_pages'][$pageKey])) {
        $pageLabels = json_decode((string) get_post_meta($post->ID, 'dn_page_labels', true), true);
        $page = [
          'id'        => $pageId,
          'thumbnail' => (string) get_post_meta($post->ID, 'dn_page_thumbnail', true),
          'fullImage' => (string) get_post_meta($post->ID, 'dn_page_full_image', true),
          'sections'  => [],
          '_order'    => (int) get_post_meta($post->ID, 'dn_page_order', true),
        ];
        $fullHiRes = (string) get_post_meta($post->ID, 'dn_page_full_hires', true);
        if ($fullHiRes !== '') {
          $page['fullImageHiRes'] = $fullHiRes;
        }
        if (is_array($pageLabels) && $pageLabels) {
          $page['pageLabels'] = $pageLabels;
        }
        $editionMap[$editionKey]['_pages'][$pageKey] = $page;
      }

      $payload = $this->decode_section_payload((string) get_post_meta($post->ID, 'dn_section_payload', true));
      if (!is_array($payload)) {
        $linkedSectionIds = json_decode((string) get_post_meta($post->ID, 'dn_linked_section_ids', true), true);
        $payload = [
          'id'               => (string) get_post_meta($post->ID, 'dn_section_id', true),
          'title'            => $post->post_title,
          'x'                => (float) get_post_meta($post->ID, 'dn_crop_x', true),
          'y'                => (float) get_post_meta($post->ID, 'dn_crop_y', true),
          'width'            => (float) get_post_meta($post->ID, 'dn_crop_w', true),
          'height'           => (float) get_post_meta($post->ID, 'dn_crop_h', true),
          'content'          => $post->post_content,
          'imageUrl'         => (string) get_post_meta($post->ID, 'dn_cropped_image_url', true),
          'pageId'           => $pageId,
          'linkedSectionIds' => is_array($linkedSectionIds) ? $linkedSectionIds : [],
          'showCaption'      => true,
        ];
        $lsp = (string) get_post_meta($post->ID, 'dn_linked_section_primary', true);
        if ($lsp !== '') $payload['linkedSectionPrimary'] = $lsp;
      }
      $payload['_order'] = (int) get_post_meta($post->ID, 'dn_section_order', true);
      $editionMap[$editionKey]['_pages'][$pageKey]['sections'][] = $payload;
    }

    $editions = array_values($editionMap);
    foreach ($editions as &$edition) {
      $pages = array_values($edition['_pages']);
      usort($pages, function ($a, $b) {
        $orderDiff = ((int) ($a['_order'] ?? 0)) <=> ((int) ($b['_order'] ?? 0));
        return $orderDiff !== 0 ? $orderDiff : ((int) ($a['id'] ?? 0)) <=> ((int) ($b['id'] ?? 0));
      });

      foreach ($pages as &$page) {
        usort($page['sections'], function ($a, $b) {
          return ((int) ($a['_order'] ?? 0)) <=> ((int) ($b['_order'] ?? 0));
        });
        foreach ($page['sections'] as &$section) {
          unset($section['_order']);
        }
        unset($page['_order']);
      }

      $edition['pages'] = $pages;
      unset($edition['_pages']);
      if (empty($edition['editionLabels'])) {
        unset($edition['editionLabels']);
      }
    }
    unset($edition);

    usort($editions, function ($a, $b) {
      return ((int) ($a['edition'] ?? 1)) <=> ((int) ($b['edition'] ?? 1));
    });

    return $editions;
  }

  /**
   * Write per-date keys and the index after a successful save.
   * Called by save_data() — always after the main dn_data write succeeds.
   * Errors here are non-fatal: dn_data remains the authoritative source.
   *
   * @param array $data  The full NewspaperData array (already version-stamped).
   */
  private function write_per_date_storage(array $data, ?string $only_date = null): void {
    $dataVersion = (float) $data['dataVersion'];

    // ── Settings ──────────────────────────────────────────────────────────
    if (!empty($data['settings']) && is_array($data['settings'])) {
      update_option(self::OPTION_SETTINGS, $data['settings'], false);
    }

    // ── Per-date editions ─────────────────────────────────────────────────
    $editions_by_date = [];
    foreach (($data['editions'] ?? []) as $edition) {
      $date = (string) ($edition['date'] ?? '');
      if ($date === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        continue;
      }
      $editions_by_date[$date][] = $edition;
    }

    // PERF: When the caller knows exactly which date changed (atomic page /
    // section endpoints), update only that date's per-date option instead of
    // looping through every date.  Rewriting hundreds of unchanged dates is a
    // major source of gateway timeouts on installations with a long archive.
    //
    // We capture the return value of update_option() and throw on apparent
    // failure when this write is the user's primary persistence (only_date
    // case).  Background: update_option() returns false when (a) the DB write
    // failed, or (b) the value is byte-identical to what's already stored.
    // Case (b) is benign — we double-check by reading the option back and
    // comparing dataVersion stamps.  Case (a) means the user's edit is gone
    // and we must report it.
    if ($only_date !== null && preg_match('/^\d{4}-\d{2}-\d{2}$/', $only_date)) {
      if (isset($editions_by_date[$only_date])) {
        global $wpdb;
        $wpdb->last_error = '';
        $ok = update_option($this->edition_option_key($only_date), $editions_by_date[$only_date], false);
        if (!$ok) {
          // Verify the write actually landed by reading it back and looking
          // for the new dataVersion stamp inside any edition.  This survives
          // the "value unchanged → returns false" benign case while catching
          // real DB failures.
          $verify = get_option($this->edition_option_key($only_date), null);
          $verify_ok = is_array($verify) && !empty($verify) && $this->edition_array_signature($verify) === $this->edition_array_signature($editions_by_date[$only_date]);
          if (!$verify_ok) {
            $db_err = trim((string) ($wpdb->last_error ?? ''));
            throw new \RuntimeException(
              'Per-date write failed for ' . $only_date
              . ($db_err !== '' ? (' (DB: ' . $db_err . ')') : ' (update_option returned false and verification read does not match)')
            );
          }
        }
      } else {
        // Date no longer has any editions (last page deleted) — clean up the
        // stale per-date option so future reads don't return orphaned data.
        delete_option($this->edition_option_key($only_date));
      }
    } else {
      foreach ($editions_by_date as $date => $editions) {
        update_option($this->edition_option_key($date), $editions, false);
      }
    }

    // ── Dates index ───────────────────────────────────────────────────────
    // Build the index carefully so a scoped write (single $only_date) does NOT
    // wipe every other date out of the index.  When the caller passed a slice
    // of $data (just one date), $editions_by_date will contain only that one
    // entry — using it as the new dates list would erase the rest of the
    // archive from the index, which would in turn cause /data/dates to return
    // nothing and the Angular app to show an empty newspaper.
    if ($only_date !== null && preg_match('/^\d{4}-\d{2}-\d{2}$/', $only_date)) {
      $existing      = get_option(self::OPTION_INDEX);
      $existingDates = is_array($existing) && is_array($existing['dates'] ?? null)
        ? (array) $existing['dates']
        : [];

      // If the date we touched still has editions, ensure it's in the list.
      // If it no longer has editions (last page deleted), drop it.
      $dateStillExists = isset($editions_by_date[$only_date]);
      $merged          = array_values(array_unique(array_filter(
        $existingDates,
        static fn($d) => is_string($d) && $d !== $only_date
      )));
      if ($dateStillExists) {
        $merged[] = $only_date;
      }
      rsort($merged);
      update_option(self::OPTION_INDEX, [
        'dates'       => $merged,
        'dataVersion' => $dataVersion,
      ], false);
    } else {
      // Full-blob write — $editions_by_date represents the entire archive,
      // so it's safe (and necessary) to overwrite the index from it.
      $dates = array_keys($editions_by_date);
      rsort($dates);
      update_option(self::OPTION_INDEX, [
        'dates'       => $dates,
        'dataVersion' => $dataVersion,
      ], false);
    }

    // Mark migration done (in case this is the very first save on a new install)
    if (!get_option(self::OPTION_MIGRATED_V2)) {
      update_option(self::OPTION_MIGRATED_V2, true);
    }
  }

  /**
   * Normalize all known domain aliases in stored URLs to the current WordPress
   * home_url() origin. This ensures the API always returns URLs whose host
   * matches the active installation — no matter which domain was used when the
   * data was originally saved (epaper ↔ nepaper ↔ www variants).
   * The canonical origin is derived at runtime from home_url(), so it
   * automatically follows the configured wpBaseUrl on the Angular side.
   */
  private function normalize_domain_urls($data) {
    static $canonical_origin = null;
    static $known_aliases    = null;

    if ($canonical_origin === null) {
      $parsed           = wp_parse_url(home_url());
      $canonical_origin = ($parsed['scheme'] ?? 'https') . '://' . ($parsed['host'] ?? '');
    }

    if ($known_aliases === null) {
      // ── CQ-5: domain aliases from WordPress option ─────────────────────
      // Read the saved alias list; fall back to the built-in defaults so that
      // existing installations that have never saved the option still work.
      // Admins can update the list via Settings > Digital Newspaper > Domain Aliases.
      $defaults = [
        'https://epaper.dailysangram.com',
        'http://epaper.dailysangram.com',
        'https://www.epaper.dailysangram.com',
        'https://nepaper.dailysangram.com',
        'http://nepaper.dailysangram.com',
        'https://www.nepaper.dailysangram.com',
      ];
      $saved = get_option(self::OPTION_DOMAIN_ALIASES, null);
      $known_aliases = (is_array($saved) && !empty($saved)) ? $saved : $defaults;
    }

    // ── Performance optimisation (PERF-1) ─────────────────────────────────
    // For arrays (the common case — full dataset or edition list), serialise
    // to JSON once, do bulk string replacements on the JSON string, then
    // decode back.  This is O(n) in the JSON length rather than O(n×k)
    // recursive PHP function calls (k = number of aliases), which caused
    // PHP execution-time timeouts on large newspapers (365+ editions).
    if (is_array($data)) {
      // Compute the set of aliases that actually differ from canonical_origin
      // so we skip aliases that are already correct (no-op replacements).
      $to_replace = [];
      foreach ($known_aliases as $alias) {
        if ($alias !== $canonical_origin) {
          $to_replace[] = $alias;
        }
      }

      if (empty($to_replace)) {
        return $data; // Nothing to replace — return as-is.
      }

      $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
      if ($json === false) {
        // json_encode failed (rare — e.g. invalid UTF-8). Fall back to the
        // original recursive approach for correctness.
        return array_map([$this, 'normalize_domain_urls'], $data);
      }

      // Only run replacements if at least one alias string appears in the JSON.
      $needs_replacement = false;
      foreach ($to_replace as $alias) {
        if (strpos($json, $alias) !== false) {
          $needs_replacement = true;
          break;
        }
      }

      if (!$needs_replacement) {
        return $data; // No aliases found — nothing to do.
      }

      $json = str_replace($to_replace, array_fill(0, count($to_replace), $canonical_origin), $json);
      $result = json_decode($json, true);
      return is_array($result) ? $result : $data;
    }

    if (is_string($data)) {
      foreach ($known_aliases as $alias) {
        if ($alias !== $canonical_origin && strpos($data, $alias) !== false) {
          $data = str_replace($alias, $canonical_origin, $data);
        }
      }
      return $data;
    }
    return $data;
  }

  /**
   * Persists $data (stamping a fresh dataVersion) and syncs dn_section posts.
   *
   * @param  array  $data            The full NewspaperData payload to store.
   * @param  string $saved_by        Display name of the saving user (for audit).
   * @param  float  $version         Pre-computed version stamp (optional; generated here if 0).
   * @param  bool   $throttle_snapshot  When true, snapshot is skipped if one was created
   *                                    within the last 5 minutes (for high-frequency atomic saves).
   * @return array{postIds: array<string,int>, newDataVersion: float}
   */
  public function save_data(array $data, string $saved_by = '', float $version = 0.0, bool $throttle_snapshot = false, bool $sync_posts = true, ?string $only_date = null): array {
    // ── Snapshot rotation ──────────────────────────────────────────────────
    // Only snapshot on full-blob saves.  Atomic ($only_date) endpoints don't
    // modify the dn_data blob, so there is nothing new to snapshot AND the
    // snapshot itself is the most memory-intensive operation in the plugin:
    // it has to load the dn_data_backups option (up to ~200 MB — 20 slots ×
    // ~10 MB each compressed snapshots), prepend a new entry, then serialise
    // and write it back.  Peak RAM during that sequence approaches 400 MB and
    // is the source of the "Allowed memory size … exhausted" fatals on shared
    // hosting (visible as intermittent save failures every ~5 min, gated by
    // the snapshot throttle transient).
    //
    // dn_data backups are refreshed on every POST /data save, which already
    // bumps memory_limit to 1536M for exactly this reason.  Per-date options
    // are themselves the source of truth and can be recovered from
    // dn_section custom posts via /data/rebuild-from-sections if needed.
    if ($only_date === null) {
      $this->snapshot_current_data_before_save($saved_by, $throttle_snapshot);
    }
    // Stamp a fresh version so the next client load gets the new version token.
    $data['dataVersion'] = $version > 0.0 ? $version : (float) microtime(true);

    // ── Primary write ──────────────────────────────────────────────────────
    // Historically this wrote the full ~30 MB dn_data blob on every save for
    // backward compatibility with the legacy GET /data endpoint.  On shared
    // hosting that 30 MB UPDATE was the single biggest cause of save failures:
    //   • MySQL max_allowed_packet (often 16–64 MB) can reject the query
    //     outright, producing a "Got a packet bigger than max_allowed_packet"
    //     fatal that WordPress surfaces as its critical-error HTML.
    //   • Even when it succeeds, the UPDATE on a 30 MB option_value spends
    //     5–15 s in fsync + redo/undo logging.
    //
    // Now that granular storage v2 is the source of truth (dn_settings +
    // dn_data_index + per-date dn_edition_{date} options), the blob is only
    // useful as a cold-storage fallback.  When the caller supplies $only_date
    // (atomic page/section endpoints) we skip the blob write entirely and let
    // the per-date write below carry the change.  Full saves (POST /data)
    // continue to refresh the blob so the fallback stays usable.
    if ($only_date === null) {
      update_option(self::OPTION_KEY, $data, false);
    }

    // Secondary write: granular per-date keys (used by the new cacheable endpoints).
    //
    // When $only_date is set (atomic page/section endpoints) this IS the
    // primary persistence — the dn_data blob write was skipped above — so a
    // failure here means the user's edit is lost.  Re-throw in that case so
    // the endpoint returns a 500 and the admin's error toast surfaces it
    // instead of falsely showing "saved" while the data was discarded.
    //
    // For full saves ($only_date === null) the dn_data blob is still the
    // authoritative source, so a per-date failure remains non-fatal.
    try {
      $this->write_per_date_storage($data, $only_date);
    } catch (\Throwable $e) {
      error_log('[DigitalNewspaper] write_per_date_storage failed: ' . $e->getMessage());
      if ($only_date !== null) {
        throw $e;
      }
    }

    // WP post sync: mirrors every section to a dn_section custom post type.
    // Skipped ($sync_posts = false) by the atomic PUT endpoints which sync only
    // the single changed section themselves — avoiding O(all-sections) DB work
    // that causes gateway timeouts on large datasets.
    $postIds = [];
    if ($sync_posts) {
      try {
        $postIds = $this->sync_section_posts_from_data($data);
      } catch (\Throwable $e) {
        error_log('[DigitalNewspaper] sync_section_posts_from_data failed: ' . $e->getMessage());
      }
    }

    return ['postIds' => $postIds, 'newDataVersion' => $data['dataVersion']];
  }

  private function snapshot_current_data_before_save(string $saved_by = '', bool $throttle = false): void {
    global $wpdb;

    // For high-frequency atomic saves (e.g. every section edit), only take a
    // snapshot at most once every 5 minutes to avoid burning through the
    // 20-slot backup rotation in seconds.
    if ($throttle) {
      $last = (int) get_transient('dn_last_auto_snapshot');
      if ($last > 0 && (time() - $last) < 300) {
        return; // Skip — a snapshot was taken recently
      }
      set_transient('dn_last_auto_snapshot', time(), 3600);
    }

    // ── MEM-OPT: Read the raw serialized bytes from MySQL ──────────────────
    // get_option() would deserialize the PHP-serialized string into a PHP array
    // which for a 30–50 MB blob costs 150–200 MB of RAM — easily OOMing on
    // shared hosting with a 256 M limit.
    //
    // Instead: read the raw option_value string from MySQL (a PHP string, not
    // an array) and gzcompress that directly.  Peak memory: ~35 MB (raw string
    // + compressed copy) instead of ~210 MB (PHP array + JSON + gz).
    //
    // The backup is stored as data_gz_serial (gzip of the PHP-serialized
    // string).  The restore endpoint handles both the old data_gz (JSON) and
    // the new data_gz_serial format transparently.
    $raw_serial = $wpdb->get_var($wpdb->prepare(
      "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
      self::OPTION_KEY
    ));

    if (empty($raw_serial) || strlen($raw_serial) < 10) {
      return; // Nothing to snapshot (fresh install or option missing)
    }

    // ── Pre-compute summary fields from the index ───────────────────────────
    // We avoid deserializing the raw string for summary fields; use the
    // dn_data_index (always tiny) instead.  Falls back to regex extraction.
    $index = get_option(self::OPTION_INDEX);
    if (is_array($index) && !empty($index['dates'])) {
      $dates      = (array) $index['dates'];
      $editionCnt = count($dates);
    } else {
      // Fallback: extract dates from the serialized string via regex.
      // This is much cheaper than a full unserialize.
      preg_match_all('/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/', $raw_serial, $m);
      $dates      = array_values(array_unique($m[1] ?? []));
      rsort($dates);
      $editionCnt = count($dates);
    }

    $entry = [
      'createdAt'    => gmdate('c'),
      'savedBy'      => $saved_by ?: 'system',
      'editionCount' => $editionCnt,
      'pageCount'    => -1,   // Not computed — avoids deserializing the blob
      'sectionCount' => -1,   // Not computed — avoids deserializing the blob
      'latestDates'  => array_slice($dates, 0, 10),
    ];
    unset($dates, $index);

    // ── Compress the raw serialized string ─────────────────────────────────
    if (function_exists('gzcompress')) {
      $gz_raw = gzcompress($raw_serial, 6);
      unset($raw_serial);
      $entry['data_gz_serial'] = base64_encode($gz_raw);
      unset($gz_raw);
    } else {
      // zlib not available: store the serialized string directly.
      // It's a string, not an array — the restore code handles this.
      $entry['data_serial'] = $raw_serial;
      unset($raw_serial);
    }

    gc_collect_cycles();

    $backups = get_option(self::OPTION_BACKUPS, []);
    if (!is_array($backups)) {
      $backups = [];
    }

    // Trim to 19 BEFORE inserting so the array never holds 21 entries at once.
    if (count($backups) >= 20) {
      array_pop($backups);
    }
    array_unshift($backups, $entry);
    unset($entry);

    update_option(self::OPTION_BACKUPS, $backups, false);

    // Free the backup array before returning to save_data() which still
    // needs RAM for the section-post sync.
    unset($backups);
    gc_collect_cycles();
  }

  private function count_pages(array $data): int {
    $count = 0;
    foreach (($data['editions'] ?? []) as $edition) {
      if (is_array($edition) && isset($edition['pages']) && is_array($edition['pages'])) {
        $count += count($edition['pages']);
      }
    }
    return $count;
  }

  private function count_sections(array $data): int {
    $count = 0;
    foreach (($data['editions'] ?? []) as $edition) {
      foreach (($edition['pages'] ?? []) as $page) {
        if (is_array($page) && isset($page['sections']) && is_array($page['sections'])) {
          $count += count($page['sections']);
        }
      }
    }
    return $count;
  }

  private function backup_summary(array $backup, int $index): array {
    // New compressed format: summary fields are pre-computed and stored inline
    // alongside the data_gz blob.  Return them directly — no decompression
    // needed, keeping the list-backups endpoint fast and memory-efficient.
    if (isset($backup['data_gz'])) {
      return [
        'index'        => $index,
        'createdAt'    => (string) ($backup['createdAt'] ?? ''),
        'editionCount' => (int)    ($backup['editionCount'] ?? 0),
        'pageCount'    => (int)    ($backup['pageCount']    ?? 0),
        'sectionCount' => (int)    ($backup['sectionCount'] ?? 0),
        'latestDates'  => is_array($backup['latestDates'] ?? null) ? $backup['latestDates'] : [],
      ];
    }

    // Legacy uncompressed format: derive counts from the data array.
    $data = isset($backup['data']) && is_array($backup['data']) ? $backup['data'] : [];
    $dates = [];
    foreach (($data['editions'] ?? []) as $edition) {
      if (is_array($edition) && !empty($edition['date'])) {
        $dates[] = (string) $edition['date'];
      }
    }
    $dates = array_values(array_unique($dates));
    rsort($dates);

    return [
      'index'        => $index,
      'createdAt'    => (string) ($backup['createdAt'] ?? ''),
      'editionCount' => is_array($data['editions'] ?? null) ? count($data['editions']) : 0,
      'pageCount'    => $this->count_pages($data),
      'sectionCount' => $this->count_sections($data),
      'latestDates'  => array_slice($dates, 0, 10),
    ];
  }

  private function get_data_backups(): array {
    $backups = get_option(self::OPTION_BACKUPS, []);
    return is_array($backups) ? $backups : [];
  }

  private function section_key(string $date, int $editionNumber, int $pageId, string $sectionId): string {
    return $date . ':' . $editionNumber . ':' . $pageId . ':' . $sectionId;
  }

  private function find_section_post_id(string $key): int {
    $posts = get_posts([
      'post_type'      => self::SECTION_POST_TYPE,
      // RECOVERY: include 'trash' so a save that re-introduces a section
      // whose post was previously trashed (by trash_stale_section_posts during
      // a shrunken-save) reuses + untrashes that post instead of creating a
      // duplicate.  The caller is expected to untrash before updating.
      'post_status'    => ['publish', 'draft', 'private', 'pending', 'trash'],
      'posts_per_page' => 1,
      'fields'         => 'ids',
      'meta_key'       => '_dn_section_key',
      'meta_value'     => $key,
      'no_found_rows'  => true,
    ]);

    return $posts ? (int) $posts[0] : 0;
  }

  private function get_all_section_post_ids(): array {
    $posts = get_posts([
      'post_type'      => self::SECTION_POST_TYPE,
      'post_status'    => ['publish', 'draft', 'private', 'pending'],
      'posts_per_page' => -1,
      'fields'         => 'ids',
      'no_found_rows'  => true,
    ]);

    return array_map('intval', $posts ?: []);
  }

  /**
   * Syncs every section in $data to a dn_section custom post and returns a
   * map of section key → WP post ID so the REST response can round-trip the
   * post IDs back to Angular.
   *
   * @return array<string, int>  e.g. [ '2026-06-04:1:2:xml-2026-06-04-e1-p2-hello' => 42 ]
   */
  private function sync_section_posts_from_data(array $data): array {
    if (empty($data['editions']) || !is_array($data['editions']) || $this->count_sections($data) === 0) {
      return [];
    }

    $seenKeys = [];
    $keyToPostId = [];

    foreach ($data['editions'] as $editionIndex => $edition) {
      if (!is_array($edition)) continue;
      $date = sanitize_text_field((string) ($edition['date'] ?? ''));
      if ($date === '') continue;
      $editionNumber = max(1, (int) ($edition['edition'] ?? 1));
      $editionLabels = is_array($edition['editionLabels'] ?? null) ? $edition['editionLabels'] : [];

      foreach (($edition['pages'] ?? []) as $pageIndex => $page) {
        if (!is_array($page)) continue;
        $pageId = max(1, (int) ($page['id'] ?? ($pageIndex + 1)));
        $pageLabels = is_array($page['pageLabels'] ?? null) ? $page['pageLabels'] : [];

        foreach (($page['sections'] ?? []) as $sectionIndex => $section) {
          if (!is_array($section)) continue;
          $sectionId = sanitize_text_field((string) ($section['id'] ?? ''));
          if ($sectionId === '') continue;

          $key = $this->section_key($date, $editionNumber, $pageId, $sectionId);
          $seenKeys[$key] = true;

          $postId = $this->upsert_section_post(
            $key,
            $date,
            $editionNumber,
            $editionLabels,
            $editionIndex,
            $page,
            $pageId,
            $pageLabels,
            $pageIndex,
            $section,
            $sectionIndex
          );

          if ($postId > 0) {
            $keyToPostId[$key] = $postId;
          }
        }
      }
    }

    $this->sync_linked_section_post_ids($data, $keyToPostId);
    $this->trash_stale_section_posts(array_keys($seenKeys));

    return $keyToPostId;
  }

  private function upsert_section_post(
    string $key,
    string $date,
    int $editionNumber,
    array $editionLabels,
    int $editionIndex,
    array $page,
    int $pageId,
    array $pageLabels,
    int $pageIndex,
    array $section,
    int $sectionIndex
  ): int {
    $sectionId = sanitize_text_field((string) ($section['id'] ?? ''));
    $title = sanitize_text_field((string) ($section['title'] ?? $sectionId));
    $content = wp_kses_post((string) ($section['content'] ?? ''));
    $postId = $this->find_section_post_id($key);

    $postData = [
      'post_type'    => self::SECTION_POST_TYPE,
      'post_status'  => 'publish',
      'post_title'   => $title !== '' ? $title : $sectionId,
      'post_content' => $content,
      'post_name'    => sanitize_title($key),
    ];

    if ($postId > 0) {
      $postData['ID'] = $postId;
      $result = wp_update_post($postData, true);
    } else {
      $result = wp_insert_post($postData, true);
    }

    if (is_wp_error($result)) {
      error_log('Digital Newspaper section mirror failed: ' . $result->get_error_message());
      return 0;
    }

    $postId = (int) $result;
    $linkedSectionIds = is_array($section['linkedSectionIds'] ?? null) ? array_values(array_map('strval', $section['linkedSectionIds'])) : [];

    $meta = [
      '_dn_section_key'       => $key,
      'dn_newspaper_date'     => $date,
      'dn_edition_number'     => $editionNumber,
      'dn_edition_order'      => $editionIndex,
      'dn_edition_labels'     => wp_json_encode($editionLabels, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
      'dn_page_id'            => $pageId,
      'dn_page_order'         => $pageIndex,
      'dn_page_labels'        => wp_json_encode($pageLabels, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
      'dn_page_name'          => sanitize_text_field((function () use ($pageLabels): string {
        if (!empty($pageLabels) && is_array($pageLabels)) {
          $first = reset($pageLabels);
          if (is_string($first) && $first !== '') return $first;
        }
        return '';
      })()),
      'dn_page_thumbnail'     => esc_url_raw((string) ($page['thumbnail'] ?? '')),
      'dn_page_full_image'    => esc_url_raw((string) ($page['fullImage'] ?? '')),
      'dn_page_full_hires'    => esc_url_raw((string) ($page['fullImageHiRes'] ?? '')),
      'dn_section_id'         => $sectionId,
      'dn_section_order'      => $sectionIndex,
      'dn_crop_x'             => (string) (float) ($section['x'] ?? 0),
      'dn_crop_y'             => (string) (float) ($section['y'] ?? 0),
      'dn_crop_w'             => (string) (float) ($section['width'] ?? 0),
      'dn_crop_h'             => (string) (float) ($section['height'] ?? 0),
      'dn_cropped_image_url'  => esc_url_raw((string) ($section['imageUrl'] ?? '')),
      'dn_linked_section_ids'     => wp_json_encode($linkedSectionIds),
      'dn_linked_section_primary' => sanitize_text_field((string) ($section['linkedSectionPrimary'] ?? '')),
      'dn_section_payload'        => wp_json_encode($section, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
    ];

    foreach ($meta as $metaKey => $metaValue) {
      update_post_meta($postId, $metaKey, $metaValue);
    }

    return $postId;
  }

  private function sync_linked_section_post_ids(array $data, array $keyToPostId): void {
    foreach ($data['editions'] ?? [] as $edition) {
      if (!is_array($edition)) continue;
      $date = (string) ($edition['date'] ?? '');
      $editionNumber = max(1, (int) ($edition['edition'] ?? 1));

      foreach (($edition['pages'] ?? []) as $page) {
        if (!is_array($page)) continue;
        $pageId = max(1, (int) ($page['id'] ?? 1));

        foreach (($page['sections'] ?? []) as $section) {
          if (!is_array($section)) continue;
          $sectionId = (string) ($section['id'] ?? '');
          $key = $this->section_key($date, $editionNumber, $pageId, $sectionId);
          $postId = $keyToPostId[$key] ?? 0;
          if (!$postId) continue;

          $linkedPostIds = [];
          foreach (($section['linkedSectionIds'] ?? []) as $linkedSectionId) {
            $linkedKey = $this->section_key($date, $editionNumber, $pageId, (string) $linkedSectionId);
            if (!empty($keyToPostId[$linkedKey])) {
              $linkedPostIds[] = (int) $keyToPostId[$linkedKey];
            }
          }
          update_post_meta($postId, 'dn_linked_wp_post_ids', wp_json_encode(array_values(array_unique($linkedPostIds))));
        }
      }
    }
  }

  private function trash_stale_section_posts(array $activeKeys): void {
    $active = array_fill_keys($activeKeys, true);
    foreach ($this->get_all_section_post_ids() as $postId) {
      $key = (string) get_post_meta($postId, '_dn_section_key', true);
      if ($key !== '' && empty($active[$key])) {
        wp_trash_post($postId);
      }
    }
  }

  public function register_routes(): void {
    register_rest_route('digital-newspaper/v1', '/data', [
      [
        'methods' => 'GET',
        'callback' => [$this, 'get_data_endpoint'],
        'permission_callback' => '__return_true'
      ],
      [
        'methods' => 'POST',
        'callback' => [$this, 'post_data_endpoint'],
        'permission_callback' => [$this, 'auth_required']
      ]
    ]);

    // ── Lightweight version probe ─────────────────────────────────────────────
    // Returns only the current dataVersion float. Clients poll this every 30–60 s
    // to detect remote changes without downloading the full dataset each time.
    register_rest_route('digital-newspaper/v1', '/data/version', [
      'methods'             => 'GET',
      'callback'            => [$this, 'get_data_version_endpoint'],
      'permission_callback' => '__return_true',
    ]);

    // ── Incremental / date-based public read endpoints ─────────────────────
    // These three endpoints let the Angular app fetch data incrementally
    // instead of downloading the full dataset on every page load.
    // All are publicly cacheable; credentials are NOT required or sent.

    // GET /data/settings — global settings only (logo, theme, social links).
    // Cached for 1 hour; settings change rarely.
    register_rest_route('digital-newspaper/v1', '/data/settings', [
      'methods'             => 'GET',
      'callback'            => [$this, 'get_settings_endpoint'],
      'permission_callback' => '__return_true',
    ]);

    // GET /data/dates — sorted list of available edition dates.
    // Cached for 5 minutes; new editions are published daily.
    register_rest_route('digital-newspaper/v1', '/data/dates', [
      'methods'             => 'GET',
      'callback'            => [$this, 'get_dates_endpoint'],
      'permission_callback' => '__return_true',
    ]);

    // GET /data/editions/:date — all editions for a single date.
    // Past dates cached 24 h; today cached 5 min.
    register_rest_route('digital-newspaper/v1', '/data/editions/(?P<date>\d{4}-\d{2}-\d{2})', [
      'methods'             => 'GET',
      'callback'            => [$this, 'get_edition_by_date_endpoint'],
      'permission_callback' => '__return_true',
      'args'                => [
        'date' => [
          'required'          => true,
          'validate_callback' => static function ($param) {
            return (bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $param);
          },
          'sanitize_callback' => 'sanitize_text_field',
        ],
      ],
    ]);

    // ── Atomic page endpoints (server-side read-modify-write; no version conflict) ──
    // Each endpoint reads the current stored data, updates only the target page,
    // and writes back — safe because PHP handles one request at a time.
    register_rest_route('digital-newspaper/v1', '/data/page', [
      [
        'methods'             => 'PUT',
        'callback'            => [$this, 'put_page_endpoint'],
        'permission_callback' => [$this, 'auth_required'],
      ],
      [
        'methods'             => 'DELETE',
        'callback'            => [$this, 'delete_page_endpoint'],
        'permission_callback' => [$this, 'auth_required'],
      ],
    ]);

    // ── Atomic section endpoints ───────────────────────────────────────────────
    register_rest_route('digital-newspaper/v1', '/data/section', [
      [
        'methods'             => 'PUT',
        'callback'            => [$this, 'put_section_endpoint'],
        'permission_callback' => [$this, 'auth_required'],
      ],
      [
        'methods'             => 'DELETE',
        'callback'            => [$this, 'delete_section_endpoint'],
        'permission_callback' => [$this, 'auth_required'],
      ],
    ]);

    register_rest_route('digital-newspaper/v1', '/data/backups', [
      [
        'methods' => 'GET',
        'callback' => [$this, 'list_data_backups_endpoint'],
        'permission_callback' => [$this, 'auth_required']
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/data/restore', [
      [
        'methods' => 'POST',
        'callback' => [$this, 'restore_data_backup_endpoint'],
        'permission_callback' => [$this, 'admin_required']
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/data/rebuild-from-sections', [
      [
        'methods' => 'POST',
        'callback' => [$this, 'rebuild_data_from_sections_endpoint'],
        'permission_callback' => [$this, 'admin_required']
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/diag/last-fatal', [
      [
        'methods' => 'GET',
        'callback' => [$this, 'diag_last_fatal_endpoint'],
        'permission_callback' => [$this, 'diag_permission_callback']
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/diag/sample-section', [
      [
        'methods' => 'GET',
        'callback' => [$this, 'diag_sample_section_endpoint'],
        'permission_callback' => [$this, 'diag_permission_callback']
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/diag/scan-broken', [
      [
        'methods' => 'GET',
        'callback' => [$this, 'diag_scan_broken_endpoint'],
        'permission_callback' => [$this, 'diag_permission_callback']
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/auth/login', [
      [
        'methods' => 'POST',
        'callback' => [$this, 'login'],
        'permission_callback' => '__return_true'
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/auth/me', [
      [
        'methods' => 'GET',
        'callback' => [$this, 'me'],
        'permission_callback' => [$this, 'auth_required']
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/proxy', [
      [
        'methods' => 'GET',
        'callback' => [$this, 'proxy_image'],
        'permission_callback' => '__return_true'
      ]
    ]);

    // Custom media endpoints — authenticated via plugin JWT (bypasses core /wp/v2/media auth issues)
    register_rest_route('digital-newspaper/v1', '/media', [
      [
        'methods'             => 'POST',
        'callback'            => [$this, 'upload_media'],
        'permission_callback' => [$this, 'auth_required']
      ],
      [
        'methods'             => 'GET',
        'callback'            => [$this, 'list_media'],
        'permission_callback' => [$this, 'auth_required']
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/media/(?P<id>\d+)', [
      [
        'methods'             => 'DELETE',
        'callback'            => [$this, 'delete_media_item'],
        'permission_callback' => [$this, 'auth_required']
      ]
    ]);

    // ── Activity log endpoints ─────────────────────────────────────────────
    register_rest_route('digital-newspaper/v1', '/activity-log', [
      [
        'methods'             => 'GET',
        'callback'            => [$this, 'list_activity_log'],
        'permission_callback' => [$this, 'admin_required'],
      ],
      [
        'methods'             => 'DELETE',
        'callback'            => [$this, 'clear_activity_log'],
        'permission_callback' => [$this, 'admin_required'],
      ],
    ]);

    // Client-side batch event endpoint — accepts up to 50 events per call.
    register_rest_route('digital-newspaper/v1', '/activity-log/batch', [
      [
        'methods'             => 'POST',
        'callback'            => [$this, 'log_client_batch'],
        'permission_callback' => [$this, 'auth_required'],
      ],
    ]);

    // ── Page/section locking endpoints ────────────────────────────────────
    // Acquire a lock on a resource (page or edition) while editing.
    register_rest_route('digital-newspaper/v1', '/locks/(?P<resource>[a-zA-Z0-9_:.-]+)', [
      [
        'methods'             => 'GET',
        'callback'            => [$this, 'get_lock'],
        'permission_callback' => [$this, 'auth_required'],
      ],
      [
        'methods'             => 'POST',
        'callback'            => [$this, 'acquire_lock'],
        'permission_callback' => [$this, 'auth_required'],
      ],
      [
        'methods'             => 'DELETE',
        'callback'            => [$this, 'release_lock'],
        'permission_callback' => [$this, 'auth_required'],
      ],
    ]);

    // Heartbeat: refresh a held lock's TTL.
    register_rest_route('digital-newspaper/v1', '/locks/(?P<resource>[a-zA-Z0-9_:.-]+)/heartbeat', [
      [
        'methods'             => 'POST',
        'callback'            => [$this, 'heartbeat_lock'],
        'permission_callback' => [$this, 'auth_required'],
      ],
    ]);

    // List all active locks (admin only).
    register_rest_route('digital-newspaper/v1', '/locks', [
      [
        'methods'             => 'GET',
        'callback'            => [$this, 'list_locks'],
        'permission_callback' => [$this, 'admin_required'],
      ],
    ]);

    // Social-sharing OG/Twitter Card endpoint — called by .htaccess for
    // social crawlers so they receive proper meta tags without running JS.
    register_rest_route('digital-newspaper/v1', '/social', [
      [
        'methods'             => 'GET',
        'callback'            => [$this, 'social_sharing_endpoint'],
        'permission_callback' => '__return_true'
      ]
    ]);

    // Stable public image endpoint for generated social JPEGs. This bypasses
    // direct /wp-content/uploads/ fetch issues seen with some crawler UAs.
    register_rest_route('digital-newspaper/v1', '/social-image', [
      [
        'methods'             => 'GET',
        'callback'            => [$this, 'social_image_endpoint'],
        'permission_callback' => '__return_true'
      ]
    ]);

    // Cache pre-warm: generate social thumbnail JPEG files proactively.
    // This is intentionally credential-protected and never called automatically
    // after saves, because host bot protection may block background automation.
    register_rest_route('digital-newspaper/v1', '/warm-cache', [
      [
        'methods'             => 'POST',
        'callback'            => [$this, 'warm_social_cache'],
        'permission_callback' => [$this, 'warm_cache_permission']
      ]
    ]);

    // GET /data/health — operational health stats (admin only).
    register_rest_route('digital-newspaper/v1', '/data/health', [
      'methods'             => 'GET',
      'callback'            => [$this, 'get_health_endpoint'],
      'permission_callback' => [$this, 'admin_required'],
    ]);
  }

  public function warm_cache_permission(WP_REST_Request $request) {
    // Warm-cache triggers heavy GD image processing — restrict to admins
    // so unprivileged authenticated users cannot abuse it as a DoS vector.
    return $this->admin_required($request);
  }

  public function social_sharing_endpoint(WP_REST_Request $request) {
    // Use wp_unslash + trim instead of sanitize_text_field — the latter
    // strips %XX byte sequences which can corrupt multibyte Bengali slugs.
    $date         = trim(wp_unslash((string) ($request->get_param('date') ?? '')));
    $pageSlug     = trim(wp_unslash((string) ($request->get_param('page') ?? '')));
    $editionSlug  = trim(wp_unslash((string) ($request->get_param('edition') ?? '')));
    $slug         = trim(wp_unslash(urldecode((string) ($request->get_param('slug') ?? ''))));

    // ---------------------------------------------------------------
    // Homepage case: ?homepage=1 — return site-level OG tags with logo.
    // Triggered from .htaccess when a social bot visits the root URL (/).
    // ---------------------------------------------------------------
    if (filter_var($request->get_param('homepage'), FILTER_VALIDATE_BOOLEAN)) {
      $data     = $this->get_data();
      $settings = isset($data['settings']) && is_array($data['settings']) ? $data['settings'] : [];
      $siteName = isset($settings['logo']['alt']) ? trim((string) $settings['logo']['alt']) : '';
      if ($siteName === '') {
        $siteName = 'Digital Newspaper';
      }
      $logoUrl  = isset($settings['logo']['url']) ? trim((string) $settings['logo']['url']) : '';
      $wpBase   = rtrim(site_url(), '/');
      $wpParsed = wp_parse_url(site_url());
      $angularBase = $wpParsed['scheme'] . '://' . $wpParsed['host'];
      $canonical   = $angularBase . '/';

      // Generate a 1200×630 JPEG: light grey background + site logo centred.
      // At ~30–60 KB this single image satisfies ALL social platforms:
      //   Facebook  ≥ 200 px minimum  ✓  (1200×630 is the recommended size)
      //   WhatsApp  ≤ ~300 KB limit   ✓  (generated JPEG is well under that)
      // Cached in wp-content/uploads/ after first generation; no per-UA branching.
      $imageUrl = $this->dn_fallback_social_image($logoUrl);

      // If PHP GD is unavailable on this server, fall back to section image chain.
      if ($imageUrl === '') {
        $pageImgFallback = '';
        $editions = isset($data['editions']) && is_array($data['editions']) ? $data['editions'] : [];
        usort($editions, static function ($a, $b) {
          return strcmp((string) ($b['date'] ?? ''), (string) ($a['date'] ?? ''));
        });
        if (!empty($editions)) {
          $latestEdition = $editions[0];
          foreach (($latestEdition['pages'] ?? []) as $page) {
            if ($pageImgFallback === '') {
              $pageImgFallback = $this->dn_resolve_image((string) ($page['fullImage'] ?? ''), $wpBase);
            }
            foreach (($page['sections'] ?? []) as $sec) {
              $rawImg = trim((string) ($sec['imageUrl'] ?? ''));
              if ($rawImg === '') continue;
              $candidate = $this->dn_resolve_image($rawImg, $wpBase);
              if ($candidate !== '') {
                $imageUrl = $candidate;
                break 2;
              }
            }
          }
          if ($imageUrl === '' && $pageImgFallback !== '') {
            $imageUrl = $pageImgFallback;
          }
        }
        if ($imageUrl === '' && $logoUrl !== '') {
          $imageUrl = $this->dn_resolve_image($logoUrl, $wpBase);
        }
      }

      $t   = esc_attr($siteName);
      $s   = esc_attr($siteName);
      $u   = esc_url($canonical);
      $img = esc_url($this->dn_public_social_image_url($imageUrl));
      $twitterUrl = esc_url($canonical);
      $twitterDomain = esc_attr((string) ($wpParsed['host'] ?? ''));
      $red = wp_json_encode($canonical, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

      // Generated fallback is always JPEG; others detected from extension.
      $imgExt  = strtolower(pathinfo((string) parse_url($imageUrl, PHP_URL_PATH), PATHINFO_EXTENSION));
      $imgMime = in_array($imgExt, ['png', 'webp', 'gif'], true) ? 'image/' . $imgExt : 'image/jpeg';

      // Homepage image is always our GD-generated 1200×630 fallback (when GD is
      // available) — emit width/height so WhatsApp doesn't need a separate HEAD.
      $isStandardSize = strpos($imageUrl, '/dn-social-') !== false;

      $ogImgTags      = '';
      $twitterImgTags = '';
      if ($img !== '') {
        $ogImgTags      = "  <meta property=\"og:image\"            content=\"{$img}\">\n"
                        . "  <meta property=\"og:image:secure_url\" content=\"{$img}\">\n"
                        . "  <meta property=\"og:image:type\"       content=\"{$imgMime}\">\n";
        if ($isStandardSize) {
          $ogImgTags .= "  <meta property=\"og:image:width\"      content=\"1200\">\n"
                     .  "  <meta property=\"og:image:height\"     content=\"630\">\n";
        }
        $twitterImgTags = "  <meta name=\"twitter:image\"     content=\"{$img}\">\n"
                        . "  <meta name=\"twitter:image:src\" content=\"{$img}\">\n"
                        . "  <meta name=\"twitter:image:alt\" content=\"{$t}\">\n";
      }

      $html = <<<HTML
<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="utf-8">
  <title>{$t}</title>

  <!-- Open Graph -->
  <meta property="og:site_name"   content="{$s}">
  <meta property="og:type"        content="website">
  <meta property="og:title"       content="{$t}">
  <meta property="og:description" content="{$t}">
  <meta property="og:url"         content="{$u}">
{$ogImgTags}
  <!-- Twitter / X Card -->
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:url"         content="{$twitterUrl}">
  <meta name="twitter:domain"      content="{$twitterDomain}">
  <meta name="twitter:title"       content="{$t}">
  <meta name="twitter:description" content="{$t}">
{$twitterImgTags}
  <script>window.location.replace({$red});</script>
</head>
<body><p>Redirecting to <a href="{$u}">{$t}</a>&hellip;</p></body>
</html>
HTML;

      add_filter('rest_pre_serve_request', static function ($served) use ($html) {
        if (!$served) {
          status_header(200);
          header('Content-Type: text/html; charset=utf-8');
          header('Cache-Control: public, max-age=300, s-maxage=300');
          header('X-Robots-Tag: noindex, nofollow, noarchive');
          header('Vary: User-Agent');
          echo $html; // phpcs:ignore WordPress.Security.EscapeOutput
        }
        return true;
      }, 99);

      return new WP_REST_Response(null, 200);
    }

    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) || $slug === '') {
      return new WP_REST_Response(['error' => 'Invalid params'], 400);
    }

    $data     = $this->get_data();
    $settings = isset($data['settings']) && is_array($data['settings']) ? $data['settings'] : [];
    $siteName = isset($settings['logo']['alt']) ? trim((string) $settings['logo']['alt']) : '';
    $logoUrl  = isset($settings['logo']['url'])  ? trim((string) $settings['logo']['url'])  : '';
    if ($siteName === '') {
      $siteName = 'ইপেপার - দৈনিক সংগ্রাম';
    }

    // Angular app lives at the root of the same domain as WordPress.
    $wpParsed    = wp_parse_url(site_url());
    $angularBase = $wpParsed['scheme'] . '://' . $wpParsed['host'];
    $wpBase      = rtrim(site_url(), '/'); // for resolving relative image URLs

    $editions = isset($data['editions']) && is_array($data['editions']) ? $data['editions'] : [];

    $editionNumberFilter = 0;
    if ($editionSlug !== '' && preg_match('/^edition-(\d+)$/', $editionSlug, $m)) {
      $editionNumberFilter = (int) $m[1];
    }

    $secTitle   = '';
    $secContent = '';
    $imageUrl   = '';
    $found      = false;

    foreach ($editions as $edition) {
      // Normalise to YYYY-MM-DD — the stored value may carry a trailing timestamp.
      $editionDate = substr(trim((string) ($edition['date'] ?? '')), 0, 10);
      if ($editionDate !== $date) {
        continue;
      }
      if ($editionNumberFilter > 0) {
        $edNo = isset($edition['edition']) ? (int) $edition['edition'] : 1;
        if ($edNo !== $editionNumberFilter) {
          continue;
        }
      }
      foreach (($edition['pages'] ?? []) as $editionPage) {
        $pageImg = $this->dn_resolve_image((string) ($editionPage['fullImage'] ?? ''), $wpBase);
        foreach (($editionPage['sections'] ?? []) as $sec) {
          $id    = (string) ($sec['id']    ?? '');
          $title = (string) ($sec['title'] ?? '');
          if ($this->dn_matches_section_slug($slug, $title, $id)) {
            $secTitle   = $title;
            $secContent = strip_tags((string) ($sec['content'] ?? ''));
            $rawImg     = trim((string) ($sec['imageUrl'] ?? ''));
            if ($rawImg !== '') {
              $imageUrl = $this->dn_resolve_image($rawImg, $wpBase);
            } else {
              // No dedicated section image: crop from full-page image using
              // section coordinates so social preview matches selected section.
              $imageUrl = $this->dn_crop_section_from_page($pageImg, $sec);
              if ($imageUrl === '') {
                $imageUrl = $pageImg;
              }
            }
            $found      = true;
            break 3; // Exit sections + pages + editions loops.
          }
        }
      }
    }

    // When the specific section is not found, fall back to site-level OG tags.
    // Never return 404 — Facebook shows "bad response code" for any non-2xx status.
    if (!$found) {
      $secTitle = $siteName;
      // Try to find at least a page image for the requested date.
      foreach ($editions as $edition) {
        $editionDate = substr(trim((string) ($edition['date'] ?? '')), 0, 10);
        if ($editionDate !== $date) continue;
        foreach (($edition['pages'] ?? []) as $editionPage) {
          $fallbackImg = $this->dn_resolve_image((string) ($editionPage['fullImage'] ?? ''), $wpBase);
          if ($fallbackImg !== '') {
            $imageUrl = $fallbackImg;
            break 2;
          }
        }
      }
    }

    // Ultimate fallback: ensure og:image is ALWAYS present.
    // If the section was not found and no page scan exists for this date,
    // serve the branded grey+logo fallback image generated by GD.
    if ($imageUrl === '') {
      $imageUrl = $this->dn_fallback_social_image($logoUrl);
    }

    $desc = trim(preg_replace('/\s+/', ' ', $secContent));
    $desc = mb_substr($desc, 0, 155, 'UTF-8');
    if ($desc === '') {
      $desc = $siteName;
    }

    if ($pageSlug !== '' && $editionSlug !== '') {
      $canonical = $angularBase . '/' . rawurlencode($date) . '/' . rawurlencode($pageSlug) . '/' . rawurlencode($editionSlug) . '/' . rawurlencode($slug);
    } else {
      $canonical = $angularBase . '/' . rawurlencode($date) . '/' . rawurlencode($slug);
    }

    // Resize to 1200×630 for consistent social-media thumbnail dimensions.
    // Falls back to the original URL if GD is unavailable or the fetch fails.
    if ($imageUrl !== '') {
      $imageUrl = $this->dn_resize_for_social($imageUrl);
    }

    $t   = esc_attr($secTitle !== '' ? $secTitle : $siteName);
    $d   = esc_attr($desc);
    $s   = esc_attr($siteName);
    $u   = esc_url($canonical);
    $img = esc_url($this->dn_public_social_image_url($imageUrl));
    $twitterUrl = esc_url($canonical);
    $twitterDomain = esc_attr((string) ($wpParsed['host'] ?? ''));
    $red = wp_json_encode($canonical, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

    // Detect whether the image is our GD-generated 1200×630 JPEG so we can
    // emit accurate og:image:width / og:image:height — WhatsApp uses these
    // hints to display the preview without an extra image HEAD request.
    $isStandardSize = strpos($imageUrl, '/dn-social-') !== false;

    $ogImgTags     = '';
    $twitterImgTags = '';
    if ($img !== '') {
      $ogImgTags      = "  <meta property=\"og:image\"            content=\"{$img}\">\n"
                      . "  <meta property=\"og:image:secure_url\" content=\"{$img}\">\n"
                      . "  <meta property=\"og:image:type\"       content=\"image/jpeg\">\n";
      if ($isStandardSize) {
        $ogImgTags .= "  <meta property=\"og:image:width\"      content=\"1200\">\n"
                   .  "  <meta property=\"og:image:height\"     content=\"630\">\n";
      }
      $twitterImgTags = "  <meta name=\"twitter:image\"     content=\"{$img}\">\n"
                      . "  <meta name=\"twitter:image:src\" content=\"{$img}\">\n"
                      . "  <meta name=\"twitter:image:alt\" content=\"{$t}\">\n";
    }

    $html = <<<HTML
<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="utf-8">
  <title>{$t}</title>

  <!-- Open Graph -->
  <meta property="og:site_name"   content="{$s}">
  <meta property="og:type"        content="article">
  <meta property="og:title"       content="{$t}">
  <meta property="og:description" content="{$d}">
  <meta property="og:url"         content="{$u}">
{$ogImgTags}
  <!-- Twitter / X Card -->
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:url"         content="{$twitterUrl}">
  <meta name="twitter:domain"      content="{$twitterDomain}">
  <meta name="twitter:title"       content="{$t}">
  <meta name="twitter:description" content="{$d}">
{$twitterImgTags}
  <!-- Redirect real browsers to the Angular app (JS only — no noscript meta-refresh:
       social bots do NOT run JS but many follow meta-refresh, which would create a
       redirect loop back through .htaccess and break Twitter card scraping). -->
  <script>window.location.replace({$red});</script>
</head>
<body><p>Redirecting to <a href="{$u}">{$t}</a>&hellip;</p></body>
</html>
HTML;

    // Output HTML directly, bypassing WordPress's JSON response encoding.
    add_filter('rest_pre_serve_request', static function ($served) use ($html) {
      if (!$served) {
        status_header(200);
        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: public, max-age=300, s-maxage=300');
        header('X-Robots-Tag: noindex, nofollow, noarchive');
        header('Vary: User-Agent');
        echo $html; // phpcs:ignore WordPress.Security.EscapeOutput
      }
      return true;
    }, 99);

    return new WP_REST_Response(null, 200);
  }

  public function social_image_endpoint(WP_REST_Request $request): WP_REST_Response {
    $file = trim((string) ($request->get_param('file') ?? ''));
    if (!preg_match('/^dn-social-(?:resize|fallback|section)-[a-z0-9_-]+\.jpg$/', $file)) {
      return new WP_REST_Response(['error' => 'Invalid file'], 400);
    }

    $upload = wp_upload_dir();
    $path   = rtrim($upload['basedir'], '/') . '/' . $file;
    if (!file_exists($path) || !is_readable($path)) {
      return new WP_REST_Response(['error' => 'File not found'], 404);
    }

    add_filter('rest_pre_serve_request', static function ($served) use ($path) {
      if (!$served) {
        status_header(200);
        header('Content-Type: image/jpeg');
        header('Content-Length: ' . (string) filesize($path));
        header('Cache-Control: public, max-age=604800, s-maxage=604800');
        header('Accept-Ranges: bytes');
        readfile($path); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_read_readfile
      }
      return true;
    }, 99);

    return new WP_REST_Response(null, 200);
  }

  /**
   * Pre-warm the social thumbnail cache for all sections in the current dataset.
   *
    * Calling POST /wp-json/digital-newspaper/v1/warm-cache with a valid admin
    * token ensures every section's 1200x630 JPEG is already generated before
    * social bots visit. This endpoint is intentionally not called automatically
    * after saves because shared-host bot protection can block automation.
   *
   * Returns a JSON summary: { "processed": N, "skipped": N, "errors": N }
   */
  public function warm_social_cache(WP_REST_Request $request): WP_REST_Response {
    if (!extension_loaded('gd') || !function_exists('imagecreatetruecolor')) {
      return new WP_REST_Response(['error' => 'PHP GD extension not available'], 503);
    }

    $data     = $this->get_data();
    $settings = isset($data['settings']) && is_array($data['settings']) ? $data['settings'] : [];
    $logoUrl  = isset($settings['logo']['url']) ? trim((string) $settings['logo']['url']) : '';
    $wpBase   = rtrim(site_url(), '/');

    // Always pre-warm the homepage fallback image.
    $this->dn_fallback_social_image($logoUrl);

    $processed = 0;
    $skipped   = 0;
    $errors    = 0;

    $editions = isset($data['editions']) && is_array($data['editions']) ? $data['editions'] : [];
    foreach ($editions as $edition) {
      foreach (($edition['pages'] ?? []) as $page) {
        // Pre-warm the full-page scan image for this page.
        $pageImg = $this->dn_resolve_image((string) ($page['fullImage'] ?? ''), $wpBase);
        if ($pageImg !== '') {
          $upload    = wp_upload_dir();
          $cacheSlug = substr(md5($pageImg), 0, 12);
          $cachePath = $upload['basedir'] . '/dn-social-resize-' . $cacheSlug . '.jpg';
          if (file_exists($cachePath)) {
            $skipped++;
          } else {
            $result = $this->dn_resize_for_social($pageImg);
            if (strpos($result, '/dn-social-') !== false) {
              $processed++;
            } else {
              $errors++;
            }
          }
        }

        // Pre-warm each section's image.
        foreach (($page['sections'] ?? []) as $sec) {
          $rawImg = trim((string) ($sec['imageUrl'] ?? ''));
          if ($rawImg === '') {
            // If no dedicated section image exists, generate a section crop
            // from the page scan and then pre-warm the 1200x630 social size.
            $cropUrl = $this->dn_crop_section_from_page($pageImg, $sec);
            if ($cropUrl === '') {
              continue;
            }
            $imageUrl = $cropUrl;
          } else {
            $imageUrl = $this->dn_resolve_image($rawImg, $wpBase);
          }
          if ($imageUrl === '') continue;

          $upload    = wp_upload_dir();
          $cacheSlug = substr(md5($imageUrl), 0, 12);
          $cachePath = $upload['basedir'] . '/dn-social-resize-' . $cacheSlug . '.jpg';
          if (file_exists($cachePath)) {
            $skipped++;
            continue;
          }

          $result = $this->dn_resize_for_social($imageUrl);
          if (strpos($result, '/dn-social-') !== false) {
            $processed++;
          } else {
            $errors++;
          }
        }
      }
    }

    return new WP_REST_Response([
      'processed' => $processed,
      'skipped'   => $skipped,
      'errors'    => $errors,
    ], 200);
  }

  /**
   * Generate (once) a 1200×630 JPEG social-sharing image: light grey background
   * (#F0F0F0) with the site logo centred.  Result is cached in wp-content/uploads/
   * and keyed on the logo URL so it regenerates automatically if the logo changes.
   *
   * At ~30–60 KB this image is accepted by Facebook (≥ 200 px) AND WhatsApp (≤ 300 KB).
   * Requires PHP GD; returns '' if GD is not loaded on the server.
   */
  private function dn_fallback_social_image(string $logoUrl): string {
    if (!extension_loaded('gd') || !function_exists('imagecreatetruecolor')) {
      return ''; // PHP GD not available — caller falls back to section images.
    }

    $upload   = wp_upload_dir();
    $slug     = $logoUrl !== '' ? substr(md5($logoUrl), 0, 8) : 'nologo';
    $filename = "dn-social-fallback-{$slug}.jpg";
    $path     = $upload['basedir'] . '/' . $filename;
    $url      = $upload['baseurl'] . '/' . $filename;

    if (file_exists($path)) {
      return $url; // Serve cached version.
    }

    // --- Canvas: 1200 × 630, light grey background (#F0F0F0) ---
    $w      = 1200;
    $h      = 630;
    $canvas = imagecreatetruecolor($w, $h);
    $bg     = imagecolorallocate($canvas, 240, 240, 240);
    imagefill($canvas, 0, 0, $bg);

    // --- Centre the logo, preserving PNG transparency ---
    if ($logoUrl !== '') {
      $resp = wp_remote_get($logoUrl, ['timeout' => 10, 'sslverify' => true]);
      if (!is_wp_error($resp)) {
        $logo = @imagecreatefromstring(wp_remote_retrieve_body($resp));
        if ($logo !== false) {
          imagealphablending($logo, true); // composite alpha onto grey background
          $lw    = imagesx($logo);
          $lh    = imagesy($logo);
          // Scale to fit inside 60 % of canvas; never upscale a small logo.
          $scale = min(($w * 0.60) / $lw, ($h * 0.60) / $lh, 1.0);
          $nw    = (int) round($lw * $scale);
          $nh    = (int) round($lh * $scale);
          $dx    = (int) round(($w - $nw) / 2);
          $dy    = (int) round(($h - $nh) / 2);
          imagecopyresampled($canvas, $logo, $dx, $dy, 0, 0, $nw, $nh, $lw, $lh);
          imagedestroy($logo);
        }
      }
    }

    // Save at JPEG quality 85 → ~30–60 KB.
    imagejpeg($canvas, $path, 85);
    imagedestroy($canvas);

    return file_exists($path) ? $url : '';
  }

  /**
   * Resize (and letterbox) any image URL to a 1200×630 JPEG suitable for
   * social-media OG / Twitter cards.  The result is cached in wp-content/uploads/
   * keyed on md5($imageUrl) so repeated bot hits are served from disk.
   *
   * Letterbox strategy: the source is scaled to fit inside 1200×630 while
   * preserving its aspect ratio; the remaining area is filled with #F0F0F0 grey.
   * This avoids cropping newspaper article images that may be portrait or landscape.
   *
   * Returns the cached public URL, or the original $imageUrl if GD is unavailable
   * or the fetch fails (no regression — caller always gets a usable URL).
   */
  private function dn_resize_for_social(string $imageUrl): string {
    if ($imageUrl === '' || !extension_loaded('gd') || !function_exists('imagecreatetruecolor')) {
      return $imageUrl; // GD not available — caller uses original URL as-is.
    }

    $tw       = 1200;
    $th       = 630;
    $upload   = wp_upload_dir();
    $slug     = substr(md5($imageUrl), 0, 12);
    $filename = "dn-social-resize-{$slug}.jpg";
    $path     = $upload['basedir'] . '/' . $filename;
    $url      = $upload['baseurl'] . '/' . $filename;

    if (file_exists($path)) {
      return $url; // Serve cached version.
    }

    // Read source image: prefer direct disk access (milliseconds) over HTTP
    // (can be 2–10 s on a shared server, long enough to timeout WhatsApp's bot).
    $localPath = $this->dn_uploads_url_to_path($imageUrl);
    if ($localPath !== '' && file_exists($localPath)) {
      $body = @file_get_contents($localPath);
    } else {
      $resp = wp_remote_get($imageUrl, ['timeout' => 10, 'sslverify' => true]);
      if (is_wp_error($resp)) return $imageUrl;
      $body = wp_remote_retrieve_body($resp);
    }
    if ($body === false || $body === '') return $imageUrl;

    $src = @imagecreatefromstring($body);
    if ($src === false) {
      return $imageUrl;
    }

    // Create 1200×630 canvas with light grey background.
    $canvas = imagecreatetruecolor($tw, $th);
    $bg     = imagecolorallocate($canvas, 240, 240, 240);
    imagefill($canvas, 0, 0, $bg);

    // Scale source to fit inside canvas preserving aspect ratio (letterbox).
    $sw    = imagesx($src);
    $sh    = imagesy($src);
    $scale = min($tw / $sw, $th / $sh);
    $nw    = (int) round($sw * $scale);
    $nh    = (int) round($sh * $scale);
    $dx    = (int) round(($tw - $nw) / 2);
    $dy    = (int) round(($th - $nh) / 2);

    imagealphablending($src, true); // Composite PNG alpha onto grey background.
    imagecopyresampled($canvas, $src, $dx, $dy, 0, 0, $nw, $nh, $sw, $sh);
    imagedestroy($src);

    imagejpeg($canvas, $path, 85);
    imagedestroy($canvas);

    return file_exists($path) ? $url : $imageUrl;
  }

  /**
   * Crop a section rectangle from the full-page image based on percentage
   * coordinates, then return a cached URL to the cropped JPEG.
   * Returns empty string if cropping cannot be completed.
   */
  private function dn_crop_section_from_page(string $pageImageUrl, array $section): string {
    if ($pageImageUrl === '' || !extension_loaded('gd') || !function_exists('imagecreatetruecolor')) {
      return '';
    }

    $xPct = (float) ($section['x'] ?? 0);
    $yPct = (float) ($section['y'] ?? 0);
    $wPct = (float) ($section['width'] ?? 0);
    $hPct = (float) ($section['height'] ?? 0);

    if ($wPct <= 0 || $hPct <= 0) {
      return '';
    }

    $upload = wp_upload_dir();
    $idPart = preg_replace('/[^a-zA-Z0-9_-]/', '-', (string) ($section['id'] ?? 'unknown'));
    $cacheKey = substr(md5($pageImageUrl . '|' . $xPct . '|' . $yPct . '|' . $wPct . '|' . $hPct), 0, 12);
    $filename = "dn-social-section-{$idPart}-{$cacheKey}.jpg";
    $path = $upload['basedir'] . '/' . $filename;
    $url  = $upload['baseurl'] . '/' . $filename;

    if (file_exists($path)) {
      return $url;
    }

    $localPath = $this->dn_uploads_url_to_path($pageImageUrl);
    if ($localPath !== '' && file_exists($localPath)) {
      $body = @file_get_contents($localPath);
    } else {
      $resp = wp_remote_get($pageImageUrl, ['timeout' => 10, 'sslverify' => true]);
      if (is_wp_error($resp)) return '';
      $body = wp_remote_retrieve_body($resp);
    }

    if ($body === false || $body === '') return '';

    $src = @imagecreatefromstring($body);
    if ($src === false) return '';

    $sw = imagesx($src);
    $sh = imagesy($src);
    if ($sw <= 0 || $sh <= 0) {
      imagedestroy($src);
      return '';
    }

    $cropX = (int) round(($xPct / 100) * $sw);
    $cropY = (int) round(($yPct / 100) * $sh);
    $cropW = (int) round(($wPct / 100) * $sw);
    $cropH = (int) round(($hPct / 100) * $sh);

    $cropX = max(0, min($cropX, $sw - 1));
    $cropY = max(0, min($cropY, $sh - 1));
    $cropW = max(1, min($cropW, $sw - $cropX));
    $cropH = max(1, min($cropH, $sh - $cropY));

    $crop = imagecreatetruecolor($cropW, $cropH);
    imagecopy($crop, $src, 0, 0, $cropX, $cropY, $cropW, $cropH);
    imagedestroy($src);

    imagejpeg($crop, $path, 90);
    imagedestroy($crop);

    return file_exists($path) ? $url : '';
  }

  /**
   * Map a wp-content/uploads URL to its local filesystem path for fast direct reads.
   * Returns '' if the URL does not belong to this site's uploads directory.
   *
   * Normalises http:// vs https:// before comparing so a scheme mismatch between
   * site_url() and wp_upload_dir()['baseurl'] doesn't silently fall back to HTTP.
   */
  private function dn_uploads_url_to_path(string $url): string {
    $upload   = wp_upload_dir();
    $baseUrl  = rtrim($upload['baseurl'], '/');
    // Strip scheme for comparison so http:// / https:// mismatches don't cause a miss.
    $cmpUrl  = (string) preg_replace('#^https?://#i', '', $url);
    $cmpBase = (string) preg_replace('#^https?://#i', '', $baseUrl);
    if (strpos($cmpUrl, $cmpBase) !== 0) {
      return '';
    }
    $relativePath = substr($cmpUrl, strlen($cmpBase));
    return rtrim($upload['basedir'], '/') . '/' . ltrim($relativePath, '/');
  }

  /**
   * Like dn_uploads_url_to_path but ignores the URL host entirely.
   * Compares only the path segment, so cross-domain aliases
   * (epaper.dailysangram.com ↔ nepaper.dailysangram.com) resolve to the same
   * local file. Safe because the resolved path is still validated against
   * the uploads basedir before any file is read.
   */
  private function dn_uploads_url_to_path_any_host(string $url): string {
    $upload    = wp_upload_dir();
    $baseUrl   = rtrim($upload['baseurl'], '/');
    // Strip scheme+host to get just the path
    $urlPath  = (string) preg_replace('#^https?://[^/]+#i', '', $url);
    $basePath = (string) preg_replace('#^https?://[^/]+#i', '', $baseUrl);
    if ($basePath === '' || strpos($urlPath, $basePath) !== 0) {
      return '';
    }
    $relativePath = substr($urlPath, strlen($basePath));
    return rtrim($upload['basedir'], '/') . '/' . ltrim($relativePath, '/');
  }

  private function dn_public_social_image_url(string $imageUrl): string {
    $imageUrl = trim($imageUrl);
    if ($imageUrl === '') {
      return '';
    }

    $filename = basename((string) parse_url($imageUrl, PHP_URL_PATH));
    if (!preg_match('/^dn-social-(?:resize|fallback|section)-[a-z0-9_-]+\.jpg$/', $filename)) {
      return $imageUrl;
    }

    $upload = wp_upload_dir();
    return trailingslashit($upload['baseurl']) . rawurlencode($filename);
  }

  /**
   * Match a route slug against section title/id with tolerant ID aliases.
   * Supports these equivalent forms: post-123, section-123, 123.
   */
  private function dn_matches_section_slug(string $slug, string $title, string $id): bool {
    $slug = trim($slug);
    $id   = trim($id);
    if ($slug === '') {
      return false;
    }

    if ($this->dn_create_slug($title, $id) === $slug || $id === $slug) {
      return true;
    }

    if (preg_match('/^(?:post|section)-(\d+)$/', $slug, $slugMatch)) {
      $slugNum = $slugMatch[1];
      if ($id === $slugNum || $id === 'post-' . $slugNum || $id === 'section-' . $slugNum) {
        return true;
      }
    }

    if (preg_match('/^(?:post|section)-(\d+)$/', $id, $idMatch)) {
      $idNum = $idMatch[1];
      if ($slug === $idNum || $slug === 'post-' . $idNum || $slug === 'section-' . $idNum) {
        return true;
      }
    }

    return false;
  }

  /**
   * Generate a slug from a section title, mirroring the TypeScript createSectionSlug().
   * Preserves Bengali Unicode (U+0980–U+09FF). PHP 7.4 compatible.
   */
  private function dn_create_slug(string $title, string $id): string {
    if ($title === '') return $id;
    $slug = mb_strtolower(trim($title), 'UTF-8');
    $slug = preg_replace('/\s+/u', '-', $slug);
    $slug = preg_replace('/[^\w\x{0980}-\x{09FF}-]/u', '', $slug);
    $slug = preg_replace('/-+/', '-', $slug);
    $slug = trim($slug, '-');
    return $slug !== '' ? $slug : $id;
  }

  /**
   * Resolve a relative image URL to absolute, mirroring Angular's resolveImageUrl().
   * Discards data: URLs (crawlers cannot fetch them). PHP 7.4 compatible.
   */
  private function dn_resolve_image(string $url, string $wpBase): string {
    $url = trim($url);
    if ($url === '' || strncmp($url, 'data:', 5) === 0) return '';
    if (strncmp($url, 'http://', 7) === 0 || strncmp($url, 'https://', 8) === 0) {
      // Normalize WordPress uploads absolute URLs to the current WP origin.
      // This fixes images after a domain migration: source_url saved with the
      // old domain is rewritten to the current site_url() host so OG images
      // still resolve without touching the database.
      if (strpos($url, '/wp-content/uploads/') !== false) {
        $parsed   = wp_parse_url(site_url());
        $wpOrigin = $parsed['scheme'] . '://' . $parsed['host'];
        if (preg_match('#^https?://[^/]+(/.*)$#s', $url, $m)) {
          return $wpOrigin . $m[1];
        }
      }
      return $url;
    }
    $base = rtrim($wpBase, '/');
    return strncmp($url, '/', 1) === 0 ? $base . $url : $base . '/' . $url;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INCREMENTAL / DATE-BASED READ ENDPOINTS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /digital-newspaper/v1/data/settings
   *
   * Returns only the GlobalSettings object from the stored data.
   * Settings change rarely (logo, theme, social links, contact info), so this
   * response is cached for 1 hour by the Angular HTTP cache interceptor and
   * by any CDN/LiteSpeed proxy in front of WordPress.
   *
   * ETag: '"dn-settings-{hash}"' — Angular sends If-None-Match for 304 responses.
   * No credentials required or expected (withCredentials = false on the client side).
   */
  public function get_settings_endpoint(WP_REST_Request $request): WP_REST_Response {
    // MEM-OPT: the granular helper may fall back to the dn_data blob when the
    // dn_settings option is missing.  Loading the blob can briefly need a few
    // hundred MB on large datasets — bump the limits up-front so the request
    // survives on shared hosting.  Both calls are silent no-ops if the host
    // has locked the limits via php.ini.
    @ini_set('memory_limit', '512M');
    @set_time_limit(60);

    $this->add_public_security_headers();

    if (!$this->check_public_get_rate_limit()) {
      header('Retry-After: 60');
      return new WP_REST_Response(['error' => 'Too many requests. Please wait and try again.'], 429);
    }

    // Use the granular dn_settings option when available (O(1) DB read).
    // Falls back to the full dn_data blob on a fresh install.
    $granular    = $this->get_settings_granular();
    $settings    = $granular['settings'];
    $dataVersion = $granular['dataVersion'];

    // Generate a deterministic ETag from the settings content.
    // The hash changes whenever settings are saved, triggering a fresh fetch.
    $etag = '"dn-settings-' . substr(md5(serialize($settings)), 0, 16) . '"';

    // Honour conditional GET: return 304 if the client's cached copy is current.
    $client_etag = isset($_SERVER['HTTP_IF_NONE_MATCH'])
                   ? trim((string) $_SERVER['HTTP_IF_NONE_MATCH'])
                   : '';
    if ($client_etag !== '' && $client_etag === $etag) {
      status_header(304);
      header('ETag: ' . $etag);
      header('Cache-Control: public, max-age=3600, s-maxage=3600');
      // WordPress REST dispatch requires a WP_REST_Response — return empty body.
      add_filter('rest_pre_serve_request', static function ($served) {
        if (!$served) {
          status_header(304);
          echo '';
        }
        return true;
      }, 99);
      return new WP_REST_Response(null, 304);
    }

    header('Cache-Control: public, max-age=3600, s-maxage=3600');
    header('ETag: ' . $etag);
    header('Vary: Origin');

    return rest_ensure_response([
      'settings'    => $settings,
      'dataVersion' => $dataVersion,
    ]);
  }

  /**
   * GET /digital-newspaper/v1/data/dates
   *
   * Returns the sorted list of edition dates that have at least one page,
   * plus the most recent date for convenience.  Payload is small (~1 KB for
   * 365 dates/year) so the Angular app can load it on startup.
   *
   * Cached for 5 minutes — a new edition is published at most once per day.
   */
  public function get_dates_endpoint(WP_REST_Request $request): WP_REST_Response {
    // MEM-OPT: the granular helper now augments the index with dates pulled
    // from the raw dn_data blob (regex scan, no deserialise — cheap), but
    // bump limits anyway in case a future code path triggers a full read.
    @ini_set('memory_limit', '512M');
    @set_time_limit(60);

    $this->add_public_security_headers();

    if (!$this->check_public_get_rate_limit()) {
      header('Retry-After: 60');
      return new WP_REST_Response(['error' => 'Too many requests. Please wait and try again.'], 429);
    }

    // Use the granular dn_data_index option when available (O(1) DB read).
    // Falls back to scanning all editions in the monolith blob.
    $granular   = $this->get_dates_granular();
    $dates      = $granular['dates'];
    $latestDate = $granular['latestDate'];

    header('Cache-Control: public, max-age=300, s-maxage=300');
    header('Vary: Origin');

    return rest_ensure_response([
      'dates'      => array_values($dates),
      'latestDate' => $latestDate,
    ]);
  }

  /**
   * GET /digital-newspaper/v1/data/editions/:date
   *
   * Returns all editions (one per edition number) for the given YYYY-MM-DD date.
   * The full page + section data is included so the Angular app can render
   * the newspaper without a separate request per page.
   *
   * Cache strategy:
   *   - Past dates  →  max-age=86400 (24 h): they are immutable after publication.
   *   - Today       →  max-age=300  (5 min): admin may still be adding content.
   *
   * ETag: '"dn-{date}-{short-hash}"'  where hash covers date + dataVersion.
   * Supports If-None-Match for 304 Not Modified responses.
   *
   * Returns 400 for invalid date format, 200 with empty editions[] for unknown dates.
   */
  public function get_edition_by_date_endpoint(WP_REST_Request $request): WP_REST_Response {
    // MEM-OPT: the granular helper falls back to loading + filtering the full
    // dn_data blob when the per-date option is missing.  Bump PHP limits so
    // that fallback doesn't fatal on shared hosting.  Both @-suppressed.
    @ini_set('memory_limit', '512M');
    @set_time_limit(60);

    $this->add_public_security_headers();

    if (!$this->check_public_get_rate_limit()) {
      header('Retry-After: 60');
      return new WP_REST_Response(['error' => 'Too many requests. Please wait and try again.'], 429);
    }

    $date = sanitize_text_field((string) ($request->get_param('date') ?? ''));

    // Double-check format (also validated by route args).
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
      return new WP_REST_Response(['error' => 'Invalid date format. Expected YYYY-MM-DD.'], 400);
    }

    // Use the granular dn_edition_{date} option when available (O(1) DB read).
    // Falls back to filtering the full dn_data blob when the index is stale.
    $granular      = $this->get_edition_for_date_granular($date);
    $date_editions = $granular['editions'];
    $dataVersion   = $granular['dataVersion'];

    // Build ETag from date + dataVersion (sufficient for cache invalidation).
    $etag = '"dn-' . $date . '-' . substr(md5($date . (string) $dataVersion), 0, 12) . '"';

    // Honour conditional GET.
    $client_etag = isset($_SERVER['HTTP_IF_NONE_MATCH'])
                   ? trim((string) $_SERVER['HTTP_IF_NONE_MATCH'])
                   : '';
    if ($client_etag !== '' && $client_etag === $etag) {
      add_filter('rest_pre_serve_request', static function ($served) use ($etag) {
        if (!$served) {
          status_header(304);
          header('ETag: ' . $etag);
          echo '';
        }
        return true;
      }, 99);
      return new WP_REST_Response(null, 304);
    }

    // Past dates are immutable after the day closes; cache them for 24 hours.
    // Today's date may still receive edits — we cannot let the browser hold a
    // stale copy for any window or the admin will appear to "lose" their saves
    // on refresh.  Force the browser to revalidate via ETag on every request
    // (response body is still served from cache if the ETag matches, so this
    // only costs a small conditional GET round-trip).
    $today  = gmdate('Y-m-d');
    if ($date < $today) {
      header('Cache-Control: public, max-age=86400, s-maxage=86400');
    } else {
      // no-cache = "must revalidate every time"; max-age=0 belt-and-braces
      // for HTTP/1.0 intermediaries.  must-revalidate forbids serving stale.
      header('Cache-Control: public, max-age=0, no-cache, must-revalidate');
    }
    header('ETag: ' . $etag);
    header('Last-Modified: ' . gmdate('D, d M Y H:i:s \G\M\T'));
    header('Vary: Origin');

    return rest_ensure_response([
      'date'        => $date,
      'editions'    => $date_editions,
      'dataVersion' => $dataVersion,
    ]);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  HEALTH ENDPOINT  (FP-5)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /digital-newspaper/v1/data/health
   *
   * Returns operational stats for monitoring and debugging. Admin-only.
   *
   * Response shape:
   * {
   *   pluginVersion:   string,      // from plugin header
   *   phpVersion:      string,
   *   wpVersion:       string,
   *   storageMode:     "granular"|"blob",
   *   dataVersion:     float,
   *   editionCount:    int,         // number of distinct dates
   *   totalPages:      int,         // sum of pages across all editions
   *   totalSections:   int,
   *   blobSizeKb:      float,       // size of dn_data option in KB
   *   lastBackupAt:    string|null, // ISO-8601 or null
   *   lastBackupBy:    string|null,
   *   migrationDone:   bool,        // whether the v2 storage migration ran
   * }
   */
  public function get_health_endpoint(WP_REST_Request $request): WP_REST_Response {
    // ── Storage mode ──────────────────────────────────────────────────────
    $migrated    = (bool) get_option(self::OPTION_MIGRATED_V2, false);
    $index       = get_option(self::OPTION_INDEX);
    $storageMode = ($migrated && is_array($index)) ? 'granular' : 'blob';

    // ── Edition / page / section counts ───────────────────────────────────
    $editionDates   = 0;
    $totalPages     = 0;
    $totalSections  = 0;
    $dataVersion    = 0.0;

    if ($storageMode === 'granular' && is_array($index)) {
      $dates       = (array) ($index['dates'] ?? []);
      $dataVersion = (float) ($index['dataVersion'] ?? 0.0);
      $editionDates = count($dates);
      foreach ($dates as $date) {
        $editions = get_option($this->edition_option_key((string)$date), []);
        if (!is_array($editions)) continue;
        foreach ($editions as $ed) {
          $pages = $ed['pages'] ?? [];
          $totalPages += count($pages);
          foreach ($pages as $page) {
            $totalSections += count($page['sections'] ?? []);
          }
        }
      }
    } else {
      // Fallback: read the blob directly (may be slow on large datasets)
      $blob        = get_option(self::OPTION_KEY, []);
      $dataVersion = is_array($blob) ? (float) ($blob['dataVersion'] ?? 0.0) : 0.0;
      $dates       = [];
      foreach (($blob['editions'] ?? []) as $ed) {
        $date = (string) ($ed['date'] ?? '');
        if ($date !== '') $dates[$date] = true;
        $pages = $ed['pages'] ?? [];
        $totalPages += count($pages);
        foreach ($pages as $page) {
          $totalSections += count($page['sections'] ?? []);
        }
      }
      $editionDates = count($dates);
    }

    // ── Blob size ──────────────────────────────────────────────────────────
    $blobRaw    = get_option(self::OPTION_KEY, '');
    $blobSizeKb = round(strlen(maybe_serialize($blobRaw)) / 1024, 1);

    // ── Last backup ────────────────────────────────────────────────────────
    $backups     = get_option(self::OPTION_BACKUPS, []);
    $lastBackupAt = null;
    $lastBackupBy = null;
    if (is_array($backups) && !empty($backups[0])) {
      $lastBackupAt = (string) ($backups[0]['createdAt'] ?? '');
      $lastBackupBy = (string) ($backups[0]['savedBy']   ?? '');
    }

    // ── Plugin version (from plugin header) ───────────────────────────────
    $pluginFile = plugin_dir_path(__FILE__) . 'digital-newspaper.php';
    $pluginData = function_exists('get_plugin_data')
                  ? get_plugin_data($pluginFile, false, false)
                  : [];
    $pluginVersion = (string) ($pluginData['Version'] ?? '1.x');

    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

    return rest_ensure_response([
      'pluginVersion' => $pluginVersion,
      'phpVersion'    => PHP_VERSION,
      'wpVersion'     => get_bloginfo('version'),
      'storageMode'   => $storageMode,
      'dataVersion'   => $dataVersion,
      'editionCount'  => $editionDates,
      'totalPages'    => $totalPages,
      'totalSections' => $totalSections,
      'blobSizeKb'    => $blobSizeKb,
      'lastBackupAt'  => $lastBackupAt ?: null,
      'lastBackupBy'  => $lastBackupBy ?: null,
      'migrationDone' => $migrated,
    ]);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  LEGACY MONOLITHIC ENDPOINT (backward-compatible; kept indefinitely)
  // ══════════════════════════════════════════════════════════════════════════

  public function get_data_endpoint(
    WP_REST_Request $request
  ): WP_REST_Response {
    // ── MEM-OPT: shared hosting (Hostinger, cPanel) often caps PHP at
    // 128–256 MB and 30 s.  Building the full data response with a 35 MB
    // blob can briefly need ~300–400 MB and 10–20 s.  Without these bumps
    // the endpoint dies with a PHP fatal which WordPress surfaces as the
    // generic "There has been a critical error on this website" JSON
    // (HTTP 500, code = internal_server_error).  Both calls are no-ops if
    // the host has locked the limits via php.ini and are safe to leave in.
    @ini_set('memory_limit', '512M');
    @set_time_limit(120);

    $this->add_public_security_headers();
    // Forbid any CDN or proxy from caching this endpoint — stale responses
    // would cause the Angular app to show old data after new editions are saved.
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');

    // Wrap in try/catch so any fatal/throwable returns a descriptive JSON
    // body the Angular app (and the browser network panel) can act on,
    // instead of WordPress's opaque "critical error" handler.
    try {
      return rest_ensure_response($this->load_full_dataset_for_legacy_endpoint());
    } catch (\Throwable $e) {
      error_log('[DigitalNewspaper] get_data_endpoint fatal: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
      return new WP_REST_Response([
        'error'   => 'internal_error',
        'message' => $e->getMessage(),
        'file'    => basename($e->getFile()),
        'line'    => $e->getLine(),
      ], 500);
    }
  }

  /**
   * Assemble the full NewspaperData payload for the legacy GET /data endpoint.
   *
   * Once granular storage v2 is active (dn_storage_migrated_v2 + a populated
   * dn_data_index), the legacy dn_data blob is no longer written on atomic
   * page/section saves, so reading it here would return stale data.  Build the
   * response live from the per-date options instead.  Each per-date option is
   * small (≤ a few MB), so we never need 30 MB of RAM in a single allocation.
   *
   * Falls back to the legacy blob when:
   *   • v2 migration hasn't run, OR
   *   • the index is empty (very old installs), OR
   *   • assembly throws.
   *
   * Domain normalisation is still applied so the response always speaks the
   * caller's origin.
   */
  private function load_full_dataset_for_legacy_endpoint(): array {
    $migrated = (bool) get_option(self::OPTION_MIGRATED_V2);
    $index    = get_option(self::OPTION_INDEX);
    $hasIndex = is_array($index) && !empty($index['dates']);

    if (!$migrated || !$hasIndex) {
      // Legacy / fresh-install path — keep the original behaviour.
      return $this->get_data();
    }

    try {
      $settings = get_option(self::OPTION_SETTINGS);
      if (!is_array($settings) || empty($settings)) {
        $settings = self::default_data()['settings'];
      }

      $editions = [];
      foreach ((array) $index['dates'] as $date) {
        if (!is_string($date) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
          continue;
        }
        $perDate = get_option($this->edition_option_key($date), []);
        if (!is_array($perDate)) {
          continue;
        }
        foreach ($perDate as $ed) {
          if (is_array($ed)) {
            $editions[] = $ed;
          }
        }
        unset($perDate); // free per-iteration to keep peak RAM low
      }

      $assembled = [
        'dataVersion' => (float) ($index['dataVersion'] ?? microtime(true)),
        'settings'    => $settings,
        'editions'    => $editions,
      ];

      // Apply the same domain-normalisation pass as the legacy reader so
      // hostname mismatches (epaper ↔ nepaper ↔ www) are corrected at the
      // response edge.  This is the only consumer of legacy GET /data, so a
      // single normalisation pass here is sufficient.
      $assembled = $this->normalize_domain_urls($assembled);

      return $assembled;
    } catch (\Throwable $e) {
      // Assembly failed — fall back to the legacy blob so the endpoint still
      // returns something usable.  The fatal is logged for diagnostics.
      error_log('[DigitalNewspaper] granular assembly failed, falling back to blob: ' . $e->getMessage());
      return $this->get_data();
    }
  }

  /**
   * GET /digital-newspaper/v1/data/version
   *
   * Returns only the current dataVersion float and nothing else.
   * Clients poll this every 30 s to detect remote changes without
   * transferring the full dataset on every poll tick.
   *
   * Response: { "dataVersion": 1717600012.345678 }
   */
  public function get_data_version_endpoint(WP_REST_Request $request): WP_REST_Response {
    $this->add_public_security_headers();
    // No caching: version probe is specifically used to detect changes.
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

    // ── PERF-2: Read dataVersion from the lightweight index option ────────
    // Previously this read the entire dn_data blob (potentially 30–50 MB) just
    // to extract one float.  This endpoint is polled every 30 s, so that was
    // causing a full blob deserialisation on every poll tick — a major source
    // of slow responses.  The dn_data_index option stores only the version float
    // and the list of date strings, so this read is O(1) and very fast.
    //
    // Fallback chain:
    //   1. dn_data_index['dataVersion']  — populated by granular storage
    //   2. dn_data['dataVersion']        — legacy blob (only if index missing)
    //   3. 0.0                           — nothing stored yet (fresh install)
    $dataVersion = 0.0;
    $index = get_option(self::OPTION_INDEX);
    if (is_array($index) && isset($index['dataVersion'])) {
      $dataVersion = (float) $index['dataVersion'];
    } else {
      // Index not populated yet — fall back to the blob but only read the
      // dataVersion key by loading the option (WordPress caches options in
      // wp_cache after the first read within a request).
      $data        = get_option(self::OPTION_KEY, []);
      $dataVersion = isset($data['dataVersion']) ? (float) $data['dataVersion'] : 0.0;
      unset($data); // free memory immediately
    }

    // ETag support so clients can use If-None-Match on version polls.
    $etag = '"dn-ver-' . $dataVersion . '"';
    header('ETag: ' . $etag);

    return rest_ensure_response([
      'dataVersion' => $dataVersion,
    ]);
  }

  public function list_data_backups_endpoint(WP_REST_Request $request): WP_REST_Response {
    $backups = $this->get_data_backups();
    $items = [];
    foreach ($backups as $index => $backup) {
      if (is_array($backup)) {
        $items[] = $this->backup_summary($backup, (int) $index);
      }
    }
    return rest_ensure_response(['backups' => $items]);
  }

  public function restore_data_backup_endpoint(WP_REST_Request $request): WP_REST_Response {
    $params = $request->get_json_params();
    $index = isset($params['index']) ? (int) $params['index'] : -1;
    $backups = $this->get_data_backups();

    $backup_entry = $backups[$index] ?? null;
    if ($index < 0 || !is_array($backup_entry)) {
      return new WP_REST_Response(['error' => 'Backup not found'], 404);
    }

    // Support three backup formats (newest to oldest):
    //   data_gz_serial — gzip of PHP-serialized string (low-memory format, current)
    //   data_gz        — gzip of JSON string (old format)
    //   data           — raw PHP array (oldest format)
    //   data_serial    — PHP-serialized string without gzip (zlib unavailable)
    $restore_data = null;
    if (!empty($backup_entry['data_gz_serial']) && function_exists('gzuncompress')) {
      $gz = base64_decode((string) $backup_entry['data_gz_serial'], true);
      if ($gz !== false) {
        $serial = @gzuncompress($gz);
        unset($gz);
        if ($serial !== false) {
          $restore_data = @unserialize($serial); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions
          unset($serial);
          if (!is_array($restore_data)) $restore_data = null;
        }
      }
    } elseif (!empty($backup_entry['data_serial'])) {
      $restore_data = @unserialize((string) $backup_entry['data_serial']); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions
      if (!is_array($restore_data)) $restore_data = null;
    } elseif (!empty($backup_entry['data_gz']) && function_exists('gzuncompress')) {
      $raw = base64_decode((string) $backup_entry['data_gz'], true);
      if ($raw !== false) {
        $uncompressed = @gzuncompress($raw);
        if ($uncompressed !== false) {
          $restore_data = json_decode($uncompressed, true);
        }
      }
    } elseif (is_array($backup_entry['data'] ?? null)) {
      $restore_data = $backup_entry['data'];
    }

    if (!is_array($restore_data)) {
      return new WP_REST_Response(['error' => 'Backup data is unavailable or corrupted'], 500);
    }

    $restore_user = wp_get_current_user();
    $restore_by   = ($restore_user && $restore_user->ID)
      ? ($restore_user->display_name ?: $restore_user->user_login)
      : 'unknown';
    $summary = $this->backup_summary($backup_entry, $index);

    // Free all backup data before save_data() — save_data() reloads backups
    // internally for the snapshot and we want maximum free RAM for that.
    unset($backups, $backup_entry);
    gc_collect_cycles();

    $this->save_data($restore_data, 'restore:' . $restore_by);  // version auto-stamped
    $this->log_auth_user_action('restore_backup', 'Restored backup #' . $index, ['backupIndex' => (string) $index, 'backupCreatedAt' => $summary['createdAt'] ?? '']);

    return rest_ensure_response([
      'success'  => true,
      'restored' => $summary,
    ]);
  }

  public function rebuild_data_from_sections_endpoint(WP_REST_Request $request): WP_REST_Response {
    // MEM-OPT: rebuilding from dn_section posts is the most RAM- and time-
    // intensive operation in the plugin.  Bump PHP limits up-front so the
    // request can actually complete on shared hosting.  Both are silent
    // no-ops if the host has locked them via php.ini.
    @ini_set('memory_limit', '1536M');
    @set_time_limit(600);

    // Install a shutdown handler so PHP fatals (OOM, max execution) are
    // captured to a known location even when the WP REST error handler
    // can't see them.  Read with /digital-newspaper/v1/diag/last-fatal.
    $fatalLogPath = WP_CONTENT_DIR . '/dn-last-fatal.log';
    register_shutdown_function(function() use ($fatalLogPath) {
      $err = error_get_last();
      if ($err && in_array($err['type'] ?? 0, [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR], true)) {
        @file_put_contents($fatalLogPath, json_encode([
          'when'    => gmdate('c'),
          'type'    => $err['type'],
          'message' => $err['message'],
          'file'    => $err['file'],
          'line'    => $err['line'],
          'peak_mb' => round(memory_get_peak_usage(true) / 1048576, 1),
        ], JSON_PRETTY_PRINT));
      }
    });

    try {
      // STEP 1 — Bulk untrash every dn_section post in ONE SQL UPDATE so the
      // posts are back to a queryable state before we touch anything else.
      $untrashed = $this->bulk_untrash_section_posts();

      // STEP 2 — Discover every distinct newspaper date from postmeta.
      $dates = $this->extract_dates_from_section_posts();
      if (empty($dates)) {
        return new WP_REST_Response([
          'error' => 'No mirrored section posts were found to rebuild from.',
        ], 404);
      }
      rsort($dates);

      // STEP 3 — Per-date rebuild + write to dn_edition_{date} option.
      //
      // We deliberately AVOID calling save_data() / write_per_date_storage()
      // with a full blob here.  That path:
      //   • snapshots the existing ~50MB blob into the backup rotation
      //     (read raw, gzip in-place = ~70MB of RAM)
      //   • re-serializes the whole rebuilt blob into wp_options (another
      //     ~50MB allocation + WP autoload hashing)
      //   • calls sync_section_posts_from_data() which then iterates
      //     every section calling wp_update_post()/wp_insert_post() and
      //     fires the long status-transition hook chain per row
      //
      // All three combine to OOM on shared hosting.  Instead we:
      //   • build each date's editions in isolation (RAM scoped per date)
      //   • write JUST the dn_edition_{date} option (small, autoload=no)
      //   • free the per-date payload before moving on
      //   • update the dn_data_index at the very end with the UNION of all
      //     dates (existing + newly recovered)
      $writtenDates  = [];
      $sectionCount  = 0;
      $pageCount     = 0;
      $editionCount  = 0;
      $perDateErrors = [];

      foreach ($dates as $date) {
        try {
          $editions = $this->build_date_editions_from_section_posts($date);
          if (empty($editions)) {
            continue;
          }
          // Count for the response BEFORE freeing the array.
          $editionCount += count($editions);
          foreach ($editions as $ed) {
            foreach (($ed['pages'] ?? []) as $page) {
              $pageCount++;
              $sectionCount += is_array($page['sections'] ?? null) ? count($page['sections']) : 0;
            }
          }

          // autoload=false — these can grow large and must NOT be loaded
          // on every WP request.
          update_option($this->edition_option_key($date), $editions, false);
          $writtenDates[] = $date;

          // Free per-date memory before the next iteration.
          unset($editions);
          gc_collect_cycles();
        } catch (\Throwable $perDateE) {
          $perDateErrors[$date] = $perDateE->getMessage();
          error_log('[DigitalNewspaper] rebuild per-date failure ' . $date . ': ' . $perDateE->getMessage());
        }
      }

      if (empty($writtenDates)) {
        return new WP_REST_Response([
          'error'  => 'Section posts exist but no editions could be rebuilt.',
          'errors' => $perDateErrors,
        ], 500);
      }

      // STEP 4 — Update dn_data_index as the UNION of existing dates and
      // every date we just rebuilt.  Never SHRINK the dates list.
      $existingIndex = get_option(self::OPTION_INDEX);
      $existingDates = is_array($existingIndex['dates'] ?? null) ? $existingIndex['dates'] : [];
      $unionDates    = array_values(array_unique(array_merge($existingDates, $writtenDates)));
      rsort($unionDates);
      update_option(self::OPTION_INDEX, [
        'dates'       => $unionDates,
        'dataVersion' => (float) microtime(true),
      ], false);

      // STEP 5 — Mark migration done so future loads use the granular path.
      if (!get_option(self::OPTION_MIGRATED_V2)) {
        update_option(self::OPTION_MIGRATED_V2, true);
      }

      $this->log_auth_user_action('rebuild_from_sections', 'Rebuilt data from section posts (incremental)', [
        'untrashed'    => (string) $untrashed,
        'editionCount' => (string) $editionCount,
        'pageCount'    => (string) $pageCount,
        'sectionCount' => (string) $sectionCount,
        'datesWritten' => (string) count($writtenDates),
      ]);

      return rest_ensure_response([
        'success'      => true,
        'mode'         => 'incremental',
        'untrashed'    => $untrashed,
        'editionCount' => $editionCount,
        'pageCount'    => $pageCount,
        'sectionCount' => $sectionCount,
        'datesWritten' => count($writtenDates),
        'dates'        => $writtenDates,
        'perDateErrors'=> $perDateErrors,
        'peak_mb'      => round(memory_get_peak_usage(true) / 1048576, 1),
      ]);
    } catch (\Throwable $e) {
      error_log('[DigitalNewspaper] rebuild_data_from_sections_endpoint fatal: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
      return new WP_REST_Response([
        'error'   => 'internal_error',
        'message' => $e->getMessage(),
        'file'    => basename($e->getFile()),
        'line'    => $e->getLine(),
        'peak_mb' => round(memory_get_peak_usage(true) / 1048576, 1),
      ], 500);
    }
  }

  /**
   * Returns the last PHP fatal captured by the rebuild endpoint's shutdown
   * handler.  Useful for surfacing OOM/timeout errors that never reach the
   * WP REST response pipeline.
   */
  public function diag_last_fatal_endpoint(WP_REST_Request $request): WP_REST_Response {
    $path = WP_CONTENT_DIR . '/dn-last-fatal.log';
    if (!file_exists($path)) {
      return rest_ensure_response([
        'hasFatal' => false,
        'message'  => 'No captured fatal error.',
        'path'     => $path,
      ]);
    }
    $raw = @file_get_contents($path);
    $parsed = json_decode((string) $raw, true);
    return rest_ensure_response([
      'hasFatal' => true,
      'path'     => $path,
      'mtime'    => gmdate('c', (int) @filemtime($path)),
      'data'     => is_array($parsed) ? $parsed : null,
      'raw'      => is_array($parsed) ? null : $raw,
    ]);
  }

  /**
   * Permission callback for /diag/* endpoints.  Accepts EITHER:
   *   (a) a valid JWT Bearer token belonging to an Administrator, OR
   *   (b) a currently-logged-in WordPress administrator (cookie auth) —
   *       so the diag URLs are usable directly from a browser tab while
   *       logged into wp-admin.
   *
   * GET-only and read-only, so cookie auth without nonce is acceptable
   * here; the response surface is restricted to debug metadata.
   */
  public function diag_permission_callback(WP_REST_Request $request) {
    // Path (a): try JWT.
    $jwt = $this->admin_required($request);
    if ($jwt === true) {
      return true;
    }
    // Path (b): cookie-authenticated WP administrator.
    if (is_user_logged_in() && current_user_can('manage_options')) {
      return true;
    }
    return $jwt instanceof WP_Error ? $jwt : new WP_Error('dn_unauthorized', 'Administrator access required', ['status' => 401]);
  }

  /**
   * Plain (non-REST) HTTP handler for diagnostics, triggered by
   * `?dn_diag=NAME` on any WP URL.  Uses ordinary cookie-based
   * `current_user_can()` checks — no nonce/JWT required — so admins
   * can hit these URLs directly from a logged-in browser tab.
   *
   * Available NAME values:
   *   - last-fatal                     → mirror of /diag/last-fatal
   *   - sample-section[&date=…|&post_id=…]
   *   - scan-broken[&limit=N]
   *
   * Responds with JSON and exits.  Returns 403 for non-admins.
   */
  public function maybe_handle_diag_query(): void {
    if (!isset($_GET['dn_diag'])) {
      return;
    }
    // No nonce here because the admin is just opening URLs in their
    // browser; the response is read-only diagnostic data.
    if (!is_user_logged_in() || !current_user_can('manage_options')) {
      status_header(403);
      header('Content-Type: application/json; charset=utf-8');
      echo wp_json_encode([
        'error'   => 'forbidden',
        'message' => 'Administrator login required.  Open wp-admin in another tab first.',
      ]);
      exit;
    }

    $action = sanitize_key((string) $_GET['dn_diag']);

    // Build a fake REST request object so we can reuse the existing
    // endpoint methods without duplicating any logic.
    $fake = new WP_REST_Request('GET');
    foreach ($_GET as $k => $v) {
      if ($k === 'dn_diag') continue;
      if (is_string($v) || is_numeric($v)) {
        $fake->set_param($k, $v);
      }
    }

    $response = null;
    switch ($action) {
      case 'last-fatal':
        $response = $this->diag_last_fatal_endpoint($fake);
        break;
      case 'sample-section':
        $response = $this->diag_sample_section_endpoint($fake);
        break;
      case 'scan-broken':
        $response = $this->diag_scan_broken_endpoint($fake);
        break;
      default:
        status_header(404);
        header('Content-Type: application/json; charset=utf-8');
        echo wp_json_encode([
          'error' => 'unknown_action',
          'available' => ['last-fatal', 'sample-section', 'scan-broken'],
        ]);
        exit;
    }

    $status = ($response instanceof WP_REST_Response) ? (int) $response->get_status() : 200;
    $data   = ($response instanceof WP_REST_Response) ? $response->get_data() : $response;

    status_header($status > 0 ? $status : 200);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, max-age=0');
    echo wp_json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
  }

  /**
   * Robust decode of a `dn_section_payload` postmeta value.
   *
   * The payload was originally written via `wp_json_encode($section)` which
   * uses default json_encode flags (escapes unicode to \uXXXX).  In some
   * legacy paths the data may have been routed through a layer that strips
   * single backslashes (e.g. WP's wp_unslash in HTTP request handling),
   * leaving the stored bytes as `uXXXX` instead of `\uXXXX` — which makes
   * Bangla and other non-ASCII text decode to literal `u09AC...` strings.
   *
   * This helper:
   *   1. Tries straight json_decode first (the happy path).
   *   2. If that fails, tries with a wp_slash-style backslash repair before
   *      decoding (covers the unslashed case).
   *   3. Returns null if neither attempt yields a non-empty array, signalling
   *      the caller should fall back to post_title/post_content.
   *
   * @return array|null  Decoded payload array, or null if undecodable.
   */
  private function decode_section_payload(string $raw): ?array {
    if ($raw === '') {
      return null;
    }

    // Step 1 — eagerly repair stripped backslashes BEFORE decoding.
    // The corruption seen in production is wp_unslash() applied once to
    // wp_json_encode() output, which silently turned every `\uXXXX` into
    // `uXXXX`, every `\"` into `"`, every `\\` into `\`, every `\n` into
    // `n`, etc.  Some payloads remain valid JSON despite the damage (small
    // payloads with no inner quotes/newlines) — for those `json_decode()`
    // succeeds but inner string values still contain literal `uXXXX` runs.
    // Larger payloads with embedded HTML break decode entirely because
    // unescaped quotes / control chars made the JSON malformed.
    //
    // Strategy: ALWAYS repair `uXXXX` → `\uXXXX` first when there's a
    // telltale unslashed-unicode marker, then decode, then walk the
    // decoded array to recover any string values that still carry literal
    // `uXXXX` sequences (the case where the JSON wrapper was untouched
    // but inner data was already mangled upstream).
    $candidate = $raw;
    if (preg_match('/(?<!\\\\)u[0-9a-fA-F]{4}/', $candidate)) {
      $repaired = preg_replace('/(?<!\\\\)u([0-9a-fA-F]{4})/', '\\\\u$1', $candidate);
      if (is_string($repaired)) {
        $candidate = $repaired;
      }
    }

    // Path 1 — decode the (possibly repaired) bytes.
    $decoded = json_decode($candidate, true);
    if (is_array($decoded) && !empty($decoded)) {
      return $this->repair_unslashed_unicode_in_array($decoded);
    }

    // Path 2 — try the original bytes untouched (in case repair was wrong).
    if ($candidate !== $raw) {
      $decoded = json_decode($raw, true);
      if (is_array($decoded) && !empty($decoded)) {
        return $this->repair_unslashed_unicode_in_array($decoded);
      }
    }

    // Path 3 — double-slashed (wp_slash applied twice on the way in).
    $stripped = stripslashes($raw);
    if ($stripped !== $raw) {
      $decoded = json_decode($stripped, true);
      if (is_array($decoded) && !empty($decoded)) {
        return $this->repair_unslashed_unicode_in_array($decoded);
      }
    }

    return null;
  }

  /**
   * Walk a decoded payload array and convert any literal `uXXXX` byte runs
   * inside string values back to their UTF-8 characters.  This handles the
   * case where the JSON structure decoded cleanly but inner strings were
   * already mangled before encoding.  Runs are matched greedily so the
   * common Bangla title form `u09a8u09c7...` collapses in one pass.
   *
   * Operates in-place style by returning the rebuilt array.
   *
   * @param array $arr  Decoded payload (any depth).
   * @return array      Same shape, with strings repaired.
   */
  private function repair_unslashed_unicode_in_array(array $arr): array {
    foreach ($arr as $k => $v) {
      if (is_array($v)) {
        $arr[$k] = $this->repair_unslashed_unicode_in_array($v);
      } elseif (is_string($v) && $v !== '' && preg_match('/u[0-9a-fA-F]{4}/', $v)) {
        $arr[$k] = $this->repair_unslashed_unicode_in_string($v);
      }
    }
    return $arr;
  }

  /**
   * Convert standalone `uXXXX` runs in $s into their UTF-8 characters.
   * Only matches sequences that look like dropped-backslash JSON escapes —
   * a `u` followed by exactly 4 hex digits, NOT preceded by a backslash
   * (those decoded already) and NOT a substring of a longer hex identifier.
   * Falls back to the input on mb_convert failure.
   */
  private function repair_unslashed_unicode_in_string(string $s): string {
    // Replace each bare `uXXXX` (not preceded by \) with its UTF-8 character.
    // Processes codepoints individually so consecutive runs like `u0986u0987u09a8`
    // are all converted.  The previous greedy `+`-group approach had a
    // `(?<![0-9a-zA-Z])` lookbehind that blocked matching whenever `u` directly
    // followed a hex digit from the prior codepoint — leaving all but the first
    // unconverted.  The simpler per-codepoint pattern below avoids that pitfall.
    $out = preg_replace_callback(
      '/(?<!\\\\)u([0-9a-fA-F]{4})/',
      static function (array $m): string {
        $bytes = pack('n', hexdec($m[1]));  // UCS-2BE
        $utf8  = @mb_convert_encoding($bytes, 'UTF-8', 'UCS-2BE');
        return is_string($utf8) && $utf8 !== '' ? $utf8 : $m[0];
      },
      $s
    );
    return is_string($out) ? $out : $s;
  }


  /**
   * GET /digital-newspaper/v1/diag/sample-section
   *
   * Query params (one of):
   *   - post_id=NNN              → inspect a specific dn_section post.
   *   - date=YYYY-MM-DD          → latest post for the given date (no status filter).
   *   - (none, "any" or "*")     → latest dn_section post in the DB.
   *
   * Returns raw stored bytes (length, preview, hex lead, UTF-8 validity)
   * for the section payload, post_title and post_content so we can diagnose
   * encoding issues without server log access.  Admin-only.
   */
  public function diag_sample_section_endpoint(WP_REST_Request $request): WP_REST_Response {
    global $wpdb;
    $explicitId = (int) $request->get_param('post_id');
    $dateParam  = sanitize_text_field((string) $request->get_param('date'));

    $postId = 0;
    $resolvedDate = '';

    if ($explicitId > 0) {
      $postId = $explicitId;
      $resolvedDate = (string) get_post_meta($postId, 'dn_newspaper_date', true);
    } elseif ($dateParam !== '' && $dateParam !== 'any' && $dateParam !== '*') {
      if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateParam)) {
        return new WP_REST_Response(['error' => 'Invalid date. Expected YYYY-MM-DD, "any", or omit param.'], 400);
      }
      $postIds = $wpdb->get_col($wpdb->prepare(
        "SELECT p.ID FROM {$wpdb->posts} p
           INNER JOIN {$wpdb->postmeta} m ON m.post_id = p.ID
          WHERE p.post_type = %s
            AND m.meta_key = %s
            AND m.meta_value = %s
          ORDER BY p.post_modified DESC
          LIMIT 1",
        self::SECTION_POST_TYPE,
        'dn_newspaper_date',
        $dateParam
      ));
      $postId = !empty($postIds) ? (int) $postIds[0] : 0;
      $resolvedDate = $dateParam;
    } else {
      // No filter: pick the most recently modified dn_section post regardless of status.
      $postIds = $wpdb->get_col($wpdb->prepare(
        "SELECT ID FROM {$wpdb->posts}
          WHERE post_type = %s
          ORDER BY post_modified DESC
          LIMIT 1",
        self::SECTION_POST_TYPE
      ));
      $postId = !empty($postIds) ? (int) $postIds[0] : 0;
      $resolvedDate = $postId > 0 ? (string) get_post_meta($postId, 'dn_newspaper_date', true) : '';
    }

    if ($postId <= 0) {
      // List a few candidate dates so the caller can retry.
      $candidateDates = $wpdb->get_col($wpdb->prepare(
        "SELECT DISTINCT meta_value FROM {$wpdb->postmeta} WHERE meta_key = %s ORDER BY meta_value DESC LIMIT 10",
        'dn_newspaper_date'
      ));
      return new WP_REST_Response([
        'error'           => 'No section posts found for the given selector.',
        'date_requested'  => $dateParam,
        'post_id_requested' => $explicitId,
        'candidate_dates' => is_array($candidateDates) ? $candidateDates : [],
      ], 404);
    }

    $payloadRaw = (string) $wpdb->get_var($wpdb->prepare(
      "SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key = %s LIMIT 1",
      $postId,
      'dn_section_payload'
    ));
    $titleRaw = (string) $wpdb->get_var($wpdb->prepare(
      "SELECT post_title FROM {$wpdb->posts} WHERE ID = %d",
      $postId
    ));
    $contentRaw = (string) $wpdb->get_var($wpdb->prepare(
      "SELECT post_content FROM {$wpdb->posts} WHERE ID = %d",
      $postId
    ));

    // Charset info for the wpdb connection + relevant tables.
    $dbCharset = $wpdb->get_var("SELECT @@character_set_database");
    $connCharset = $wpdb->get_var("SELECT @@character_set_connection");
    $postsCharset = $wpdb->get_var("SHOW CREATE TABLE {$wpdb->posts}", 1);
    $metaCharset  = $wpdb->get_var("SHOW CREATE TABLE {$wpdb->postmeta}", 1);

    $sample = function (string $s): array {
      $hexLead = substr($s, 0, 60);
      return [
        'length'    => strlen($s),
        'preview'   => mb_substr($s, 0, 200, 'UTF-8'),
        'hex_lead'  => bin2hex($hexLead),
        'utf8_valid'=> mb_check_encoding($s, 'UTF-8'),
        // Cheap heuristic flags so the caller can spot common corruption forms.
        'looks_like_unslashed_unicode' => (bool) preg_match('/(?<!\\\\)u[0-9a-fA-F]{4}/', $s),
        'looks_like_mojibake'          => $this->looks_like_mojibake($s),
        'contains_devanagari_unicode'  => (bool) preg_match('/\\\\u09[0-9a-fA-F]{2}/', $s), // Bangla codepoints
      ];
    };

    $decoded = $this->decode_section_payload($payloadRaw);

    // If decode failed, gather json_last_error details on the RAW bytes so
    // we can pinpoint the exact byte offset and surrounding context.  This
    // is independent of decode_section_payload() and only runs when the
    // caller needs to debug a still-broken payload.
    $decodeError = null;
    if (!is_array($decoded) && $payloadRaw !== '') {
      @json_decode($payloadRaw, true);
      $msg = function_exists('json_last_error_msg') ? json_last_error_msg() : null;
      $errCode = json_last_error();
      // Try to extract a byte offset from the message ("at offset N").
      $offset = null;
      if (is_string($msg) && preg_match('/offset\s+(\d+)/i', $msg, $m)) {
        $offset = (int) $m[1];
      }
      $window = null;
      if ($offset !== null) {
        $from = max(0, $offset - 80);
        $window = [
          'start'    => $from,
          'snippet'  => substr($payloadRaw, $from, 160),
          'hex'      => bin2hex(substr($payloadRaw, $from, 160)),
        ];
      }
      $decodeError = [
        'code'    => $errCode,
        'message' => $msg,
        'offset'  => $offset,
        'window'  => $window,
      ];
    }

    return rest_ensure_response([
      'postId'              => $postId,
      'date'                => $resolvedDate,
      'db_charset'          => $dbCharset,
      'connection_charset'  => $connCharset,
      'posts_table_ddl_tail'=> is_string($postsCharset) ? substr($postsCharset, -120) : null,
      'meta_table_ddl_tail' => is_string($metaCharset)  ? substr($metaCharset,  -120) : null,
      'payload'             => $sample($payloadRaw),
      'post_title'          => $sample($titleRaw),
      'post_content'        => $sample($contentRaw),
      'decoded_payload_ok'  => is_array($decoded),
      'decode_error'        => $decodeError,
      'decoded_title'       => is_array($decoded) ? ($decoded['title'] ?? null) : null,
      'decoded_content_head'=> is_array($decoded) && is_string($decoded['content'] ?? null)
                              ? mb_substr($decoded['content'], 0, 200, 'UTF-8') : null,
    ]);
  }

  /**
   * Heuristic: returns true if the string looks like mojibake — UTF-8 bytes
   * that were misinterpreted as latin1 (or similar single-byte encoding)
   * and re-encoded to UTF-8.  The telltale is a sequence like Ã + ASCII or
   * â<U+0080><U+0099> patterns.  Used by the diag endpoints.
   */
  private function looks_like_mojibake(string $s): bool {
    if ($s === '') return false;
    // Classic UTF-8-as-Latin1 mojibake: Ã with high-bit follower, or â\u0080…
    if (preg_match('/Ã[\x80-\xBF]/', $s)) return true;
    if (preg_match('/â\x80[\x90-\xA9]/', $s)) return true;
    // Bangla often shows up as à¦ / à§ sequences when mojibakeified.
    if (preg_match('/à[¦§]/u', $s)) return true;
    return false;
  }

  /**
   * GET /digital-newspaper/v1/diag/scan-broken?limit=20
   *
   * Walks every `dn_section` post, computes whether its payload or content
   * is likely broken (invalid UTF-8, mojibake, stripped backslashes,
   * undecodable payload), and returns the first $limit matches.  Lets us
   * find broken posts without having to guess dates.  Admin-only.
   */
  public function diag_scan_broken_endpoint(WP_REST_Request $request): WP_REST_Response {
    @ini_set('memory_limit', '512M');
    @set_time_limit(120);

    global $wpdb;
    $limit = max(1, min(200, (int) $request->get_param('limit') ?: 20));

    $rows = $wpdb->get_results($wpdb->prepare(
      "SELECT p.ID, p.post_title, p.post_modified, m1.meta_value AS dn_date
         FROM {$wpdb->posts} p
         LEFT JOIN {$wpdb->postmeta} m1
                ON m1.post_id = p.ID AND m1.meta_key = %s
        WHERE p.post_type = %s
        ORDER BY p.post_modified DESC",
      'dn_newspaper_date',
      self::SECTION_POST_TYPE
    ));

    if (empty($rows)) {
      return rest_ensure_response([
        'scanned' => 0,
        'broken'  => [],
        'message' => 'No dn_section posts found.',
      ]);
    }

    $broken = [];
    $scanned = 0;
    foreach ($rows as $row) {
      $scanned++;
      $postId = (int) $row->ID;
      $payload = (string) $wpdb->get_var($wpdb->prepare(
        "SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key = %s LIMIT 1",
        $postId,
        'dn_section_payload'
      ));

      $flags = [];
      if ($payload === '') {
        $flags[] = 'empty_payload';
      } else {
        $decoded = $this->decode_section_payload($payload);
        if (!is_array($decoded)) {
          $flags[] = 'undecodable_payload';
        } else {
          $title = (string) ($decoded['title']   ?? '');
          $body  = (string) ($decoded['content'] ?? '');
          if ($title !== '' && !mb_check_encoding($title, 'UTF-8')) $flags[] = 'title_not_utf8';
          if ($body  !== '' && !mb_check_encoding($body,  'UTF-8')) $flags[] = 'content_not_utf8';
          if ($title !== '' && $this->looks_like_mojibake($title)) $flags[] = 'title_mojibake';
          if ($body  !== '' && $this->looks_like_mojibake($body))  $flags[] = 'content_mojibake';
          if ($title !== '' && preg_match('/(?<!\\\\)u[0-9a-fA-F]{4}/', $title)) $flags[] = 'title_unslashed_unicode';
          if ($body  !== '' && preg_match('/(?<!\\\\)u[0-9a-fA-F]{4}/', $body))  $flags[] = 'content_unslashed_unicode';
        }
        if (!mb_check_encoding($payload, 'UTF-8')) $flags[] = 'payload_not_utf8';
      }

      if (!empty($flags)) {
        $broken[] = [
          'postId'       => $postId,
          'date'         => (string) $row->dn_date,
          'modified'     => $row->post_modified,
          'title'        => mb_substr((string) $row->post_title, 0, 80, 'UTF-8'),
          'flags'        => $flags,
          'payload_head' => mb_substr($payload, 0, 120, 'UTF-8'),
          'hex_lead'     => bin2hex(substr($payload, 0, 40)),
        ];
        if (count($broken) >= $limit) {
          break;
        }
      }
    }

    return rest_ensure_response([
      'scanned'    => $scanned,
      'broken'     => $broken,
      'broken_count_so_far' => count($broken),
      'limit'      => $limit,
      'truncated'  => count($broken) >= $limit,
    ]);
  }

  /**
   * Bulk untrash every `dn_section` post via a single SQL UPDATE.  Used by
   * the recovery paths so a single REST request can resurrect hundreds of
   * sections without firing per-post hooks (which OOM on shared hosting).
   *
   * Returns the number of posts untrashed.
   */
  private function bulk_untrash_section_posts(): int {
    global $wpdb;

    // Restore previous post_status from _wp_trash_meta_status when present,
    // else default to 'publish'.  Using one UPDATE per branch keeps SQL
    // portable across MySQL / MariaDB versions.
    $postType = self::SECTION_POST_TYPE;

    // 1. Posts WITH a stored previous status: restore exactly that status.
    $restoredWithMeta = (int) $wpdb->query($wpdb->prepare(
      "UPDATE {$wpdb->posts} p
         INNER JOIN {$wpdb->postmeta} m
            ON m.post_id = p.ID
           AND m.meta_key = %s
          SET p.post_status = m.meta_value
        WHERE p.post_type = %s
          AND p.post_status = %s",
      '_wp_trash_meta_status',
      $postType,
      'trash'
    ));

    // 2. Posts WITHOUT stored previous status: default to 'publish'.
    $restoredDefault = (int) $wpdb->query($wpdb->prepare(
      "UPDATE {$wpdb->posts}
          SET post_status = %s
        WHERE post_type = %s
          AND post_status = %s",
      'publish',
      $postType,
      'trash'
    ));

    $total = $restoredWithMeta + $restoredDefault;

    if ($total > 0) {
      // Strip the trash markers so WP doesn't think these are still in trash.
      $wpdb->query($wpdb->prepare(
        "DELETE m FROM {$wpdb->postmeta} m
           INNER JOIN {$wpdb->posts} p ON p.ID = m.post_id
          WHERE p.post_type = %s
            AND m.meta_key IN ('_wp_trash_meta_status', '_wp_trash_meta_time', '_wp_desired_post_slug')",
        $postType
      ));

      // Bust the WP object cache for posts so subsequent get_post() sees the
      // new status without us having to walk every ID.
      if (function_exists('wp_cache_set_last_changed')) {
        wp_cache_set_last_changed('posts');
      } else {
        wp_cache_set('last_changed', microtime(), 'posts');
      }
      error_log('[DigitalNewspaper] bulk_untrash_section_posts: restored ' . $total . ' post(s) (' . $restoredWithMeta . ' with prior status, ' . $restoredDefault . ' defaulted to publish).');
    }

    return $total;
  }

  private function build_data_from_section_posts(array $settings): array {
    // RECOVERY: include 'trash' in the query so that, even if the caller
    // hasn't run bulk_untrash_section_posts() yet, we still see and rebuild
    // from previously-trashed posts.  The endpoint above runs the bulk
    // untrash first so the in-memory $post->post_status values returned
    // here will normally already be 'publish' — but keep the trash filter
    // as a safety net for direct callers.
    //
    // Order by post_modified DESC so when duplicate posts exist for the same
    // section key the newest version wins during the dedup pass below.
    $posts = get_posts([
      'post_type'      => self::SECTION_POST_TYPE,
      'post_status'    => ['publish', 'draft', 'private', 'pending', 'trash'],
      'posts_per_page' => -1,
      'orderby'        => 'modified',
      'order'          => 'DESC',
      'no_found_rows'  => true,
    ]);

    // DEDUP across the full dataset: collapse duplicate section posts (same
    // _dn_section_key) keeping the most-recently-modified one.
    $seenSectionKeys = [];
    $editionMap = [];
    foreach ($posts as $post) {
      $date = sanitize_text_field((string) get_post_meta($post->ID, 'dn_newspaper_date', true));
      if ($date === '') continue;

      $sectionKey = (string) get_post_meta($post->ID, '_dn_section_key', true);
      if ($sectionKey === '') {
        $sectionKey = $date
          . ':' . max(1, (int) get_post_meta($post->ID, 'dn_edition_number', true))
          . ':' . max(1, (int) get_post_meta($post->ID, 'dn_page_id', true))
          . ':' . (string) get_post_meta($post->ID, 'dn_section_id', true);
      }
      if (isset($seenSectionKeys[$sectionKey])) {
        continue;
      }
      $seenSectionKeys[$sectionKey] = true;

      $editionNumber = max(1, (int) get_post_meta($post->ID, 'dn_edition_number', true));
      $pageId = max(1, (int) get_post_meta($post->ID, 'dn_page_id', true));
      $editionKey = $date . ':' . $editionNumber;
      $pageKey = (string) $pageId;

      if (!isset($editionMap[$editionKey])) {
        $editionLabels = json_decode((string) get_post_meta($post->ID, 'dn_edition_labels', true), true);
        $editionMap[$editionKey] = [
          'date' => $date,
          'edition' => $editionNumber,
          'editionLabels' => is_array($editionLabels) ? $editionLabels : [],
          '_pages' => [],
        ];
      }

      if (!isset($editionMap[$editionKey]['_pages'][$pageKey])) {
        $pageLabels = json_decode((string) get_post_meta($post->ID, 'dn_page_labels', true), true);
        $page = [
          'id' => $pageId,
          'thumbnail' => (string) get_post_meta($post->ID, 'dn_page_thumbnail', true),
          'fullImage' => (string) get_post_meta($post->ID, 'dn_page_full_image', true),
          'sections' => [],
          '_order' => (int) get_post_meta($post->ID, 'dn_page_order', true),
        ];
        $fullHiRes = (string) get_post_meta($post->ID, 'dn_page_full_hires', true);
        if ($fullHiRes !== '') {
          $page['fullImageHiRes'] = $fullHiRes;
        }
        if (is_array($pageLabels) && $pageLabels) {
          $page['pageLabels'] = $pageLabels;
        }
        $editionMap[$editionKey]['_pages'][$pageKey] = $page;
      }

      $payload = $this->decode_section_payload((string) get_post_meta($post->ID, 'dn_section_payload', true));
      if (!is_array($payload)) {
        $linkedSectionIds = json_decode((string) get_post_meta($post->ID, 'dn_linked_section_ids', true), true);
        $payload = [
          'id' => (string) get_post_meta($post->ID, 'dn_section_id', true),
          'title' => $post->post_title,
          'x' => (float) get_post_meta($post->ID, 'dn_crop_x', true),
          'y' => (float) get_post_meta($post->ID, 'dn_crop_y', true),
          'width' => (float) get_post_meta($post->ID, 'dn_crop_w', true),
          'height' => (float) get_post_meta($post->ID, 'dn_crop_h', true),
          'content' => $post->post_content,
          'imageUrl' => (string) get_post_meta($post->ID, 'dn_cropped_image_url', true),
          'pageId' => $pageId,
          'linkedSectionIds' => is_array($linkedSectionIds) ? $linkedSectionIds : [],
          'showCaption' => true,
        ];
        $lsp = (string) get_post_meta($post->ID, 'dn_linked_section_primary', true);
        if ($lsp !== '') $payload['linkedSectionPrimary'] = $lsp;
      }
      $payload['_order'] = (int) get_post_meta($post->ID, 'dn_section_order', true);
      $editionMap[$editionKey]['_pages'][$pageKey]['sections'][] = $payload;
    }

    $editions = array_values($editionMap);
    foreach ($editions as &$edition) {
      $pages = array_values($edition['_pages']);
      usort($pages, function ($a, $b) {
        $orderDiff = ((int) ($a['_order'] ?? 0)) <=> ((int) ($b['_order'] ?? 0));
        return $orderDiff !== 0 ? $orderDiff : ((int) ($a['id'] ?? 0)) <=> ((int) ($b['id'] ?? 0));
      });

      foreach ($pages as &$page) {
        usort($page['sections'], function ($a, $b) {
          return ((int) ($a['_order'] ?? 0)) <=> ((int) ($b['_order'] ?? 0));
        });
        foreach ($page['sections'] as &$section) {
          unset($section['_order']);
        }
        unset($page['_order']);
      }

      $edition['pages'] = $pages;
      unset($edition['_pages']);
      if (empty($edition['editionLabels'])) {
        unset($edition['editionLabels']);
      }
    }
    unset($edition);

    usort($editions, function ($a, $b) {
      $dateDiff = strcmp((string) ($b['date'] ?? ''), (string) ($a['date'] ?? ''));
      return $dateDiff !== 0 ? $dateDiff : ((int) ($a['edition'] ?? 1)) <=> ((int) ($b['edition'] ?? 1));
    });

    return [
      'settings' => $settings ?: self::default_data()['settings'],
      'editions' => $editions,
    ];
  }

  public function post_data_endpoint(
    WP_REST_Request $request
  ): WP_REST_Response {
    // Raise the PHP memory ceiling for this request.  The backup snapshot
    // loads all prior compressed snapshots and the section-sync iterates
    // every WordPress post, both of which are RAM-heavy for large newspapers.
    // The @ suppresses the warning on hosts that cap ini_set(); the gzip
    // compression below dramatically reduces actual peak usage regardless.
    @ini_set('memory_limit', '1536M');

    // Extend the PHP execution time limit.  On shared hosting the default is
    // often 30 s — far too short for a large newspaper with many editions.
    // The backup snapshot alone (read + gzip + write) can take 10-20 s, and
    // sync_section_posts_from_data() does O(editions × pages × sections) DB
    // writes on top.  300 s (5 min) is a safe ceiling; @ suppresses the
    // warning if the host has locked max_execution_time via php.ini.
    @set_time_limit(300);

    // Catch true PHP fatals (OOM, max-execution) that would otherwise return
    // the WordPress critical-error HTML page.  The try/catch below only
    // catches \Throwable; E_ERROR-class fatals bypass it entirely.
    $this->install_fatal_response_handler('POST /data');

    try {
      return $this->post_data_endpoint_inner($request);
    } catch (\Throwable $e) {
      error_log('[DigitalNewspaper] post_data_endpoint fatal: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
      return new WP_REST_Response([
        'error'   => 'internal_error',
        'message' => $e->getMessage(),
        'file'    => basename($e->getFile()),
        'line'    => $e->getLine(),
      ], 500);
    }
  }

  /**
   * Inner implementation of the POST /data endpoint.
   * Extracted so post_data_endpoint() can wrap it in a try/catch and
   * return a descriptive error body instead of a silent 500.
   */
  private function post_data_endpoint_inner(
    WP_REST_Request $request
  ): WP_REST_Response {
    global $wpdb;

    $payload = $request->get_json_params();
    if (!is_array($payload)) {
      return new WP_REST_Response(['error' => 'Invalid payload'], 400);
    }

    $force = $request->get_param('force') === '1' || $request->get_param('force') === 'true';

    // ── Guard 1: refuse to overwrite pages with an empty dataset ────────────
    // MEM-OPT: Instead of loading the full dn_data blob into PHP memory just
    // to count pages, check the dn_data_index (a tiny option with date counts)
    // first.  Only fall back to a full load when the index is absent (e.g.
    // migration has never run), and even then use a SQL LENGTH check to avoid
    // deserialising a 30–50 MB JSON blob.
    $incomingPageCount = $this->count_pages($payload);
    if (!$force && $incomingPageCount === 0) {
      // Is there real existing data?  Check the index first (fast path).
      $index = get_option(self::OPTION_INDEX);
      $hasExistingData = is_array($index) && !empty($index['dates']);

      if (!$hasExistingData) {
        // Index absent or empty (migration not yet run). Use a SQL SIZE check
        // to avoid loading the full blob — just check if the option is present
        // and has substantial content (> 200 bytes means it has real data).
        $blobLen = (int) $wpdb->get_var($wpdb->prepare(
          "SELECT LENGTH(option_value) FROM {$wpdb->options} WHERE option_name = %s",
          self::OPTION_KEY
        ));
        $hasExistingData = $blobLen > 200;
      }

      if ($hasExistingData) {
        return new WP_REST_Response([
          'error'              => 'Refusing to overwrite existing newspaper pages with an empty page dataset. Restore from backup or retry with force=1 if this is intentional.',
          'conflictType'       => 'empty-overwrite',
          'currentPageCount'   => -1, // unknown without loading blob
          'incomingPageCount'  => $incomingPageCount,
        ], 409);
      }
    }

    // ── Guard 2: optimistic-concurrency version check ────────────────────────
    // MEM-OPT: Read the dataVersion from the lightweight dn_data_index option
    // rather than deserialising the full dn_data blob (30–50 MB → 150 MB PHP
    // array).  Falls back to the blob only when the index is unavailable.
    //
    // Skip when:
    //   - ?force=1 is explicitly set (admin restore / force-save intent)
    //   - The incoming payload has no dataVersion (old client build)
    if (!$force && isset($payload['dataVersion'])) {
      $storedVersion = 0.0;

      // Fast path: read version from dn_data_index (tiny option).
      $index = get_option(self::OPTION_INDEX);
      if (is_array($index) && !empty($index['dataVersion'])) {
        $storedVersion = (float) $index['dataVersion'];
      } else {
        // Slow path: load the blob. This only runs if migration has never
        // completed — once the first save succeeds, dn_data_index is always
        // populated and this branch is never taken again.
        $blob = get_option(self::OPTION_KEY);
        if (is_array($blob) && !empty($blob['dataVersion'])) {
          $storedVersion = (float) $blob['dataVersion'];
        }
        unset($blob);
        gc_collect_cycles();
      }

      if ($storedVersion > 0.0) {
        $incomingVersion = (float) $payload['dataVersion'];

        // incomingVersion === 0 means the client is an old build that predates
        // the versioning feature and always sends dataVersion = 0.  Allow those
        // saves through — blocking them would make the admin permanently unusable
        // on legacy builds.  The version guard only fires for clients that have
        // actually received a real version token from the server.
        if ($incomingVersion > 0.0 && $incomingVersion < $storedVersion - 0.001) {
          $lastBackup  = get_option(self::OPTION_BACKUPS, []);
          $lastSavedBy = '';
          if (is_array($lastBackup) && !empty($lastBackup[0]['savedBy'])) {
            $lastSavedBy = (string) $lastBackup[0]['savedBy'];
          }
          unset($lastBackup);

          return new WP_REST_Response([
            'error'           => 'conflict',
            'conflictType'    => 'version-mismatch',
            'message'         => 'The newspaper data was saved by another user while you were editing. Your changes have not been lost — please reload to see the latest version, then re-apply your edits.',
            'lastSavedBy'     => $lastSavedBy,
            'storedVersion'   => $storedVersion,
            'incomingVersion' => $incomingVersion,
          ], 409);
        }
      }
    }

    // ── Guard 3: refuse to overwrite a populated dataset with a *much smaller*
    // ── one (shrinking-overwrite) ─────────────────────────────────────────
    // The granular endpoints can return a truncated date list if the per-date
    // options were partially migrated.  When that happened the admin would
    // edit just the recent dates, hit Save, and the trimmed payload would
    // silently wipe every older edition from dn_data.  This guard catches
    // that scenario at the server boundary so the data is never destroyed.
    //
    // Cheap detection: regex-extract distinct YYYY-MM-DD strings from the raw
    // dn_data option_value (no deserialise) and compare the count with the
    // incoming payload's distinct dates.  Block if the payload is missing
    // more than 5 dates.  Threshold of 5 allows normal deletions while still
    // catching catastrophic truncation.  ?force=1 bypasses this guard.
    if (!$force) {
      $incomingDates = [];
      foreach (($payload['editions'] ?? []) as $ed) {
        $d = (string) ($ed['date'] ?? '');
        if ($d !== '' && preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) {
          $incomingDates[$d] = true;
        }
      }
      $incomingDateCount = count($incomingDates);

      // Always check, even if incoming is empty (Guard 1 already covers the
      // truly-empty case, but for non-empty-but-shrunk we need this guard).
      // Union dates from every place data could live so the guard cannot be
      // bypassed by a previously-trimmed dn_data blob.
      $existingDates = array_values(array_unique(array_merge(
        $this->extract_dates_from_raw_blob(),
        $this->extract_dates_from_per_date_options(),
        $this->extract_dates_from_section_posts()
      )));
      $existingDateCount = count($existingDates);

      if ($existingDateCount > 0 && $incomingDateCount < $existingDateCount) {
        $missing = array_values(array_diff($existingDates, array_keys($incomingDates)));
        // Allow small reductions (≤ 5 dates) so legitimate edition deletions
        // still go through; block anything larger so accidental truncation
        // never destroys old editions silently.
        if (count($missing) > 5) {
          return new WP_REST_Response([
            'error'             => 'Refusing to overwrite ' . $existingDateCount . ' stored edition dates with only ' . $incomingDateCount . '. ' . count($missing) . ' dates would be lost. Retry with force=1 if this is intentional, or use the "Rebuild from sections" admin action to recover.',
            'conflictType'      => 'shrinking-overwrite',
            'currentDateCount'  => $existingDateCount,
            'incomingDateCount' => $incomingDateCount,
            'missingDates'      => array_slice($missing, 0, 25),
          ], 409);
        }
      }
    }

    // Identify the saving user for audit / snapshot
    $current_user = wp_get_current_user();
    $saved_by     = ($current_user && $current_user->ID)
      ? ($current_user->display_name ?: $current_user->user_login)
      : 'unknown';

    // Strip the export metadata envelope so it is never persisted in the
    // WordPress option.  The Angular app may accidentally send the full
    // ExportPayload (with a "meta" key) instead of a plain NewspaperData
    // object; removing it here keeps the stored structure clean.
    unset($payload['meta']);

    $save_result    = $this->save_data($payload, $saved_by);
    $sectionPostIds = $save_result['postIds'];
    $newVersion     = $save_result['newDataVersion'];

    // Activity log
    $this->log_auth_user_action('save_data', 'Saved newspaper data', [
      'editionCount'   => (string) (is_array($payload['editions'] ?? null) ? count($payload['editions']) : 0),
      'pageCount'      => (string) $this->count_pages($payload),
      'sectionCount'   => (string) $this->count_sections($payload),
      'newDataVersion' => (string) $newVersion,
    ]);

    return rest_ensure_response([
      'success'          => true,
      'message'          => 'Data saved successfully',
      'sectionPostIds'   => $sectionPostIds,
      'newDataVersion'   => $newVersion,
    ]);
  }

  // ── Atomic endpoint helpers ──────────────────────────────────────────────

  /**
   * Get the current user's display name for audit purposes.
   */
  private function current_user_display(): string {
    $u = wp_get_current_user();
    return ($u && $u->ID) ? ($u->display_name ?: $u->user_login) : 'unknown';
  }

  /**
   * Returns true if no lock exists for this resource, OR if the lock is held
   * by the currently authenticated user.  Returns false when another user
   * holds the lock — the caller should respond 423 Locked.
   *
   * Resource format: "{date}:{edition}:{pageId}"
   */
  private function lock_belongs_to_current_user(string $resource): bool {
    $lock = get_transient($this->lock_transient_key($resource));
    if (!$lock || !is_array($lock)) {
      return true; // No active lock — allow write
    }
    $current = wp_get_current_user();
    return (int)($lock['userId'] ?? 0) === (int)($current->ID ?? 0);
  }

  /**
   * Build a standard 423 Locked response including the lock holder's name.
   */
  private function locked_response(string $resource): WP_REST_Response {
    $lock = get_transient($this->lock_transient_key($resource));
    return new WP_REST_Response([
      'error'    => 'This page is currently locked by ' . (is_array($lock) ? ($lock['displayName'] ?? 'another user') : 'another user') . '.',
      'lockedBy' => is_array($lock) ? ($lock['displayName'] ?? '') : '',
    ], 423);
  }

  /**
   * Find and return a reference to the edition array element matching $date + $edition_number.
   * Returns null when not found. Caller passes $data['editions'] by reference.
   */
  private function find_edition_ref(array &$editions, string $date, int $edition_number): ?array {
    foreach ($editions as &$ed) {
      if ((string)($ed['date'] ?? '') === $date && (int)($ed['edition'] ?? 1) === $edition_number) {
        return [&$ed];  // wrap in array so caller can modify via reference
      }
    }
    return null;
  }

  // ── Input validation helpers (CQ-4) ───────────────────────────────────────

  /**
   * Validate a date string.
   * @return string|null  Error message, or null if valid.
   */
  private function validate_date_format(string $date): ?string {
    if ($date === '') {
      return 'date is required';
    }
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
      return 'date must be in YYYY-MM-DD format';
    }
    // Validate calendar correctness (e.g. no 2024-02-30)
    $parts = explode('-', $date);
    if (!checkdate((int)$parts[1], (int)$parts[2], (int)$parts[0])) {
      return 'date is not a valid calendar date';
    }
    return null;
  }

  /**
   * Validate a NewspaperPage payload.
   * @param  array $page  Raw page array from the request body.
   * @return array        Keyed field → error message. Empty array = valid.
   */
  private function validate_page_payload(array $page): array {
    $errors = [];

    // id: required positive integer
    $id = isset($page['id']) ? (int) $page['id'] : 0;
    if ($id <= 0 || $id > 9999) {
      $errors['id'] = 'page.id must be a positive integer ≤ 9999';
    }

    // thumbnail / fullImage: optional URL strings, ≤ 2048 chars
    foreach (['thumbnail', 'fullImage', 'fullImageHiRes'] as $field) {
      if (isset($page[$field])) {
        if (!is_string($page[$field])) {
          $errors[$field] = "page.{$field} must be a string";
        } elseif (strlen($page[$field]) > 2048) {
          $errors[$field] = "page.{$field} must not exceed 2048 characters";
        }
      }
    }

    // sections: must be an array if present
    if (isset($page['sections']) && !is_array($page['sections'])) {
      $errors['sections'] = 'page.sections must be an array';
    }

    // imageStatus: optional enum
    if (isset($page['imageStatus']) && !in_array($page['imageStatus'], ['pending', 'ready'], true)) {
      $errors['imageStatus'] = 'page.imageStatus must be "pending" or "ready"';
    }

    // pageLabels: optional map of lang → string
    if (isset($page['pageLabels'])) {
      if (!is_array($page['pageLabels'])) {
        $errors['pageLabels'] = 'page.pageLabels must be an object';
      } else {
        foreach ($page['pageLabels'] as $lang => $label) {
          if (!is_string($label) || strlen($label) > 200) {
            $errors['pageLabels'] = "page.pageLabels[{$lang}] must be a string ≤ 200 characters";
            break;
          }
        }
      }
    }

    return $errors;
  }

  /**
   * Validate a NewsSection payload.
   * @param  array $section  Raw section array from the request body.
   * @return array           Keyed field → error message. Empty array = valid.
   */
  private function validate_section_payload(array $section): array {
    $errors = [];

    // id: required non-empty string ≤ 200 chars
    $sid = (string) ($section['id'] ?? '');
    if ($sid === '') {
      $errors['id'] = 'section.id is required';
    } elseif (strlen($sid) > 200) {
      $errors['id'] = 'section.id must not exceed 200 characters';
    }

    // title: required string ≤ 500 chars
    if (!isset($section['title'])) {
      $errors['title'] = 'section.title is required';
    } elseif (!is_string($section['title'])) {
      $errors['title'] = 'section.title must be a string';
    } elseif (strlen($section['title']) > 500) {
      $errors['title'] = 'section.title must not exceed 500 characters';
    }

    // x, y, width, height: required numeric within reasonable bounds
    foreach (['x', 'y'] as $coord) {
      if (!isset($section[$coord])) {
        $errors[$coord] = "section.{$coord} is required";
      } elseif (!is_numeric($section[$coord])) {
        $errors[$coord] = "section.{$coord} must be numeric";
      } elseif ((float)$section[$coord] < -100000 || (float)$section[$coord] > 100000) {
        $errors[$coord] = "section.{$coord} must be between -100000 and 100000";
      }
    }
    foreach (['width', 'height'] as $dim) {
      if (!isset($section[$dim])) {
        $errors[$dim] = "section.{$dim} is required";
      } elseif (!is_numeric($section[$dim])) {
        $errors[$dim] = "section.{$dim} must be numeric";
      } elseif ((float)$section[$dim] < 0 || (float)$section[$dim] > 100000) {
        $errors[$dim] = "section.{$dim} must be between 0 and 100000";
      }
    }

    // content: optional string ≤ 500 KB
    if (isset($section['content'])) {
      if (!is_string($section['content'])) {
        $errors['content'] = 'section.content must be a string';
      } elseif (strlen($section['content']) > 512000) {
        $errors['content'] = 'section.content must not exceed 500 KB';
      }
    }

    // imageUrl: optional URL string ≤ 2048 chars
    if (isset($section['imageUrl'])) {
      if (!is_string($section['imageUrl'])) {
        $errors['imageUrl'] = 'section.imageUrl must be a string';
      } elseif (strlen($section['imageUrl']) > 2048) {
        $errors['imageUrl'] = 'section.imageUrl must not exceed 2048 characters';
      }
    }

    // linkedSectionIds: optional array of strings
    if (isset($section['linkedSectionIds'])) {
      if (!is_array($section['linkedSectionIds'])) {
        $errors['linkedSectionIds'] = 'section.linkedSectionIds must be an array';
      } else {
        foreach ($section['linkedSectionIds'] as $i => $lid) {
          if (!is_string($lid) || strlen($lid) > 200) {
            $errors['linkedSectionIds'] = "section.linkedSectionIds[{$i}] must be a string ≤ 200 characters";
            break;
          }
        }
      }
    }

    return $errors;
  }

  // ── Atomic write endpoints ─────────────────────────────────────────────────

  /**
   * Install a shutdown handler that turns PHP **fatal errors** (E_ERROR — OOM,
   * max-execution-time, type-error during writeback, etc.) into a structured
   * JSON 500 response and logs them to wp-content/dn-last-fatal.log.
   *
   * Background: a regular try/catch CANNOT catch E_ERROR-class fatals.  When
   * one fires inside a save endpoint, WordPress's core error handler emits
   * its "There has been a critical error on this website" HTML page with a
   * 500 status.  Angular receives HTML where it expects JSON, fails to parse
   * it, and surfaces an opaque error to the editor.
   *
   * This handler:
   *   1. Records the fatal to dn-last-fatal.log so ?dn_diag=last-fatal can
   *      show the file/line/peak-memory after the fact.
   *   2. If headers have not been sent, wipes any buffered partial output
   *      (the WP critical-error HTML) and emits a JSON 500 the Angular admin
   *      can display in its save-failure toast.
   *
   * Idempotent within a request — safe to call once at the top of every
   * write endpoint.
   */
  private function install_fatal_response_handler(string $endpoint_name): void {
    register_shutdown_function(static function () use ($endpoint_name) {
      $err = error_get_last();
      $fatal_types = [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR];
      if (!$err || !in_array($err['type'] ?? 0, $fatal_types, true)) {
        return;
      }

      $payload = [
        'when'     => gmdate('c'),
        'endpoint' => $endpoint_name,
        'type'     => $err['type'],
        'message'  => $err['message'],
        'file'     => $err['file'],
        'line'     => $err['line'],
        'peak_mb'  => function_exists('memory_get_peak_usage')
          ? round(memory_get_peak_usage(true) / 1048576, 1)
          : null,
      ];

      // Persist for ?dn_diag=last-fatal (best-effort; never throw).
      if (defined('WP_CONTENT_DIR')) {
        @file_put_contents(
          WP_CONTENT_DIR . '/dn-last-fatal.log',
          json_encode($payload, JSON_PRETTY_PRINT)
        );
      }

      // Replace the WP "critical error" HTML with structured JSON so the
      // Angular admin's error toast can show the actual cause.
      if (headers_sent()) {
        return;
      }
      while (ob_get_level() > 0) {
        @ob_end_clean();
      }
      if (function_exists('status_header')) {
        status_header(500);
      } else {
        @header('HTTP/1.1 500 Internal Server Error');
      }
      if (function_exists('nocache_headers')) {
        nocache_headers();
      }
      @header('Content-Type: application/json; charset=utf-8');
      echo json_encode([
        'error'    => 'fatal',
        'code'     => 'php_fatal',
        'message'  => $err['message'],
        'file'     => basename((string) $err['file']),
        'line'     => (int) $err['line'],
        'endpoint' => $endpoint_name,
        'peakMem'  => $payload['peak_mb'],
        'hint'     => 'See ?dn_diag=last-fatal for the captured fatal record.',
      ]);
    });
  }

  /**
   * PUT /data/page
   *
   * Atomically upsert a single page within an edition.
   * Body: { date: string, edition: int, page: NewspaperPage }
   */
  public function put_page_endpoint(WP_REST_Request $request): WP_REST_Response {
    // MEM-OPT: bump limits before loading the full dn_data blob, same as the
    // legacy GET /data endpoint.  get_data() + save_data() on a 30–50 MB
    // dataset can approach the default 256 MB shared-hosting memory cap.
    @ini_set('memory_limit', '512M');
    @set_time_limit(120);

    // Catch true PHP fatals (OOM, max-execution) that bypass the try/catch
    // below and would otherwise surface as the WordPress critical-error HTML.
    $this->install_fatal_response_handler('PUT /data/page');

    // Wrap entire endpoint body in try/catch so any PHP fatal (memory
    // exhaustion, type error, DB write failure) returns a structured JSON
    // payload Angular can surface instead of WordPress's opaque 500 page.
    // Mirrors the pattern used in get_data_endpoint.
    try {
      $body    = $request->get_json_params();
      $date    = sanitize_text_field((string)($body['date']    ?? ''));
      $edition = max(1, min(99, (int)($body['edition'] ?? 1)));
      $page    = isset($body['page']) && is_array($body['page']) ? $body['page'] : null;

      // ── Validation (CQ-4) ──────────────────────────────────────────────────
      $date_err = $this->validate_date_format($date);
      if ($date_err) {
        return new WP_REST_Response(['error' => 'Validation failed', 'fields' => ['date' => $date_err]], 422);
      }
      if (!$page) {
        return new WP_REST_Response(['error' => 'Validation failed', 'fields' => ['page' => 'page payload is required and must be an object']], 422);
      }
      $page_errors = $this->validate_page_payload($page);
      if (!empty($page_errors)) {
        return new WP_REST_Response(['error' => 'Validation failed', 'fields' => $page_errors], 422);
      }

      // Enforce server-side lock: only the lock holder may update this page.
      $resource = $date . ':' . $edition . ':' . (int)($page['id'] ?? 0);
      if ((int)($page['id'] ?? 0) > 0 && !$this->lock_belongs_to_current_user($resource)) {
        return $this->locked_response($resource);
      }

      // PERF: read ONLY this date's slice (settings + dn_edition_{date}) instead
      // of deserialising the full ~30 MB dn_data blob.  Combined with the blob-
      // write skip in save_data(), this means an atomic page save touches at
      // most a few hundred KB of MySQL traffic instead of 60 MB round-trip.
      $data          = $this->get_data_scoped_to_date($date);
      $found_edition = false;

      foreach ($data['editions'] as &$ed) {
        if ((string)($ed['date'] ?? '') === $date && (int)($ed['edition'] ?? 1) === $edition) {
          $found_edition = true;
          $page_id       = (int)($page['id'] ?? 0);
          $found_page    = false;

          foreach ($ed['pages'] as &$p) {
            if ((int)$p['id'] === $page_id) {
              $p           = $page;
              $found_page  = true;
              break;
            }
          }
          unset($p);

          if (!$found_page) {
            $ed['pages'][] = $page;
          }
          break;
        }
      }
      unset($ed);

      if (!$found_edition) {
        $data['editions'][] = ['date' => $date, 'edition' => $edition, 'pages' => [$page]];
        usort($data['editions'], static function ($a, $b) {
          $d = strcmp((string)($b['date'] ?? ''), (string)($a['date'] ?? ''));
          return $d !== 0 ? $d : ((int)($a['edition'] ?? 1) - (int)($b['edition'] ?? 1));
        });
      }

      // sync_posts = false: page saves don't change section content, so there is
      // nothing to mirror to dn_section posts.  Skipping the full-dataset sync
      // avoids O(all-sections) DB queries and the gateway timeout they cause.
      // throttle_snapshot = true: high-frequency page saves should share one
      // backup slot per 5 min — taking a full ~50 MB snapshot on every page
      // save was the primary cause of the "Server response timed out" warning.
      // only_date = $date: write only the affected date's per-date option
      // instead of rewriting every date (O(1) vs O(N) update_option calls).
      $result = $this->save_data($data, $this->current_user_display(), 0.0, true, false, $date);

      $this->log_auth_user_action('page_save', 'Saved page (atomic)', [
        'date'    => $date,
        'edition' => (string)$edition,
        'pageId'  => (string)($page['id'] ?? ''),
      ]);

      return rest_ensure_response(['success' => true, 'newDataVersion' => $result['newDataVersion']]);
    } catch (\Throwable $e) {
      error_log('[DigitalNewspaper] put_page_endpoint fatal: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
      return new WP_REST_Response([
        'error'   => 'internal_error',
        'message' => $e->getMessage(),
        'file'    => basename($e->getFile()),
        'line'    => $e->getLine(),
        'peakMem' => function_exists('memory_get_peak_usage') ? memory_get_peak_usage(true) : null,
      ], 500);
    }
  }

  /**
   * DELETE /data/page
   *
   * Atomically remove a single page from an edition.
   * Body: { date: string, edition: int, pageId: int }
   */
  public function delete_page_endpoint(WP_REST_Request $request): WP_REST_Response {
    $this->install_fatal_response_handler('DELETE /data/page');

    $body    = $request->get_json_params();
    $date    = sanitize_text_field((string)($body['date']   ?? ''));
    $edition = max(1, min(99, (int)($body['edition'] ?? 1)));
    $page_id = (int)($body['pageId'] ?? 0);

    // ── Validation (CQ-4) ──────────────────────────────────────────────────
    $date_err = $this->validate_date_format($date);
    if ($date_err) {
      return new WP_REST_Response(['error' => 'Validation failed', 'fields' => ['date' => $date_err]], 422);
    }
    if ($page_id <= 0 || $page_id > 9999) {
      return new WP_REST_Response(['error' => 'Validation failed', 'fields' => ['pageId' => 'pageId must be a positive integer ≤ 9999']], 422);
    }

    // Enforce server-side lock: only the lock holder may delete this page.
    $resource = $date . ':' . $edition . ':' . $page_id;
    if (!$this->lock_belongs_to_current_user($resource)) {
      return $this->locked_response($resource);
    }

    $data = $this->get_data();

    foreach ($data['editions'] as &$ed) {
      if ((string)($ed['date'] ?? '') === $date && (int)($ed['edition'] ?? 1) === $edition) {
        $ed['pages'] = array_values(
          array_filter($ed['pages'], static fn($p) => (int)($p['id'] ?? 0) !== $page_id)
        );
        break;
      }
    }
    unset($ed);

    // throttle_snapshot = true + only_date = $date: same rationale as
    // put_page_endpoint — avoid the full-blob snapshot and full per-date
    // rewrite on every page mutation.  sync_posts left at default (true)
    // because deleting a page may orphan dn_section posts that the full sync
    // will trash.
    $result = $this->save_data($data, $this->current_user_display(), 0.0, true, true, $date);

    $this->log_auth_user_action('page_delete', 'Deleted page (atomic)', [
      'date'    => $date,
      'edition' => (string)$edition,
      'pageId'  => (string)$page_id,
    ]);

    return rest_ensure_response(['success' => true, 'newDataVersion' => $result['newDataVersion']]);
  }

  /**
   * PUT /data/section
   *
   * Atomically upsert a single section within a page.
   * Body: { date, edition, pageId, section: NewsSection, originalSectionId?: string }
   * originalSectionId lets the server find the section even when the ID was normalized/renamed.
   */
  public function put_section_endpoint(WP_REST_Request $request): WP_REST_Response {
    // MEM-OPT: bump limits before loading the full dn_data blob.
    @ini_set('memory_limit', '512M');
    @set_time_limit(120);

    // Catch true PHP fatals (OOM, max-execution) so the editor receives JSON
    // instead of the WordPress critical-error HTML.
    $this->install_fatal_response_handler('PUT /data/section');

    $body            = $request->get_json_params();
    $date            = sanitize_text_field((string)($body['date']             ?? ''));
    $edition         = max(1, min(99, (int)($body['edition'] ?? 1)));
    $page_id         = (int)($body['pageId']         ?? 0);
    $original_sec_id = sanitize_text_field((string)($body['originalSectionId'] ?? ''));
    $section         = isset($body['section']) && is_array($body['section']) ? $body['section'] : null;

    // ── Validation (CQ-4) ──────────────────────────────────────────────────
    $date_err = $this->validate_date_format($date);
    if ($date_err) {
      return new WP_REST_Response(['error' => 'Validation failed', 'fields' => ['date' => $date_err]], 422);
    }
    if ($page_id <= 0 || $page_id > 9999) {
      return new WP_REST_Response(['error' => 'Validation failed', 'fields' => ['pageId' => 'pageId must be a positive integer ≤ 9999']], 422);
    }
    if (!$section) {
      return new WP_REST_Response(['error' => 'Validation failed', 'fields' => ['section' => 'section payload is required and must be an object']], 422);
    }
    $sec_errors = $this->validate_section_payload($section);
    if (!empty($sec_errors)) {
      return new WP_REST_Response(['error' => 'Validation failed', 'fields' => $sec_errors], 422);
    }

    // Enforce server-side lock: only the lock holder may modify sections on this page.
    $resource = $date . ':' . $edition . ':' . $page_id;
    if (!$this->lock_belongs_to_current_user($resource)) {
      return $this->locked_response($resource);
    }

    $new_sec_id = sanitize_text_field((string)($section['id'] ?? ''));
    $lookup_id  = $original_sec_id ?: $new_sec_id;

    // PERF: scoped read — only load this date's slice (≤ a few MB) instead of
    // the full ~30 MB dn_data blob.  save_data() with $only_date=$date will
    // skip the legacy blob write entirely, so the round-trip cost is bounded
    // by the single per-date option size.
    $data          = $this->get_data_scoped_to_date($date);
    $found_edition = false;
    $found_page    = false;

    // Track context needed for targeted WP post upsert (avoids full-dataset sync).
    $ctx_edition_index  = 0;
    $ctx_edition_labels = [];
    $ctx_page           = [];
    $ctx_page_labels    = [];
    $ctx_page_index     = 0;
    $ctx_section_index  = 0;

    foreach ($data['editions'] as $ei => &$ed) {
      if ((string)($ed['date'] ?? '') === $date && (int)($ed['edition'] ?? 1) === $edition) {
        $found_edition      = true;
        $ctx_edition_index  = $ei;
        $ctx_edition_labels = is_array($ed['editionLabels'] ?? null) ? $ed['editionLabels'] : [];

        foreach ($ed['pages'] as $pi => &$p) {
          if ((int)($p['id'] ?? 0) === $page_id) {
            $found_page      = true;
            $ctx_page_index  = $pi;
            $ctx_page_labels = is_array($p['pageLabels'] ?? null) ? $p['pageLabels'] : [];
            $found_section   = false;

            foreach ($p['sections'] as $si => &$s) {
              if ((string)($s['id'] ?? '') === $lookup_id) {
                $s                  = $section;
                $ctx_section_index  = $si;
                $found_section      = true;
                break;
              }
            }
            unset($s);

            if (!$found_section) {
              $ctx_section_index = count($p['sections']); // will be at end after append
              $p['sections'][]   = $section;
            }

            $ctx_page = $p; // capture after modification (sections array updated)
            break 2;
          }
        }
        unset($p);
        break;
      }
    }
    unset($ed);

    // Guard: the target page must already exist on the server.
    // Returning an error here (instead of silently saving unchanged data) lets
    // Angular surface a visible failure so the admin knows to retry — commonly
    // triggered by a race condition where the section save arrives before the
    // page save has been committed.
    if (!$found_edition || !$found_page) {
      return new WP_REST_Response([
        'error'     => 'Page not found',
        'code'      => 'page_not_found',
        'message'   => "Cannot save section: page {$page_id} was not found for {$date} edition {$edition}. Save the page first, then retry.",
      ], 404);
    }

    // sync_posts = false: we upsert only the single changed section below,
    // avoiding the O(all-sections) full-dataset sync that causes timeouts.
    // throttle_snapshot = true: high-frequency section saves share one backup slot per 5 min.
    // only_date = $date: write only the affected date's per-date option (PERF).
    $result = $this->save_data($data, $this->current_user_display(), 0.0, true, false, $date);

    // Upsert only the one section that changed into its dn_section WP post.
    // This is O(1) vs. the O(N) full sync, so it completes in milliseconds.
    try {
      $sec_key = $this->section_key($date, $edition, $page_id, $new_sec_id);
      $this->upsert_section_post(
        $sec_key,
        $date,
        $edition,
        $ctx_edition_labels,
        $ctx_edition_index,
        $ctx_page,
        $page_id,
        $ctx_page_labels,
        $ctx_page_index,
        $section,
        $ctx_section_index
      );
    } catch (\Throwable $e) {
      error_log('[DigitalNewspaper] upsert_section_post failed in put_section_endpoint: ' . $e->getMessage());
    }

    $this->log_auth_user_action('section_save', 'Saved section (atomic)', [
      'date'      => $date,
      'edition'   => (string)$edition,
      'pageId'    => (string)$page_id,
      'sectionId' => $new_sec_id,
      'title'     => (string)($section['title'] ?? ''),
    ]);

    return rest_ensure_response(['success' => true, 'newDataVersion' => $result['newDataVersion']]);
  }

  /**
   * DELETE /data/section
   *
   * Atomically remove a single section from a page.
   * Body: { date, edition, pageId, sectionId }
   */
  public function delete_section_endpoint(WP_REST_Request $request): WP_REST_Response {
    $this->install_fatal_response_handler('DELETE /data/section');

    $body       = $request->get_json_params();
    $date       = sanitize_text_field((string)($body['date']      ?? ''));
    $edition    = max(1, min(99, (int)($body['edition']  ?? 1)));
    $page_id    = (int)($body['pageId']   ?? 0);
    $section_id = sanitize_text_field((string)($body['sectionId'] ?? ''));

    // ── Validation (CQ-4) ──────────────────────────────────────────────────
    $date_err = $this->validate_date_format($date);
    if ($date_err) {
      return new WP_REST_Response(['error' => 'Validation failed', 'fields' => ['date' => $date_err]], 422);
    }
    if ($page_id <= 0 || $page_id > 9999) {
      return new WP_REST_Response(['error' => 'Validation failed', 'fields' => ['pageId' => 'pageId must be a positive integer ≤ 9999']], 422);
    }
    if ($section_id === '' || strlen($section_id) > 200) {
      return new WP_REST_Response(['error' => 'Validation failed', 'fields' => ['sectionId' => 'sectionId must be a non-empty string ≤ 200 characters']], 422);
    }

    // Enforce server-side lock: only the lock holder may delete sections on this page.
    $resource = $date . ':' . $edition . ':' . $page_id;
    if (!$this->lock_belongs_to_current_user($resource)) {
      return $this->locked_response($resource);
    }

    $data = $this->get_data();

    foreach ($data['editions'] as &$ed) {
      if ((string)($ed['date'] ?? '') === $date && (int)($ed['edition'] ?? 1) === $edition) {
        foreach ($ed['pages'] as &$p) {
          if ((int)($p['id'] ?? 0) === $page_id) {
            $p['sections'] = array_values(
              array_filter($p['sections'], static fn($s) => (string)($s['id'] ?? '') !== $section_id)
            );
            break 2;
          }
        }
        unset($p);
        break;
      }
    }
    unset($ed);

    // Snapshot throttled for atomic section deletes to preserve backup history.
    // only_date = $date: write only the affected date's per-date option (PERF).
    $result = $this->save_data($data, $this->current_user_display(), 0.0, true, true, $date);

    $this->log_auth_user_action('section_delete', 'Deleted section (atomic)', [
      'date'      => $date,
      'edition'   => (string)$edition,
      'pageId'    => (string)$page_id,
      'sectionId' => $section_id,
    ]);

    return rest_ensure_response(['success' => true, 'newDataVersion' => $result['newDataVersion']]);
  }

  public function login(WP_REST_Request $request) {
    // ── Brute-force rate limiting: max 5 failed attempts per IP per 10 min ──
    $client_ip  = sanitize_text_field((string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? ''));
    $rate_key   = 'dn_login_attempts_' . md5($client_ip);
    $attempts   = (int) get_transient($rate_key);
    if ($attempts >= 5) {
      $this->log_activity('login_blocked', 'Login blocked (rate limit)', ['ip' => $client_ip], 0, 'unknown', 'unknown');
      return new WP_REST_Response([
        'error' => 'Too many failed login attempts. Please wait 10 minutes before trying again.',
      ], 429);
    }

    $params = $request->get_json_params();
    if (!is_array($params) || empty($params)) {
      $params = $request->get_body_params();
    }
    $username = $params['username'] ?? '';
    $password = $params['password'] ?? '';

    if (!$username || !$password) {
      return new WP_REST_Response(['error' => 'Missing credentials'], 400);
    }

    $user = wp_authenticate($username, $password);
    if (is_wp_error($user)) {
      // Increment failure counter (10-minute window, auto-expires)
      set_transient($rate_key, $attempts + 1, 600);
      $remaining = max(0, 4 - $attempts);
      return new WP_REST_Response([
        'error' => 'Invalid credentials',
        'attemptsRemaining' => $remaining,
      ], 401);
    }

    // Successful login — clear the failure counter
    delete_transient($rate_key);

    $token = $this->generate_token($user->ID);

    $roles = (array) $user->roles;
    $role   = !empty($roles) ? $roles[0] : 'subscriber';

    // Set the standard WordPress session cookie so that subsequent REST API
    // calls carry a valid WordPress auth cookie.  Imunify360 bot-protection
    // trusts requests that include a recognised WordPress session cookie and
    // does not treat them as bot traffic — without this cookie every POST from
    // the Angular app looks like an unauthenticated automation request.
    // 'remember = true' matches a typical "stay logged in" session length
    // (14 days) so the cookie remains valid as long as the JWT.
    wp_set_auth_cookie($user->ID, true /* remember */);

    // Activity log (login success)
    $this->log_activity('login', 'User logged in', ['role' => $role], $user->ID, $user->display_name ?: $user->user_login, $role);

    return rest_ensure_response([
      'token' => $token,
      'user' => [
        'id'          => $user->ID,
        'username'    => $user->user_login,
        'email'       => $user->user_email,
        'displayName' => $user->display_name,
        'role'        => $role,
      ]
    ]);
  }

  public function me(WP_REST_Request $request): WP_REST_Response {
    $user = wp_get_current_user();
    if (!$user || !$user->ID) {
      return new WP_REST_Response(['error' => 'Unauthorized'], 401);
    }

    $roles = (array) $user->roles;
    $role   = !empty($roles) ? $roles[0] : 'subscriber';

    return rest_ensure_response([
      'id'          => $user->ID,
      'username'    => $user->user_login,
      'email'       => $user->user_email,
      'displayName' => $user->display_name,
      'role'        => $role,
    ]);
  }

  public function proxy_image(WP_REST_Request $request) {
    $url = $request->get_param('url');
    if (!$url) {
      return new WP_REST_Response(['error' => 'Missing url'], 400);
    }

    // Resolve protocol-relative URLs before parsing
    if (substr($url, 0, 2) === '//') {
      $url = 'https:' . $url;
    }

    // If the URL has no host, resolve it against site_url() (handles relative paths)
    $parsed = wp_parse_url($url);
    if (empty($parsed['host'])) {
      $url = rtrim(site_url(), '/') . '/' . ltrim($url, '/');
      $parsed = wp_parse_url($url);
    }

    // Validate scheme early (before any host checks or file lookups)
    $scheme = $parsed['scheme'] ?? '';
    if (!in_array($scheme, ['http', 'https'], true)) {
      return new WP_REST_Response(['error' => 'Invalid URL scheme'], 400);
    }

    // Fast path: try to serve the image directly from the local uploads directory.
    // Uses a host-agnostic path comparison so cross-domain aliases
    // (epaper.dailysangram.com ↔ nepaper.dailysangram.com on the same server)
    // resolve to the local file without needing to pass the host allowlist check.
    $local_path = $this->dn_uploads_url_to_path_any_host($url);
    if ($local_path !== '') {
      $upload = wp_upload_dir();
      $uploads_base = realpath($upload['basedir']);
      $real_path = realpath($local_path);
      if ($uploads_base && $real_path && strpos($real_path, $uploads_base) === 0 && is_readable($real_path)) {
        $type = wp_check_filetype($real_path);
        $content_type = $type['type'] ?? '';
        if (!$content_type || strpos($content_type, 'image/') !== 0) {
          $content_type = function_exists('mime_content_type') ? (string) mime_content_type($real_path) : '';
        }
        if (!$content_type || strpos($content_type, 'image/') !== 0) {
          return new WP_REST_Response(['error' => 'Not an image'], 415);
        }
        $body = file_get_contents($real_path);
        if ($body === false) {
          return new WP_REST_Response(['error' => 'Failed to read image'], 500);
        }
        $local_headers = [
          'Content-Type'  => $content_type,
          'Cache-Control' => 'public, max-age=86400',
        ];
        if (stripos($content_type, 'svg') !== false) {
          $local_headers['Content-Disposition']  = 'attachment; filename="image.svg"';
          $local_headers['X-Content-Type-Options'] = 'nosniff';
        }
        return new WP_REST_Response($body, 200, $local_headers);
      }
    }

    // Remote fetch: only allowed for the site's own domains.
    // Include home_url, site_url, and www. variants to handle subdirectory installs.
    $home_host = (string) wp_parse_url(home_url(), PHP_URL_HOST);
    $site_host = (string) wp_parse_url(site_url(), PHP_URL_HOST);
    $built_in_hosts = array_values(array_unique(array_filter([
      $home_host,
      $site_host,
      $home_host ? 'www.' . $home_host : '',
      $site_host ? 'www.' . $site_host : '',
      $home_host && strpos($home_host, 'www.') === 0 ? substr($home_host, 4) : '',
      $site_host && strpos($site_host, 'www.') === 0 ? substr($site_host, 4) : '',
    ])));
    $allowed_hosts = apply_filters('dn_proxy_allowed_hosts', $built_in_hosts);
    if (empty($parsed['host']) || !in_array($parsed['host'], $allowed_hosts, true)) {
      return new WP_REST_Response(['error' => 'URL not allowed: ' . ($parsed['host'] ?? '(none)') . '. Allowed: ' . implode(', ', $allowed_hosts)], 403);
    }

    $response = wp_remote_get($url, [
      'timeout' => 20,
      'redirection' => 5,
      'reject_unsafe_urls' => true,
      'headers' => [
        'User-Agent' => 'DigitalNewspaperProxy/1.0',
        'Referer' => home_url()
      ]
    ]);

    if (is_wp_error($response)) {
      return new WP_REST_Response(['error' => 'Failed to fetch image'], 502);
    }

    $code = wp_remote_retrieve_response_code($response);
    if ($code < 200 || $code >= 300) {
      return new WP_REST_Response(['error' => 'Image fetch failed'], $code);
    }

    $body = wp_remote_retrieve_body($response);
    $content_type = wp_remote_retrieve_header($response, 'content-type');

    if (!$content_type) {
      $content_type = 'image/jpeg';
    }

    // Block non-image responses to prevent content-sniffing attacks
    if (strpos($content_type, 'image/') !== 0) {
      return new WP_REST_Response(['error' => 'Not an image'], 415);
    }

    $headers = [
      'Content-Type'  => $content_type,
      'Cache-Control' => 'public, max-age=86400',
    ];

    // SVG files can contain inline <script> tags. Force them to download rather
    // than render in the browser to prevent stored-XSS via a crafted SVG.
    if (stripos($content_type, 'svg') !== false) {
      $headers['Content-Disposition'] = 'attachment; filename="image.svg"';
      $headers['X-Content-Type-Options'] = 'nosniff';
    }

    return new WP_REST_Response($body, 200, $headers);
  }

  public function upload_media(WP_REST_Request $request): WP_REST_Response {
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';

    $files = $request->get_file_params();
    if (empty($files['file'])) {
      return new WP_REST_Response(['error' => 'No file provided'], 400);
    }

    $file = $files['file'];

    if ($file['size'] > 10 * 1024 * 1024) {
      return new WP_REST_Response(['error' => 'File too large (max 10 MB)'], 413);
    }

    // Sanitize filename to prevent path-traversal attacks
    $file['name'] = sanitize_file_name($file['name']);

    // Validate MIME type by actual file content — do NOT trust $file['type'],
    // which is set by the client and can be spoofed.
    $allowed_ext_map = [
      'jpg'  => 'image/jpeg',
      'jpeg' => 'image/jpeg',
      'png'  => 'image/png',
      'gif'  => 'image/gif',
      'webp' => 'image/webp',
    ];
    $type_info    = wp_check_filetype_and_ext($file['tmp_name'], $file['name']);
    $detected_ext = $type_info['ext'] ?? '';
    if (!$detected_ext || !isset($allowed_ext_map[$detected_ext])) {
      return new WP_REST_Response(['error' => 'Only JPEG, PNG, GIF and WebP images are allowed'], 415);
    }
    // Use the server-verified type, not the client-supplied one
    $file['type'] = $allowed_ext_map[$detected_ext];

    $overrides = ['test_form' => false];
    $uploaded   = wp_handle_upload($file, $overrides);

    if (isset($uploaded['error'])) {
      return new WP_REST_Response(['error' => $uploaded['error']], 500);
    }

    $title = sanitize_text_field(preg_replace('/\.[^.]+$/', '', basename($uploaded['file'])));

    $attachment = [
      'post_mime_type' => $uploaded['type'],
      'post_title'     => $title,
      'post_content'   => '',
      'post_status'    => 'inherit',
    ];

    $attach_id = wp_insert_attachment($attachment, $uploaded['file']);

    if (is_wp_error($attach_id)) {
      // Remove the orphaned upload so it does not occupy disk space untracked
      @unlink($uploaded['file']);
      return new WP_REST_Response(['error' => $attach_id->get_error_message()], 500);
    }

    $meta = wp_generate_attachment_metadata($attach_id, $uploaded['file']);
    wp_update_attachment_metadata($attach_id, $meta);

    $url = wp_get_attachment_url($attach_id);
    return new WP_REST_Response([
      'id'         => $attach_id,
      'source_url' => $url,
      'guid'       => ['rendered' => $url],
    ], 201);
  }

  public function list_media(WP_REST_Request $request): WP_REST_Response {
    $search   = sanitize_text_field((string) ($request->get_param('search') ?? ''));
    $per_page = min((int) ($request->get_param('per_page') ?? 100), 200);

    $args = [
      'post_type'      => 'attachment',
      'post_status'    => 'inherit',
      'posts_per_page' => $per_page,
    ];

    if ($search !== '') {
      $args['s'] = $search;
    }

    $query = new WP_Query($args);
    $items = array_map(function ($post) {
      return [
        'id'    => $post->ID,
        'title' => ['rendered' => $post->post_title],
        'slug'  => $post->post_name,
      ];
    }, $query->posts);

    return rest_ensure_response($items);
  }

  public function delete_media_item(WP_REST_Request $request): WP_REST_Response {
    $id = (int) $request->get_param('id');
    if (!$id) {
      return new WP_REST_Response(['error' => 'Invalid id'], 400);
    }

    $result = wp_delete_attachment($id, true);
    if (!$result) {
      return new WP_REST_Response(['error' => 'Attachment not found or could not be deleted'], 404);
    }

    return rest_ensure_response(['deleted' => true, 'id' => $id]);
  }

  public function auth_required(WP_REST_Request $request) {
    $token = $this->get_bearer_token($request);
    if (!$token) {
      return new WP_Error('dn_unauthorized', 'Missing token', ['status' => 401]);
    }

    $payload = $this->verify_token($token);
    if (!$payload || empty($payload['sub'])) {
      return new WP_Error('dn_unauthorized', 'Invalid token', ['status' => 401]);
    }

    $user = get_user_by('id', (int) $payload['sub']);
    if (!$user) {
      return new WP_Error('dn_unauthorized', 'User not found', ['status' => 401]);
    }

    wp_set_current_user($user->ID);

    if (!user_can($user, 'edit_posts')) {
      return new WP_Error('dn_forbidden', 'Insufficient permissions', ['status' => 403]);
    }

    return true;
  }

  /**
   * Permission callback that requires the WordPress Administrator role.
   * Calls auth_required first so token validation is not duplicated.
   */
  public function admin_required(WP_REST_Request $request) {
    $check = $this->auth_required($request);
    if ($check !== true) {
      return $check;
    }
    $user = wp_get_current_user();
    if (!$user || !user_can($user, 'manage_options')) {
      return new WP_Error('dn_forbidden', 'Administrator access required', ['status' => 403]);
    }

    return true;
  }

  public function authenticate_rest_request($result) {
    if (!empty($result)) {
      return $result;
    }

    $token = $this->get_bearer_token_from_globals();
    if (!$token) {
      // No Bearer token present — let WordPress's own cookie/nonce auth handle it.
      return $result;
    }

    // Bearer token present: JWT identity always takes precedence over any
    // existing cookie-authenticated session.  This ensures the correct user is
    // resolved even when two different users share the same browser (one logged
    // into WP admin via cookie, the other sending a different JWT).
    $payload = $this->verify_token($token);
    if (!$payload || empty($payload['sub'])) {
      return new WP_Error('dn_unauthorized', 'Invalid token', ['status' => 401]);
    }

    $user = get_user_by('id', (int) $payload['sub']);
    if (!$user) {
      return new WP_Error('dn_unauthorized', 'User not found', ['status' => 401]);
    }

    wp_set_current_user($user->ID);
    return true;
  }

  public function add_cors_headers($served, $result, $request, $server) {
    // Only add CORS headers when the browser supplies an Origin.
    // Same-origin fetch() GET requests do NOT send Origin, so we must not
    // gate the proxy binary-serving logic on Origin being present.
    $origin = get_http_origin();
    if ($origin) {
      $allowed = $this->get_allowed_origins();
      if ($allowed && in_array($origin, $allowed, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Vary: Origin');
        header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: Authorization, X-Authorization, Content-Type');
        if (get_option(self::OPTION_ALLOW_CREDENTIALS, true)) {
          header('Access-Control-Allow-Credentials: true');
        }
      }
    }

    if ('OPTIONS' === $request->get_method()) {
      return true;
    }

    if ($request->get_route() === '/digital-newspaper/v1/proxy' && $result instanceof WP_REST_Response) {
      $data = $result->get_data();
      $headers = $result->get_headers();
      $status = $result->get_status();

      if (is_string($data) && !empty($headers['Content-Type']) && strpos($headers['Content-Type'], 'image/') === 0) {
        status_header($status);
        foreach ($headers as $key => $value) {
          header($key . ': ' . $value);
        }
        echo $data;
        return true;
      }
    }

    return $served;
  }

  private function get_allowed_origins(): array {
    $defaults = [
      'https://epaper.dailysangram.com',
      'https://www.epaper.dailysangram.com',
      'http://localhost:4200',
      'http://127.0.0.1:4200',
    ];

    $raw = (string) get_option(self::OPTION_ORIGINS, '');
    if (!$raw) {
      return $defaults;
    }
    $configured = array_values(array_filter(array_map('trim', explode(',', $raw))));
    return array_values(array_unique(array_merge($defaults, $configured)));
  }

  private function get_bearer_token(WP_REST_Request $request): ?string {
    // Try standard Authorization header first, then X-Authorization fallback.
    // Apache on shared hosting (cPanel, Hostinger) strips Authorization from $_SERVER;
    // X-Authorization is a custom header that Apache always passes through.
    $header = $request->get_header('authorization') ?? '';
    if (!$header) {
      $header = $request->get_header('x-authorization') ?? '';
    }
    if (!$header) {
      return null;
    }
    if (preg_match('/Bearer\s+(.*)$/i', $header, $matches)) {
      return trim($matches[1]);
    }
    return null;
  }

  private function get_bearer_token_from_globals(): ?string {
    // 1. Standard $_SERVER keys (Nginx and some Apache configs).
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';

    // 2. X-Authorization — Apache never strips custom headers, so this is the
    //    most reliable fallback on cPanel / Hostinger shared hosting.
    if (!$header) {
      $header = $_SERVER['HTTP_X_AUTHORIZATION'] ?? '';
    }

    // 3. getallheaders() — last resort for other Apache configurations.
    if (!$header && function_exists('getallheaders')) {
      $all = getallheaders();
      $header = $all['Authorization'] ?? $all['authorization']
             ?? $all['X-Authorization'] ?? $all['x-authorization'] ?? '';
    }

    if (!$header) {
      return null;
    }
    if (preg_match('/Bearer\s+(.*)$/i', $header, $matches)) {
      return trim($matches[1]);
    }
    return null;
  }

  private function generate_token(int $user_id): string {
    $header = ['alg' => 'HS256', 'typ' => 'JWT'];
    $payload = [
      'iss' => get_site_url(),
      'iat' => time(),
      'exp' => time() + self::TOKEN_TTL,
      'sub' => $user_id
    ];

    $segments = [
      $this->base64url_encode(json_encode($header)),
      $this->base64url_encode(json_encode($payload))
    ];

    $signing_input = implode('.', $segments);
    $signature = hash_hmac('sha256', $signing_input, $this->get_secret(), true);
    $segments[] = $this->base64url_encode($signature);

    return implode('.', $segments);
  }

  private function verify_token(string $jwt): ?array {
    $parts = explode('.', $jwt);
    if (count($parts) !== 3) {
      return null;
    }

    [$encoded_header, $encoded_payload, $encoded_signature] = $parts;
    $signing_input = $encoded_header . '.' . $encoded_payload;
    $signature = $this->base64url_decode($encoded_signature);
    $expected = hash_hmac('sha256', $signing_input, $this->get_secret(), true);

    if (!hash_equals($expected, $signature)) {
      return null;
    }

    $payload = json_decode($this->base64url_decode($encoded_payload), true);
    if (!is_array($payload)) {
      return null;
    }

    if (!empty($payload['exp']) && time() > (int) $payload['exp']) {
      return null;
    }

    // Validate issuer: the token must have been issued by this site.
    // Prevents tokens signed with a shared secret on a different site
    // (e.g. a staging clone) from being accepted on production.
    if (!empty($payload['iss']) && $payload['iss'] !== get_site_url()) {
      return null;
    }

    return $payload;
  }

  private function base64url_encode(string $data): string {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
  }

  private function base64url_decode(string $data): string {
    $remainder = strlen($data) % 4;
    if ($remainder) {
      $data .= str_repeat('=', 4 - $remainder);
    }
    return base64_decode(strtr($data, '-_', '+/'));
  }

  private function get_secret(): string {
    // ── FP-2: dedicated JWT secret constant ───────────────────────────────
    // Prefer DN_JWT_SECRET so rotating the JWT signing key does not affect
    // WordPress cookie auth (which also uses AUTH_KEY internally).
    // To use: add  define('DN_JWT_SECRET', 'your-strong-random-secret');
    // to wp-config.php, ideally before the WordPress salt definitions.
    if (defined('DN_JWT_SECRET') && DN_JWT_SECRET) {
      return DN_JWT_SECRET;
    }
    // Backward compat: fall back to AUTH_KEY if DN_JWT_SECRET is not defined.
    if (defined('AUTH_KEY') && AUTH_KEY) {
      return AUTH_KEY;
    }
    if (defined('LOGGED_IN_KEY') && LOGGED_IN_KEY) {
      return LOGGED_IN_KEY;
    }
    // No key configured — the fallback is weak. Warn the admin.
    if (is_admin()) {
      add_action('admin_notices', function () {
        echo '<div class="notice notice-warning"><p><strong>Digital Newspaper:</strong> '
           . 'No JWT secret is configured. Please define <code>DN_JWT_SECRET</code> in wp-config.php '
           . '(or at minimum <code>AUTH_KEY</code>) for production security.</p></div>';
      });
    }
    return 'dn_fallback_secret';
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ACTIVITY LOG  —  custom database table for indexed, sortable storage
  // ══════════════════════════════════════════════════════════════════════════

  const DB_TABLE_SUFFIX  = 'dn_activity_log';
  const DB_VERSION_KEY   = 'dn_activity_log_db_version';
  const DB_VERSION       = 2;              // bump to force schema re-run

  // ── Schema ────────────────────────────────────────────────────────────────

  /**
   * Create or upgrade the activity-log DB table.
   * Safe to call on every request (uses dbDelta / version gate).
   */
  public function maybe_create_activity_table(): void {
    global $wpdb;
    $installed = (int) get_option(self::DB_VERSION_KEY, 0);
    if ($installed >= self::DB_VERSION) return;

    $table   = $wpdb->prefix . self::DB_TABLE_SUFFIX;
    $charset = $wpdb->get_charset_collate();

    $sql = "CREATE TABLE {$table} (
      id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id      BIGINT UNSIGNED NOT NULL DEFAULT 0,
      display_name VARCHAR(255)    NOT NULL DEFAULT '',
      role         VARCHAR(100)    NOT NULL DEFAULT '',
      action       VARCHAR(100)    NOT NULL DEFAULT '',
      label        VARCHAR(255)    NOT NULL DEFAULT '',
      details      LONGTEXT,
      ip           VARCHAR(45)     NOT NULL DEFAULT '',
      user_agent   VARCHAR(500)    NOT NULL DEFAULT '',
      session_id   VARCHAR(64)     NOT NULL DEFAULT '',
      created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY  (id),
      INDEX idx_user_id   (user_id),
      INDEX idx_created   (created_at),
      INDEX idx_action    (action),
      INDEX idx_user_date (user_id, created_at)
    ) {$charset};";

    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    dbDelta($sql);

    update_option(self::DB_VERSION_KEY, self::DB_VERSION, false);

    // One-time migration: move any old wp_options log into the new table
    $old_log = get_option('dn_activity_log', null);
    if (is_array($old_log) && !empty($old_log)) {
      foreach (array_reverse($old_log) as $entry) {
        $this->db_insert_entry(
          (int)    ($entry['userId']      ?? 0),
          (string) ($entry['displayName'] ?? ''),
          (string) ($entry['role']        ?? ''),
          (string) ($entry['action']      ?? ''),
          (string) ($entry['action']      ?? ''),   // label same as action for migrated rows
          (array)  ($entry['details']     ?? []),
          (string) ($entry['ip']          ?? ''),
          (string) ($entry['userAgent']   ?? ''),
          '',
          (string) ($entry['timestamp']   ?? '')
        );
      }
      delete_option('dn_activity_log');
    }
  }

  /** Low-level DB insert — always silent, never throws. */
  private function db_insert_entry(
    int    $user_id,
    string $display_name,
    string $role,
    string $action,
    string $label,
    array  $details,
    string $ip,
    string $user_agent,
    string $session_id,
    string $created_at = ''
  ): void {
    try {
      global $wpdb;
      $table = $wpdb->prefix . self::DB_TABLE_SUFFIX;
      $wpdb->insert($table, [
        'user_id'      => $user_id,
        'display_name' => substr($display_name, 0, 255),
        'role'         => substr($role,         0, 100),
        'action'       => substr($action,       0, 100),
        'label'        => substr($label,        0, 255),
        'details'      => wp_json_encode($details, JSON_UNESCAPED_UNICODE),
        'ip'           => substr($ip,           0,  45),
        'user_agent'   => substr($user_agent,   0, 500),
        'session_id'   => substr($session_id,   0,  64),
        'created_at'   => $created_at ?: gmdate('Y-m-d H:i:s'),
      ], ['%d','%s','%s','%s','%s','%s','%s','%s','%s','%s']);
    } catch (\Throwable $e) {
      error_log('[Digital Newspaper] db_insert_entry: ' . $e->getMessage());
    }
  }

  // ── Public logging API ────────────────────────────────────────────────────

  /**
   * Log a single activity entry.  Always silent.
   *
   * @param string $action        Machine-readable key, e.g. "save_data".
   * @param string $label         Human-readable description shown in the UI.
   * @param array  $details       Arbitrary extra context.
   * @param int    $user_id
   * @param string $display_name
   * @param string $role
   * @param string $session_id    Optional browser session token (for grouping).
   */
  public function log_activity(
    string $action,
    string $label        = '',
    array  $details      = [],
    int    $user_id      = 0,
    string $display_name = '',
    string $role         = '',
    string $session_id   = ''
  ): void {
    $this->maybe_create_activity_table();
    $raw_ip = $_SERVER['REMOTE_ADDR'] ?? '';
    $this->db_insert_entry(
      $user_id,
      $display_name,
      $role,
      $action,
      $label ?: $action,
      $details,
      $this->anonymize_ip($raw_ip),
      substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 500),
      $session_id
    );
  }

  private function anonymize_ip(string $ip): string {
    if ($ip === '') return '';
    if (strpos($ip, ':') !== false) {
      $parts = explode(':', $ip);
      return implode(':', array_slice($parts, 0, 3)) . '::/48';
    }
    $parts = explode('.', $ip);
    array_pop($parts);
    return implode('.', $parts) . '.*';
  }

  /** Log the currently authenticated REST-request user. */
  private function log_auth_user_action(string $action, string $label = '', array $details = []): void {
    $user = wp_get_current_user();
    if (!$user || !$user->ID) return;
    $roles = (array) $user->roles;
    $this->log_activity(
      $action,
      $label ?: $action,
      $details,
      $user->ID,
      $user->display_name ?: $user->user_login,
      !empty($roles) ? $roles[0] : 'subscriber'
    );
  }

  // ── REST endpoints ────────────────────────────────────────────────────────

  /**
   * GET /activity-log
   * Supports: page, per_page, sort_by (created_at|user_id|action), sort_dir (asc|desc),
   *           action, userId, from (YYYY-MM-DD), to (YYYY-MM-DD), search (display_name LIKE).
   */
  public function list_activity_log(WP_REST_Request $request): WP_REST_Response {
    $this->maybe_create_activity_table();
    global $wpdb;
    $table = $wpdb->prefix . self::DB_TABLE_SUFFIX;

    $per_page  = max(1, min(200, (int) ($request->get_param('per_page') ?? 50)));
    $page      = max(1, (int) ($request->get_param('page')     ?? 1));
    $sort_by   = in_array($request->get_param('sort_by'),  ['created_at', 'user_id', 'action', 'display_name'], true)
                   ? $request->get_param('sort_by') : 'created_at';
    $sort_dir  = strtoupper((string) ($request->get_param('sort_dir') ?? 'DESC')) === 'ASC' ? 'ASC' : 'DESC';
    $action_f  = sanitize_text_field((string) ($request->get_param('action')  ?? ''));
    $user_f    = (int) ($request->get_param('userId') ?? 0);
    $from_f    = sanitize_text_field((string) ($request->get_param('from')    ?? ''));
    $to_f      = sanitize_text_field((string) ($request->get_param('to')      ?? ''));
    $search_f  = sanitize_text_field((string) ($request->get_param('search')  ?? ''));

    // Build WHERE
    $where  = '1=1';
    $params = [];
    if ($action_f) { $where .= ' AND action = %s';                          $params[] = $action_f; }
    if ($user_f)   { $where .= ' AND user_id = %d';                         $params[] = $user_f; }
    if ($from_f)   { $where .= ' AND created_at >= %s';                     $params[] = $from_f . ' 00:00:00'; }
    if ($to_f)     { $where .= ' AND created_at <= %s';                     $params[] = $to_f   . ' 23:59:59'; }
    if ($search_f) { $where .= ' AND display_name LIKE %s';                 $params[] = '%' . $wpdb->esc_like($search_f) . '%'; }

    $offset    = ($page - 1) * $per_page;
    $order_sql = "ORDER BY {$sort_by} {$sort_dir}";  // both whitelisted above

    // ── Always go through $wpdb->prepare to satisfy WordPress 6.x requirements.
    // All user-supplied filters go into the $params array as positional arguments;
    // LIMIT/OFFSET are appended last so they are never embedded as raw strings.
    $count_params = array_merge($params);
    $count_sql    = $wpdb->prepare(
      "SELECT COUNT(*) FROM {$table} WHERE {$where}",
      ...$count_params
    );
    $total = (int) $wpdb->get_var($count_sql);

    $data_params = array_merge($params, [$per_page, $offset]);
    $data_sql    = $wpdb->prepare(
      "SELECT id,user_id,display_name,role,action,label,details,ip,created_at
       FROM {$table} WHERE {$where} {$order_sql} LIMIT %d OFFSET %d",
      ...$data_params
    );
    $rows = $wpdb->get_results($data_sql, ARRAY_A) ?: [];

    // Normalize field names and decode JSON details
    foreach ($rows as &$row) {
      $row['details']     = json_decode((string) ($row['details'] ?? '{}'), true) ?: (object)[];
      $row['userId']      = (int) $row['user_id'];
      $row['displayName'] = (string) $row['display_name'];
      // Return created_at as ISO-8601 so Angular can parse it reliably
      $row['createdAt']   = isset($row['created_at'])
        ? (new \DateTime($row['created_at'], new \DateTimeZone('UTC')))->format('c')
        : '';
      unset($row['user_id'], $row['display_name'], $row['created_at']);
    }
    unset($row);

    // Unique users for filter dropdown — no user input in this query
    $users_sql = $wpdb->prepare(
      "SELECT DISTINCT user_id, display_name FROM {$table} ORDER BY display_name ASC LIMIT %d",
      200
    );
    $users_raw = $wpdb->get_results($users_sql, ARRAY_A) ?: [];
    $users = array_map(
      static fn($u) => ['userId' => (int) $u['user_id'], 'displayName' => (string) $u['display_name']],
      $users_raw
    );

    return new WP_REST_Response([
      'total'    => $total,
      'page'     => $page,
      'per_page' => $per_page,
      'sort_by'  => $sort_by,
      'sort_dir' => $sort_dir,
      'entries'  => $rows,
      'users'    => $users,
    ], 200);
  }

  /** DELETE /activity-log */
  public function clear_activity_log(WP_REST_Request $request): WP_REST_Response {
    $this->maybe_create_activity_table();
    global $wpdb;
    $table = $wpdb->prefix . self::DB_TABLE_SUFFIX;
    $this->log_auth_user_action('clear_activity_log', 'Cleared activity log');
    $wpdb->query("TRUNCATE TABLE {$table}");
    return new WP_REST_Response(['cleared' => true], 200);
  }

  /**
   * POST /activity-log/batch — accept an array of client-side events in one request.
   * Much more efficient than one HTTP call per action.
   * Max 50 events per batch to prevent abuse.
   */
  public function log_client_batch(WP_REST_Request $request): WP_REST_Response {
    $this->maybe_create_activity_table();
    $params = $request->get_json_params();
    if (!is_array($params) || !isset($params['events']) || !is_array($params['events'])) {
      return new WP_REST_Response(['error' => 'Invalid payload'], 400);
    }

    $user = wp_get_current_user();
    if (!$user || !$user->ID) {
      return new WP_REST_Response(['error' => 'Unauthorized'], 401);
    }

    // Rate-limit: max 120 batches per user per 60 s to prevent log flooding.
    $rate_key = 'dn_log_rate_' . $user->ID;
    $rate     = (int) get_transient($rate_key);
    if ($rate >= 120) {
      return new WP_REST_Response(['error' => 'Rate limit exceeded'], 429);
    }
    set_transient($rate_key, $rate + 1, 60);

    $roles       = (array) $user->roles;
    $role        = !empty($roles) ? $roles[0] : 'subscriber';
    $display     = $user->display_name ?: $user->user_login;
    $session_id  = sanitize_text_field((string) ($params['sessionId'] ?? ''));
    $raw_ip      = $_SERVER['REMOTE_ADDR'] ?? '';
    $safe_ip     = $this->anonymize_ip($raw_ip);
    $ua          = substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 500);

    $events = array_slice($params['events'], 0, 50);   // hard cap per batch
    $logged = 0;

    foreach ($events as $ev) {
      if (!is_array($ev)) continue;
      $action     = substr(sanitize_text_field((string) ($ev['action']    ?? '')), 0, 100);
      $label      = substr(sanitize_text_field((string) ($ev['label']     ?? '')), 0, 255);
      $created_at = '';

      // Respect client-provided timestamp if valid ISO-8601
      if (!empty($ev['timestamp'])) {
        $ts = strtotime((string) $ev['timestamp']);
        if ($ts && $ts > 0) {
          $created_at = gmdate('Y-m-d H:i:s', $ts);
        }
      }

      if ($action === '') continue;

      // Sanitize details
      $details = [];
      if (isset($ev['details']) && is_array($ev['details'])) {
        foreach ($ev['details'] as $k => $v) {
          $dk = sanitize_key((string) $k);
          $details[$dk] = is_scalar($v) ? sanitize_text_field((string) $v) : '';
        }
      }

      $this->db_insert_entry($user->ID, $display, $role, $action, $label, $details, $safe_ip, $ua, $session_id, $created_at);
      $logged++;
    }

    return new WP_REST_Response(['logged' => $logged], 200);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PAGE / SECTION LOCKING
  // ══════════════════════════════════════════════════════════════════════════

  /** Lock TTL in seconds. Clients must send a heartbeat within this window. */
  const LOCK_TTL = 90;

  /**
   * Build the WordPress transient key for a resource.
   * resource is validated against a strict whitelist pattern before use.
   */
  private function lock_transient_key(string $resource): string {
    // Transient keys are limited to 172 chars; resource is already short-safe.
    return 'dn_lock_' . substr(md5($resource), 0, 12);
  }

  /**
   * Validates and sanitizes the resource identifier from the URL parameter.
   * Accepts: date:edition, date:edition:pageId (colon-separated numbers/dates).
   * Returns the sanitized resource string or empty string on failure.
   */
  private function sanitize_lock_resource(string $resource): string {
    // Allow digits, colons, hyphens (dates like 2026-06-05:1:3)
    if (!preg_match('/^[\d:.-]{1,60}$/', $resource)) {
      return '';
    }
    return $resource;
  }

  /** GET /locks/{resource} — read the current lock status without acquiring it. */
  public function get_lock(WP_REST_Request $request): WP_REST_Response {
    $resource = $this->sanitize_lock_resource(
      (string) ($request->get_param('resource') ?? '')
    );
    if ($resource === '') {
      return new WP_REST_Response(['error' => 'Invalid resource identifier'], 400);
    }

    $transient_key = $this->lock_transient_key($resource);
    $now           = time();
    $existing      = get_transient($transient_key);

    if ($existing && is_array($existing) && $existing['expiresAt'] > $now) {
      return new WP_REST_Response([
        'locked'    => true,
        'heldBy'    => $existing['displayName'] ?? 'Another user',
        'userId'    => (int) $existing['userId'],
        'lockedAt'  => $existing['lockedAt'],
        'expiresAt' => $existing['expiresAt'],
      ], 200);
    }

    return new WP_REST_Response(['locked' => false], 200);
  }

  /** POST /locks/{resource} — acquire or refresh a lock. */
  public function acquire_lock(WP_REST_Request $request): WP_REST_Response {
    $resource = $this->sanitize_lock_resource(
      (string) ($request->get_param('resource') ?? '')
    );
    if ($resource === '') {
      return new WP_REST_Response(['error' => 'Invalid resource identifier'], 400);
    }

    $user = wp_get_current_user();
    if (!$user || !$user->ID) {
      return new WP_REST_Response(['error' => 'Unauthorized'], 401);
    }

    $transient_key = $this->lock_transient_key($resource);
    $now           = time();
    $existing      = get_transient($transient_key);

    if ($existing && is_array($existing)) {
      // Lock is held by a different user and has not expired
      if ((int) $existing['userId'] !== $user->ID && $existing['expiresAt'] > $now) {
        return new WP_REST_Response([
          'locked'       => true,
          'heldBy'       => $existing['displayName'] ?? 'Another user',
          'userId'       => (int) $existing['userId'],
          'lockedAt'     => $existing['lockedAt'],
          'expiresAt'    => $existing['expiresAt'],
        ], 423);
      }
    }

    $lock = [
      'resource'    => $resource,
      'userId'      => $user->ID,
      'displayName' => $user->display_name ?: $user->user_login,
      'lockedAt'    => $now,
      'expiresAt'   => $now + self::LOCK_TTL,
    ];

    set_transient($transient_key, $lock, self::LOCK_TTL);

    // Track this key in the active-locks index so list_locks() can find it.
    $this->register_lock_key($transient_key);

    return new WP_REST_Response([
      'locked'      => false,
      'acquired'    => true,
      'resource'    => $resource,
      'expiresAt'   => $lock['expiresAt'],
    ], 200);
  }

  /** DELETE /locks/{resource} — release a held lock. */
  public function release_lock(WP_REST_Request $request): WP_REST_Response {
    $resource = $this->sanitize_lock_resource(
      (string) ($request->get_param('resource') ?? '')
    );
    if ($resource === '') {
      return new WP_REST_Response(['error' => 'Invalid resource identifier'], 400);
    }

    $user          = wp_get_current_user();
    $transient_key = $this->lock_transient_key($resource);
    $existing      = get_transient($transient_key);
    $force         = $request->get_param('force') === '1';

    // Only the lock holder (or an admin using ?force=1) may release.
    if ($existing && is_array($existing)) {
      if (!$force && (int) $existing['userId'] !== $user->ID) {
        return new WP_REST_Response(['error' => 'Forbidden — you do not hold this lock'], 403);
      }
    }

    delete_transient($transient_key);
    $this->unregister_lock_key($transient_key);

    return new WP_REST_Response(['released' => true], 200);
  }

  /** POST /locks/{resource}/heartbeat — renew TTL of a held lock. */
  public function heartbeat_lock(WP_REST_Request $request): WP_REST_Response {
    $resource = $this->sanitize_lock_resource(
      (string) ($request->get_param('resource') ?? '')
    );
    if ($resource === '') {
      return new WP_REST_Response(['error' => 'Invalid resource identifier'], 400);
    }

    $user          = wp_get_current_user();
    $transient_key = $this->lock_transient_key($resource);
    $existing      = get_transient($transient_key);

    if (!$existing || !is_array($existing)) {
      return new WP_REST_Response(['error' => 'Lock not found or expired'], 404);
    }

    if ((int) $existing['userId'] !== $user->ID) {
      return new WP_REST_Response(['error' => 'You do not hold this lock'], 403);
    }

    $now               = time();
    $existing['expiresAt'] = $now + self::LOCK_TTL;
    set_transient($transient_key, $existing, self::LOCK_TTL);

    return new WP_REST_Response(['renewed' => true, 'expiresAt' => $existing['expiresAt']], 200);
  }

  /** GET /locks — list all currently active locks (admin only). */
  public function list_locks(WP_REST_Request $request): WP_REST_Response {
    $now        = time();
    $lock_keys  = get_option('dn_lock_index', []);
    if (!is_array($lock_keys)) $lock_keys = [];

    $active = [];
    $prune  = [];

    foreach ($lock_keys as $key) {
      $lock = get_transient($key);
      if (!$lock || !is_array($lock)) {
        $prune[] = $key;
        continue;
      }
      if ($lock['expiresAt'] <= $now) {
        $prune[] = $key;
        continue;
      }
      $active[] = $lock;
    }

    // Prune stale keys from the index
    if ($prune) {
      $clean = array_values(array_diff($lock_keys, $prune));
      update_option('dn_lock_index', $clean, false);
    }

    return new WP_REST_Response(['locks' => $active], 200);
  }

  private function register_lock_key(string $key): void {
    $index = get_option('dn_lock_index', []);
    if (!is_array($index)) $index = [];
    if (!in_array($key, $index, true)) {
      $index[] = $key;
      update_option('dn_lock_index', $index, false);
    }
  }

  private function unregister_lock_key(string $key): void {
    $index = get_option('dn_lock_index', []);
    if (!is_array($index)) return;
    $index = array_values(array_filter($index, fn($k) => $k !== $key));
    update_option('dn_lock_index', $index, false);
  }
}

new Digital_Newspaper_API();

register_activation_hook(__FILE__, function () {
  if (!get_option(Digital_Newspaper_API::OPTION_KEY)) {
    update_option(Digital_Newspaper_API::OPTION_KEY, Digital_Newspaper_API::default_data(), false);
  }
  // Create the activity-log DB table immediately on activation
  (new Digital_Newspaper_API())->maybe_create_activity_table();
});
