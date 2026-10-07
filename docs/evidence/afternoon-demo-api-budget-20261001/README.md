# 오후 시연 API 합산 $20 예산 계획

2026-10-01 현재 소스 읽기 전용 조사. 이 조사에서 모델 호출·운영 데이터 쓰기·브라우저 변경은 0회다. 배포 환경의 모델 override는 실행 담당자가 값만 확인해야 한다. 키·메시지 본문은 기록하지 않는다.

배포 담당자 read-only 확인: READY `dpl_CjpptvL6qj3H5zNjcp4tGDyVZrj6`, source `d745bfc`, production `CHAT_MODEL`과 `CHAT_DRAFT_MODEL` 모두 미설정. 따라서 이 배포에는 아래 소스 기본 모델 예약표를 적용한다. 최초 DB 기준 snapshot은 `spike-out/afternoon-demo-api-usage-baseline.json` (UTC 05:55:55.104)이며 기존 reported 1건, 비용추정 $0.01427125다. 신규 시연 요청과 구분한다.

| 경로 | 코드 기본 모델 | 출력 토큰 상한 | SDK 재시도 | 요청 전 보수 예약액 |
|---|---|---:|---:|---:|
| 일반 chat | claude-haiku-4-5-20251001 | 1,024 | 최대 2회 재시도, 총 3회 | $1.50 |
| fieldSuggest | claude-sonnet-4-6 | 4,000 | 0 | $7.00 |
| sectionComposer | claude-sonnet-4-6 | 6,000 | 0 | $7.00 |
| field context chat | 위 chat + 후속 field/section 제안 | 위 두 요청 각각 적용 | chat만 재시도 | $8.50 |

`CHAT_MODEL`, `CHAT_DRAFT_MODEL` override가 있으면 이 예약표를 적용하지 않고 해당 모델 가격·context로 다시 산정한다. field/section은 45초 timeout이다. chat 이력은 세션 전체를 읽고, 문서 grounding 기본 24,000은 chars/1.6 추정이므로 전체 입력의 엄격한 token cap이 아니다.

예약액은 예상 비용이 아니라 최대 context 입력과 캐시 쓰기·재시도 여유를 포함한 상계다. Haiku context 200K, Sonnet4.6 context 1M을 각각 모두 입력으로 간주한다. 1시간 cache write 단가와 1.1배 regional 여유까지 적용하면 chat `3 × (200000×2 + 1024×5)/1e6×1.1 = $1.337`, section `(1000000×6 + 6000×15)/1e6×1.1 = $6.699`, field `$6.666`이다. 현재 코드 캐시는 TTL 없이 ephemeral이므로 실제 사용량 가격 계산에는 5분 쓰기 단가를 쓴다. 도구 추가 호출·임의 모델 변경·병렬 실행을 포함하지 않는다. 모델 context 및 가격 근거: [모델 context](https://platform.claude.com/docs/en/build-with-claude/context-windows), [공식 가격](https://platform.claude.com/docs/en/about-claude/pricing).

## 실행 담당자 원장

원장 경로 제안: `spike-out/afternoon-demo-api-budget-20261001.jsonl`. 첫 줄에 시작 UTC, 사용자·회사 ID, 배포 SHA, 실제 두 모델, 상한 20을 적는다. API 실행은 담당자 한 명이 순차 수행한다. 요청마다 종류·시작시각·예약액·session/request ID·종료 상태·usage 4종·산정액·미확인 예약액을 기록한다. `확인된 비용 + 미확인 예약액 + 신규 예약액 <= 20`일 때만 실행한다. 일반 chat → 필드 제안 → 섹션 작성은 선예약 합계 $15.50으로 시작할 수 있다. 필드 context chat은 후속 요청까지 $8.50을 예약한다. 다른 승인된 API 호출이 있으면 동일 원장에 포함한다.

완료된 provider usage는 실제 토큰 관측 증거이고, 단가를 곱한 금액은 청구서가 아닌 비용 추정이다. 실패·timeout·usage 누락·chat 재시도 발생은 최종 성공 usage에 모든 청구가 포함된다는 보장이 없으므로 차액 예약을 해제하지 않는다. 오류나 재시도 여부가 불명확하면 관련 예약 전액을 유지한다. Console 청구와 대조 전까지 미확인 비용을 0으로 처리하지 않는다.

독립 로컬 helper: `node docs/evidence/afternoon-demo-api-budget-20261001/ledger.mjs init`, `reserve chat-1 chat`, `reserve section-1 section`, `report section-1 0.15`, `status`. 기본 원장은 `/tmp/cunote-afternoon-demo-api-budget-20261001.jsonl`, `DEMO_API_LEDGER`로 변경 가능하다. report는 기본적으로 잔여 예약을 유지한다. 모든 attempt usage 또는 무재시도 단일 요청 성공이 증명된 경우에만 `report section-1 0.15 --reconciled`로 해제한다. 일반 chat 1+section 2+field 1을 처음부터 모두 예약하면 $22.50이므로 차단된다. 실제 단일 section usage 대조 후 해당 예약을 해제하고 다음 요청을 순차 예약한다. helper cap 차단/해제 후 다음 예약 허용을 로컬 검증했다.

SQL 실행 helper는 gitignored `spike-out/afternoon-demo-api-usage-snapshot.ts`이며 `pnpm exec tsx spike-out/afternoon-demo-api-usage-snapshot.ts --output=spike-out/usage-after-section-1.json`으로 실행한다. 기본 출력은 timestamp 파일, 기존 출력은 exclusive-create로 덮어쓰지 않는다. 모델·DB 쓰기 없이 SQL을 실제 read-only transaction으로 실행해 형식을 확인했다.

## 읽기 전용 확인 경로

[usage.sql](usage.sql)은 `chat_messages.usage`와 `generative_usage_events`를 합친다. 실제 실행 시작 UTC로 필터를 바꾸고 기준 snapshot에서 이미 있던 request ID를 제외한다. 현재 키는 input/output/cacheRead/cacheWrite이다. 제안 이벤트는 `field_suggestion`, 섹션은 `writing-section-v1`이며 reported/started/unavailable 상태를 확인한다. 알 수 없는 model은 비용 NULL로 남겨 원장 예약을 유지한다. query는 read-only transaction에서 실행하고 결과만 로컬 저장한다.

`chat_sessions` 누적에는 generative event 사용량도 더해져 있으므로 SQL 결과와 합산하면 중복이다. 또한 제안 모델과 세션 모델이 다를 수 있어 세션 누적×모델 단가로 계산하면 부정확하다. 세션 누적은 일일 300,000 토큰 기본 guard를 위한 보조 값이며 $20 상한이나 동시 요청 예약을 제공하지 않는다. chat session model이 실제 배포 override와 같다는 것도 확인한다. provider request ID는 현재 제안 호출자가 저장하지 않으므로 usage 누락을 DB만으로 완전 복구할 수 없다. HTTP 실패로 assistant row 자체가 없으면 DB SQL에 나타나지 않으므로 로컬 사전 요청 원장이 필수다.

코드 근거: `apps/web/src/app/api/web/chat/route.ts`, `lib/server/chat/{session,budget,grounding,fieldAssist}.ts`, `lib/server/documents/{fieldSuggest,sectionComposer,generativeUsage}.ts`. 설치된 ai SDK `dist/index.js`의 maxRetries 기본값 2도 직접 확인했다. 운영 API는 Anthropic SDK API key 경로이며 구독 CLI transport가 아니다.
