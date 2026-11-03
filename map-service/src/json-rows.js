'use strict';

// Streams the flat row objects out of a (possibly gzipped) JSON document without ever holding the
// document in memory. Used for SMART and CORPUS, whose documented shape is
//   {"BERTHDATA":[{...},{...}]}   and   {"TIPLOCDATA":[{...},{...}]}
// but which this script has to treat as unverified.
//
// Why a scanner and not the earlier proof of concept's regex `{[^{}]*}`: a free-text field (SMART's
// COMMENT) can contain a brace, and the regex cannot tell a brace inside a string from structure. This
// scanner tracks string and escape state, so it is exact for any valid JSON, and it carries that state
// across chunk boundaries so a row split mid-key, mid-string or mid-escape is still found.
//
// What counts as a row: an object that contains no other object or array — a "leaf" object. In the
// documented shapes that is every array element. A wrapper object is not a leaf, so it is never
// emitted; a bare array of rows and one-row-per-line files work unchanged. Rows are handed to `onRow`
// as soon as they close.
//
// Memory is bounded: between rows nothing is kept; inside a row only that row's text is, and a row
// longer than `maxRowChars` is dropped (counted as bad) rather than accumulated.

const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { StringDecoder } = require('string_decoder');

const QUOTE = 34, BACKSLASH = 92, OPEN_BRACE = 123, CLOSE_BRACE = 125, OPEN_BRACKET = 91, CLOSE_BRACKET = 93;
const MAX_BAD_SAMPLES = 3;

class RowScanner {
  /**
   * @param {object} opts
   * @param {function(object):void} opts.onRow   called with each parsed row
   * @param {function(string,string):void} [opts.onBad] called with (reason, sample) for each bad row
   * @param {number} [opts.maxRowChars]  longest row accepted; longer ones are dropped and counted
   * @param {number} [opts.headChars]    how much of the start of the document to keep for diagnosis
   * @param {number} [opts.tailChars]    how much of the end
   */
  constructor({ onRow, onBad = () => {}, maxRowChars = 65536, headChars = 2000, tailChars = 160 } = {}) {
    if (typeof onRow !== 'function') throw new Error('RowScanner needs an onRow function');
    this.onRow = onRow;
    this.onBad = onBad;
    this.maxRowChars = maxRowChars;
    this.headChars = headChars;
    this.tailChars = tailChars;

    this.inString = false;
    this.escaped = false;
    this.kinds = [];       // one entry per open container: OPEN_BRACE or OPEN_BRACKET
    this.leaf = [];        // parallel: true while that container has had no nested container
    this.rowStart = -1;    // offset in the current text of an open leaf candidate's '{', else -1
    this.carry = '';       // that candidate's text so far, kept across a chunk boundary

    this.rows = 0;
    this.bad = 0;
    this.badSamples = [];
    this.chars = 0;
    this.head = '';
    this.tail = '';
  }

  _bad(reason, sample) {
    this.bad++;
    const s = String(sample).slice(0, 120);
    if (this.badSamples.length < MAX_BAD_SAMPLES) this.badSamples.push({ reason, sample: s });
    this.onBad(reason, s);
  }

  _emit(text) {
    // Enforced here as well as at chunk ends, so the limit means the same thing however the input
    // happens to be split.
    if (text.length > this.maxRowChars) {
      this._bad(`a row longer than ${this.maxRowChars} characters (dropped)`, text);
      return;
    }
    let row;
    try { row = JSON.parse(text); }
    catch (e) { this._bad(`unparseable row (${e.message})`, text); return; }
    this.rows++;
    this.onRow(row);
  }

