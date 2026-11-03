'use strict';

// The reference-data manager: SMART, CORPUS, NaPTAN, CIF. Each has its own refresh slot (London
// time), and every refresh follows the same rules:
//
//   * the download goes to <file>.new (download.js writes <file>.new.tmp and renames only when
//     complete and the right size), and credentials go on the FIRST hop only, to NROD hosts only;
//   * the new file is LOADED before it replaces anything: a file that downloads fine but does not
//     parse, or parses to far too few rows, is discarded and the last good file keeps serving;
//   * a failure is one log line, then a retry with backoff (15 min .. 1 h); it never throws out of
//     here, and never unloads what is already in memory;
//   * only after a successful load is <file>.new renamed onto <file> (the last-good copy on disk, which
//     is what a restart loads), and the in-memory structure swapped in.
//
// A restart loads the files already on disk first, so the service is useful at once, and only
// downloads what is missing or whose refresh slot has passed since the file was written.
//
// FAKE mode (`refDir` set): files are read from that folder, read-only; nothing is downloaded or
// written, and no credentials are ever read.
//
// Writes only under <dataDir>/ref/.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const dl = require('./download');
const { loadEnvFile, feedCredentials, secretsFor } = require('./env');
const log = require('./log');
const R = require('./reference');
const { buildCifIndex, targetDays } = require('./cif-index');
const { london } = require('./time');
const mem = require('./mem');

const NAPTAN_URL = 'https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv&atcoAreaCodes=910';

function definitions() {
  return {
    smart: { file: 'smart-latest.json.gz', url: dl.nrodUrl('SMART'), auth: true, server: 'Network Rail', load: f => R.loadSmart(f), rows: d => d.rows, slotKey: 'smart' },
    corpus: { file: 'corpus-latest.json.gz', url: dl.nrodUrl('CORPUS'), auth: true, server: 'Network Rail', load: f => R.loadCorpus(f), rows: d => d.rows, slotKey: 'corpus' },
    naptan: { file: 'naptan-rail.csv', url: NAPTAN_URL, auth: false, server: 'NaPTAN', load: f => R.loadNaptan(f), rows: d => d.byTiploc.size, slotKey: 'naptan' },
    cif: { file: 'cif-latest.json.gz', url: dl.NROD_CIF, auth: true, server: 'Network Rail', load: null, rows: d => d.schedules, slotKey: 'cif', big: true }
  };
}

