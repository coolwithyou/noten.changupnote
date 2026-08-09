# 딥분석·Kordoc 분석 계층 전체 재구축 Runbook

> 최초 결정: 2026-07-31<br>
> fresh-start 범위 확정: 2026-08-08<br>
> 적용 조건: 공개 런칭 전이며 클로즈드 베타와 실제 사용자 상태가 없는 현재 환경<br>
> 목적: 품질 기준이 달랐던 과거 딥분석·빠른 작성 파생물을 폐기하고, 안정화된 로컬 구독 분석 결과만 다시 검수·승격한다.

## 1. 결정과 현재 기준선

점진적 교체는 하지 않는다. 공고·첨부 원본과 문서 preview 자산은 보존하지만, DB에서
서빙되는 딥분석 projection과 Kordoc 빠른 작성 projection은 모두 0에서 다시 발행한다.

현재 분석 계약은 다음과 같다.

- 운영 deep-analysis policy: `deep-analysis-model-policy-v25`
- 운영 deep-analysis prompt: `deep-analysis-v18`
- 로컬 lab prompt: `lab-deep-v11`
- 로컬 transport/model: `claude-cli` / `claude-opus-5`
- Kordoc roundtrip: `kordoc-application-roundtrip-v7`
- materialized field parser: `kordoc-rhwp-application-fields-v2`

2026-08-08 읽기 전용 조사에서는 운영 DB에 v25/v16 보존 조건을 충족하는 run이 0건이었다.
반면 로컬 immutable artifact에는 lab v9 + Claude 구독 모델로 완료된 공고와 Kordoc v5
결과가 있다. 이 로컬 결과는 재구축의 **입력 후보**일 뿐, DB 서빙 상태는 아니다.

따라서 이번 재구축은 `preserve_current`가 아니라 명시적인 `fresh_start` 모드를 사용한다.
`preserve_current`는 향후 현재 정책의 DB run을 보존해야 할 때만 사용한다.

## 2. 삭제·보존 경계

보존한다.

- `grants`
- `grant_attachment_archives`와 원본 HWP/HWPX/PDF
- `grant_application_surfaces`
- `document_artifacts` 중 `page_image`, `pdf`, `markdown`, `hwpx` 등 문서 preview 자산
- 사람 검수의 append-only `audit_dispatch_*` 이력
- 관리자 action 이력 자체
- 로컬 `spike-out` immutable 분석 artifact

초기화한다.

- 모든 `analysis_lab_promotion_releases/items`
- 모든 `grant_criteria`
- 모든 확인 질문·답변
- 모든 `match_state`
- 모든 랜딩 매칭 관측
- 모든 deep-analysis job/run/receipt/axis/audit/exception/worker heartbeat
- 모든 Kordoc precompute job/attempt/worker heartbeat와 비용 원장
- `document_artifacts.kind = 'field_candidates'`
- 모든 materialized `grant_document_fields`
- `fields_ready` surface의 빠른 작성 projection

`grant_document_fields`에는 초기 자동 분석뿐 아니라 `reconcile-v0` 사람이 보정한 필드도
포함될 수 있다. fresh-start에서는 활성 projection을 전부 비우되, 실행 전 DB dump와 사람
검수 원장은 보존한다. `fields_ready` surface는 page image가 있으면 `preview_ready`, 없으면
`pending`으로 되돌리고 `extraction_version`과 `confidence`를 비운다.

관리자 action과 통합공고 child가 삭제 대상 deep job을 참조하면 행을 삭제하지 않고 FK만
분리한다. R2의 `field_candidates` 객체는 DB 서빙 정본이 아니므로 이번 트랜잭션에서
삭제하지 않는다. DB 재구축 완료 후 orphan storage 정리 대상으로 별도 처리한다.

## 3. 안전장치

- Cloud Run deep worker는 `observe_only`를 유지하고, 최종 dry-run부터 write까지 main
  scheduler 실행을 잠시 멈춘다. Kordoc worker와 로컬 batch도 정지 상태여야 한다.
- 기본 명령은 dry-run이며 DB를 쓰지 않는다.
- `fresh_start`는 `--fresh-start` 플래그가 없으면 선택되지 않는다.
- write는 clean git tree, deep leased job 0건, Kordoc leased job/attempt 0건을 강제한다.
- 트랜잭션은 재구축 lock과 deep/Kordoc claim lock을 모두 획득해 새 claim을 막는다.
- mutation 대상 테이블은 일정한 이름 순서로 `SHARE ROW EXCLUSIVE` lock을 잡아 dry-run
  재검증부터 사후 count까지 enqueue·materialization·매칭 write가 끼어들지 못하게 한다.
- write 전 대상 테이블의 custom-format `pg_dump`를 만들고 `pg_restore --list`로 읽는다.
- dry-run `stateSha256` 앞 12자 이상과 실제 backup 파일이 있어야 한다.
- `lock_timeout=5s`, statement별 `120s` 제한을 사용한다.
- `TRUNCATE CASCADE`를 사용하지 않고 FK 역순으로 명시적 `DELETE`를 수행한다.
- reset 대상 append-only trigger 5개는 동일 트랜잭션 안에서만 비활성화하고 즉시
  재활성화한다. 이름·상태가 예상과 다르면 rollback한다.
- 삭제·surface reset count 또는 사후 보존 count가 하나라도 다르면 전체 rollback한다.
- 실행 receipt는 로컬 artifact와 `usage_events/deep_analysis_layer_rebuild`에 남긴다.

