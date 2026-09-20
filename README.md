# EasySubway Data

### Transit data with clear provenance, built so everyone can move freely.

EasySubway Data turns official public transit feeds into verifiable DataPacks and vector route maps. Every station, route, timetable, and barrier-free facility is tracked back to where it came from.

<details>
<summary><b>🇰🇷 한국어 설명 보기 (Switch to Korean)</b></summary>
<br>

### 더 쉽게 이동할 수 있도록, 근거가 남는 도시철도 데이터.

EasySubway Data는 공식 대중교통 정보를 정리해 데이터팩과 노선도 artifact로 제공합니다. 역, 노선, 운행 정보와 이동약자 시설 정보를, 출처를 추적할 수 있는 형태로 다룹니다.

#### 제공하는 것
- **도시철도 데이터팩**: 역, 노선, 연결, 시간표, 시설 정보를 하나의 배포 artifact로 묶습니다.
- **노선도 artifact**: 공식 노선도에서 확인한 위치와 표기 근거를 보존해, 화면에서 일관된 노선도 표현을 만듭니다.
- **접근성 데이터**: 엘리베이터, 에스컬레이터, 휠체어 리프트처럼 이동에 직접 필요한 시설 정보를 근거와 함께 연결합니다.

#### 출처와 provenance
데이터팩은 국토교통부, 서울특별시, 서울교통공사, 국가철도공단 등 공식 제공처의 데이터를 사용합니다.

각 배포 artifact에는 원천 데이터의 제공처, 라이선스, 갱신 시점, 적용 범위를 담은 [source inventory](tools/datapack/source-inventory.json)가 포함됩니다. 노선도는 별도의 [geometry provenance manifest](tools/route-map/geometry-provenance-manifest.json)로 원본 도형과 생성 결과의 연결을 확인합니다.

#### 현재 범위
수도권, 광주, 대전, 대구, 부산 5개 도시철도 권역을 대상으로 후보 데이터팩을 구성하고 있습니다. 현재 현장 검증을 마친 접근성 범위는 수도권 4호선 상록수역과 사당역의 승강기 시설이며, 나머지 권역은 검증 절차를 거치며 차례대로 반영하고 있습니다.

#### Artifact
데이터팩의 정본은 서명된 manifest입니다. 오래되거나 검증되지 않은 데이터는 승객에게 전달하지 않습니다.

<br>
</details>

## What we build

- **Transit DataPacks**: Station topology, route connections, timetables, and accessibility facilities bundled into a single verifiable package.
- **Route map geometry**: Maps built from verified public blueprints, keeping coordinates and geometry consistent across screens.
- **Accessibility records**: Elevators, escalators, and wheelchair lifts connected directly to station nodes with inspection records.

## Sources and provenance

We build on public data from the Ministry of Land, Infrastructure and Transport, Seoul Metropolitan Government, Seoul Metro, and Korea National Railway.

Each release includes our [source inventory](tools/datapack/source-inventory.json) recording the provider, license, collection time, and coverage for every data source. Route maps track back to original geometry through our [geometry provenance manifest](tools/route-map/geometry-provenance-manifest.json).

## Current scope

Candidate data covers five metropolitan areas across South Korea: Capital Area, Gwangju, Daejeon, Daegu, and Busan. Facilities for Sangnoksu and Sadang stations in the Capital Area have completed on-site verification. Remaining lines and regions undergo automated checks before admission.

## Artifacts

The single source of truth for a DataPack is its signed manifest. Expired or unverified data is never served to riders.

## Contact

Questions about data provenance or corrections: [aquila@aquilaxk.site](mailto:aquila@aquilaxk.site)
