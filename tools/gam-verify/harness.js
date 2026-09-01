/**
 * Browser harness for the GAM ad-slot behaviour tests.
 *
 * Serves the local `dist/` build under the production origin so that same-origin
 * WordPress REST calls still resolve, while every ad-related request is under
 * our control. See GAM_AD_REFRESH_TODO.md §6.12/§6.13 for why it works this way.
 *
 * Billing: ad requests are answered locally by default. Pass `noBill: false` on
 * a case that genuinely needs a real creative — that spends live impressions on
 * the publisher's network.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ORIGIN = 'https://epaper.dailysangram.com';
const DIST = path.join(__dirname, '..', '..', 'dist', 'digital-newspaper', 'browser');
const CONFIG_FIXTURE = path.join(__dirname, 'fixtures', 'ads-config.json');

/** The SSR build emits index.csr.html for the client entry; a plain build emits index.html. */
function indexFile() {
  for (const name of ['index.csr.html', 'index.html']) {
    const p = path.join(DIST, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`No index html in ${DIST} — run: npm run build`);
}

/** Slot-id → GPT div suffix, from the fixture. */
const DIV = Object.fromEntries(
  JSON.parse(fs.readFileSync(CONFIG_FIXTURE, 'utf8')).slots
    .map(s => [s.id, s.div.replace('div-gpt-ad-', '')])
);

/**
 * Console noise from third parties and from the page's own CSP that says nothing
 * about the app. Anything not listed here counts as a real error and fails a case.
 */
const NOISE = [
  'frame-ancestors',
  'ERR_BLOCKED_BY_CLIENT',
  'ERR_ABORTED',
  'net::ERR_FAILED',
  'googlesyndication',
  'google-analytics',
  'googletagmanager',
  'doubleclick.net',
  'Failed to load resource',
  'preloaded using link preload',
];
const isNoise = m => NOISE.some(n => String(m).includes(n));

/** Matches only the real ad request, not every doubleclick asset. See §2.4 trap 2. */
const AD_REQ = /\/gampad\/(live\/)?ads?(\?|$)/;

/**
 * Wraps GPT before any page script runs. Registered as the first `cmd` entry, so
 * it is in place before AdService pushes its own callbacks.
 */
const INSTRUMENT = `
(() => {
  window.__gam = { define: [], display: [], refresh: [], gptLoaded: false };
  window.googletag = window.googletag || { cmd: [] };
  window.googletag.cmd.push(function () {
    const gt = window.googletag;
    window.__gam.gptLoaded = true;
    const strip = d => String(d).replace('div-gpt-ad-', '');
    const od = gt.defineSlot;
    gt.defineSlot = function (unit, sizes, div) {
      window.__gam.define.push(strip(div));
      return od.apply(this, arguments);
    };
    const odisp = gt.display;
    gt.display = function (d) {
      window.__gam.display.push(strip(d && d.getSlotElementId ? d.getSlotElementId() : d));
      return odisp.apply(this, arguments);
    };
    const pub = gt.pubads();
    const orf = pub.refresh;
    pub.refresh = function (slots) {
      window.__gam.refresh.push((slots || []).map(s => strip(s.getSlotElementId())));
      return orf.apply(this, arguments);
    };
  });
})();
`;

/** Reads live GPT + DOM state. Evaluated as a string so it needs no bundling. */
const SNAP = `(() => {
  const gt = window.googletag;
  const ready = !!(gt && gt.apiReady && gt.pubads);
  const slots = ready ? gt.pubads().getSlots().map(s => {
    const info = s.getResponseInformation && s.getResponseInformation();
    const keys = s.getTargetingKeys ? s.getTargetingKeys() : [];
    return {
      div: String(s.getSlotElementId()).replace('div-gpt-ad-', ''),
      unit: s.getAdUnitPath(),
      creative: info && info.creativeId ? String(info.creativeId) : null,
      targeting: Object.fromEntries(keys.map(k => [k, s.getTargeting(k)])),
    };
  }) : [];
  const hosts = Array.from(document.querySelectorAll('app-ad-slot')).map(h => {
    const inner = h.querySelector('div[id^="div-gpt-ad-"]');
    return {
      slot: h.getAttribute('slotid'),
      div: inner ? inner.id.replace('div-gpt-ad-', '') : null,
      hidden: h.offsetParent === null,
      h: Math.round(h.getBoundingClientRect().height),
      iframes: h.querySelectorAll('iframe').length,
    };
  });
  return {
    gptLoaded: window.__gam.gptLoaded,
    defined: window.__gam.define.slice(),
    displays: window.__gam.display.slice(),
    refreshes: window.__gam.refresh.slice(),
    slots, hosts,
    thumbs: document.querySelectorAll('.thumbnail-item').length,
    sections: document.querySelectorAll('.clickable-section').length,
    pagBtns: document.querySelectorAll('.pagination-page-btn').length,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  };
})()`;

async function launch() {
  return chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

/**
 * @param {object} o
 * @param {(cfg:object)=>void} [o.mutateConfig] edit the served /ads/config snapshot
 * @param {boolean} [o.noBill=true]     answer /gampad/ads locally (no live impressions)
 * @param {boolean} [o.bumpVersion]     force the version poll to see new content
 * @param {boolean} [o.hidden]          force document.hidden true
 */
async function makeContext(browser, o = {}) {
  const { viewport = { width: 1680, height: 1000 }, mutateConfig, noBill = true, bumpVersion = false, hidden = false } = o;
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
  const state = { adReqs: 0, errs: [], configPosts: 0 };

  await ctx.addInitScript(INSTRUMENT);
  if (hidden) {
    await ctx.addInitScript(`Object.defineProperty(document, 'hidden', { get: () => true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' });`);
  }

  const cfg = JSON.parse(fs.readFileSync(CONFIG_FIXTURE, 'utf8'));
  if (mutateConfig) mutateConfig(cfg);

  await ctx.route(`${ORIGIN}/**`, async route => {
    const req = route.request();
    const url = new URL(req.url());
    const rest = url.searchParams.get('rest_route') || '';

    if (rest.includes('ads/config')) {
      // Never write to the live backend, whatever the app or an admin screen does.
      if (req.method() !== 'GET') { state.configPosts++; return route.abort(); }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(cfg) });
    }
    if (bumpVersion && rest.includes('data/version')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ dataVersion: 9999999999 }) });
    }
    if (url.pathname.startsWith('/wp')) return route.continue();

    if (url.pathname !== '/') {
      const file = path.join(DIST, url.pathname.slice(1));
      if (file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return route.fulfill({ path: file });
      }
    }
    // `/` and deep links such as /2026-08-29/page-03/edition-01/ are client-side routes.
    if (!path.extname(url.pathname)) return route.fulfill({ path: indexFile() });
    return route.continue();
  });

  if (noBill) {
    await ctx.route(/\/gampad\//, route => route.fulfill({ status: 200, contentType: 'text/html', body: '' }));
  }

  ctx.on('request', r => { if (AD_REQ.test(r.url())) state.adReqs++; });
  ctx.on('page', p => {
    p.on('pageerror', e => { if (!isNoise(e.message)) state.errs.push(String(e.message).slice(0, 200)); });
    p.on('console', m => {
      if (m.type() !== 'error') return;
      if (!isNoise(m.text())) state.errs.push(m.text().slice(0, 200));
    });
  });

  return { ctx, state, cfg };
}

