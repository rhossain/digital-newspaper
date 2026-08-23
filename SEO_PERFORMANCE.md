# SEO & Performance — Deep Audit

**Reviewed:** 15 Aug 2026 · branch `development` · companion to `CODEBASE_REVIEW.md`
**Evidence base:** staged `src/`, `angular.json`, `ngsw-config.json`, the 8,532-line plugin PHP, plus — on the dev machine — `src/.htaccess` (225 lines), `src/styles.css`, `scripts/compress-dist.js`, and **the real build in `dist/digital-newspaper/browser/`** (4 Aug), which let me measure actual bytes rather than estimate them.

Every headline claim went through an adversarial verification pass. Where verification **downgraded** a finding, the correction is stated in place rather than quietly dropped — see the "corrected during verification" notes.

> **Not measured in the field.** The Chrome extension was not connected and WebFetch could not reach the origin, so there are no live Core Web Vitals, no response headers, and no waterfall in this report. Nine specific things that need a live request are listed in §7 with the exact commands.

---

## 0. The one-paragraph version

Googlebot currently sees **an empty HTML shell on every URL**, and there is **no link from any page to any other page** — so the crawl graph is a single node and roughly 128,000 article URLs are undiscoverable. Separately, the LCP image is **4–6 network round trips deep** on a cold load, and the code that would fix that is already written, shipped, and **turned off by four `false` defaults**. Two smaller items are pure self-harm: the LCP image is explicitly deprioritized in favour of a blurred placeholder, and every public reader's service worker background-downloads the entire admin bundle.

**Highest leverage, in order:** (1) turn on the four plugin flags, (2) add `.html` to the compression path before doing so, (3) fix the service-worker prefetch, (4) put Googlebot in the prerender path, (5) ship sitemaps.

---

## 1. SEO

### 1.1 What Googlebot actually sees — the defining problem

**Verified by tracing every RewriteRule in `src/.htaccess` in order.**

The social-crawler User-Agent list appears **five times verbatim** (`.htaccess:16, 17, 59, 64, 69`):

```
facebookexternalhit|Facebot|Twitterbot|Xbot|LinkedInBot|WhatsApp|Slackbot|
Slackbot-LinkExpanding|TelegramBot|Discordbot|Pinterest|vkShare|W3C_Validator|Googlebot-Image
```

`Googlebot-Image` is present. **Plain `Googlebot` is not.** Neither is `bingbot`, `DuckDuckBot`, `YandexBot`, `Applebot`, `PetalBot`, `GPTBot`, `ClaudeBot`, `PerplexityBot` or `CCBot`.

**Trace for a plain Googlebot request to `/`:**

1. `:34-39` — compression negotiation skipped (no file extension)
2. `:59/64/69` — UA conditions do not match
3. `:83` — `RewriteCond %{DOCUMENT_ROOT}/index.html -f` **fails**. Verified: `dist/digital-newspaper/browser/` contains only `index.csr.html`; `prerendered-routes.json` is `{"routes": {}}`
4. `:85` — serves `index.csr.html`, HTTP 200

What that file contains (measured, 9,728 B):

| | |
|---|---|
| `<html lang="en">` | **wrong** — 100% of the content is Bengali |
| `<title>` | present and good (bilingual, static) |
| `<meta name="description">` | **absent** — `grep -rn 'name="description"' src/` → no matches |
| `<link rel="canonical">` | **absent** |
| JSON-LD | **absent** |
| `<script id="dn-initial-state">` | present but **empty (0 bytes inner)** — `OPTION_INLINE_INDEX` defaults false |
| `<app-root>` | **empty** |

**Zero words of newspaper content.** Googlebot must queue the URL for the Web Rendering Service (hours to days), then wait out 4–6 round trips (§2.2), and finds a page whose content is an image.

**On an article URL** (`/2026-08-15/page-01/edition-01/post-12345/`): `:64-65` doesn't match → `:101-108` catch-all → **byte-for-byte the identical `index.csr.html`**. All ~128,000 article URLs return the same file with HTTP 200.

**Meanwhile `Googlebot-Image` *is* in the list**, so Google's image crawler receives the `/social` HTML — a document carrying `X-Robots-Tag: noarchive` (`digital-newspaper.php:3354`), `Cache-Control: no-store` (`.htaccess:222`), a `<script>window.location.replace(...)</script>` (`:3546`), and a `<body>` containing only "Redirecting to…". Googlebot and Googlebot-Image get materially different documents for the same URL — a cloaking signal — **and it actively prevents Google Images from indexing your page scans.**

**Fix.** Define the UA sets once with `mod_setenvif` so the five copies can't drift, add the search crawlers, and remove `Googlebot-Image`:

```apache
<IfModule mod_setenvif.c>
  # Social/link-preview crawlers: OG shell, JS-redirected to the app.
  SetEnvIfNoCase User-Agent "facebookexternalhit|Facebot|Twitterbot|Xbot|LinkedInBot|WhatsApp|Slackbot|Slackbot-LinkExpanding|TelegramBot|Discordbot|Pinterest|vkShare|W3C_Validator" IS_SOCIAL_BOT=1
  # Search + AI crawlers: SAME endpoint, but the PHP must emit real article text,
  # JSON-LD and a canonical, and must NOT emit the JS redirect or noarchive.
  # This is dynamic rendering, not cloaking — the content must be equivalent.
  # Googlebot-Image is deliberately EXCLUDED: it must reach the real image URLs.
  SetEnvIfNoCase User-Agent "Googlebot|Storebot-Google|Google-InspectionTool|bingbot|DuckDuckBot|YandexBot|Applebot|PetalBot|Baiduspider" IS_SEARCH_BOT=1
  SetEnvIfNoCase User-Agent "Googlebot-Image|Googlebot-Video|Googlebot-News" IS_SEARCH_BOT=0
  SetEnvIf IS_SOCIAL_BOT 1 IS_PRERENDER_BOT=1
  SetEnvIf IS_SEARCH_BOT 1 IS_PRERENDER_BOT=1
  SetEnvIf IS_PRERENDER_BOT 1 no-cache=1
</IfModule>
```

Then replace the three `RewriteCond %{HTTP_USER_AGENT} "…" [NC]` at `:59/64/69` with `RewriteCond %{ENV:IS_PRERENDER_BOT} =1`.

