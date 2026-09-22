<?php
/**
 * Digital Newspaper — Backup Integrity Check
 *
 * USAGE:
 *   1. Upload this file to: /public_html/dn-backup-check.php  (web root, beside /wp/)
 *   2. Visit: https://epaper.dailysangram.com/dn-backup-check.php
 *   3. DELETE the file immediately after reading the output.
 *
 * This script DOES NOT modify any data. It only reads.
 *
 * WHAT IT LOOKS FOR
 * -----------------
 * snapshot_current_data_before_save() released $raw_serial before the branch
 * that needed it, so whenever gzcompress() failed the fallback wrote
 * data_serial => null instead of the uncompressed payload. The backup row is
 * still created and still lists normally in the admin UI — it is simply empty,
 * and nothing says so until someone tries to restore from it. Fixed in
 * 4268974f; this reports whether any such entry was already written.
 *
 * WHY IT READS RAW BYTES AND NOT get_option()
 * -------------------------------------------
 * dn_data_backups holds up to 20 entries, each carrying a compressed copy of
 * the whole data blob. get_option() would deserialize all of them at once —
 * the exact OOM the backup code is written to avoid on shared hosting. So the
 * scan runs inside MySQL against the raw option_value, and PHP only ever holds
 * the short SUBSTRING windows it pulls back.
 *
 * The markers are PHP serialization literals:
 *   s:14:"data_gz_serial";   healthy, compressed
 *   s:11:"data_serial";s:    healthy, uncompressed (zlib absent)
 *   s:11:"data_serial";N;    CORRUPT — the bug above
 */

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

echo "Digital Newspaper — Backup Integrity Check\n";
echo "Generated: " . gmdate('Y-m-d H:i:s') . " UTC\n";

// ═══════════════════════════════════════════════════════════
section('WORDPRESS BOOTSTRAP');
// ═══════════════════════════════════════════════════════════

$wp_load = __DIR__ . '/wp/wp-load.php';
if (!file_exists($wp_load)) {
    h('wp-load.php exists', false, false);
    echo "\n  Cannot load WordPress — stopping here.\n";
    exit;
}

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
h('DB name',      DB_NAME);
h('Table prefix', $wpdb->prefix);

// ═══════════════════════════════════════════════════════════
section('dn_data_backups');
// ═══════════════════════════════════════════════════════════

$OPTION = 'dn_data_backups';

$size = $wpdb->get_var($wpdb->prepare(
    "SELECT LENGTH(option_value) FROM {$wpdb->options} WHERE option_name = %s",
    $OPTION
));

if ($size === null) {
    h('option exists', false, false);
    echo "\n  No backup option stored yet — nothing to check.\n";
    exit;
}

$size = (int) $size;
h('option exists', true);
h('stored size',   number_format($size) . ' bytes (' . round($size / 1048576, 1) . ' MB)');

/**
 * Byte offsets of every occurrence of $needle, found entirely inside MySQL.
 *
 * LOCATE() returns a 1-based position or 0 when absent, and takes a start
 * offset, so stepping it walks the column without ever sending the value to
 * PHP. Capped so a malformed option cannot spin here forever.
 */
function marker_offsets(string $needle, string $option, int $limit = 500): array {
    global $wpdb;
    $offsets = [];
    $pos = 1;
    while (count($offsets) < $limit) {
        $found = (int) $wpdb->get_var($wpdb->prepare(
            "SELECT LOCATE(%s, option_value, %d) FROM {$wpdb->options} WHERE option_name = %s",
            $needle, $pos, $option
        ));
        if ($found === 0) break;
        $offsets[] = $found;
        $pos = $found + strlen($needle);
    }
    return $offsets;
}

/** A short window of the raw value, for reading a timestamp without loading the blob. */
function window(int $start, int $len, string $option): string {
    global $wpdb;
    return (string) $wpdb->get_var($wpdb->prepare(
        "SELECT SUBSTRING(option_value, %d, %d) FROM {$wpdb->options} WHERE option_name = %s",
        $start, $len, $option
    ));
}

$entries    = marker_offsets('s:9:"createdAt";',       $OPTION);
$healthyGz  = marker_offsets('s:14:"data_gz_serial";', $OPTION);
$healthyRaw = marker_offsets('s:11:"data_serial";s:',  $OPTION);
$corrupt    = marker_offsets('s:11:"data_serial";N;',  $OPTION);

h('entries found', count($entries), count($entries) > 0);
h('  compressed (data_gz_serial)',   count($healthyGz));
h('  uncompressed (data_serial)',    count($healthyRaw));
h('  CORRUPT (data_serial => null)', count($corrupt), count($corrupt) === 0);

// ═══════════════════════════════════════════════════════════
section('PER-ENTRY DETAIL');
// ═══════════════════════════════════════════════════════════

/** Which entry a marker belongs to: the last createdAt at or before its offset. */
function entry_index_for(int $offset, array $entries): int {
    $idx = -1;
    foreach ($entries as $i => $start) {
        if ($start <= $offset) $idx = $i; else break;
    }
    return $idx;
}

$state = [];
foreach ($healthyGz  as $o) $state[entry_index_for($o, $entries)] = 'compressed';
foreach ($healthyRaw as $o) $state[entry_index_for($o, $entries)] = 'uncompressed';
foreach ($corrupt    as $o) $state[entry_index_for($o, $entries)] = 'CORRUPT (null payload)';

$bad = 0;
foreach ($entries as $i => $start) {
    // s:9:"createdAt";s:NN:"<value>"  — 64 bytes is ample for the whole token.
    $win = window($start, 64, $OPTION);
    $when = preg_match('/s:9:"createdAt";s:\d+:"([^"]*)"/', $win, $m) ? $m[1] : '(unreadable)';
    $st   = $state[$i] ?? 'NO PAYLOAD AT ALL';
    $ok   = ($st === 'compressed' || $st === 'uncompressed');
    if (!$ok) $bad++;
    // Index 0 is the newest — array_unshift puts each new entry at the front.
    h(sprintf('index %-2d  %-28s', $i, $when), $st, $ok);
}

// ═══════════════════════════════════════════════════════════
section('VERDICT');
// ═══════════════════════════════════════════════════════════

if ($bad === 0) {
    echo "✓  All " . count($entries) . " backup entries carry a payload. Nothing to do.\n";
    echo "   The gzcompress() fallback never fired on this install.\n";
} else {
    echo "✗  $bad of " . count($entries) . " backup entries are unrestorable.\n\n";
    echo "   They will still appear in the admin backup list, and restoring from\n";
    echo "   one will not produce the data it claims to hold. Treat the entries\n";
    echo "   marked above as absent and restore from a healthy index instead.\n\n";
    echo "   The write path is fixed (4268974f), so no new entry can take this\n";
    echo "   shape. Existing ones cannot be repaired — the payload was never\n";
    echo "   stored — they simply rotate out as new backups are taken.\n\n";
    echo "   Worth checking why gzcompress() failed: it points at a zlib problem\n";
    echo "   or memory pressure on this host, which is worth knowing regardless.\n";
}

echo "\nDone. DELETE this file now.\n";