class RefData extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.config          the whole config
   * @param {string} o.dataDir         MAP_DATA_DIR
   * @param {string} [o.refDir]        fake mode: read reference files from here, no downloads
   * @param {string} [o.envFile]       MAP_ENV_FILE (credentials, read-only, literal)
   * @param {function} [o.now]
   * @param {object} [o.urls]          override {smart, corpus, naptan, cif} (tests point these at a local server)
   * @param {string[]} [o.authHosts]
   */
  constructor({ config, dataDir, refDir = null, envFile = null, now = Date.now, urls = {}, authHosts = null, downloadOpts = {} }) {
    super();
    this.config = config;
    this.rc = config.reference;
    this.dir = refDir || path.join(dataDir, 'ref');
    this.fake = !!refDir;
    this.envFile = envFile;
    this.now = now;
    this.authHosts = authHosts;
    this.downloadOpts = downloadOpts;
    this.defs = definitions();
    this.data = {};
    this.state = {};
    for (const [name, d] of Object.entries(this.defs)) {
      if (urls[name]) d.url = urls[name];
      this.state[name] = { loadedAt: null, rows: 0, lastError: null, lastAttempt: null, doneSlot: -Infinity, nextRetryAt: 0, busy: false, failures: 0, fileMtime: null };
    }
    this.stationsFile = path.resolve(__dirname, '..', 'data', 'stations.json');
    this.stations = null;
    this._timer = null;
    this._chain = Promise.resolve();
    this.stopped = false;
  }

  fileFor(name) { return path.join(this.dir, this.defs[name].file); }

  // ---- slots ----------------------------------------------------------------------------------------

  /** The key of the most recent refresh slot at or before `ms` (a day number, or for weekly the day of the slot). */
  slotKeyAt(name, ms) {
    const s = this.rc[this.defs[name].slotKey];
    const l = london(ms);
    let day = l.dayNum;
    if (l.hour * 60 + l.minute < s.hour * 60 + s.minute) day -= 1;
    if (s.weekday !== undefined && s.weekday !== null) {
      // The latest day <= `day` whose weekday matches.
      const dow = ((day % 7) + 7 + 3) % 7;     // day 0 (1970-01-01) was a Thursday -> Mon=0
      day -= ((dow - s.weekday) + 7) % 7;
    }
    return day;
  }

  // ---- loading ----------------------------------------------------------------------------------------

  _cifLoader() { return f => buildCifIndex(f, { dayNums: targetDays(this.now(), this.config.service.yesterdayUntilHour), collect: mem.collect }); }

  async _loadFile(name, file) {
    const d = this.defs[name];
    const data = await (name === 'cif' ? this._cifLoader()(file) : d.load(file));
    const rows = d.rows(data);
    const min = this.rc.minRows[name] || 1;
    if (rows < min) throw new Error(`the ${name} file has only ${rows} usable rows (expected at least ${min})`);
    return { data, rows };
  }

  _install(name, data, rows) {
    const st = this.state[name];
    this.data[name] = data;
    st.loadedAt = this.now(); st.rows = rows; st.lastError = null; st.failures = 0;
    this.emit('loaded', name, data);
    mem.collect();                       // a whole file's worth of parse garbage has just been made
  }

  _credentials() {
    if (!this.envFile) throw new Error('no credentials file configured (MAP_ENV_FILE)');
    const env = loadEnvFile(this.envFile);
    const creds = feedCredentials(env, this.envFile);
    log.addSecrets(secretsFor(creds));
    return creds;
  }

  /** Load what is on disk. Resolves once every dataset has been tried; never throws. */
  async loadFromDisk() {
    try { this.stations = R.loadStationsFile(this.stationsFile); } catch (e) { this.stations = null; log.warn(`ref: station table unusable (${log.errText(e)}); NaPTAN only`); }
    // The CIF first: its parse is the biggest transient, so it runs while the heap is emptiest.
    for (const name of ['cif', 'corpus', 'naptan', 'smart']) {
      const file = this.fileFor(name), st = this.state[name];
      let stat;
      try { stat = fs.statSync(file); } catch (_) { continue; }
      st.fileMtime = stat.mtimeMs;
      st.doneSlot = this.slotKeyAt(name, stat.mtimeMs);
      try {
        const t0 = Date.now();
        const { data, rows } = await this._loadFile(name, file);
        this._install(name, data, rows);
        log.info(`ref: ${name} loaded from disk (${rows} rows, ${Date.now() - t0} ms)`);
      } catch (e) {
        st.lastError = log.errText(e); st.doneSlot = -Infinity;
        log.warn(`ref: ${name} on disk is unusable (${st.lastError}); will download`);
      }
    }
  }

  // ---- refresh ----------------------------------------------------------------------------------------

  /** Download, validate by loading, then swap. Resolves true on success. Never throws. */
  refresh(name) {
    const run = () => this._refresh(name);
    this._chain = this._chain.then(run, run);          // one heavy operation at a time
    return this._chain;
  }

  async _refresh(name) {
    const st = this.state[name], d = this.defs[name];
    if (this.fake || this.stopped || st.busy) return false;
    st.busy = true; st.lastAttempt = this.now();
    const target = this.fileFor(name), fresh = target + '.new';
    try {
      let auth = null;
      if (d.auth) auth = this._credentials();
      fs.mkdirSync(this.dir, { recursive: true });
      await dl.downloadFile({
        url: d.url, dest: fresh, auth, authHosts: this.authHosts || undefined,
        serverName: d.server, what: `${name} file`,
        authHint: `check NR_FEED_USER and NR_FEED_PASS in ${this.envFile}`,
        idleTimeoutMs: 120000, totalTimeoutMs: d.big ? 45 * 60000 : 15 * 60000, ...this.downloadOpts
      });
      if (d.big) mem.collect();            // start the CIF parse from the smallest heap we can
      const { data, rows } = await this._loadFile(name, fresh);
      fs.renameSync(fresh, target);                    // the last-good copy on disk changes only now
      st.fileMtime = this.now(); st.doneSlot = this.slotKeyAt(name, this.now());
      this._install(name, data, rows);
      log.info(`ref: ${name} refreshed (${rows} rows)`);
      return true;
    } catch (e) {
      try { fs.unlinkSync(fresh); } catch (_) { /* not there */ }
      try { fs.unlinkSync(fresh + '.tmp'); } catch (_) { /* not there */ }
      st.failures++;
      st.lastError = log.errText(e);
      const wait = Math.min(this.rc.retryMaxSecs, this.rc.retryMinSecs * 2 ** Math.min(st.failures - 1, 4));
      st.nextRetryAt = this.now() + wait * 1000;
      const keeping = this.data[name] ? `keeping the last good copy (loaded ${new Date(st.loadedAt).toISOString().slice(0, 16)}Z)` : 'nothing loaded yet';
      log.warn(`ref: ${name} refresh failed (${st.lastError}); ${keeping}; retry in ${Math.round(wait / 60)} min`);
      return false;
    } finally {
      st.busy = false;
    }
  }

  // ---- the scheduler ----------------------------------------------------------------------------------------

  start() {
    if (this._timer || this.fake) return;
    const tick = () => { this.checkDue().catch(() => {}); };
    this._timer = setInterval(tick, (this.rc.checkIntervalSecs || 30) * 1000);
    if (this._timer.unref) this._timer.unref();
    setImmediate(tick);
  }

  stop() { this.stopped = true; clearInterval(this._timer); this._timer = null; }

  /** One scheduler pass: refresh whatever is due; keep the CIF day sets current. */
  async checkDue() {
    const now = this.now();
    if (this.data.cif) this.data.cif.prune(now, this.config.service.yesterdayUntilHour);
    if (this.fake) return;
    for (const name of ['corpus', 'naptan', 'smart', 'cif']) {
      const st = this.state[name];
      if (st.busy || now < st.nextRetryAt) continue;
      const missing = !this.data[name];
      const due = this.slotKeyAt(name, now) > st.doneSlot;
      if (missing || due) await this.refresh(name);
    }
    await this._reindexCifIfDayMoved();
  }

  // The index holds today and tomorrow as they were at build time. If refreshes keep failing, the day
  // eventually moves on: rebuild from the file we already have rather than serve no timetable at all.
  async _reindexCifIfDayMoved() {
    const idx = this.data.cif, st = this.state.cif;
    if (!idx || st.busy) return;
    const l = london(this.now());
    if (idx.days.some(d => d.dayNum === l.dayNum)) return;
    if (this.now() - (st.reindexAt || 0) < 30 * 60000) return;
    st.reindexAt = this.now();
    const run = async () => {
      try {
        const { data, rows } = await this._loadFile('cif', this.fileFor('cif'));
        this._install('cif', data, rows);
        log.info(`ref: cif re-indexed from the file on disk for the new day (${rows} schedules)`);
      } catch (e) { log.warn(`ref: cif re-index failed (${log.errText(e)})`); }
    };
    this._chain = this._chain.then(run, run);
    await this._chain;
  }

  status() {
    const s = (name, key = 'rows') => ({ [key]: this.state[name].rows, loadedAt: this.state[name].loadedAt, ...(this.state[name].lastError ? { lastError: this.state[name].lastError } : {}) });
    return { smart: s('smart'), corpus: s('corpus'), naptan: s('naptan'), cif: s('cif', 'schedules') };
  }

  /** Are the three things placement needs loaded? */
  get placementReady() { return !!(this.data.smart && this.data.corpus); }
}

module.exports = { RefData, NAPTAN_URL };
