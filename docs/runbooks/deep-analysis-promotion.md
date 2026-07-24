# 딥 공고 분석 운영 승격 Runbook

> 적용일: 2026-07-25  
> 상태: 코드·마이그레이션 준비 완료, W30 검수 수거 대기  
> 상세 설계: `docs/plans/2026-07-24-deep-analysis-production-rollout.md`

## 1. 원칙

- 랜딩 요청 중 LLM을 실행하지 않습니다. 검수된 결과만 `grant_criteria`와
  `grant_confirmation_questions`에 미리 발행합니다.
- W30 초기 릴리스는 `pending=0`, `conflict=0`, `collect/reconcile=100%` 전에는 준비하지
  않습니다.
- `manifest.json`이 aggregate, shadow, dry-run, promote의 단일 입력입니다.
- 준비자, 승인자, 실행자는 식별 가능한 서로 다른 담당자로 기록합니다.
- 실발행은 manifest hash 앞 12자 이상을 직접 확인한 경우에만 허용합니다.
- 사업자등록번호와 회사 원문 식별자는 릴리스 JSON·로그에 남기지 않습니다.

## 2. 사전 점검

```bash
git status --short
pnpm typecheck
pnpm verify:db-migrations
pnpm db:doctor
```

release 준비와 승인은 clean git tree에서만 실행됩니다. 운영 DB에는 최신 migration이
적용되어 있어야 합니다.

## 3. 검수 수거

검수팀 판정이 모두 끝난 뒤 운영 관리자가 실행합니다.

```bash
pnpm lab:collect -- --week=2026-W30
pnpm lab:reconcile -- --week=2026-W30
```

`pending`, `conflict`, 미수거 item, receipt 불일치가 하나라도 있으면 여기서 중단합니다.

## 4. 릴리스 준비와 게이트

```bash
pnpm lab:release -- --prepare --cohort=2026-W30 --actor=<준비자>
pnpm lab:aggregate -- --release=<release-id>
ANALYSIS_LAB_ARTIFACT_HMAC_KEY=<32자-이상-secret> \
  pnpm lab:shadow -- --release=<release-id>
pnpm lab:promote -- --release=<release-id> --dry-run
```

확인할 값:

- 세 산출물의 `releaseId`, `manifestSha256`, `releasePlanSha256`이 동일합니다.
- aggregate는 `GO`, shadow와 dry-run은 `PASS`입니다.
- 변환 오류, 드롭, 질문 앵커 상실, baseline drift가 0입니다.
- shadow JSON의 회사 키는 `company-...` 형태이며 원문 사업자등록번호가 없습니다.

## 5. 분리 승인

준비자가 아닌 승인자가 실행합니다.

```bash
pnpm lab:release -- \
  --approve \
  --release=<release-id> \
  --actor=<승인자> \
  --confirm=<manifest-sha256-앞-12자-이상>
```

명령은 aggregate, shadow, dry-run의 파일 hash와 schema까지 다시 검증해
`approval.json`과 DB 원장에 기록합니다.

## 6. 카나리와 전체 승격

승인자가 아닌 실행 담당자가 실행합니다.

```bash
pnpm lab:promote -- \
  --release=<release-id> \
  --grantId=<manifest-canary-grant-id> \
  --write \
  --actor=<실행자> \
  --confirm=<manifest-sha256-앞-12자-이상>

pnpm lab:verify-promotion -- --release=<release-id> --scope=canary
```

카나리 검증 후 실제 랜딩에서 다음을 확인합니다.

1. 사업자등록번호로 매칭 결과를 조회합니다.
2. 카나리 공고의 판정, 근거, 확인 질문 수를 확인합니다.
3. `확인하기`를 누르면 회사 저장·로그인 후 같은 공고 질문이 자동으로 열리는지 확인합니다.
4. 비결격/결격 답변이 카드와 owned dashboard에 즉시 반영되는지 확인합니다.
5. 대상 밖 공고와 응답시간·오류율에 회귀가 없는지 확인합니다.

통과한 같은 release만 전체 적용합니다.

```bash
pnpm lab:promote -- \
  --release=<release-id> \
  --write \
  --actor=<실행자> \
  --confirm=<manifest-sha256-앞-12자-이상>

pnpm lab:verify-promotion -- --release=<release-id> --scope=all
```

## 7. 롤백

현재 DB가 release의 after hash와 다르면 롤백도 거부됩니다. 먼저 dry-run을 실행합니다.

```bash
pnpm lab:rollback -- --release=<release-id>
pnpm lab:rollback -- \
  --release=<release-id> \
  --write \
  --actor=<롤백-담당자> \
  --confirm=<manifest-sha256-앞-12자-이상>
```

롤백은 기존 criterion ID와 질문 활성 상태를 복원하고 `match_state`를 무효화합니다. 기존
사용자 답변은 삭제하거나 새 질문 의미로 재연결하지 않습니다.

## 8. 현재 중단 조건

2026-07-25 확인 기준 W30은 `decided 42`, `pending 12`, `conflict 12`, `collected 0`입니다.
따라서 지금 허용되는 작업은 코드 배포와 additive migration까지이며, release 준비·승인·카나리
및 전체 criteria 승격은 검수 수거 완료 전까지 실행하지 않습니다.
