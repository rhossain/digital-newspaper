<?php
/**
 * Digital Newspaper — Server Diagnostic Script
 *
 * USAGE:
 *   1. Upload this file to: /public_html/dn-diag.php  (web root, beside /wp/)
 *   2. Visit: https://epaper.dailysangram.com/dn-diag.php
 *   3. DELETE the file immediately after reading the output.
 *
 * This script DOES NOT modify any data. It only reads.
 */

// ── Basic security: restrict to your IP only ────────────────────────────────
// Uncomment and set your IP if you want extra protection:
// $allowed_ip = '1.2.3.4';
// if (($_SERVER['REMOTE_ADDR'] ?? '') !== $allowed_ip) { http_response_code(403); exit('Forbidden'); }

define('DN_DIAG_START', microtime(true));
header('Content-Type: text/plain; charset=utf-8');
header('X-Robots-Tag: noindex');

function h(string $label, $value, bool $ok = true): void {
    $icon = $ok ? '✓' : '✗';
    $val  = is_bool($value) ? ($value ? 'true' : 'false') : (string) $value;
    echo "$icon  $label: $val\n";
}
function section(string $title): void {
    echo "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
    echo "  $title\n";
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
}

echo "Digital Newspaper — Server Diagnostic\n";
echo "Generated: " . gmdate('Y-m-d H:i:s') . " UTC\n";

// ═══════════════════════════════════════════════════════════
section('PHP ENVIRONMENT');
// ═══════════════════════════════════════════════════════════

h('PHP version',          PHP_VERSION,                          version_compare(PHP_VERSION, '7.4', '>='));
h('max_execution_time',   ini_get('max_execution_time') . ' s');
h('memory_limit',         ini_get('memory_limit'));
h('gzcompress available', function_exists('gzcompress'));
h('json_encode available',function_exists('json_encode'));

// ═══════════════════════════════════════════════════════════
section('WORDPRESS BOOTSTRAP');
// ═══════════════════════════════════════════════════════════

$wp_load = __DIR__ . '/wp/wp-load.php';
h('wp-load.php exists', file_exists($wp_load), file_exists($wp_load));

if (!file_exists($wp_load)) {
    echo "\n  Cannot load WordPress — stopping here.\n";
    exit;
}

// Suppress output during WP load
ob_start();
try {
    require_once $wp_load;
    ob_end_clean();
    h('WordPress loaded', true);
} catch (Throwable $e) {
    ob_end_clean();
    h('WordPress load error', $e->getMessage(), false);
    exit;
}

global $wpdb;
h('WP version',  $wp_version ?? get_bloginfo('version'));
h('DB host',     DB_HOST);
h('DB name',     DB_NAME);
h('Table prefix',$wpdb->prefix);

// ═══════════════════════════════════════════════════════════
section('DATABASE CONNECTIVITY');
// ═══════════════════════════════════════════════════════════

$db_ok = $wpdb->get_var('SELECT 1') === '1';
h('MySQL reachable', $db_ok, $db_ok);
h('Last DB error',   $wpdb->last_error ?: 'none', empty($wpdb->last_error));

// Check wp_options table
$opts_count = (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->options}");
h('wp_options row count', number_format($opts_count), $opts_count > 0);

// ═══════════════════════════════════════════════════════════
section('DIGITAL NEWSPAPER OPTIONS');
// ═══════════════════════════════════════════════════════════

// Check each granular option
$migrated = get_option('dn_storage_migrated_v2', false);
h('dn_storage_migrated_v2', $migrated ? 'true (granular storage active)' : 'false (migration not done)', (bool)$migrated);

$index = get_option('dn_data_index');
h('dn_data_index exists', is_array($index), is_array($index));
if (is_array($index)) {
    h('  dataVersion', $index['dataVersion'] ?? 'missing');
    h('  date count',  count($index['dates'] ?? []));
    $dates = $index['dates'] ?? [];
    if (!empty($dates)) {
        h('  latest date', $dates[0]);
        h('  oldest date', end($dates));
    }
}

$settings = get_option('dn_settings');
h('dn_settings exists', is_array($settings), is_array($settings));
if (is_array($settings)) {
    h('  language', $settings['language'] ?? 'not set');
    h('  has logo',  !empty($settings['logo']['url']) ? 'yes' : 'no');
}

// Legacy blob size
$blob_raw = $wpdb->get_row(
    "SELECT LENGTH(option_value) AS len FROM {$wpdb->options} WHERE option_name = 'dn_data'",
    OBJECT
);
$blob_bytes = $blob_raw ? (int) $blob_raw->len : 0;
$blob_kb    = round($blob_bytes / 1024, 1);
$blob_mb    = round($blob_bytes / 1048576, 2);
$blob_ok    = $blob_mb < 20; // warn if > 20 MB
h('dn_data blob size', "{$blob_kb} KB ({$blob_mb} MB)" . ($blob_ok ? '' : ' ← LARGE — may cause timeout'), $blob_ok);

// Check transients
$lock = get_transient('dn_migration_v2_lock');
h('migration lock transient', $lock ? 'STUCK (set)' : 'clear (good)', !$lock);

$t_keys = $wpdb->get_results(
    "SELECT option_name FROM {$wpdb->options}
     WHERE option_name LIKE '_transient_dn_pub_rate_%' LIMIT 5"
);
h('rate-limit transients active', count($t_keys) . ' IPs', true);

