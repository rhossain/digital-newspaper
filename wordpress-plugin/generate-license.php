#!/usr/bin/env php
<?php
/**
 * Digital Newspaper — License Key Generator
 *
 * Generates a signed license key that activates Starter or Publisher/Pro
 * features on a specific WordPress installation.
 *
 * USAGE
 * ─────
 * php wordpress-plugin/generate-license.php \
 *     --client="Daily Songram" \
 *     --domain="wp.rshossain.me" \
 *     --package="publisher" \
 *     --modes="today_edition,archive_access" \
 *     --expires="never" \
 *     --secret="PASTE_SECRET_FROM_WP_ADMIN_HERE"
 *
 * HOW TO GET THE SECRET
 * ─────────────────────
 * 1. Install the Digital Newspaper plugin on the WordPress site.
 * 2. Go to WordPress Admin → Settings → Digital Newspaper.
 * 3. In the "🔑 License Key" section, copy the value shown in the
 *    "Signing Secret" field (the plugin auto-generates it on first load).
 * 4. Pass that value as --secret when running this script.
 *
 * VALID OPTION VALUES
 * ───────────────────
 *   --secret    Required. The signing secret from the WP admin settings page.
 *   --package   starter | publisher
 *   --modes     Comma-separated list (only used when package=publisher):
 *                 today_edition   Today's first page free; subscribing unlocks all pages
 *                                 of today's edition. Archive is fully locked.
 *                 archive_access  Today's first page free; subscribing unlocks today's
 *                                 full edition AND all past editions (archive).
 *               Defaults to "today_edition,archive_access" (all modes allowed)
 *   --expires   YYYY-MM-DD or "never"
 */

// ─────────────────────────────────────────────────────────────────────────────
// Parse CLI arguments
// ─────────────────────────────────────────────────────────────────────────────

$opts = getopt('', [
    'client:',
    'domain:',
    'package:',
    'modes::',
    'expires:',
    'secret:',
]);

$errors = [];

$client  = isset($opts['client'])  ? trim($opts['client'])  : '';
$domain  = isset($opts['domain'])  ? trim($opts['domain'])  : '';
$package = isset($opts['package']) ? strtolower(trim($opts['package'])) : '';
$expires = isset($opts['expires']) ? trim($opts['expires']) : '';
$secret  = isset($opts['secret'])  ? trim($opts['secret'])  : '';

if (!$client)  { $errors[] = '--client is required'; }
if (!$domain)  { $errors[] = '--domain is required'; }
if (!$package) { $errors[] = '--package is required (starter|publisher)'; }
if (!in_array($package, ['starter', 'publisher'], true)) {
    $errors[] = '--package must be "starter" or "publisher"';
}
if (!$expires) { $errors[] = '--expires is required (YYYY-MM-DD or "never")'; }
if (!$expires && $expires !== 'never' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $expires)) {
    $errors[] = '--expires must be a date in YYYY-MM-DD format or the word "never"';
}
if (!$secret)  { $errors[] = '--secret is required. Copy it from WordPress Admin → Settings → Digital Newspaper → Signing Secret.'; }

// Validate access modes
$allowed_modes = ['today_edition', 'archive_access'];
$modes_raw = isset($opts['modes']) ? trim($opts['modes']) : implode(',', $allowed_modes);
$modes = array_values(array_filter(array_map('trim', explode(',', $modes_raw))));

foreach ($modes as $m) {
    if (!in_array($m, $allowed_modes, true)) {
        $errors[] = "Unknown access mode \"$m\". Valid modes: " . implode(', ', $allowed_modes);
    }
}

// Strip protocol from domain if accidentally included
$domain = preg_replace('#^https?://#i', '', $domain);
$domain = rtrim($domain, '/');

if ($errors) {
    fwrite(STDERR, "\n[ERROR] License key generation failed:\n");
    foreach ($errors as $e) {
        fwrite(STDERR, "  • $e\n");
    }
    fwrite(STDERR, "\nRun with --help for usage.\n\n");
    exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Build and sign the license payload
// ─────────────────────────────────────────────────────────────────────────────

$payload = [
    'client'  => $client,
    'domain'  => $domain,
    'package' => $package,
    'modes'   => ($package === 'publisher') ? $modes : [],
    'expires' => $expires,
    'issued'  => date('Y-m-d'),
];

// The HMAC is computed over a canonical string of the non-signature fields.
// Fields are sorted alphabetically to ensure deterministic output.
$fields_to_sign = $payload;
ksort($fields_to_sign);
$canonical = json_encode($fields_to_sign, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

$signature = hash_hmac('sha256', $canonical, $secret);

$payload['sig'] = $signature;

// Encode as URL-safe base64 (no line breaks, no padding)
$license_key = 'DN1-' . rtrim(
    strtr(
        base64_encode(json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)),
        '+/',
        '-_'
    ),
    '='
);

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

echo "\n";
echo "╔══════════════════════════════════════════════════════════════╗\n";
echo "║          DIGITAL NEWSPAPER — LICENSE KEY                     ║\n";
echo "╚══════════════════════════════════════════════════════════════╝\n";
echo "\n";
printf("  Client   : %s\n", $client);
printf("  Domain   : %s\n", $domain);
printf("  Package  : %s\n", strtoupper($package));
printf("  Modes    : %s\n", $modes ? implode(', ', $modes) : '(none — starter)');
printf("  Issued   : %s\n", $payload['issued']);
printf("  Expires  : %s\n", $expires);
echo "\n";
echo "  LICENSE KEY (paste into WordPress > Digital Newspaper > License):\n";
echo "  ──────────────────────────────────────────────────────────────\n";
echo "  $license_key\n";
echo "\n";
