# 실제 공급 기준 serving monitor 보완

2026-09-09. 사용자가 새로 발견된 모니터링 누락을 이번 세션에서 처리하도록 승인했다.
sol/xhigh가 구현하고 root가 독립 감사·실제 PostgreSQL 검증·출고를 맡는다.

## 범위와 완료 조건

- `--active` 대상은 정식 serving reader의 현재 공급과 일치시킨다. production뿐 아니라
  검증된 local provenance 및 실제 제공 중인 canary를 포함한다. 미승격·역사 item을
  무조건 검사 대상으로 열지 않는다.
- 같은 read-only repeatable-read snapshot에서 정식 DTO와 promotion 결속을 읽고,
  공고마다 정확히 하나의 검사 결과를 남긴다. 최신 결속이 모호하거나 조회 상한을 넘거나
  공급/대상/결과 수가 맞지 않으면 실패한다.
- 실제 공급이 있는데 검사 0건인 결과를 PASS로 만들지 않는다. 실제 공급도 없으면
  `NO_TARGETS`로 표시하며 정상 공급 검증과 구분한다.
- 비노출 공고 하나 때문에 release 전체를 건너뛰지 않는다. 개별 오류를 기록한 뒤
  다른 공고 검사를 이어가되 전체 판정은 실패로 남긴다.
- Cloud Run에 없는 로컬 `spike-out` 파일을 active 검사의 필수조건으로 삼지 않는다.
  검증된 embedded provenance와 현재 원천 revision을 대조한다. local lab input과
  operational input은 서로 다른 계약이므로 단순 hash 동등성을 요구하지 않는다.
- 특정 release의 승인 전 full 검증 및 과거 24시간 observation receipt 의미는 유지한다.
  이번 active coverage 수정이 local 24시간 연속 관측을 증명한다고 주장하지 않는다.

새 모델 실행·원천 수정·분석 결과 승격·스케줄러 재개는 하지 않는다. 메인은
`observe_only`, main/input preparation Scheduler는 PAUSED, monitor는 ENABLED를 유지한다.
기존 heartbeat와 production monitor receipt 쓰기를 데이터 쓰기 전체 0으로 표현하지 않는다.

## 수정 전 실측

- root 정식 serving reader, `asOf=2026-09-09T02:46:54.774Z`:
  **85공고 / 502조건**, DTO SHA
  `113f162325535672520c9aa936931bad2dc29c7f282ce2437f00c3d329bb409f`.
- private snapshot `/tmp/cunote-root-serving-r12-monitor-before.json`.
  임시 진단은 서비스 데이터 쓰기 없이 정식 reader의 top-level RR transaction을 사용했다.
- 이전 실제 Cloud Run 실행의 checked 0/PASS와 원인·배포 설정은
  [선행 GCP 검증](2026-09-09-gcp-release.md)에 기록돼 있다.
- 기존 kind 불일치 30공고/36조건 등 데이터 문제는 별도 교정 대상이다. 수정된 monitor가
  이를 실패로 발견하는 것은 검사의 성공이며, 데이터 무결성 PASS와 구분한다.

## 검증·출고 결과

구현 검증과 출고 증거를 구분한다. 아래 초기 검증은 개선 과정의 기록이고, 최종 소스의
검증·배포 결과는 후속 절에 따로 기록한다.

### 초기 구현 독립 감사

- 실제 PostgreSQL 첫 실행: 84 migrations를 새 Unix-socket-only cluster에 적용한 product
  suite PASS. 실제 monitor inventory loader로 local/production/canary 포함, 비노출/마감/
  기간종료/dedup/history/prepared 제외, 최신 item 선택·동률/날짜누락 거부, after hash 변경
  감지, sentinel overflow, nested transaction 거부, 빈 공급 NO_TARGETS를 확인했다.
  `/tmp/cunote-monitor-coverage-rOfnkB/postgres-v1.log`; cluster
  `/tmp/cunote-product-pg-tHYLps`는 종료했다. fixture는 서비스 release 승인 증거가 아니다.
- 12:00 KST 초기 코드의 실제 서비스 read-only inventory 대조: canonical **85/502**,
  admitted **85**, coverage issue 0, 기존 DTO SHA 유지. 적용 active/canary 120행 중
  verified serving binding 118행, provenance 미충족 2행. 118행 중 현재 대상 85행,
  비활성 상태 14행·기간 종료 19행을 명시 제외했다. 선택 대상은 모두 local active였다.
  현재 유효한 canary가 없다는 뜻이며 canary 지원 회귀는 실제 격리 PG로 증명했다.
- 위 읽기는 약 2.12초, 종료 RSS 약 307MiB였다. 모델·R2 처리와 전체 verifier 실행 성능이
  아니라 **inventory 조회만**의 로컬 실측이다. private receipt
  `/tmp/cunote-monitor-coverage-rOfnkB/inventory-initial.json`.
- 감사 중 빈 공급 판정 우선순위, 결과 ID exact 대조, item별 manifest JSON 중복 직렬화
  문제를 발견해 보완했다. 큰 release 문서는 release별 hash로 결속하고 전체 inventory
  hash에는 작은 item 결속만 사용한다. 이는 512Mi monitor의 중복 메모리/CPU 위험을 줄인다.
