'use strict';

// S-Class survey window (crossing-directory-refresh skill): while sclass.json survey.until is in
// the future, raw S-Class from areas NOT in the config is banked to survey-<date>.jsonl; areas in
// the config are logged exactly as before; nothing is written outside the window; the window is
// capped at SURVEY_MAX_DAYS; the rotation prunes survey files sooner. Writes go to a temp folder.

const fs = require('fs');
const os = require('os');
const path = require('path');

const td = require('../src/td-listener');
const rotation = require('../src/sclass-rotation');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n          got:      ${actual}\n          expected: ${expected}`); fail++; }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const readLines = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const sf = (area, address, data) => ({ SF_MSG: { area_id: area, msg_type: 'SF', address, data, time: String(Date.now()) } });
const body = (...w) => JSON.stringify(w);

(async () => {
  console.log('\nS-Class survey window\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sclass-survey-'));
  const survey = path.join(tmp, 'survey.jsonl');
  td._setLogFilesForTest({ survey: () => survey, td: a => path.join(tmp, 'td', a + '.jsonl'), cclass: a => path.join(tmp, 'cc', a + '.jsonl') });

  // ---- the window ------------------------------------------------------------------------
  const now = Date.parse('2026-11-12T12:00:00Z');
  const { SURVEY_MAX_DAYS } = td._constantsForSurveyTest;
  check('no survey block -> off', td._surveyUntilFrom({ areas: {} }, now), null);
  check('until null -> off', td._surveyUntilFrom({ survey: { until: null } }, now), null);
  check('until in the past -> off', td._surveyUntilFrom({ survey: { until: '2026-11-01T00:00:00Z' } }, now), null);
  check('until not a date -> off', td._surveyUntilFrom({ survey: { until: 'next week' } }, now), null);
  check('until 7 days ahead -> that instant',
    td._surveyUntilFrom({ survey: { until: '2026-11-19T12:00:00Z' } }, now), Date.parse('2026-11-19T12:00:00Z'));
  check(`until a year ahead -> capped at ${SURVEY_MAX_DAYS} days`,
    td._surveyUntilFrom({ survey: { until: '2027-11-12T12:00:00Z' } }, now), now + SURVEY_MAX_DAYS * 86400000);
  const liveUntil = require('../config/sclass.json').survey.until;
  check('live config: survey.until is null or a real date (a typo would silently mean "off")',
    liveUntil === null || Number.isFinite(Date.parse(liveUntil)), true);

  // ---- routing ---------------------------------------------------------------------------
  // Off: an unconfigured area writes nothing.
  td._setSurveyUntilForTest(null);
  td._processMessageForTest(body(sf('ZZ', '10', '40')));
  await wait(50);
  check('survey off: unconfigured area writes nothing', readLines(survey).length, 0);

  // On: unconfigured areas are banked, the configured area (BM) is not duplicated into it.
  td._setSurveyUntilForTest(Date.now() + 60000);
  td._processMessageForTest(body(
    sf('ZZ', '10', '40'),
    { SG_MSG: { area_id: 'Q9', msg_type: 'SG', address: '00', data: '0A0B0C0D', time: String(Date.now()) } },
    sf('BM', '09', 'A0'),
    sf('../x', '01', '01'),
    { SF_MSG: { area_id: 'ZZ', msg_type: 'SF', address: '11' } }
  ));
  await wait(50);
  const got = readLines(survey);
  check('survey on: two unconfigured messages banked', got.length, 2);
  // Writes are async appends, so compare as a set, not by position.
  const lines = got.map(e => `${e.area} ${e.msgType} ${e.address}=${e.data}`).sort();
  check('  ZZ SF 10=40 banked', lines.includes('ZZ SF 10=40'), true);
  check('  SG refresh kept whole', lines.includes('Q9 SG 00=0A0B0C0D'), true);
  check('  same shape as the sclass raw log', got[0] && Object.keys(got[0]).join(','), 'ts,feedTime,area,msgType,address,data');
  check('  configured area BM is not in the survey file', got.some(e => e.area === 'BM'), false);
  check('  an area id that would be a path is refused', got.some(e => e.area === '../x'), false);

  // Expired: nothing more is written, with no restart.
  td._setSurveyUntilForTest(Date.now() - 1);
  td._processMessageForTest(body(sf('ZZ', '12', '80')));
  await wait(50);
  check('after the window closes, nothing more is written', readLines(survey).length, 2);

  // C-Class for an unconfigured area is still ignored, survey or not.
  td._setSurveyUntilForTest(Date.now() + 60000);
  td._processMessageForTest(body({ CA_MSG: { area_id: 'ZZ', msg_type: 'CA', from: '0001', to: '0002', descr: '1A01', time: String(Date.now()) } }));
  await wait(50);
  check('C-Class of an unconfigured area is not logged anywhere', fs.existsSync(path.join(tmp, 'td', 'ZZ.jsonl')) || fs.existsSync(path.join(tmp, 'cc', 'ZZ.jsonl')), false);
  td._setSurveyUntilForTest(null);

  // ---- rotation --------------------------------------------------------------------------
  check('rotation recognises survey files', rotation._parseDateFromName('survey-2026-11-12.jsonl.gz') instanceof Date, true);
  check('survey files pruned after 60 days', rotation._pruneAfterDays('survey-2026-11-12.jsonl'), 60);
  check('other S-Class files still kept 180 days', rotation._pruneAfterDays('sclass-2026-11-12.jsonl'), 180);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
