'use strict';

// The track pack on the server: load it from MAP_DATA_DIR/track/, keep it fresh from the GitHub Release,
// never lose the last good one.
//
//   * A pack is `track-pack-<yyyymmdd>.bin` with `track-pack-<yyyymmdd>.manifest.json` beside it. The manifest's SHA-256
//     and byte count are verified before the pack is trusted, on every start and after every download.
//   * Start-up loads the newest pack on disk that verifies and loads (format 2 loads in milliseconds: the spatial
//     index is stored in the pack, nothing is computed). A pack that is corrupt, truncated, of an unknown format or
//     far too small is skipped, with a log line, and the next-newest is tried.
//   * Refresh: once a day, ask the GitHub releases API (public, no login, never sent one) for the newest release
//     tagged `track-pack-<date>`; if it is newer than what is loaded, download the manifest and the .bin
//     (atomic temp-then-rename, bounded), verify, LOAD it, and only then swap it in and emit 'loaded'. Any failure
//     is one log line and a backoff; what is loaded keeps serving.
//   * `fixedFile` (the --track-pack option, for development): load exactly that file, never download.
//   * Writes only under <dataDir>/track/. Keeps the newest `keepPacks` files.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const dl = require('./download');
const log = require('./log');

const NAME = /^track-pack-(\d{8})\.bin$/;

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

class TrackManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.config        config.track
   * @param {string} o.dataDir
   * @param {string} [o.fixedFile]   development: load this file and never download
   * @param {boolean} [o.download]   false in fake mode (no network)
   * @param {object} [o.urls]        {releases} test seam
   * @param {object} [o.downloadOpts]
   * @param {function} [o.now]
   * @param {function} [o.load]      (file) => pack; default src/track loadPack
   */
  constructor({ config, dataDir, fixedFile = null, download = true, urls = {}, downloadOpts = {}, now = Date.now, load = null }) {
    super();
    this.cfg = config; this.now = now;
    this.dir = path.join(dataDir, 'track');
    this.fixedFile = fixedFile; this.download = download && !fixedFile;
    this.releasesUrl = urls.releases || `https://api.github.com/repos/${config.repo}/releases?per_page=30`;
    this.downloadOpts = downloadOpts;
    this.loadPack = load || (f => require('./track').loadPack(f));
    this.pack = null;
    this.info = null;                  // {file, packDate, sha256, bytes, loadedAt, loadMs}
    this.lastCheckAt = null; this.lastError = null; this.failures = 0; this.nextRetryAt = 0;
    this.busy = false; this._timer = null; this.stopped = false;
    this.minEdges = config.minEdges || 200;
  }

  // ---- loading ---------------------------------------------------------------------------------------------------

  /** Verify a pack against its manifest and load it. Throws a sentence on any problem. */
  async _verifyAndLoad(file, { requireManifest = true } = {}) {
    const st = fs.statSync(file);
    if (st.size > (this.cfg.maxPackBytes || 120000000)) throw new Error(`${path.basename(file)} is ${st.size} bytes, more than the ${this.cfg.maxPackBytes} allowed`);
    let sha = null;
    const mfile = file.replace(/\.bin$/, '.manifest.json');
    if (fs.existsSync(mfile)) {
      let mf;
      try { mf = JSON.parse(fs.readFileSync(mfile, 'utf8')); } catch (_) { throw new Error(`${path.basename(mfile)} is not valid JSON`); }
      sha = await sha256File(file);
      if (mf.bytes !== undefined && mf.bytes !== st.size) throw new Error(`${path.basename(file)} is ${st.size} bytes, its manifest says ${mf.bytes}`);
      if (!mf.sha256 || String(mf.sha256).toLowerCase() !== sha) throw new Error(`${path.basename(file)} does not match the SHA-256 in its manifest`);
    } else if (requireManifest) {
      throw new Error(`${path.basename(file)} has no manifest to verify it against`);
    }
    const t0 = Date.now();
    const pack = this.loadPack(file);                      // throws on a wrong magic, an unknown format or a truncated file
    const ms = Date.now() - t0;
    if (pack.nEdges < this.minEdges) throw new Error(`${path.basename(file)} has only ${pack.nEdges} edges (expected at least ${this.minEdges})`);
    const m = NAME.exec(path.basename(file));
    return { pack, info: { file, packDate: m ? m[1] : (pack.meta && pack.meta.packDate) || null, sha256: sha, bytes: st.size, loadedAt: this.now(), loadMs: ms } };
  }

  _install({ pack, info }) {
    this.pack = pack; this.info = info;
    this.emit('loaded', pack, info);
  }

  /** Load the newest usable pack on disk. Resolves true when one is loaded. Never throws. */
  async loadFromDisk() {
    if (this.fixedFile) {
      try { this._install(await this._verifyAndLoad(this.fixedFile, { requireManifest: false })); log.info(`track: loaded ${this.fixedFile} (${this.info.loadMs} ms)`); return true; }
      catch (e) { this.lastError = log.errText(e); log.error(`track: cannot load ${this.fixedFile} (${this.lastError}); the map will have no spans`); return false; }
    }
    let names = [];
    try { names = fs.readdirSync(this.dir).filter(n => NAME.test(n)).sort().reverse(); } catch (_) { return false; }
    for (const n of names) {
      try {
        this._install(await this._verifyAndLoad(path.join(this.dir, n)));
        log.info(`track: loaded ${n} (${this.info.loadMs} ms, ${this.pack.nEdges} edges)`);
        return true;
      } catch (e) { this.lastError = log.errText(e); log.warn(`track: ${n} is unusable (${this.lastError}); trying an older one`); }
    }
    return false;
  }

  // ---- refreshing ---------------------------------------------------------------------------------------------------

  async _getJson(url) {
    const o = { serverName: 'GitHub', what: 'release list', idleTimeoutMs: 30000, totalTimeoutMs: 60000, maxRedirects: 3, headers: { Accept: 'application/vnd.github+json' }, ...this.downloadOpts };
    return dl.fetchResponse(url, o, async res => {
      if (res.statusCode !== 200) { res.resume(); throw new Error(`GitHub answered HTTP ${res.statusCode} for the release list`); }
      const chunks = []; let n = 0;
      for await (const c of res) { n += c.length; if (n > 2 * 1024 * 1024) throw new Error('the release list is too large'); chunks.push(c); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    });
  }

  /** The newest release tagged track-pack-<date> with a .bin and a manifest asset: {date, bin, manifest} or null. */
  _pick(releases) {
    if (!Array.isArray(releases)) return null;
    const prefix = this.cfg.tagPrefix || 'track-pack-';
    let best = null;
    for (const r of releases) {
      if (!r || r.draft || typeof r.tag_name !== 'string' || !r.tag_name.startsWith(prefix)) continue;
      const date = r.tag_name.slice(prefix.length);
      if (!/^\d{8}$/.test(date) || !Array.isArray(r.assets)) continue;
      const bin = r.assets.find(a => a && a.name === `track-pack-${date}.bin`), manifest = r.assets.find(a => a && a.name === `track-pack-${date}.manifest.json`);
      if (!bin || !manifest || !bin.browser_download_url || !manifest.browser_download_url) continue;
      if (!best || date > best.date) best = { date, bin, manifest };
    }
    return best;
  }

  /** One refresh attempt. Resolves true when a newer pack was installed. Never throws. */
  async check() {
    if (!this.download || this.stopped || this.busy) return false;
    this.busy = true; this.lastCheckAt = this.now();
    try {
      const pick = this._pick(await this._getJson(this.releasesUrl));
      if (!pick) { log.warn('track: no track-pack release with a pack and a manifest was found'); this.failures = 0; return false; }
      if (this.info && this.info.packDate && pick.date <= this.info.packDate) { this.failures = 0; return false; }
      fs.mkdirSync(this.dir, { recursive: true });
      const target = path.join(this.dir, `track-pack-${pick.date}.bin`), mtarget = target.replace(/\.bin$/, '.manifest.json');
      const opts = { serverName: 'GitHub', idleTimeoutMs: 120000, totalTimeoutMs: 15 * 60000, ...this.downloadOpts };
      await dl.downloadFile({ url: pick.manifest.browser_download_url, dest: mtarget + '.new', what: 'track pack manifest', ...opts });
      await dl.downloadFile({ url: pick.bin.browser_download_url, dest: target + '.new', what: 'track pack', ...opts });
      // Verify against the manifest BEFORE either name is taken: rename the pair into place only if it checks out and loads.
      fs.renameSync(mtarget + '.new', mtarget + '.check');
      fs.renameSync(target + '.new', target + '.check');
      let loaded;
      try {
        // _verifyAndLoad wants the final names (it finds the manifest beside the .bin): stage them, undo on failure.
        fs.renameSync(mtarget + '.check', mtarget); fs.renameSync(target + '.check', target);
        loaded = await this._verifyAndLoad(target);
      } catch (e) {
        for (const f of [target, mtarget, target + '.check', mtarget + '.check', target + '.new', mtarget + '.new']) { try { fs.unlinkSync(f); } catch (_) { /* not there */ } }
        throw e;
      }
      this._install(loaded);
      this.failures = 0; this.lastError = null;
      log.info(`track: installed ${path.basename(target)} (${loaded.info.bytes} bytes, ${loaded.info.loadMs} ms to load)`);
      this._prune();
      return true;
    } catch (e) {
      this.failures++; this.lastError = log.errText(e);
      const wait = Math.min(this.cfg.retryMaxSecs || 21600, (this.cfg.retryMinSecs || 900) * 2 ** Math.min(this.failures - 1, 5));
      this.nextRetryAt = this.now() + wait * 1000;
      log.warn(`track: refresh failed (${this.lastError}); ${this.pack ? 'keeping the pack in use' : 'no pack loaded'}; retry in ${Math.round(wait / 60)} min`);
      return false;
    } finally { this.busy = false; }
  }

  _prune() {
    let names;
    try { names = fs.readdirSync(this.dir).filter(n => NAME.test(n)).sort(); } catch (_) { return; }
    const keep = this.cfg.keepPacks || 2;
    for (const n of names.slice(0, Math.max(0, names.length - keep))) {
      if (this.info && path.basename(this.info.file) === n) continue;
      for (const f of [n, n.replace(/\.bin$/, '.manifest.json')]) { try { fs.unlinkSync(path.join(this.dir, f)); } catch (_) { /* gone */ } }
    }
  }

  /** Load from disk, then start the daily check (first one soon if nothing is loaded). */
  async start() {
    await this.loadFromDisk();
    if (!this.download) return;
    const tick = () => { if (this.now() >= this.nextRetryAt && (!this.lastCheckAt || this.now() - this.lastCheckAt >= (this.cfg.checkIntervalSecs || 86400) * 1000 || (!this.pack && this.failures === 0))) this.check().catch(() => {}); };
    this._timer = setInterval(tick, 60000);
    if (this._timer.unref) this._timer.unref();
    setImmediate(tick);
  }

  stop() { this.stopped = true; clearInterval(this._timer); this._timer = null; }

  status() {
    const i = this.info;
    return { loaded: !!this.pack, file: i ? path.basename(i.file) : null, packDate: i ? i.packDate : null, sha256: i ? i.sha256 : null, bytes: i ? i.bytes : null, loadedAt: i ? i.loadedAt : null, loadMs: i ? i.loadMs : null,
      bytesHeld: this.pack && this.pack.bytesHeld ? this.pack.bytesHeld() : null, lastCheckAt: this.lastCheckAt, lastError: this.lastError };
  }
}

module.exports = { TrackManager, sha256File };
