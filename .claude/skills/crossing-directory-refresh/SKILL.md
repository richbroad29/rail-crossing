---
name: crossing-directory-refresh
description: Keep the crossing directory current - fold a new Network Rail level-crossing file into the master crossing list, and check which signalling areas now show level-crossing barrier data. Use when refreshing the crossing list or directory, when Network Rail publishes new level-crossing data, for the twice-yearly data check, or before launching a crossing.
---

# Crossing directory refresh

Three checks, run together **twice a year** and **before every crossing launch**:

- **A. Network Rail list.** Has Network Rail published a new level-crossing file? If so, fold it
  into the master crossing list and rebuild the directory.
- **B. Barrier data.** Which signalling areas, collected or not, carry barrier up/down data?
  More areas means cheaper launches (crossing-launch, Gate 4). Every area is banked permanently, so
  it can run any day.
- **C. Live crossing pages.** Re-measure each live crossing's figures and remake its local map.

Words: GLOSSARY.md (Crossing number, Crossing directory, Coming-soon crossing, Live crossing).

## The data, and why it is shaped this way

- **The master crossing list** is `scripts/crossing-list.csv` on `main`, one row per road crossing,
  keyed by crossing number. It is the source of truth. **It is edited, never regenerated:** the
  scripts that first built it (OSM + OS + ONS, 4 GB of downloads) were lost in November 2026, and
  its road names, towns and positions include 27 hand-checked fixes and 9 satellite checks that a
  rerun would undo.
- Each row holds **what Network Rail said last time** (`nr_name`, `nr_type`, `nr_status`,
  `nr_lat`, `nr_lon`) apart from **what the app shows** (`display_name`, `road`, `town`, `lat`,
  `lon`...). A refresh compares Network Rail with Network Rail, so a position we corrected never
  reads as "moved".
- `hand_checked=yes`: a person checked this row; a refresh flags it and does not overwrite its
  position. `excluded=yes` + `exclude_reason`: a private yard or works crossing kept out of the
  directory; it stays in the list so a refresh does not add it back.
- `scripts/build-crossings.js` joins the list with the live crossing definitions to make the
  directory. It **fails** if a live crossing's number is missing from the list - that is the guard
  against a refresh dropping a live crossing.
- Licences: Network Rail and OS are OGL; road and town names are partly from OpenStreetMap (ODbL),
  so the published directory carries the OSM attribution and is offered under ODbL.

**First run only:** if `scripts/crossing-list.csv` does not exist yet, make it from the research
files with `nr-refresh.py seed` (the research used Network Rail's August 2025 file, URL in
`history/refresh-log.md`), then apply the exclusions and commit. The seed's diff against that same
file must report **zero changes**; anything else means the wrong file.

## A. Network Rail list

1. **Ask Rich to check for a new file** (their site blocks automated fetches - 403):
   - Open https://www.networkrail.co.uk/who-we-are/safety-in-the-community/level-crossing-safety/active-level-crossings/
   - Find the "Alternative download" card ("Level crossings data: <month year>").
   - Tell me the month shown, and right-click the download link → Copy Link Address → paste it.

   Same file as the last entry in `history/refresh-log.md` → log "no change" and go to B.
2. **Download it** into a new empty folder in the scratchpad (it is untrusted input):
   `curl -s -A 'Mozilla/5.0' -o <scratch>/nr/nr.xlsx '<url>'`
3. **Diff:** `python3 -I .claude/skills/crossing-directory-refresh/scripts/nr-refresh.py diff <scratch>/nr/nr.xlsx scripts/crossing-list.csv`.
   If it stops on "Network Rail changed the columns", read the header it prints and adapt
   `read_xlsx` - never guess a column.
4. **Show Rich the summary and get a yes to each section.** Look up each "Gone" number against the
   crossing numbers in the live definitions (`backend/config/crossings/<slug>.json` on
   `origin/backend-v2`) - a gone live crossing is Rich's call (retire it, or Network Rail renumbered).
   Look at every hand-checked "moved" row and every core↔ambiguous move on the map before saying
   what you recommend.
5. **Apply** to a new file: `nr-refresh.py apply <nr.xlsx> scripts/crossing-list.csv <scratch>/crossing-list.new.csv`.
6. **Fill every `needs_fill=yes` row** by [FILL-RULES.md](FILL-RULES.md), then clear the flag.
   For each new row also decide `excluded` (private yard or works = excluded, with a reason).
