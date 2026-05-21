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
  const TOKEN_TTL = 86400; // 24 hours

  public function __construct() {
    add_action('init', [$this, 'handle_cors_preflight'], 1);
    add_action('rest_api_init', [$this, 'register_routes']);
    add_filter('rest_authentication_errors', [$this, 'authenticate_rest_request']);
    add_action('admin_menu', [$this, 'register_settings_page']);
    add_action('admin_init', [$this, 'register_settings']);
    add_filter('rest_pre_serve_request', [$this, 'add_cors_headers'], 10, 4);
  }

  public function handle_cors_preflight(): void {
    $origin = isset($_SERVER['HTTP_ORIGIN']) ? sanitize_text_field($_SERVER['HTTP_ORIGIN']) : '';
    if (!$origin) return;

    $allowed = $this->get_allowed_origins();
    if (!$allowed || !in_array($origin, $allowed, true)) return;

    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Authorization, X-Authorization, Content-Type');
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
  }

  public function get_data_endpoint(
    WP_REST_Request $request
  ): WP_REST_Response {
    return rest_ensure_response($this->get_data());
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
    $raw = (string) get_option(self::OPTION_ORIGINS, '');
    if (!$raw) {
      return [];
    }
    return array_values(array_filter(array_map('trim', explode(',', $raw))));
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
