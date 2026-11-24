# Usage counts (GoatCounter)

Dashboard: **https://richbroad29.goatcounter.com**. It counts page views on the homepage, every
crossing page and the live train map (`/map/`). The observer app is left out on purpose, so field
sessions don't inflate the numbers.

Clicks and other actions are counted as **events**. In the dashboard they appear in the same list
as pages, each name counted like a page. Type a prefix (e.g. `map-tap`) into the dashboard's
filter box to see one kind together.

All of them go through `shared/track.js`. Add a new one with `data-track="name: detail"` on the
element, or `TRACK('name: detail')` in code.

A crossing is always named the same way, so one crossing's taps add up across the site:
`Name (Road, Town) #crossing-number`, e.g. `Portslade Level Crossing (Boundary Road, Portslade by Sea) #1950`.

## The events

| Event | When it's counted |
|---|---|
| `map-tap: <crossing> (live)` / `(coming soon)` | A crossing tapped on the homepage map |
| `list-tap: <crossing>` | A crossing tapped in the Live crossings list below the homepage map |
| `search: <words>` | Something searched for (homepage or crossing-page menu): sent 2 s after typing stops, or on Enter. Lower-cased |
| `search (no results): <words>` | The same, when nothing matched. Good for spotting crossings or places people want |
| `search-tap: <crossing>` | A live crossing tapped in the homepage search results |
| `recent-tap: <crossing>` | A live crossing tapped in the homepage's Recent list |
| `nearby-tap: <crossing>` | A live crossing tapped in the homepage's Near you cards |
| `menu-tap: <crossing>` | A live crossing tapped in a crossing page's menu (search, closest or recent) |
| `search-show-on-map: homepage` | "Show on map" pressed in the homepage search results |
| `postcode-search: <district>` / `postcode-search (no results): <district>` | A UK postcode typed into a crossing search, homepage or crossing-page menu (since 2026-11-22). Only the district is counted, e.g. `cf5` for CF5 6XB, never the full postcode. `(no results)` = no such postcode, or the lookup failed. A postcode is not also counted as `search:` |
| `postcode-tap: <crossing>` | A live crossing tapped in the closest-to-a-postcode results (dropdown or cards) |
| `postcode-show-on-map: homepage` / `portslade menu` | "Show on map" pressed under a postcode's closest crossings (from a menu it opens the homepage map at that postcode) |
| `search-see-more: portslade menu` | "See more" pressed under a crossing page's menu search (it opens the homepage with the search filled in; the search is counted once, on the crossing page) |
| `train-map-search: <words>` / `train-map-search (no results): <words>` | Something searched for in the live train map's own search (train codes and stations), counted the same way as the crossing searches but kept separate from them |
| `train-map-pick: train <code>` / `station <name> (<code>)` | A result picked from the train map's search, e.g. `train-map-pick: station Brighton (BTN)` |
| `location-button: homepage` / `portslade menu` | "Show nearby" / "Find closest" pressed |
| `location-result: found` / `blocked` / `unavailable` / `unsupported` | What happened next: found you, location blocked, no fix, or the browser can't share location |
| `request: <crossing>` | A specific coming-soon crossing's request form opened |
| `request-from: <where>` | Any request-form link pressed. `<where>` is `map`, `search`, `postcode`, `recent`, `nearby`, `portslade menu` (crossing-specific, so these also send `request:`), or `homepage button` / `homepage FAQ` / `homepage footer` / `portslade page` / `portslade page footer` (the general form), or `<crossing> page` from a coming-soon crossing's own page (e.g. `keymer page`, with `request:`) |
| `add-app: <where>` | Add as app pressed: `homepage map button`, `homepage text button`, `portslade menu` |
| `add-app-shown: <what>` | What it showed: `install prompt` (the browser's own install dialog: Chrome, Edge and Samsung) or `iphone steps` / `android steps` / `other steps` (the instructions) |
| `add-app-choice: accepted` / `dismissed` | The answer to the browser's install dialog |
| `app-installed: <page>` | An install that completed, however it was started (our button or the browser's own menu). Only Chrome-family browsers report this: Android, and desktop Chrome/Edge. iPhone never does |
| `gofundme: <where>` | A GoFundMe link pressed: `homepage FAQ`, `homepage footer`, `portslade page` |
| `map-link: <where>` | A link to the live train map: `homepage footer`, `portslade page footer`, `portslade local map` (the street-map picture in About this crossing) |
| `home-link: <where>` | A link back to the homepage from a crossing page: `portslade menu`, `portslade page footer`, `portslade header` (the logo and name in the sea-blue header, since the 2026-11 rebrand; also `<slug> header` on coming-soon pages and `<county> county header` on county lists) |
| `county-link: <where>` | A link to a county's list of crossings: `homepage` (Crossings by county), `<crossing> page footer` |
| `county-tap: <county> -> <crossing>` | A crossing tapped in a county list (`/crossings/<county>/`); names are page addresses |
| `nearby-page-tap: <from> -> <to>` | A crossing tapped in a coming-soon page's Nearby crossings; names are page addresses |
| `station-tap: <crossing> -> <CRS>` | A station tapped in a crossing page's Nearby stations (opens the live train map there) |
| `menu-open: portslade page` | The burger menu opened |
| `show-more: portslade page` | Show More pressed under the upcoming closures |
| `refresh: portslade page` | The refresh button pressed |
| `feedback-form: portslade page` | Share Feedback pressed |

On a crossing page, `portslade` is that page's own name. Every crossing page is built from the same
template, so a new crossing's buttons are counted automatically, under its own name.

## Notes

- To stop your own visits being counted, open **https://railcrossing.uk/#toggle-goatcounter** once
  on each phone and browser you use (it's a GoatCounter feature; it remembers per browser).
- People with ad blockers aren't counted at all, so treat every number as a minimum.
- iPhone installs can't be counted. `add-app-shown: iphone steps` is the closest you'll get.
