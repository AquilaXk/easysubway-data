<!-- A등급: high-risk source, schema, data, security, artifact, publication, release, CI·contract 변경. -->

## Related issue

Related #

## Summary

- Problem:
- Outcome:

## Changes

-

## Scope

### Included

-

### Excluded

-

### Ownership / dependencies

- Accountable owner or plan:
- Required predecessor output:
- Concurrent work overlap: None

## Contract & Compatibility

- Source / API / schema contract:
- Artifact / provenance identity:
- Backward compatibility:
- Migration or cutover:

## Version impact

- [ ] no version change
- [ ] datapack release only
- [ ] route-map artifact change
- [ ] data contract change
- [ ] product gate JSON change
- [ ] CI workflow·계약 테스트 change

## Product gate impact

- [ ] release/product-gates/** 영향 없음
- [ ] 변경한 gate의 근거를 갱신했습니다.
- [ ] 검증되지 않은 지원 범위 claim을 추가하거나 확대하지 않습니다.

## Provenance impact

- [ ] source inventory·geometry provenance manifest 영향 없음
- [ ] 제공처·라이선스·갱신 시점·적용 범위를 갱신했습니다.
- [ ] 공식 source로 확인되지 않은 값을 배포 artifact에 추가하지 않습니다.

### Version decision

- datapack version:
- data contract:
- route-map artifact / product gate:
- promotion request id:

## Verification

| Check | Result / Evidence |
| --- | --- |
| Focused RED → GREEN | |
| Affected integration | |
| Required CI | |
| Live provider / release | Not required — reason: |
| Security / data integrity | Not applicable — reason: |

## Not run

- Check: None
- Reason:
- Rerun owner / condition:

## Risk

- Level: High
- Main risk:
- Failure behavior:
- Candidate / admission / publication state on failure:
- Fallback or degraded-success path introduced: No

## Rollout / Recovery

- Rollout or promotion:
- Monitoring / success signal:
- Rollback or recovery:
- Existing artifact / schema compatibility after rollback:

## Review focus

-

## Checklist

- [ ] 이슈 범위와 실제 diff가 일치합니다.
- [ ] 관련 없는 변경이나 다른 owner의 surface를 포함하지 않았습니다.
- [ ] 위험에 필요한 검증과 미실행 사유를 기록했습니다.
- [ ] 실패·호환성·promotion·recovery 동작이 명확합니다.
- [ ] current failure를 이전·stale·alternate 결과의 성공으로 바꾸지 않습니다.
- [ ] GitHub PR Review 객체가 있는지 확인했습니다. CodeRabbit status check만으로는 리뷰 완료로 보지 않습니다.
- [ ] CodeRabbit Review 객체가 없으면 지원되는 Codex CLI 폴백 Review를 단일 GitHub PR Review로 게시했습니다.
- [ ] datapack 배포 영향이 있는 경우 release workflow 상태를 확인했습니다.
