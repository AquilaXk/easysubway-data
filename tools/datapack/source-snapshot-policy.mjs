export function requiredCredentialFreeObjectUri(value, label) {
  const uri = requiredText(value, label);
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`${label} must be a credential-free object storage URI`);
  }
  if (!["s3:", "oci:"].includes(parsed.protocol)
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.hostname === ""
    || parsed.pathname === ""
    || parsed.pathname === "/"
    || uri.includes("@")) {
    throw new Error(`${label} must be a credential-free object storage URI`);
  }
  return uri;
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}
