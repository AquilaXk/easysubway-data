# 보안 취약점 제보 정책 (Security policy)

## 지원 범위 (Supported versions)

쉬운 지하철 프로젝트는 5개 저장소의 `main` 브랜치를 기준으로 보안 업데이트를 제공합니다.

- `AquilaXk/easysubway`
- `AquilaXk/easysubway-backend`
- `AquilaXk/easysubway-data`
- `AquilaXk/easysubway-mobile`
- `AquilaXk/easysubway-platform`

EasySubway provides security updates for the `main` branch across all five repositories listed above.

## 취약점 제보 방법 (Report a vulnerability)

보안 취약점을 발견하면 공개 Issue나 Pull Request에 등록하지 마십시오. `AquilaXk/easysubway-data` 저장소의 [GitHub Security Advisories](https://github.com/AquilaXk/easysubway-data/security/advisories/new) 비공개 제보 기능(Private Vulnerability Reporting)으로 제출해 주십시오.

제보 내용에는 다음 정보를 포함해 주십시오.

1. 영향받는 파일이나 파이프라인 경로
2. 재현 절차와 최소 검증 입력
3. 예상되는 보안 영향 범위

Do not report security vulnerabilities in public GitHub issues, pull requests, or discussions. Submit a private report through [GitHub Security Advisories](https://github.com/AquilaXk/easysubway-data/security/advisories/new) on `AquilaXk/easysubway-data`.

Include the following details in your report:

1. Affected file or pipeline path.
2. Reproduction steps with minimal verification input.
3. Expected security impact.

## 공개 채널 금지 사항 (Public disclosure rules)

공개 Issue, Pull Request, 커밋, 코멘트에는 다음 정보를 절대 게시하지 마십시오.

- 실제 인증 정보, API 키, 토큰, 서명된 URL, 비밀키
- 운영 환경이나 외부 공공 API를 대상으로 동작하는 실제 공격 페이로드
- 개인 식별 정보 및 원본 사용자 제보 데이터

Never post secrets, credentials, API keys, tokens, signed URLs, private keys, personal data, or live exploit payloads in public issues, pull requests, commits, or comments.
