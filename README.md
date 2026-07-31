# EasySubway Data

### 더 쉽게 이동할 수 있도록, 근거가 남는 도시철도 데이터.

EasySubway Data는 공식 대중교통 정보를 정리해 데이터팩과 노선도 artifact로 제공합니다. 역·노선·운행 정보와 이동약자 시설 정보를, 출처를 추적할 수 있는 형태로 다룹니다.

## 제공하는 것

- **도시철도 데이터팩** — 역, 노선, 연결, 시간표, 시설 정보를 하나의 배포 artifact로 묶습니다.
- **노선도 artifact** — 공식 노선도에서 확인한 위치·표기 근거를 보존해, 화면에서 일관된 노선도 표현을 만들 수 있게 합니다.
- **접근성 데이터** — 엘리베이터, 에스컬레이터, 휠체어 리프트처럼 이동에 직접 필요한 시설 정보를 근거와 함께 연결합니다.

## 출처와 provenance

데이터팩은 국토교통부, 서울특별시, 서울교통공사, 국가철도공단 등 공식 제공처의 데이터를 사용합니다. 각 배포 artifact에는 원천 데이터의 제공처·라이선스·갱신 시점·적용 범위를 담은 [source inventory](tools/datapack/source-inventory.json)가 포함되며, 노선도는 별도의 [geometry provenance manifest](tools/route-map/geometry-provenance-manifest.json)로 원본 도형과 생성 결과의 연결을 확인할 수 있습니다.

## 현재 범위

현재 검증된 접근성 지원 범위는 **수도권 4호선 상록수·사당역**의 엘리베이터·에스컬레이터·휠체어 리프트 정보입니다. 다른 지역·운영기관·노선은 원천 데이터 또는 artifact에 포함될 수 있어도, 같은 수준으로 검증된 지원 범위라고 표현하지 않습니다.

## Artifact

데이터팩의 정본은 서명된 manifest입니다. 현재 production manifest는 2026-07-30에 만료되었으며, 새 검증본을 게시할 준비를 하고 있습니다. 따라서 이 README에서는 현재 사용 가능한 데이터팩 다운로드를 안내하지 않습니다.

## 문의

데이터 출처·정정·협업 문의는 [aquila@aquilaxk.site](mailto:aquila@aquilaxk.site)로 남겨 주세요.
