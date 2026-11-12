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
