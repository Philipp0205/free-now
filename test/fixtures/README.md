# Test fixtures

Used only by tests. The production image never contains them: the Dockerfile copies only
`package*.json`, `tsconfig.json`, `src` (build stage), `dist` and `public`, and `.dockerignore`
excludes `test`.

## stuttgart-schlossplatz.pmtiles

A small PMTiles v3 vector basemap around Stuttgart Schlossplatz, for `test/ui/protomaps.spec.ts`.

- Source: the Protomaps Basemap 4.15.2 build of Stuttgart (`stuttgart.pmtiles`, OSM replication
  time 2026-11-08T04:00:00Z).
- Command:

  ```sh
  pmtiles extract stuttgart.pmtiles out.pmtiles --bbox=9.170,48.770,9.190,48.785 --minzoom=12
  ```

- Header: bounds `[9.17, 48.77, 9.19, 48.785]` (west, south, east, north), zoom 12–15, MVT tiles.
- Size: 1,234,788 bytes.
- sha256: `81529b83cfc25c883de2edb348b68702d7e92b1262d4c3921bf5d14c00021b7e`

Map data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0:
https://www.openstreetmap.org/copyright. Tiles built with Protomaps (https://protomaps.com).
This extract is a Derivative Database under the ODbL; it is offered under the same licence.
