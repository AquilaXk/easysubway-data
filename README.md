# EasySubway Data

### Reliable rail data, with the evidence to back it up.

EasySubway Data turns official Korean public-transport information into the production artifacts behind EasySubway. It keeps stations, lines, services, fares, route maps, and accessibility details connected to the evidence they came from.

## What it provides

- **Nationwide data packs** — Stations, lines, connections, timetables, fares, transfers, and accessibility data prepared for production use.
- **Route-map artifacts** — Deterministic station positions, line styles, and interchange layouts for a consistent map across the app.
- **Station catalogs** — Search-ready station names, aliases, codes, and line membership.
- **Server route bundles** — Topology, timetable, accessibility, and fare components used by Journey V3, including admitted ITX-Cheongchun station membership, express topology, and timetable evidence.

## Sources and provenance

The data comes from official national, regional, and rail-operator sources. The [source inventory](tools/datapack/source-inventory.json) records each source's provider, licence, coverage, fields, retrieval time, and freshness.

Every released row remains traceable to an admitted source snapshot. Route-map geometry keeps the same connection through its [geometry provenance manifest](tools/route-map/geometry-provenance-manifest.json).

## Nationwide coverage

The production scope covers EasySubway's nationwide urban-rail service. Stations, lines, route connectivity, service data, and accessibility details are included only when their required source and admission evidence are complete.

That matters most for accessible travel: EasySubway never turns missing facility or pathway evidence into a positive accessibility claim.

## Artifacts

Each release produces a map pack, a station catalog pack, and a server route bundle bound to the same station-set identity.

Current production artifacts carry their source provenance, freshness window, payload hashes, compatibility identity, release sequence, and signature. Expired, unsigned, incomplete, corrupt, or identity-mismatched artifacts are rejected. A failed release never falls back to stale, previous, local, placeholder, or legacy data as success.

## Contact

For source corrections, attribution questions, or data partnerships, email [aquila@aquilaxk.site](mailto:aquila@aquilaxk.site).