  /** Feed the next piece of the document as a string. Pieces may split the document anywhere. */
  write(chunk) {
    if (!chunk) return;
    this.chars += chunk.length;
    if (this.head.length < this.headChars) this.head += chunk.slice(0, this.headChars - this.head.length);
    this.tail = chunk.length >= this.tailChars ? chunk.slice(-this.tailChars) : (this.tail + chunk).slice(-this.tailChars);

    // The carry is the open row's text from the previous chunk. It is prepended only so the row can be
    // sliced out whole; its characters were already scanned, so scanning resumes after it.
    const offset = this.carry.length;
    const text = offset ? this.carry + chunk : chunk;
    const n = text.length;
    for (let i = offset; i < n; i++) {
      const c = text.charCodeAt(i);
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === BACKSLASH) this.escaped = true;
        else if (c === QUOTE) this.inString = false;
        continue;
      }
      if (c === QUOTE) { this.inString = true; continue; }
      if (c === OPEN_BRACE || c === OPEN_BRACKET) {
        if (this.leaf.length) this.leaf[this.leaf.length - 1] = false;   // the parent now has a child
        this.kinds.push(c);
        this.leaf.push(c === OPEN_BRACE);
        this.rowStart = c === OPEN_BRACE ? i : -1;
      } else if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
        if (!this.kinds.length) continue;                                 // a closer with nothing open
        const opened = this.kinds.pop();
        const wasLeaf = this.leaf.pop();
        if (opened === OPEN_BRACE && c === CLOSE_BRACE) {
          if (wasLeaf && this.rowStart >= 0) this._emit(text.slice(this.rowStart, i + 1));
        } else if (wasLeaf) {
          this._bad('mismatched brackets', text.slice(Math.max(0, i - 40), i + 1));
        }
        this.rowStart = -1;
      }
    }

    if (this.rowStart >= 0) {
      if (n - this.rowStart > this.maxRowChars) {
        this._bad(`a row longer than ${this.maxRowChars} characters (dropped)`, text.slice(this.rowStart));
        this.rowStart = -1;
        this.carry = '';
      } else {
        this.carry = text.slice(this.rowStart);
        this.rowStart = 0;
      }
    } else {
      this.carry = '';
    }
  }

  /** Call once after the last piece. */
  finish() {
    const endedCleanly = this.kinds.length === 0 && !this.inString;
    if (this.carry) {
      this._bad('the document ended inside a row (truncated file?)', this.carry);
      this.carry = '';
    }
    return {
      rows: this.rows,
      bad: this.bad,
      badSamples: this.badSamples,
      chars: this.chars,
      endedCleanly,
      head: this.head,
      tail: this.tail,
      wrapper: describeWrapper(this.head)
    };
  }
}

const BOM = String.fromCharCode(0xfeff);

/**
 * What surrounds the rows, judged from the start of the document. If it opens with an object, that
 * object's keys are read in order, stepping over scalar and nested values, until one holds an array: that
 * is the wrapper key, and every key read on the way is reported (a version or date key ahead of the data
 * is not mistaken for "no wrapper").
 *
 *   object-with-array  {"KEY":[ ...  or  {"VERSION":"x","KEY":[ ...     key = KEY, keys = [VERSION, KEY]
 *   bare-array         [ ...
 *   bare-rows          {"FIELD":"value", ...}   an object with no array in it: a row, so no wrapper
 *   unknown            anything else, or the start of the file ended before the answer
 *
 * @returns {{ kind: string, key: string|null, keys: string[] }}
 */
function describeWrapper(head) {
  const t = String(head).startsWith(BOM) ? String(head).slice(1) : String(head);
  const n = t.length;
  const unknown = keys => ({ kind: 'unknown', key: null, keys });
  let i = 0;
  const skipSpace = () => { while (i < n && /\s/.test(t[i])) i++; };
  // A JSON string at t[i]; returns its decoded text and moves past it, or null if the head ends inside it.
  const readString = () => {
    const start = i++;
    while (i < n) {
      if (t[i] === '\\') i += 2;
      else if (t[i] === '"') { i++; try { return JSON.parse(t.slice(start, i)); } catch (_) { return t.slice(start + 1, i - 1); } }
      else i++;
    }
    return null;
  };
  // Step over one value that is not an array: a string, a nested object, or a bare scalar. False if the head ends first.
  const skipValue = () => {
    if (t[i] === '"') return readString() !== null;
    if (t[i] === '{') {
      let depth = 0;
      while (i < n) {
        if (t[i] === '"') { if (readString() === null) return false; continue; }
        if (t[i] === '{' || t[i] === '[') depth++;
        else if (t[i] === '}' || t[i] === ']') depth--;
        i++;
        if (depth === 0) return true;
      }
      return false;
    }
    while (i < n && t[i] !== ',' && t[i] !== '}') i++;      // number, true, false, null
    return i < n;
  };

  skipSpace();
  if (t[i] === '[') return { kind: 'bare-array', key: null, keys: [] };
  if (t[i] !== '{') return unknown([]);
  i++;
  const keys = [];
  for (;;) {
    skipSpace();
    if (i >= n) return unknown(keys);
    if (t[i] === ',') { i++; continue; }
    if (t[i] === '}') return keys.length ? { kind: 'bare-rows', key: null, keys: [] } : unknown([]);
    if (t[i] !== '"') return unknown(keys);
    const key = readString();
    if (key === null) return unknown(keys);
    skipSpace();
    if (t[i] !== ':') return unknown(keys);
    i++;
    skipSpace();
    if (i >= n) return unknown(keys);
    keys.push(key);
    if (t[i] === '[') return { kind: 'object-with-array', key, keys };
    if (!skipValue()) return unknown(keys);
  }
}

