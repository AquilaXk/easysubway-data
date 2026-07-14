export function requiredUtcInstant(value, label) {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value)
    : null;
  if (!match) {
    throw new Error(`${label} must be an RFC 3339 UTC timestamp`);
  }
  const millis = Date.parse(value);
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] ?? "").padEnd(3, "0")}Z`;
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== normalized) {
    throw new Error(`${label} must be an RFC 3339 UTC timestamp`);
  }
  return millis;
}