**And widen the `Vary`.** `.htaccess:222-224` sets `Vary: User-Agent` only `env=IS_SOCIAL_BOT` — i.e. only on the bot response, not the human one. Any shared cache that stores the bot HTML can then serve it to humans. Change to `Header always set Vary "User-Agent"`.

**Non-negotiable companion change:** if you route search bots to `/social`, the PHP must return equivalent content — real article body, no `window.location.replace`, no `noarchive`. Gate it:

```php
$isSearchBot = preg_match('/Googlebot|bingbot|DuckDuckBot|YandexBot/i',
                          (string) ($_SERVER['HTTP_USER_AGENT'] ?? ''));
$redirectScript = $isSearchBot ? '' : "<script>window.location.replace({$red});</script>";
```

Google explicitly sanctions this as **dynamic rendering** provided the content matches what the SPA renders. Serving structured data and then bouncing the crawler is not.

### 1.2 There is no crawlable link graph — verified

```
$ grep -rn "routerLink" src/
(no matches)
$ grep -rn "<a " src/app --include=*.html | wc -l
20
```

Of the 20 `<a>` elements in the entire application:

| Count | Destination |
|---|---|
| 12 | external social icons (`target="_blank"`), lines 150–190 and 246–286 |
| 6 | `tel:` / `mailto:` / external website, lines 319, 329, 343, 705, 715, 729 |
| 1 | commented-out `<a href="/admin">`, line 198 |
| **1** | `<a [href]="logoHref">` at line 107 — resolves to `settings.logo.link` or `document.baseURI`, i.e. **the homepage** |

> **Corrected during verification:** the original finding said "zero internal `<a href>`". That was wrong by one element — the logo link at `:107` is internal. It is a homepage self-link, so the conclusion is unchanged: there is no link from anywhere to any date, page or article.

Every navigation is a `(click)` handler (26 of them):

- Date archive: `<select [(ngModel)]="selectedDate">` at `:76`, `:233` — **`<option>` elements are not links**; Google does not enumerate them
- Prev/next day: `<button (click)="previousDay()">` at `:56` / `:67`
- Page thumbnails: `<div class="thumbnail-item" (click)="onPageClick(page)">` at `:383`
- Pagination: `<button class="pagination-page-btn">` at `:583`
- Sections: `<div class="clickable-section" (click)="sectionClick.emit(section)">` — `section-overlay.component.ts:29`

And the URL is never a real navigation — `updateUrl()` (`newspaper.component.ts:1947-1964`) uses `location.replaceState()`, which produces no navigation event and no followable link.

Combined with `{ path: '**', redirectTo: '' }` (`app.config.ts:34`) and the catch-all serving 200 for everything:

> **Google's crawl graph for this site is exactly one node: `/`. There is no edge from it to any other URL — not to yesterday, not to any page, not to any article.**

**Fixes, in order of leverage:**

**(a) Sitemaps.** The only thing that gets ~128k URLs discovered. See §1.4.

**(b) Make the existing controls real links.** Same UX (`$event.preventDefault()` then the existing handler), but crawlable and middle-clickable:

```html
<!-- newspaper.component.html:56 -->
<a class="date-nav-btn" [href]="previousDayHref()"
   (click)="$event.preventDefault(); previousDay()"
   [title]="ts.t('header.previousDay')" rel="prev">…</a>
```
```ts
/** Real href for the prev/next-day controls so crawlers (and middle-click, and
 *  "open in new tab") work. The (click) handler still does the SPA navigation;
 *  the href is what Googlebot follows. availableDates is sorted newest-first. */
previousDayHref(): string {
  const i = this.availableDates.indexOf(this.selectedDate);
  const d = i >= 0 ? this.availableDates[i + 1] : undefined;
  return d ? `/${d}/` : '';
}
nextDayHref(): string {
  const i = this.availableDates.indexOf(this.selectedDate);
  const d = i > 0 ? this.availableDates[i - 1] : undefined;
  return d ? `/${d}/` : '';
}
```

Apply the same pattern to the pagination buttons (`:583`), the thumbnail rail (`:383`) and — most importantly — the section overlays (`section-overlay.component.ts:29`), which are the URLs that carry actual article text.

**(c) A crawlable archive index.** The `<select>` at `:76` is the only archive UI. Add a `<nav>` of `<a>` elements for the last 30 dates plus a "full archive" link, or emit an `/archive/` route from the plugin (it already holds `dn_data_index.dates`) and link it from the footer at `:684`.

### 1.3 Missing head tags — exact insertion points

**`<meta name="description">`.** The string is *already computed* and then thrown away — `newspaper.component.ts:1996`:

```ts
const description = plainText.length > 155 ? plainText.slice(0, 152) + '...' : (plainText || siteName);
```

Four additions:

```ts
// newspaper.component.ts — section branch, first line of the block after :2001
// Standard meta description — this is what Google uses for the SERP snippet.
// og:description is ignored by Google's snippet generator.
this.meta.updateTag({ name: 'description', content: description });
```

Plus the page branch (after `:2029`), the default branch (after `:2050`), and a static fallback in `src/index.html` after line 13. **And in the plugin's `/social` heredoc** after `<title>` (`digital-newspaper.php:3527`) — that's what a crawler in the UA list actually receives.

**`<link rel="canonical">`.** Angular has no `Link` service; use `DOCUMENT`, already injected at `newspaper.component.ts:211`. Three complications, all real:

1. `TrailingSlashUrlSerializer` (`app.config.ts:59-66`) forces trailing slashes — but `updateUrl()` hand-builds strings that already end in `/`, so the serializer isn't even in the loop. Either way: **canonical must always end in `/`.**
2. **Six host aliases serve identical content** — `digital-newspaper.php:881-886` enumerates `https://epaper`, `http://epaper`, `https://www.epaper`, `https://nepaper`, `http://nepaper`, `https://www.nepaper`, all `.dailysangram.com`. Textbook duplicate-content split.
3. `pageUrl = this.document.location.href` (`newspaper.component.ts:1975`) inherits whichever alias the user landed on — **so `og:url` is currently non-canonical too.**

Add `canonicalOrigin: 'https://epaper.dailysangram.com'` to both environment files, then replace `:1975` with a `buildCanonicalUrl()` that always uses that constant (never `location.origin`) and an `updateCanonical()` that creates-or-updates the `<link>`. Because `og:url` and `twitter:url` already read `pageUrl`, one change fixes all three.

Back it up at the server layer — 301 the aliases rather than serving 200s. Insert after `RewriteBase /` (`.htaccess:23`), **before** the compression block:

