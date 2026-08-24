import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";
import {
  MOLIT_URL, SEOUL_POSITIONS_URL, projectMolit, projectPositions,
} from "./collect-current-static-network-successors.mjs";

const fail = (code) => { throw new Error(`PUBLIC_STATIC_NETWORK_V2_${code}`); };

function capturedAt(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))) fail("ARGUMENT");
  return value;
}

async function officialBytes(fetchImpl, url, { source, contentType }) {
  let response;
  try { response = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000) }); } catch { fail(`${source}_TRANSPORT`); }
  if (!response?.ok || response.status !== 200) {
    const status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? `_${response.status}` : "";
    fail(`${source}_HTTP${status}`);
  }
  if (!contentType.test(response.headers?.get("content-type") ?? "")) fail(`${source}_CONTENT_TYPE`);
  const value = Buffer.from(await response.arrayBuffer());
  if (value.length === 0 || value.length > 16 * 1024 * 1024) fail(`${source}_BODY`);
  return value;
}

// This collector is intentionally limited to the two cataloged official
// responses. It returns no legacy lineage, alternate provider, or fallback.
export async function collectPublicStaticNetworkV2({ fetchImpl = fetch, capturedAt: observedAt, serviceKey = process.env.DATA_GO_KR_SERVICE_KEY } = {}) {
  const now = capturedAt(observedAt);
  let key;
  try { key = normalizeDataGoKrServiceKey(serviceKey); } catch { fail("ARGUMENT"); }
  const positionUrl = new URL(SEOUL_POSITIONS_URL);
  positionUrl.search = new URLSearchParams({ serviceKey: key, page: "1", perPage: "1000", returnType: "JSON" }).toString();
  const [positionRawBytes, molitRawBytes] = await Promise.all([
    officialBytes(fetchImpl, positionUrl, { source: "POSITIONS", contentType: /^application\/json(?:;|$)/iu }),
    officialBytes(fetchImpl, new URL(MOLIT_URL), { source: "MOLIT", contentType: /^(?:application\/octet-stream|text\/csv)(?:;|$)/iu }),
  ]);
  try { projectPositions(positionRawBytes, now); } catch { fail("POSITIONS_SCHEMA"); }
  try { projectMolit(molitRawBytes); } catch { fail("MOLIT_SCHEMA"); }
  return { capturedAt: now, positionRawBytes, molitRawBytes };
}
