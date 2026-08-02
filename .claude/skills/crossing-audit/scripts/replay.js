// Replay recorded /crossing/:id payloads through the REAL shared/crossing.js so we
// read the exact strings the user saw. Stubs the DOM, fakes the clock per sample.
//   node replay.js <OUTDIR> [repo-root]
// Writes <OUTDIR>/replay.json and prints a per-sample timeline.
const fs = require('fs'), path = require('path');
const OUT = process.argv[2];
const REPO = process.argv[3] || path.resolve(__dirname, '../../../..');
if (!OUT) { console.error('usage: node replay.js <OUTDIR> [repo-root]'); process.exit(1); }

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
global.fetch = () => Promise.reject(new Error('no network in replay'));
global.setInterval = global.setTimeout = () => 0;
global.clearInterval = global.clearTimeout = () => {};

// predict.js first — it defines the PREDICT global that crossing.js is a presentation
// layer over. Concatenated rather than required so the harness keeps exercising the exact
// bytes the browser loads.
// closure-card.js too: renderClosures() delegates the card markup to it (it is shared with
// the observer so the two apps cannot render one closure differently), so without it the
// harness throws on the first sample instead of replaying.
const core = fs.readFileSync(path.join(REPO, 'shared/predict.js'), 'utf8')
  + ';\n' + fs.readFileSync(path.join(REPO, 'shared/closure-card.js'), 'utf8');
const src = core + ';\n' + fs.readFileSync(path.join(REPO, 'shared/crossing.js'), 'utf8');
const app = new Function(src + `;return {buildClosuresFromVps, updateStatus, parseVpsResponse,
  setCFG:c=>{CFG=c}, setPeriods:p=>{closurePeriods=p}, setTrains:t=>{trains=t}};`)();
app.setCFG(JSON.parse(fs.readFileSync(path.join(REPO, 'shared/crossings.json'), 'utf8')).portslade);

const RealDate = Date;
const setNow = ms => { global.Date = class extends RealDate {
  constructor(...a) { a.length ? super(...a) : super(ms); }
  static now() { return ms; } }; };

const out = [];
for (const line of fs.readFileSync(path.join(OUT, 'main.jsonl'), 'utf8').trim().split('\n')) {
  let rec; try { rec = JSON.parse(line); } catch { continue; }
  if (!rec.main || !rec.main.upcomingClosures) continue;
  const ms = rec.t * 1000;
  setNow(ms);
  const periods = app.buildClosuresFromVps(rec.main.upcomingClosures);
  app.setPeriods(periods);
  app.setTrains(app.parseVpsResponse(rec.main));
  app.updateStatus();
  global.Date = RealDate;
  const card = (String(els.closureList?.innerHTML || '')
    .match(/<div class="closure-card[\s\S]*?(?=<div class="closure-card|$)/) || [''])[0]
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const c0 = rec.main.upcomingClosures[0];
  out.push({
    t: rec.t,
    time: new RealDate(ms).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour12: false }),
    backendState: rec.main.state,
    uiTitle: els.statusTitle.textContent, uiMsg: els.statusMsg.textContent,
    nextClose: els.nextCloseCountdown.textContent, nextOpen: els.nextOpenCountdown.textContent,
    downFor: els.closureLength.textContent, downForRange: els.closureLengthSub.textContent,
    card1: card.slice(0, 200),
    currentClosureNull: rec.main.currentClosure === null,
    firstStart: c0 && c0.start, firstPredStart: c0 && c0.predictedStart, firstEnd: c0 && c0.end,
  });
}
fs.writeFileSync(path.join(OUT, 'replay.json'), JSON.stringify(out, null, 1));
console.log('samples:', out.length);
let prev = null;
for (const r of out) {
  const key = [r.backendState, r.uiTitle, r.downFor, r.firstStart, r.firstEnd].join('|');
  if (key !== prev) console.log([r.time, String(r.backendState).padEnd(12),
    r.uiTitle.padEnd(15), 'close:' + r.nextClose.padEnd(8), 'open:' + r.nextOpen.padEnd(8),
    'downFor:' + r.downFor.padEnd(9), '| ' + r.card1.slice(0, 90)].join(' '));
  prev = key;
}
