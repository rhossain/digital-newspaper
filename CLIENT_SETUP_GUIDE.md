# Digital Newspaper — Client Setup Guide

This guide walks you through deploying the Digital Newspaper application from scratch on your own hosting. No prior technical experience with Angular or WordPress internals is required beyond the steps described here.

---

## Table of Contents

1. [How the System Works](#1-how-the-system-works)
2. [What You Need Before Starting](#2-what-you-need-before-starting)
3. [Step 1 — Install the WordPress Plugin](#3-step-1--install-the-wordpress-plugin)
4. [Step 2 — Configure the WordPress Plugin](#4-step-2--configure-the-wordpress-plugin)
5. [Step 3 — Configure the Angular App Source](#5-step-3--configure-the-angular-app-source)
6. [Step 4 — Build the Angular App](#6-step-4--build-the-angular-app)
7. [Step 5 — Upload the Angular App to Your Hosting](#7-step-5--upload-the-angular-app-to-your-hosting)
8. [Step 6 — Configure the Web Server (URL Routing)](#8-step-6--configure-the-web-server-url-routing)
9. [Step 7 — Verify Everything Works](#9-step-7--verify-everything-works)
10. [Quick Configuration Reference](#10-quick-configuration-reference)
11. [Common Problems & Fixes](#11-common-problems--fixes)

---

## 1. How the System Works

The application has **two separate parts** that talk to each other:

```
[ Angular App ]  ←──── HTTPS API calls ────→  [ WordPress + Plugin ]
  Your web host                                  Your WordPress host
  e.g. app.yournewspaper.com                     e.g. wp.yournewspaper.com
```

| Part | What it does | Where it lives |
|------|-------------|----------------|
| **Angular App** | The newspaper viewer and admin editor your readers and staff use | Any static web host (Apache, Nginx, cPanel, Netlify, etc.) |
| **WordPress Plugin** | Stores all newspaper data and handles logins via the WordPress REST API | Your existing WordPress site |

The Angular App needs to know the URL of your WordPress site. The WordPress Plugin needs to know the URL of your Angular App. That is the entire configuration.

---

## 2. What You Need Before Starting

- [ ] A **WordPress site** (version 5.6 or newer) with admin access
- [ ] A **web hosting account** for the Angular app (even a shared cPanel host works)
- [ ] The **project source code** folder (the folder you received containing `src/`, `package.json`, `angular.json`, etc.)
- [ ] **Node.js 20+** installed on your local machine ([nodejs.org](https://nodejs.org))
- [ ] The WordPress **username and password** of the account that will manage newspaper content (must have the Administrator role)

---

## 3. Step 1 — Install the WordPress Plugin

The plugin folder is located inside the project at:

```
wordpress-plugin/
└── digital-newspaper/
    └── digital-newspaper.php
```

### Option A — Upload via WordPress Admin (easiest)

1. Zip the entire `digital-newspaper` folder (the one containing `digital-newspaper.php`).
   - On macOS: right-click → **Compress "digital-newspaper"**
   - On Windows: right-click → **Send to → Compressed (zipped) folder**
   - The result should be `digital-newspaper.zip`
2. Log in to your WordPress admin panel (`https://your-wordpress-site.com/wp-admin`).
3. Go to **Plugins → Add New Plugin → Upload Plugin**.
4. Click **Choose File**, select `digital-newspaper.zip`, then click **Install Now**.
5. After installation, click **Activate Plugin**.

### Option B — Upload via FTP/SFTP

1. Connect to your WordPress hosting using an FTP client (e.g. FileZilla).
2. Navigate to `wp-content/plugins/`.
3. Upload the entire `digital-newspaper` folder (not the zip) into `wp-content/plugins/`.
4. Log in to WordPress admin → **Plugins** → find **Digital Newspaper API** → click **Activate**.

### Verify the plugin is active

After activation you should see **"Digital Newspaper"** listed under **Settings** in your WordPress admin sidebar.

---

## 4. Step 2 — Configure the WordPress Plugin

1. In WordPress admin, go to **Settings → Digital Newspaper**.

2. In the **Allowed Origins** field, enter the full URL of your Angular app — this is the domain where you will host the Angular app (the address your users will visit):

   ```
   https://app.yournewspaper.com
   ```

   - Include `https://` (or `http://` if not using SSL).
   - **No trailing slash.**
   - If you want to allow multiple origins (e.g. also allow local development), separate them with commas:
     ```
     https://app.yournewspaper.com, http://localhost:4200
     ```

3. Leave the **Allow Credentials** checkbox **ticked** (this is required for the admin login to work).

4. Click **Save Changes**.

> **Why this matters:** Browsers block cross-origin requests unless the server explicitly permits them. This setting tells WordPress to allow the Angular app to communicate with it.

---

## 5. Step 3 — Configure the Angular App Source

This is the **only code change** you need to make before building.

Open the file:

```
src/app/config.ts
```

It looks like this:

```typescript
/** WordPress site root (no trailing slash). */
export const WP_BASE_URL = 'https://wp.rshossain.me';
```

Change the URL to your WordPress site's root address:

```typescript
/** WordPress site root (no trailing slash). */
export const WP_BASE_URL = 'https://your-wordpress-site.com';
```

**Rules:**
- Use the exact domain where WordPress is installed.
- **No trailing slash** at the end.
- Use `https://` if your WordPress site has SSL (it should).

**Example values:**

| Your WordPress URL | Correct value for `WP_BASE_URL` |
|---|---|
| `https://news.example.com` | `'https://news.example.com'` |
| `https://www.example.com/wp` | `'https://www.example.com/wp'` |
| `https://example.com` | `'https://example.com'` |

Save the file. This single change propagates to every part of the Angular app that communicates with WordPress.

---

## 6. Step 4 — Build the Angular App

Open a terminal in the root of the project folder (the folder containing `package.json`).

### Install dependencies (first time only)

```bash
npm install
```

This downloads all required packages into `node_modules/`. It takes 1–3 minutes. You only need to do this once.

### Build for production

```bash
npm run build
```

This compiles the Angular app into optimised static files. When it finishes you will see a new folder:

```
dist/
└── digital-newspaper/
    ├── index.html
    ├── main.<hash>.js
    ├── polyfills.<hash>.js
    ├── styles.<hash>.css
    └── assets/
```

The entire contents of `dist/digital-newspaper/` is what you upload to your web host. Do not rename or restructure files inside it.

---

## 7. Step 5 — Upload the Angular App to Your Hosting

Upload **the contents** of `dist/digital-newspaper/` (not the folder itself) to the public directory on your web host.

### If you are using cPanel / Hostinger / Bluehost

1. Log in to your hosting control panel.
2. Open the **File Manager**.
3. Navigate to the directory where you want the app:
   - For the root domain: `public_html/`
   - For a subdomain (e.g. `app.yournewspaper.com`): `public_html/app/` or wherever the subdomain points
4. Upload all files and folders from `dist/digital-newspaper/` into that directory.

### If you are using FTP (FileZilla or similar)

1. Connect to your hosting via FTP.
2. Navigate to `public_html/` (or your subdomain folder).
3. Upload everything inside `dist/digital-newspaper/`.

### If you are using Nginx or a VPS

Copy the build output to your webroot:

```bash
scp -r dist/digital-newspaper/* user@yourserver:/var/www/html/
```

Or use `rsync`:

```bash
rsync -avz dist/digital-newspaper/ user@yourserver:/var/www/html/
```

---

## 8. Step 6 — Configure the Web Server (URL Routing)

The Angular app uses **client-side routing** — when a user navigates or refreshes a page, the web server must always return `index.html` instead of a 404 error.

### Apache (cPanel / Hostinger / Bluehost / most shared hosts)

The build already includes a `.htaccess` file in `dist/digital-newspaper/`. Ensure it was uploaded along with the other files. If it is missing, create a file named `.htaccess` in your public directory with this content:

```apache
Options -MultiViews
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteRule ^ index.html [QSA,L]
```

### Nginx

Add the following inside your `server {}` block:

```nginx
location / {
    root /var/www/html;   # path to your uploaded files
    index index.html;
    try_files $uri $uri/ /index.html;
}
```

Reload Nginx after saving:

```bash
sudo nginx -s reload
```

### Netlify / Vercel / GitHub Pages (static hosts)

Create a file named `_redirects` (Netlify) or `vercel.json` (Vercel) in `dist/digital-newspaper/` before uploading:

**Netlify** — create `dist/digital-newspaper/_redirects`:
```
/*  /index.html  200
```

**Vercel** — create `dist/digital-newspaper/vercel.json`:
```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

---

## 9. Step 7 — Verify Everything Works

Open your Angular app URL in a browser (e.g. `https://app.yournewspaper.com`).

**Checklist:**

- [ ] The newspaper viewer loads without a blank white screen.
- [ ] The homepage shows the newspaper (if data has been added) or an empty state.
- [ ] Navigate to the **Admin** area (look for the admin login link, usually at `/admin`).
- [ ] Log in with your WordPress username and password.
- [ ] After login you should see the admin dashboard with no error messages.
- [ ] Try adding a test edition — it should save and appear in the viewer.

### How to test the API directly

Visit the following URL in your browser to confirm the WordPress plugin is working:

```
https://your-wordpress-site.com/wp-json/digital-newspaper/v1/data
```

You should see a JSON response (not a 404). If you see a 404, the plugin is not activated or WordPress permalinks are not set to **Post name** (see [Common Problems](#11-common-problems--fixes)).

---

## 10. Quick Configuration Reference

This table summarises every place a URL or configuration value must be set.

| # | File / Location | Setting | What to put there |
|---|---|---|---|
| 1 | `src/app/config.ts` | `WP_BASE_URL` | Full URL of your WordPress site, no trailing slash. E.g. `https://wp.yournewspaper.com` |
| 2 | WordPress Admin → **Settings → Digital Newspaper** → Allowed Origins | Text area | Full URL of your Angular app. E.g. `https://app.yournewspaper.com` |
| 3 | Web server config (`.htaccess` or Nginx) | URL rewriting | Redirect all unknown paths to `index.html` (see Step 6) |

> **That's it.** There are no environment variables, no `.env` files, and no database changes required on the Angular side.

---

## 11. Common Problems & Fixes

### The app shows a blank white page

**Cause:** The web server is not serving `index.html` for unknown routes, or the files were uploaded into a subfolder.

**Fix:**
- Confirm you uploaded the *contents* of `dist/digital-newspaper/`, not the folder itself.
- Confirm the `.htaccess` or Nginx rewrite rule is in place (see Step 6).
- Open browser DevTools (F12) → **Console** tab and look for red errors.

---

### "CORS error" in the browser console

**Cause:** The Angular app URL is not in the WordPress plugin's Allowed Origins list.

**Fix:**
1. Go to WordPress Admin → **Settings → Digital Newspaper**.
2. Make sure the **Allowed Origins** field contains the exact URL of your Angular app, including the protocol (`https://`), with no trailing slash.
3. Save and hard-refresh the Angular app (Ctrl+Shift+R / Cmd+Shift+R).

---

### Login fails with "Invalid credentials"

**Cause A:** Wrong username or password.

**Fix:** Try logging in directly at `https://your-wordpress-site.com/wp-admin` with the same credentials to confirm they are correct.

**Cause B:** The WordPress REST API is blocked by a security plugin (e.g. Wordfence, iThemes Security).

**Fix:** In your security plugin settings, whitelist the route `/wp-json/digital-newspaper/v1/*`.

---

### "404 Not Found" when hitting the WordPress API

**Cause:** WordPress pretty permalinks are not enabled.

**Fix:**
1. Log in to WordPress admin.
2. Go to **Settings → Permalinks**.
3. Select **Post name** (or any option other than "Plain").
4. Click **Save Changes** — this regenerates the `.htaccess` that powers the REST API.

---

### Images do not load / appear broken

**Cause:** Image URLs stored in the database point to the old development domain.

**Fix:** After uploading images through the admin, make sure you are uploading them from the new WordPress installation. The image proxy endpoint (`/wp-json/digital-newspaper/v1/proxy`) only allows images hosted on your WordPress domain.

---

### Admin saves do not persist after page refresh

**Cause:** The `WP_BASE_URL` in `config.ts` was not updated before building, so the app is still pointing to the old WordPress site.

**Fix:** Update `src/app/config.ts`, rebuild (`npm run build`), and re-upload the contents of `dist/digital-newspaper/`.

---

## Appendix — Project File Structure Reference

```
digital-newspaper/
├── src/
│   └── app/
│       └── config.ts          ← ⭐ ONLY file you edit before building
├── dist/
│   └── digital-newspaper/     ← Upload these files to your web host
└── wordpress-plugin/
    └── digital-newspaper/     ← Upload this folder to WordPress
        └── digital-newspaper.php
```

WordPress REST API endpoints provided by the plugin:

| Endpoint | Method | Auth required | Purpose |
|---|---|---|---|
| `/wp-json/digital-newspaper/v1/data` | GET | No | Retrieve all newspaper data |
| `/wp-json/digital-newspaper/v1/data` | POST | Yes | Save newspaper data |
| `/wp-json/digital-newspaper/v1/auth/login` | POST | No | Log in (returns token) |
| `/wp-json/digital-newspaper/v1/auth/me` | GET | Yes | Verify current session |
| `/wp-json/digital-newspaper/v1/proxy` | GET | No | Proxy images from WordPress host |
