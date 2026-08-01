## 관련 이슈

<!-- 타 레포 이슈는 `AquilaXk/easysubway#N` 형태로 명기. -->

close #

## 작업 배경

-

## 작업 내용

-

## 검증

- 실행한 명령과 결과:

## 검증 증거

데이터 정확성, 접근성 시설 근거, provenance, 배포 artifact 확인이 필요한 항목은 증거 첨부, 링크, 또는 로컬 evidence 경로(절대 경로·사용자명 등 환경 정보 제외, 레포 상대 경로 권장)를 적습니다. 증거가 필요 없는 항목은 사유를 적습니다.

| 항목 | 대상 artifact | 확인 방법 | 증거 | 결과 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Version impact

- [ ] no version change
- [ ] datapack release only
- [ ] route-map artifact change
- [ ] data contract change (contracts/**, contracts.lock.json)
- [ ] product gate JSON change (release/product-gates/**)
- [ ] CI workflow·계약 테스트 change

## Product gate impact

- [ ] release/product-gates/** 영향 없음
- [ ] release/product-gates/** 중 변경한 gate(현재: datapack freshness SLA, production datapack scope, mobility profile policy, train-search 제외 gate)의 근거를 갱신했다.
- [ ] 검증되지 않은 지원 범위(지역·운영기관·노선) claim을 추가하거나 확대하지 않는다.

## Provenance impact

- [ ] source inventory·geometry provenance manifest 영향 없음
- [ ] tools/datapack/source-inventory.json 또는 tools/route-map/geometry-provenance-manifest.json의 제공처·라이선스·갱신 시점·적용 범위를 갱신했다.
- [ ] 공식 source로 확인되지 않은 값을 배포 artifact에 추가하지 않는다.

## Version decision

- datapack version:
- data contract:
- route-map artifact:
- product gate:
- promotion request id:

## 리뷰어 메모

- 리뷰어가 먼저 봐야 할 지점:

## 리스크

-

## 체크리스트

- [ ] PR 본문은 이 템플릿 섹션을 삭제하지 않고 모두 채웠다.
- [ ] CI 결과를 확인했다.
- [ ] CodeRabbit 리뷰를 확인했다.
- [ ] GitHub PR Review 객체가 있는지 확인했다. CodeRabbit status check만으로는 리뷰 완료로 보지 않는다.
- [ ] CodeRabbit 실행이 불가능하거나 PR Review 객체가 없으면 폴백 리뷰를 단일 PR review로 게시했다.
- [ ] datapack 배포 영향이 있는 경우 release workflow 상태를 확인했다.