- 두 번째 실제 PG 실행도 PASS. 서비스에 없는 UUID run과 원격 읽기·쓰기를 모두 거부하는
  storage fixture를 사용해 active verifier의 3단계 정상 통과를 확인했다. local lab input과
  operational input이 달라도 올바른 source revision이면 통과했다. 원천 제목 변경은
  freshness 실패, 조건 추가는 publication 실패/후속 단계 not_reached, 복원 후 PASS였다.
  `/tmp/cunote-monitor-coverage-rOfnkB/postgres-v2.log`, 종료 cluster
  `/tmp/cunote-product-pg-0FImmq`. 첨부 없는 격리 fixture이며 실제 R2 첨부 검증과 구분한다.
- [Cloud Logging 공식 한도](https://docs.cloud.google.com/logging/quotas)의 LogEntry 256KiB를
  확인했다. 모든 공고의 stage evidence를 한 줄에 넣는 방식은 공급이 늘면 한도를 넘을 수
  있어, 공고별 terminal 로그와 count/hash로 결속한 최종 집계를 분리하도록 보완한다.

### 첫 현행 전체 검사와 파이프라인 경계 보정

12:09~12:10 KST 초기 full monitor는 85건을 약 42초에 검사했다. 실행 전후 코드 hash와
inventory hash가 같고, 공고별 로그 85개/잘림 0, 최대 행 약 3.1KiB였다. publication 85건과
canonical DTO→matcher 대조 85건이 통과했다. 이는 원래 분석 의미가 올바르다는 재검수가
아니므로, 앞서 확인된 원문 대비 kind 불일치 30공고/36조건의 교정 완료로 해석하지 않는다.

최초 freshness는 42건 통과/43건 미충족이었다. 원천 revision 불일치 22건과 operational
input 미봉인 36건이 있었고 15건은 겹쳤다. 원천 revision이 같은 나머지 21건을 다시 읽으니
운영 archive 미완료 22첨부/markdown conversion 미완료 5첨부였으며 실제 저장 객체 읽기나
SHA 오류는 아니었다. local lab과 운영 준비 파이프라인은 서로 다른 계약이므로 이 21건을
원천이 변한 것으로 분류하면 잘못된 경고다.

따라서 local active 검사의 freshness 범위를 **현재 원천 결속**으로 명시한다. verified
local embedded manifest와 현재 sourceRevision이 일치하는지 검증하고, 별도 운영 파이프라인의
미준비·상한 상태는 telemetry로 남긴다. 이미 key/hash가 있는 객체의 실제 읽기 실패·SHA
불일치 등은 계속 실패로 처리한다. production은 기존 sealed + inputSha 검증을 유지한다.
이는 local lab 원문 전체 재검수나 모든 외부 URL 가용성의 증거가 아니다.

초기 private 로그 `local-monitor-initial.jsonl`, 실행 결속
`local-monitor-initial-execution.json`, 준비 미충족 재조회 `input-blockers.json`은 모두
`/tmp/cunote-monitor-coverage-rOfnkB/`에 있다. 최종 정책 코드의 재실행·배포 영수증은 별도다.

### 최종 구현 검증 — 12:31 KST

- 최상위 `pnpm test` PASS. 새 monitor 17-case suite는 `test:product-journey` 경로에 연결했다.
  최종 aggregate 실행 전후 변경 파일 8개의 hash가 같았다. `aggregate-final.log` SHA
  `913a21ff837dca11759c9aa57f1dd5b89688e1b7eedb980131081910445e9e48`.
- 실제 PostgreSQL 최종 v7 PASS, 84 migrations/RLS/기존 제품 회귀 포함.
  `postgres-v7.log`, cluster `/tmp/cunote-product-pg-N41uNv` 종료.
  관측 메타데이터에서 파생된 extraction manifest 시각도 material hash에서 분리했다.
  원문 hash·reviewedAt·extractorVersion·readiness 변경은 그대로 결속한다.
- 출고 전 추가 dedup 동시성 감사에서 과거 links 배열 사용 결함을 실제 PG v6로 재현했다.
  미승격 member 추가는 canonical DTO를 바꾸지 않아 전체 inventory hash만으로 감지할 수
  없었다. active target의 짧은 RR 안에서 현재 dedup component도 함께 읽도록 보정했고,
  v7에서 publication 실패 감지/링크 복원 후 PASS를 확인했다. 특정 release CLI는 유지했다.
- 최종 소스의 현행 full monitor는 **85/85 검사, 누락 0, coverage issue 0**이다.
  publication/serving 각각 85 PASS, freshness **63 PASS / 22 source revision 불일치**.
  실행 전후 코드와 inventory hash가 같고, 공고별 ID/결과 hash와 최종 결과 집합 hash도
  root가 별도 검증했다. 진짜 0-target PASS는 없으며 실제 health는 exit 2/FAIL로 남는다.
  `local-monitor-release.jsonl`, `local-monitor-release-execution.json`,
  `monitor-local-release-audit.json`을 같은 private scratch에 보존했다.
- 현재 공급은 계속 85공고/502조건이며 초기 DTO SHA와 같다. 모델 실행·원천 수정·결과 승격은
  하지 않았다. 다음 단계는 검증된 소스의 커밋·push·clean image build와 실제 Cloud Run 검증이다.