7. **Check the new file** before it replaces the old one: no `needs_fill=yes` left; no blank
   `road`, `town`, `local_authority`, `ceremonial_county`, `country`; every new county, council and
   country value already appears elsewhere in its column (a new spelling is a mistake until
   proved otherwise). Then move it over `scripts/crossing-list.csv`.
8. **Rebuild:** `node scripts/build-crossings.js` - it must pass. Show Rich `git diff --stat` and
   the list's diff; commit only on his word (CLAUDE.md: main deploys live).
9. **Log it** in `history/refresh-log.md`: date, file month + URL, counts per section.

## B. Barrier data

The feed carries signalling (S-Class) data for **every** area in Britain, and the server keeps all
of it: the areas in `backend/config/sclass.json` (12 today) in `sclass-<date>` files, every other
area in `survey-<date>` files beside them. The all-area survey ran as a one-week window from
2026-11-12 and has been **permanent since 2026-11-19** (backend-v2 `6d3421a`: `sclass.json`
`survey.until: "always"`), gzipped the next day (~45 MB) and pruned after **90 days** like every log
(`backend/src/retention.js`). So the check covers areas we don't collect, with nothing to switch on
and nothing to look up by hand.

1. **Is the survey still on?** The journal's 5-minute summary line ends `+ N survey`, and
   `survey.until` in `backend/config/sclass.json` is `"always"`. **Do not set it back to `null`**
   (Rich, 2026-11-19: barrier data from every area is kept). If it is off, that is a fault: tell Rich.
