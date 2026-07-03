# Support Request — Enable Static-File Compression (LiteSpeed)

Copy the message below into a support ticket to your hosting provider (the site
runs on **LiteSpeed**). This is the single highest-impact change for site speed:
it compresses **all** static assets at once — JavaScript, CSS, and the JSON the
e-paper loads — typically a 6–7× reduction in transfer size.

---

## Why this is needed (evidence)

Measured on `https://nepaper.dailysangram.com` (staging), static files are being
served **uncompressed**:

| File | Type | Served size | Compressed (expected) |
|---|---|---|---|
| `main-*.js` (app bundle) | `application/javascript` | ~164 KB | ~45 KB |
| `editions/<date>.json` (e-paper data) | `application/json` | ~360 KB | ~50 KB |

Responses come back with **no `Content-Encoding` header**. Only `text/html` is
being compressed. `.htaccess` `mod_deflate` / `mod_brotli` directives are ignored
by LiteSpeed, so this must be enabled at the server level.

---

## Message to paste to the host

> **Subject: Please enable Gzip/Brotli compression for static files on my account**
>
> Hi,
>
> My site is hosted on LiteSpeed. Static assets (JavaScript, CSS, and JSON) are
> currently being served **without compression** — responses have no
> `Content-Encoding` header and only HTML appears to be compressed.
>
> Could you please **enable Gzip and Brotli compression for static content** on
> my account, and ensure the following MIME types are included in the
> compressible/“gzip-able” types list:
>
> - `application/json`
> - `application/javascript`
> - `text/javascript`
> - `text/css`
> - `image/svg+xml`
>
> In LiteSpeed this is typically configured under **Tuning → Enable Compression
> = Yes** and the **Compressible Types** list (server or vhost level), and/or via
> the LiteSpeed Cache settings. I don’t have access to that level of
> configuration, so I’d appreciate your help enabling it.
>
> To confirm afterward, a request to a `.js` or `.json` file on my site should
> return a `content-encoding: br` (or `gzip`) header.
>
> Thank you!

---

## How to verify it worked (after the host responds)

Open the site in Chrome, then in **DevTools → Console** run:

```js
const r = await fetch('/main.js'.replace('main.js', document.querySelector('script[src*="main-"]').src.split('/').pop()), {cache:'reload'});
console.log('content-encoding:', r.headers.get('content-encoding'));
```

A result of `br` or `gzip` means compression is on. You can also check the
**Network** tab: the “Size” column should show a transferred size much smaller
than the “Content” (decoded) size.

Once compression is enabled, **no code changes are needed** — the app already
requests the plain `.json` and your JS/CSS, so they’ll all start arriving
compressed automatically.
