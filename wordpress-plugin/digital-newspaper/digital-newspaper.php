<?php
/**
 * Plugin Name: Digital Newspaper API
 * Description: Headless WordPress REST API for Digital Newspaper data and authentication.
 * Version: 1.0.0
 * Author: Digital Newspaper
 */

if (!defined('ABSPATH')) {
  exit;
}

class Digital_Newspaper_API {
  const OPTION_KEY = 'dn_data';
  const OPTION_ORIGINS = 'dn_allowed_origins';
  const OPTION_ALLOW_CREDENTIALS = 'dn_allow_credentials';
  const OPTION_PLANS = 'dn_subscription_plans';
  const TOKEN_TTL = 86400; // 24 hours

  // License constants
  const OPTION_LICENSE_KEY    = 'dn_license_key';    // raw key string entered by admin
  const OPTION_LICENSE_DATA   = 'dn_license_data';   // decoded & verified license payload
  const OPTION_LICENSE_SECRET = 'dn_license_secret'; // auto-generated HMAC signing secret

  // Subscription constants
  const OPTION_SUBSCRIPTION_SETTINGS = 'dn_subscription_settings';
  /** WooCommerce product tag that marks a product as a subscription plan. */
  const SUBSCRIPTION_PLAN_TAG = 'dn-subscription-plan';
  /** User meta key storing the ISO date when the user's subscription expires. */
  const SUBSCRIPTION_META_EXPIRES = '_dn_subscription_expires';
  /** User meta key storing the WooCommerce order ID that last activated the subscription. */
  const SUBSCRIPTION_META_ORDER_ID = '_dn_subscription_order_id';

  /** User meta key storing the slug of the plan that last activated the subscription. */
  const SUBSCRIPTION_META_PLAN_SLUG = '_dn_subscription_plan_slug';

  public function __construct() {
    // Ensure the HMAC secret is ready before anything else needs it.
    add_action('init', [$this, 'ensure_license_secret'], 0);
    add_action('init', [$this, 'handle_cors_preflight'], 1);
    add_action('rest_api_init', [$this, 'register_routes']);
    add_filter('rest_authentication_errors', [$this, 'authenticate_rest_request']);
    add_action('admin_menu', [$this, 'register_settings_page']);
    add_action('admin_init', [$this, 'register_settings']);
    add_filter('rest_pre_serve_request', [$this, 'add_cors_headers'], 10, 4);
    // Write subscription expiry to user meta when a WooCommerce order completes.
    add_action('woocommerce_order_status_completed', [$this, 'on_order_completed']);
    // Auto-complete orders containing a DN subscription plan so the subscription
    // activates immediately after payment without requiring admin confirmation.
    add_filter('woocommerce_payment_complete_order_status', [$this, 'auto_complete_subscription_order_status'], 10, 2);
    add_action('woocommerce_order_status_processing', [$this, 'maybe_auto_complete_subscription_order'], 10, 1);
    // Redirect back to the Angular app after the WooCommerce order-received page.
    add_action('woocommerce_thankyou', [$this, 'on_order_thankyou'], 5, 1);
    // Clean-cart checkout page: empties cart, adds only the requested plan, redirects to WC checkout.
    add_action('template_redirect', [$this, 'handle_clean_checkout_redirect']);
    // When any subscription plan is added to cart, remove all other cart items first.
    add_filter('woocommerce_add_to_cart_validation', [$this, 'enforce_single_plan_in_cart'], 10, 2);
    // Allow wp_safe_redirect() to send users back to the Angular app (different domain).
    add_filter('allowed_redirect_hosts', [$this, 'add_allowed_redirect_hosts'], 10, 1);
    // Strip non-essential checkout fields for digital subscription products.
    add_filter('woocommerce_checkout_fields', [$this, 'customize_checkout_fields']);
    // Fallback "Return to app" button on the order-received page (e.g. guest orders).
    add_action('woocommerce_thankyou', [$this, 'show_return_to_app_button'], 10, 1);
    // Block non-editor users from accessing the WordPress admin dashboard.
    add_action('admin_init', [$this, 'block_nonadmin_wp_access']);
  }

  public function handle_cors_preflight(): void {
    $origin = isset($_SERVER['HTTP_ORIGIN']) ? sanitize_text_field($_SERVER['HTTP_ORIGIN']) : '';
    if (!$origin) return;

    $allowed = $this->get_allowed_origins();
    if (!$allowed || !in_array($origin, $allowed, true)) return;

    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Authorization, Content-Type');
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

    register_setting('digital_newspaper_settings', self::OPTION_SUBSCRIPTION_SETTINGS, [
      'type' => 'array',
      'sanitize_callback' => [$this, 'sanitize_subscription_settings'],
      'default' => self::default_subscription_settings()
    ]);

    register_setting('digital_newspaper_settings', self::OPTION_LICENSE_KEY, [
      'type'              => 'string',
      'sanitize_callback' => [$this, 'sanitize_and_store_license_key'],
      'default'           => '',
    ]);
  }

  public function sanitize_subscription_settings($value): array {
    if (!is_array($value)) {
      return self::default_subscription_settings();
    }

    $valid_combined = ['free', 'today_edition', 'archive_access'];

    if (isset($value['combinedMode'])) {
      $incoming = $value['combinedMode'];
      // Migrate legacy mode names.
      if ($incoming === 'both' || $incoming === 'today_only') { $incoming = 'today_edition'; }
      if ($incoming === 'first_page_free') { $incoming = 'archive_access'; }
      $combined_mode = in_array($incoming, $valid_combined, true) ? $incoming : 'free';
    } else {
      // Backward compat: derive combinedMode from old enabled + accessMode fields.
      $old_enabled = !empty($value['enabled']);
      $old_mode    = $value['accessMode'] ?? 'today_edition';
      if (!$old_enabled) {
        $combined_mode = 'free';
      } elseif (in_array($old_mode, ['today_only', 'today_edition', 'time_based', 'both'], true)) {
        $combined_mode = 'today_edition';
      } else {
        $combined_mode = 'archive_access';
      }
    }

    $enabled     = ($combined_mode !== 'free');
    $access_mode = match ($combined_mode) {
      'today_edition'  => 'today_edition',
      'archive_access' => 'archive_access',
      default          => 'today_edition',
    };

    return [
      'enabled'      => $enabled,
      'accessMode'   => $access_mode,
      'combinedMode' => $combined_mode,
      'currency'     => sanitize_text_field($value['currency'] ?? 'BDT'),
      'loginUrl'     => esc_url_raw($value['loginUrl'] ?? ''),
    ];
  }

