import { codepointCompare } from "../../lib/codepoint-compare.mjs";

/**
 * #920: 같은 달력(serviceId) 안에서 (노선, 역, 출발 시각, 다음 역, 종착역)이 같은 trip 묶음을 돌려준다.
 * 한 선로에서 두 열차가 같은 초에 같은 역을 같은 다음 역으로 출발할 수 없으므로, 묶음이 있으면 같은 열차를 두 번 실은 것이다.
 * 종착역이 다르면(광명행·인천행 등) 다른 열차로 본다. 빈 배열이어야 후보를 만들 수 있다.
 */
export function duplicateDepartureGroups({ transitTrips, transitStopTimes }) {
  const serviceByTrip = new Map(transitTrips.map(({ id, serviceId }) => [id, serviceId]));
  const stopsByTrip = new Map();
  for (const row of transitStopTimes) {
    if (!stopsByTrip.has(row.tripId)) stopsByTrip.set(row.tripId, []);
    stopsByTrip.get(row.tripId).push(row);
  }
  const groups = new Map();
  for (const [tripId, rows] of stopsByTrip) {
    const serviceId = serviceByTrip.get(tripId);
    if (serviceId === undefined) throw new Error(`duplicate departure check: stop_time trip is missing: ${tripId}`);
    const stops = [...rows].sort((left, right) => left.stopSequence - right.stopSequence);
    const terminalStationId = stops.at(-1).stationId;
    for (let index = 0; index < stops.length - 1; index += 1) {
      const { lineId, stationId, departureSeconds } = stops[index];
      const nextStationId = stops[index + 1].stationId;
      const key = JSON.stringify([serviceId, lineId, stationId, departureSeconds, nextStationId, terminalStationId]);
      if (!groups.has(key)) groups.set(key, { serviceId, lineId, stationId, departureSeconds, nextStationId, terminalStationId, tripIds: [] });
      groups.get(key).tripIds.push(tripId);
    }
  }
  return [...groups.values()]
    .filter(({ tripIds }) => tripIds.length > 1)
    .map((group) => ({ ...group, tripIds: group.tripIds.sort(codepointCompare) }))
    .sort((left, right) => codepointCompare(left.serviceId, right.serviceId) || codepointCompare(left.lineId, right.lineId)
      || codepointCompare(left.stationId, right.stationId) || left.departureSeconds - right.departureSeconds);
}
