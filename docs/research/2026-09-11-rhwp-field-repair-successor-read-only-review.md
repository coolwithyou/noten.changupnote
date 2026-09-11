# RHWP field repair successor 읽기 전용 검토

- 검토 범위: 기존 active 9건 release 중 exact 1건의 application field projection을 `0 → v11`로 보완하는 경로
- 검토 방식: 코드와 migration 읽기 전용. 서비스 DB 쓰기와 구현 변경은 하지 않았다.
- 보존 조건: 기존 promotion item과 release, 나머지 8건, 사용자 draft/revision/answer, 과거 artifact/receipt는 변경하지 않는다.

## 결론

이번 변경은 primary criteria를 다시 승격하는 successor보다 **기존 active/applied item을 exact parent로 묶은 application-only repair release/item**이 작고 안전하다. 기존 item의 `application_precompute_receipt`를 덮어쓰거나 새 ordinary promotion item을 `applied`로 추가하면 안 된다.

전용 repair item은 다음을 영속 결속해야 한다.

- `releaseDbId`, `parentPromotionItemId`, `grantId`
- 새 run/field artifact/source attachment SHA와 application analysis version
- surface 메타데이터와 field row 전체를 포함한 `beforeApplicationSnapshot/Sha256`, `afterApplicationSnapshot/Sha256`
- 승인 artifact, materialization receipt, 상태와 적용/rollback 시각

admission은 다음 조건을 모두 만족할 때 generic `promotion_duplicate`/`deep_analysis_duplicate`를 이 경로에서만 예외 처리한다.

1. exact parent가 유일한 `active release + applied item`이고 현재 primary snapshot이 parent `afterSha256`과 같다.
2. 대상 RHWP surface와 source attachment SHA가 새 receipt에 exact하게 결속된다.
3. 대상 application projection이 실제 0건이고 protected/manual/field-agent map이 없다.
4. 같은 parent 또는 grant에 이미 active/applied repair successor가 없다.
5. 새 artifact가 기대한 v11 projection의 exact field count와 전체 canonical content hash를 제공한다.

apply는 `grant publication lock → surface lock을 ID 순으로 획득 → full before 재검증 → field materialization → full after 검증 → repair item applied`를 한 transaction으로 수행한다. 중간 실패 시 surface/field/repair 상태가 모두 원복되어야 한다. parent item과 나머지 8건은 어떤 column도 갱신하지 않는다.

`PromotionGrantSnapshot`과 `restoreBeforeSnapshot()`은 현재 authoring guide, criteria, confirmation question, dedup만 다룬다. application surface/field를 hash하거나 복원하지 않으므로 field repair rollback에 재사용할 수 없다. application snapshot에는 최소한 surface의 `extractionStatus`, `extractionVersion`, `confidence`, source binding과 field row의 ID 및 모든 의미 column을 안정 정렬해 포함해야 한다. 기존 v1 promotion hash 형식은 바꾸지 않는다.

rollback은 repair item이 current applied repair이고 current application hash가 `afterApplicationSha256`과 같을 때만 수행한다. 새 field ID를 `grant_document_field_agent_runs`, `grant_document_field_agent_suggestions`, 또는 draft `field_answers[*].fieldId`가 참조하면 삭제 rollback은 FK 오류나 dangling answer를 만들므로 fail-closed한다. 사용자 draft를 고쳐서 rollback을 성립시키면 안 된다.

application-only repair가 제품의 자동 작성 가능 상태도 올려야 한다. 현재 match card `template_fill` 판정은 기존 promotion manifest의 `authoringReadiness`를 사용하므로, 적용된 repair receipt를 검증한 별도 readiness overlay가 없으면 field rows가 생겨도 제품 진입은 `manual_form`에 머물 수 있다.

## ordinary promotion head 대안

향후 criteria까지 successor 승격해야 한다면 grant별 current promotion head가 적합하다. exact target에만 transaction 안에서 lazy head를 만들고, head가 없는 legacy grant는 기존 유일 active/applied item을 읽는 fallback을 유지하면 다른 grant backfill은 피할 수 있다. 하지만 이 방식은 아래 모든 status 기반 consumer를 head/frontier 기준으로 바꾸어야 하므로 이번 field-only 복구에는 범위가 크다.