  public static function default_subscription_settings(): array {
    return [
      'enabled'      => true,
      'accessMode'   => 'today_edition',
      'combinedMode' => 'today_edition',
      'currency'     => 'BDT',
      'loginUrl'     => '',
    ];
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

        <?php
        // ── License Key ────────────────────────────────────────────────────
        $license_key_stored = esc_attr(get_option(self::OPTION_LICENSE_KEY, ''));
        $license_status_html = $this->get_license_status_html();
        $license_data = $this->get_license_data();
        $license_pkg  = $license_data['package'] ?? null;
        ?>
        <?php
        $dn_secret_value = $this->get_license_secret();
        $dn_secret_origin = defined('DN_LICENSE_SECRET') && DN_LICENSE_SECRET ? 'wp-config.php' : 'auto-generated (stored in database)';
        ?>
        <h2>🔑 License Key</h2>
        <p class="description">
          Enter the license key issued for this site. The key determines whether this
          installation runs in <strong>Starter</strong> (free, no subscriptions) or
          <strong>Publisher/Pro</strong> (full subscription features) mode.
        </p>
        <table class="form-table" role="presentation">
          <tr>
            <th scope="row"><label for="dn_license_key_input">License Key</label></th>
            <td>
              <input id="dn_license_key_input"
                     type="text"
                     name="<?php echo esc_attr(self::OPTION_LICENSE_KEY); ?>"
                     value="<?php echo $license_key_stored; ?>"
                     class="large-text"
                     placeholder="DN1-…"
                     autocomplete="off" />
              <p class="description" style="margin-top:6px"><?php echo $license_status_html; ?></p>
              <?php if ($license_data): ?>
              <p class="description" style="margin-top:4px">
                Package: <strong><?php echo esc_html(strtoupper($license_pkg ?? '')); ?></strong>
                &nbsp;|&nbsp;
                Allowed modes: <strong><?php echo esc_html(implode(', ', $license_data['modes'] ?? [])); ?></strong>
                &nbsp;|&nbsp;
                Client: <strong><?php echo esc_html($license_data['client'] ?? ''); ?></strong>
              </p>
              <?php endif; ?>
            </td>
          </tr>
          <tr>
            <th scope="row">Signing Secret</th>
            <td>
              <div style="display:flex;align-items:center;gap:8px">
                <input id="dn_secret_display"
                       type="text"
                       value="<?php echo esc_attr($dn_secret_value); ?>"
                       class="large-text"
                       readonly
                       style="font-family:monospace;background:#f0f0f0" />
                <button type="button"
                        class="button"
                        onclick="navigator.clipboard.writeText(document.getElementById('dn_secret_display').value).then(function(){this.textContent='Copied!';setTimeout(function(){document.getElementById('dn-copy-secret-btn').textContent='Copy';},2000)}.bind(this));"
                        id="dn-copy-secret-btn">Copy</button>
              </div>
              <p class="description" style="margin-top:4px">
                Auto-managed (<?php echo esc_html($dn_secret_origin); ?>).
                Use this value as <code>--secret</code> when running <code>generate-license.php</code>.
              </p>
            </td>
          </tr>
        </table>

        <?php
        $sub = get_option(self::OPTION_SUBSCRIPTION_SETTINGS, self::default_subscription_settings());
        if (!is_array($sub)) { $sub = self::default_subscription_settings(); }
        $sub_currency   = esc_attr($sub['currency'] ?? 'BDT');
        $sub_login_url  = esc_attr($sub['loginUrl'] ?? '');
        $sub_opt        = self::OPTION_SUBSCRIPTION_SETTINGS;

        // Determine lock state: no valid license OR starter license → options 2–4 disabled.
        $is_locked = !$license_data || $license_pkg === 'starter';

        // Compute the current combined mode (backward compat with old enabled+accessMode).
        $combined_mode = $sub['combinedMode'] ?? null;
        if (!$combined_mode) {
          $old_enabled = !empty($sub['enabled']);
          $old_mode    = $sub['accessMode'] ?? 'today_edition';
          if (!$old_enabled) {
            $combined_mode = 'free';
          } elseif (in_array($old_mode, ['today_only', 'today_edition', 'time_based', 'both'], true)) {
            $combined_mode = 'today_edition';
          } else {
            $combined_mode = 'archive_access';
          }
        }
        // Migrate legacy mode names.
        if ($combined_mode === 'both' || $combined_mode === 'today_only') { $combined_mode = 'today_edition'; }
        if ($combined_mode === 'first_page_free') { $combined_mode = 'archive_access'; }
        // When locked, always reset selection to 'free'.
        if ($is_locked) { $combined_mode = 'free'; }
        ?>
        <h2>Subscription Settings</h2>
        <p class="description">Choose how content access is controlled for visitors of the Angular app.</p>
        <table class="form-table" role="presentation">
          <tr>
            <th scope="row">Access Mode</th>
            <td>
              <fieldset>
                <legend class="screen-reader-text">Access mode</legend>

                <?php /* ── Option 1: Free / full access (always enabled) ─────────────── */ ?>
                <label style="display:flex;align-items:flex-start;gap:8px;margin-bottom:12px">
                  <input type="radio"
                         name="<?php echo esc_attr($sub_opt); ?>[combinedMode]"
                         value="free"
                         <?php checked($combined_mode, 'free'); ?>
                         style="margin-top:3px" />
                  <span>
                    <strong>Free – Full access</strong><br>
                    <span class="description">All content is publicly accessible. No subscription is required.</span>
                  </span>
                </label>

                <?php /* ── Option 2: Today's Edition ─────────────────────────────────── */ ?>
                <label style="display:flex;align-items:flex-start;gap:8px;margin-bottom:12px<?php echo $is_locked ? ';opacity:.45' : ''; ?>">
                  <input type="radio"
                         name="<?php echo esc_attr($sub_opt); ?>[combinedMode]"
                         value="today_edition"
                         <?php checked($combined_mode, 'today_edition'); ?>
                         <?php disabled($is_locked, true); ?>
                         style="margin-top:3px" />
                  <span>
                    <strong>Today's Edition</strong><br>
                    <span class="description">Today's first page is always free. Subscribing (Daily / Monthly / Yearly) unlocks all pages of today's newspaper. Archive (past editions) is fully locked and not available in this mode.</span>
                  </span>
                </label>

                <?php /* ── Option 3: Full Archive ──────────────────────────────────────── */ ?>
                <label style="display:flex;align-items:flex-start;gap:8px;margin-bottom:12px<?php echo $is_locked ? ';opacity:.45' : ''; ?>">
                  <input type="radio"
                         name="<?php echo esc_attr($sub_opt); ?>[combinedMode]"
                         value="archive_access"
                         <?php checked($combined_mode, 'archive_access'); ?>
                         <?php disabled($is_locked, true); ?>
                         style="margin-top:3px" />
                  <span>
                    <strong>Full Archive</strong><br>
                    <span class="description">Today's first page is freely accessible. Subscribing unlocks all pages of today's edition <em>and</em> all past editions (archive).</span>
                  </span>
                </label>

                <?php if ($is_locked): ?>
                <p style="margin-top:4px;color:#d63638">
                  &#9888; A valid <strong>Publisher</strong> license key is required to enable subscription features.
                  Enter your license key in the <strong>🔑 License Key</strong> section above.
                </p>
                <?php endif; ?>
              </fieldset>
            </td>
          </tr>
          <tr>
            <th scope="row"><label for="dn_sub_currency">Currency Code</label></th>
            <td>
              <input id="dn_sub_currency" type="text" name="<?php echo esc_attr($sub_opt); ?>[currency]" value="<?php echo $sub_currency; ?>" class="regular-text" />
              <p class="description">ISO 4217 code, e.g. BDT, USD. Shown in the plan list UI.</p>
            </td>
          </tr>
          <tr>
            <th scope="row"><label for="dn_sub_login_url">Login / My Account URL</label></th>
            <td>
              <input id="dn_sub_login_url" type="url" name="<?php echo esc_attr($sub_opt); ?>[loginUrl]" value="<?php echo $sub_login_url; ?>" class="large-text" />
              <p class="description">Shown in the paywall when the visitor is not logged in.</p>
            </td>
          </tr>
        </table>
        <?php submit_button('Save General Settings'); ?>
      </form>

      <!-- ── Plan Management ──────────────────────────────────────── -->
      <hr />
      <h2>📋 Subscription Plans</h2>
      <p class="description">Define the plans shown in the paywall. Price and duration control the card display in the Angular app. Leave <em>Checkout URL</em> blank to auto-build it from WooCommerce (requires the WC product ID in the <em>ID</em> field).</p>

      <?php
      $stored_plans = $this->get_stored_plans();
      $nonce = wp_create_nonce('dn_save_plans');
      ?>

      <div id="dn-plans-wrap">
        <table class="widefat striped" id="dn-plans-table" style="margin-bottom:12px">
          <thead>
            <tr>
              <th style="width:36px">#</th>
              <th>Name</th>
              <th style="width:90px">Price</th>
              <th style="width:70px">Currency</th>
              <th style="width:90px">Days</th>
              <th style="width:140px">Group</th>
              <th>Description</th>
              <th>Checkout URL</th>
              <th style="width:36px"></th>
            </tr>
          </thead>
          <tbody id="dn-plans-body">
            <?php if (empty($stored_plans)): ?>
            <tr id="dn-no-plans-row"><td colspan="9" style="color:#888;padding:16px 8px">No plans yet. Click "Add Plan" to create one.</td></tr>
            <?php else: foreach ($stored_plans as $idx => $plan): ?>
            <?php $am = esc_attr($plan['accessMode'] ?? 'today_edition'); ?>
            <tr class="dn-plan-row" data-idx="<?php echo $idx; ?>">
              <td style="color:#888;font-size:12px"><?php echo $idx + 1; ?></td>
              <td><input type="text" class="regular-text" name="dn_plan_name[]" value="<?php echo esc_attr($plan['name']); ?>" placeholder="Monthly" required /></td>
              <td><input type="text" style="width:80px" name="dn_plan_price[]" value="<?php echo esc_attr($plan['price']); ?>" placeholder="299" /></td>
              <td><input type="text" style="width:60px" name="dn_plan_currency[]" value="<?php echo esc_attr($plan['currency']); ?>" placeholder="BDT" /></td>
              <td><input type="number" min="1" style="width:70px" name="dn_plan_days[]" value="<?php echo esc_attr($plan['durationDays']); ?>" placeholder="30" /></td>
              <td>
                <select name="dn_plan_access_mode[]" style="width:130px">
                  <option value="today_edition"<?php echo $am === 'today_edition' ? ' selected' : ''; ?>>Today\'s Edition</option>
                  <option value="archive_access"<?php echo $am === 'archive_access' ? ' selected' : ''; ?>>Full Archive</option>
                </select>
              </td>
              <td><input type="text" class="regular-text" name="dn_plan_desc[]" value="<?php echo esc_attr($plan['description'] ?? ''); ?>" placeholder="Optional short description" /></td>
              <td><input type="url" class="regular-text" name="dn_plan_url[]" value="<?php echo esc_attr($plan['checkoutUrl'] ?? ''); ?>" placeholder="https://wp.example.com/?dn_buy=ID" /></td>
              <td><button type="button" class="button dn-remove-plan" title="Remove">✕</button></td>
            </tr>
            <?php endforeach; endif; ?>
          </tbody>
        </table>

        <button type="button" class="button" id="dn-add-plan">＋ Add Plan</button>
        <button type="button" class="button button-primary" id="dn-save-plans" style="margin-left:8px">Save Plans</button>
        <span id="dn-plans-status" style="margin-left:10px;color:#46b450;display:none">✔ Saved!</span>
        <span id="dn-plans-error" style="margin-left:10px;color:#dc3232;display:none"></span>
      </div>

      <script>
      (function($) {
        var rowTemplate = function(idx) {
          return '<tr class="dn-plan-row" data-idx="' + idx + '">' +
            '<td style="color:#888;font-size:12px">' + (idx+1) + '</td>' +
            '<td><input type="text" class="regular-text" name="dn_plan_name[]" placeholder="Monthly" required /></td>' +
            '<td><input type="text" style="width:80px" name="dn_plan_price[]" placeholder="299" /></td>' +
            '<td><input type="text" style="width:60px" name="dn_plan_currency[]" placeholder="BDT" /></td>' +
            '<td><input type="number" min="1" style="width:70px" name="dn_plan_days[]" placeholder="30" /></td>' +
            '<td><select name="dn_plan_access_mode[]" style="width:130px">' +
              '<option value="today_edition">Today\'s Edition</option>' +
              '<option value="archive_access">Full Archive</option>' +
            '</select></td>' +
            '<td><input type="text" class="regular-text" name="dn_plan_desc[]" placeholder="Optional short description" /></td>' +
            '<td><input type="url" class="regular-text" name="dn_plan_url[]" placeholder="https://…/?dn_buy=ID" /></td>' +
            '<td><button type="button" class="button dn-remove-plan" title="Remove">✕</button></td>' +
          '</tr>';
        };

        function reindex() {
          $('#dn-plans-body .dn-plan-row').each(function(i, row) {
            $(row).find('td:first').text(i + 1);
          });
        }

        $('#dn-add-plan').on('click', function() {
          $('#dn-no-plans-row').remove();
          var idx = $('#dn-plans-body .dn-plan-row').length;
          $('#dn-plans-body').append(rowTemplate(idx));
        });

        $('#dn-plans-body').on('click', '.dn-remove-plan', function() {
          $(this).closest('tr').remove();
          reindex();
          if ($('#dn-plans-body .dn-plan-row').length === 0) {
            $('#dn-plans-body').append('<tr id="dn-no-plans-row"><td colspan="9" style="color:#888;padding:16px 8px">No plans yet. Click "Add Plan" to create one.</td></tr>');
          }
        });

        $('#dn-save-plans').on('click', function() {
          var plans = [];
          $('#dn-plans-body .dn-plan-row').each(function(i, row) {
            var name = $(row).find('[name="dn_plan_name[]"]').val().trim();
            if (!name) return;
            plans.push({
              id:           i + 1,
              name:         name,
              price:        $(row).find('[name="dn_plan_price[]"]').val().trim() || '0',
              currency:     $(row).find('[name="dn_plan_currency[]"]').val().trim() || 'BDT',
              durationDays: parseInt($(row).find('[name="dn_plan_days[]"]').val(), 10) || 30,
              accessMode:   $(row).find('[name="dn_plan_access_mode[]"]').val() || 'today_edition',
              description:  $(row).find('[name="dn_plan_desc[]"]').val().trim(),
              checkoutUrl:  $(row).find('[name="dn_plan_url[]"]').val().trim(),
            });
          });

          var $btn = $('#dn-save-plans').prop('disabled', true).text('Saving…');
          $('#dn-plans-status, #dn-plans-error').hide();

          $.ajax({
            url: '<?php echo esc_js(rest_url('digital-newspaper/v1/subscription/plans')); ?>',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(plans),
            beforeSend: function(xhr) {
              xhr.setRequestHeader('X-WP-Nonce', '<?php echo esc_js(wp_create_nonce('wp_rest')); ?>');
            },
            success: function(res) {
              $btn.prop('disabled', false).text('Save Plans');
              $('#dn-plans-status').text('✔ Saved!').show().delay(3000).fadeOut();
            },
            error: function(xhr) {
              $btn.prop('disabled', false).text('Save Plans');
              var msg = xhr.responseJSON && xhr.responseJSON.message ? xhr.responseJSON.message : 'Save failed.';
              $('#dn-plans-error').text('✗ ' + msg).show();
            }
          });
        });
      })(jQuery);
      </script>
    </div>
    <?php
  }

