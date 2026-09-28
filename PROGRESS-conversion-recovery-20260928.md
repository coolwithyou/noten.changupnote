# 변환 병목과 원문 누락 복구

## 목표·범위

- 긴 HWP 변환 중에도 HTTP 등록·상태 조회가 응답하도록 동기 변환을 별도 실행 스레드로 분리한다.
- 현재 pending 중 archive SHA가 없는 exact 4개 surface를 공식 원문·기존 아카이브와 대조해 복구한다.
- 앞선 승인된 변환 공급 운영 범위 안에서 코드 검증, 정확한 워커 소스 배포 및 소량 실측을 수행한다. 모델 호출·추천 승격은 범위 밖이다.
- 메인 dirty checkout과 다른 세션 작업은 보존한다. 기존 완료·비활성 워커 checkout에서 origin/main 기반 새 브랜치를 사용한다.

## 체크리스트·검증

- [x] Orca 작업 소유권과 clean branch 확인.
- [x] 별도 스레드 변환 구현: 변환 결과 계약·동시성 상한·temp cleanup 유지.
- [x] 실제 blocking 변환 중 HTTP 응답, worker 오류·종료, 정상 artifact/cleanup 회귀 검사.
- [x] 누락4개 exact source URL, archive row, R2 bytes/SHA 읽기 검증 및 복구 경로 확정.
- [x] 관련 build/tests 및 source integrity 검증 후 커밋·통합.
- [x] exact image digest 배포, runtime 설정 보존, 긴 실제 문서 상태조회 p95/완료율 검증.
- [x] 복구4개 DB/R2 결속과 변환 결과 검증, 잔량·시간 추정 갱신.

## 결정 로그

- 2026-09-28 기존 queue가 convertDocument의 spawnSync 경로를 HTTP 이벤트 루프에서 실행한다. 클라이언트 timeout만 늘리지 않고 이 실행을 worker_threads로 격리한다. queue의 작업수 상한(현행2)이 변환 스레드 상한도 제한한다.
- Node.js 공식 worker_threads 문서의 Buffer structured clone/exit/error 동작을 확인했다: https://nodejs.org/api/worker_threads.html
- 신규 원문과 기존 보관 자료가 충돌하면 임의로 SHA를 덮어쓰지 않고 원문 변경으로 분류한다.

- 누락4건 재분류: 공고 `126496`·`126545`의 수정 전 PDF/HWPX4개 surface는 역사 행이며, 현재 raw/archives는 수정·최종 첨부4개로 교체되어 있다. 최신4개 각각을 공식 fileDown URL과 R2에서 읽어 전체SHA를 비교했고 모두 일치했다. 과거 SHA를 현재 원문으로 복원하지 않는다. canonical raw 첨부 identity가 있는 경우 자동 스윕에서 교체 전 surface를 제외하고, 현행 첨부의 실제 SHA 누락은 진단 대상에 남긴다. 기존 행·파일 삭제 없음.
- HTTP 응답 회귀: 실제 pdftoppm wrapper가3초 동기 blocking 중 상태조회3ms, 동시성2, 정상artifact, worker throw/nonzero/silent exit3경로와 임시파일 정리 PASS. cleanup3경로·quality10개 PASS.

- 웹 typecheck 및 격리 product-postgres(94 migrations/RLS) PASS. 추가 DB 회귀는 교체 전 첨부 제외, 현행 SHA 누락 유지, 역사 조회 보존, canonical key 없는 legacy 보존을 검증한다. 테스트 최초 실패는 fixture JSON을 문자열로 이중 인코딩한 문제였고 postgres.json 바인딩으로 수정했다.
- 로컬 native failure suite는 LibreOffice 미설치 때문에2개 전제 미충족(9/11). 같은 소스의 Linux Cloud Build 이미지 안에서 전체 native suite를 실행해 배포 전 확인한다. 로컬 hwp-markdown endpoint suite PASS.