// ═══════════════════════════════════════════════════════════
section('PLUGIN STATUS');
// ═══════════════════════════════════════════════════════════

$plugin_file = WP_PLUGIN_DIR . '/digital-newspaper/digital-newspaper.php';
h('Plugin file exists', file_exists($plugin_file), file_exists($plugin_file));

if (file_exists($plugin_file)) {
    $plugin_data = get_file_data($plugin_file, ['Version' => 'Version', 'Name' => 'Plugin Name']);
    h('Plugin name',    $plugin_data['Name']    ?: '?');
    h('Plugin version', $plugin_data['Version'] ?: '?');
    h('File modified',  date('Y-m-d H:i:s', filemtime($plugin_file)) . ' UTC');
    h('File size',      round(filesize($plugin_file) / 1024, 1) . ' KB');
}

$active_plugins = get_option('active_plugins', []);
$dn_active = in_array('digital-newspaper/digital-newspaper.php', $active_plugins, true);
h('Plugin is activated', $dn_active, $dn_active);

// Check REST API routes
$routes = rest_get_server()->get_routes();
$dn_routes = array_filter(array_keys($routes), fn($r) => str_contains($r, 'digital-newspaper'));
h('Plugin REST routes registered', count($dn_routes) . ' routes', count($dn_routes) > 0);
foreach ($dn_routes as $r) {
    echo "     $r\n";
}

// ═══════════════════════════════════════════════════════════
section('REST API SELF-TEST');
// ═══════════════════════════════════════════════════════════

// Call each endpoint internally (no HTTP round-trip needed)
$endpoints = [
    'data/version'  => '/digital-newspaper/v1/data/version',
    'data/settings' => '/digital-newspaper/v1/data/settings',
    'data/dates'    => '/digital-newspaper/v1/data/dates',
];

foreach ($endpoints as $label => $route) {
    $t0  = microtime(true);
    $req = new WP_REST_Request('GET', $route);
    $res = rest_get_server()->dispatch($req);
    $ms  = round((microtime(true) - $t0) * 1000);
    $status = $res->get_status();
    $ok   = ($status >= 200 && $status < 300);
    h("GET $label → HTTP $status ({$ms} ms)", '', $ok);
    if (!$ok) {
        $data = $res->get_data();
        echo "     Error: " . (is_array($data) ? json_encode($data) : (string)$data) . "\n";
    }
}

// ═══════════════════════════════════════════════════════════
section('HTACCESS CHECK');
// ═══════════════════════════════════════════════════════════

$htaccess = ABSPATH . '.htaccess';
h('.htaccess path', $htaccess);
h('.htaccess exists', file_exists($htaccess), file_exists($htaccess));
if (file_exists($htaccess)) {
    $content = file_get_contents($htaccess);
    h('Has Digital Newspaper block',    str_contains($content, 'BEGIN Digital Newspaper'), str_contains($content, 'BEGIN Digital Newspaper'));
    h('Has SecRuleEngine Off',          str_contains($content, 'SecRuleEngine Off'),         str_contains($content, 'SecRuleEngine Off'));
    h('Has rest_route SetEnvIf',        str_contains($content, 'rest_route'),                str_contains($content, 'rest_route'));
    h('.htaccess is writable',          is_writable($htaccess));
}

// ═══════════════════════════════════════════════════════════
section('PER-DATE EDITION OPTIONS (sample)');
// ═══════════════════════════════════════════════════════════

$edition_rows = $wpdb->get_results(
    "SELECT option_name,
            LENGTH(option_value) AS len
     FROM {$wpdb->options}
     WHERE option_name LIKE 'dn_edition_%'
     ORDER BY option_name DESC
     LIMIT 5"
);
h('dn_edition_* options found', count($edition_rows), count($edition_rows) > 0);
foreach ($edition_rows as $row) {
    $kb = round((int)$row->len / 1024, 1);
    echo "     {$row->option_name}  ({$kb} KB)\n";
}

// ═══════════════════════════════════════════════════════════
section('EXTERNAL HTTP TEST (optional)');
// ═══════════════════════════════════════════════════════════

$test_url = home_url('/wp-json/digital-newspaper/v1/data/version');
h('Testing URL', $test_url);

if (function_exists('wp_remote_get')) {
    $t0   = microtime(true);
    $resp = wp_remote_get($test_url, ['timeout' => 10, 'sslverify' => false]);
    $ms   = round((microtime(true) - $t0) * 1000);
    if (is_wp_error($resp)) {
        h("External HTTP GET ({$ms} ms)", 'WP_Error: ' . $resp->get_error_message(), false);
    } else {
        $code = wp_remote_retrieve_response_code($resp);
        $body = substr(wp_remote_retrieve_body($resp), 0, 120);
        h("External HTTP GET ({$ms} ms)", "HTTP $code", ($code >= 200 && $code < 300));
        echo "     Body preview: $body\n";
    }
}

// ═══════════════════════════════════════════════════════════
section('SUMMARY');
// ═══════════════════════════════════════════════════════════

$total_ms = round((microtime(true) - DN_DIAG_START) * 1000);
echo "Total diag time: {$total_ms} ms\n";
echo "\nDELETE THIS FILE FROM THE SERVER AFTER READING THE OUTPUT.\n";
