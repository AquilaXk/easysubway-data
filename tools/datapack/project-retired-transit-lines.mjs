const retiredStatus = "OUT_OF_ACTIVE_SCOPE";
const retiredLifecycle = "RETIRED";

export function retiredTransitDescriptors(policy) {
  if (!Array.isArray(policy)) throw new TypeError("inactiveLineExclusions must be an array");
  const descriptors = policy.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.lineId !== "string" || entry.lineId.length === 0
      || entry.status !== retiredStatus || entry.serviceLifecycle !== retiredLifecycle
      || typeof entry.evidenceRef !== "string" || entry.evidenceRef.length === 0) {
      throw new Error("retired transit exclusion policy is invalid");
    }
    const arrays = ["operatorIds", "stationIds", "preservedStationIds"];
    if (arrays.some((key) => !Array.isArray(entry[key]) || entry[key].some((id) => typeof id !== "string" || id.length === 0)
      || new Set(entry[key]).size !== entry[key].length)) {
      throw new Error("retired transit exclusion policy identities are invalid");
    }
    if (entry.operatorIds.length === 0 || entry.stationIds.length === 0
      || entry.preservedStationIds.some((id) => !entry.stationIds.includes(id))) {
      throw new Error("retired transit exclusion policy preservation is invalid");
    }
    return structuredClone(entry);
  });
  if (new Set(descriptors.map(({ lineId }) => lineId)).size !== descriptors.length) {
    throw new Error("retired transit exclusion policy duplicates a line");
  }
  return descriptors;
}

export function retiredLineIds(policy) { return new Set(retiredTransitDescriptors(policy).map(({ lineId }) => lineId)); }

export function projectRetiredTransitLines(fixture, policy) {
  const descriptors = retiredTransitDescriptors(policy);
  const next = structuredClone(fixture);
  for (const pack of next.packs ?? []) projectPack(pack, descriptors);
  if (Array.isArray(next.coverageLineOperatorScopes)) next.coverageLineOperatorScopes = removeScopes(next.coverageLineOperatorScopes, descriptors);
  if (Array.isArray(next.providerLineScopes)) next.providerLineScopes = removeScopes(next.providerLineScopes, descriptors);
  return next;
}

export function assertNoRetiredTransitReferences(fixture, policy) {
  const descriptors = retiredTransitDescriptors(policy);
  if (references(fixture, descriptorTokens(descriptors))) {
    throw new Error("retired transit remains in production fixture");
  }
}

function projectPack(pack, descriptors) {
  for (const descriptor of descriptors) {
    if (!references(pack, descriptorTokens([descriptor]))) continue;
    validateProjectionInput(pack, descriptor);
  }
  const lineIds = new Set(descriptors.map(({ lineId }) => lineId));
  const retiredStationIds = new Set(descriptors.flatMap(({ stationIds, preservedStationIds }) =>
    stationIds.filter((id) => !preservedStationIds.includes(id))));
  pack.lines = (pack.lines ?? []).filter((line) => !lineIds.has(line.id));
  pack.stationLines = (pack.stationLines ?? []).filter((row) => !lineIds.has(row.lineId));
  pack.stations = (pack.stations ?? []).filter((station) => !retiredStationIds.has(station.id));
  const operatorIds = new Set(descriptors.flatMap(({ operatorIds }) => operatorIds));
  pack.operators = (pack.operators ?? []).filter((operator) => !operatorIds.has(operator.id)
    || pack.lines.some((line) => line.operatorId === operator.id));
  for (const [key, value] of Object.entries(pack)) {
    if (key === "sourceInventory") pack[key] = value.map((source) => projectSourceScopes(source, lineIds));
    else if (Array.isArray(value) && !["operators", "lines", "stations", "stationLines"].includes(key)) {
      pack[key] = value.filter((row) => !references(row, { lineIds, operatorIds, stationIds: retiredStationIds }));
    }
  }
  if (Array.isArray(pack.coverageLineOperatorScopes)) pack.coverageLineOperatorScopes = removeScopes(pack.coverageLineOperatorScopes, descriptors);
  if (pack.minimumTableRows && typeof pack.minimumTableRows === "object") {
    for (const [table, field] of Object.entries({ operators: "operators", lines: "lines", stations: "stations", station_lines: "stationLines", network_edges: "networkEdges", route_map_positions: "routeMapPositions" })) {
      if (Object.hasOwn(pack.minimumTableRows, table)) pack.minimumTableRows[table] = pack[field]?.length ?? 0;
    }
  }
}

function validateProjectionInput(pack, { lineId, operatorIds, stationIds, preservedStationIds }) {
  const rows = (pack.stationLines ?? []).filter((row) => row.lineId === lineId);
  if (rows.length !== stationIds.length || new Set(rows.map(({ stationId }) => stationId)).size !== stationIds.length
    || rows.some(({ stationId }) => !stationIds.includes(stationId))
    || !(pack.lines ?? []).some((line) => line.id === lineId && operatorIds.includes(line.operatorId))) {
    throw new Error("retired transit projection input identity is invalid");
  }
  if (preservedStationIds.some((stationId) => !(pack.stationLines ?? []).some((row) => row.stationId === stationId && row.lineId !== lineId))
    || stationIds.filter((stationId) => !preservedStationIds.includes(stationId))
      .some((stationId) => (pack.stationLines ?? []).some((row) => row.stationId === stationId && row.lineId !== lineId))) {
    throw new Error("retired transit station preservation identity is invalid");
  }
}

function removeScopes(scopes, descriptors) {
  const lineIds = new Set(descriptors.map(({ lineId }) => lineId));
  return scopes.filter((scope) => !lineIds.has(scope.lineId));
}

function projectSourceScopes(source, lineIds) {
  const next = structuredClone(source);
  if (Array.isArray(next.coverageLineOperatorScopes)) next.coverageLineOperatorScopes = next.coverageLineOperatorScopes.filter((scope) => !lineIds.has(scope.lineId));
  if (Array.isArray(next.coverageScope?.lineIds)) next.coverageScope.lineIds = next.coverageScope.lineIds.filter((lineId) => !lineIds.has(lineId));
  return next;
}

function descriptorTokens(descriptors) {
  return {
    lineIds: new Set(descriptors.map(({ lineId }) => lineId)),
    operatorIds: new Set(descriptors.flatMap(({ operatorIds }) => operatorIds)),
    stationIds: new Set(descriptors.flatMap(({ stationIds, preservedStationIds }) => stationIds.filter((id) => !preservedStationIds.includes(id)))),
  };
}

function references(value, { lineIds, operatorIds, stationIds }) {
  if (typeof value === "string") return lineIds.has(value) || operatorIds.has(value) || stationIds.has(value)
    || [...lineIds].some((lineId) => value.includes(`:${lineId}`)) || [...stationIds].some((stationId) => value.includes(`${stationId}:`));
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((item) => references(item, { lineIds, operatorIds, stationIds }));
}
