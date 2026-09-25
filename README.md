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

## Current scope

Candidate data covers five metropolitan areas across South Korea: Capital Area, Gwangju, Daejeon, Daegu, and Busan. Facilities for Sangnoksu and Sadang stations in the Capital Area have completed on-site verification. Remaining lines and regions undergo automated checks before admission.

## Artifacts

The single source of truth for a DataPack is its signed manifest. Expired or unverified data is never served to riders.

## Contact

Questions about data provenance or corrections: [aquila@aquilaxk.site](mailto:aquila@aquilaxk.site)
