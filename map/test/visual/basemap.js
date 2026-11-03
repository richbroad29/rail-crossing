'use strict';
// Base-map comparison: the same Sussex views on the two candidate light bases (positron, liberty) and
// the dark base, all with the style.js flattening applied. Writes basemap-<base>-z9|z12.png.
// Run:  node map/test/visual/run.js basemap
const L = require('./lib.js');

module.exports = async function basemap(browser) {
  let failed = 0;
  const cases = [['positron', 'light'], ['liberty', 'light'], ['dark', 'dark']];
  for (const [base, scheme] of cases) {
    const { page, ctx, errors } = await L.open(browser, { viewport: { width: 1440, height: 900 }, colorScheme: scheme }, '', base === 'liberty' ? '&light=liberty' : '');
    for (const z of [9, 12]) {
      await page.evaluate((z) => RM.debug.map.jumpTo({ center: z === 9 ? [-0.35, 50.92] : [-0.2, 50.835], zoom: z }), z);
      await page.waitForTimeout(4000);
      const f = await L.shot(page, `basemap-${base}-z${z}`);
      console.log('ok   ' + f.split('/').pop());
    }
    if (errors.length) { failed++; console.log('FAIL console errors:\n   ' + errors.join('\n   ')); }
    await ctx.close();
  }
  return failed;
};
