# 변환 공급 처리량 분리 릴리스

## 목표와 완료 조건

- 현재 모집 중인 공고의 보관 원문이 변환 대기열에서 공정하게 처리되도록 한다.
- 발행/백필 트랜잭션 동안 원격 변환 서버를 기다리지 않는다.
- 자동 스윕의 중복 실행을 DB lease로 막고, 종료 뒤 회복한다.
- 격리 DB 및 Preview에서 확인한 뒤 정확한 `0093` 운영 마이그레이션과 웹 배포를 별도 승인 범위로 처리한다.
- 배포 뒤 pending/preview_ready 변화, 실제 공고문 1건, 아스카웍스 추천 경로를 계층별로 검증한다.

## 실행 기록

- `origin/main@83981b3`에서 별도 `codex/conversion-supply-throughput` 브랜치를 만들었다. 대형 matching PR #18의 107개 커밋을 가져오지 않고 변환 코드 커밋 5개의 변경만 적용했다. 변경 범위는 웹 변환·발행/백필 호출처, `0093` DB lease, Vercel Cron, 격리 PostgreSQL 검증이다.
- 정확한 코드 근거와 이전 작업의 운영 snapshot은 `codex/matching-coverage-artifact-recovery`의 `PROGRESS-asca-507-review.md` §2026-09-28을 참조한다. 운영 snapshot은 배포 이후 결과가 아니다.

## 검증 체크리스트

- [x] `pnpm install --frozen-lockfile` — 기존 로컬 패키지 캐시로 완료
- [x] `pnpm build:packages` 및 `pnpm --filter web typecheck`
- [x] `pnpm verify:db-migrations` — 0093 포함
- [x] `pnpm test:product-postgres` — 격리 Unix socket·94 migrations·RLS, 변환 source/동시성/lease/공정성
- [x] `pnpm verify:deep-analysis-contract` — 입력 준비 호출처
- [x] `pnpm verify:package-runtime-freshness`
- [ ] `git diff --check` 및 Vercel Preview PASS
- [ ] 운영 적용 범위 승인 후 `0093` 적용 → 정확한 소스 배포 → Cron/변환 처리량 관측

## 결정과 경계

- 생산 DB 쓰기와 생산 웹 배포는 프로젝트 AGENTS.md의 별도 명시 승인 단계다. 코드/Preview 검증은 그 승인이 아니다.
- Cloud Run `cunote-conversion` 현재 구성 읽기는 `cunote-codex-dev` gcloud base 계정의 대화형 재인증 만료로 막혔다. 코드 적용 전에도 독립 변환 서버의 CPU 정책·실제 처리량은 미확인이다.
- 다른 세션의 dirty `main` 파일과 PR #18의 독립 matching campaign 준비물은 변경하지 않는다. exact19와 별도 matching-only manifest의 grant/receipt 없는 상태는 launch 권한이 아니다.
