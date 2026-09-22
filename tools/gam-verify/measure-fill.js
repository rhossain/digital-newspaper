#!/usr/bin/env node
/**
 * Fill measurement — how often GAM actually returns a creative, per slot.
 *
 *   node tools/gam-verify/measure-fill.js --spend-impressions [opens]
 *
 * ⚠ THIS SPENDS REAL IMPRESSIONS on the publisher's GAM network. Unlike
 * `run.js`, it does **not** answer `/gampad/ads` locally: every request reaches
 * Google and is billed and reported like any reader's. The `--spend-impressions`
 * flag is mandatory so it can never be run by reflex or by CI.
 *
 * This is a measurement, not a case, and it deliberately lives outside `CASES`.
 * Fill is not deterministic and is not something this codebase controls, so no
 * pass/fail verdict could be honest — see the README. What it produces is the
 * one number code cannot: for each slot, how many of its ad requests came back
 * with a creative, and at what size.
 *
 * Why it exists: §8.1–§8.4 changed what happens around an empty response
 * (collapse, retry) and what the modal slots are eligible for (sizes, and no
 * longer two `Post_Top` divs in one SRA call). Whether any of that moved fill is
 * a question only live traffic answers.
 *
 * Reads content from the production backend and serves the local `dist/`, same
 * as `run.js` — so build first. `/ads/config` still comes from the fixture, so
 * admin state cannot skew a measurement, and any non-GET to it is still aborted.
 */
const { launch, boot, SNAP, enable, Inconclusive } = require('./harness');

const SUBJECTS = [
  'desktop_post_top_image',
  'desktop_post_middle',
  'desktop_post_preview_top',
  'desktop_post_preview_middle',
  'desktop_page_right',
];

const line = s => console.log(`   ${s}`);

/**
 * Sizes `TDSEV3_Desktop_Post_Top-01` carried before §8.4 widened it.
 *
 * `--legacy-top-sizes` puts them back for one run, which is the only clean test
 * of whether that widening helped or hurt: §8.4 made the two `Post_Top` slots'
 * size list **identical** to `desktop_post_middle`'s, and if shared line items
 * carry a roadblock or a one-creative-per-request constraint, that is exactly
 * the shape §1.7 blames for `preview_top` never filling. Post_Middle's own sizes
 * were never touched, so a difference between the two runs can only come from
 * contention with Post_Top.
 */
const LEGACY_TOP_SIZES = [[320, 100], [300, 100], [728, 90], [468, 60]];

/**
 * Opens article `i` (wrapping), waits for the render to settle, closes it.
 *
 * Rotates through sections rather than reopening one, because a reader moving
 * between articles is what the modal slots actually see — and hammering a single
 * article exaggerates the frequency capping that §1.7 measured degrading fill
 * within a driven session.
 */
async function openAndClose(page, i) {
  const sections = page.locator('.clickable-section');
  const n = await sections.count();
  if (!n) return false;
  const sec = sections.nth(i % n);
  await sec.click({ force: true, timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3500);

  if (!(await page.locator('.modal-image-scroll-body').count())) {
    const w = page.locator('.section-image-wrapper').first();
    if (await w.count()) {
      await w.click({ force: true, timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3500);
    }
  }
  const opened = (await page.locator('.modal-image-scroll-body').count()) > 0;
  await page.locator('.modal-close-button').first()
    .click({ force: true, timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);
  return opened;
}

(async () => {
  if (!process.argv.includes('--spend-impressions')) {
    console.error(
      'Refusing to run: this measurement bills real impressions to the GAM network.\n' +
      'Re-run with --spend-impressions if that is what you intend.'
    );
    process.exit(2);
  }
  const opens = Number(process.argv.find(a => /^\d+$/.test(a))) || 16;
  const legacyTop = process.argv.includes('--legacy-top-sizes');
  // `--no-preview` takes the right panel's two slots out of the picture, to test
  // whether they are starving the modal slots of the rectangle demand both want.
  const noPreview = process.argv.includes('--no-preview');

  const browser = await launch();
  try {
   try {
    // noBill:false is the whole point — real requests, real responses.
    // Retries stay at the production default so what is measured is the
    // behaviour readers actually get, retries included.
    const { ctx, page, state } = await boot(browser, {
      noBill: false,
      mutateConfig: c => {
        enable(c, SUBJECTS);
        if (noPreview) {
          enable(c, ['desktop_post_preview_top', 'desktop_post_preview_middle'], false);
        }
        if (legacyTop) {
          c.slots.forEach(sl => {
            if (sl.unit.endsWith('Desktop_Post_Top-01')) sl.sizes = LEGACY_TOP_SIZES;
          });
        }
      },
    });

    console.log(`\n══════ fill over ${opens} article-modal open/close cycles` +
      `${legacyTop ? ' — Post_Top on PRE-§8.4 sizes' : ''}` +
      `${noPreview ? ' — preview slots OFF' : ''} ══════`);
    let opened = 0;
    for (let i = 1; i <= opens; i++) {
      if (await openAndClose(page, i - 1)) opened++;
      if (i % 4 === 0) line(`… ${i}/${opens} cycles (${opened} opened), ad requests so far=${state.adReqs}`);
    }

    if (!opened) {
      // No modal ever opened, so the modal slots never mounted and nothing about
      // them was measured. Reporting 0% here would be a lie about fill.
      throw new Inconclusive(`modal never opened in ${opens} attempts — nothing measured`);
    }

    // Let the last render and any in-flight no-fill retry land before reading.
    await page.waitForTimeout(12000);
    const s = await page.evaluate(SNAP);

    const byDiv = new Map(s.hosts.map(h => [h.div, h.slot]));
    const rows = new Map();
    for (const r of s.renders) {
      const slot = byDiv.get(r.div) || r.unit.split('/').pop();
      const row = rows.get(slot) || { renders: 0, filled: 0, sizes: new Map() };
      row.renders++;
      if (!r.empty) {
        row.filled++;
        const key = Array.isArray(r.size) ? r.size.join('x') : '?';
        row.sizes.set(key, (row.sizes.get(key) || 0) + 1);
      }
      rows.set(slot, row);
    }

    console.log('');
    line(`modal opens that succeeded=${opened}/${opens}   total ad requests=${state.adReqs}`);
    line('');
    line('slot                          renders  filled  fill%   creative sizes');
    for (const slot of [...rows.keys()].sort()) {
      const r = rows.get(slot);
      const pct = r.renders ? Math.round((r.filled / r.renders) * 100) : 0;
      const sizes = [...r.sizes.entries()].map(([k, n]) => `${k}×${n}`).join(' ') || '—';
      line(`${slot.padEnd(30)}${String(r.renders).padStart(6)}${String(r.filled).padStart(8)}${String(pct + '%').padStart(7)}   ${sizes}`);
    }
    if (!rows.size) line('(no renders recorded — gpt.js blocked, or no slot ever mounted)');
    line('');
    line(`console errors: ${[...new Set(state.errs)].join(' ; ') || '(none)'}`);
    line('Fill varies with demand, frequency capping and time of day — read a run as');
    line('one sample, and compare slots within a run rather than across runs.');

    await ctx.close();
   } catch (e) {
    // A backend outage is not a measurement of anything. Say so and exit
    // non-zero rather than leaving a stack trace that reads like a code fault.
    if (!(e instanceof Inconclusive)) throw e;
    console.log(`   ==> INCONCLUSIVE: ${e.message} — nothing was measured, re-run`);
    process.exitCode = 3;
   }
  } finally {
    await browser.close();
  }
})();
