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

  public function __construct() {
    add_action('init', [$this, 'handle_cors_preflight'], 1);
    add_action('init', [$this, 'register_section_post_type']);
    add_action('rest_api_init', [$this, 'register_routes']);
    add_filter('rest_authentication_errors', [$this, 'authenticate_rest_request']);
    add_action('admin_menu', [$this, 'register_settings_page']);
    add_action('admin_init', [$this, 'register_settings']);
    add_filter('rest_pre_serve_request', [$this, 'add_cors_headers'], 10, 4);
    // Ensure ModSecurity bypass rules are in .htaccess so the REST API is not
    // blocked by host-level WAF (e.g. Imunify360 on Hostinger shared hosting).
    add_action('admin_init', [$this, 'ensure_htaccess_rules']);
    register_activation_hook(__FILE__, [$this, 'ensure_htaccess_rules']);
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
      '# Disable ModSecurity rule engine for Digital Newspaper REST API requests.',
      '# These paths handle login and data save for authenticated admin users;',
      '# WAF bot-protection must not block them.',
      '<IfModule mod_security2.c>',
      '  SecRuleEngine Off',
      '</IfModule>',
      '<IfModule mod_security.c>',
      '  SecFilterEngine Off',
      '  SecFilterScanPOST Off',
      '</IfModule>',
    ];

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
    $data = get_option(self::OPTION_KEY);
    if (!is_array($data)) {
      $data = self::default_data();
    }
    // Rewrite old nepaper URLs to epaper URLs for backward compatibility
    $data = $this->rewrite_old_urls($data);
    return $data;
  }

  /**
   * Recursively rewrite old nepaper.dailysangram.com URLs to epaper.dailysangram.com
   * This handles data that was saved with the old domain before the fix.
   */
  private function rewrite_old_urls($data) {
    if (is_array($data)) {
      return array_map([$this, 'rewrite_old_urls'], $data);
    }
    if (is_string($data)) {
      // Replace nepaper with epaper in URLs
      return str_replace('https://nepaper.dailysangram.com', 'https://epaper.dailysangram.com', $data);
    }
    return $data;
  }

  public function save_data(array $data): void {
    $this->snapshot_current_data_before_save();
    update_option(self::OPTION_KEY, $data, false);
    $this->sync_section_posts_from_data($data);
  }

  private function snapshot_current_data_before_save(): void {
    $current = get_option(self::OPTION_KEY);
    if (!is_array($current)) {
      return;
    }

    $backups = get_option(self::OPTION_BACKUPS, []);
    if (!is_array($backups)) {
      $backups = [];
    }

    array_unshift($backups, [
      'createdAt' => gmdate('c'),
      'data'      => $current,
    ]);

    $backups = array_slice($backups, 0, 20);
    update_option(self::OPTION_BACKUPS, $backups, false);
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
      'post_status'    => ['publish', 'draft', 'private', 'pending'],
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

  private function sync_section_posts_from_data(array $data): void {
    if (empty($data['editions']) || !is_array($data['editions']) || $this->count_sections($data) === 0) {
      return;
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
      'dn_edition_labels'     => wp_json_encode($editionLabels),
      'dn_page_id'            => $pageId,
      'dn_page_order'         => $pageIndex,
      'dn_page_labels'        => wp_json_encode($pageLabels),
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
      'dn_linked_section_ids' => wp_json_encode($linkedSectionIds),
      'dn_section_payload'    => wp_json_encode($section),
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
        'permission_callback' => [$this, 'auth_required']
      ]
    ]);

    register_rest_route('digital-newspaper/v1', '/data/rebuild-from-sections', [
      [
        'methods' => 'POST',
        'callback' => [$this, 'rebuild_data_from_sections_endpoint'],
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
  }

  public function warm_cache_permission(WP_REST_Request $request) {
    return $this->auth_required($request);
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

  public function get_data_endpoint(
    WP_REST_Request $request
  ): WP_REST_Response {
    // Explicitly forbid any CDN / LiteSpeed / proxy from caching this
    // endpoint. Stale cached responses were causing the Angular app to show
    // old data even after new editions had been uploaded.
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');
    return rest_ensure_response($this->get_data());
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

    if ($index < 0 || !isset($backups[$index]) || !is_array($backups[$index]) || !is_array($backups[$index]['data'] ?? null)) {
      return new WP_REST_Response(['error' => 'Backup not found'], 404);
    }

    $this->snapshot_current_data_before_save();
    update_option(self::OPTION_KEY, $backups[$index]['data'], false);
    $this->sync_section_posts_from_data($backups[$index]['data']);

    return rest_ensure_response([
      'success'  => true,
      'restored' => $this->backup_summary($backups[$index], $index),
    ]);
  }

  public function rebuild_data_from_sections_endpoint(WP_REST_Request $request): WP_REST_Response {
    $current = $this->get_data();
    $rebuilt = $this->build_data_from_section_posts($current['settings'] ?? []);

    if ($this->count_sections($rebuilt) === 0) {
      return new WP_REST_Response(['error' => 'No mirrored section posts were found to rebuild from.'], 404);
    }

    $this->save_data($rebuilt);

    return rest_ensure_response([
      'success'      => true,
      'editionCount' => is_array($rebuilt['editions'] ?? null) ? count($rebuilt['editions']) : 0,
      'pageCount'    => $this->count_pages($rebuilt),
      'sectionCount' => $this->count_sections($rebuilt),
    ]);
  }

  private function build_data_from_section_posts(array $settings): array {
    $posts = get_posts([
      'post_type'      => self::SECTION_POST_TYPE,
      'post_status'    => ['publish', 'draft', 'private', 'pending'],
      'posts_per_page' => -1,
      'orderby'        => 'meta_value',
      'meta_key'       => 'dn_newspaper_date',
      'order'          => 'DESC',
      'no_found_rows'  => true,
    ]);

    $editionMap = [];
    foreach ($posts as $post) {
      $date = sanitize_text_field((string) get_post_meta($post->ID, 'dn_newspaper_date', true));
      if ($date === '') continue;
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

      $payload = json_decode((string) get_post_meta($post->ID, 'dn_section_payload', true), true);
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
    $payload = $request->get_json_params();
    if (!is_array($payload)) {
      return new WP_REST_Response(['error' => 'Invalid payload'], 400);
    }

    $force = $request->get_param('force') === '1' || $request->get_param('force') === 'true';
    $current = $this->get_data();
    $currentPageCount = $this->count_pages($current);
    $incomingPageCount = $this->count_pages($payload);
    if (!$force && $currentPageCount > 0 && $incomingPageCount === 0) {
      return new WP_REST_Response([
        'error' => 'Refusing to overwrite existing newspaper pages with an empty page dataset. Restore from backup or retry with force=1 if this is intentional.',
        'currentPageCount' => $currentPageCount,
        'incomingPageCount' => $incomingPageCount,
      ], 409);
    }

    // Strip the export metadata envelope so it is never persisted in the
    // WordPress option.  The Angular app may accidentally send the full
    // ExportPayload (with a "meta" key) instead of a plain NewspaperData
    // object; removing it here keeps the stored structure clean.
    unset($payload['meta']);

    $this->save_data($payload);

    return rest_ensure_response([
      'success' => true,
      'message' => 'Data saved successfully'
    ]);
  }

  public function login(WP_REST_Request $request) {
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
      return new WP_REST_Response(['error' => 'Invalid credentials'], 401);
    }

    $token = $this->generate_token($user->ID);

    return rest_ensure_response([
      'token' => $token,
      'user' => [
        'id' => $user->ID,
        'username' => $user->user_login,
        'email' => $user->user_email,
        'displayName' => $user->display_name
      ]
    ]);
  }

  public function me(WP_REST_Request $request): WP_REST_Response {
    $user = wp_get_current_user();
    if (!$user || !$user->ID) {
      return new WP_REST_Response(['error' => 'Unauthorized'], 401);
    }

    return rest_ensure_response([
      'id' => $user->ID,
      'username' => $user->user_login,
      'email' => $user->user_email,
      'displayName' => $user->display_name
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

    $local_path = $this->dn_uploads_url_to_path($url);
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

        return new WP_REST_Response($body, 200, [
          'Content-Type' => $content_type,
          'Cache-Control' => 'public, max-age=86400'
        ]);
      }
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
    // AUTH_KEY / LOGGED_IN_KEY not set — the fallback is weak. This should
    // not happen on a properly configured WordPress installation.
    if (is_admin()) {
      add_action('admin_notices', function () {
        echo '<div class="notice notice-warning"><p><strong>Digital Newspaper:</strong> AUTH_KEY is not set in wp-config.php. JWT tokens use a fallback secret. Please define AUTH_KEY for production security.</p></div>';
      });
    }
    return 'dn_fallback_secret';
  }
}

new Digital_Newspaper_API();

register_activation_hook(__FILE__, function () {
  if (!get_option(Digital_Newspaper_API::OPTION_KEY)) {
    update_option(Digital_Newspaper_API::OPTION_KEY, Digital_Newspaper_API::default_data(), false);
  }
});
