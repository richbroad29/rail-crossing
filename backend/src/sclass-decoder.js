'use strict';

// S-Class barrier-state decoder.
//
// The Network Rail TD feed carries S-Class (signalling-state) messages as a
// per-describer bitmap. We maintain that bitmap from:
//   - SF (signalling update): one byte at one address — a live state change;
//   - SG / SH (signalling refresh): a run of bytes from a starting address,
//     resent periodically (and after a request). SH marks the end of a refresh
//     cycle; for bitmap purposes SG and SH are handled identically.
// Addresses and data are hex. A function is addressed by byte:bit with bit 0 =
// LSB, so bit 7 = 0x80. Config (config/sclass.json) maps describer->byte:bit->
// crossing; nothing about specific crossings is hard-coded here.
//
// For each watched crossing we track the raised / lowered / failed bits and emit
// a phase event on every transition:
//   lowered 0->1 -> CLOSED      (barriers fully down)        kind=CLOSE
//   raised  1->0 -> LOWER_START (barriers begin to lower)    kind=null
//   lowered 1->0 -> RAISE_START (barriers begin to rise)     kind=null
//   raised  0->1 -> OPEN        (barriers fully up)          kind=OPEN
//   failed  0->1 -> FAILED  ;  failed 1->0 -> FAIL_CLEAR
// CLOSE/OPEN are the canonical dataset events; LOWER_START/RAISE_START give the
// lowering/raising phase durations (the FOI-withheld strike-in timing) for free.
//
// Cold start: the first time an address is observed we record its value but emit
// NO transition events (the prior state is unknown), so a refresh at startup
// cannot fabricate a spurious CLOSE/OPEN. Transitions first seen on a refresh
// (SG/SH) rather than an SF are flagged recovered=true: the net change is real
// but the exact instant may be the refresh time, not the true transition time
// (e.g. an SF was missed during a reconnect gap).
//
// Pure and synchronous — all I/O (logging, emitting) lives in the caller. The
// server-receive timestamp is passed in (ts), keeping this unit-testable.

// Transition table: bit name + direction -> { phase, kind }. kind is the
// canonical dataset label (CLOSE/OPEN); null phases are intermediate markers.
const TRANSITIONS = {
  'lowered:0->1': { phase: 'CLOSED', kind: 'CLOSE' },
  'lowered:1->0': { phase: 'RAISE_START', kind: null },
  'raised:1->0': { phase: 'LOWER_START', kind: null },
  'raised:0->1': { phase: 'OPEN', kind: 'OPEN' },
  'failed:0->1': { phase: 'FAILED', kind: null },
  'failed:1->0': { phase: 'FAIL_CLEAR', kind: null },
};

function hexByte(v) {
  return v.toString(16).toUpperCase().padStart(2, '0');
}