2. **Check the disk:** `du -sh ~/rail-crossing/backend/data/logs/sclass/survey-*` and `df -h /` on the
   VPS. Expect ~45 MB a day gzipped (~620 MB for today's unzipped file) and the whole VPS at
   ~14-18 GB of logs at steady state. Under 10 GB free: tell Rich before anything else.
3. **Are the logs complete?** `ls ~/rail-crossing/backend/data/logs/sclass/ | tail -20`: one
   `sclass-<date>` and one `survey-<date>` (plain or `.gz`) per day scanned. A missing day lowers
   the per-day rates; say so in the report.
4. **Run the scan on the Mac, not the VPS.** Over every area it peaks at **1.2 GB** of memory
   (2026-11-21); the VPS has 952 MB in all, shared with the live service, so the old 300 MB run
   there would die. Copy the last 7 complete days (`sclass`, `survey`, `barrier`, ~350 MB) and the
   config into `~/rc-data/sclass-survey/`, then run it there (~30 min; it reads `.gz`):
   ```
   mkdir -p ~/rc-data/sclass-survey/<date> && cd ~/rc-data/sclass-survey/<date>
   ssh -i ~/Downloads/ssh-key-2026-03-22.key ubuntu@130.162.167.237 'cd ~/rail-crossing/backend && tar cf - config/sclass.json data/logs/sclass/{sclass,survey,barrier}-2026-11-{14..20}.jsonl.gz' | tar xf -
   for f in data/logs/sclass/*.gz; do gzip -t "$f" || echo "BAD $f"; done
   node --max-old-space-size=8000 <repo>/.claude/skills/crossing-directory-refresh/scripts/barrier-bit-scan.js --days 7 --dir "$PWD/data/logs/sclass" --config "$PWD/config/sclass.json" > <repo>/.claude/skills/crossing-directory-refresh/history/barrier-scan-<date>.txt
   ```
   (Put the 7 dates in the `{14..20}`; a week across a month end needs two brace groups. scp
   will not expand braces on the server; the tar pipe does.)
   Its first line must say "7 with an all-area survey"; fewer means the survey didn't cover the
   week.
5. **Known answer first.** BM byte 09 (Yapton, bits 7/6) must be a candidate at the number of
   Yapton closures a day **over the same 7 days** (`barrier-<date>` files, `"kind":"CLOSE"`, summed
   and divided by 7). Not a fixed figure: a weekday is ~200-237, but engineering works can stop the
   line (14-15 Nov 2026: 9 and 4), which pulls the week down (158/day that week). If they do not
   match, the scan or the feed is broken; stop and fix that before reading anything else.
6. **Compare with the previous `history/barrier-scan-*.txt`:**
   `node scripts/area-names.js ~/rail-map-refdata/smart-latest.json.gz ~/rail-map-refdata/corpus-latest.json.gz > <scratch>/area-names.json`
   (each TD area's busiest SMART places, since the Open Rail Data wiki refuses automated fetches), then
   `node scripts/barrier-scan-compare.js <previous scan> <this scan> <sclass.json> <scratch>/area-names.json`.
   Self-test: the 2026-11-12 file against itself must give 99 pairs / 63 bytes. It lists
   candidate bytes per area, which
   areas are **new** (not in `sclass.json`), and which bytes are new. A candidate is a
   **shortlist entry, not a crossing**: signals beside a crossing switch in the same rhythm. Only
   the train check (step 7) binds a bit to a crossing. Report per
   area: candidate bytes now vs last time, and the busiest new ones. **Expect noise:** in Nov 2026,
   11 London areas with at most one road crossing (X0 X1 X2 X3 X8 XA XB Q0 NX Y9 VC) carried 81
   candidate bytes, from points and signals. A count of candidates is not a count of crossings, and a minimum
   closure length only halves the noise (≥45 s: 81 → 36), so the berth correlation stays the filter.
7. **Train check: which candidates are crossings, and which ones.** `scripts/barrier-train-check.js`
   tests every candidate against the trains, without being told any berths (its header says how).
   It needs the all-area train steps for the same days (`td-all-<date>`, kept since 19 Nov 2026, 90
   days); copy them beside the S-Class files, in the same folder as step 4:
   ```
   ssh -i ~/Downloads/ssh-key-2026-03-22.key ubuntu@130.162.167.237 'cd ~/rail-crossing/backend && tar cf - data/logs/td-all/td-all-2026-11-{14..20}.jsonl.gz' | tar xf -
   node --max-old-space-size=12000 <repo>/.claude/skills/crossing-directory-refresh/scripts/barrier-train-check.js --sclass "$PWD/data/logs/sclass" --cclass "$PWD/data/logs/td-all" --from 2026-11-14 --to 2026-11-20 --scan <repo>/.claude/skills/crossing-directory-refresh/history/barrier-scan-<date>.txt --json <scratch>/train-check.json > <repo>/.claude/skills/crossing-directory-refresh/history/barrier-train-check-<date>.txt
   ```
   (2 days: 45 s, 0.5 GB on the Mac.) **Read the last line first:** the Yapton known answer must say
   PASS. Verdicts: **CONFIRMED** = the bit follows the trains both ways and sits at a named crossing;
   **WHICH ONE?** = it passes every train rule, but two or three listed crossings are too close to
   choose between (settle by berth order or a site check); **POSSIBLE** = one rule could not be tested
   (no timed station near its trains, the other direction not found); **REJECTED** = says why. Count
   crossings, not bits: one crossing can show in several bytes and in two areas (Yapton is BM 09 and
   CH 18 - every down-bit change within 5 s). Dry run 22 Nov on 20-21 Nov only: 17 confirmed, 10
   unresolved groups, and all 127 London noise candidates rejected.
8. **Feed it to crossing-launch:** report each new area with candidates to Rich. Its data is already
   banked (survey, 90 days), so nothing needs adding to `sclass.json` until a byte is bound to a
   crossing (step 7, or crossing-launch Stage 3), when the area goes in to decode that barrier live. Any Parked
   candidate in crossing-launch's `CANDIDATES.md` whose area gained candidates is due a re-check (its
   "re-check if S-Class coverage expands" trigger).

## C. Live crossing pages

Each live crossing's About block carries figures and a map picture that go stale (ticket 12):
1. **Figures:** on the VPS, `node backend/scripts/crossing-figures.js --crossing <id> --from <4 weeks
   ago> --to <yesterday>` (copy it to /tmp first if backend-v2 isn't deployed yet); paste the block
   into `presentation.figures` in the definition on backend-v2, commit, push (no restart needed: the
   backend never reads it).
2. **Map pictures:** on the Mac, after `git fetch`, `node scripts/render-local-maps.mjs` (all live
   crossings; opens Chrome off-screen). Look at each `<id>/local-map.webp`.
3. `node scripts/build-crossings.js`, `--check`, screenshot one page, and ask Rich before pushing.

## Done

Both logs written (`history/refresh-log.md`, `history/barrier-scan-<date>.txt`), Rich has seen the
two summaries, and either the list is unchanged or its new version is built and awaiting his push.
