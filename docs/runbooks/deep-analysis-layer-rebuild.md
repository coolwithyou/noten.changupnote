# 딥분석 계층 전체 재구축 Runbook

> 결정일: 2026-07-31  
> 적용 조건: 공개 런칭 전이며 클로즈드 베타와 실제 사용자 상태가 없는 현재 환경  
> 목적: 구버전 분석 파생물을 교정하지 않고 폐기한 뒤 현재 정책으로 분석·승격·서빙 계층을 다시 구성한다.

## 1. 결정

점진적 교체는 하지 않는다. 원본 공고와 첨부 자산은 보존하고, 현재 정책의 최신 통과
run만 분석 원장으로 남긴다. 모든 공개 projection은 0에서 다시 발행한다.

현재 기준선:

- model policy: `deep-analysis-model-policy-v24`
- primary prompt: `deep-analysis-v11`
- 보존 run 조건:
  - 공고별 현재 정책의 최신 job
  - job `succeeded`, run `passed`
  - `analysis_complete=passed`
  - 22축 결과 22행
  - 최신 AI 검수 `concur` 또는 현재 정책이 조건부 승격을 허용하는 `unsure`

`unsure`는 성공으로 위장하지 않는다. run과 비용·검수 원장은 보존하지만 재승격 시 기존
promotion gate가 `conditional_promotable` 여부와 확인 질문을 다시 검증한다.

## 2. 삭제·보존 경계

보존:

- `grants`
- `grant_attachment_archives`와 HWP/HWPX/PDF 원본·변환 결과
- 현재 정책의 최신 통과 `grant_deep_analysis_runs`
- 위 run의 job, S0~S14 receipt, 22축, AI audit, exception event
- 사람 검수의 append-only `audit_dispatch_*` 이력
- 관리자 action 이력 자체

초기화:

- 모든 `analysis_lab_promotion_releases/items`
- 모든 `grant_criteria`
- 모든 확인 질문·답변
- 모든 `match_state`
- 모든 랜딩 매칭 관측
- 보존 run 이외의 job/run/receipt/axis/audit/exception
- worker heartbeat

관리자 action과 통합공고 child가 삭제 대상 job을 참조하면 행을 삭제하지 않고 FK만
분리한다. 원본 공고·첨부·통합공고 구조는 절대 삭제하지 않는다. R2 분석 artifact는
서빙 정본이 아니므로 이번 DB reset에서는 삭제하지 않으며, DB 재구축 완료 후 별도
storage 정리 대상으로 둔다.

## 3. 안전장치

- Cloud Run 메인 worker가 `observe_only`인지 먼저 확인한다.
- write 전 선택 테이블의 custom-format `pg_dump`를 만들고 `pg_restore --list`로 읽는다.
- 기본 명령은 dry-run이며 DB를 쓰지 않는다.
- write는 clean git tree, leased job 0건, 보존 run 1건 이상을 강제한다.
- dry-run `stateSha256` 앞 12자 이상과 backup 파일이 있어야 한다.
- 트랜잭션 advisory lock, `lock_timeout=5s`, statement별 `120s` 제한을 사용한다.
- `TRUNCATE CASCADE`를 사용하지 않고 FK 역순으로 명시적 `DELETE`를 수행한다.
- 삭제 count 또는 사후 count가 하나라도 다르면 전체 트랜잭션을 rollback한다.
- 실행 receipt는 로컬 artifact와 `usage_events/deep_analysis_layer_rebuild`에 남긴다.

## 4. 실행

### 4.1 워커·DB 확인

```bash
gcloud run jobs describe cunote-deep-analysis \
  --configuration=cunote-codex-dev \
  --region=asia-northeast3

TSX_TSCONFIG_PATH=apps/web/tsconfig.json node \
  --env-file-if-exists=.env \
  --env-file-if-exists=.env.local \
  --import tsx \
  apps/web/src/lib/server/deep-analysis/rebuild-analysis-layer-cli.ts
```

출력의 `keepRuns`, `before`, `delete`, `preserve`, `stateSha256`를 확인한다.

### 4.2 복구 dump

분석계층 대상 테이블과 FK를 분리하는 두 테이블을 custom format으로 저장한다.
비밀번호와 DB URL은 명령 출력이나 파일명에 남기지 않는다.

```bash
pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file=<절대경로>/before.dump \
  --table=grant_deep_analysis_jobs \
  --table=grant_deep_analysis_worker_heartbeats \
  --table=grant_deep_analysis_runs \
  --table=grant_deep_analysis_stage_receipts \
  --table=grant_deep_analysis_axis_results \
  --table=grant_deep_analysis_audits \
  --table=grant_deep_analysis_exception_events \
  --table=admin_deep_analysis_actions \
  --table=analysis_lab_promotion_releases \
  --table=analysis_lab_promotion_items \
  --table=grant_criteria \
  --table=grant_confirmation_questions \
  --table=company_grant_confirmations \
  --table=match_state \
  --table=usage_events \
  --table=grant_aggregate_split_children \
  --dbname=<운영 DB URL>

pg_restore --list <절대경로>/before.dump
```

### 4.3 reset

```bash
TSX_TSCONFIG_PATH=apps/web/tsconfig.json node \
  --env-file-if-exists=.env \
  --env-file-if-exists=.env.local \
  --import tsx \
  apps/web/src/lib/server/deep-analysis/rebuild-analysis-layer-cli.ts \
  --write \
  --actor=codex-analysis-layer-rebuild \
  --backup=<절대경로>/before.dump \
  --confirm=<stateSha256 앞 12자 이상>
```

## 5. 재발행과 재분석

1. 보존 run을 기존 `deep-analysis:release`로 다시 준비한다.
2. aggregate/shadow/dry-run과 분리 역할 승인을 거친다.
3. 카나리 1건을 승격하고 `verify-promotion`·`verify-serving`을 통과시킨다.
4. 같은 release의 나머지 보존 run을 승격한다.
5. 활성 공고 input preparation을 실행해 현재 source revision과 policy로 큐를 다시 만든다.
6. worker는 한 공고·동시성 1·공고당 2달러 상한으로만 active 실행한다.
7. 새 공고마다 비용·AI 검수·승격·서빙·랜딩 결과가 ops `/pipeline`에 쌓이는지 확인한다.

reset 직후 criteria와 promotion은 0이므로 랜딩 매칭 결과도 0이 정상이다. 새 release의
serving 검증 전까지 구버전 criteria를 임시로 복원하지 않는다.

## 6. 완료 조건

- 원본 `grants`와 attachment count가 reset 전후 동일
- 과거 promotion/criteria/question/match/landing observation 0
- 보존 run/job 및 비용·AI audit count가 manifest와 동일
- 새 release만 `active/applied`
- 전체 serving monitor가 과거 drift 없이 PASS
- 랜딩 호출이 새 release 공고만 반환하고 새 관측을 기록
