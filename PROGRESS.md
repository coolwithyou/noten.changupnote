# 변환 공급 처리량 분리 릴리스

## 목표와 완료 조건

- 현재 모집 중인 공고의 보관 원문이 변환 대기열에서 공정하게 처리되도록 한다.
- 발행/백필 트랜잭션 동안 원격 변환 서버를 기다리지 않는다.
- 자동 스윕의 중복 실행을 DB lease로 막고, 종료 뒤 회복한다.
- 격리 DB 및 Preview에서 확인한 뒤 정확한 `0093` 운영 마이그레이션과 웹 배포를 별도 승인 범위로 처리한다.
- 배포 뒤 pending/preview_ready 변화, 실제 공고문 1건, 아스카웍스 추천 경로를 계층별로 검증한다.

## 실행 기록

- `origin/main@83981b3`에서 별도 `codex/conversion-supply-throughput` 브랜치를 만들었다. 대형 matching PR #18의 107개 커밋을 가져오지 않고 변환 코드 커밋 5개의 변경만 적용했다. 변경 범위는 웹 변환·발행/백필 호출처, `0093` DB lease, Vercel Cron, 격리 PostgreSQL 검증이다.
- 후속 검토에서 변환 서버는 진행 중인 SHA 작업을 자동으로 합치지 않고 `jobId`만 멱등 처리함을 확인했다. 웹이 매 스윕마다 새 UUID를 만들던 결함을 `db21209`에서 surface·원문 SHA·converter 버전 기반 안정 ID로 수정했다. 명시적인 failed 복구는 새 ID를 사용한다. 같은 원문에 대한 불필요한 중복 큐 등록을 방지한다.
- 정확한 코드 근거와 이전 작업의 운영 snapshot은 `codex/matching-coverage-artifact-recovery`의 `PROGRESS-asca-507-review.md` §2026-09-28을 참조한다. 운영 snapshot은 배포 이후 결과가 아니다.
- 2026-09-28T07:43:28Z 운영 DB 읽기 전용 preflight: `changupnote`/role `postgres`, Drizzle 원장 최신 id 94(`0092`), `conversion_sweep_leases` 없음. surface 전체 `pending` 4,050·`preview_ready` 1,406·`fields_ready` 54·`failed` 16. KST 현재 모집 중 `open/visible`인 파일 surface pending은 K-Startup 176개/77공고, BizInfo 500개/246공고로 합계 676개/323공고다. 기간·타입 필터를 명시한 이 snapshot을 이전 709개 수치와 같은 모집단으로 합치지 않는다.
- 2026-09-28 읽기 전용 연결 확인: `NOTEN/changupnote` production 환경에 `CONVERSION_SERVER_URL`, `CONVERSION_SHARED_SECRET`, `CRON_SECRET`이 등록돼 있다. production env가 가리키는 Cloud Run URL의 `GET /`은 앱 401, 같은 production secret으로 없는 job을 GET하면 앱 JSON 404(`job not found`)가 나왔다. 인증·도달성은 확인됐으나 실제 변환 성공·처리량 증거는 아니다. `/healthz`의 Google 404는 기존 배포 기록에도 명시된 프런트엔드 가로채기다.
- 2026-09-28T07:59Z 운영 DB 읽기 전용 재측정: 같은 KST 현재 `open/visible`·신청기간·`file_template/pending` 모집단은 709개(K-Startup 189·BizInfo 520)로 달라졌다. exact archive SHA와 공급 URL이 있는 것은 705개이며, 4개는 BizInfo 두 공고(`PBLN_000000000126496`, `PBLN_000000000126545`)의 공고문 쌍에 보관 SHA가 없다. 07:43Z 기준선 이후 만들어진 해당 모집단 surface는 0개라 676→709를 신규 첨부 유입량으로 해석하지 않는다. 현재 grant 노출·기간 등 모집단 변동 원인은 별도 추적 대상이다.
- 같은 시각 운영 DB에서 새 자동 정렬과 동일한 50건 선택 SELECT를 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`로 읽기 전용 실행했다. 실제 50행, planning 0.929ms·execution 12.805ms·shared read 0블록이었다. 선택 쿼리 비용만 확인한 결과이며 원격 변환 완료 시간은 포함하지 않는다.
- 운영 `drizzle.__drizzle_migrations` 최신 id 94의 hash prefix `32c6b2c989125fd6`는 로컬 `0092_company_fact_withdrawals.sql` 바이트 SHA와 일치한다. 직전 id 93도 로컬 `0091` SHA와 일치하며, 현재 분리 브랜치 저널의 다음 항목은 `0093_conversion_sweep_lease` 하나다. 이는 적용 전 원장 결속 검사이고 운영 마이그레이션 실행은 아니다.

## 검증 체크리스트

- [x] `pnpm install --frozen-lockfile` — 기존 로컬 패키지 캐시로 완료
- [x] `pnpm build:packages` 및 `pnpm --filter web typecheck`
- [x] `pnpm verify:db-migrations` — 0093 포함
- [x] `pnpm test:product-postgres` — 격리 Unix socket·94 migrations·RLS, 변환 source/동시성/lease/공정성
- [x] `pnpm verify:deep-analysis-contract` — 입력 준비 호출처
- [x] `pnpm verify:package-runtime-freshness`
- [x] `git diff --check` 및 [draft PR #19](https://github.com/coolwithyou/noten.changupnote/pull/19) Vercel Preview·Preview Comments PASS (`eec4490`, 최신 코드 `db21209` 이후 문서만 변경)
- [x] `db21209` 이후 `pnpm --filter web typecheck`, `pnpm test:product-postgres` 재실행 PASS. 안정 ID 재스윕·새 SHA·명시 실패 복구를 격리 DB 검증에 포함했다.
- [ ] 운영 적용 범위 승인 후 `0093` 적용 → 정확한 소스 배포 → Cron/변환 처리량 관측

## 결정과 경계

- 생산 DB 쓰기와 생산 웹 배포는 프로젝트 AGENTS.md의 별도 명시 승인 단계다. 코드/Preview 검증은 그 승인이 아니다.
- 적용 범위 후보: PR #19의 최신 코드 `db21209`를 `main`에 통합하고, `changupnote` DB에 `0093_conversion_sweep_lease.sql`만 적용한 뒤 `NOTEN/changupnote` 웹을 정확한 통합 SHA로 배포한다. 운영 Cron은 첫 1회 상태·결과를 관측해 재시도/실패/preview_ready 변화와 공고문 원본 결속을 확인한다. 앞서 제시한 `86baf8c` 적용 범위는 새 코드 때문에 폐기했다. 최신 범위 승인 전에는 세 쓰기 단계를 수행하지 않는다.
- 변환 서버는 인메모리 큐, 기본 동시 작업 2건이며 독립 운영의 CPU 정책과 실제 처리량은 아직 확인되지 않았다. 안정 ID는 살아 있는 같은 인스턴스의 중복 작업을 줄이지만 재시작·다중 인스턴스 간 중복 방지와 676개 backlog 소진 시간은 운영 관측 대상이다.
- Cloud Run `cunote-conversion` 현재 구성 읽기는 `cunote-codex-dev` gcloud base 계정의 대화형 재인증 만료로 막혔다. 코드 적용 전에도 독립 변환 서버의 CPU 정책·실제 처리량은 미확인이다. [Cloud Run 공식 문서](https://docs.cloud.google.com/run/docs/configuring/billing-settings)에 따르면 기본 request-based billing에서는 요청 밖 CPU가 할당되지 않는다. 인메모리 큐가 POST 응답 뒤에 작업하므로 현재 서비스의 CPU 설정을 확인하고 첫 Cron에서 완료율을 관측해야 한다. 과거 배포 기록의 2Gi/2cpu·max-instances1만으로 CPU 지속 할당을 증명할 수 없다.
- 다른 세션의 dirty `main` 파일과 PR #18의 독립 matching campaign 준비물은 변경하지 않는다. exact19와 별도 matching-only manifest의 grant/receipt 없는 상태는 launch 권한이 아니다.
