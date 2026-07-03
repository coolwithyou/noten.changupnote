# 필수 인프라 설정 가이드 (2026-07-03 기준)

> 한 번에 처리할 수 있도록 순서대로 정리. 각 항목 끝의 ✋는 사람만 할 수 있는 것.
> 완료하면 이 문서의 체크박스를 채우고 커밋해 두면 다음 세션이 상태를 안다.

## A. GCP — Phase 2 T10 변환 서버 배포 준비 ✋

변환 서버(apps/conversion)는 DB에 직접 붙지 않는다. 필요한 건 R2 자격증명과 공유 시크릿뿐.

- [x] **A1. 프로젝트**: `changupnote-com` (조직 567880527987 소속, 결제 연결 확인) — 2026-07-03
- [x] **A2. gcloud CLI**: `sw@noten.im` 인증 + 프로젝트 설정 완료 — 2026-07-03
- [x] **A3. API 활성화**: run·artifactregistry·secretmanager + cloudbuild(빌드용 추가) — 2026-07-03
- [x] **A4. Artifact Registry**: `asia-northeast3-docker.pkg.dev/changupnote-com/cunote` 생성 — 2026-07-03
- [x] **A5. Secret Manager 5종 등록**: `CONVERSION_SHARED_SECRET`(신규 생성) + `R2_*` 4종(.env 재사용) — 2026-07-03
- [x] **A6. T10 배포**: Cloud Build(amd64) → AR push → Cloud Run `cunote-conversion`(asia-northeast3) — 실행 기록·스모크 결과는 phase2 계획 12장 참조
- [ ] **A7. 배포 후 웹앱 연결** ✋: Vercel(dev) 환경변수에 `CONVERSION_SERVER_URL`(Cloud Run URL)과 `CONVERSION_SHARED_SECRET`(`gcloud secrets versions access latest --secret=CONVERSION_SHARED_SECRET`로 조회) 추가

> **조직 정책 주의 (2026-07-03 확인)**: 조직에 Domain Restricted Sharing이 걸려 있어 `allUsers` invoker(=`--allow-unauthenticated`)가 불가하다. 대신 **`--no-invoker-iam-check`**(invoker IAM check 비활성화)로 배포해 설계대로 앱 레벨 shared secret 인증만 사용한다. 또 run.app 기본 URL에서 **`/healthz` 경로는 Google 프런트엔드가 가로채 404를 반환**하므로(컨테이너 미도달) 원격 헬스 확인은 `GET /`의 앱 401 응답으로 한다.

## B. 리뷰어 워크스페이스 (dev.changupnote.com/internal/review)

- [ ] **B1. Vercel dev 프로젝트 환경변수 확인** ✋: `R2_ACCOUNT_ID`·`R2_ACCESS_KEY_ID`·`R2_SECRET_ACCESS_KEY`·`R2_BUCKET` 4종이 dev 배포 환경에 있는지 확인, 없으면 추가 (페이지 이미지 프록시 서빙에 필요)
- [ ] **B2. 리뷰어 등록** ✋: 리뷰어들이 dev.changupnote.com에서 Google 로그인에 쓸 이메일 목록을 확정한 뒤, Supabase SQL Editor에서:
  ```sql
  insert into admin_users (email, name, role) values
    ('reviewer1@example.com', '이름1', 'support'),
    ('reviewer2@example.com', '이름2', 'support');
  ```
  (접근 게이트는 admin_users에 email 존재 + status active만 본다)
- [ ] **B3. 마이그레이션·임포트는 구현 완료 후 이쪽에서 실행** (사용자 액션 불필요 — 완료 보고에 포함)

## C. 저장소 위생 ✋

- [x] **C1. origin push**: 완료 — 2026-07-03 (34커밋)
- [x] **C2. 로컬 typecheck**: 완료 — 2026-07-03. conversion에서 선존 타입 에러 1건 발견·수정(`97925d3`), web/admin/packages 통과
- [x] **C3. 샌드박스 git 잔재 정리**: 완료 — 2026-07-03

## 이 세션과 무관하게 이미 완료된 것

- Supabase DB (0026까지 적용), R2 버킷, dev/prod 도메인·호스팅, next-auth(Google/Kakao)