## status 기반 consumer 점검 목록

- `apps/web/src/lib/server/repositories/drizzle.ts`: serving item과 최신 `authoringReadiness` 선택
- `apps/web/src/lib/server/deep-analysis/servingMonitorInventory.ts`: active/applied inventory
- `apps/web/src/lib/server/productReadiness/exposure.ts`: exposure token 대상과 활성 검증
- `apps/web/src/lib/server/matches/annotateConfirmationQuestions.ts`: promotion 질문 provenance
- `apps/web/src/lib/server/analysis-lab/verify-promotion.ts`: active release item 상태와 current snapshot 검증
- `apps/web/src/lib/server/analysis-lab/promotion-rollback.ts`: applied item rollback 대상 선택
- `apps/web/src/lib/server/analysis-lab/deep-repair-promotion.ts`: grant 단위 promotion/deep run duplicate 판정
- `apps/web/src/lib/server/analysis-lab/promotion-release-cli.ts`: active release overlap 거부
- `apps/web/src/lib/server/deep-analysis/verify-serving-cli.ts`, `verify-serving-window-cli.ts`, `verify-ledger-production.ts`, `verify-cohort-cli.ts`
- `apps/web/src/lib/server/adminGrantSimulationList.ts`, `analysis-lab/ops-summary.ts`, `analysis-serving/verifiedDeepSources.ts`, `deep-analysis/aggregateSplitExposure.ts`

application-only repair는 기존 ordinary item을 그대로 두어 이 목록의 primary serving 의미를 보존한다. 새 repair를 읽어야 하는 곳은 authoring readiness overlay, repair verifier/monitor, fail-closed rollback entrypoint로 제한한다.

## 초기 격리 PostgreSQL 회귀 제안

아래는 구현 전 제안이며 rollback과 RLS 범위는 2026-09-11 최종 보정에서 대체됐다.

1. active 9건 fixture에서 exact target만 field 0건에서 기대 v11 전체 projection으로 바뀌고, parent item/release와 다른 8건의 모든 column/hash/status/timestamp가 byte-equivalent임을 확인한다.
2. 기존 target draft, field answers, document revision/head/event, profile row의 count와 hash가 apply 전후 동일함을 확인한다.
3. materialization 중간, after hash 기록 직전, receipt 기록 직전 fault injection 각각에서 DB state가 전부 before와 같음을 확인한다.
4. 같은 parent에 두 successor를 동시 적용하면 한 transaction만 성공하고 다른 하나는 parent/repair CAS conflict로 실패하며 field 중복이 없어야 한다.
5. surface writer와 동시에 실행하면 공통 surface lock으로 직렬화되고, 다른 writer가 먼저 field를 만들면 repair는 `field_count_not_zero`로 전체 거부되어야 한다. 현재 review approval bridge는 공통 surface advisory lock을 사용하지 않으므로 함께 보완해야 한다.
6. no parent, 다중 active parent, parent hash drift, source/archive SHA drift, field 1건 이상, protected map, 이미 적용된 repair, 기대 count/content 불일치는 모두 쓰기 0건으로 거부한다.
7. 동일 repair 재실행은 exact after hash에서만 no-op이고, 새 repair row나 field row를 만들지 않는다. 한 번 성공한 field projection에 새 repair를 다시 준비하는 경로는 거부한다.
8. rollback은 사용 전 exact before surface/0 fields로 돌아가고 repair만 rolled_back된다. 새 field ID를 참조하는 draft answer 또는 field-agent run을 만든 뒤에는 rollback이 전체 무변경으로 거부되어야 한다.
9. authoring readiness overlay는 유효한 applied repair에서만 `ready/template_fill`이고 prepared, failed, rolled_back, receipt/hash drift에서는 기존 parent readiness로 fail-closed한다.
10. field 행은 `(surfaceId, fieldKey)`가 중복되지 않아야 한다. 현 upsert는 앱측 select 후 insert이고 DB unique index가 없으므로, 모든 production writer의 공통 lock 계약이나 안전한 unique constraint 중 하나를 실제 race test로 증명한다.

## 초기 RLS와 권한 제안

아래는 구현 전 제안이며 기존 surface/field까지 넓히는 내용은 2026-09-11 최종 보정에서 제외됐다.

