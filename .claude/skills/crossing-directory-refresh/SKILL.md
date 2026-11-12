---
name: crossing-directory-refresh
description: Keep the crossing directory current - fold a new Network Rail level-crossing file into the master crossing list, and check which signalling areas now show level-crossing barrier data. Use when refreshing the crossing list or directory, when Network Rail publishes new level-crossing data, for the twice-yearly data check, or before launching a crossing.
---

# Crossing directory refresh

Two checks, run together **twice a year** and **before every crossing launch**. Start B's survey
week first; do A while it runs:

- **A. Network Rail list.** Has Network Rail published a new level-crossing file? If so, fold it
  into the master crossing list and rebuild the directory.
- **B. Barrier data.** Which signalling areas, collected or not, carry barrier up/down data?
  More areas means cheaper launches (crossing-launch, Gate 4). Needs a survey week first.

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

The feed carries signalling (S-Class) data for **every** area in Britain. The server keeps only the
areas in `backend/config/sclass.json` (12 today) unless a **survey** is on, when it also keeps
every other area for up to 14 days, in `survey-<date>` files beside the usual `sclass-<date>`
ones. So the check covers areas we don't collect, with nothing to look up by hand.

1. **Start the survey a week before the check** (a backend change and a restart, so Rich's go):
   on `backend-v2`, set `survey.until` in `backend/config/sclass.json` to 7 days ahead (ISO, e.g.
   `"2026-11-21T00:00:00Z"`), commit, push, and give Rich the deploy steps (CLAUDE.md, "Deploying
   the backend"). It switches itself off at that time; set it back to `null` in the next commit.
2. **After day 1, check the disk:** `du -sh ~/rail-crossing/backend/data/logs/sclass/survey-*` and
   `df -h /` on the VPS. Above ~2 GB a day, or under 10 GB free, set `until` to now and restart.
   The journal's 5-minute summary line ends `+ N survey` while it runs.
3. **Are the logs complete?** `ls ~/rail-crossing/backend/data/logs/sclass/ | tail -20`: one
   `sclass-<date>` and one `survey-<date>` per survey day. A missing day lowers the per-day
   rates; say so in the report.
4. **Run the scan** over the survey days (copy it to the VPS and run it there, where the logs are):
   ```
   scp -i ~/Downloads/ssh-key-2026-03-22.key .claude/skills/crossing-directory-refresh/scripts/barrier-bit-scan.js ubuntu@130.162.167.237:/tmp/
   ssh -i ~/Downloads/ssh-key-2026-03-22.key ubuntu@130.162.167.237 'cd ~/rail-crossing && nice -n 19 node --max-old-space-size=300 /tmp/barrier-bit-scan.js --days 7' > .claude/skills/crossing-directory-refresh/history/barrier-scan-<date>.txt
   ```
   Its first line must say "7 with an all-area survey"; fewer means the survey didn't cover the
   week.
5. **Known answer first.** BM byte 09 (Yapton, bits 7/6) must be a candidate at roughly the
   number of Yapton closures a day (`barrier-<date>` files, `"kind":"CLOSE"`; ~217/day in Nov 2026).
   If it is not, the scan or the feed is broken; stop and fix that before reading anything else.
6. **Compare with the previous `history/barrier-scan-*.txt`:** candidate bytes per area, which
   areas are **new** (not in `sclass.json`), and which bytes are new. A candidate is a
   **shortlist entry, not a crossing**: signals beside a crossing switch in the same rhythm. Only
   the berth-correlation proof in crossing-launch Phase 3 binds a bit to a crossing. Report per
   area: candidate bytes now vs last time, and the busiest new ones.
7. **Feed it to crossing-launch:** a new area with candidates is proposed to Rich as a
   collection-only area in `sclass.json` (`"logRaw": "all"`, `"crossings": {}`) so its data is
   banked for good. Any Parked candidate in crossing-launch's `CANDIDATES.md` whose area gained
   candidates is due a re-check (its "re-check if S-Class coverage expands" trigger).

## Done

Both logs written (`history/refresh-log.md`, `history/barrier-scan-<date>.txt`), Rich has seen the
two summaries, and either the list is unchanged or its new version is built and awaiting his push.
