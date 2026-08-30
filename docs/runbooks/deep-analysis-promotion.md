# 딥 공고 분석 운영 승격 Runbook

> 적용일: 2026-08-17
> 상태: 신규 릴리스는 receipt 기반 exact cohort만 허용. exact release 처리 범위와 실제
> `lab:promote --write` 권한을 분리
> 상세 설계: `docs/plans/2026-07-24-deep-analysis-production-rollout.md`

## 1. 원칙

- 랜딩 요청 중 LLM을 실행하지 않습니다. 검수된 결과만 `grant_criteria`와
  `grant_confirmation_questions`에 미리 발행합니다.
- 과거 사람/AI 검수·감사 산출물은 진단과 기존 manifest 읽기 호환에만 사용하고 신규
  release 입력으로 사용하지 않습니다.
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
- Gate R은 live 모델 실행 권한만 소유합니다. 이미 봉인된 receipt를 사용하는 release 처리에
  target별 실행 승인을 반복 적용하지 않습니다.
- 사용자가 exact cohort와 처리 상한을 승인하면 그 범위는 같은 grantId/run/source revision의
  실패 revision 교체에도 유지됩니다. CLI 승인자 actor 분리는 새 사용자 승인이 아닙니다.
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

## 3. 입력 경로

신규 release는 다음 두 exact receipt 경로 중 하나만 사용합니다.

- 봉인된 `deep_repair` series: `--series`와 `--grantIds`를 명시합니다.
- 정식 런치와 독립 AI 검수를 모두 마친 결과: 기여하는 모든
  `analysis-launch-receipt-v1` SHA를 `--launch-receipts`로, exact 대상은 `--grantIds`로
  명시합니다. 각 공고에서 독립 검수 결함이 없는 leaf가 정확히 하나여야 하며, formal RHWP
  필드 분석 산출물이 release bundle에 함께 봉인됩니다.

두 입력을 섞거나 자동으로 후보를 추가하지 않습니다. collect/reconcile와 legacy
review·audit·confirmations 파일은 신규 release 입력이 아닙니다.

## 4. 과거 주간 검수 진단(승격 입력 아님)

과거 검수 표본을 재현할 때만 운영 관리자가 실행합니다.

```bash
pnpm lab:collect -- --week=2026-W30
pnpm lab:reconcile -- --week=2026-W30
```

`pending`, `conflict`, 미수거 item, receipt 불일치를 조사하는 read/diagnostic 흐름입니다.
이 결과로 신규 release를 준비할 수 없습니다. 과거 표본 집계는
`pnpm lab:review:aggregate`, 섀도는 `pnpm lab:review:shadow`로 명시적으로 분리돼 있습니다.

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

정식 런치 결과는 다음처럼 점검합니다.

```bash
pnpm lab:release -- \
  --inspect \
  --launch-receipts=<launch-receipt-sha256-csv> \
  --grantIds=<exact-grant-id-csv>
```

`candidates`, `adminReview`, `held`를 구분해 확인합니다. `adminReview`나 `held` 대상이 exact
CSV에 포함된 채로 release 준비를 시도하면 명령이 거부됩니다.

`prepared` item은 아직 승격된 데이터가 아니므로 읽기 전용 readiness에서는
`promotion_duplicate`로 세지 않습니다. 다만 release 준비 시 같은 exact cohort의 이전
`prepared` revision을 다시 확인합니다. 이전 immutable aggregate/shadow/dry-run 중 하나가
실패했고 새 revision 번호가 더 큰 경우에만 다음 revision을 허용합니다. gate 미종결, 세 gate
모두 통과, 다른 exact cohort와의 부분 겹침, 승인·적용 중 상태는 모두 거부합니다. 현재
receipt admission으로 승인할 수 없는 legacy prepared 예약과 완전히 `rolled_back`된 release는
신규 exact release를 막지 않습니다.

## 6. 릴리스 준비와 게이트

receipt 기반 exact cohort는 사용자에게 grantId/run/source revision/receipt 결속과 처리 상한을
먼저 제시합니다. 사용자가 `release approve까지`처럼 범위를 승인하면 다음 준비와 세 gate,
분리 actor approve까지 한 흐름으로 진행합니다. immutable gate 실패로 상위 revision을 만들더라도
exact 결속이 같으면 새 사용자 승인을 요구하지 않습니다.

```bash
pnpm lab:release -- \
  --prepare \
  --series=<deep-repair-series> \
  --cohort=<closed-beta-cohort-name> \
  --grantIds=<exact-grant-id-csv> \
  --revision=1 \
  --actor=<준비자>
```

정식 런치 결과는 `--series` 대신 `--launch-receipts`를 사용합니다. 이 경로는 launch
manifest/grant/run과 Codex 구독 독립 검수 aggregate, 현재 source revision/input/attachment,
RHWP 필드 분석 run을 교차 검증하고 `promotion-application-precompute-v3` bundle을 생성합니다.
검수 결함, source drift, 중복 분석, 접수 마감, 필드 산출물 결속 누락 중 하나라도 있으면
release 준비 전에 중단합니다.

이 경로는 deep receipt를 criterion resolution provenance로 기록합니다. legacy AI 검수,
블라인드 감사, confirmations, Kordoc 완료로 표기하지 않습니다.

준비된 exact release의 세 게이트는 다음처럼 실행합니다.

```bash
pnpm lab:aggregate -- --release=<release-id>
ANALYSIS_LAB_ARTIFACT_HMAC_KEY=<32자-이상-secret> \
  pnpm lab:shadow -- --release=<release-id>
pnpm lab:promote -- --release=<release-id> --dry-run
```

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

과거 audited local canary manifest는 serving provenance를 읽기 위한 호환 대상으로만
남습니다. `--grantId`/`--audited-local-canary`를 이용한 신규 release 준비는 거부됩니다.
기존 local release, API transport, 단순 `runId`만 있는 승격 행은 랜딩 서빙 대상이 아닙니다.

확인할 값:

- 세 산출물의 `releaseId`, `manifestSha256`, `releasePlanSha256`이 동일합니다.
- aggregate v2는 `GO`, shadow와 dry-run은 `PASS`입니다.
- sealed release는 `sealed_evidence_acceptance=1`이고 review 전용 gate가
  `not_applicable`인지 확인합니다. review 수치를 0점으로 해석하지 않습니다.
- 변환 오류, 드롭, 질문 앵커 상실, baseline drift가 0입니다.
- shadow JSON의 회사 키는 `company-...` 형태이며 원문 사업자등록번호가 없습니다.

## 7. 원장 역할 분리 승인

준비자가 아닌 승인자가 실행합니다.

```bash
pnpm lab:release -- \
  --approve \
  --release=<release-id> \
  --actor=<승인자> \
  --confirm=<manifest-sha256-앞-12자-이상>
```

명령은 aggregate v2, shadow, dry-run의 파일 hash와 schema까지 다시 검증해
`approval.json`과 DB 원장에 기록합니다. 여기서 다른 승인자 actor는 자기 승인 방지를 위한
원장 역할 분리이며, 사용자에게 같은 release 범위를 다시 승인받는 단계가 아닙니다.

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
실제 source conflict 관리자 확인 대상입니다. 사용자가 seq 0~8 exact cohort에 대해
release approve까지 처리 범위를 승인했으므로, 같은 grantId/run/source revision을 유지하는
revision 2 준비·세 gate·원장 역할 분리 approve는 재승인 없이 이어갑니다. `lab:promote --write`,
배포와 운영 설정 변경은 이 범위에 포함되지 않습니다.