/** The wrapper in words: {"VERSION":…,"BERTHDATA":[…]}, a bare array, and so on. */
function wrapperText(w) {
  if (w.kind === 'object-with-array') {
    const parts = (w.keys && w.keys.length ? w.keys : [w.key]).map(k => (k === w.key ? `"${k}":[…]` : `"${k}":…`));
    return `{${parts.join(',')}}`;
  }
  if (w.kind === 'bare-array') return 'a bare array […]';
  if (w.kind === 'bare-rows') return 'bare rows with no wrapper';
  return 'an unrecognised layout';
}

/**
 * Open a file as a stream of decompressed bytes. Whether it is gzip is decided from the file's first
 * two bytes, not its name: a download saved as .json.gz that the server actually sent uncompressed
 * (or the reverse) still reads, and the result says which it was.
 */
function openSource(file) {
  let size, compressed;
  try {
    const fd = fs.openSync(file, 'r');          // a folder opens fine on Linux and fails at the read below
    try {
      size = fs.fstatSync(fd).size;
      const magic = Buffer.alloc(2);
      compressed = fs.readSync(fd, magic, 0, 2, 0) === 2 && magic[0] === 0x1f && magic[1] === 0x8b;
    } finally { fs.closeSync(fd); }
  } catch (e) { throw fileError(file, e); }

  const raw = fs.createReadStream(file);
  if (!compressed) return { stream: raw, compressed, size };
  const gunzip = zlib.createGunzip({ chunkSize: 64 * 1024 });
  // pipeline forwards an error from either end to the stream we read, and destroys both.
  const stream = pipeline(raw, gunzip, () => {});
  return { stream, compressed, size };
}

function fileError(file, e) {
  let message;
  if (e.code === 'ENOENT') message = `The file ${file} does not exist.`;
  else if (e.code === 'EACCES') message = `Cannot read ${file}: permission denied.`;
  else if (e.code === 'EISDIR') message = `${file} is a folder, not a file.`;
  else message = `Cannot read ${file} (${e.code || e.message}).`;
  const err = new Error(message);
  err.code = e.code === 'ENOENT' ? 'FILE_MISSING' : 'FILE_UNREADABLE';
  return err;
}

/**
 * Scan any readable stream of bytes (or strings). A multi-byte character split across two chunks is
 * reassembled by the decoder, so chunk boundaries cannot corrupt text. Resolves with the scanner's
 * summary plus `bytes` (how many bytes were read).
 */
async function scanStream(stream, { onRow, onBad, onChunk, maxRowChars } = {}) {
  const decoder = new StringDecoder('utf8');
  const scanner = new RowScanner({ onRow, onBad, maxRowChars });
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    scanner.write(decoder.write(chunk));
    if (onChunk) onChunk(bytes);
  }
  scanner.write(decoder.end());
  return { ...scanner.finish(), bytes };
}

/**
 * Stream every row of `file` to `onRow`. Resolves with the scanner's summary plus
 * { compressed, size (bytes on disk), bytes (bytes after decompression) }.
 * Rejects with a plain-English message if the file is missing or its gzip is damaged.
 */
async function streamRows(file, opts = {}) {
  const src = openSource(file);
  try {
    const summary = await scanStream(src.stream, opts);
    return { ...summary, compressed: src.compressed, size: src.size };
  } catch (e) {
    // zlib reports every kind of damaged stream (truncated, bad header, bad checksum...) with a Z_* code.
    if (src.compressed && /^Z_/.test(e.code || '')) {
      const err = new Error(`${file} is damaged or incomplete: gzip says "${e.message}". Download it again.`);
      err.code = 'GZIP_DAMAGED';
      throw err;
    }
    throw e;
  }
}

module.exports = { RowScanner, scanStream, streamRows, openSource, describeWrapper, wrapperText };
