#!/bin/sh
# Stamp a fresh ?v= token onto every local .js/.css reference in the HTML shells.
#
# WHY. GitHub Pages serves everything with `cache-control: max-age=600` and there is no way to
# change that (no _headers support). Without a token, a browser can hold the OLD crossing.js for
# ten minutes while fetching the NEW index.html — and the two are not interchangeable. On
# 2026-08-10 that pairing threw on a removed element id and aborted updateStatus() halfway: the
# banner kept counting down while the barrier and the cards sat frozen at their markup defaults.
# It looks alive, so nobody reports it.
#
# A token makes the pairing impossible: old HTML asks for the old URL, new HTML for the new one.
#
# The observer PWA is deliberately NOT stamped. Its service worker already fetches code with
# `cache: 'reload'`, which defeats the HTTP cache outright, and it matches its precached shell on
# the exact URL — a token would miss that cache and break the offline launch it exists for.
#
# Only src="…" / href="…" are rewritten, and the extension must be followed by the closing
# quote. Both restrictions are load-bearing. A looser pattern rewrote `fetch('shared/
# crossings.json')` in the landing page into `crossings.js?v=…on`, because [A-Za-z0-9._-]+
# happily backtracks so that ".js" matches inside ".json" — which would have broken the
# crossing list outright. Runtime fetch() strings are not asset tags; leave them alone.
#
# shared/crossings.json is deliberately unstamped: it is fetched by crossing.js at runtime, and
# a stale config paired with new code is a values mismatch, not the structural one above.
#
# Usage:  sh scripts/bump-assets.sh [token]      (default: UTC yyyymmddHHMM)
set -e
cd "$(dirname "$0")/.."
TOKEN=${1:-$(date -u +%Y%m%d%H%M)}
FILES="index.html portslade/index.html"

perl -pi -e "s{((?:src|href)=\")((?:\.\./)*shared/[A-Za-z0-9._-]+\.(?:js|css))(?:\?v=[^\"]*)?\"}{\$1\$2?v=$TOKEN\"}g" $FILES

echo "asset token -> $TOKEN"
grep -hoE '(src|href)="(\.\./)*shared/[A-Za-z0-9._-]+\.(js|css)\?v=[0-9]+"' $FILES | sort -u
