PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;

CREATE TABLE catalog_metadata (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER
);

CREATE TABLE operators (
  id TEXT NOT NULL PRIMARY KEY,
  name_ko TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT ''
);

CREATE TABLE lines (
  id TEXT NOT NULL PRIMARY KEY,
  operator_id TEXT NOT NULL,
  name_ko TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (operator_id) REFERENCES operators(id)
);

CREATE TABLE stations (
  id TEXT NOT NULL PRIMARY KEY,
  name_ko TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  normalized_name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  latitude REAL,
  longitude REAL,
  data_quality_level TEXT NOT NULL DEFAULT 'LEVEL_1',
  data_source_type TEXT NOT NULL DEFAULT 'OFFICIAL_FILE',
  last_verified_at INTEGER
);

CREATE TABLE station_aliases (
  station_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  FOREIGN KEY (station_id) REFERENCES stations(id)
);

CREATE TABLE station_lines (
  station_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  station_code TEXT NOT NULL DEFAULT '',
  line_sequence INTEGER NOT NULL,
  platform_info TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (station_id, line_id),
  FOREIGN KEY (station_id) REFERENCES stations(id),
  FOREIGN KEY (line_id) REFERENCES lines(id)
);

CREATE TABLE network_edges (
  id TEXT NOT NULL PRIMARY KEY,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  edge_type TEXT NOT NULL DEFAULT 'WALK',
  service_pattern TEXT NOT NULL DEFAULT '',
  includes_stairs INTEGER NOT NULL DEFAULT 0,
  accessibility_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  reliability_score INTEGER NOT NULL DEFAULT 100,
  last_verified_at INTEGER
);

CREATE TABLE station_exits (
  id TEXT NOT NULL PRIMARY KEY,
  station_id TEXT NOT NULL,
  exit_number TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (station_id) REFERENCES stations(id)
);

CREATE TABLE facilities (
  id TEXT NOT NULL PRIMARY KEY,
  station_id TEXT NOT NULL,
  exit_id TEXT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NORMAL',
  floor_from TEXT NOT NULL DEFAULT '',
  floor_to TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (station_id) REFERENCES stations(id),
  FOREIGN KEY (exit_id) REFERENCES station_exits(id)
);

CREATE TABLE station_accessibility_summaries (
  station_id TEXT NOT NULL PRIMARY KEY,
  summary TEXT NOT NULL,
  warning TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (station_id) REFERENCES stations(id)
);

CREATE TABLE internal_route_nodes (
  id TEXT NOT NULL PRIMARY KEY,
  station_id TEXT NOT NULL,
  label TEXT NOT NULL,
  node_type TEXT NOT NULL,
  FOREIGN KEY (station_id) REFERENCES stations(id)
);

CREATE TABLE internal_route_edges (
  id TEXT NOT NULL PRIMARY KEY,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  instruction TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (from_node_id) REFERENCES internal_route_nodes(id),
  FOREIGN KEY (to_node_id) REFERENCES internal_route_nodes(id)
);

CREATE TABLE data_quality_records (
  id TEXT NOT NULL PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  quality_level TEXT NOT NULL,
  checked_at INTEGER
);

CREATE INDEX idx_stations_normalized_name ON stations(normalized_name);
CREATE INDEX idx_station_lines_line_sequence ON station_lines(line_id, line_sequence);
CREATE INDEX idx_network_edges_from_node ON network_edges(from_node_id);
CREATE INDEX idx_facilities_station ON facilities(station_id);
CREATE INDEX idx_internal_route_edges_from ON internal_route_edges(from_node_id);
