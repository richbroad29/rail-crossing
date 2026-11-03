'use strict';
// Close-zoom probes: one stopped train with a known heading, shot at zoom 14, 16 and 18 (2x pixel
// ratio, light and dark), plus a train that is moving between stations and one selected (the highlight
// follows the silhouette). Look for: ONE elongated body with a cab nose, pointing the way it faces;
// no overlaid shapes; the station name and the train code not on top of one another.
const L = require('./lib.js');

module.exports = async function probes(browser) {
  let failed = 0;
  for (const scheme of ['light', 'dark']) {
    const { page, ctx, errors } = await L.open(browser, { viewport: { width: 900, height: 640 }, deviceScaleFactor: 2, colorScheme: scheme });
    await page.evaluate(() => RM.debug.map.jumpTo({ center: [-0.35, 50.92], zoom: 9 }));
    await page.waitForTimeout(2000);
    await L.setMock('freeze=1');             // stop the simulation clock: a standing train stays standing
    await page.waitForTimeout(2500);
    // A stopped train at a station with a heading, and a moving one.
    const picks = await page.evaluate(() => {
      let stopped = null, moving = null;
      RM.debug.store.forEach((r) => {
        if (!stopped && r.pl === 's' && r.hdg != null && r.svc && r.lat > 50.8 && r.lat < 51.1 && r.lon > -0.6 && r.lon < 0.2) stopped = { id: r.id, lon: r.cx, lat: r.cy, hdg: r.hdg, hc: r.hc };
        if (!moving && r.pl === 'i' && r.hdg != null && r.svc && r.lat > 50.8 && r.lat < 51.1 && r.lon > -0.6 && r.lon < 0.2) moving = { id: r.id, lon: r.cx, lat: r.cy, hdg: r.hdg, hc: r.hc };
      });
      return { stopped, moving };
    });
    for (const z of [14, 16, 18]) {
      const p = picks.stopped;
      await page.evaluate(([p, z]) => RM.debug.map.jumpTo({ center: [p.lon, p.lat], zoom: z }), [p, z]);
      await page.waitForTimeout(2500);
      // the train may have moved a little: re-centre on it before shooting
      await page.evaluate(([id, z]) => { const r = RM.debug.store.get(id); if (r) RM.debug.map.jumpTo({ center: [r.cx, r.cy], zoom: z }); }, [p.id, z]);
      await page.waitForTimeout(1200);
      const f = await L.shot(page, `probe-z${z}-${scheme}`);
      console.log('ok   ' + f.split('/').pop() + '  (stopped ' + p.hc + ', heading ' + p.hdg + ')');
    }
    if (picks.moving) {
      const p = picks.moving;
      await page.evaluate(([id]) => RM.debug.select(id, { fly: false }), [p.id]);
      await page.evaluate(([p]) => RM.debug.map.easeTo({ center: [p.lon, p.lat], zoom: 15.5, offset: [-190, 0], duration: 0 }), [p]);
      await page.waitForTimeout(3000);
      await page.evaluate(([id]) => { const r = RM.debug.store.get(id); if (r) RM.debug.map.easeTo({ center: [r.cx, r.cy], zoom: 15.5, offset: [-190, 0], duration: 0 }); }, [p.id]);
      await page.waitForTimeout(1200);
      const f = await L.shot(page, `probe-selected-moving-z15.5-${scheme}`);
      console.log('ok   ' + f.split('/').pop() + '  (selected, moving ' + p.hc + ', heading ' + p.hdg + ')');
    }
    if (errors.length) { failed++; console.log('FAIL console errors:\n   ' + errors.join('\n   ')); }
    await L.setMock('freeze=0');
    await ctx.close();
  }
  return failed;
};
