export function usesLocalPlaceholderHost(value) {
  try {
    let hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }
    return isLocalPlaceholderHostname(hostname) || isNonPublicIpv4(hostname) || isNonPublicIpv6(hostname);
  } catch {
    return false;
  }
}

function isLocalPlaceholderHostname(hostname) {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local");
}

function isNonPublicIpv4(hostname) {
  const octets = parseIpv4Octets(hostname);
  return octets !== null && isNonPublicIpv4Octets(octets);
}

function parseIpv4Octets(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function isNonPublicIpv4Octets(octets) {
  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function isNonPublicIpv6(hostname) {
  if (!hostname.includes(":")) {
    return false;
  }
  const mappedIpv4 = parseIpv4MappedIpv6(hostname);
  if (mappedIpv4 !== null) {
    return isNonPublicIpv4Octets(mappedIpv4);
  }
  const compatibleIpv4 = parseIpv4CompatibleIpv6(hostname);
  if (compatibleIpv4 !== null) {
    return isNonPublicIpv4Octets(compatibleIpv4);
  }
  const [first = null, second = null, third = null] = parseIpv6LeadingHextets(hostname);
  return (
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    /^fe[89ab]/.test(hostname) ||
    (first !== null && first >= 0xff00) ||
    (first === 0x0064 && second === 0xff9b && third === 0x0001) ||
    first === 0x0100 ||
    (first === 0x2001 && second !== null && second <= 0x01ff) ||
    (first === 0x2001 && second === 0x0002) ||
    (first === 0x2001 && second === 0x0db8) ||
    first === 0x2002
  );
}

function parseIpv6LeadingHextets(hostname) {
  const hextets = [];
  for (const part of hostname.split(":")) {
    if (part === "") {
      continue;
    }
    const value = Number.parseInt(part, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      return [];
    }
    hextets.push(value);
    if (hextets.length === 3) {
      break;
    }
  }
  return hextets;
}

function parseIpv4MappedIpv6(hostname) {
  if (!hostname.startsWith("::ffff:")) {
    return null;
  }
  return parseIpv6TailAsIpv4(hostname.slice("::ffff:".length));
}

function parseIpv4CompatibleIpv6(hostname) {
  if (!hostname.startsWith("::") || hostname.startsWith("::ffff:")) {
    return null;
  }
  return parseIpv6TailAsIpv4(hostname.slice(2));
}

function parseIpv6TailAsIpv4(suffix) {
  if (suffix.includes(".")) {
    return parseIpv4Octets(suffix);
  }
  const parts = suffix.split(":");
  if (parts.length !== 2) {
    return null;
  }
  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return null;
  }
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}
