import { createHash } from "node:crypto";

export const CURRENT_MOLIT_FULL_ROUTE_ROW_COUNT = 1103;
export const CURRENT_SEOUL_PUBLIC_POSITION_COUNT = 276;

const MOLIT_REGION_COUNTS = Object.freeze({ "01": 802, "02": 158, "03": 101, "04": 20, "05": 22 });
const MOLIT_OPERATOR_COUNTS = Object.freeze({
  "공항철도주식회사": 14, "광주교통공사": 20, "구리도시공사": 3, "김포골드라인운영주식회사": 10,
  "남서울경전철주식회사": 11, "남양주도시공사": 5, "네오트랜스주식회사": 16, "대구교통공사": 94,
  "대전교통공사": 22, "부산교통공사": 114, "부산김해경전철주식회사": 21, "서울교통공사": 277,
  "서울시메트로9호선주식회사": 38, "서해철도주식회사": 12, "용인경량전철주식회사": 15,
  "우이신설경전철주식회사": 13, "의정부경량전철주식회사": 15, "인천교통공사": 68,
  "인천국제공항공사": 6, "주식회사 SR": 1, "지티엑스에이운영": 8, "코레일": 320,
});
const POSITION_LINE_COUNTS = Object.freeze({ "1": 10, "2": 51, "3": 34, "4": 26, "5": 56, "6": 39, "7": 42, "8": 18 });
const POSITION_MEMBERSHIP_SHA256 = "56ae4255e20e947030dd27cc480dca770d710f57b8067782a57f0fa39f6b4521";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const counts = (records, field) => Object.fromEntries(
  [...new Set(records.map((record) => record[field]))].sort().map((key) => [key, records.filter((record) => record[field] === key).length]),
);
const positionKey = ({ line, stationCode, stationName }) => `${line}:${stationCode}:${stationName}`;
const membershipSha = (records) => sha(JSON.stringify(
  records.map(positionKey).sort((left, right) => left.localeCompare(right, "en")),
));

export function assertCurrentMolitFullRouteCompleteness(records) {
  if (!Array.isArray(records)
    || records.length !== CURRENT_MOLIT_FULL_ROUTE_ROW_COUNT
    || JSON.stringify(counts(records, "region_code")) !== JSON.stringify(MOLIT_REGION_COUNTS)
    || JSON.stringify(counts(records, "operator_name")) !== JSON.stringify(MOLIT_OPERATOR_COUNTS)) {
    throw new Error("STATIC_NETWORK_SUCCESSOR_MOLIT_SCOPE");
  }
  return records;
}

export function assertCurrentSeoulPositionProjectionCompleteness(records) {
  if (!Array.isArray(records)
    || records.length !== CURRENT_SEOUL_PUBLIC_POSITION_COUNT
    || JSON.stringify(counts(records, "line")) !== JSON.stringify(POSITION_LINE_COUNTS)
    || membershipSha(records) !== POSITION_MEMBERSHIP_SHA256) {
    throw new Error("STATIC_NETWORK_SUCCESSOR_SEOUL_POSITIONS_SCOPE");
  }
  return records;
}

export function normalizeCurrentSeoulPositionCompleteness(records) {
  return assertCurrentSeoulPositionProjectionCompleteness(records);
}
