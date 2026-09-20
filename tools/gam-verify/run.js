#!/usr/bin/env node
/**
 * GAM ad-slot behaviour suite.
 *
 *   node tools/gam-verify/run.js              # every case
 *   node tools/gam-verify/run.js poll mobile  # only cases whose name contains these
 *
 * Requires a current build: npm run build.
 *
 * Reads live content from the production WordPress backend (there is no reachable
 * staging — §6.13), but serves the local dist/ and answers every ad request
 * locally, so a run costs no live impressions.
 */
const { launch, boot, makeContext, enable, DIV, SNAP, Inconclusive } = require('./harness');

const results = {};
const MIN_REFRESH_GAP = 5200; // GamService enforces a 5s floor per slot.

const line = s => console.log(`   ${s}`);
const report = (name, pass, extra = {}) => {
  results[name] = { pass, ...extra };
  line(`==> ${pass ? 'PASS' : 'REVIEW'}`);
};
const errLine = st => line(`errors: ${[...new Set(st.errs)].join(' ; ') || '(none)'}`);

/** Clicks pagination button `n` (1-based) and waits for the render to settle. */
async function paginate(page, n) {
  const btn = page.locator('.pagination-page-btn').nth(n - 1);
  await btn.click({ force: true, timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

async function openArticleModal(page) {
  const sec = page.locator('.clickable-section').first();
  if (await sec.count()) {
    await sec.click({ force: true, timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3500);
  }
  if (!(await page.locator('.modal-image-scroll-body').count())) {
    const w = page.locator('.section-image-wrapper').first();
    if (await w.count()) {
      await w.click({ force: true, timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3500);
    }
  }
  return (await page.locator('.modal-image-scroll-body').count()) > 0;
}

// ── cases ────────────────────────────────────────────────────────────────────

/** Ads off in admin must behave exactly like a build with no ad code at all. */
async function adsOff(browser) {
  const { ctx, page, state } = await boot(browser, { mutateConfig: c => { c.enabled = false; } });
  const s = await page.evaluate(SNAP);
  line(`gpt.js loaded=${s.gptLoaded} (expect false)  defined=${s.defined.length}  display()=${s.displays.length}  hosts=${s.hosts.length}`);
  line(`ad requests=${state.adReqs} (expect 0)   layout: thumbs=${s.thumbs} sections=${s.sections} pag=${s.pagBtns}`);
  errLine(state);
  const pass = !s.gptLoaded && s.defined.length === 0 && s.displays.length === 0 &&
    s.hosts.length === 0 && state.adReqs === 0 && s.thumbs > 0 && s.pagBtns > 0 &&
    s.scrollW <= s.clientW && state.errs.length === 0;
  report('ads-off', pass, { adReqs: state.adReqs, errs: state.errs });
  await ctx.close();
}

/** Scenario 1: each page change refreshes the persistent right-rail slot, once. */
async function paginationRefresh(browser) {
  const { ctx, page, state } = await boot(browser);
  const counts = [];
  for (const n of [2, 3, 4]) {
    await page.waitForTimeout(MIN_REFRESH_GAP);
    await paginate(page, n);
    const s = await page.evaluate(SNAP);
    counts.push({ n, refreshes: s.refreshes.length, adReqs: state.adReqs, last: s.refreshes.at(-1) });
    line(`page ${n}: refreshCalls=${s.refreshes.length} adReqs=${state.adReqs} batch=${JSON.stringify(s.refreshes.at(-1) ?? [])}`);
  }
  const rightIncluded = counts.every(c => (c.last || []).includes(DIV.desktop_page_right));
  const oneEach = counts.every((c, i) => c.refreshes === i + 1);
  line(`one refresh per navigation=${oneEach}   right-rail slot in every batch=${rightIncluded}`);
  errLine(state);
  report('pagination', oneEach && rightIncluded && state.errs.length === 0, { counts, errs: state.errs });
  await ctx.close();
}

/** A burst of clicks must coalesce into at most one refresh. */
async function paginationBurst(browser) {
  const { ctx, page, state } = await boot(browser);
  await page.waitForTimeout(MIN_REFRESH_GAP);
  for (const n of [2, 3, 4, 5, 6, 7]) {
    await page.locator('.pagination-page-btn').nth(n - 1).click({ force: true, timeout: 8000 }).catch(() => {});
  }
  await page.waitForTimeout(4000);
  const s = await page.evaluate(SNAP);
  line(`refresh calls for the whole burst=${s.refreshes.length} (expect <=1)   adReqs=${state.adReqs}`);
  errLine(state);
  report('burst', s.refreshes.length <= 1 && state.errs.length === 0, { refreshes: s.refreshes.length });
  await ctx.close();
}

/** Guardrail 3: a backgrounded tab must not refresh. */
async function hiddenTab(browser) {
  const { ctx, page, state } = await boot(browser, { hidden: true });
  await page.waitForTimeout(MIN_REFRESH_GAP);
  for (const n of [2, 3, 4]) await paginate(page, n);
  const s = await page.evaluate(SNAP);
  line(`document.hidden forced   refreshCalls=${s.refreshes.length} (expect 0)   display() still ran=${s.displays.length}`);
  errLine(state);
  report('hidden-tab', s.refreshes.length === 0 && state.errs.length === 0, { refreshes: s.refreshes.length });
  await ctx.close();
}

/**
 * The unverified commit (§6.13): the 5-minute version poll reaches the same
 * render path a click does, and must not refresh ads. Anti-vacuity — the poll
 * must actually have fired and reloaded, or the case cannot pass.
 */
async function pollGate(browser) {
  const { ctx, page, state } = await boot(browser, { bumpVersion: true });
  let versionHits = 0, reloadHits = 0;
  page.on('request', r => {
    const rest = new URL(r.url()).searchParams.get('rest_route') || '';
    if (rest.includes('data/version')) versionHits++;
    if (rest.includes('editions') || rest.includes('/data')) reloadHits++;
  });

  const before = await page.evaluate(SNAP);
  const adReqsBefore = state.adReqs;
  line(`before: refreshCalls=${before.refreshes.length} adReqs=${adReqsBefore}`);

  // The poll interval is 300s and the first emission is at 300s, not t=0.
  line('waiting out the 5-minute version poll…');
  await page.waitForTimeout(310000);

  const after = await page.evaluate(SNAP);
  line(`version endpoint hits=${versionHits}  content reload hits=${reloadHits}`);
  line(`after:  refreshCalls=${after.refreshes.length} adReqs=${state.adReqs}`);
  const pollFired = versionHits > 0, reloaded = reloadHits > 0;
  const noRefresh = after.refreshes.length === before.refreshes.length;
  line(`poll ran=${pollFired}  content reloaded=${reloaded}  ad refresh fired=${!noRefresh} (expect false)`);
  errLine(state);
  report('poll-gate', pollFired && reloaded && noRefresh && state.errs.length === 0,
    { versionHits, reloadHits, before: before.refreshes.length, after: after.refreshes.length });
  await ctx.close();
}

/** Mobile: the two mobile slots are the only visible ones, and appear once each. */
async function mobilePlacement(browser) {
  // needSections is left at its default. This case asserts `opened`, and the only
  // route into the modal is clicking a section — so with needSections:false a boot
  // that loaded no content scored REVIEW instead of retrying, turning a backend
  // hiccup into a failure verdict. Observed exactly that: `sections=0`,
  // `modal opened=false`, every mobile assertion reported 0/2.
  const { ctx, page, state } = await boot(browser, {
    viewport: { width: 390, height: 844 },
    mutateConfig: c => enable(c, ['mobile_post_top', 'mobile_post_middle']),
  });
  const opened = await openArticleModal(page);
  await page.waitForTimeout(4000);
  const s = await page.evaluate(SNAP);
  s.hosts.forEach(h => line(`   ${h.slot} div=${h.div} hidden=${h.hidden} h=${h.h}`));

  const mob = s.hosts.filter(h => (h.slot || '').startsWith('mobile_'));
  const deskShown = s.hosts.filter(h => (h.slot || '').startsWith('desktop_') && !h.hidden).map(h => h.slot);
  const counts = s.hosts.reduce((a, h) => (h.div && (a[h.div] = (a[h.div] || 0) + 1), a), {});
  const dupes = Object.entries(counts).filter(([, n]) => n > 1).map(([d]) => d);
  const defined = ['mobile_post_top', 'mobile_post_middle'].filter(id => s.defined.includes(DIV[id]));

  line(`modal opened=${opened}   mobile hosts=${mob.length}/2 visible=${mob.filter(h => !h.hidden).length}/2 GPT-defined=${defined.length}/2`);
  line(`desktop hosts visible on mobile=${JSON.stringify(deskShown)} (expect [])   duplicate divs=${JSON.stringify(dupes)} (expect [])`);
  errLine(state);
  report('mobile-placement',
    opened && mob.length === 2 && mob.every(h => !h.hidden) && defined.length === 2 &&
    deskShown.length === 0 && dupes.length === 0 && state.errs.length === 0,
    { mob, deskShown, dupes });
  await ctx.close();
}

/** Guard 3 (RC-8): a hidden slot must never be refreshed. */
async function mobileNoRefresh(browser) {
  const { ctx, page, state } = await boot(browser, {
    viewport: { width: 390, height: 844 }, needSections: false,
  });
  await page.waitForTimeout(MIN_REFRESH_GAP);
  for (const n of [2, 3]) await paginate(page, n);
  const s = await page.evaluate(SNAP);
  const hiddenDivs = s.hosts.filter(h => h.hidden).map(h => h.div);
  const refreshed = s.refreshes.flat();
  const bad = refreshed.filter(d => hiddenDivs.includes(d));
  line(`hidden hosts=${hiddenDivs.length}  refreshCalls=${s.refreshes.length}  refreshed divs=${JSON.stringify([...new Set(refreshed)])}`);
  line(`hidden slots that got refreshed=${JSON.stringify(bad)} (expect [])`);
  errLine(state);
  report('mobile-no-refresh', bad.length === 0 && state.errs.length === 0, { bad });
  await ctx.close();
}

/**
 * §5.3: a slot the viewport cannot show must not be defined or fetched at all.
 * Before the fix this recorded 6 desktop slots defined while display:none.
 */
async function noHiddenDefine(browser) {
  const { ctx, page, state } = await boot(browser, {
    viewport: { width: 390, height: 844 }, needSections: false,
    mutateConfig: c => enable(c, ['mobile_post_top', 'mobile_post_middle']),
  });
  await openArticleModal(page);
  await page.waitForTimeout(4000);
  const s = await page.evaluate(SNAP);
  const desktopDivs = Object.entries(DIV).filter(([id]) => id.startsWith('desktop_')).map(([, d]) => d);
  const definedDesktop = s.defined.filter(d => desktopDivs.includes(d));
  // The wrong-viewport <app-ad-slot> host elements stay in the DOM — they are in
  // the template unconditionally. What must not exist is the container div, since
  // that is what gets handed to GPT.
  const hiddenWithContainer = s.hosts.filter(h => h.hidden && h.div !== null).map(h => h.slot);
  const hiddenReservingSpace = s.hosts.filter(h => h.hidden && h.h > 0).map(h => h.slot);

  line(`slots defined on a 390px viewport=${JSON.stringify(s.defined)}`);
  line(`desktop slots defined=${JSON.stringify(definedDesktop)} (expect [])   ad requests=${state.adReqs}`);
  line(`hidden hosts still holding a GPT container=${JSON.stringify(hiddenWithContainer)} (expect [])`);
  line(`hidden hosts reserving height=${JSON.stringify(hiddenReservingSpace)} (expect [])`);
  errLine(state);
  report('no-hidden-define',
    definedDesktop.length === 0 && hiddenWithContainer.length === 0 &&
    hiddenReservingSpace.length === 0 && state.errs.length === 0,
    { definedDesktop, hiddenWithContainer, adReqs: state.adReqs });
  await ctx.close();
}

/**
 * A navigation that lands inside the 5 s floor must still reach the slot.
 *
 * Before deferral every blocked refresh was discarded outright, so a reader
 * clicking faster than once per five seconds kept the creative the slot was born
 * with and nothing re-fired it. Measured on that code: one refresh for the two
 * clicks below. The second click must now produce its own refresh, delayed to the
 * earliest moment the floor allows rather than thrown away.
 */
async function deferredRefresh(browser) {
  const { ctx, page, state } = await boot(browser);
  await page.waitForTimeout(MIN_REFRESH_GAP);

  await paginate(page, 2);                       // eligible: refreshes at once
  const afterFirst = await page.evaluate(SNAP);

  // Sampled tight, because the point is to catch the refresh mid-hold. paginate()
  // waits 3 s after its click, which is longer than the ~2 s left on the floor at
  // this moment, so reading the snapshot through it would show the deferred
  // refresh already fired and prove nothing about whether it was held.
  await page.locator('.pagination-page-btn').nth(2).click({ force: true, timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const beforeWait = await page.evaluate(SNAP);

  await page.waitForTimeout(MIN_REFRESH_GAP);    // let the deferral come due
  const afterWait = await page.evaluate(SNAP);

  const first = afterFirst.refreshes.length;
  const held = beforeWait.refreshes.length;
  const final = afterWait.refreshes.length;
  line(`refreshCalls: after click 1=${first}  right after click 2=${held}  once the floor expired=${final}`);
  line(`second click was held, not dropped=${held === first && final === first + 1} (expect true)`);
  line(`last batch=${JSON.stringify(afterWait.refreshes.at(-1) ?? [])}`);
  errLine(state);
  report('deferred-refresh',
    first === 1 && held === 1 && final === 2 &&
    (afterWait.refreshes.at(-1) || []).includes(DIV.desktop_page_right) &&
    state.errs.length === 0,
    { first, held, final });
  await ctx.close();
}

/**
 * The mobile image/text toggle is a content swap that mounts nothing, so only a
 * refresh can turn its ad over. `mobile_post_top` sits outside the image panel
 * and stays visible across the toggle; `mobile_post_middle` is inside it and is
 * hidden in text view, so guard 3 must leave that one alone.
 */
async function mobileToggle(browser) {
  // needSections is left at its default: this case has to click a section to
  // reach the modal, so a boot with no content is worth retrying rather than
  // carrying into a verdict.
  const { ctx, page, state } = await boot(browser, {
    viewport: { width: 390, height: 844 },
    mutateConfig: c => enable(c, ['mobile_post_top', 'mobile_post_middle']),
  });
  if (!(await openArticleModal(page))) throw new Inconclusive('article modal did not open');

  const tabs = page.locator('.mobile-modal-tab');
  if ((await tabs.count()) < 2) throw new Inconclusive('no image/text toggle — this article has no text body');

  await page.waitForTimeout(MIN_REFRESH_GAP);    // clear the slots' mount stamp
  const before = await page.evaluate(SNAP);
  await tabs.nth(1).click({ force: true, timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const after = await page.evaluate(SNAP);

  const batch = after.refreshes.at(-1) || [];
  const fired = after.refreshes.length === before.refreshes.length + 1;
  const topRefreshed = batch.includes(DIV.mobile_post_top);
  const middleLeftAlone = !batch.includes(DIV.mobile_post_middle);
  line(`refreshCalls before=${before.refreshes.length} after=${after.refreshes.length} (expect +1)`);
  line(`batch=${JSON.stringify(batch)}`);
  line(`mobile_post_top refreshed=${topRefreshed}   mobile_post_middle (now hidden) left alone=${middleLeftAlone}`);
  errLine(state);
  report('mobile-toggle', fired && topRefreshed && middleLeftAlone && state.errs.length === 0,
    { batch, before: before.refreshes.length, after: after.refreshes.length });
  await ctx.close();
}

/**
 * RC-3, the reported symptom: open an article from the right panel, close it,
 * open another. The modal's ads filled the first time and were blank every time
 * after, for the rest of the session.
 *
 * The cause was GPT's one-`display()`-per-slot-per-pageview rule. The old code
 * defined every slot once up front and injected a `display()` per container, so a
 * remounted container issued a second `display()` that GPT silently ignored —
 * measured on the live site as `display()` firing on each reopen while the ad
 * request count stayed frozen.
 *
 * Asserts the pairing directly: every open defines and displays, every close
 * destroys, and every open costs a real ad request. Fill is deliberately not
 * asserted — see §1.7 and the note in the README.
 */
async function modalReopen(browser) {
  const { ctx, page, state } = await boot(browser);
  const modalDivs = [DIV.desktop_post_top_image, DIV.desktop_post_middle];
  // `defined` and `displays` are flat lists of div ids; `destroys` is one entry
  // per destroySlots() call, each an array.
  const inModal = flat => flat.filter(d => modalDivs.includes(d)).length;

  const opens = [];
  for (let i = 1; i <= 3; i++) {
    const reqsBefore = state.adReqs;
    if (!(await openArticleModal(page))) throw new Inconclusive(`article modal did not open on attempt ${i}`);
    await page.waitForTimeout(2500);
    const s = await page.evaluate(SNAP);
    opens.push({
      i,
      defines: inModal(s.defined),
      displays: inModal(s.displays),
      destroys: inModal(s.destroys.flat()),
      newAdReqs: state.adReqs - reqsBefore,
    });
    await page.locator('.modal-close-button').first().click({ force: true, timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }

  const final = await page.evaluate(SNAP);
  const totalDefines = inModal(final.defined);
  const totalDisplays = inModal(final.displays);
  const totalDestroys = inModal(final.destroys.flat());

  opens.forEach(o => line(`open ${o.i}: cumulative defineSlot=${o.defines} display()=${o.displays} destroySlots=${o.destroys}  new ad requests this open=${o.newAdReqs}`));
  line(`totals across 3 open/close cycles — defineSlot=${totalDefines} display()=${totalDisplays} destroySlots=${totalDestroys} (expect 6/6/6)`);

  // The defect's signature: display() climbs while ad requests stay flat.
  const everyOpenFetched = opens.every(o => o.newAdReqs > 0);
  line(`every open issued at least one new ad request=${everyOpenFetched} (expect true — this is what RC-3 broke)`);
  errLine(state);
  report('modal-reopen',
    totalDefines === 6 && totalDisplays === 6 && totalDestroys === 6 &&
    everyOpenFetched && state.errs.length === 0,
    { opens, totalDefines, totalDisplays, totalDestroys });
  await ctx.close();
}

const CASES = [
  ['ads-off', adsOff],
  ['pagination', paginationRefresh],
  ['burst', paginationBurst],
  ['hidden-tab', hiddenTab],
  ['mobile-placement', mobilePlacement],
  ['mobile-no-refresh', mobileNoRefresh],
  ['no-hidden-define', noHiddenDefine],
  ['deferred-refresh', deferredRefresh],
  ['mobile-toggle', mobileToggle],
  ['modal-reopen', modalReopen],
  ['poll-gate', pollGate], // slowest: waits out the real 5-minute poll
];

(async () => {
  const filters = process.argv.slice(2);
  const picked = filters.length
    ? CASES.filter(([n]) => filters.some(f => n.includes(f)))
    : CASES;
  if (!picked.length) {
    console.error(`No case matches ${filters.join(', ')}. Available: ${CASES.map(([n]) => n).join(', ')}`);
    process.exit(1);
  }

  const browser = await launch();
  try {
    for (const [name, fn] of picked) {
      console.log(`\n══════ ${name} ══════`);
      try {
        await fn(browser);
      } catch (e) {
        if (e instanceof Inconclusive) {
          console.log(`   ==> INCONCLUSIVE: ${e.message} — verdict is inconclusive, not a failure`);
          results[name] = { pass: null, inconclusive: e.message };
        } else {
          console.log(`   ==> ERROR: ${e.message}`);
          results[name] = { pass: false, error: e.message };
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n════════ SUMMARY ════════');
  for (const [k, v] of Object.entries(results)) {
    console.log(`${k}: ${v.pass === null ? 'INCONCLUSIVE (environment)' : v.pass ? 'PASS' : 'REVIEW'}`);
  }
  const failed = Object.values(results).some(v => v.pass === false);
  process.exit(failed ? 1 : 0);
})();
