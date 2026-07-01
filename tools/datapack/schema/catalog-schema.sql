PRAGMA foreign_keys = ON;
PRAGMA user_version = 10;

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

CREATE TABLE service_calendars (
  service_id TEXT NOT NULL PRIMARY KEY,
  monday INTEGER NOT NULL CHECK (monday IN (0, 1)),
  tuesday INTEGER NOT NULL CHECK (tuesday IN (0, 1)),
  wednesday INTEGER NOT NULL CHECK (wednesday IN (0, 1)),
  thursday INTEGER NOT NULL CHECK (thursday IN (0, 1)),
  friday INTEGER NOT NULL CHECK (friday IN (0, 1)),
  saturday INTEGER NOT NULL CHECK (saturday IN (0, 1)),
  sunday INTEGER NOT NULL CHECK (sunday IN (0, 1)),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  CHECK (start_date <= end_date)
);

CREATE TABLE service_calendar_dates (
  service_id TEXT NOT NULL,
  date TEXT NOT NULL,
  exception_type INTEGER NOT NULL CHECK (exception_type IN (1, 2)),
  PRIMARY KEY (service_id, date),
  FOREIGN KEY (service_id) REFERENCES service_calendars(service_id)
);

CREATE TABLE transit_routes (
  id TEXT NOT NULL PRIMARY KEY,
  line_id TEXT NOT NULL,
  route_short_name TEXT NOT NULL DEFAULT '',
  route_long_name TEXT NOT NULL DEFAULT '',
  direction_name TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  FOREIGN KEY (line_id) REFERENCES lines(id)
);

CREATE TABLE transit_trips (
  id TEXT NOT NULL PRIMARY KEY,
  route_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  trip_headsign TEXT NOT NULL DEFAULT '',
  direction_id TEXT NOT NULL DEFAULT '',
  service_pattern TEXT NOT NULL DEFAULT 'LOCAL',
  service_day_start_seconds INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (route_id) REFERENCES transit_routes(id),
  FOREIGN KEY (service_id) REFERENCES service_calendars(service_id),
  CHECK (service_pattern IN ('LOCAL', 'EXPRESS')),
  CHECK (service_day_start_seconds >= 0 AND service_day_start_seconds < 108000)
);

CREATE TABLE transit_stop_times (
  trip_id TEXT NOT NULL,
  stop_sequence INTEGER NOT NULL,
  station_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  arrival_seconds INTEGER NOT NULL,
  departure_seconds INTEGER NOT NULL,
  pickup_type INTEGER NOT NULL DEFAULT 0,
  drop_off_type INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, stop_sequence),
  FOREIGN KEY (trip_id) REFERENCES transit_trips(id),
  FOREIGN KEY (station_id, line_id) REFERENCES station_lines(station_id, line_id),
  CHECK (stop_sequence > 0),
  CHECK (arrival_seconds >= 0 AND arrival_seconds < 108000),
  CHECK (departure_seconds >= 0 AND departure_seconds < 108000),
  CHECK (arrival_seconds <= departure_seconds)
);

CREATE TABLE transit_frequencies (
  trip_id TEXT NOT NULL,
  start_time_seconds INTEGER NOT NULL,
  end_time_seconds INTEGER NOT NULL,
  headway_seconds INTEGER NOT NULL,
  exact_times INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, start_time_seconds),
  FOREIGN KEY (trip_id) REFERENCES transit_trips(id),
  CHECK (start_time_seconds >= 0 AND start_time_seconds < 108000),
  CHECK (end_time_seconds > start_time_seconds AND end_time_seconds < 108000),
  CHECK (headway_seconds > 0),
  CHECK (exact_times IN (0, 1))
);

CREATE TABLE realtime_provider_line_mappings (
  provider_id TEXT NOT NULL,
  provider_line_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  supports_arrivals INTEGER NOT NULL DEFAULT 0 CHECK (supports_arrivals IN (0, 1)),
  supports_train_positions INTEGER NOT NULL DEFAULT 0 CHECK (supports_train_positions IN (0, 1)),
  mapping_confidence TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (mapping_confidence IN ('OFFICIAL', 'MANUAL', 'HEURISTIC', 'UNKNOWN')),
  updated_at INTEGER,
  PRIMARY KEY (provider_id, provider_line_id),
  UNIQUE (provider_id, line_id),
  UNIQUE (provider_id, provider_line_id, line_id),
  FOREIGN KEY (line_id) REFERENCES lines(id)
);