  // ---------------------------------------------------------------------------
  // License key validation
  // ---------------------------------------------------------------------------

  /**
   * Ensures the HMAC signing secret exists.
   *
   * Priority order:
   *  1. DN_LICENSE_SECRET constant already defined (e.g. by an older wp-config.php entry).
   *  2. Secret stored in wp_options (written on a previous load).
   *  3. Auto-generate a new secret, persist it in wp_options, and attempt to write
   *     it to wp-config.php so future PHP processes pick it up as a constant.
   *
   * Called on the 'init' hook at priority 0.
   */
  public function ensure_license_secret(): void {
    // Case 1: wp-config.php (or earlier define()) already has it.
    if (defined('DN_LICENSE_SECRET') && DN_LICENSE_SECRET
        && DN_LICENSE_SECRET !== 'CHANGE_ME_TO_A_STRONG_RANDOM_SECRET') {
      // Mirror into options so get_license_secret() always has a DB fallback.
      if (!get_option(self::OPTION_LICENSE_SECRET)) {
        update_option(self::OPTION_LICENSE_SECRET, DN_LICENSE_SECRET, false);
      }
      return;
    }

    // Case 2: already stored in options from a previous run.
    $stored = (string) get_option(self::OPTION_LICENSE_SECRET, '');
    if ($stored) {
      if (!defined('DN_LICENSE_SECRET')) {
        define('DN_LICENSE_SECRET', $stored);
      }
      return;
    }

    // Case 3: first time — generate, persist, and try to bake into wp-config.php.
    try {
      $secret = bin2hex(random_bytes(32));
    } catch (\Exception $e) {
      $secret = sha1(uniqid('dn_', true) . wp_generate_password(32, true, true));
    }

    // Persist in DB first (guaranteed to work even if wp-config.php isn't writable).
    update_option(self::OPTION_LICENSE_SECRET, $secret, false);

    // Try to bake it into wp-config.php so it survives option-table clears.
    $this->write_secret_to_wpconfig($secret);

    if (!defined('DN_LICENSE_SECRET')) {
      define('DN_LICENSE_SECRET', $secret);
    }
  }

  /**
   * Attempts to write the DN_LICENSE_SECRET define() line into wp-config.php.
   * Silently returns false if the file isn't writable — the options-table copy is
   * always used as the authoritative fallback.
   */
  private function write_secret_to_wpconfig(string $secret): bool {
    // WordPress keeps wp-config.php either in ABSPATH or one directory above.
    $candidates = [
      ABSPATH . 'wp-config.php',
      dirname(ABSPATH) . '/wp-config.php',
    ];

    $config_file = '';
    foreach ($candidates as $path) {
      if (is_file($path) && is_readable($path)) {
        $config_file = $path;
        break;
      }
    }

    if (!$config_file || !is_writable($config_file)) {
      return false;
    }

    $contents = file_get_contents($config_file);
    if ($contents === false) {
      return false;
    }

    // Don't overwrite an existing definition.
    if (strpos($contents, 'DN_LICENSE_SECRET') !== false) {
      return false;
    }

    $line = "\ndefine( 'DN_LICENSE_SECRET', '" . addslashes($secret) . "' ); // Auto-added by Digital Newspaper Plugin\n";

    // Insert before the standard "stop editing" marker.
    $marker = "/* That's all, stop editing!";
    if (strpos($contents, $marker) !== false) {
      $contents = str_replace($marker, $line . $marker, $contents);
    } else {
      // Fallback: insert before the final close-tag or append to end.
      $last_close = strrpos($contents, '?' . '>');
      if ($last_close !== false) {
        $contents = substr($contents, 0, $last_close) . $line . substr($contents, $last_close);
      } else {
        $contents .= $line;
      }
    }

    return (bool) file_put_contents($config_file, $contents, LOCK_EX);
  }

  /**
   * Returns the effective HMAC signing secret.
   * Reads from the runtime constant first, then falls back to wp_options.
   */
  private function get_license_secret(): string {
    if (defined('DN_LICENSE_SECRET') && DN_LICENSE_SECRET) {
      return DN_LICENSE_SECRET;
    }
    return (string) get_option(self::OPTION_LICENSE_SECRET, '');
  }

  /**
   * sanitize_callback for the license key option.
   * Validates, decodes and caches the payload to OPTION_LICENSE_DATA.
   * Adds an admin notice on error.
   */
  public function sanitize_and_store_license_key(string $value): string {
    // Strip all whitespace so pasted keys with line-wrapping are accepted.
    $value = preg_replace('/\s+/', '', $value);
    if ($value === '') {
      delete_option(self::OPTION_LICENSE_DATA);
      return '';
    }

    $result = $this->validate_license_key($value);
    if (is_wp_error($result)) {
      add_settings_error(
        self::OPTION_LICENSE_KEY,
        'dn_license_invalid',
        '⚠ License key error: ' . $result->get_error_message(),
        'error'
      );
      // Keep the old valid license if one exists, reject the bad new key.
      return (string) get_option(self::OPTION_LICENSE_KEY, '');
    }

    update_option(self::OPTION_LICENSE_DATA, $result, false);
    return $value;
  }

