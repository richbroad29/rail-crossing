'use strict';

// A small streaming CSV record parser (RFC 4180): quoted fields may contain commas, newlines and doubled
// quotes; CRLF and LF both end a record; a leading byte order mark is ignored. Records are handed to
// `onRecord` as soon as they close, so memory stays bounded, and a field longer than `maxFieldChars` is
// truncated (and counted) rather than allowed to swallow the rest of the file behind a stray opening quote.

class CsvParser {
  constructor(onRecord, { maxFieldChars = 100000 } = {}) {
    this.onRecord = onRecord;
    this.maxFieldChars = maxFieldChars;
    this.field = '';
    this.record = [];
    this.touched = false;        // has the current field had any character, an opening quote included?
    this.inQuotes = false;
    this.quotePending = false;   // in quotes, just saw a '"': an escaped quote or the closing one, decided by the next character
    this.started = false;
    this.records = 0;
    this.truncatedFields = 0;
    this.fieldTruncated = false;
  }

  _append(c) {
    if (this.field.length < this.maxFieldChars) { this.field += c; return; }
    if (!this.fieldTruncated) { this.fieldTruncated = true; this.truncatedFields++; }   // counted once per field
  }

  _endField() {
    this.record.push(this.field);
    this.field = '';
    this.touched = false;
    this.fieldTruncated = false;
  }

  _endRecord() {
    // A blank line is not a record.
    if (this.record.length === 0 && !this.touched && this.field === '') return;
    this._endField();
    this.records++;
    const r = this.record;
    this.record = [];
    this.onRecord(r);
  }

  write(text) {
    let i = 0;
    if (!this.started) { this.started = true; if (text.charCodeAt(0) === 0xfeff) i = 1; }
    for (; i < text.length; i++) {
      const c = text[i];
      if (this.inQuotes) {
        if (this.quotePending) {
          this.quotePending = false;
          if (c === '"') { this._append('"'); continue; }     // "" inside quotes is one quote
          this.inQuotes = false;                              // it was the closing quote: handle c normally below
        } else if (c === '"') { this.quotePending = true; continue; }
        else { this._append(c); continue; }
      }
      if (c === '"' && !this.touched) { this.inQuotes = true; this.touched = true; continue; }
      if (c === ',') this._endField();
      else if (c === '\n') this._endRecord();
      else if (c === '\r') continue;
      else { this._append(c); this.touched = true; }
    }
  }

  /** Flush a final record that has no trailing newline. Returns whether the input ended inside quotes. */
  end() {
    const unterminated = this.inQuotes && !this.quotePending;
    if (this.touched || this.record.length) this._endRecord();
    return { unterminatedQuote: unterminated };
  }
}

module.exports = { CsvParser };
