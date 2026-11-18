#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, values) =>
  value.startsWith("--") ? [[value.slice(2), values[index + 1]]] : [],
));

if (!args.fixture) {
  console.error("usage: build-headway-report.mjs --fixture <catalog-fixture.json> [--output <report.json>]");
  process.exit(1);
}

try {
  const fixture = JSON.parse(await readFile(args.fixture, "utf8"));
  const packs = (fixture.packs ?? []).map(headwaysForPack);
  const report = {
    schemaVersion: 1,
    artifactKind: "datapack-headway-report",
    summary: {
      packCount: packs.length,
      observedHeadwayGroupCount: packs.reduce((count, pack) => count + pack.observedHeadways.length, 0),
      declaredFrequencyCount: packs.reduce((count, pack) => count + pack.declaredFrequencies.length, 0),
    },
    packs,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    await mkdir(path.dirname(args.output), { recursive: true });
    await writeFile(args.output, json);
  } else {
    process.stdout.write(json);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function headwaysForPack(pack) {
  const routesById = new Map((pack.transitRoutes ?? []).map((route) => [route.id, route]));
  const tripsById = new Map((pack.transitTrips ?? []).map((trip) => [trip.id, trip]));
  const frequencyTripIds = new Set((pack.transitFrequencies ?? []).map((frequency) => frequency.tripId));
  const departuresByGroup = new Map();

  for (const stopTime of pack.transitStopTimes ?? []) {
    if (stopTime.pickupType === 1 || frequencyTripIds.has(stopTime.tripId)) {
      continue;
    }
    const trip = tripsById.get(stopTime.tripId);
    const route = trip ? routesById.get(trip.routeId) : undefined;
    if (!trip || !route) {
      continue;
    }
    const servicePattern = trip.servicePattern ?? "LOCAL";
    const key = [
      route.lineId,
      trip.serviceId,
      trip.directionId,
      servicePattern,
      stopTime.stationId,
      stopTime.lineId,
    ].join("|");
    if (!departuresByGroup.has(key)) {
      departuresByGroup.set(key, {
        lineId: route.lineId,
        serviceId: trip.serviceId,
        directionId: trip.directionId,
        servicePattern,
        stationId: stopTime.stationId,
        stationLineId: stopTime.lineId,
        departures: [],
      });
    }
    departuresByGroup.get(key).departures.push(stopTime.departureSeconds);
  }

  const observedHeadways = [...departuresByGroup.values()]
    .map((group) => {
      const departures = [...new Set(group.departures)].sort((left, right) => left - right);
      const gaps = departures.slice(1).map((departure, index) => departure - departures[index]);
      return {
        ...group,
        departures,
        minHeadwaySeconds: gaps.length ? Math.min(...gaps) : null,
        maxHeadwaySeconds: gaps.length ? Math.max(...gaps) : null,
      };
    })
    .filter((group) => group.departures.length >= 2);

  return {
    id: pack.id,
    version: pack.version,
    observedHeadways,
    declaredFrequencies: (pack.transitFrequencies ?? []).map((frequency) => ({
      tripId: frequency.tripId,
      startTimeSeconds: frequency.startTimeSeconds,
      endTimeSeconds: frequency.endTimeSeconds,
      headwaySeconds: frequency.headwaySeconds,
      exactTimes: frequency.exactTimes === true,
    })),
  };
}