```apache
# Collapse the six host aliases onto one canonical origin. Excludes /wp/ so
# WordPress admin/login keeps working on any alias.
RewriteCond %{HTTP_HOST} !^epaper\.dailysangram\.com$ [NC]
RewriteCond %{REQUEST_URI} !^/wp(?:/|-admin|-login\.php|$) [NC]
RewriteRule ^(.*)$ https://epaper.dailysangram.com/$1 [R=301,L,NE]
```

**`<html lang>`.** `src/index.html:2` is `lang="en"` with entirely Bengali content — a direct machine-readable signal that suppresses the site in Bengali-language results. Note the plugin **already gets this right**: `digital-newspaper.php:3521` emits `<html lang="bn">`. So a social crawler sees `bn` and Googlebot sees `en`, inconsistent by construction. Set `lang="bn"` statically, and sync it dynamically in `refreshSettings()` (`newspaper.component.ts:471`) right after `setLanguage()`. Add `og:locale` (`bn_BD`) while you're there, and fix `getPrintDocument()` at `:1509`, which emits `<html>` with no lang at all.

### 1.4 JSON-LD and sitemaps

**JSON-LD placement matters more than the schema.** Client-side injection is near-worthless *here* — not because Googlebot can't run JS, but because (a) every URL returns the same 200 shell so Google must render everything, putting article URLs in the render queue rather than the indexing pipeline; (b) `{path:'**', redirectTo:''}` makes stale URLs a soft-404 farm; (c) **Google News / Top Stories requires server-rendered structured data**; (d) Bing, Yandex and every LLM crawler run no JS at all.

**Emit it server-side in `/social`** (`digital-newspaper.php:3520`), as an `@graph` of `NewsArticle` + `NewsMediaOrganization` + `BreadcrumbList`. Field mapping against the real interfaces (`newspaper-data.service.ts:16-83`):

| Schema field | Source | Note |
|---|---|---|
| `headline` | `NewsSection.title` | truncate at 110 chars — Google's limit |
| `articleBody` | `stripHtmlToPlainText(NewsSection.content)` | strip helper at `:2073` |
| `image` | `/social-thumb?…` | guaranteed 1200×630 |
| `datePublished` | `NewspaperEdition.date` | **no time-of-day exists in the model** — `T00:00:00+06:00` is the honest representation |
| `dateModified` | `dataVersion` (microtime float) → ISO | |
| `author` | — | **absent from `NewsSection`**; fall back to the Organization |
| `isPartOf` | `PublicationIssue` from `date` + `edition` + `editionLabels` | add the paper's ISSN if it has one — a strong News signal |
| `pageStart` | `NewspaperPage.id` | |
| `inLanguage` | `GlobalSettings.language` | |

**Sitemaps.** The plugin already has the index (`dn_data_index`, and `get_dates_granular()` used at `:1925`). URL count, for **D** published dates at a typical 14 pages × ~25 sections:

| Granularity | Formula | D=365 | D=1000 |
|---|---|---|---|
| Date-level | D | 365 | 1,000 |
| Page-level | D × 14 | ~5,100 | ~14,000 |
| **Article-level** | D × 14 × 25 | **~128,000** | **~350,000** |

