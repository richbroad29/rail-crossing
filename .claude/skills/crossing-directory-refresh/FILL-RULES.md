# Filling road, town and county for a new or moved crossing

The rules ticket 09 of the burger-menu map used for all 1,422 rows (0 road errors and 0 county
errors in a 40-row spot-check), rewritten for the handful of rows a refresh brings. Do them per row,
by hand with these lookups. Each source is free, with no key; keep Nominatim to one request per
second with the User-Agent "railcrossing.uk dataset build" and no email.

Record the evidence for every filled row: what each source said and which rule won. A row you
could not settle goes to Rich with that evidence and an OSM map link
(`https://www.openstreetmap.org/?mlat=<lat>&mlon=<lon>#map=18/<lat>/<lon>`), and is marked
`hand_checked=yes` once he has looked.

## Position first

Network Rail's coordinate is sometimes 80-200 m from the real crossing, usually at the station.
Fetch the OSM data around it (below). If no road crosses the railway at grade within ~80 m, look for
the real crossing on satellite imagery (a rail line crossing a road) before naming anything, move
`lat`/`lon` there, and note it. Leave `nr_lat`/`nr_lon` as Network Rail's.

## Road - first match wins

Fetch once per row (POST to `https://overpass-api.de/api/interpreter`):

```
[out:json][timeout:60];
( way(around:150,LAT,LON)[highway];
  way(around:150,LAT,LON)[railway~"^(rail|light_rail|narrow_gauge)$"];
  node(around:150,LAT,LON)[railway~"^(level_crossing|crossing)$"]; );
out tags geom;
```

1. The name of a road (not footway/path/cycleway) that crosses the rail line at grade (neither is a
   bridge or tunnel) within 80 m. If it changes name at the crossing, keep both: "Station Road /
   Boundary Road".
2. The road through the nearest OSM level-crossing node within 150 m.
3. No name, but a road number (`ref`, e.g. B2194) → the number. Always also store a number in
   `road_ref`; a Welsh name goes in `road_alt_lang`.
4. Unnamed crossing road → "off X", where X is the first named road it joins within 600 m
   (`road_relation=off`). Further than that gives "off <cul-de-sac>" nonsense; use 5 instead.
5. Positively unnamed in OSM and in Nominatim → "Unnamed road" (the app never displays this; it
   shows "Crossing name, Town").

The crossing's Network Rail name is a tie-break only: about 40% of them are historic ("Eccles Road"
is on today's Station Road).

## Town

The settlement the crossing is in, else the nearest village or town within 3 km
(`town_relation=near`). Inside a big city, use the district a local would say: Portslade by Sea, not
Brighton and Hove; Acton, not Ealing. OSM `place=` nodes from Overpass give the candidates. OSM
tags many urban neighbourhoods as villages, so the nearest node alone is wrong in about a third
of cases. Pick the settlement whose built-up area contains the point, and check against the towns
of the nearest existing crossings on the same line.

## Council, ceremonial county, country

`local_authority` (the council: Brighton and Hove, Gwynedd, Highland), `ceremonial_county` (East
Sussex; Welsh preserved county; Scottish lieutenancy area) and `country`. Use Nominatim reverse
(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=LAT&lon=LON&zoom=10`) as evidence,
then the nearest existing crossings in the list. **Every value must already exist in its column,
spelled the same way.** The list's spellings follow OS Boundary-Line with "(B)", "District" and
"City of" stripped, and the English half of Welsh bilingual names.

## Name

`display_name` comes from `nr-refresh.py` (`clean-name` shows one). Check it reads naturally;
fix it by hand if not.
