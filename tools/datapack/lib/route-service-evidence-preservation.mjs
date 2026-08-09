const tables = ["route_service_artifact_evidence", "route_service_station_catalog_evidence"];

export function routeServiceEvidenceSnapshot(database) {
  for (const table of tables) {
    const exists = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table);
    if (exists == null) throw new Error(`bundled route service evidence table is missing: ${table}`);
    const rows = database.prepare(`SELECT * FROM ${table} ORDER BY service_class`).all();
    if (rows.length !== 1 || rows[0].service_class !== "ITX_CHEONGCHUN") {
      throw new Error(`bundled route service evidence table must contain exactly one ITX_CHEONGCHUN row: ${table}`);
    }
  }
  return JSON.stringify(tables.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY service_class`).all()));
}

export function assertRouteServiceEvidenceUnchanged(database, expected, errorMessage) {
  if (routeServiceEvidenceSnapshot(database) !== expected) throw new Error(errorMessage);
}