Article-level is the point — page-level URLs have no unique text to rank. But that exceeds the 50,000-URL limit, so: **a sitemap index plus month-partitioned children**, which keeps each child at ~10,850 URLs and means only the current month changes daily (efficient `lastmod`-driven recrawl). Add three routes next to `/data/dates` (`digital-newspaper.php:2942`): `/sitemap` (index), `/sitemap/(?P<month>\d{4}-\d{2})`, and `/sitemap-news` (last 48 h, per Google's News spec). Alias them in `.htaccess` **above** the `!-f`/`!-d` catch-all or they'll be swallowed by the SPA fallback.

URL shapes must match `updateUrl()` (`:1954`) and the `.htaccess` regex at `:65` **byte-for-byte, with trailing slashes** — note `:65` requires the edition segment to literally begin `edition-`, so emit whatever `getEditionSlug()` (`:727`) produces rather than hand-guessing.

**`robots.txt` does not exist.** No file matching `robots*` under `src/`, `dist/` or `wordpress-plugin/`. A request for `/robots.txt` therefore hits the catch-all at `.htaccess:108` and returns **`index.csr.html` with HTTP 200 and `Content-Type: text/html`**. Google treats an unparseable robots.txt as fully-allow, so you aren't blocked — but you publish no sitemap reference, no crawl guidance, and serve the whole app shell on every robots fetch.

> *Weak corroboration:* WebFetch refused this origin twice with robots.txt preflight errors ("Response too large", then "Failed to fetch or parse"). Consistent with the above, but not proof — verify with `curl -sI https://epaper.dailysangram.com/robots.txt`.

Create `src/robots.txt` and register it in `angular.json`'s assets array. Key decisions:

- **Do not blanket-disallow `/wp/`** — `/wp/wp-json/digital-newspaper/v1/social*` is where the only crawler-readable content lives and `/wp/wp-content/uploads/` holds every image. Disallow the sub-paths (`wp-admin`, `wp-login.php`, `xmlrpc.php`, `wp-json/`) and `Allow:` the social/thumb/crop/sitemap routes back.
- **Disallow `/admin` and `/admin/`** — because of the catch-all it returns 200 with the app shell, and Google will happily index a login screen.
- **Disallow `/wp/wp-content/dn-static/`** — internal JSON, not documents.
- Everything under `/{date}/…` stays open.

---

## 2. Performance — critical rendering path and LCP

### 2.1 What blocks the first paint

Measured from the real build. **Render-blocking resources: exactly two inline `<style>` blocks totalling 4,157 B. Zero render-blocking external CSS or JS.** That part is genuinely good.

The problem is what sits at **Highest** priority. `src/index.html:42-44` preloads three woff2 files:

| File | Bytes | `unicode-range` | Needed at first paint? |
|---|---|---|---|
| `google-sans-bengali-wght-normal.woff2` | **75,712** | `U+0980-09FE` | **Yes** — all UI and content |
| `google-sans-latin-wght-normal.woff2` | **36,204** | `U+0000-00FF`, punctuation | Marginal — a few ASCII strings |
| `google-sans-latin-ext-wght-normal.woff2` | **21,412** | Latin Ext-A/B, IPA, Latin Ext Additional | **No** — nothing in `bn.ts`, `en.ts` or Bengali article text falls in these ranges |

**Total: 133,328 B at Highest priority** — above the `modulepreload`/module scripts (High). So 130 KiB of fonts is pulled ahead of `main.js` on the same connection, and `main.js` is what eventually triggers the LCP image request. On a Bangladeshi mobile link that is roughly 1.5–2.5 s of head-of-line delay.

Drop `latin-ext` entirely, drop the `latin` *preload* (let it load from CSS), and subset the Bengali variable font to the ranges actually used plus a `wght` instance range — typically 75.7 KB → ~48–55 KB. **Preload budget: 133 KB → ~55 KB.**

> **Corrected during verification, twice.** (a) `font-display: swap` **is** already set on all three faces (`styles.css:11/20/29`) and survives into the inlined critical CSS — so there is no FOIT, and that item was removed. (b) The absence of `preconnect`/`dns-prefetch` is **not a defect for fonts** — they are self-hosted and same-origin, so there is nothing to preconnect to. It *is* still worth adding a `preconnect` for `securepubads.g.doubleclick.net`, which is discovered cold at roughly T+2 s when `AdService` resolves `/ads/config` (`ad.service.ts:103` → `:147`).

**`inlineCritical` is a net loss here, but a small one.** Measured: `index.csr.html` = 9,728 B, containing a 1,051 B hand-written splash block plus a 3,106 B Critters block; `styles-E6D5HBFY.css` = 4,808 B with `.br` (1,361 B) and `.gz` siblings present. The deferred load uses the correct `media="print" onload="this.media='all'"` + `<noscript>` pattern.

> **Corrected during verification:** the original finding framed this as meaningful waste. It isn't — the redundant transfer is ~1 KB against a stylesheet that ships as 1,361 B brotli. Compared with 133 KB of fonts or 214 KiB of admin prefetch, this is noise. **Deprioritized to a footnote.** The one real observation that survives: the inlined block includes the full `:root` token set (~60 custom properties), almost all consumed by `admin.component.css`. Moving those to an admin-only stylesheet is worth ~2 KB of the inlined block.

### 2.2 The LCP chain — 4 to 6 round trips

**LCP element:** `newspaper.component.html:656`, the `<img #mainImage class="main-page-image">`.

Except it probably isn't — and that's the finding. **Verified:**

```html
<!-- newspaper.component.html:621 — the blur-up placeholder -->
fetchpriority="high"
<!-- :662 — the actual LCP image -->
[attr.fetchpriority]="mainThumbSrc ? 'auto' : 'high'"
<!-- :668 -->
[style.opacity]="imageLoaded ? '1' : '0'"
```
```css
/* newspaper.component.css:1017-1022 */
.main-page-image { width:100%; height:auto; display:block; transition: opacity 0.3s ease; }
```

Three self-inflicted problems stacked:

1. The decorative blurred placeholder gets `fetchpriority="high"`; the image the user came for is **demoted to `auto`** whenever a thumbnail exists.
2. An element at `opacity: 0` **is not an LCP candidate at all**. So Chrome's LCP is the `filter: blur(4px)` placeholder, and the real image only becomes a candidate after `(load)` fires and a CD pass runs.
3. The 300 ms opacity ramp then adds up to **300 ms of pure measurement penalty** for zero user benefit — the blurred thumb underneath is already showing the same picture.

Fix: swap `fetchpriority` on the two elements, delete `transition: opacity 0.3s ease`, and use `visibility` rather than `opacity: 0` so the element is a candidate as soon as it paints. Keep the fade-*out* on the placeholder — that's free.

**Cold-load round trips (empty cache, first visit, today's defaults):**

| RT | Requests |
|----|----------|
| 1 | `GET /` → `index.csr.html` |
| 2 | 3× woff2 (133 KB), `styles.css`, `logo.png`, manifest, favicon, `polyfills.js`, `main.js`, 2 modulepreloaded chunks |
| 3 | `ads/config` **(PHP)**, `settings.json`, `dates.json`, `version.json`, `editions/<today>.light.json` — 5 parallel |
| 4 | *conditional* — `editions/<today>.json` 404 → `data/editions/<today>` **(PHP)**, when today's paper isn't published yet |
| 5 | *conditional* — `editions/<latestDate>.json` (the `remainingDates` batch at `newspaper-data.service.ts:871`) |
| **6** | **LCP image** + placeholder + first 2 eager thumbnails |
| 7 | `gpt.js` — new origin, cold DNS+TCP+TLS |

**Best case (paper published, warm `dn_latest_date`): the LCP image is requested on RT 4. Realistic first visit: RT 6.** At 150–400 ms RTT the image *starts downloading* 1.2–3.5 s in, before a byte of the page scan has moved.

Two structural contributors worth naming: `AdService`'s **constructor** (`ad.service.ts:103`) fires `/ads/config` — a PHP request on the critical path before any content request; and on a first-ever visit `speculativeDate` resolves to *today* (`newspaper-data.service.ts:792`), so if today's edition isn't published yet you pay an extra 404 → PHP fallback → second `forkJoin`.

### 2.3 The fix already exists and is switched off

**Verified** — four flags, all defaulting `false`:

```php
394:  $static_snapshots = (bool) get_option(self::OPTION_STATIC_SNAPSHOTS, false);
395:  $inline_index     = (bool) get_option(self::OPTION_INLINE_INDEX, false);
396:  $preload_lcp      = (bool) get_option(self::OPTION_PRELOAD_LCP, false);
397:  $uploads_cache    = (bool) get_option(self::OPTION_UPLOADS_CACHE, false);
```

Together they collapse the chain above from 6 round trips to **2** — the HTML carries the state inline, and the image preload starts during HTML parse. **The code is written, shipped, and reviewed. This is a checkbox in WP admin.**

> **Two honest caveats.** (1) Code defaults describe the fallback when the option row is absent — they say nothing about the live DB. Corroborating evidence that `INLINE_INDEX` is currently off: the `dn-initial-state` tag in the built HTML is empty. Note also that `regenerate_snapshots_action()` at `:2292` does `update_option(OPTION_STATIC_SNAPSHOTS, true)`, so clicking "Regenerate snapshots now" permanently enables that one. (2) **Do not enable `INLINE_INDEX` before fixing compression** — see §3.1.

**Three bugs to fix in `build_first_page_preload_block()` (`digital-newspaper.php:2179-2213`) before or alongside enabling `PRELOAD_LCP`:**

1. **The high-priority preload goes to the thumbnail** and the full image gets default priority — the same inversion as §2.2, at a second layer.
2. **No `imagesrcset`.** Correct *today* (no variants exist), but the moment anyone populates `imageVariants.webp`, `newspaper.component.ts:940` emits a `<source>`, the browser picks the WebP, and the preloaded full image becomes a 100% wasted multi-hundred-KB download.
3. **Injection point.** `:2153` injects before `</head>` — after the font preloads. Since `as=font` outranks `as=image`, the 133 KB of fonts still wins the wire. Anchor it right after the viewport meta instead, and combine with the font diet in §2.1 — **that combination is what actually unlocks the win.**

**One thing to check before enabling:** `src/app/config.ts:8` claims production points at `nepaper.dailysangram.com` while `environment.prod.ts:7` says `epaper`. The plugin writes preload hrefs normalised to `home_url()`; Angular's `resolveImageUrl()` rewrites to `environment.wpBaseUrl`'s origin. **If those disagree, every reader double-downloads the full page image.** (The stale comment is a known item — see `CODEBASE_REVIEW.md`.)

---

## 3. Performance — network, caching, service worker

### 3.1 `index.csr.html` is never served pre-compressed

**Verified on both sides:**

```js
// scripts/compress-dist.js:39 — no .html
const COMPRESSIBLE_EXT = new Set(['.js', '.mjs', '.css', '.json', '.svg', '.webmanifest']);
```
```apache
# .htaccess:36 and :39 — no html in the alternation
RewriteRule ^(.+\.(?:js|mjs|css|json|svg|webmanifest))$ $1.br [L]
```
```
$ ls dist/digital-newspaper/browser/*.html*
index.csr.html   9728      # no .br, no .gz
```

The two producers are otherwise in **exact lock-step** — no orphans in either direction, exactly as the author's comment claims. `.html` is the single gap, and it's the most-requested file on the site.

At 9,728 B this is minor today. **It becomes the difference between a good idea and a bad one the moment you enable `INLINE_INDEX`**, which pushes the shell to an estimated 55–70 KB of JSON (derived from `PERFORMANCE_OPTIMIZATION_STRATEGY.md:112`'s "a year ≈ 18 MB" ÷ 365 — not measured). Brotli on that JSON is roughly 7×, so you'd ship ~60 KB more than necessary on every single load.

Three coordinated changes: add `.html` to `COMPRESSIBLE_EXT`; add `html` to both `.htaccess` alternations **and** add a `<FilesMatch "\.html\.(?:br|gz)$">` block setting `Content-Type: text/html` and `Cache-Control: no-cache` (the existing `<FilesMatch "^index(\.csr)?\.html$">` at `:120` will **not** match `index.csr.html.br`); and — easy to miss — teach the plugin's `atomic_write()` to re-compress. It currently only writes siblings for `.json` (`digital-newspaper.php:1839`), but `maybe_rewrite_index_html()` calls it on a `.html` path at `:2161`. **Without that, the stale `.br` from the last `npm run build` gets served instead of the freshly-inlined HTML** — a silent correctness bug armed the moment both features are on.

### 3.2 Every reader's service worker downloads the admin bundle

**Verified by parsing the generated `dist/digital-newspaper/browser/ngsw.json`:**

```
NAME: app-shell | installMode: prefetch | updateMode: prefetch
urls: /assets/favicon.png, /assets/image-unavailable.svg,
      /chunk-3E2P4WFJ.js, /chunk-5HGGXWUV.js, /chunk-GDV5J4TR.js, /chunk-TFQ4GFBG.js,
      /favicon.ico, /index.csr.html, /main-4FIIML5A.js, /manifest.webmanifest,
      /polyfills-5CFQRCPP.js, /styles-E6D5HBFY.css
```

Chunk identification by grepping the minified bundles:

```
chunk-GDV5J4TR.js  716,920 B  ql-editor×157, admin×53, BulkXmlImport×9,
                              sheet_to_json×3, book_new×1, "SheetJS"×2   → admin + xlsx
chunk-5HGGXWUV.js  204,722 B  Quill×7, blots/block×2                     → quill core
chunk-3E2P4WFJ.js  378,019 B  Angular framework (in the initial graph)
```

Neither admin chunk is referenced by `index.csr.html` — they are genuinely lazy. But the `app-shell` group's `/*.js` glob is `installMode: prefetch`, so **the service worker background-downloads both on first visit, for every public reader, and re-downloads them on every deploy** (`updateMode: prefetch`).

This exactly defeats `AuthAwarePreloadingStrategy` (`app.config.ts:45-53`), whose docstring says it exists so readers don't pay for "the ~689 KB admin bundle."

> **Corrected during verification:** the headline "921 KB" is *disk* bytes. `.br` siblings exist (167,458 + 51,705 B) and `.htaccess:34-36` negotiates them, so the real wire cost is **~214 KiB**, roughly 4.3× smaller than the raw figure. Still a genuine regression — 214 KiB of admin code pushed to every reader on install and on every release — but the number should be stated honestly.

**Fix** — split the group in `ngsw-config.json`:

```json
{ "name": "app-shell", "installMode": "prefetch", "updateMode": "prefetch",
  "resources": { "files": [
    "/favicon.ico", "/assets/favicon.png", "/assets/image-unavailable.svg",
    "/index.csr.html", "/manifest.webmanifest",
    "/*.css", "/main-*.js", "/polyfills-*.js" ] } },
{ "name": "lazy-chunks", "installMode": "lazy", "updateMode": "prefetch",
  "resources": { "files": ["/chunk-*.js"] } }
```

Trade-off to accept knowingly: `chunk-3E2P4WFJ.js` (378 KB, Angular core) *is* in the initial graph and is `modulepreload`ed, so moving it to `lazy` means the SW fetches it on demand. For a first visit that's identical — it's on the critical path anyway — and it's cached after the first load. The 214 KiB saving is worth it.

While you're in that file: `ngsw-config.json:24` lists `"/index.html"`, which doesn't exist in the build. Angular resolves globs against real files so it's silently dropped and harmless — but delete it, it's confusing.

### 3.3 `.htaccess` — what's right and what's wrong

**Correct and well-reasoned** (do not "fix" these): the LiteSpeed `no-cache=1` env for social bots (`:15-18`); the *internal* rewrite rather than a 302 for crawlers, with correct RFC 7230 reasoning about raw Bengali in a `Location:` header (`:46-70`); `no-cache, must-revalidate` on `index(.csr).html` (`:119-123`) — necessary given hashed bundle references; the `no-gzip dont-vary` double-compression guard (`:200-203`); and `ngsw.json`/`ngsw-worker.js` no-store with `(\.(?:br|gz))?` in the FilesMatch so it survives negotiation (`:209-217`) — a subtle detail, correctly handled.

**Defects, by severity:**

**(a) No security headers at the Apache layer — and the plugin's never fire for the app.** `digital-newspaper.php:746-748` sets `X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy` inside `add_public_security_headers()`, which runs on **REST callbacks only**. `add_csp_report_only_header()` (`:781`) is hooked to `send_headers`, which does not fire for a file Apache serves directly. **The entire security-header story is dead for the actual application.** No HSTS anywhere. Add an explicit `mod_headers` block after `:123`. (Hold `includeSubDomains` until every `*.dailysangram.com` host is HTTPS-only.)

**(b) Hashed assets may be losing their 1-year cache.** `mod_expires` (`:126-139`) keys off `ExpiresByType application/javascript`, but the file actually served is `main-4FIIML5A.js.br`. Whether `mod_expires` resolves the type through the unknown `.br` extension is host-dependent — and the presence of an explicit `Header set Content-Type` block at `:183-188` strongly suggests the author already hit this. Also, `mod_expires` never emits `immutable`. Make it deterministic:

```apache
# Hashed Angular assets are content-addressed. Set explicitly (not via
# mod_expires) because the pre-compressed .br/.gz siblings do not reliably
# resolve a Content-Type that ExpiresByType can match on LiteSpeed.
<FilesMatch "-[A-Z0-9]{8}\.(?:js|css)(\.(?:br|gz))?$">
  Header set Cache-Control "public, max-age=31536000, immutable"
  Header unset Expires
</FilesMatch>
```

(The `-[A-Z0-9]{8}` pattern matches Angular's `outputHashing: "all"` format — verified against `main-4FIIML5A.js`, `styles-E6D5HBFY.css`.)

**(c) Fonts get a 1-year cache but are *not* content-hashed.** `styles.css:3-4` deliberately uses root-relative `/assets/fonts/…` to stop esbuild hashing them. If you re-subset the fonts per §2.1, **returning visitors are stuck on the old file for up to a year.** Version the path (`/assets/fonts/v2/…`) on every font change, or drop woff2 to 30 days.

**(d) `Vary: Accept-Encoding` is only emitted on the compressed path.** `:177`/`:181` sit inside `<FilesMatch "\.br$">` / `"\.gz$">`, so a client without `br`/`gzip` gets the plain file with **no `Vary`** — poisonable by any shared cache that saw the compressed response first. Hoist a global `Header append Vary Accept-Encoding` for the text types.

**(e) Minor.** `FileETag` is never set, so Apache's default embeds the inode and breaks 304s across nodes — set `FileETag MTime Size`. `RewriteCond %{HTTP:Accept-Encoding} br` (`:34`) is a naive substring match that also matches `br;q=0` (explicit refusal). The `index.html` preference rule at `:83-84` is **dead** — that file doesn't exist, and the comment at `app.config.server.ts:8-10` claiming Angular emits a static `index.html` is wrong (`RenderMode.Client` emits `index.csr.html`).

### 3.4 SW cache policy vs. server headers

| Endpoint | PHP emits | SW dataGroup | Conflict |
|---|---|---|---|
| `/data/editions/:date` | `no-cache, must-revalidate` + ETag | `freshness`, 24 h | Minor — ngsw manages its own metadata, so an offline user can get a 24 h-old edition despite `must-revalidate`. Acceptable for a newspaper; know it. |
| `/section-crop` | `max-age=3600` | **not matched** (no file extension in the URL) | Section crops re-fetch every session. 304s, but N requests per article view. Add a dataGroup for `/**/section-crop*`. |
| `wp-content/uploads/**` | `immutable, 1 yr` — **only when `OPTION_UPLOADS_CACHE` is on, which it isn't** | `performance`, 30 d, maxSize 300 | **Real conflict.** SW-controlled clients are fine; **first-load, bot, and pre-install traffic re-downloads every page scan.** Turn the flag on. |

---

## 4. CLS

Structural credit first: `styles.css:127-139` makes the whole app a fixed-viewport flex layout with internal scroll panels, which contains a large fraction of what would otherwise be page-level shift.

| # | Source | Mitigated? |
|---|---|---|
| **C1** | **Ad slots render 0 px until `/ads/config` resolves**, then jump to `min_height` — 250 px for `desktop_page_right` (`digital-newspaper.php:610`). `ad-slot.component.html:1` gates on `slot()`, which is `undefined` until `AdService._fetch()` returns. | **No — likely the single largest CLS contributor** |
| **C2** | Left panel renders empty while `!adService.ready()` (`newspaper.component.html:365-372`), then pops in either an ad or the entire thumbnail rail | **No** |
| **C3** | Pagination bar (~41 px) inserts *above* the image once the edition loads (`:569`) | **No** |
| **C7** | `contain-intrinsic-size: 0 200px` on thumbnails (`newspaper.component.css:593`) vs a real height of ~290 px — every item grows 90 px as it scrolls into relevance | **No** |
| **C9** | Centre-panel skeleton is a single grey rectangle (`:770-776`); real content is toolbar + pagination + image wrapper with different margins | **No** |
| **C15** | Heavy-Ad collapse sets `display:none` on an already-visible 250 px slot (`ad-slot.component.ts:156-187`) — *creates* a shift to fix a blank | **No — trades one problem for another** |
| C5 | Main image has real `width`/`height` from `dn_attach_page_dimensions()` → browser derives `aspect-ratio` | **Yes — well done** |
| C5b | …**except** on the legacy-blob path: `dn_attach_page_dimensions()` has 3 call sites (`:1965`, `:2008`, `:4799`), none in `get_data()` | **No** on that path |
| C6 | Thumbnail rail uses `aspect-ratio: 0.7071` + absolutely-positioned img | **Yes** |
| C4, C11, C13 | Pagination `ResizeObserver` (width-only), update banner (`position:fixed`), splash removal (`position:fixed`) | **Yes** |
| C8 | FOUT reflow on the `font-display: swap` flip — no `size-adjust`/`ascent-override` on any fallback | **No** — every Bengali glyph reflows when the 75 KB font lands |

**The highest-value CLS fix is C1.** Reserve the slot's declared box *before* the config resolves, using a static map in `ad-slot.component.ts` that mirrors `gam_ad_slots()` (`digital-newspaper.php:594-685`) — the server stays authoritative for *whether* a slot renders; the client only needs the dimensions to hold space. Also remove `!slot()` from the host `dn-ad--hidden` binding (`ad-slot.component.ts:54`) or the placeholder itself gets `display:none`.

For C8, add a metric-overridden `@font-face` fallback (`local('Noto Sans Bengali')`, `local('Nirmala UI')`) with measured `size-adjust`/`ascent-override`/`descent-override`. Derive the real numbers rather than guessing:

```
python -c "from fontTools.ttLib import TTFont; f=TTFont('…woff2'); print(f['head'].unitsPerEm, f['hhea'].ascent, f['hhea'].descent)"
```

---

## 5. INP and main-thread work (reader route)

**Good news first:** there is **no `APP_INITIALIZER`** anywhere, section overlays use pure CSS absolute positioning with native `(click)` handlers — **no JS hit-testing, no `getBoundingClientRect` loops** — and the pagination `ResizeObserver` is correctly guarded so it only ticks when the integer width changes.

**1. The MutationObserver on ad containers runs inside the Angular zone.** Verified — `ad-slot.component.ts:167-186` creates `new MutationObserver(...)` with `{childList: true, subtree: true}`, and `NgZone`/`runOutsideAngular` appear nowhere in the file. zone.js patches `MutationObserver`, so **every DOM mutation GPT makes while constructing the SafeFrame schedules a full app tick.** With 2–4 slots that can be 50–200 ticks across the whole `NewspaperComponent` tree. This is a plausible primary INP contributor whenever ads are on. Wrap the observer in `zone.runOutsideAngular()` and re-enter with `zone.run()` only for the signal write.

**2. ~1,000 section clones per render.** Verified — `newspaper.component.ts:540-545`:

```ts
this._sectionByIdCache = new Map<string, NewsSection>();
for (const page of this.pages) {
  for (const section of page.sections) {
    this._sectionByIdCache.set(section.id, { ...section, pageId: page.id });
  }
}
```

40 pages × ~25 sections, each spread copying a `content` string that can be several KB of article HTML — the heaviest allocation on the reader path. Since these objects come straight from `JSON.parse` and nothing else aliases them, set `pageId` in place and store the reference.

**3. Synchronous 50 KB `localStorage` write.** Verified — `edition-cache.service.ts:212-218` calls `_persistAll` → `localStorage.setItem(key, JSON.stringify({editions}))` with no `setTimeout`/`requestIdleCallback` anywhere in the file. That's 5–20 ms of blocking I/O on a cheap device.

> **Corrected during verification:** the original finding said this runs *in the `NewspaperDataService` constructor, before first paint*. It doesn't — today. `seedFromLoadedData` is called only inside `if (inlineState)` (`newspaper-data.service.ts:383-391`), and `bootstrapState.read()` returns `null` when the tag is empty, which it currently is. **But this is armed the moment you enable `INLINE_INDEX` (§2.3)** — at which point the largest payload the app ever holds gets stringified synchronously during service construction. Defer it via `requestIdleCallback` *before* flipping that flag, not after.

**4. The 5-minute version poll re-renders under the user's fingers.** `newspaper.component.ts:322` → on any version bump, `reloadCurrentDateOnly()` re-runs the full `renderCurrentEdition()` pass including the 1,000-clone loop and a synchronous `detectChanges()`. Guarded only by "no modal open". Add a `visibilityState` gate, and stop the poll entirely while hidden — a backgrounded tab currently fires ~96 pointless requests per 8 hours.

**5. Zoneless is close.** Every component on the reader route is already `OnPush`, and the ~15 manual `detectChanges()`/`markForCheck()` calls are already explicit. `provideZonelessChangeDetection()` + dropping the `zone.js` polyfill removes 11.3 KB brotli **and** eliminates every tick from the patched-API table (9 `setTimeout`s, the resize debounce that ticks twice, ~42 `img.onload` handlers per edition, the document click handler, and the ad MutationObserver). That's the correct end state; it needs an audit of the `setTimeout` sites first.

---

## 6. Prioritized fix list

**S** ≈ under an hour · **M** ≈ a day · **L** ≈ a week+. Sorted by impact ÷ effort.

| # | Item | Area | Effort | Impact | Where |
|---|---|---|---|---|---|
| 1 | **Add `.html` to compression** (compress-dist + both `.htaccess` alternations + `atomic_write`) | Network | S | Prerequisite for #2 — without it #2 ships ~60 KB uncompressed and can serve a stale `.br` | `compress-dist.js:39`; `.htaccess:36,39,175`; `digital-newspaper.php:1839` |
| 2 | **Turn on the four plugin flags** (after #1) | LCP | S | Cold-load chain **6 RT → 2 RT**. Biggest single win. | `digital-newspaper.php:394-397` |
| 3 | **Fix the SW prefetching admin chunks** | Network | S | −214 KiB background download per reader, per release | `ngsw-config.json:27-28` |
| 4 | **Drop `latin-ext` + the `latin` preload; subset Bengali** | LCP | S | −78 KB off the Highest-priority band; unblocks the JS bundle | `index.html:42-44`; `styles.css:8-33` |
| 5 | **Add search crawlers to the prerender UA set; remove `Googlebot-Image`** | SEO | S | Googlebot goes from empty shell → real HTML; removes a cloaking signal | `.htaccess:16,17,59,64,69` |
| 6 | **Fix the `fetchpriority` inversion + drop the 300 ms opacity ramp** | LCP | S | Makes the real image the LCP element; −up to 300 ms measured | `newspaper.component.html:621,662,668`; `.css:1021` |
| 7 | **Reserve ad-slot height before `/ads/config` resolves** | CLS | S | Removes a 250 px shift — likely the largest CLS contributor | `ad-slot.component.html:1`; `ad-slot.component.ts:54` |
| 8 | **`<html lang="bn">`** | SEO | S | Unblocks Bengali-language SERP eligibility | `index.html:2` |
| 9 | **Add `<meta name="description">`** (4 sites) | SEO | S | SERP snippets — the string is already computed and discarded | `index.html:13`; `newspaper.component.ts:2001,2029,2050`; `php:3527` |
| 10 | **Add `robots.txt`** + register in `angular.json` assets | SEO | S | Stops serving the app shell as robots.txt; carries the sitemap ref | new `src/robots.txt` |
| 11 | **`MutationObserver` → `runOutsideAngular`** | INP | S | Removes 50–200 full app ticks per ad render | `ad-slot.component.ts:185` |
| 12 | **`contain-intrinsic-size: auto 290px`** | CLS | S | Removes per-thumbnail scroll shifts | `newspaper.component.css:593` |
| 13 | **Security headers at the Apache layer** (HSTS, nosniff, Referrer-Policy) | Network | S | The plugin's versions never fire for the SPA — this is a fully open gap | `.htaccess:123` |
| 14 | **Explicit `immutable` on hashed assets** | Network | S | Makes the 1-yr cache deterministic instead of host-dependent | `.htaccess:174-198` |
| 15 | **Stop cloning ~1,000 sections per render** | INP | S | Heaviest allocation on the reader path | `newspaper.component.ts:540-545` |
| 16 | **Defer `_persistAll` off the boot path** — do this *before* enabling `INLINE_INDEX` | INP | S | Prevents a 5–20 ms pre-paint block that flag #2 would arm | `edition-cache.service.ts:212,322,345` |
| 17 | **Version poll: gate on `visibilityState`** | INP | S | Kills a 50–150 ms long task every 5 min + ~96 idle requests per 8 h | `newspaper.component.ts:322-336` |
| 18 | **`preconnect` to `securepubads`** | CRP | S | −~300 ms to first ad | `index.html:38` |
| 19 | **Canonical + alias 301s** (6 hosts serve identical content) | SEO | M | Consolidates link equity; fixes `og:url` and `twitter:url` too | `newspaper.component.ts:1975`; `.htaccess:23` |
| 20 | **Variant-aware `imagesrcset` in the preload block; inject before the fonts** | LCP | M | Prevents a future full double-download; lands the preload earlier | `digital-newspaper.php:2196-2212,2152` |
| 21 | **Sitemap index + monthly + news endpoints** | SEO | M | The **only** mechanism that gets ~128k article URLs discovered | `digital-newspaper.php:2942` |
| 22 | **Server-side JSON-LD in `/social`; drop the JS redirect for search bots** | SEO | M | Rich results + Top Stories eligibility | `digital-newspaper.php:3520` |
| 23 | **Make prev/next-day, pagination, thumbnails and section overlays real `<a href>`** | SEO | M | Creates a crawl graph that currently has exactly one node | `newspaper.component.html:56,67,383,583`; `section-overlay.component.ts:29` |
| 24 | **Metric-matched `@font-face` fallback** | CLS | M | Eliminates the FOUT reflow of every Bengali glyph | `styles.css:33` |
| 25 | **Make skeletons geometrically match real content** | CLS | M | Removes the skeleton→content shift | `newspaper.component.html:441`; `.css:770` |
| 26 | **Move the 60-token `:root` block to an admin-only stylesheet** | CRP | M | −~2 KB of inlined critical CSS the reader never uses | `styles.css:38-120` |
| 27 | **`provideZonelessChangeDetection()`; drop `zone.js`** | INP | L | −11.3 KB br; eliminates every tick in §5. All reader components already `OnPush`. | `app.config.ts:69`; `angular.json:28` |
| 28 | **Real build-time prerender fed from `dn-static/editions/*.json`** instead of the REST API | SEO / LCP | L | Makes #5, #22, #23 largely redundant; real HTML for every crawler, sub-1 s LCP. Sidesteps the Imunify360 problem that killed `RenderMode.Prerender`. | `app.config.server.ts:29-32` |

---

## 7. What I could not verify

Stated plainly rather than guessed. Items 1–5 need a live HTTP request; the Chrome extension was not connected and WebFetch could not reach the origin.

1. **Whether `index.csr.html` is actually served uncompressed.** Three strong indicators (§3.1) but it needs:
   `curl -sI -H 'Accept-Encoding: br,gzip' https://epaper.dailysangram.com/ | grep -i content-encoding`
2. **Whether `mod_expires` resolves `application/javascript` for `main-*.js.br` on this LiteSpeed build.** Fix #14 makes it moot either way.
3. **HTTP/2 vs HTTP/3.** No protocol config anywhere in the repo (the host controls it). If it's HTTP/1.1, the 133 KB font block is *far* more damaging than estimated — 6 connections, strict FIFO.
   `curl -sI --http2 https://epaper.dailysangram.com/ -o /dev/null -w '%{http_version}\n'`
4. **Which element Chrome actually picks as LCP.** The blurred placeholder sits right on the 0.05 bpp entropy-exclusion threshold. `web-vitals.service.ts:111-120` already collects this — add a `PerformanceObserver` that logs `entry.element`.
5. **The exact number of published dates** (drives the sitemap URL count):
   `curl -s '…/wp-json/digital-newspaper/v1/data/dates' | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["dates"]))'`
6. **The live values of the four feature flags.** Code defaults are `false`; the DB may differ, and `:2292` flips `STATIC_SNAPSHOTS` to `true` whenever anyone clicks "Regenerate snapshots now". Check `wp_options`.
7. **The actual byte size of the inlined `dn-initial-state` blob.** Estimated 55–70 KB from a figure in your own `PERFORMANCE_OPTIMIZATION_STRATEGY.md:112`, not measured.
8. **Whether the deployed WordPress `home_url()` host is `epaper` or `nepaper`.** `config.ts:8` and `environment.prod.ts:7` contradict each other, and the answer determines whether the LCP preload double-fetches.
9. **Whether `static.dailysangram.com` is a live image CDN.** It's allow-listed in the plugin's CSP (`:798`) and described in a comment as the image CDN — but `resolveImageUrl()` (`newspaper.component.ts:1418`) rewrites anything containing `/wp-content/uploads/` back to the WP origin, which would **defeat the CDN entirely**. If it's live, that function needs an exclusion.
10. **Whether the PHP `brotli` extension is present** (`digital-newspaper.php:1850`). If absent, JSON snapshots ship gzip-only — fine, but ~15–20 % left on the table. `php -m | grep -i brotli`.

**One more, worth flagging separately:** the plugin's CSP (`digital-newspaper.php:798`) has `script-src 'self'` with **no `securepubads.g.doubleclick.net`**. It's `Report-Only` and, per §3.3(a), never actually fires for the SPA — so nobody is seeing the violation reports. If it were ever promoted to enforced, **all ads would break instantly.**
