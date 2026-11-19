'use strict';

// The daily timetable UPDATE extract, applied only when it is newer than the full timetable we loaded.
//
// How Network Rail publishes them (read from each file's own header, 2026-11-19):
//   - the FULL snapshot is published daily; we fetch it at 04:00 London (cif-fetcher downloadCif);
//   - each UPDATE carries one day's changes, is NAMED for that day (toc-update-mon..sun), and appears
//     ~00:30 UTC the NEXT morning. Both carry a sequence number, and a day's full has the same
//     sequence as the update published that morning: on 19 Nov the full was 5295, and so was 'wed'.
//
// Until 2026-11-20 the live code asked for TODAY's name every hour. Today's name is last week's file
// until tonight, so all day it applied a six-day-old update over a fresh full (19 Nov: 'thu' = 5289
// over full 5295). Measured from the service journal, 2026-05-31..11-19 (4,126 applications): 92%
// changed nothing at Portslade; on 7 days it withdrew 6 or 2 trains the full listed (none of them ran);
// on ~10 days it merged 1-6 older overlay records. The withdrawals repeated cancellations the full
// carried but the parser ignored until 2026-11-15 (2b799fd) — shown for 8Y91 (the 19 Nov full cancels
// it 28 Sep-4 Dec), and very likely for the other six (listed on every Mon-Thu, run in long blocks,
// the signature of planned cancellations; those fulls are gone, so it cannot be proven). With today's
// parser the full would withdraw them itself.
//
// The rule now: the update is applied only if its header says it is NEWER than the loaded full. Since
// the full is fetched after the morning's update is published, that is normally false and the update
// is skipped; it matters when the 04:00 full download failed and we are still on yesterday's.
//
// Shared by both engines: the timetable this produces is the one the berth-first engine reads too.

// 'apply' | 'stale' (older than the full: already in it) | 'same' (the full's own sequence: in it) |
// 'unknown' (either sequence unreadable: keep the full alone rather than guess).
function updateDecision(fullSeq, updateSeq) {
  if (!Number.isFinite(fullSeq) || !Number.isFinite(updateSeq)) return 'unknown';
  if (updateSeq > fullSeq) return 'apply';
  return updateSeq === fullSeq ? 'same' : 'stale';
}

// Fetch the newest update, read its header, and apply it over the loaded full only if it is newer.
//   fullSeq     the loaded full's sequence (null if unknown)
//   download()  -> { path, bytes, day }   (cif-fetcher downloadCifUpdate)
//   readHeader(path) -> { type, sequence, date }   (cif-archive readHeader)
//   apply(path) -> whatever the caller needs back (applyUpdateExtract over the full's parse)
//   log(line)
// Returns { decision, header, day, result? }. Throws only what download/readHeader/apply throw.
async function applyNewerUpdate({ fullSeq, download, readHeader, apply, log = () => {} }) {
  const res = await download();
  const header = await readHeader(res.path);
  if (header.type !== 'update') throw new Error(`toc-update-${res.day} is not an update extract (${header.type})`);
  const decision = updateDecision(fullSeq, header.sequence);
  const what = `CIF update: toc-update-${res.day} is sequence ${header.sequence} (${header.date}), loaded full is ${fullSeq == null ? 'unknown' : fullSeq}`;
  if (decision !== 'apply') {
    log(`${what} — not applied (${decision === 'unknown' ? 'sequence unknown' : 'not newer than the full'})`);
    return { decision, header, day: res.day };
  }
  log(`${what} — applying`);
  const result = await apply(res.path);
  return { decision, header, day: res.day, result };
}

module.exports = { updateDecision, applyNewerUpdate };