  /**
   * Validates the given license key string.
   *
   * Returns the decoded payload array on success, or WP_Error on failure.
   * The shared secret must be defined in wp-config.php as DN_LICENSE_SECRET.
   *
   * @param  string $key The raw license key (starts with "DN1-…").
   * @return array|WP_Error
   */
  private function validate_license_key(string $key) {
    $secret = $this->get_license_secret();
    if (!$secret) {
      return new WP_Error('dn_license_no_secret', 'Signing secret is not available yet. Please reload this page and try again.');
    }

    // Remove any whitespace introduced by terminal line-wrapping or copy-paste.
    $key = preg_replace('/\s+/', '', $key);

    // Strip prefix
    if (strncmp($key, 'DN1-', 4) !== 0) {
      return new WP_Error('dn_license_format', 'Key must start with "DN1-".');
    }
    $b64 = substr($key, 4);

    // Restore standard base64 from URL-safe variant
    $remainder = strlen($b64) % 4;
    if ($remainder) {
      $b64 .= str_repeat('=', 4 - $remainder);
    }
    $json = base64_decode(strtr($b64, '-_', '+/'), true);
    if ($json === false) {
      return new WP_Error('dn_license_format', 'Invalid base64 encoding.');
    }

    $payload = json_decode($json, true);
    if (!is_array($payload)) {
      return new WP_Error('dn_license_format', 'Could not decode license payload.');
    }

    // Verify required fields
    foreach (['client', 'domain', 'package', 'expires', 'issued', 'sig'] as $field) {
      if (!isset($payload[$field])) {
        return new WP_Error('dn_license_fields', "Missing field: $field.");
      }
    }

    // Reconstruct the canonical string that was signed (sig field excluded)
    $sig = $payload['sig'];
    unset($payload['sig']);
    $fields_to_sign = $payload;
    ksort($fields_to_sign);
    $canonical = json_encode($fields_to_sign, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $expected_sig = hash_hmac('sha256', $canonical, $secret);

    if (!hash_equals($expected_sig, $sig)) {
      return new WP_Error('dn_license_sig', 'License signature is invalid. The signing secret on this site does not match the one used to generate this key.');
    }

    // Put sig back for storage
    $payload['sig'] = $sig;

    // Verify domain matches this WordPress installation
    $site_host = wp_parse_url(get_site_url(), PHP_URL_HOST);
    $license_host = preg_replace('#^https?://#i', '', $payload['domain']);
    $license_host = rtrim($license_host, '/');
    if ($site_host !== $license_host) {
      return new WP_Error(
        'dn_license_domain',
        sprintf('This key is for domain "%s" but this site runs on "%s".', $license_host, $site_host)
      );
    }

    // Verify expiry
    if ($payload['expires'] !== 'never') {
      $expires_ts = strtotime($payload['expires']);
      if ($expires_ts === false || $expires_ts < time()) {
        return new WP_Error('dn_license_expired', sprintf('This license expired on %s.', $payload['expires']));
      }
    }

    // Validate package value
    if (!in_array($payload['package'], ['starter', 'publisher'], true)) {
      return new WP_Error('dn_license_package', 'Unknown package tier in license.');
    }

    return $payload;
  }

  /** Returns the stored decoded license payload, or null if none / invalid. */
  private function get_license_data(): ?array {
    $data = get_option(self::OPTION_LICENSE_DATA, null);
    return is_array($data) ? $data : null;
  }

  /** Returns a human-readable license status string for the settings page. */
  private function get_license_status_html(): string {
    $key  = (string) get_option(self::OPTION_LICENSE_KEY, '');
    $data = $this->get_license_data();

    if (!$key) {
      return '<span style="color:#888">No license key entered.</span>';
    }
    if (!$data) {
      return '<span style="color:#dc3232">&#10007; Invalid or expired license.</span>';
    }

    $package = strtoupper($data['package'] ?? '');
    $expires = $data['expires'] === 'never' ? 'Never expires' : 'Expires ' . esc_html($data['expires']);
    $client  = esc_html($data['client'] ?? '');
    return sprintf(
      '<span style="color:#46b450">&#10003; Active</span> &mdash; <strong>%s</strong> / %s / %s',
      $package, $client, $expires
    );
  }

  public function sanitize_origins($value): string {
    $parts = array_filter(array_map('trim', explode(',', (string) $value)));
    $parts = array_map(function ($origin) {
      return esc_url_raw($origin);
    }, $parts);
    return implode(', ', $parts);
  }

  public function get_data(): array {
    $data = get_option(self::OPTION_KEY);
    if (!is_array($data)) {
      $data = self::default_data();
    }
    return $data;
  }

  public function save_data(array $data): void {
    update_option(self::OPTION_KEY, $data, false);
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

    register_rest_route('digital-newspaper/v1', '/auth/login', [
      [
        'methods' => 'POST',
        'callback' => [$this, 'login'],
        'permission_callback' => '__return_true'
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/auth/register', [
      [
        'methods' => 'POST',
        'callback' => [$this, 'register_user'],
        'permission_callback' => '__return_true'
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/auth/logout', [
      [
        'methods'             => 'POST',
        'callback'            => [$this, 'logout'],
        'permission_callback' => [$this, 'subscriber_auth_required'],
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

    // --- Subscription endpoints -------------------------------------------

    register_rest_route('digital-newspaper/v1', '/subscription/plans', [
      [
        'methods' => 'GET',
        'callback' => [$this, 'get_subscription_plans_endpoint'],
        'permission_callback' => '__return_true'
      ],
      [
        'methods' => 'POST',
        'callback' => [$this, 'post_subscription_plans_endpoint'],
        'permission_callback' => [$this, 'auth_required']
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/subscription/status', [
      [
        'methods' => 'GET',
        'callback' => [$this, 'get_subscription_status_endpoint'],
        'permission_callback' => [$this, 'subscriber_auth_required']
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/subscription/checkout', [
      [
        'methods' => 'POST',
        'callback' => [$this, 'post_subscription_checkout_endpoint'],
        'permission_callback' => [$this, 'subscriber_auth_required']
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/subscription/orders', [
      [
        'methods'             => 'GET',
        'callback'            => [$this, 'get_subscription_orders_endpoint'],
        'permission_callback' => [$this, 'auth_required']
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/subscription/orders/(?P<userId>\d+)', [
      [
        'methods'             => 'DELETE',
        'callback'            => [$this, 'delete_subscription_order_endpoint'],
        'permission_callback' => [$this, 'auth_required'],
        'args'                => [
          'userId' => [
            'required'          => true,
            'validate_callback' => fn($v) => is_numeric($v) && (int) $v > 0,
            'sanitize_callback' => 'absint',
          ],
        ],
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/subscription/settings', [
      [
        'methods' => 'GET',
        'callback' => [$this, 'get_subscription_settings_endpoint'],
        'permission_callback' => [$this, 'auth_required']
      ],
      [
        'methods' => 'POST',
        'callback' => [$this, 'post_subscription_settings_endpoint'],
        'permission_callback' => [$this, 'auth_required']
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/auth/checkout-token', [
      [
        'methods'             => 'POST',
        'callback'            => [$this, 'post_auth_checkout_token_endpoint'],
        'permission_callback' => [$this, 'subscriber_auth_required'],
      ]
    ]);
  }

  /**
   * POST /auth/checkout-token
   *
   * Issues a short-lived, one-time token that the Angular app appends to the
   * WooCommerce checkout URL (?dn_token=…).  When WordPress loads that URL,
   * handle_clean_checkout_redirect() validates the token, logs the user in via
   * wp_set_auth_cookie(), and then redirects back without the token so the
   * subsequent checkout page request has a clean WooCommerce session for the
   * correct user.
   *
   * Token properties:
   *  - 48-char lowercase hex string (24 random bytes via random_bytes).
   *  - Stored as a WordPress transient keyed "dn_otp_{token}" → user_id.
   *  - Expires after 5 minutes; deleted on first use (truly one-time).
   */
  public function post_auth_checkout_token_endpoint(WP_REST_Request $request): WP_REST_Response {
    $user = wp_get_current_user();
    if (!$user || !$user->ID) {
      return new WP_REST_Response(['error' => 'Unauthorized'], 401);
    }

    $otp = bin2hex(random_bytes(24)); // 48-char hex, cryptographically secure
    set_transient('dn_otp_' . $otp, $user->ID, 5 * MINUTE_IN_SECONDS);

    return rest_ensure_response(['token' => $otp]);
  }

  public function get_data_endpoint(
    WP_REST_Request $request
  ): WP_REST_Response {
    $data = $this->get_data();
    // Embed subscription settings so Angular can override compile-time defaults.
    if (!isset($data['settings']) || !is_array($data['settings'])) {
      $data['settings'] = [];
    }
    $data['settings']['subscription'] = $this->get_subscription_settings_for_response();
    return rest_ensure_response($data);
  }

  public function post_data_endpoint(
    WP_REST_Request $request
  ): WP_REST_Response {
    $payload = $request->get_json_params();
    if (!is_array($payload)) {
      return new WP_REST_Response(['error' => 'Invalid payload'], 400);
    }

    $this->save_data($payload);

    return rest_ensure_response([
      'success' => true,
      'message' => 'Data saved successfully'
    ]);
  }

  public function login(WP_REST_Request $request) {
    $params = $request->get_json_params();
    $username = $params['username'] ?? '';
    $password = $params['password'] ?? '';

    if (!$username || !$password) {
      return new WP_REST_Response(['error' => 'Missing credentials'], 400);
    }

    $user = wp_authenticate($username, $password);
    if (is_wp_error($user)) {
      return new WP_REST_Response(['error' => 'Invalid credentials'], 401);
    }

    $token = $this->generate_token($user->ID);

    // Include subscription status in the login response so the Angular app can
    // seed its cache immediately without a separate /subscription/status call.
    $sub = $this->get_user_subscription_status($user->ID);

    return rest_ensure_response([
      'token' => $token,
      'user' => [
        'id'           => $user->ID,
        'username'     => $user->user_login,
        'email'        => $user->user_email,
        'displayName'  => $user->display_name,
        'isAdmin'      => user_can($user, 'edit_posts'),
        'subscription' => [
          'hasActiveSubscription' => $sub['hasActiveSubscription'],
          'expiresAt'             => $sub['expiresAt']  ?? null,
          'plan'                  => $sub['plan']       ?? null,
          'planSlug'              => $sub['planSlug']   ?? null,
        ],
      ]
    ]);
  }

  /**
   * Action: admin_init
   * Redirects any logged-in user who lacks the 'edit_posts' capability away
   * from the WordPress admin dashboard back to the Angular app.
   * AJAX requests (admin-ajax.php) are excluded so WooCommerce keeps working.
   */
  public function block_nonadmin_wp_access(): void {
    if (!is_user_logged_in() || wp_doing_ajax()) {
      return;
    }
    if (!user_can(get_current_user_id(), 'edit_posts')) {
      $settings  = (array) get_option(self::OPTION_SUBSCRIPTION_SETTINGS, []);
      $app_url   = !empty($settings['loginUrl']) ? $settings['loginUrl'] : home_url('/');
      wp_safe_redirect($app_url);
      exit;
    }
  }

  public function logout(): WP_REST_Response {
    $user = wp_get_current_user();
    if ($user && $user->ID) {
      // Destroy the browser session cookie so the WP/WooCommerce session
      // for this user is cleared on the server side.
      wp_logout();
    }
    return rest_ensure_response(['success' => true]);
  }

  public function me(): WP_REST_Response {
    $user = wp_get_current_user();
    if (!$user || !$user->ID) {
      return new WP_REST_Response(['error' => 'Unauthorized'], 401);
    }

    $sub_status = $this->get_user_subscription_status($user->ID);

    return rest_ensure_response([
      'id'           => $user->ID,
      'username'     => $user->user_login,
      'email'        => $user->user_email,
      'displayName'  => $user->display_name,
      'isAdmin'      => user_can($user, 'edit_posts'),
      'subscription' => [
        'hasActiveSubscription' => $sub_status['hasActiveSubscription']
      ]
    ]);
  }

  public function register_user(WP_REST_Request $request): WP_REST_Response {
    $params   = $request->get_json_params();
    $username = sanitize_user(trim($params['username'] ?? ''));
    $email    = sanitize_email(trim($params['email']    ?? ''));
    $password = $params['password'] ?? '';

    if (!$username || !$email || !$password) {
      return new WP_REST_Response(['error' => 'All fields are required.'], 400);
    }

    if (!is_email($email)) {
      return new WP_REST_Response(['error' => 'Please enter a valid email address.'], 400);
    }

    if (mb_strlen($password) < 6) {
      return new WP_REST_Response(['error' => 'Password must be at least 6 characters.'], 400);
    }

    if (username_exists($username)) {
      return new WP_REST_Response(['error' => 'That username is already taken.'], 409);
    }

    if (email_exists($email)) {
      return new WP_REST_Response(['error' => 'An account with that email address already exists.'], 409);
    }

    $user_id = wp_create_user($username, $password, $email);

    if (is_wp_error($user_id)) {
      return new WP_REST_Response(['error' => $user_id->get_error_message()], 400);
    }

    // Send WP's new-user notification email.
    wp_new_user_notification($user_id, null, 'user');

    $token = $this->generate_token($user_id);
    $user  = get_userdata($user_id);

    return rest_ensure_response([
      'token' => $token,
      'user'  => [
        'id'          => $user->ID,
        'username'    => $user->user_login,
        'email'       => $user->user_email,
        'displayName' => $user->display_name,
        'subscription' => [
          'hasActiveSubscription' => false,
          'expiresAt'             => null,
          'plan'                  => null,
          'planSlug'              => null,
        ],
      ],
    ]);
  }

  public function proxy_image(WP_REST_Request $request) {
    $url = $request->get_param('url');
    if (!$url) {
      return new WP_REST_Response(['error' => 'Missing url'], 400);
    }

    // Only allow proxying images from the same WordPress host or trusted domains
    $parsed = wp_parse_url($url);
    $home_host = wp_parse_url(home_url(), PHP_URL_HOST);
    $allowed_hosts = apply_filters('dn_proxy_allowed_hosts', [$home_host]);
    if (empty($parsed['host']) || !in_array($parsed['host'], $allowed_hosts, true)) {
      return new WP_REST_Response(['error' => 'URL not allowed'], 403);
    }

    // Validate it resolves to an image path
    $scheme = $parsed['scheme'] ?? '';
    if (!in_array($scheme, ['http', 'https'], true)) {
      return new WP_REST_Response(['error' => 'Invalid URL scheme'], 400);
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

    return new WP_REST_Response($body, 200, [
      'Content-Type' => $content_type,
      'Cache-Control' => 'public, max-age=86400'
    ]);
  }

  // ---------------------------------------------------------------------------
  // Subscription endpoints
  // ---------------------------------------------------------------------------

  /**
   * GET /subscription/plans
   * Public. Returns stored plans first; falls back to WooCommerce products tagged
   * with SUBSCRIPTION_PLAN_TAG if no plans are stored yet.
   */
  public function get_subscription_plans_endpoint(WP_REST_Request $request): WP_REST_Response {
    $plans = $this->get_stored_plans();
    if (!empty($plans)) {
      // Back-fill slug for plans saved before the slug field was introduced,
      // so Angular always receives a non-empty slug for every plan.
      foreach ($plans as &$plan) {
        if (empty($plan['slug']) && !empty($plan['name'])) {
          $plan['slug'] = sanitize_title($plan['name']);
        }
      }
      unset($plan);
      return rest_ensure_response($plans);
    }

    // Fallback: read from WooCommerce products (legacy path).
    if (!function_exists('wc_get_products')) {
      return rest_ensure_response([]);
    }

    $products = wc_get_products([
      'status' => 'publish',
      'limit'  => 50,
      'tag'    => [self::SUBSCRIPTION_PLAN_TAG],
    ]);

    $plans = [];
    foreach ($products as $product) {
      $duration = absint($product->get_meta('_dn_duration_days', true));
      $plans[] = [
        'id'          => $product->get_id(),
        'name'        => $product->get_name(),
        'slug'        => $product->get_slug(),
        'price'       => (string) $product->get_price(),
        'currency'    => function_exists('get_woocommerce_currency') ? get_woocommerce_currency() : 'BDT',
        'durationDays'=> $duration ?: 30,
        'checkoutUrl' => add_query_arg('dn_buy', $product->get_id(), home_url('/')), // clean-cart checkout
      ];
    }

    return rest_ensure_response($plans);
  }

  /**
   * POST /subscription/plans
   * Admin only. Replaces the full plan list with the submitted array.
   * Each plan: { name, slug, price, currency, durationDays, description?, checkoutUrl? }
   */
  public function post_subscription_plans_endpoint(WP_REST_Request $request): WP_REST_Response {
    $body = $request->get_json_params();
    if (!is_array($body)) {
      return new WP_REST_Response(['error' => 'Invalid payload'], 400);
    }

    $plans = [];
    foreach ($body as $i => $p) {
      if (!is_array($p)) continue;
      $name = sanitize_text_field($p['name'] ?? '');
      if (!$name) continue; // skip blank entries

      // Preserve numeric WC product ID when present (non-zero); generate a
      // simple sequential fallback for manually-created plans.
      $id = isset($p['id']) && (int) $p['id'] > 0 ? (int) $p['id'] : ($i + 1);

      $raw_mode   = sanitize_text_field($p['accessMode'] ?? 'today_edition');
      $access_mode = in_array($raw_mode, ['today_edition', 'archive_access'], true) ? $raw_mode : 'today_edition';

      $plans[] = [
        'id'           => $id,
        'name'         => $name,
        'slug'         => sanitize_title($p['slug'] ?? $name),
        'price'        => sanitize_text_field((string) ($p['price'] ?? '0')),
        'currency'     => sanitize_text_field($p['currency'] ?? 'BDT'),
        'durationDays' => max(1, (int) ($p['durationDays'] ?? 30)),
        'accessMode'   => $access_mode,
        'description'  => sanitize_text_field($p['description'] ?? ''),
        'checkoutUrl'  => esc_url_raw($p['checkoutUrl'] ?? ''),
      ];
    }

    update_option(self::OPTION_PLANS, $plans, false);
    return rest_ensure_response(['success' => true, 'plans' => $plans]);
  }

  /** Returns stored plans from wp_options, or empty array if none. */
  private function get_stored_plans(): array {
    $plans = get_option(self::OPTION_PLANS, []);
    return is_array($plans) ? $plans : [];
  }

  /**
   * GET /subscription/status
   * Requires Bearer token (any authenticated WordPress user).
   * Returns the subscription status for the token owner.
   */
  public function get_subscription_status_endpoint(WP_REST_Request $request): WP_REST_Response {
    $user = wp_get_current_user();
    if (!$user || !$user->ID) {
      return new WP_REST_Response(['error' => 'Unauthorized'], 401);
    }
    return rest_ensure_response($this->get_user_subscription_status($user->ID));
  }

  /**
   * POST /subscription/checkout
   * Requires Bearer token. Validates planId against WC products and returns a
   * WooCommerce add-to-cart checkout URL with an optional return_url parameter.
   *
   * Body: { "planId": int, "returnUrl": string }
   */
  public function post_subscription_checkout_endpoint(WP_REST_Request $request): WP_REST_Response {
    $params     = $request->get_json_params();
    $plan_id    = isset($params['planId']) ? absint($params['planId']) : 0;
    $return_url = isset($params['returnUrl']) ? esc_url_raw((string) $params['returnUrl']) : '';

    if (!$plan_id) {
      return new WP_REST_Response(['error' => 'Missing planId'], 400);
    }

    // Validate returnUrl host against allowed origins to prevent open redirects.
    if ($return_url) {
      $parsed       = wp_parse_url($return_url);
      $return_host  = ($parsed['scheme'] ?? '') . '://' . ($parsed['host'] ?? '');
      $allowed      = $this->get_allowed_origins();
      if ($allowed && !in_array($return_host, $allowed, true)) {
        return new WP_REST_Response(['error' => 'returnUrl not in allowed origins'], 400);
      }
    }

    // Block purchase if the user already has an active subscription.
    $user   = wp_get_current_user();
    $status = $this->get_user_subscription_status($user->ID);
    if (!empty($status['hasActiveSubscription'])) {
      return new WP_REST_Response([
        'error'     => 'already_subscribed',
        'expiresAt' => $status['expiresAt'] ?? null,
        'plan'      => $status['plan']      ?? null,
      ], 409);
    }

    // --- Path 1: Stored plan with its own checkoutUrl ---
    $stored_plans = $this->get_stored_plans();
    foreach ($stored_plans as $plan) {
      if ((int) ($plan['id'] ?? 0) === $plan_id && !empty($plan['checkoutUrl'])) {
        $checkout_url = add_query_arg('dn_return', rawurlencode($return_url), $plan['checkoutUrl']);
        return rest_ensure_response(['checkoutUrl' => esc_url_raw($checkout_url)]);
      }
    }

    // --- Path 2: WooCommerce product ---
    if (!function_exists('wc_get_checkout_url')) {
      return new WP_REST_Response(['error' => 'WooCommerce is not active'], 503);
    }

    $product = wc_get_product($plan_id);
    if (!$product || !$product->is_purchasable()) {
      return new WP_REST_Response(['error' => 'Plan not found'], 404);
    }

    if ($return_url && $user->ID) {
      set_transient('dn_return_' . $user->ID, $return_url, 2 * HOUR_IN_SECONDS);
    }

    // Use the clean-cart endpoint so no leftover items end up in the cart.
    $checkout_url = add_query_arg('dn_buy', $plan_id, home_url('/'));

    return rest_ensure_response(['checkoutUrl' => esc_url_raw($checkout_url)]);
  }

  /**
   * Filter: woocommerce_checkout_fields
   * Removes shipping and non-essential billing fields from the WooCommerce
   * checkout page. Subscription plans are digital — no physical address is needed.
   */
  public function customize_checkout_fields(array $fields): array {
    // Remove the entire shipping section.
    unset($fields['shipping']);

    // Hide the "Ship to a different address?" toggle.
    unset($fields['ship_to_different_address']);

    // Remove billing fields that are irrelevant for a digital purchase.
    $remove_billing = [
      'billing_company',
      'billing_address_1',
      'billing_address_2',
      'billing_postcode',
      'billing_state',
      'billing_phone',
    ];
    foreach ($remove_billing as $field) {
      unset($fields['billing'][$field]);
    }

    return $fields;
  }

  /**
   * Hook: woocommerce_thankyou (priority 10 — runs after on_order_thankyou)
   * Shows a "Return to Digital Newspaper" button on the order-received page.
   * Acts as a fallback for guest orders (which cannot be auto-redirected because
   * the transient is keyed by user ID) and for cases where the redirect is
   * blocked by the browser.
   */
  public function show_return_to_app_button(int $order_id): void {
    $settings = (array) get_option(self::OPTION_SUBSCRIPTION_SETTINGS, []);
    $app_url  = !empty($settings['loginUrl']) ? $settings['loginUrl'] : home_url('/');

    // Determine which items are in this order so we can build a targeted return URL.
    $return_url = $app_url;

    // If a dn_return transient is still set for this user, prefer it (it carries
    // the exact Angular page the user was on, including any ?sub=pending marker).
    $user_id = 0;
    if (function_exists('wc_get_order')) {
      $order   = wc_get_order($order_id);
      $user_id = $order ? (int) $order->get_user_id() : 0;
    }

    if ($user_id) {
      $transient_url = (string) get_transient('dn_return_' . $user_id);
      if ($transient_url) {
        $return_url = $transient_url;
        // Leave the transient intact — on_order_thankyou (priority 5) will
        // consume and redirect for auto-redirect capable browsers; this button
        // is the manual fallback.
      }
    }

    // Append ?sub=pending so the Angular app knows to refresh subscription status.
    $return_url = add_query_arg('sub', 'pending', $return_url);

    echo '<div style="margin-top:28px;text-align:center">';
    echo '<a href="' . esc_url($return_url) . '" class="button button-primary wc-forward" style="font-size:1rem;padding:.75em 2em">';
    echo esc_html__('Return to Digital Newspaper', 'digital-newspaper');
    echo '</a>';
    echo '</div>';
  }

  /**
   * Hook: woocommerce_thankyou
   * Fires on the Order Received page after a successful payment.
   * If the order contains a DN subscription plan and we have a stored return URL
   * for this user, redirect the browser back to the Angular app.
   */
  public function on_order_thankyou(int $order_id): void {
    if (!function_exists('wc_get_order')) {
      return;
    }

    $order = wc_get_order($order_id);
    if (!$order) {
      return;
    }

    $user_id = $order->get_user_id();
    if (!$user_id) {
      return; // Guest — cannot link to a WP user.
    }

    // Only redirect if this order contains at least one DN subscription plan item.
    $has_plan = false;
    foreach ($order->get_items() as $item) {
      /** @var WC_Order_Item_Product $item */
      if (has_term(self::SUBSCRIPTION_PLAN_TAG, 'product_tag', $item->get_product_id())) {
        $has_plan = true;
        break;
      }
    }
    if (!$has_plan) {
      return;
    }

    $transient_key = 'dn_return_' . $user_id;
    $return_url = (string) get_transient($transient_key);

    // Fallback: the Angular app may have embedded dn_return in the checkout URL
    // directly (used for stored plans that bypass the /checkout endpoint).
    if (!$return_url) {
      $dn_return = isset($_GET['dn_return']) ? sanitize_text_field(wp_unslash($_GET['dn_return'])) : '';
      if ($dn_return) {
        $return_url = esc_url_raw($dn_return);
      }
    }

    if (!$return_url) {
      return;
    }

    delete_transient($transient_key);

    // Re-validate the URL against allowed origins before redirecting.
    $parsed      = wp_parse_url($return_url);
    $return_host = ($parsed['scheme'] ?? '') . '://' . ($parsed['host'] ?? '');
    $allowed     = $this->get_allowed_origins();
    if ($allowed && !in_array($return_host, $allowed, true)) {
      return;
    }

    // allowed_redirect_hosts filter adds the Angular app origins, so
    // wp_safe_redirect will accept the URL.
    wp_safe_redirect(esc_url_raw($return_url));
    exit;
  }

  /**
   * Action: template_redirect
   *
   * Handles the ?dn_buy=PRODUCT_ID query parameter — a clean-cart checkout
   * shortcut used by all stored plan checkoutUrls.
   *
   * Flow:
   *   1. Validates the product ID and that it is tagged as a subscription plan.
   *   2. Empties the WooCommerce cart completely.
   *   3. Adds only the requested plan (qty 1).
   *   4. Redirects to the WooCommerce checkout page.
   *
   * The optional ?dn_return param is stored in a transient so
   * on_order_thankyou() can send the user back to the Angular app.
   */
  public function handle_clean_checkout_redirect(): void {
    if (!isset($_GET['dn_buy'])) {
      return;
    }

    // -----------------------------------------------------------------------
    // Auto-login via one-time checkout token (dn_token).
    //
    // The Angular app obtains a short-lived OTP from POST /auth/checkout-token
    // and appends it to the checkout URL.  Here we:
    //   1. Validate and consume the token (one-time use).
    //   2. Swap to the correct WordPress user (even if an admin is currently
    //      logged in, preventing admin credentials from prefilling the form).
    //   3. Redirect back to the same URL *without* dn_token so the next
    //      request arrives with a proper WooCommerce session for that user.
    // -----------------------------------------------------------------------
    if (isset($_GET['dn_token'])) {
      $otp = sanitize_text_field(wp_unslash($_GET['dn_token']));

      // Only process well-formed hex OTPs (48 lowercase hex chars = 24 bytes).
      if (preg_match('/^[0-9a-f]{48}$/', $otp)) {
        $transient_key  = 'dn_otp_' . $otp;
        $target_user_id = (int) get_transient($transient_key);

        if ($target_user_id > 0) {
          delete_transient($transient_key); // consume — truly one-time

          if (get_current_user_id() !== $target_user_id) {
            // A different user (e.g., the WP admin) is logged in.
            // Log them out and log in the correct customer.
            wp_logout();
            wp_set_current_user($target_user_id);
            wp_set_auth_cookie($target_user_id, false);
          }

          // Redirect back to this URL without dn_token so the next request
          // has a clean WooCommerce cart/session for the authenticated user.
          $product_id_raw = absint($_GET['dn_buy'] ?? 0);
          $clean_url      = add_query_arg('dn_buy', $product_id_raw, home_url('/'));
          if (!empty($_GET['dn_return'])) {
            $clean_url = add_query_arg(
              'dn_return',
              rawurlencode(esc_url_raw(wp_unslash($_GET['dn_return']))),
              $clean_url
            );
          }
          wp_safe_redirect($clean_url);
          exit;
        }
        // Invalid / expired token — fall through and let WC handle the request
        // normally (user may already be logged in via cookie).
      }
    }

    if (!function_exists('wc_get_checkout_url') || !WC()->cart) {
      return;
    }

    $product_id = absint($_GET['dn_buy']);
    if (!$product_id) {
      return;
    }

    // Validate the WC product exists and is purchasable.
    // Security: even if someone guesses a product ID they still must complete
    // WooCommerce checkout with real payment — no bypass possible.
    $product = wc_get_product($product_id);
    if (!$product || !$product->is_purchasable()) {
      wp_die(esc_html__('Plan is currently unavailable.', 'digital-newspaper'), 400);
    }

    // Store the return URL for use after payment.
    $return_url = isset($_GET['dn_return']) ? esc_url_raw(wp_unslash($_GET['dn_return'])) : '';
    if ($return_url) {
      $user = wp_get_current_user();
      if ($user->ID) {
        set_transient('dn_return_' . $user->ID, $return_url, 2 * HOUR_IN_SECONDS);
      }
    }

    // Block if the user already has an active subscription.
    if (is_user_logged_in()) {
      $uid    = get_current_user_id();
      $status = $this->get_user_subscription_status($uid);
      if (!empty($status['hasActiveSubscription'])) {
        $expires = $status['expiresAt'] ?? '';
        wp_die(
          sprintf(
            esc_html__('You already have an active subscription (valid until %s). You can purchase a new plan after it expires.', 'digital-newspaper'),
            esc_html($expires)
          ),
          esc_html__('Already Subscribed', 'digital-newspaper'),
          ['response' => 409, 'link_url' => home_url(), 'link_text' => esc_html__('Go back', 'digital-newspaper')]
        );
      }
    }

    // Empty cart, then add only this plan.
    WC()->cart->empty_cart();
    WC()->cart->add_to_cart($product_id, 1);

    wp_safe_redirect(wc_get_checkout_url());
    exit;
  }

  /**
   * Filter: woocommerce_add_to_cart_validation
   *
   * Before any subscription plan product is added to the cart, remove all
   * existing cart items. This prevents the cart from accumulating multiple
   * plans (whether from the same or different users' lingering sessions)
   * regardless of how the product was added.
   *
   * @param bool $passed     Whether validation passed so far.
   * @param int  $product_id The product being added.
   * @return bool
   */
  public function enforce_single_plan_in_cart(bool $passed, int $product_id): bool {
    if (!$passed) {
      return false;
    }

    $stored_plans = $this->get_stored_plans();
    $is_plan = false;
    foreach ($stored_plans as $plan) {
      if ((int) ($plan['id'] ?? 0) === $product_id) {
        $is_plan = true; break;
      }
      if (!empty($plan['checkoutUrl'])) {
        $parsed = wp_parse_url($plan['checkoutUrl']);
        if (!empty($parsed['query'])) {
          parse_str($parsed['query'], $qvars);
          if (isset($qvars['dn_buy']) && (int) $qvars['dn_buy'] === $product_id) {
            $is_plan = true; break;
          }
        }
      }
    }
    if (!$is_plan) {
      return true; // Not a stored subscription plan — no intervention needed.
    }

    if (WC()->cart && !WC()->cart->is_empty()) {
      WC()->cart->empty_cart();
    }

    return true;
  }

  /**
   * Filter: allowed_redirect_hosts
   * Adds Angular app hostnames to the list WordPress considers safe for
   * wp_safe_redirect(), so post-payment redirects to the Angular domain work.
   */
  public function add_allowed_redirect_hosts(array $hosts): array {
    foreach ($this->get_allowed_origins() as $origin) {
      $parsed = wp_parse_url($origin);
      if (!empty($parsed['host'])) {
        $hosts[] = $parsed['host'];
      }
    }
    return $hosts;
  }

  // ---------------------------------------------------------------------------
  // Auto-complete helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the given WooCommerce order contains at least one DN
   * subscription plan item, identified either via the stored plans list
   * (checkoutUrl ?dn_buy=ID) or the 'dn-subscription-plan' product tag.
   */
  private function order_has_subscription_plan(\WC_Order $order): bool {
    $stored_plans     = $this->get_stored_plans();
    $plan_product_ids = [];
    foreach ($stored_plans as $plan) {
      if (!empty($plan['checkoutUrl'])) {
        $parsed = wp_parse_url($plan['checkoutUrl']);
        if (!empty($parsed['query'])) {
          parse_str($parsed['query'], $qvars);
          $wc_id = isset($qvars['dn_buy']) ? (int) $qvars['dn_buy'] : 0;
          if ($wc_id) {
            $plan_product_ids[] = $wc_id;
          }
        }
      }
    }

    foreach ($order->get_items() as $item) {
      /** @var WC_Order_Item_Product $item */
      $product_id = $item->get_product_id();
      if (in_array($product_id, $plan_product_ids, true)) {
        return true;
      }
      if (has_term(self::SUBSCRIPTION_PLAN_TAG, 'product_tag', $product_id)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Filter: woocommerce_payment_complete_order_status
   * For orders that contain a DN subscription plan, return 'completed' instead
   * of the default 'processing'. This fires immediately after payment is
   * confirmed by the gateway (Stripe, PayPal, etc.) so the subscription
   * activates without any manual admin action.
   */
  public function auto_complete_subscription_order_status(string $status, int $order_id): string {
    if (!function_exists('wc_get_order')) {
      return $status;
    }
    $order = wc_get_order($order_id);
    if ($order && $this->order_has_subscription_plan($order)) {
      return 'completed';
    }
    return $status;
  }

  /**
   * Hook: woocommerce_order_status_processing
   * Fallback for payment gateways that set the order to 'processing' without
   * going through payment_complete() (e.g. some offline/redirect gateways).
   * If the processing order contains a DN subscription plan, immediately
   * promote it to 'completed' so on_order_completed() activates the subscription.
   *
   * Note: 'on-hold' orders (BACS, cheque) are intentionally left alone because
   * payment has not yet been confirmed for those.
   */
  public function maybe_auto_complete_subscription_order(int $order_id): void {
    if (!function_exists('wc_get_order')) {
      return;
    }
    $order = wc_get_order($order_id);
    if ($order && $this->order_has_subscription_plan($order)) {
      $order->update_status(
        'completed',
        __('Auto-completed: digital subscription plan — no physical fulfilment required.', 'digital-newspaper')
      );
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * Hook: woocommerce_order_status_completed
   * Finds any subscription plan products in the completed order and extends the
   * user's subscription expiry date accordingly, stacking on top of any existing
   * unexpired subscription.
   */
  public function on_order_completed(int $order_id): void {
    if (!function_exists('wc_get_order')) {
      return;
    }

    $order = wc_get_order($order_id);
    if (!$order) {
      return;
    }

    $user_id = $order->get_user_id();
    if (!$user_id) {
      return; // Guest checkout — cannot link to a WP user.
    }

    // Build a set of known WC product IDs from stored plans (keyed by WC id → duration).
    $stored_plans  = $this->get_stored_plans();
    $plan_durations = []; // wc_product_id => durationDays
    $plan_slugs     = []; // wc_product_id => slug
    $plan_names     = []; // wc_product_id => DN plan name (NOT WC product name)
    foreach ($stored_plans as $plan) {
      $days = absint($plan['durationDays'] ?? 0);
      if (!$days) continue;
      // The WC product ID is stored inside the checkoutUrl as ?dn_buy=ID.
      if (!empty($plan['checkoutUrl'])) {
        $parsed = wp_parse_url($plan['checkoutUrl']);
        if (!empty($parsed['query'])) {
          parse_str($parsed['query'], $qvars);
          $wc_id = isset($qvars['dn_buy']) ? (int) $qvars['dn_buy'] : 0;
          if ($wc_id) {
            $plan_durations[$wc_id] = $days;
            // Derive slug from name when the slug field is absent (pre-slug plans).
            $plan_slugs[$wc_id] = sanitize_key($plan['slug'] ?? sanitize_title($plan['name'] ?? ''));
            // Store the DN plan name so it can be saved to user meta instead of
            // the WC product name. This ensures status.plan matches plan.name in Angular.
            $plan_names[$wc_id] = $plan['name'] ?? '';
          }
        }
      }
    }

    $max_duration = 0;
    $matched_plan_name = '';
    $matched_plan_slug = '';
    foreach ($order->get_items() as $item) {
      /** @var WC_Order_Item_Product $item */
      $product_id = $item->get_product_id();
      $duration   = 0;
      if (isset($plan_durations[$product_id])) {
        $duration = $plan_durations[$product_id];
      } else {
        // Fallback: also accept products tagged dn-subscription-plan with _dn_duration_days meta.
        if (has_term(self::SUBSCRIPTION_PLAN_TAG, 'product_tag', $product_id)) {
          $duration = absint(get_post_meta($product_id, '_dn_duration_days', true));
        }
      }
      if ($duration > $max_duration) {
        $max_duration = $duration;
        // Prefer the DN admin plan name over the WC product name so that
        // _dn_subscription_plan matches plan.name in the Angular plans list.
        // Fall back to the WC product name only for tagged-product subscriptions
        // that aren't in the DN admin settings.
        $matched_plan_name = $plan_names[$product_id] ?? $item->get_name();
        $matched_plan_slug = $plan_slugs[$product_id] ?? '';
      }
    }

    if ($max_duration <= 0) {
      return;
    }

    // Only activate if the user does NOT already have an active subscription.
    // A user may only hold one plan at a time; they can renew once it expires.
    $existing = (string) get_user_meta($user_id, self::SUBSCRIPTION_META_EXPIRES, true);
    if ($existing && strtotime($existing) > time()) {
      // Active subscription present — do not overwrite or stack.
      return;
    }

    $new_expires = gmdate('Y-m-d', time() + ($max_duration * DAY_IN_SECONDS));
    update_user_meta($user_id, self::SUBSCRIPTION_META_EXPIRES, $new_expires);
    update_user_meta($user_id, self::SUBSCRIPTION_META_ORDER_ID, $order_id);
    if ($matched_plan_name) {
      update_user_meta($user_id, '_dn_subscription_plan', $matched_plan_name);
    }
    if ($matched_plan_slug) {
      update_user_meta($user_id, self::SUBSCRIPTION_META_PLAN_SLUG, $matched_plan_slug);
    }
  }

  // ---------------------------------------------------------------------------
  // Private subscription helpers
  // ---------------------------------------------------------------------------

  /**
   * GET /subscription/orders — admin-only list of all users with subscriptions.
   */
  public function get_subscription_orders_endpoint(WP_REST_Request $request): WP_REST_Response {
    // Query all users who have the _dn_subscription_expires meta key set.
    $users = get_users([
      'meta_key'     => self::SUBSCRIPTION_META_EXPIRES,
      'meta_compare' => 'EXISTS',
      'number'       => 500,
      'orderby'      => 'meta_value',
      'order'        => 'DESC',
    ]);

    $rows = [];
    foreach ($users as $user) {
      $expires  = (string) get_user_meta($user->ID, self::SUBSCRIPTION_META_EXPIRES, true);
      $order_id = (int)    get_user_meta($user->ID, self::SUBSCRIPTION_META_ORDER_ID, true);
      $plan     = (string) get_user_meta($user->ID, '_dn_subscription_plan', true);
      $active   = $expires && strtotime($expires) > time();
      $rows[] = [
        'userId'    => $user->ID,
        'username'  => $user->user_login,
        'email'     => $user->user_email,
        'name'      => trim($user->first_name . ' ' . $user->last_name) ?: $user->display_name,
        'plan'      => $plan ?: '—',
        'orderId'   => $order_id ?: null,
        'expiresAt' => $expires,
        'active'    => $active,
      ];
    }

    // Sort: active first, then by expiry desc.
    usort($rows, fn($a, $b) => ($b['active'] <=> $a['active']) ?: strcmp($b['expiresAt'], $a['expiresAt']));

    return rest_ensure_response($rows);
  }

  /**
   * DELETE /subscription/orders/{userId} — admin revokes a user's active subscription.
   * Clears the subscription meta keys so the user immediately loses access.
   */
  public function delete_subscription_order_endpoint(WP_REST_Request $request): WP_REST_Response {
    $user_id = (int) $request->get_param('userId');

    // Verify the target user actually exists.
    if (!get_userdata($user_id)) {
      return new WP_REST_Response(['success' => false, 'message' => 'User not found.'], 404);
    }

    delete_user_meta($user_id, self::SUBSCRIPTION_META_EXPIRES);
    delete_user_meta($user_id, self::SUBSCRIPTION_META_ORDER_ID);
    delete_user_meta($user_id, '_dn_subscription_plan');
    delete_user_meta($user_id, self::SUBSCRIPTION_META_PLAN_SLUG);

    return new WP_REST_Response(['success' => true], 200);
  }

  /**
   * Returns the full subscription status array for a given WordPress user ID.
   * User ID must always come from the verified JWT — never from request input.
   */
  private function get_user_subscription_status(int $user_id): array {
    $expires  = (string) get_user_meta($user_id, self::SUBSCRIPTION_META_EXPIRES, true);
    $order_id = (int)    get_user_meta($user_id, self::SUBSCRIPTION_META_ORDER_ID, true);

    if (!$expires || strtotime($expires) < time()) {
      return ['hasActiveSubscription' => false];
    }

    // Read plan name and slug from user meta (stored by on_order_completed).
    $plan_name = (string) get_user_meta($user_id, '_dn_subscription_plan', true);
    $plan_slug = (string) get_user_meta($user_id, self::SUBSCRIPTION_META_PLAN_SLUG, true);

    // Fallback: resolve plan name from the WC order if meta is missing (old orders).
    if (!$plan_name && $order_id && function_exists('wc_get_order')) {
      $order = wc_get_order($order_id);
      if ($order) {
        foreach ($order->get_items() as $item) {
          $plan_name = $item->get_name();
          break;
        }
      }
    }

    // Retroactively resolve planSlug by matching against stored plans.
    // This fixes existing orders that pre-date the slug meta, and also
    // handles cases where the _dn_subscription_plan_slug meta was never written.
    // When the stored plan has no explicit slug (pre-slug-field plans), derive
    // it from the plan name using the same sanitize_title() logic used on save.
    if (!$plan_slug && $plan_name) {
      $stored_plans = $this->get_stored_plans();
      foreach ($stored_plans as $sp) {
        $sp_name = $sp['name'] ?? '';
        if ($sp_name && strcasecmp($sp_name, $plan_name) === 0) {
          $plan_slug = sanitize_key($sp['slug'] ?? sanitize_title($sp_name));
          break;
        }
      }
    }

    // Also try matching by WC product ID from the order when name matching fails.
    if (!$plan_slug && $order_id && function_exists('wc_get_order')) {
      $order = wc_get_order($order_id);
      if ($order) {
        foreach ($order->get_items() as $item) {
          $product_id = $item->get_product_id();
          foreach ($this->get_stored_plans() as $sp) {
            if (!empty($sp['checkoutUrl'])) {
              $parsed = wp_parse_url($sp['checkoutUrl']);
              if (!empty($parsed['query'])) {
                parse_str($parsed['query'], $qvars);
                if (isset($qvars['dn_buy']) && (int) $qvars['dn_buy'] === $product_id) {
                  $sp_name   = $sp['name'] ?? '';
                  $plan_slug = sanitize_key($sp['slug'] ?? sanitize_title($sp_name));
                  // Always override plan_name with the DN plan name so that
                  // status.plan matches plan.name in the Angular plans list,
                  // even when _dn_subscription_plan stored the WC product name.
                  $plan_name = $sp_name ?: ($plan_name ?: $item->get_name());
                  break 2;
                }
              }
            }
          }
        }
      }
    }

    return [
      'hasActiveSubscription' => true,
      'expiresAt'             => $expires,
      'plan'                  => $plan_name ?: null,
      'planSlug'              => $plan_slug  ?: null,
      'orderId'               => $order_id ?: null,
    ];
  }

  /** Returns the subscription settings block embedded in the /data response. */
  private function get_subscription_settings_for_response(): array {
    $settings = get_option(self::OPTION_SUBSCRIPTION_SETTINGS, null);
    if (!is_array($settings)) {
      $settings = self::default_subscription_settings();
    }

    $license = $this->get_license_data();
    if ($license) {
      // License takes precedence: a Starter license forces the feature off;
      // a Publisher license exposes the package and allowed modes.
      $settings['package'] = $license['package'];

      if ($license['package'] === 'starter') {
        // Starter: subscription enforcement is always off regardless of manual settings.
        $settings['enabled'] = false;
      } else {
        // Publisher: honour the manual "enabled" toggle but restrict to licensed modes.
        // Migrate legacy mode names in license payload.
        $raw_modes = $license['modes'] ?? ['today_edition', 'archive_access'];
        $licensed_modes = array_values(array_unique(array_map(function($m) {
          if ($m === 'both' || $m === 'today_only') return 'today_edition';
          if ($m === 'first_page_free') return 'archive_access';
          return $m;
        }, $raw_modes)));
        // Migrate stored accessMode if it uses a legacy name.
        $current = $settings['accessMode'] ?? '';
        if ($current === 'both' || $current === 'today_only') { $settings['accessMode'] = 'today_edition'; }
        if ($current === 'first_page_free') { $settings['accessMode'] = 'archive_access'; }
        if (!empty($licensed_modes) && !in_array($settings['accessMode'], $licensed_modes, true)) {
          $settings['accessMode'] = $licensed_modes[0];
        }
        $settings['allowedModes'] = $licensed_modes;
      }
    } else {
      // No valid license: treat identically to Starter — force subscription off.
      // This guarantees that the WordPress "Free" lock state in the admin UI matches
      // what the API actually returns, regardless of whatever was previously stored.
      $settings['enabled']      = false;
      $settings['combinedMode'] = 'free';
      $settings['package']      = null;
    }

    return $settings;
  }

  /** GET /subscription/settings — returns current settings for admin UI. */
  public function get_subscription_settings_endpoint(WP_REST_Request $request): WP_REST_Response {
    return rest_ensure_response($this->get_subscription_settings_for_response());
  }

  /**
   * POST /subscription/settings — saves subscription settings from admin UI.
   * Body: { enabled, accessMode, currency, loginUrl }
   */
  public function post_subscription_settings_endpoint(WP_REST_Request $request): WP_REST_Response {
    $params = $request->get_json_params();
    if (!is_array($params)) {
      return new WP_REST_Response(['error' => 'Invalid payload'], 400);
    }
    $sanitized = $this->sanitize_subscription_settings($params);
    update_option(self::OPTION_SUBSCRIPTION_SETTINGS, $sanitized, false);
    return rest_ensure_response(['success' => true, 'settings' => $sanitized]);
  }

  // ---------------------------------------------------------------------------
  // Auth helpers
  // ---------------------------------------------------------------------------

  /**
   * Permission callback for subscriber-facing endpoints.
   * Validates the JWT and sets current user but does NOT require edit_posts —
   * any registered WordPress user with a valid token may call these endpoints.
   */
  public function subscriber_auth_required(WP_REST_Request $request) {
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
    return true;
  }

  public function auth_required(WP_REST_Request $request) {
    // Accept WordPress cookie-based auth (admin panel AJAX calls).
    // WP REST API already validated the nonce via X-WP-Nonce before this runs.
    if (is_user_logged_in() && current_user_can('edit_posts')) {
      return true;
    }

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

  public function authenticate_rest_request($result) {
    if (!empty($result)) {
      return $result;
    }

    if (is_user_logged_in()) {
      return $result;
    }

    $token = $this->get_bearer_token_from_globals();
    if (!$token) {
      return $result;
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
    return true;
  }

  public function add_cors_headers($served, $result, $request, $server) {
    $origin = get_http_origin();
    if (!$origin) {
      return $served;
    }

    $allowed = $this->get_allowed_origins();
    if ($allowed && in_array($origin, $allowed, true)) {
      header('Access-Control-Allow-Origin: ' . $origin);
      header('Vary: Origin');
      header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
      header('Access-Control-Allow-Headers: Authorization, Content-Type');
      if (get_option(self::OPTION_ALLOW_CREDENTIALS, true)) {
        header('Access-Control-Allow-Credentials: true');
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
    $raw = (string) get_option(self::OPTION_ORIGINS, '');
    if (!$raw) {
      return [];
    }
    return array_values(array_filter(array_map('trim', explode(',', $raw))));
  }

  private function get_bearer_token(WP_REST_Request $request): ?string {
    $header = $request->get_header('authorization');
    if (!$header) {
      return null;
    }
    if (preg_match('/Bearer\s+(.*)$/i', $header, $matches)) {
      return trim($matches[1]);
    }
    return null;
  }

  private function get_bearer_token_from_globals(): ?string {
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
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
    if (defined('AUTH_KEY') && AUTH_KEY) {
      return AUTH_KEY;
    }
    if (defined('LOGGED_IN_KEY') && LOGGED_IN_KEY) {
      return LOGGED_IN_KEY;
    }
    return 'dn_fallback_secret';
  }
}

new Digital_Newspaper_API();

register_activation_hook(__FILE__, function () {
  $plugin = new Digital_Newspaper_API();
  if (!get_option(Digital_Newspaper_API::OPTION_KEY)) {
    update_option(Digital_Newspaper_API::OPTION_KEY, Digital_Newspaper_API::default_data(), false);
  }
  // Ensure the signing secret is generated immediately on activation.
  $plugin->ensure_license_secret();
});
