const ITX_SERVICE_CLASS = "ITX_CHEONGCHUN";

const minimumTableKey = Object.freeze({
  networkEdges: "network_edges",
  serviceCalendars: "service_calendars",
  serviceCalendarDates: "service_calendar_dates",
  transitRoutes: "transit_routes",
  transitTrips: "transit_trips",
  transitStopTimes: "transit_stop_times",
});

function hasItxServiceClass(row) {
  return row?.serviceClass === ITX_SERVICE_CLASS;
}

function rejectUnexpectedItxReference(rows, label, removed) {
  for (const row of rows) {
    if (removed.has(row)) continue;
    if (Object.values(row).some((value) => typeof value === "string" && value.startsWith("ITX_"))) {
      throw new Error(`${label} contains an unrecognized ITX_CHEONGCHUN reference`);
    }
  }
}

function updateMinimumTableRows(pack, key) {
  const minimumKey = minimumTableKey[key];
  if (Object.hasOwn(pack.minimumTableRows ?? {}, minimumKey)) {
    pack.minimumTableRows[minimumKey] = pack[key].length;
  }
}

/**
 * Removes historical ITX-only rows from a cloned regional-materializer input.
 * This is deliberately a test projection: it never admits or rewrites production data.
 */
export function projectRegionalMaterializeFixture(input) {
  const fixture = structuredClone(input);

  for (const pack of fixture.packs ?? []) {
    const legacyEvidence = pack.routeServiceArtifactEvidence ?? [];
    if (legacyEvidence.some((row) => !hasItxServiceClass(row))) {
      throw new Error("routeServiceArtifactEvidence contains a non-ITX legacy reference");
    }
    pack.routeServiceArtifactEvidence = [];

    const removedRoutes = new Set((pack.transitRoutes ?? []).filter(hasItxServiceClass));
    rejectUnexpectedItxReference(pack.transitRoutes ?? [], "transitRoutes", removedRoutes);
    const routeIds = new Set([...removedRoutes].map(({ id }) => id));
    pack.transitRoutes = (pack.transitRoutes ?? []).filter((row) => !removedRoutes.has(row));

    const removedTrips = new Set((pack.transitTrips ?? []).filter((row) => (
      hasItxServiceClass(row) || routeIds.has(row.routeId)
    )));
    rejectUnexpectedItxReference(pack.transitTrips ?? [], "transitTrips", removedTrips);
    const tripIds = new Set([...removedTrips].map(({ id }) => id));
    const serviceIds = new Set([...removedTrips].map(({ serviceId }) => serviceId).filter(Boolean));
    pack.transitTrips = (pack.transitTrips ?? []).filter((row) => !removedTrips.has(row));

    const removedStopTimes = new Set((pack.transitStopTimes ?? []).filter(({ tripId }) => tripIds.has(tripId)));
    rejectUnexpectedItxReference(pack.transitStopTimes ?? [], "transitStopTimes", removedStopTimes);
    pack.transitStopTimes = (pack.transitStopTimes ?? []).filter((row) => !removedStopTimes.has(row));

    const removedEdges = new Set((pack.networkEdges ?? []).filter(hasItxServiceClass));
    rejectUnexpectedItxReference(pack.networkEdges ?? [], "networkEdges", removedEdges);
    pack.networkEdges = (pack.networkEdges ?? []).filter((row) => !removedEdges.has(row));

    const remainingServiceIds = new Set((pack.transitTrips ?? []).map(({ serviceId }) => serviceId).filter(Boolean));
    const removedCalendars = new Set((pack.serviceCalendars ?? []).filter(({ serviceId }) => (
      serviceIds.has(serviceId) && !remainingServiceIds.has(serviceId)
    )));
    rejectUnexpectedItxReference(pack.serviceCalendars ?? [], "serviceCalendars", removedCalendars);
    pack.serviceCalendars = (pack.serviceCalendars ?? []).filter((row) => !removedCalendars.has(row));

    const removedCalendarDates = new Set((pack.serviceCalendarDates ?? []).filter(({ serviceId }) => (
      serviceIds.has(serviceId) && !remainingServiceIds.has(serviceId)
    )));
    rejectUnexpectedItxReference(pack.serviceCalendarDates ?? [], "serviceCalendarDates", removedCalendarDates);
    pack.serviceCalendarDates = (pack.serviceCalendarDates ?? []).filter((row) => !removedCalendarDates.has(row));

    for (const key of Object.keys(minimumTableKey)) updateMinimumTableRows(pack, key);
  }

  return fixture;
}
