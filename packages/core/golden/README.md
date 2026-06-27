# Core Golden Fixtures

검증용 골든셋은 `packages/core/golden/*/*.json`에 둔다. 각 파일은 실제 수집 fixture와 사람이 판정한 기대값을 분리해 기록한다.

## 공통 기준

- `goldenVer`는 파일명과 같아야 한다. 예: `kstartup-sample-v1.json` -> `kstartup-sample-v1`
- `fixture`는 워크스페이스 루트 기준 상대 경로를 사용한다.
- `asOf`는 ISO 날짜 문자열로 기록한다.
- `cases[].sourceId`는 한 파일 안에서 중복 없이 관리한다.
- 운영 품질 지표로 precision/recall을 주장하려면 문서 기준대로 50~100건 이상의 도메인 라벨 골든셋을 별도로 확장해야 한다.

## Matching

매칭 평가 골든셋은 `packages/core/golden/matching/*.json`에 둔다. 실제 수집 fixture와 회사 프로필을 기준으로 사람이 판정한 기대 eligibility를 기록한다.

- `cases[].expected`는 `eligible`, `conditional`, `ineligible` 중 하나다.
- `cases[].note`에는 사람이 왜 그렇게 판정했는지 짧게 남긴다.

## Dedup

중복 후보 평가 골든셋은 `packages/core/golden/dedup/*.json`에 둔다. 기준 공고와 비교 공고를 만들고, 같은 사업으로 묶어야 하는지 기록한다.

- `baseSourceId`는 source fixture 안의 기준 공고 `source_id`다.
- `minScore`는 후보 인정 임계값이다.
- `cases[].expected`는 `duplicate`, `non_duplicate` 중 하나다.
- `sameSourceControl`은 기본 동작에서 같은 source끼리 묶지 않는지 확인한다.

## 확장 절차

1. 수집 원본 fixture를 먼저 고정한다.
2. 사람이 기대 판정을 라벨링한다.
3. 각 검증 클래스가 모두 포함되도록 최소 커버리지를 맞춘다.
4. `pnpm verify:matching-eval` 또는 `pnpm verify:dedup`을 실행해 판정 회귀와 골든셋 자체 검사를 통과시킨다.