- 운영 DB read-only 전체 선택 비교: 이전678개, 수정후674개, 제외된 것은 문제의 역사4개뿐이고 현행 SHA 누락0개. 선택·URL 서명까지802ms. 최신4개는 공식 다운로드와 R2 바이트가 동일하며 raw binding도 일치한다.

- 부분 보관 manifest는 교체를 증명할 수 없으므로 모든 raw 첨부에 storage_key가 있을 때만 역사 surface를 제외하도록 보강했다. 부분 보관 누락 유지 회귀, product-postgres 전체 gate, 웹 typecheck를 다시 통과했다. 운영 비교도 역사4개 제외·현행 누락0개를 유지했다.
- worker 이미지 소스는 `0c404433fe86dfdeccd42b44119a28e32a10ced0`; 후속 보강은 웹 선택 SQL/테스트만 바꿔 워커 소스·빌드 입력은 동일하다. Cloud Build `5bf75b97-d512-4417-a196-5d84fbc8b23b`에서 native suite를 이미지 push보다 먼저 실행한다.

- PR21은 `2ce4bc8f1d148ca92a1561fad009d5617852cb2e`로 main 병합. Cloud Build 전체 SUCCESS, native failure11/11·quality10/10·worker 응답46ms/3초 blocking·cleanup·HWP endpoint PASS. 워커 revision10, image `sha256:6df93e7c7024f961898e644ced9ae16395b74e8b773779c25fe5f915d259a1e3`, runtime/access 보존 및 traffic100% 확인.
- 긴 변환 HTTP 병목 해소 후에도 20분 주기 중 비실행 대기가 남는다. 동일 자동 공급 범위·worker 동시성2·cron limit50/concurrency3/budget240s·DB lease10분을 유지하며 실행 간격만5분으로 조정한다. 매시간2/7/12/.../57분이라 기존17/37/57분 관측과 정각 수집을 유지·분산한다.

- 실제 운영 canary6개(PDF2/HWPX2/HWP2)는 캐시 없이 전건 succeeded/preview_ready. 31쪽 HWPX를 포함하고 상태조회208회 p95 19ms/max48ms/오류0. 전체128개 artifact R2 바이트 SHA 및 DB source/attachment 결속 확인. 원문 교체 대상 최신4개도 포함. 검증 파일 다운로드를 포함해153,738ms, shared lease 정상 해제.
- PR22 main 병합 `ab4e7254aa5bef09e8c3fb4d0de40394efa696a9`; 별도 코드 변경 없이 cron schedule·설명 주석만5분 주기로 변경. 운영 배포 및23:37 native cron 관측 진행.

## 완료 증거

- Web production `dpl_EtSt3khKQWcRBQsdpPMrg6ifyTxe`, SHA `ab4e7254aa5bef09e8c3fb4d0de40394efa696a9`, READY·production aliases 확인. `/`200, 무인증 cron401. 운영 cron5분 등록 확인.
- 23:37 native cron HTTP200, 23:37:20–23:40:50 약210초, ready 전환17건·새 실패0, DB lease 해제 확인. 실행 중 HTTP 응답은 실제6건 canary208회 p95 19ms로 독립 검증했다.
- 최종 current pending 643건, 현행 SHA 누락0, 역사4개 행·artifact 상태 보존. 현행첨부 SHA/DB 결속은 `docs/evidence/conversion-recovery-20260928.json`에 기록했다.
- 단일 자동 실행17건/5분을 외삽하면 잔량은 약3시간대이며 문서 크기·재시도를 고려한 운영 추정은3–6시간이다. 전체 대기열 완료를 의미하지 않는다.
- 검증 범위: 변환/원문 공급·DB artifact·native cron. 사용자 브라우저 UAT·모델 분석 품질은 이 수정 범위 밖으로 미실행. 변환 worker 패키지·런타임 입력은0c40443과 최종main이 같음을 git diff로 확인했다.

- 새5분 주기의 다음 native 실행이23:42:18에 DB lease를 획득했다. 이전23:37 실행 종료 뒤 약5분 간격 재착수를 확인했으며, 대기열은 자동 처리 중이다.