CREATE TABLE realtime_provider_station_mappings (
  provider_id TEXT NOT NULL,
  provider_line_id TEXT NOT NULL,
  provider_station_id TEXT NOT NULL,
  station_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  query_name TEXT NOT NULL DEFAULT '',
  supports_arrivals INTEGER NOT NULL DEFAULT 0 CHECK (supports_arrivals IN (0, 1)),
  supports_train_positions INTEGER NOT NULL DEFAULT 0 CHECK (supports_train_positions IN (0, 1)),
  mapping_confidence TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (mapping_confidence IN ('OFFICIAL', 'MANUAL', 'HEURISTIC', 'UNKNOWN')),
  updated_at INTEGER,
  PRIMARY KEY (provider_id, provider_line_id, provider_station_id),
  UNIQUE (provider_id, line_id, station_id),
  FOREIGN KEY (provider_id, provider_line_id, line_id) REFERENCES realtime_provider_line_mappings(provider_id, provider_line_id, line_id),
  FOREIGN KEY (station_id, line_id) REFERENCES station_lines(station_id, line_id)
);

CREATE TABLE network_edges (
  id TEXT NOT NULL PRIMARY KEY,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  distance_meters INTEGER NOT NULL DEFAULT 0,
  -- Allowed by datapack validator: RIDE, IN_STATION_TRANSFER,
  -- OUT_OF_STATION_TRANSFER, ENTRY, EXIT, WALKWAY, ELEVATOR, RAMP,
  -- STAIR, ESCALATOR, FACILITY_CONNECTOR, LEGACY_TRANSFER.
  -- Mobile keeps old TRANSFER rows as inStationTransfer for saved/older packs.
  edge_type TEXT NOT NULL DEFAULT 'WALKWAY',
  service_pattern TEXT NOT NULL DEFAULT '',
  includes_stairs INTEGER NOT NULL DEFAULT 0,
  stair_access_state TEXT NOT NULL DEFAULT 'UNKNOWN',
  accessibility_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  reliability_score INTEGER NOT NULL DEFAULT 100,
  source_id TEXT NOT NULL DEFAULT '',
  source_snapshot_id TEXT NOT NULL DEFAULT '',
  provider_record_hash TEXT NOT NULL DEFAULT '',
  provenance_kind TEXT NOT NULL DEFAULT 'UNKNOWN',
  verification_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  facility_id TEXT,
  last_verified_at INTEGER,
  evidence_hash TEXT NOT NULL DEFAULT ''
);

CREATE TABLE out_of_station_transfer_links (
  id TEXT NOT NULL PRIMARY KEY,
  from_station_id TEXT NOT NULL,
  from_line_id TEXT NOT NULL,
  to_station_id TEXT NOT NULL,
  to_line_id TEXT NOT NULL,
  from_exit_id TEXT,
  to_exit_id TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  distance_meters INTEGER NOT NULL DEFAULT 0,
  bidirectional INTEGER NOT NULL DEFAULT 0 CHECK (bidirectional IN (0, 1)),
  requires_fare_exit INTEGER NOT NULL DEFAULT 1 CHECK (requires_fare_exit IN (0, 1)),
  requires_reentry INTEGER NOT NULL DEFAULT 1 CHECK (requires_reentry IN (0, 1)),
  covered_route TEXT NOT NULL DEFAULT 'UNKNOWN',
  crossing_risk TEXT NOT NULL DEFAULT 'UNKNOWN',
  slope_level INTEGER NOT NULL DEFAULT 1,
  curb_cut_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  sidewalk_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  accessibility_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  stair_access_state TEXT NOT NULL DEFAULT 'UNKNOWN',
  reliability_score INTEGER NOT NULL DEFAULT 100,
  source_id TEXT NOT NULL DEFAULT '',
  source_snapshot_id TEXT NOT NULL DEFAULT '',
  provider_record_hash TEXT NOT NULL DEFAULT '',
  provenance_kind TEXT NOT NULL DEFAULT 'UNKNOWN',
  verification_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_field_verified_at INTEGER,
  evidence_hash TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (from_station_id, from_line_id) REFERENCES station_lines(station_id, line_id),
  FOREIGN KEY (to_station_id, to_line_id) REFERENCES station_lines(station_id, line_id)
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
  status TEXT NOT NULL DEFAULT 'UNKNOWN',
  floor_from TEXT NOT NULL DEFAULT '',
  floor_to TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  source_snapshot_id TEXT NOT NULL DEFAULT '',
  provider_facility_ref TEXT NOT NULL DEFAULT '',
  provider_record_hash TEXT NOT NULL DEFAULT '',
  provenance_kind TEXT NOT NULL DEFAULT 'UNKNOWN',
  verified_at INTEGER NOT NULL DEFAULT 0,
  retrieved_at INTEGER NOT NULL DEFAULT 0,
  evidence_hash TEXT NOT NULL DEFAULT '',
  status_meaning TEXT NOT NULL DEFAULT '',
  operational_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  installation_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  confidence INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (station_id) REFERENCES stations(id),
  FOREIGN KEY (exit_id) REFERENCES station_exits(id)
);

