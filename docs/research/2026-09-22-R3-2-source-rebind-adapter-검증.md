# R3-2 의미 불변 source rebind adapter 검증

작성일: 2026-09-22

범위: 종합 실행계획 R3-2, `source_rebind` 완료 경로

운영 변경: 없음

## 구현 경계

- `grant-source-change-impact-v1`이 `evidence_refresh`이고 변경 domain이 `raw` 하나인 경우만 받는다.
- 이전 raw, 현재 raw, 현재 source revision, raw를 제외한 material revision, 기존 promotion parent와 현재 serving hash를 exact manifest에 봉인한다.
- 준비자와 승인자를 분리한 release 원장과 전용 successor item을 사용한다.
- 기존 promotion manifest는 수정하지 않는다.
- 같은 parent의 반복 변경은 `previous revision → current revision`이 분기 없이 이어지고 raw/material 연속성이 맞는 chain일 때만 최신 frontier를 채택한다.
- 활성 v2 질문의 source revision/raw와 definition hash를 전진시키고, 같은 질문에 이미 저장된 답변의 source/definition 결속도 같은 transaction에서 전진시킨다.
- 답변 값, `satisfied|unsatisfied|unknown` 판정, question version, answer revision은 바꾸지 않는다.
- 적용 뒤 current source/material/serving hash가 receipt와 일치할 때만 readiness와 사용자 매칭 projection이 successor를 채택한다.
- coverage, eligibility, attachment, recruitment, extractor contract 변경은 fail-closed한다.

## 격리 PostgreSQL 인수

폐기형 Unix socket PostgreSQL에 다음 순서로 fixture를 만들었다.

1. 검수된 criterion, current v2 질문, `satisfied` 답변 한 건과 active promotion을 준비한다.
2. 공고·첨부·조건 projection은 유지하고 raw 관측값만 새 hash로 전진시킨다.
3. 변경 영향 영수증을 `evidence_refresh/raw`로 기록한다.
4. 공통 readiness가 D / `source_rebind`임을 확인한다.
5. exact manifest 준비, 다른 actor 승인, adapter 적용을 실행한다.
6. 최신 readiness가 A / `reuse_ready`로 이동하고 사용자 매칭 promotion evidence도 현재 source revision을 반환하는지 확인한다.
7. 기존 답변 값과 판정, answer revision이 그대로이며 source/definition 결속만 현재 값인지 확인한다.
8. 같은 release의 적용과 준비를 다시 호출해 추가 쓰기 없이 기존 성공 receipt를 재사용하는지 확인한다.
9. raw 관측값을 한 번 더 변경해 두 번째 successor를 적용하고, root promotion은 유지한 채 최신 frontier로 다시 A에 도달하는지 확인한다.

결과: 같은 질문 1건과 답변 1건을 두 개의 연속 successor에 재결속했고 각 실행의 모델 호출은 0회였다. 기존 promotion rollback은 적용된 source successor가 있으면 `source_rebind_applied`로 차단된다.

## 검증 명령

```bash
pnpm --filter @cunote/web typecheck
pnpm verify:db-migrations
pnpm test:grant-product-readiness
pnpm test:product-postgres
```

모두 통과했다. `test:product-postgres`의 의도적인 재계산 실패 fixture 로그는 기존 회귀 검사이며 suite 결과는 성공이다.

## 남은 운영 경계

- `0090_source_rebind_successor.sql`은 서비스 DB에 적용하지 않았다.
- 실제 공고의 source rebind release를 준비·승인·적용하지 않았다.
- 배포, 모델 호출, 운영 match state 갱신을 수행하지 않았다.
- 다음 단계는 R3-3 `recruitment_refresh` adapter다.
