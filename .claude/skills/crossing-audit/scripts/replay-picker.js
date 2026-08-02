// Replay a recorded /crossing/:id/live payload through the REAL feedback picker in
// shared/crossing.js, so we can read the exact card text the user would tap on — the
// main replay.js harness only covers the status card and closure list.
//
//   node replay-picker.js <OUTDIR> [repo-root] [closing|opening] [sampleIndex] [tickSecs...]
//
// Prints the picker's rendered text at t+0 and after each requested tick, plus the
// feedback payload that would be POSTed. Tick output is what proves the position labels
// actually move over time (the bug fixed 2026-07-29): pass e.g. "0 10 20 30".
const fs = require('fs'), path = require('path');
const OUT = process.argv[2];
const REPO = process.argv[3] || path.resolve(__dirname, '../../../..');
const TYPE = process.argv[4] || 'closing';
const SAMPLE = process.argv[5] ? parseInt(process.argv[5], 10) : -1;
const TICKS = process.argv.slice(6).map(Number);
if (!OUT) { console.error('usage: node replay-picker.js <OUTDIR> [repo-root] [closing|opening] [sampleIndex] [tickSecs...]'); process.exit(1); }

const readJsonl = f => fs.readFileSync(path.join(OUT, f), 'utf8').trim().split('\n')
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const mains = readJsonl('main.jsonl'), lives = readJsonl('live.jsonl');

// Pick the sample: default = the one with the most trains on the Portslade chain, i.e.
// the most informative. An explicit index overrides.
const chainBerths = /^(0016|0014|0012|0010|0008|0006|0004|0002|T686|T684|T682|T677|0001|0003|0005|0007|0009|0011|0013|0015|0017)$/;
let pick = SAMPLE;
if (pick < 0) {
  let best = -1;
  lives.forEach((s, i) => {
    const n = (s.live.trains || []).filter(t => chainBerths.test(t.berth || '') && t.direction !== 'unknown').length;
    if (n > best) { best = n; pick = i; }
  });
}
const live = lives[pick];
const main = mains.reduce((acc, m) => (Math.abs(m.t - live.t) < Math.abs(acc.t - live.t) ? m : acc), mains[0]);

// ---- DOM / env stubs ----
const els = {};
const mkEl = id => ({
  id, textContent: '', innerHTML: '', disabled: false, className: '',
  style: new Proxy({}, { set: (o, k, v) => (o[k] = v, true), get: (o, k) => o[k] || '' }),
  classList: { _s: new Set(), add(...c) { c.forEach(x => this._s.add(x)); },
               remove(...c) { c.forEach(x => this._s.delete(x)); },
               contains(c) { return this._s.has(c); } },
  setAttribute() {}, getAttribute() { return ''; }, offsetWidth: 0, offsetHeight: 0,
});
global.document = {
  getElementById(id) { return els[id] || (els[id] = mkEl(id)); },
  querySelectorAll() { return { forEach() {} }; }, title: '',
};
global.navigator = { userAgent: 'node' };
global.window = { location: { search: '' } };
const posted = [];
global.fetch = (url, opts) => {
  if (String(url).endsWith('/live')) return Promise.resolve({ ok: true, json: () => Promise.resolve(live.live) });
  if (opts && opts.method === 'POST') { posted.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true }); }
  return Promise.reject(new Error('unexpected fetch: ' + url));
};
const timers = [];
global.setInterval = (fn) => (timers.push(fn), timers.length);
global.setTimeout = (fn) => 0;
global.clearInterval = global.clearTimeout = () => {};

const RealDate = Date;
let nowMs = live.t * 1000;
const setNow = ms => { nowMs = ms; global.Date = class extends RealDate {
  constructor(...a) { a.length ? super(...a) : super(ms); }
  static now() { return ms; } }; };
setNow(nowMs);

const core = fs.readFileSync(path.join(REPO, 'shared/predict.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'shared/crossing.js'), 'utf8');
const app = new Function(core + ';\n' + appSrc + `;return {
  openFeedbackPicker, renderFbPicker, buildClosuresFromVps, parseVpsResponse, updateStatus,
  fbBuildPayload, fbPollLive, tick: (typeof fbTickPositions === 'function') ? fbTickPositions : null,
  setCFG:c=>{CFG=c}, setId:i=>{crossingId=i}, setPeriods:p=>{closurePeriods=p},
  setTrains:t=>{trains=t; trainHistory=t}};`)();

app.setCFG(JSON.parse(fs.readFileSync(path.join(REPO, 'shared/crossings.json'), 'utf8')).portslade);
app.setId('portslade');
app.setPeriods(app.buildClosuresFromVps(main.main.upcomingClosures));
app.setTrains(app.parseVpsResponse(main.main));
app.updateStatus();

const strip = h => String(h).replace(/<button/g, '\n  <button').replace(/<[^>]+>/g, ' ')
  .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

(async () => {
  await app.openFeedbackPicker(TYPE);
  await new Promise(r => process.nextTick(r));
  const t0 = new RealDate(live.t * 1000).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour12: false });
  console.log('sample #%d  %s  event=%s  trains in feed=%d\n', pick, t0, TYPE, (live.live.trains || []).length);
  console.log(strip(els.fbPicker.innerHTML));
  // The tick rewrites each card's position line by id, so read those elements directly —
  // fbPicker.innerHTML is a string in this stub DOM and won't reflect a textContent write.
  const posIds = () => Object.keys(els).filter(k => k.indexOf('fbPos-') === 0);
  for (const secs of TICKS) {
    setNow(live.t * 1000 + secs * 1000);
    if (app.tick) app.tick(); else app.renderFbPicker();
    console.log('  t+' + String(secs + 's').padEnd(5) +
      posIds().map(id => id.replace('fbPos-', '') + ': ' + els[id].textContent).join('   |   '));
  }
  global.Date = RealDate;
  console.log('\nposted %d payload(s); first:', posted.length);
  if (posted[0]) console.log(JSON.stringify(posted[0], null, 1));
})();