CREATE TABLE station_facility_evidence (
  station_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  facility_type TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  provider_record_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  provenance_kind TEXT NOT NULL,
  installation_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  operational_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  status_meaning TEXT NOT NULL DEFAULT '',
  confidence INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER NOT NULL DEFAULT 0,
  retrieved_at INTEGER NOT NULL DEFAULT 0,
  strict_route_eligible INTEGER NOT NULL DEFAULT 0 CHECK (strict_route_eligible IN (0, 1)),
  strict_route_eligible_reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (station_id, line_id, facility_type),
  FOREIGN KEY (station_id, line_id) REFERENCES station_lines(station_id, line_id)
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
  edge_type TEXT NOT NULL DEFAULT 'WALK',
  distance_meters INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  includes_stairs INTEGER NOT NULL DEFAULT 0,
  requires_elevator INTEGER NOT NULL DEFAULT 0,
  requires_escalator INTEGER NOT NULL DEFAULT 0,
  slope_level INTEGER NOT NULL DEFAULT 1,
  width_level INTEGER NOT NULL DEFAULT 2,
  reliability_score INTEGER NOT NULL DEFAULT 100,
  accessibility_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  source_id TEXT NOT NULL DEFAULT '',
  source_snapshot_id TEXT NOT NULL DEFAULT '',
  provider_record_hash TEXT NOT NULL DEFAULT '',
  provenance_kind TEXT NOT NULL DEFAULT 'UNKNOWN',
  verification_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  facility_id TEXT,
  last_verified_at INTEGER NOT NULL DEFAULT 0,
  evidence_hash TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (from_node_id) REFERENCES internal_route_nodes(id),
  FOREIGN KEY (to_node_id) REFERENCES internal_route_nodes(id)
);

CREATE TABLE station_pathway_nodes (
  id TEXT NOT NULL PRIMARY KEY,
  station_id TEXT NOT NULL,
  line_id TEXT,
  node_type TEXT NOT NULL,
  label TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT '',
  legacy_internal_route_node_id TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (station_id) REFERENCES stations(id),
  FOREIGN KEY (station_id, line_id) REFERENCES station_lines(station_id, line_id)
);

CREATE TABLE station_pathway_edges (
  id TEXT NOT NULL PRIMARY KEY,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL DEFAULT 'WALK',
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  distance_meters INTEGER NOT NULL DEFAULT 0 CHECK (distance_meters >= 0),
  bidirectional INTEGER NOT NULL DEFAULT 0 CHECK (bidirectional IN (0, 1)),
  includes_stairs INTEGER NOT NULL DEFAULT 0 CHECK (includes_stairs IN (0, 1)),
  requires_elevator INTEGER NOT NULL DEFAULT 0 CHECK (requires_elevator IN (0, 1)),
  requires_escalator INTEGER NOT NULL DEFAULT 0 CHECK (requires_escalator IN (0, 1)),
  level_from TEXT NOT NULL DEFAULT '',
  level_to TEXT NOT NULL DEFAULT '',
  requires_facility_id TEXT,
  min_width_cm INTEGER,
  slope_percent REAL,
  vertical_meters REAL,
  reliability_score INTEGER NOT NULL DEFAULT 100 CHECK (reliability_score >= 0 AND reliability_score <= 100),
  accessibility_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  source_id TEXT NOT NULL DEFAULT '',
  source_snapshot_id TEXT NOT NULL DEFAULT '',
  provider_record_hash TEXT NOT NULL DEFAULT '',
  provenance_kind TEXT NOT NULL DEFAULT 'UNKNOWN',
  verification_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_verified_at INTEGER NOT NULL DEFAULT 0,
  evidence_hash TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL DEFAULT '',
  legacy_internal_route_edge_id TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (from_node_id) REFERENCES station_pathway_nodes(id),
  FOREIGN KEY (to_node_id) REFERENCES station_pathway_nodes(id),
  FOREIGN KEY (requires_facility_id) REFERENCES facilities(id)
);

