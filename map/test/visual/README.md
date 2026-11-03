# Browser checks for the map page

Real Chrome, driven by Playwright, against the mock service. Not unit tests: they are not matched by
`node --test map/test/*.test.js` (use the glob, not the directory, on Node 20, which would otherwise
walk into this folder; the scripts here refuse to run under the test runner anyway).

**Run them** (from the repo root; needs Node 20+ and Google Chrome installed):

    cd map/test/visual && npm install && cd ../../..
    node map/test/visual/run.js            # everything: shots, probes, e2e, perf
    node map/test/visual/run.js shots      # or one of: shots | probes | e2e | perf
    node map/test/visual/run.js shots d-dark   # only shots whose name contains "d-dark"

It starts the mock service (1,500 national trains, port 3100) and a static server (port 8080) itself.
Screenshots go to `map/test/visual/out/` (git-ignored). Overrides: `CHROME=/path/to/chrome`,
`OUT=dir`, `TRAINS=n`, `MOCK_PORT`, `WEB_PORT`. Exit code is non-zero if a check fails or the page
logs a console error or scrolls sideways.

What each does: **shots** is the review set (phone 390x844 and desktop 1440x900, light and dark: map,
details panel, search, stale-feed banner, plus the national view); **probes** shoots a stopped train
at zoom 14, 16 and 18 and a selected moving one (look for ONE train body with a cab nose, aligned to
its heading, no overlaid shapes, no label on top of another); **e2e** checks keyboard search, deep
links, follow, share, chips, theme, reduced motion, tab order and the loopback-only `?api=`; **perf**
prints frame times at five views and again with the CPU throttled 4x.
