# Candidate crossings — assessment log

One row per crossing ever considered, whether or not it proceeded. A rejected candidate gets
re-requested; the second assessment should cost five minutes and reach the same answer, or say
explicitly what changed.

Gates are from `SITE-SELECTION.md`:
**G1** C-Class berth data on the approach · **G2** crossing type · **G3** closure burden ·
**G4** barrier observability.

| Crossing | Road | Area | Assessed | G1 | G2 | G3 (closures/day · peak down-min) | G4 | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Portslade | Boundary Road | LA | live since 2026 | ✅ | MCB-CCTV | ~22/day (single obs — re-measure) | ❌ no S-Class in LA | **Live** | The hard case, not the template. Human observation was the only option; every timing constant traces to n=8–11 barrier taps |
| Yapton | — | BM | 2026 (data only) | ✅ | MCB-CCTV | not assessed | ✅ `L(YN)` byte 09 bit 7/6/5 | **Not launched** — instrumented only | 1,364 barrier episodes over 38 days, zero site visits. The proof that Group D calibration can be free |

## How to add a row

1. Run `SKILL.md` Stage 0, stopping at the first failed gate.
2. Fill G3 from the CIF closure-burden computation (Stage 1) — it costs nothing and is the number that
   decides whether anyone benefits.
3. Add the Code readiness result (`SKILL.md`): required code changes, or none.
4. Verdict is one of: **Live**, **Instrumented** (Stage 2 done, clock running), **Parked** (with the
   condition that would revive it), **Rejected** (with the permanent reason).
5. A **Parked** row must name what would change the answer — "if S-Class coverage extends to <area>",
   "if the timetable adds the peak Brighton services" — or it is a Rejected row pretending otherwise.
