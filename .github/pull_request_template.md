<!--
작업 등급에 맞는 템플릿을 사용하세요.
- A등급(제품/운영 위험: 데이터 정확성, 접근성 시설 근거, 지원 범위 claim, datapack release, data contract(contracts/**, contracts.lock.json), product gate JSON(release/product-gates/**), CI workflow·계약 테스트, 서명·시크릿·무결성(manifest signing, attestation, workflow secret 취급) 변경): .github/PULL_REQUEST_TEMPLATE/full.md 내용으로 교체합니다.
- B/C등급(일반 코드 변경·낮은 위험 maintenance): .github/PULL_REQUEST_TEMPLATE/short.md 내용으로 교체합니다(아래 기본형과 동일).
- 웹 UI에서는 ?template=full.md 또는 ?template=short.md 쿼리를 쓸 수 있습니다. gh CLI는 template 쿼리를 지원하지 않으므로 템플릿 파일 내용을 body로 직접 채웁니다.
- 이 레포 소유 범위: tools/{datapack,route-map,routes,release,ci,lib}/**, contracts/**, contracts.lock.json, release/product-gates/**, .github/workflows/**.
- 리뷰 게이트(PR Review 객체 확보)는 등급과 무관하게 모든 PR 공통입니다. 이 레포에는 automerge 큐 코디네이터가 없으므로 병합은 리뷰 게이트 충족 후 수동으로 처리합니다.
-->

## 관련 이슈

<!-- 단일 PR은 `Closes #N`, 스택 중간/umbrella는 `Refs #N`, C등급 issue 생략 시 `이슈 없음(C등급)` 명기. 타 레포 이슈는 `AquilaXk/easysubway#N` 형태로 명기. 빈 칸 금지. -->

Refs #

## 작업 내용

-

## 검증

- 실행한 명령과 결과:

## 영향

- [ ] 제품/운영 위험 없음 (데이터 정확성·접근성 시설 근거·지원 범위 claim 변경 아님)
- [ ] datapack release 영향 없음
- [ ] data contract 영향 없음 (contracts/**, contracts.lock.json)
- [ ] route-map artifact·provenance manifest 영향 없음
- [ ] CI workflow·계약 테스트·product gate JSON(release/product-gates/**) 변경 없음 (있으면 full.md로 전환)

## 체크리스트

- [ ] 작업 등급에 맞는 템플릿을 사용했다.
- [ ] CI 결과를 확인했다.
- [ ] GitHub PR Review 객체가 있는지 확인했다. CodeRabbit status check만으로는 리뷰 완료로 보지 않는다.
- [ ] CodeRabbit 실행이 불가능하거나 PR Review 객체가 없으면 폴백 리뷰를 단일 PR review로 게시했다.
