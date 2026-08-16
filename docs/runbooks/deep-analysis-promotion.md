# 딥 공고 분석 운영 승격 Runbook

> 적용일: 2026-08-17
> 상태: legacy 검수 릴리스와 receipt 기반 exact 릴리스를 분리. 모든 실쓰기 별도 승인 대기
> 상세 설계: `docs/plans/2026-07-24-deep-analysis-production-rollout.md`

## 1. 원칙

- 랜딩 요청 중 LLM을 실행하지 않습니다. 검수된 결과만 `grant_criteria`와
  `grant_confirmation_questions`에 미리 발행합니다.
- 주간 사람 검수 릴리스는 `pending=0`, `conflict=0`, `collect/reconcile=100%` 전에는
  준비하지 않습니다.
- 봉인된 deep-repair 결과는 사람 검수·감사를 가장하지 않습니다. exact terminal receipt와
  실행 plan, 현재 source revision/input/attachment를 다시 결속한 별도 경로만 사용합니다.
- 실험의 누적 통계 verdict와 개별 공고의 출시 readiness는 분리합니다. 통계상
  `INVALID`여도 앞선 공고가 자동 보류되지 않고, 개별 공고의 실제 blocking issue만
  관리자 확인으로 보냅니다.
- `manifest.json`이 aggregate, shadow, dry-run, promote의 단일 입력입니다.
- aggregate는 출처별 내부 필드를 직접 해석하지 않습니다. 사람/AI 검수는 review verdict
  증거로, production/deep-repair는 sealed readiness/receipt 증거로 공통 gate interface에
  투영합니다.
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

release 준비와 승인은 추적 파일 변경이 없는 정확한 build tree에서만 실행됩니다. release
코드·패키지·빌드 입력 아래의 미추적 파일도 거부하지만, 별도 미추적 문서 때문에 build가
달라지지는 않습니다. 운영 DB에는 최신 migration이 적용되어 있어야 합니다.

## 3. 입력 경로 선택

새 릴리스는 아래 둘 중 하나의 provenance만 사용합니다.

- `human`/`audited`: 기존 주간 검수 수거 경로. 아래 collect/reconcile 게이트를 그대로
  적용하는 호환·진단 경로이며, 현재 승인·실쓰기 admission은 열지 않습니다.
- `deep_repair`: 봉인된 series의 exact grantId 집합. collect/reconcile, Kordoc, legacy
  review 파일을 요구하지 않고 terminal receipt를 직접 검증합니다.

두 경로의 플래그를 한 명령에서 섞을 수 없습니다. 자동 후보 선정은 legacy 진단 경로에만
남고, 현재 승인·실쓰기는 exact `deep_repair` release만 허용합니다. `deep_repair`는
`--series`와 `--grantIds`를 모두 명시해야 합니다.

## 4. 주간 검수 수거(legacy 호환)

검수팀 판정이 모두 끝난 뒤 운영 관리자가 실행합니다.

```bash
pnpm lab:collect -- --week=2026-W30
pnpm lab:reconcile -- --week=2026-W30
```

`pending`, `conflict`, 미수거 item, receipt 불일치가 하나라도 있으면 여기서 중단합니다.

## 5. receipt 기반 exact cohort 읽기 전용 점검

아래 명령은 release artifact나 DB 행을 만들지 않습니다. series/proposal/plan/receipt/run/
evaluator hash를 재현하고 현재 공개·접수·revision/input/attachment·중복 상태와 실제 matcher
변환 건수를 함께 출력합니다.

```bash
pnpm lab:release -- \
  --inspect \
  --series=<deep-repair-series> \
  --grantIds=<exact-grant-id-csv>
```

`candidates`, `adminReview`, `held`를 구분해 확인합니다. `adminReview`나 `held` 대상이 exact
CSV에 포함된 채로 release 준비를 시도하면 명령이 거부됩니다.

## 6. 릴리스 준비와 게이트