class Inconclusive extends Error {}

/**
 * Loads the app and waits for real content. A backend outage must report
 * INCONCLUSIVE rather than a failure — see §2.4 trap 1.
 */
async function boot(browser, o = {}) {
  const { needSections = true, attempts = 3 } = o;
  const { ctx, state, cfg } = await makeContext(browser, o);
  const page = await ctx.newPage();

  let snap = null;
  for (let i = 1; i <= attempts; i++) {
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(7000);
    snap = await page.evaluate(SNAP).catch(() => null);
    const ok = snap && snap.pagBtns > 0 && (!needSections || snap.sections > 0);
    if (ok) break;
    if (i < attempts) {
      console.log(`   [boot] attempt ${i} loaded no content (sections=${snap?.sections ?? '?'} pag=${snap?.pagBtns ?? '?'}) — retrying`);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }
  console.log(`   [boot] sections=${snap?.sections ?? '?'} paginationButtons=${snap?.pagBtns ?? '?'}`);
  if (!snap || snap.pagBtns === 0) {
    await ctx.close();
    throw new Inconclusive(`BOOT_FAILED (sections=${snap?.sections ?? '?'} pag=${snap?.pagBtns ?? '?'}) — backend unreachable`);
  }
  return { ctx, page, state, cfg, snap };
}

const enable = (cfg, ids, on = true) =>
  cfg.slots.forEach(s => { if (ids.includes(s.id)) s.enabled = on; });

module.exports = { ORIGIN, DIST, DIV, SNAP, AD_REQ, launch, makeContext, boot, enable, Inconclusive };
