# Backend Data Loading Fix Guide

**Date:** June 2026  
**Issue:** `epaper.dailysangram.com` stopped loading data from `epaper.dailysangram.com/wp`  
**Status:** Plugin code fixed — follow the steps below to restore the site.

---

## Root Causes Identified

### 1 — Migration timeout loop (most likely primary cause)

The plugin was updated with a new "granular storage" system that splits `dn_data` into per-date options. On first request after the update, it tries to migrate the old blob. If the blob is large (many editions + images), PHP timed out *before* the "migration done" flag was set. On the next request it tried again, timed out again — an infinite loop that blocked all API calls.

**Fixed in plugin code:**
- Migration flag is now set **before** any work is done (MIGS-1)
- A time-budget guard aborts migration gracefully before PHP's `max_execution_time` kills the process (MIGS-2)
- Granular read helpers no longer fall back to reading the full blob when the migration flag is already set (PERF-3)

### 2 — Version poll read the full blob

`/data/version` is polled every 30 seconds. It was reading the entire `dn_data` blob (potentially 30–50 MB) just to get one float. Now reads the tiny `dn_data_index` option instead.

### 3 — `normalize_domain_urls` too slow on large datasets

Recursive `array_map` on thousands of sections caused 10–30 second delays. Now uses `json_encode` → bulk `str_replace` → `json_decode` (O(n) instead of O(n×k)).

### 4 — WordPress `.htaccess` may have been cleared

WordPress auto-updates or a "Save Permalinks" action can regenerate `/wp/.htaccess`, removing the plugin's ModSecurity bypass rules. Without those rules, Imunify360 blocks requests to `/?rest_route=/digital-newspaper/…` before they reach PHP.

---

## Step-by-Step Recovery

### Step 1 — Upload the fixed plugin file ⬅️ **do this first**

Upload this file to your hosting server:

```
local path:  wordpress-plugin/digital-newspaper/digital-newspaper.php
server path: /wp/wp-content/plugins/digital-newspaper/digital-newspaper.php
```

**Via Hostinger File Manager:**
1. Log in to Hostinger → Hosting → Manage
2. File Manager → navigate to `public_html/wp/wp-content/plugins/digital-newspaper/`
3. Upload/overwrite `digital-newspaper.php`

**Via FTP (FileZilla / WinSCP):**
```
Local:   digital-newspaper/wordpress-plugin/digital-newspaper/digital-newspaper.php
Remote:  /public_html/wp/wp-content/plugins/digital-newspaper/digital-newspaper.php
```

### Step 2 — Regenerate WordPress .htaccess

After uploading the plugin, trigger `.htaccess` regeneration to restore the ModSecurity bypass rules:

1. Log into WordPress admin: `https://epaper.dailysangram.com/wp/wp-admin/`
2. Go to **Settings → Permalinks**
3. Click **Save Changes** (no need to change anything — just saving triggers the regeneration)

The plugin's `ensure_htaccess_rules()` hook runs automatically when permalinks are saved and adds the WAF bypass rules back.

**If WordPress admin is also broken**, add the rules manually to `/public_html/wp/.htaccess` right after the `# BEGIN WordPress` section:

```apache
# BEGIN Digital Newspaper API
# ── Digital Newspaper REST API — WAF bypass rules ────────────────────────
<IfVersion >= 2.4>
  <IfModule mod_security2.c>
    <LocationMatch "(wp-json/digital-newspaper|rest_route=/digital-newspaper)">
      SecRuleEngine Off
    </LocationMatch>
  </IfModule>
</IfVersion>
<IfModule mod_security.c>
  SecFilterEngine Off
  SecFilterScanPOST Off
</IfModule>
SetEnvIf Request_URI "wp-json" dn_api_request=1
SetEnvIf Query_String "rest_route" dn_api_request=1
# END Digital Newspaper API
```

### Step 3 — Clear WordPress transient cache (optional but recommended)

If the migration lock transient (`dn_migration_v2_lock`) is stuck, clear it:

**Via WordPress admin → Tools → Site Health → Info** won't clear it, so use one of:

**phpMyAdmin (Hostinger → phpMyAdmin):**
```sql
DELETE FROM wp_options
WHERE option_name LIKE '_transient_dn_%'
   OR option_name LIKE '_transient_timeout_dn_%';
```

**Or via WordPress admin → Plugins → Add New → search "Transients Manager"**, install it, go to Tools → Transients Manager, and delete all `dn_` transients.

### Step 4 — Verify the fix

Open your browser DevTools (F12) → Network tab, then visit `https://epaper.dailysangram.com`.

You should see these requests succeed with HTTP 200:
```
GET /wp/?rest_route=/digital-newspaper/v1/data
GET /wp/?rest_route=/digital-newspaper/v1/data/settings
GET /wp/?rest_route=/digital-newspaper/v1/data/dates
GET /wp/?rest_route=/digital-newspaper/v1/data/version
```

If any return `403` or an HTML response (Imunify360 block) — Step 2 (.htaccess) didn't take effect. Double-check the WAF bypass rules are in the WordPress `.htaccess`.

### Step 5 — Re-save from the admin panel

After the site loads (even if it shows default/empty settings):

1. Go to `https://epaper.dailysangram.com/admin`
2. Log in
3. Make any minor change (e.g. toggle a setting) and **Save**

This triggers a full `save_data()` call which:
- Writes all granular options (`dn_settings`, `dn_data_index`, `dn_edition_YYYY-MM-DD` for every date)
- Ensures subsequent reads use the fast O(1) per-option path
- Removes the need for any blob fallback

---

## What Was Fixed in the Plugin Code

| Location | Change | Why |
|---|---|---|
| `maybe_migrate_storage()` | Set `dn_storage_migrated_v2` flag **before** attempting migration | Breaks the infinite timeout loop |
| `maybe_migrate_storage()` | Added time-budget guard (aborts before `max_execution_time`) | Prevents hard PHP kills mid-migration |
| `maybe_migrate_storage()` | Extended lock transient from 60 s to 300 s | Gives large migrations room to complete |
| `get_settings_granular()` | Writes defaults instead of re-reading the blob when flag is set | Eliminates second blob read per request |
| `get_dates_granular()` | Returns `[]` instead of re-reading the blob when flag is set | Eliminates second blob read per request |
| `get_edition_for_date_granular()` | Returns `[]` instead of re-reading the blob when flag is set | Eliminates second blob read per request |
| `get_data_version_endpoint()` | Reads `dn_data_index` (tiny) instead of `dn_data` (huge) | Fixes the 30-second version poll that read 30–50 MB on every tick |
| `normalize_domain_urls()` | `json_encode` → bulk `str_replace` → `json_decode` for arrays | 10–100× faster on large datasets; eliminates recursive PHP overhead |

---

## Preventing Recurrence

1. **Never rely on WordPress auto-save permalinks** to trigger `.htaccess` regeneration — check the file after any WordPress core update.
2. **Monitor blob size**: if `dn_data` grows past ~20 MB (check via phpMyAdmin → wp_options → where option_name = 'dn_data'), migrate to the granular storage format immediately by triggering an admin save.
3. **Enable WordPress debug logging** in `wp-config.php`:
   ```php
   define('WP_DEBUG', true);
   define('WP_DEBUG_LOG', true);
   define('WP_DEBUG_DISPLAY', false);
   ```
   Then check `/wp/wp-content/debug.log` when issues arise.
