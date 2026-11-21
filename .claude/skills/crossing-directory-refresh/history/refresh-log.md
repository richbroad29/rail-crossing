# Refresh log

One entry per run of the crossing-directory-refresh skill, newest last.

## 2026-11-12 - baseline (skill created)

- **Network Rail file:** "Level crossings data", snapshot 20 July 2025, file dated 14 Aug 2025:
  https://www.networkrail.co.uk/wp-content/uploads/2025/08/Level-crossing-risk-assessment-data-August-2025.xlsx
  (671,559 bytes; 6,121 rows; 1,351 core road + 71 ambiguous + 1 Engineering Only dropped).
  Checked in a browser by Rich 2026-11-12: the card still reads "Level crossings data: November
  2025", exactly what it said when the research found it linking to this August 2025 file, so no
  newer file. (A card month alone can't prove the file changed; next time also paste the link.)
- **Master list:** not yet on main. `seed` from the burger-menu research CSVs then a diff against
  this same file gave 0 changes in every section (the known-answer test), and a planted-change
  test caught all 8 kinds of change correctly. The seed also fixes the 5 names the first clean-up
  missed (Boston and Spilsby Road, Eagle and Thorpe, Claxby and Usselby, Tees Yard No.1,
  Middleton Towers).
- **Barrier scan:** `barrier-scan-2026-11-12.txt`, 14 days 2026-10-29..11-11. Known answer
  passed: BM 09 bits 7/6 (Yapton) at 216 cycles/day against 212-222 logged closures/day, lowering
  18 s. 63 candidate bytes across all 12 areas (B3 20, RT 11, X7 10, EK 5, EN 5, EA 3, Q3 3, Q5 2,
  BM 1, BU 1, EH 1, HG 1). Unproven shortlist; only Yapton is bound to a crossing.
- **Areas we don't collect:** not yet covered. Rich (2026-11-12) asked for the check to cover
  them; the all-area survey week (backend branch `claude/sclass-survey`) does that and replaces
  reading the Open Rail Data wiki. First survey runs once that change is deployed.

## 2026-11-21 - post-survey barrier scan (section B only)

- **Network Rail list / live pages:** not run (B only, as planned for the survey's end).
- **Survey:** on, permanent (`survey.until: "always"`); journal shows ~20,000 survey messages per
  5 min. 176 areas sent S-Class on 20 Nov. Disk 32 GB free; all sclass/survey/barrier files present
  13-20 Nov.
- **Barrier scan:** `barrier-scan-2026-11-21.txt`, 7 days 2026-11-14..20, "7 with an all-area
  survey". Run on the Mac (logs copied to `~/rc-data/sclass-survey/`): peak memory 1.2 GB, ~29 min,
  which the VPS (952 MB total) cannot do - SKILL.md step 4 now says so.
- **Known answer passed:** BM 09 bits 6/7 (Yapton) at 158.0 cycles/day against 1,108 logged closures
  = 158.3/day over the same days. Lower than November's ~217 because Yapton's line barely ran on
  14-15 Nov (9 and 4 closures; the network-wide files those days are full size, so works, not a gap).
- **Result:** 971 candidate pairs / **632 candidate bytes in 128 areas** (12 Nov: 99 / 63 in 12).
  The 12 collected areas: 63 -> 66 bytes (EA +3, EH +1, Q5 +1, B3 -2; BU, EK, X7 swapped one at the
  5/day edge; different week and 7 not 14 days). **116 new areas** carry 566 candidate bytes; most
  bytes: G4 Motherwell 32, ZG Farncombe/Rowlands Castle 21, X2 Grove Park 17, SS Southport 17,
  T1 Newcastle 16, X3 Cannon St/Lewisham 15, C2 Cardiff 13, T2 Darlington/Durham 12, CA Cambridge 12,
  AL Alnmouth 11.
- **Noise:** 11 London areas with at most one road crossing (X0 X1 X2 X3 X8 XA XB Q0 NX Y9 VC,
  crossings per area estimated from SMART + NaPTAN) carry 81 candidate bytes - points and signals.
  Closure >= 45 s halves that (36) but does not separate; berth correlation stays the filter.
- **crossing-launch:** no Parked candidates in CANDIDATES.md, so nothing to re-check.
