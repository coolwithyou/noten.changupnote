# 필수 인프라 설정 가이드 (2026-07-03 기준)

> 한 번에 처리할 수 있도록 순서대로 정리. 각 항목 끝의 ✋는 사람만 할 수 있는 것.
> 완료하면 이 문서의 체크박스를 채우고 커밋해 두면 다음 세션이 상태를 안다.

## A. GCP — Phase 2 T10 변환 서버 배포 준비 ✋

변환 서버(apps/conversion)는 DB에 직접 붙지 않는다. 필요한 건 R2 자격증명과 공유 시크릿뿐.

- [ ] **A1. 프로젝트**: GCP 콘솔에서 새 프로젝트 생성 (예: `cunote-prod`), 결제 계정 연결
- [ ] **A2. gcloud CLI**: 로컬에 설치 후 `gcloud auth login` + `gcloud config set project <PROJECT_ID>`
  (Owner 계정으로 직접 배포하므로 서비스 계정 키 발급 불필요. CI 도입 시 그때 SA 생성)
- [ ] **A3. API 활성화**:
  ```bash
  gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
  ```
- [ ] **A4. Artifact Registry** (서울 리전):
  ```bash
  gcloud artifacts repositories create cunote --repository-format=docker --location=asia-northeast3
  ```
- [ ] **A5. Secret Manager에 시크릿 등록** (값은 저장소 `.env`의 R2_* 재사용, 공유 시크릿은 신규 생성):
  ```bash
  openssl rand -hex 32   # CONVERSION_SHARED_SECRET 값 생성
  for s in CONVERSION_SHARED_SECRET R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
    printf '<값>' | gcloud secrets create $s --data-file=-
  done
  ```
- [ ] **A6. 배포 자체는 협업 세션에서** (T10): Docker 빌드 → AR push → Cloud Run 배포 → 프로덕션 스모크 + 시드 5건 왕복. 이 세션에서 커맨드를 준비해 드림
- [ ] **A7. 배포 후 웹앱 연결**: Vercel(dev) 환경변수에 `CONVERSION_SERVER_URL`(Cloud Run URL)과 `CONVERSION_SHARED_SECRET` 추가

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

- [ ] **C1. origin push**: 로컬 main이 origin보다 다수 커밋 앞섬. 라벨·기준서·리뷰 GUI가 전부 로컬에만 있는 상태 — 유실 위험이자 협업 차단 요인. 최우선
- [ ] **C2. 로컬 typecheck**: `pnpm install` 후 `@cunote/conversion`·`@cunote/web` typecheck (샌드박스는 macOS 바이너리 문제로 불가)
- [ ] **C3. (선택) `.git/stale-locks/`·`.git/objects/*/tmp_obj_*` 잔재 정리**: 로컬에서 `rm -rf .git/stale-locks && find .git/objects -name 'tmp_obj_*' -delete`

## 이 세션과 무관하게 이미 완료된 것

- Supabase DB (0026까지 적용), R2 버킷, dev/prod 도메인·호스팅, next-auth(Google/Kakao)
