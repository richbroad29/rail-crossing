# Phase 0 runbook — for Rich

Three read-only checks run on the VPS. Together they answer the questions the live train map
depends on, before anything is built:

| Check | Answers | Takes |
| --- | --- | --- |
| `smart-check` | Does Network Rail's SMART file read the way we think, and how many berths can it place at stations? | 1–3 minutes |
| `td-measure` | Can the map have its own Network Rail connection without disturbing the crossing service? What does the national feed cost in CPU and memory, and does a map service fit on this machine? | 60 minutes |
| `feeds-check` | Do the TRUST and VSTP feeds work once switched on, and do they carry the fields we need? | about 13 minutes |

**What they will not do:** change anything in `~/rail-crossing`, restart anything, or write anywhere
except their own `out/` folder. `td-measure` and `feeds-check` watch the crossing service the whole
time they are connected. If it looks at all unwell, they disconnect at once and say so.

Run them in this order, on a weekday if you can. Avoid 03:30–04:30, when the crossing service
reloads the timetable.

---

## 1. Get the code (once)

Connect to the VPS the way you usually do, then run these one at a time.

```bash
cd ~/rail-crossing
```
The existing checkout. We only use it to fetch; its files and branch are not changed.

```bash
git fetch origin claude/map-phase-0
```
Downloads the phase 0 branch. Nothing changes on disk yet.

```bash
git worktree add ~/rail-map origin/claude/map-phase-0
```
Makes a **separate** folder, `~/rail-map`, holding the phase 0 code. `~/rail-crossing` stays on
`backend-v2` exactly as it was. You can check with `git -C ~/rail-crossing branch --show-current`,
which should still print `backend-v2`.

```bash
cd ~/rail-map/map-service/phase0
npm ci
```
Installs the one library the checks use (the same STOMP library the crossing service uses), into
`~/rail-map` only.

---

## 2. SMART check

```bash
cd ~/rail-map/map-service/phase0
nice -n 19 node --max-old-space-size=256 bin/smart-check.js
```
`nice -n 19` gives it the lowest CPU priority, so the crossing service always comes first.
`--max-old-space-size=256` caps its memory.

It downloads SMART into `out/data/`, reads the CORPUS file and TD logs the crossing service already
has (read-only), and prints a block that starts `===== smart-check … paste from here =====` and
ends `===== end smart-check =====`. **Copy that whole block back to Claude.**

---

## 3. Switch on the TRUST and VSTP feeds (before step 5)

1. Sign in to the Network Rail open data site (the same login as `NR_FEED_USER`).
2. Open your feed subscriptions.
3. Tick **Train Movements, all operators** (this is TRUST, topic `TRAIN_MVT_ALL_TOC`) and **VSTP**
   (topic `VSTP_ALL`).
4. Save.

The page wording may differ slightly from this; the topic names are what matter. This adds feeds to
your account. It does not change the crossing service, which keeps using only the TD feed.

---

## 4. Second connection and national load: 60 minutes

Start it in a `tmux` session, so a dropped SSH connection doesn't end the run:

```bash
tmux new -s phase0
```
Opens a terminal that keeps running if you disconnect. If `tmux` isn't installed, skip this line
and keep your terminal open for the hour.

```bash
cd ~/rail-map/map-service/phase0
nice -n 19 node --max-old-space-size=256 bin/td-measure.js --minutes 60
```
Best started on a weekday between 16:00 and 17:00, so the hour covers the evening peak.

- To leave it running: press `Ctrl-b`, then `d`. To come back: `tmux attach -t phase0`.
- To stop early: `Ctrl-c`. It disconnects cleanly and still writes its report.

When it finishes it prints a `td-measure` block. **Copy it back.**

A `MEMORY_FIT` of WARN or FAIL is not an error. It is the answer to "does a map service fit next to
the crossing service on this machine?": FAIL means the map gets its own (free) machine.

**If it says `INTERLOCK TRIPPED`:** it has already disconnected. Do **not** restart anything. The
crossing service reconnects by itself within about 5 minutes. Run the `curl` command it prints, then
copy everything it printed back to Claude.

---

## 5. TRUST and VSTP: about 13 minutes

```bash
cd ~/rail-map/map-service/phase0
nice -n 19 node --max-old-space-size=256 bin/feeds-check.js
```
It connects to TRUST for 3 minutes, then to VSTP for 10, one at a time. **Copy the `feeds-check`
block back.** A FAIL saying "not authorised" means step 3 hasn't taken effect yet: wait a few
minutes and run it again.

---

## 6. Afterwards: confirm the crossing service is fine

```bash
curl -s http://127.0.0.1:3000/health
```
It should say `"status":"ok"`. Both measuring scripts also print a `sudo journalctl …` command
covering the minutes they ran. Run it and copy its output back too: any line there means the crossing
service's own feed connection blinked while we were connected.

---

## 7. Two things to look up (no commands)

- **Oracle:** in the Oracle Cloud console, under Compute → Instances, the **shape** of the VPS (for
  example `VM.Standard.E2.1.Micro` or `VM.Standard.A1.Flex`), and whether your tenancy can create a
  second Always Free instance.
- **OpenFreeMap:** on openfreemap.org, whether a public site may use its map tiles free without a
  key, and any attribution it asks for.

---

## Where everything is

- Code: `~/rail-map` (separate from `~/rail-crossing`).
- Reports: `~/rail-map/map-service/phase0/out/`, a `.txt` and a `.json` per run. They never contain
  your password or login.
- To remove it all when phase 0 is finished:
  `cd ~/rail-crossing && git worktree remove --force ~/rail-map`