```bash
pnpm lab:release -- --prepare --cohort=2026-W30 --actor=<준비자>
pnpm lab:aggregate -- --release=<release-id>
ANALYSIS_LAB_ARTIFACT_HMAC_KEY=<32자-이상-secret> \
  pnpm lab:shadow -- --release=<release-id>
pnpm lab:promote -- --release=<release-id> --dry-run
```

receipt 기반 exact cohort는 사용자에게 grantId/run/revision/receipt 결속을 먼저 제시하고
release 생성 승인을 받은 뒤에만 다음 형식으로 준비합니다.

```bash
pnpm lab:release -- \
  --prepare \
  --series=<deep-repair-series> \
  --cohort=<closed-beta-cohort-name> \
  --grantIds=<exact-grant-id-csv> \
  --revision=1 \
  --actor=<준비자>
```

이 경로는 deep receipt를 criterion resolution provenance로 기록합니다. legacy AI 검수,
블라인드 감사, confirmations, Kordoc 완료로 표기하지 않습니다.

aggregate v2는 두 증거를 한 숫자로 섞지 않습니다.

- `reviewed`: 실제 review verdict가 있는 표본만 strict precision, wrong rate,
  missed-per-notice를 판정합니다.
- `sealed`: 존재하지 않는 review verdict를 `correct`로 간주하지 않습니다. 세 review 지표는
  `not_applicable`로 기록하고, 모든 plan의 readiness/receipt 계약이 완전한지를
  `sealed_evidence_acceptance` blocking gate로 판정합니다.
- coverage와 structured ratio는 `correct`가 아니라 실제 발행될 criteria를 분모·분자로
  사용합니다. promotion-ready release에서는 관찰 지표로 유지합니다.
- source hash/revision이 실제로 달라지면 drift로 artifact에 기록합니다. 파일·DB·스토리지
  읽기 실패처럼 현재 검증할 수 없는 상태는 immutable artifact를 쓰기 전에 중단합니다.

과거 audited local canary 형식은 기존 manifest를 읽고 진단하기 위한 호환 입력으로만
남깁니다. 신규 승인·실발행에는 사용하지 않습니다.

```bash
pnpm lab:release -- \
  --prepare \
  --cohort=local-canary-YYYY-MM-DD \
  --grantId=<검증할-grant-id> \
  --audited-local-canary \
  --actor=<준비자>
```

manifest의 `servingProvenance`가 `verified_local_lab`인지 확인한 뒤 아래 aggregate,
shadow, dry-run, 분리 승인, canary 승격 순서를 그대로 따릅니다. 기존 local release,
API transport, 단순 `runId`만 있는 승격 행은 랜딩 서빙 대상이 아닙니다.

확인할 값:

- 세 산출물의 `releaseId`, `manifestSha256`, `releasePlanSha256`이 동일합니다.
- aggregate v2는 `GO`, shadow와 dry-run은 `PASS`입니다.
- sealed release는 `sealed_evidence_acceptance=1`이고 review 전용 gate가
  `not_applicable`인지 확인합니다. review 수치를 0점으로 해석하지 않습니다.
- 변환 오류, 드롭, 질문 앵커 상실, baseline drift가 0입니다.
- shadow JSON의 회사 키는 `company-...` 형태이며 원문 사업자등록번호가 없습니다.

## 7. 분리 승인

준비자가 아닌 승인자가 실행합니다.

```bash
pnpm lab:release -- \
  --approve \
  --release=<release-id> \
  --actor=<승인자> \
  --confirm=<manifest-sha256-앞-12자-이상>
```

명령은 aggregate v2, shadow, dry-run의 파일 hash와 schema까지 다시 검증해
`approval.json`과 DB 원장에 기록합니다.

## 8. 카나리와 전체 승격

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

## 9. 롤백

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

## 10. 현재 중단 조건

2026-08-17 현재 `deep-v21` sequence 0~8은 exact read-only inventory를 통과했고 sequence 9는
실제 source conflict 관리자 확인 대상입니다. 아직 promotion release를 만들지 않았습니다.
release 준비·승인, `lab:promote --write`, 배포와 운영 설정 변경은 사용자의 별도 승인 전까지
실행하지 않습니다.