CREATE TABLE transfer_rules (
  id TEXT NOT NULL PRIMARY KEY,
  from_station_id TEXT NOT NULL,
  from_line_id TEXT NOT NULL,
  to_station_id TEXT NOT NULL,
  to_line_id TEXT NOT NULL,
  transfer_type TEXT NOT NULL DEFAULT 'IN_STATION',
  min_transfer_seconds INTEGER NOT NULL DEFAULT 0 CHECK (min_transfer_seconds >= 0),
  pathway_edge_id TEXT,
  strict_step_free_pathway_edge_id TEXT,
  source_id TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  FOREIGN KEY (from_station_id, from_line_id) REFERENCES station_lines(station_id, line_id),
  FOREIGN KEY (to_station_id, to_line_id) REFERENCES station_lines(station_id, line_id),
  FOREIGN KEY (pathway_edge_id) REFERENCES station_pathway_edges(id),
  FOREIGN KEY (strict_step_free_pathway_edge_id) REFERENCES station_pathway_edges(id)
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
CREATE INDEX idx_transit_stop_times_station_line_departure ON transit_stop_times(station_id, line_id, departure_seconds);
CREATE INDEX idx_transit_stop_times_trip_sequence ON transit_stop_times(trip_id, stop_sequence);
CREATE INDEX idx_transit_trips_route_service_pattern ON transit_trips(route_id, service_id, service_pattern);
CREATE INDEX idx_realtime_provider_stations_internal ON realtime_provider_station_mappings(station_id, line_id);
CREATE INDEX idx_network_edges_from_node ON network_edges(from_node_id);
CREATE INDEX idx_out_of_station_transfer_links_from ON out_of_station_transfer_links(from_station_id, from_line_id);
CREATE INDEX idx_station_facility_evidence_station ON station_facility_evidence(station_id, line_id);

CREATE TABLE route_map_positions (
  station_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  x INTEGER NOT NULL CHECK (x >= 0),
  y INTEGER NOT NULL CHECK (y >= 0),
  label_dx INTEGER NOT NULL DEFAULT 0,
  label_dy INTEGER NOT NULL DEFAULT 0,
  label_polygon TEXT NOT NULL DEFAULT '',
  up_path TEXT NOT NULL DEFAULT '',
  down_path TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  license TEXT NOT NULL,
  license_status TEXT NOT NULL,
  commercial_use_allowed INTEGER NOT NULL DEFAULT 0 CHECK (commercial_use_allowed IN (0, 1)),
  attribution_required INTEGER NOT NULL DEFAULT 1 CHECK (attribution_required IN (0, 1)),
  reviewed_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (station_id, line_id, region),
  FOREIGN KEY (station_id, line_id) REFERENCES station_lines(station_id, line_id)
);

CREATE INDEX idx_facilities_station ON facilities(station_id);
CREATE INDEX idx_route_map_positions_region_line ON route_map_positions(region, line_id);
CREATE INDEX idx_internal_route_edges_from ON internal_route_edges(from_node_id);
CREATE INDEX idx_station_pathway_nodes_station ON station_pathway_nodes(station_id, line_id, node_type);
CREATE INDEX idx_station_pathway_edges_from ON station_pathway_edges(from_node_id);
CREATE INDEX idx_transfer_rules_from_line ON transfer_rules(from_station_id, from_line_id);
