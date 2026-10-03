# Portslade departures board: local server

Runs the departures board on your own computer, on live National Rail data, for the proof of
concept. The board itself is `portslade/departures-arrivals/index.html`; this folder is the
small server that holds the National Rail key (which must never be in the browser) and feeds
the page. No installs beyond Node.

```
browser ──every 20 s──▶ this server ──at most every 20 s──▶ National Rail (Rail Data Marketplace)
```

## Run it (Mac)

1. **Get a key.** On raildata.org.uk, subscribe to the free **Live Departure Board** product.
   Its page shows a **consumer key** and the **endpoint** address (it ends in
   `GetDepBoardWithDetails`). Keep both to hand.
2. **Check Node.** In Terminal: `node -v`. You need v18 or newer; if not, install the LTS
   from nodejs.org.
3. **Get the code.** In Terminal, from your `rail-crossing` folder:
   `git fetch origin` then `git checkout departures-board`
4. **Add the key.** `cp boards-server/.env.example boards-server/.env`, then
   `open -e boards-server/.env`, paste the key after `RDM_DEPARTURES_KEY=` and the endpoint
   after `RDM_DEPARTURES_URL=`, and save. This file is never committed.
5. **Start it.** `node boards-server/server.js`
6. **Open** http://localhost:8080/portslade/departures-arrivals/
7. **Stop it** with Ctrl+C in the Terminal window.

No key yet? `node boards-server/server.js --sample` runs the same board on made-up trains
(marked "SAMPLE TRAINS, NOT LIVE" on the page).

## If it doesn't work

The Terminal prints one line per refresh: either the next departure, or what went wrong
(a 404 means the endpoint address is wrong; 401/403 means the key or subscription). The last
raw reply from National Rail is saved to `boards-server/last-response.json`.

## What does what

- `server.js`: serves the page and `/api/departures`; the only thing that talks to National Rail.
- `board-data.js`: every decision the board makes (status wording, order, platform, the
  scrolling line). Moves into the VPS backend unchanged at go-live.
- `sample.js`: the made-up trains for `--sample`.
- `test/`: `node --test boards-server/test/board-data.test.js`
