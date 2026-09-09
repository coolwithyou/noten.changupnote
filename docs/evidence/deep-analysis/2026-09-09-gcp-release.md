# 딥분석 GCP 배포 검증

2026-09-09. 사용자 재인증 완료 후, 기존 잔여 개선의 GCP 출고를 재개한다.
이 문서는 새 live 모델 실행·원천 승격·스케줄러 재개 권한을 부여하지 않는다.

## 인증과 출고 소스

- `cunote-codex-dev` configuration: base `sw@noten.im`, project `changupnote-com`,
  region `asia-northeast3`. 토큰 값은 출력·저장하지 않고 tokeninfo email이
  `cunote-codex-dev@changupnote-com.iam.gserviceaccount.com`인지 직접 검증했다.
- 지정 sol/xhigh 구현자가 Cloud Build의 explicit push를 top-level `images`로 바꿨다.
  root가 YAML parse, build tag/images 일치, diff를 독립 검증했다.
  [공식 이미지 저장 계약](https://docs.cloud.google.com/build/docs/building/build-containers#different_ways_of_storing_images)에
  따라 build 결과에 실제 application image digest를 남기는 최소 설정 변경이다.
- 소스 `6d0a25b0901cf25c6c01a5dad0822315e1fc2593` 커밋·push 후 clean git archive로
  빌드한다. 사용자 `apps/web/next-env.d.ts` 및 로컬 환경·의존성·산출물을 포함하지 않는다.
- 업로드 2,699파일, 파일 경로/내용 manifest SHA
  `757b018d0ade4f8b7ca60a610c2ccce4aaa97b09ca5dc242e339a92e28e5f7c1`.
  scratch root `/tmp/cunote-gcp-release-ecpDbQ`; 실행 snapshot은 private 파일이다.
- Cloud Build `4c78c9f6-78e2-4ae8-9546-cc2254d3bc05`, 기존 default build service account
  유지. source는 `gs://changupnote-com_cloudbuild/cunote-codex-dev/source/` 안에만 staging했다.
  진행 확인은 `gcloud builds describe`를 사용하며 로그 접근을 위해 권한을 추가하지 않았다.

## 배포 전 현재 상태

세 Job 모두 READY, runtime service account는
`cunote-deep-analysis@changupnote-com.iam.gserviceaccount.com`이다.
기존 image digest는 `sha256:36acd627af1da40fc8e695431e1bd42570809fb3c1c1d0c36f7fb1a333ab1a28`,
`GIT_COMMIT_SHA=28119762a2cffa137423ed81e102a3dc9770756d`였다.

| Job | generation | 실행 정책 |
| --- | --- | --- |
| cunote-deep-analysis | 98 | observe_only, Scheduler PAUSED |
| cunote-deep-analysis-input-preparation | 34 | Scheduler PAUSED |
| cunote-deep-analysis-serving-monitor | 27 | Scheduler ENABLED, KST 매시 :05/:35 |

배포 전 monitor 최근 3회 Cloud Run execution은 성공했다. 이는 새 이미지의 실행 증거가 아니다.
기존 runtime 계정·command/args·env/secret 참조·resources·timeout/retries·스케줄러 상태는
변경하지 않으며 image와 GIT_COMMIT_SHA만 갱신한다.

## 검증 경계

- 이전 R12 집계/실제 PG/브라우저 gate 이후 application runtime 소스는 동일하며,
  이번 추가 변경은 Cloud Build YAML뿐이다. worker policy 회귀를 다시 실행해 PASS했다.
- 빌드 완료·세 Job READY·전후 설정 대조·실제 스모크 증거는 아래 후속 결과로 기록한다.
- 메인은 observe_only 경로만 스모크한다. 일시정지된 input preparation의 실제 원천/변환
  처리나 스케줄러 재개는 하지 않는다. serving monitor는 기존 active release 검증 경로다.
- GCP 인증/배포는 기존 분석 데이터 교정·새 release 승인/승격·실계정 OAuth/문서 인수의
  완료 증거가 아니다.

## 배포 및 스모크 결과

Cloud Build SUCCESS, 반환된 application image digest:
`sha256:217d4d776ff66f5f362387e36cbcd082ff363511df791ccae32c42ff330c5d63`.
빌드 receipt SHA `d6ec5838ebee7a234fe58286d8fff0e747224ac286e6af0be72f71d51e9dd6b0`.
배포 직전 세 Job의 uid/generation/spec이 최초 snapshot과 같은지 다시 확인했다.

| Job | 배포 generation | 검증 결과 |
| --- | --- | --- |
| cunote-deep-analysis | 99 | READY, observe_only 유지, 실제 관측 실행 성공 |
| cunote-deep-analysis-input-preparation | 35 | READY, 설정 보존, 실제 처리 실행하지 않음 |
| cunote-deep-analysis-serving-monitor | 28 | READY, 실행 성공이나 검사 대상 0건 — coverage 미충족 |

세 Job의 image와 GIT_COMMIT_SHA는 exact build/source와 일치했다. 전후 task spec은
image/GIT_COMMIT_SHA 및 자동 생성 client metadata/nonce만 제외해 전수 비교했다.
runtime service account, command/args, env와 secret 참조, resources/timeout/retries 및
스케줄러 state/schedule/target/auth/retry 설정이 모두 보존됐다.
`job-contract-audit.json` SHA `075c55ef357c8ffe064ae59f514a66682371b738dbe39b84e508174bac49c73f`.

- 메인 execution `cunote-deep-analysis-9mpkv`: task 1/1, exit 0, exact image/SHA.
  실제 구조화 로그에서 `executionMode=observe_only`, `runtimeMode=paused`, generation 383,
  claimed 0, analysisSkipped/enqueueSkipped/budgetMutationSkipped 모두 true를 확인했다.
  heartbeat 쓰기는 있었으며 이를 DB 쓰기 전체 0으로 표현하지 않는다.
- monitor execution `cunote-deep-analysis-serving-monitor-zcn9b`: task 1/1, exit 0, exact image/SHA.
  로그의 verdict는 PASS이나 checkedReleases/checkedItems가 모두 0이었다. 이 결과는
  컨테이너·DB/R2 설정을 사용한 프로그램 실행 증거일 뿐 현재 공급 무결성 통과가 아니다.
- scratch receipt의 비밀값은 공개하지 않았다. 마지막 사용자 next-env SHA는 기존
  `7ad303e40d4fddf44f156129e397511953a71481c5cfd86b1862649aaaf240cc` 그대로다.

## 새로 확인한 모니터링 누락 — 후속 개선 필요

[verify-serving-cli.ts](../../../apps/web/src/lib/server/deep-analysis/verify-serving-cli.ts)의
active selector는 release `active`이면서 item `deepAnalysisRunId IS NOT NULL`인 것만 조회한다.
반면 현재 applied active 자산은 6 releases/117 items 모두 production run 미결속이다.
`canary_passed` applied도 3 releases/3 items(2 grants)이며 현재 selector에서 제외된다.
로컬 provenance 검증을 지원하는 하위 verifier가 있어도 상위 조회가 대상을 넘기지 않는다.

root가 제한된 read-only repeatable-read transaction에서 실제 Cloud Run 실행의 heartbeat
workerId/source SHA를 확인해 같은 서비스 DB임을 증명했다. session SET 없이 SET LOCAL만
사용했고 데이터·권한·인덱스를 바꾸지 않았다. 별도 집계의 monitor 대상은 실제 0건이었다.
`monitor-coverage-audit.json` SHA
`c8d563105702eee12cc9ebfb5d4b0fe63435ccd4fb3ce7eaedd62a5cd68d5944`.

같은 시각대의 정식 serving reader 조회는 **85공고/502조건**, DTO SHA
`113f162325535672520c9aa936931bad2dc29c7f282ce2437f00c3d329bb409f`로 기존과 같았다.
따라서 zero-target PASS는 빈 공급이 아니라 **검사 범위 누락**이다. 현재 배포에서
selector/판정 계약을 수정하거나 원천·release를 승격하지 않았다.

후속 완료 조건:

1. production/local provenance와 active/canary 제공 범위를 실제 serving 계약과 일치시킨다.
   단순 WHERE 제거로 모든 역사/미승격 item을 검사 대상으로 확대하지 않는다.
2. actual serving 대상 수와 monitor admission/checked/skipped 수를 대조한다. 공급이 있는데
   검사 0건이면 건강한 PASS로 표시하지 않는 coverage 판정을 추가한다.
3. local/production/mixed/empty/drift/역사 canary 회귀 및 실제 DB 대조를 통과한 뒤 재배포한다.
4. 같은 이미지의 실제 monitor 실행에서 현행 85건에 대한 검사·제외 사유를 증명한다.

GCP 재인증·이미지 출고 gate는 닫혔지만 운영 모니터 coverage gate는 열려 있다.

## 후속 수정 종결 — 12:43 KST

위 내용은 6d0a25b 배포 당시의 발견 기록이다. 추가 승인 후 c6ddcd9를 빌드·배포하고
실제 Cloud Run에서 현행 **85건 전수 검사·누락 0건**을 확인해 coverage gate를 닫았다.
세 Job은 generation 100/36/29이며 기존 observe_only/PAUSED/ENABLED 정책을 보존했다.

새 monitor는 원천 revision 불일치 22건을 감지해 exit 2로 종료했다. 이는 0건 PASS 누락
해결과 구분해야 할 데이터 후속 조사이며 건강 상태를 PASS로 바꾸지 않았다. exact build/digest,
실행별 로그 대조 및 후속 목록은 [모니터 수정 증거](2026-09-09-serving-monitor-coverage.md)와
[구조화 실행 영수증](2026-09-09-serving-monitor-runtime.json)에 기록했다.
