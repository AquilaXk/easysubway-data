# EasySubway Data

### Transit data with clear provenance, built so everyone can move freely.

EasySubway Data turns official public transit feeds into verifiable DataPacks and vector route maps. Every station, route, timetable, and barrier-free facility is tracked back to where it came from.

<br>

[ English ] | [ 🇰🇷 한국어 ](./README.ko.md)

<br>

## What we build

- **Transit DataPacks**: Station topology, route connections, timetables, and accessibility facilities bundled into a single verifiable package.
- **Route map geometry**: Maps built from verified public blueprints, keeping coordinates and geometry consistent across screens.
- **Accessibility records**: Elevators, escalators, and wheelchair lifts connected directly to station nodes with inspection records.

## Sources and provenance

We build on public data from the Ministry of Land, Infrastructure and Transport, Seoul Metropolitan Government, Seoul Metro, and Korea National Railway.

Each release includes our [source inventory](tools/datapack/source-inventory.json) recording the provider, license, collection time, and coverage for every data source. Route maps track back to original geometry through our [geometry provenance manifest](tools/route-map/geometry-provenance-manifest.json).

## Coverage

Provides nationwide Korean urban railway and metropolitan rail data covering five regions: Capital Area, Busan, Daegu, Daejeon, and Gwangju. Includes official barrier-free facility locations, accessible transfer routes, station timetables, and vector route map data.

## Artifacts

The single source of truth for a DataPack is its signed manifest. Expired or unverified data is never served to riders.

## Contact

Questions about data provenance or corrections: [aquila@aquilaxk.site](mailto:aquila@aquilaxk.site)