// Parse a hex data string into an array of byte values. Returns null on a
// malformed (non-hex or odd-length) string so the caller can skip it.
function parseDataBytes(dataHex) {
  if (typeof dataHex !== 'string') return null;
  const s = dataHex.trim();
  if (s.length === 0 || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

class SClassDecoder {
  // areasConfig: the `areas` object from config/sclass.json.
  constructor(areasConfig) {
    this.areas = {};
    const cfg = (areasConfig && areasConfig.areas) || areasConfig || {};
    for (const [area, aCfg] of Object.entries(cfg)) {
      // byteWatch: address(int) -> [ { crossingId, name, type, bitName, bit } ]
      const byteWatch = {};
      // crossings: crossingId -> { name, type, bits: { raised:{addr,bit}, ... } }
      const crossings = {};
      for (const [cid, cCfg] of Object.entries(aCfg.crossings || {})) {
        const bits = {};
        for (const [bitName, def] of Object.entries(cCfg.bits || {})) {
          const addr = parseInt(def.byte, 16);
          const bit = Number(def.bit);
          if (!Number.isInteger(addr) || !Number.isInteger(bit) || bit < 0 || bit > 7) {
            throw new Error(`sclass config: bad bit ${area}/${cid}/${bitName} (byte=${def.byte}, bit=${def.bit})`);
          }
          bits[bitName] = { addr, bit };
          (byteWatch[addr] = byteWatch[addr] || []).push({ crossingId: cid, name: cCfg.name || cid, type: cCfg.type || null, bitName, bit });
        }
        crossings[cid] = { name: cCfg.name || cid, type: cCfg.type || null, bits };
      }
      this.areas[area] = {
        name: aCfg.name || area,
        logRaw: aCfg.logRaw || 'all',
        state: new Map(),  // address(int) -> byte value(int)
        seen: new Set(),   // addresses observed at least once (cold-start guard)
        byteWatch,
        crossings,
      };
    }
  }

  // Is this area decoded at all? (used by the listener to bound area capture)
  hasArea(area) { return Object.prototype.hasOwnProperty.call(this.areas, area); }

  // Should the raw message be logged for this area? 'all' logs everything;
  // 'watched' logs only messages whose byte run touches a watched address.
  shouldLogRaw(area, startAddr, nBytes) {
    const a = this.areas[area];
    if (!a) return false;
    if (a.logRaw === 'all') return true;
    for (let i = 0; i < nBytes; i++) {
      if (a.byteWatch[startAddr + i]) return true;
    }
    return false;
  }

  // Apply one S-Class message. msgType is 'SF' | 'SG' | 'SH'. Returns an array of
  // barrier phase events (possibly empty). meta = { ts, feedTime } attached to
  // every emitted event; ts is the authoritative server-receive time.
  apply(area, msgType, addrHex, dataHex, meta) {
    const a = this.areas[area];
    if (!a) return [];
    const startAddr = parseInt(addrHex, 16);
    if (!Number.isInteger(startAddr)) return [];
    const bytes = parseDataBytes(dataHex);
    if (!bytes) return [];

    const recovered = msgType !== 'SF';
    const events = [];
    for (let i = 0; i < bytes.length; i++) {
      const addr = startAddr + i;
      const newVal = bytes[i];
      const watchers = a.byteWatch[addr];
      const hadPrev = a.seen.has(addr);
      const oldVal = a.state.get(addr);

      // Always record the new state.
      a.state.set(addr, newVal);
      a.seen.add(addr);

      // No transitions to emit on the first-ever observation, or if unwatched,
      // or if the byte value did not change.
      if (!watchers || !hadPrev || oldVal === newVal) continue;

      // Group this byte's watchers by crossing so each event carries the full
      // raised/lowered/failed state of that crossing after the change.
      const byCrossing = {};
      for (const w of watchers) (byCrossing[w.crossingId] = byCrossing[w.crossingId] || []).push(w);

      for (const [cid, ws] of Object.entries(byCrossing)) {
        const cross = a.crossings[cid];
        // Collect this crossing's bit transitions from the byte change.
        const changed = [];
        for (const w of ws) {
          const mask = 1 << w.bit;
          const oldBit = (oldVal & mask) ? 1 : 0;
          const newBit = (newVal & mask) ? 1 : 0;
          if (oldBit === newBit) continue;
          const t = TRANSITIONS[`${w.bitName}:${oldBit}->${newBit}`];
          if (!t) continue;
          changed.push({ w, oldBit, newBit, t });
        }
        // When several bits flip in one update (e.g. a refresh-recovered net
        // change), report clearing transitions (1->0, the START of a movement)
        // before setting transitions (0->1, the COMPLETE), so LOWER_START
        // precedes CLOSED and RAISE_START precedes OPEN whichever bits moved.
        changed.sort((x, y) => x.newBit - y.newBit);
        for (const c of changed) {
          events.push({
            ts: meta && meta.ts,
            feedTime: (meta && meta.feedTime) || null,
            area,
            crossing: cid,
            name: cross.name,
            type: cross.type,
            phase: c.t.phase,
            kind: c.t.kind,
            bit: c.w.bitName,
            transition: `${c.oldBit}->${c.newBit}`,
            byte: hexByte(addr),
            byteValue: hexByte(newVal),
            prevByteValue: hexByte(oldVal),
            raised: this._bitState(a, cross, 'raised', addr, newVal),
            lowered: this._bitState(a, cross, 'lowered', addr, newVal),
            failed: this._bitState(a, cross, 'failed', addr, newVal),
            msgType,
            recovered,
          });
        }
      }
    }
    return events;
  }

  // Current boolean state of a named bit for a crossing. If the bit's byte is the
  // one just updated, use the supplied freshVal; otherwise read this area's
  // stored state (handles crossings whose bits span more than one byte).
  _bitState(a, cross, bitName, updatedAddr, freshVal) {
    const def = cross.bits[bitName];
    if (!def) return null;
    const val = def.addr === updatedAddr ? freshVal : (a.state.has(def.addr) ? a.state.get(def.addr) : null);
    if (val == null) return null;
    return (val & (1 << def.bit)) ? true : false;
  }

  // Snapshot of a crossing's current bit state — for diagnostics/tests.
  snapshot(area, crossingId) {
    const a = this.areas[area];
    if (!a) return null;
    const c = a.crossings[crossingId];
    if (!c) return null;
    const out = {};
    for (const [bitName, def] of Object.entries(c.bits)) {
      out[bitName] = a.state.has(def.addr) ? Boolean(a.state.get(def.addr) & (1 << def.bit)) : null;
    }
    return out;
  }
}

module.exports = { SClassDecoder, parseDataBytes, hexByte };