현재 promotion release/item과 application surface/field migration에는 RLS가 없고, `test:product-postgres`의 `product_test` 역할은 public 모든 table에 DML을 부여한다. 따라서 `app.current_user_id` 설정만으로 이 원장을 보호한다고 볼 수 없다.

- 새 repair ledger에는 `ENABLE/FORCE ROW LEVEL SECURITY`와 명시적 read/write 역할 경계를 둔다.
- `NOSUPERUSER NOBYPASSRLS` 사용자 역할은 repair ledger insert/update/delete, surface/field 직접 DML을 모두 거부해야 한다.
- 사용자 역할의 `app.current_user_id`를 owner/viewer/무회원으로 바꿔도 위 DML 거부가 유지되어야 한다.
- promotion 전용 writer는 exact CLI transaction만 성공해야 한다. 웹 런타임과 CLI가 같은 DB role을 쓴다면 RLS가 둘을 구분할 수 없으므로, migration 전에 실제 production role을 확인하고 전용 writer role 또는 동등한 권한 경계를 먼저 정해야 한다.
- 실패한 RLS/DML 시도 뒤 parent item, repair row, surface/field, draft가 모두 불변인지 assertion한다.

이 검토는 구현 전 설계 증거이며, 테스트 실행이나 운영 상태 검증을 뜻하지 않는다.

## 2026-09-11 최종 승인 범위 보정

위 최초 검토의 release rollback 설계와 기존 surface/field 전체 RLS 제안은 최종 구현 범위가 아니다. 이후 문서 writer의 동시성 계약을 대조한 결과, `field_answers[*].fieldId`와 revision `materialized_answers`가 JSON 내부 참조라 DB FK로 보호되지 않고 문서 저장 경로가 promotion publication lock을 공유하지 않는다는 점을 확인했다. 적용된 field repair를 삭제 복구하면 검사 직후 들어오는 문서 쓰기가 고아 field ID를 남길 수 있으므로, **서비스의 application field repair release rollback은 append-only 정책으로 전면 fail-closed하고 어떤 DB 행도 변경하지 않는다.** 이는 RHWP 작업 문서에서 사용자가 자동 입력을 되돌리는 UI Undo와 별개다. UI Undo는 document revision/answer 계약으로 계속 지원한다.

제품 serving 검증 hash는 사용자 draft의 정상 편집과 신규 초안 생성을 drift로 취급하지 않도록 surface, source archive, field projection만 포함한다. apply transaction은 별도의 full before/after snapshot hash로 기존 draft digest가 쓰기 중 바뀌지 않았음을 확인한다. 통합 회귀는 candidate artifact pointer 생성과 field materialization, repair ledger 전진이 한 transaction임을 fault trigger로 증명하고, 실패 시 세 영역 모두 원복되는지 확인한다.

권한 변경은 새 `analysis_lab_application_field_repairs` ledger의 `ENABLE/FORCE ROW LEVEL SECURITY`와 무정책 기본 거부에만 한정한다. 기존 application surface/field, promotion release/item, public 사용자 역할의 RLS나 권한은 바꾸지 않는다. 현재 production-compatible 실행 역할 `postgres`는 `rolsuper=false`, `rolbypassrls=true`로 확인되어 별도 writer role이나 광범위 policy migration 없이 승인된 CLI transaction을 수행할 수 있다. 폐기용 PostgreSQL의 `NOSUPERUSER NOBYPASSRLS` 역할은 새 ledger의 SELECT 결과를 볼 수 없고 insert/update/delete가 적용되지 않음을 검증한다.

따라서 최종 필수 release 보장은 다음과 같다.

1. exact parent 1건과 field 0건 admission만 허용하고, 기존 9건 parent/item과 다른 8건 및 draft를 보존한다.
2. candidate artifact pointer, field projection, repair receipt를 원자적으로 적용하고 fault 시 모두 원복한다.
3. draft 편집 또는 신규 draft는 적용된 repair의 serving readiness를 무효화하지 않는다.
4. field repair release rollback은 명시적으로 unsupported이며 무변경으로 거부하고, ordinary parent rollback도 applied repair가 있으면 거부한다.
5. 새 ledger 외의 RLS 또는 DB 역할 체계를 이 복구 작업에서 확장하지 않는다.