재구축 advisory lock 문자열은 v1 도구와 동일하게 유지한다. 구버전 도구와 v2 도구가
동시에 실행되는 것을 막기 위한 의도적인 호환 계약이다.

## 4. 실행 절차

### 4.1 워커 상태 확인

```bash
gcloud run jobs describe cunote-deep-analysis \
  --configuration=cunote-codex-dev \
  --region=asia-northeast3
```

deep worker가 `DEEP_ANALYSIS_WORKER_MODE=observe_only`인지 확인한다. observe-only 실행도
heartbeat를 추가하므로 최종 dry-run 직전에 main scheduler를 pause하고 실행 중 job이
없는지 확인한다. Kordoc worker와 로컬 batch가 실행 중이지 않은지도 ops와 로컬 분석
센터에서 확인한다. write 동안 대상 테이블의 쓰기가 잠시 대기하므로 짧은 maintenance
window에서 실행한다. 완료·rollback 뒤에는 변경 전 scheduler 상태를 명시적으로 복구한다.

### 4.2 fresh-start dry-run

```bash
TSX_TSCONFIG_PATH=apps/web/tsconfig.json node \
  --env-file-if-exists=.env \
  --env-file-if-exists=.env.local \
  --import tsx \
  apps/web/src/lib/server/deep-analysis/rebuild-analysis-layer-cli.ts \
  --fresh-start
```

출력의 다음 항목을 검토한다.

- `mode = fresh_start`
- `keepRuns = []`
- 원본 `grants`, attachment, surface, non-field artifact, page image 보존 수
- deep-analysis 삭제 수
- Kordoc job/attempt/heartbeat, field candidate, document field 삭제 수
- `fields_ready` surface reset 수
- leased deep/Kordoc 수가 모두 0
- `stateSha256`와 로컬 plan artifact 경로
- `source.gitDirty`와 `source.implementationSha256`

dry-run은 매번 현재 DB snapshot으로 새 plan을 만든다. DB가 변하면 hash도 변하고 이전
확인값으로는 write할 수 없다. dirty tree에서도 조사용 dry-run은 가능하지만
`source.gitDirty=true`가 해시에 포함되므로 그 보고서는 write 승인값으로 사용할 수 없다.
write용 최종 dry-run은 구현을 커밋하고 clean tree에서 다시 생성한다.

### 4.3 복구 dump

분석계층 대상 테이블과 FK를 분리하는 테이블을 custom format으로 저장한다. 비밀번호와
DB URL은 명령 출력이나 파일명에 남기지 않는다.

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
  --table=grant_application_precompute_jobs \
  --table=grant_application_precompute_attempts \
  --table=grant_application_precompute_worker_heartbeats \
  --table=grant_application_surfaces \
  --table=document_artifacts \
  --table=grant_document_fields \
  --dbname=<운영 DB URL>

pg_restore --list <절대경로>/before.dump
```

### 4.4 승인 후 fresh-start write

실제 삭제는 dry-run report와 dump를 사람이 확인하고 별도로 승인한 뒤에만 실행한다.

```bash
TSX_TSCONFIG_PATH=apps/web/tsconfig.json node \
  --env-file-if-exists=.env \
  --env-file-if-exists=.env.local \
  --import tsx \
  apps/web/src/lib/server/deep-analysis/rebuild-analysis-layer-cli.ts \
  --fresh-start \
  --write \
  --actor=codex-analysis-layer-rebuild \
  --backup=<절대경로>/before.dump \
  --confirm=<stateSha256 앞 12자 이상>
```

`--fresh-start`를 write에서 빼면 dry-run과 다른 mode/hash가 되므로 실행되지 않는다.

## 5. 재분석·재발행 순서

1. reset 직후 criteria, promotion, deep run, Kordoc field는 모두 0인지 확인한다.
2. 로컬 lab v9 + Claude 구독 모델 결과 중 원문·AI 검수 계약을 통과한 공고만 선택한다.
3. 같은 공고의 Kordoc v5 결과와 source SHA가 현재 첨부와 일치하는지 확인한다.
4. 카나리 1건을 deep-analysis ledger와 Kordoc materialization에 재발행한다.
5. `verify-promotion`, serving monitor, 관리자 지원서 시뮬레이션을 모두 통과시킨다.
6. 5건, 30건 순으로 확대하며 딥분석·빠른 작성의 paired completion을 확인한다.
7. 활성 모집 공고 전체를 새 기준으로 분석한 뒤에만 운영 자동화 활성화를 검토한다.

reset 직후 랜딩 매칭과 빠른 작성 결과가 0인 것은 정상이다. 검증되지 않은 구버전
criteria나 field map을 임시 복원하지 않는다.

## 6. 완료 조건

- 원본 `grants`, attachment, application surface 수가 reset 전후 동일
- non-field document artifact와 page image 수가 reset 전후 동일
- 과거 promotion/criteria/question/match/landing observation 0
- deep job/run/receipt/axis/audit/exception/heartbeat 0
- Kordoc job/attempt/heartbeat/field candidate/document field 0
- `fields_ready` surface 0
- 새 기준 카나리만 다시 materialize·승격됨
- 관리자 시뮬레이션에서 딥분석 근거와 빠른 작성 필드가 모두 즉시 표시됨
- 랜딩 호출이 새 release 공고만 반환하고 새 관측을 기록함
