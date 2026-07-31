/*
 * Google Apps Script behind the feedback Google Sheet — the "Feedback v2" tab.
 *
 * THIS FILE IS A COPY FOR VERSION CONTROL. The running code lives in the spreadsheet
 * (Extensions → Apps Script). Edit here, then paste the whole file over the editor's
 * contents and Deploy → Manage deployments → edit → Deploy, so the two stay in step.
 * The deployment URL is in shared/crossings.json → feedbackUrl. No credentials here.
 *
 * Both front-ends post to this endpoint with the SAME payload shape
 * (PREDICT.feedbackPayload in shared/predict.js): the public app when a user taps
 * "Barriers Closing/Opening Now", and the observer app on every capture. The `source`
 * column says which. Adding a field means appending its name to FIELDS below — the
 * header row and the sheet's column count migrate themselves on the next post.
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var data = JSON.parse(e.postData.contents);
    // A post with test:true goes to a scratch tab, never to the real one — so the write
    // path, the header migration and the eventId upsert can all be exercised end to end
    // without a test row landing in the calibration data. Duplicate "Feedback v2" to
    // "Feedback v2 TEST" first if you want the migration tested against the real starting
    // layout rather than an empty tab. Set by ?test=1 on the observer app.
    var TAB = (data.test === true) ? 'Feedback v2 TEST' : 'Feedback v2';
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB) || ss.insertSheet(TAB);

    var FIELDS = [
      'eventId', 'completed', 'receivedAt',
      'crossing', 'crossingName',
      'eventTimestamp', 'event', 'predictedState',
      'ourGuessHeadcode', 'ourGuessRoute', 'ourGuessDirection', 'ourGuessType',
      'ourGuessSchedArr', 'ourGuessSchedDep', 'ourGuessLiveArr', 'ourGuessLiveDep',
      'ourGuessPosition', 'ourGuessBerth', 'ourGuessBerthHistory',
      'submittedAt',
      'selectedHeadcode', 'selectedRoute', 'selectedDirection', 'selectedType',
      'selectedSchedArr', 'selectedSchedDep', 'selectedLiveArr', 'selectedLiveDep',
      'selectedPosition', 'selectedBerth', 'selectedBerthHistory',
      'wasOurGuess', 'notSure',
      // --- appended 2026-07-29, when the observer app started posting here ---
      // Which app recorded the row: "public" (a user at the crossing tapping the feedback
      // button) or "observer" (the field data-collection PWA).
      'source',
      // observer only: false for a transition the observer marked as missed, where the
      // timestamp is approximate and there is no attributed train. Filter these out of any
      // timing calibration — they mark that a transition happened, not when.
      'observed',
      // observer only: the human's own confidence in the attribution, and any note.
      'confidence', 'note',
      // observer only: which closure episode (CLOSE→OPEN pair) the row belongs to, and how
      // long the barrier was actually down, in ms — present on the OPEN half of a pair.
      'episodeIndex', 'closureDurationMs',
      // observer only: the device's measured clock offset from the server at capture time.
      // The timestamps are already corrected by it; this is here to audit that correction.
      'deviceOffsetMs',
      // What the app was PREDICTING at the instant of the observation, and the gap between
      // prediction and reality. deltaVsPredictedSecs is positive when the barrier moved
      // LATER than predicted. This is the calibration measurement.
      'predictedCloseTime', 'predictedOpenTime', 'predictedDownForSecs', 'deltaVsPredictedSecs',
      // --- appended 2026-07-31 ---
      // The class the PREDICTION used, and the flags that decide it, for both the app's guess
      // and the train actually selected. Without these, calibration has to re-derive the class
      // from protecting-berth dwell, which only works after the train has crossed — so it is
      // unavailable at the moment of a close, which is when the prediction needs it.
      //
      // *Class is one of: stoppingLocal (calls the crossing station AND the station inside the
      // approach berth) / stopping (crossing station only) / fast (neither) / ecs / freight.
      // NOTE it can legitimately disagree with ourGuessType/selectedType — those are the app's
      // own guess from the headcode's first character, this is the backend's real answer.
      //
      // *Stopping/CallsAt* are tri-state: TRUE / FALSE / blank, where blank means unknowable.
      // Blank is NOT false — "we don't know" and "it doesn't call" select different anchors, so
      // filter on TRUE/FALSE explicitly rather than on truthiness.
      'ourGuessStopping', 'ourGuessClass', 'ourGuessCallsAtStation', 'ourGuessCallsAtApproach',
      'selectedStopping', 'selectedClass', 'selectedCallsAtStation', 'selectedCallsAtApproach',
      // true only for rows written by the observer's ?test=1 mode. Those land in the
      // "Feedback v2 TEST" tab, so this column should read blank/false on every row of the
      // real tab — if it ever reads true there, the routing above has broken.
      'test'
    ];

    // --- self-migration, so adding a field above needs no manual sheet edit ---
    // Widen the grid if FIELDS now exceeds it, otherwise the getRange calls below throw.
    if (sheet.getMaxColumns() < FIELDS.length) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), FIELDS.length - sheet.getMaxColumns());
    }
    // Write the header row: on a brand-new tab, and again whenever FIELDS has grown or been
    // renamed. Safe to rewrite — only appended fields ever change, so existing columns keep
    // their position and existing data stays where it is.
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(FIELDS);
      sheet.setFrozenRows(1);
    } else {
      sheet.getRange(1, 1, 1, FIELDS.length).setValues([FIELDS]);
    }
    sheet.getRange(1, 1, 1, FIELDS.length).setFontWeight('bold');

    // Keep berth codes as text so leading zeros (0005) survive.
    ['ourGuessBerth', 'selectedBerth'].forEach(function(name) {
      sheet.getRange(1, FIELDS.indexOf(name) + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
    });

    data.receivedAt = new Date();
    var row = FIELDS.map(function(f) {
      var v = data[f];
      return (v === undefined || v === null) ? '' : v;
    });

    // Upsert by eventId (column 1): the event is posted at button-tap (completed=false)
    // and again on submit (completed=true) — the second post updates the same row. Never
    // downgrade a completed row back to not-completed.
    var lastRow = sheet.getLastRow();
    var targetRow = 0;
    if (data.eventId && lastRow > 1) {
      var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (ids[i][0] === data.eventId) { targetRow = i + 2; break; }
      }
    }

    if (targetRow) {
      var existingCompleted = sheet.getRange(targetRow, 2).getValue();
      if (existingCompleted === true && data.completed !== true) {
        return ContentService.createTextOutput('skip');
      }
      sheet.getRange(targetRow, 1, 1, FIELDS.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }

    return ContentService.createTextOutput('ok');
  } finally {
    lock.releaseLock();
  }
}
