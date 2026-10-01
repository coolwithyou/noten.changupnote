# 시연 웹 운영 배포 증거 (2026-10-01)

## 완료 조건

- [x] 승인된 clean commit 고정 및 검증된 제품 소스 동일성 확인
- [x] 인증 사용자·팀·프로젝트·Root Directory 확인
- [x] 비밀·미커밋 파일·빌드 산출물을 제외한 커밋 사본 배포
- [x] production READY 및 실제 도메인의 동일 배포 결속 확인
- [x] HTTP와 데스크톱·모바일 실제 브라우저 스모크
- [x] 배포 커밋 로컬 태그 및 증거 기록

## 소스와 인증

사용자가 exact 시연 운영 승격과 검증 웹 배포를 승인한 범위에서 웹 배포를 수행했다. API 모델 호출은 이 배포 검증에서 실행하지 않았다.

- 고정 소스: `d745bfcde9483185147e54b505dba64487288dd5`.
- 시작 시 `git status --porcelain`은 빈 값이었다. `c779614`부터 고정 소스까지 apps/packages/scripts/tools 및 package/lockfile diff는 0이었다. 기존 제품 검증은 `PROGRESS-demo-account-20261001.md`의 c779614 build/typecheck 및 관련 suite PASS를 재사용했다.
- `git archive` SHA256: `f308f2e4f43add3d23c36e27c766cf82e259423c3b805e3e8bd132f1fd64f122`.
- archive 사본에서 어느 깊이의 `.env*`, `.git`, `.vercel`, node_modules, .next, dist/build를 제외했다. 연결 정보만 사본 루트 `.vercel/project.json`에 별도로 넣었다. main checkout의 미커밋 소스는 복사하지 않았다.
- `.env.vercel.local`의 정본 인증값은 자식 프로세스 `VERCEL_TOKEN` 환경으로만 전달했다. `whoami=noten-dev`, 프로젝트 `NOTEN/changupnote`, ID `prj_KhzpbTNc9r1By4OcC9nsVKJUjnW2`, Root Directory `apps/web` 확인.
- 웹 전용 릴리스 스크립트는 없었다. 현행 CLAUDE의 직접 CLI 배포 경로를 사용하되, 인증 전달은 더 최신 AGENTS의 환경변수 규칙을 따랐다. `--token`과 main push는 사용하지 않았다.
- 로컬 태그: `deploy-web-20261001-d745bfc` → 고정 소스 SHA. remote push 없음.

명령: 모노레포 사본 루트에서 `vercel deploy --prod --yes --scope noten --meta sourceCommit=d745bfcde9483185147e54b505dba64487288dd5`.

## 배포와 도메인

- deployment ID: `dpl_CjpptvL6qj3H5zNjcp4tGDyVZrj6`.
- URL: [production deployment](https://changupnote-htvw4x625-noten.vercel.app).
- [Vercel inspect](https://vercel.com/noten/changupnote/CjpptvL6qj3H5zNjcp4tGDyVZrj6).
- 서버 응답의 `sourceCommit` 메타데이터는 고정 소스 SHA와 일치했다.
- remote build의 contracts/core 빌드, WASM 복사, Next 컴파일·TypeScript·static 5페이지 생성 PASS. 동적 파일 추적 관련 NFT warning 4건은 build 실패가 아니었다.
- target `production`, readyState `READY`.
- `inspect https://changupnote.com --json`은 동일 deployment ID와 READY를 반환했다. aliases: `changupnote.com`, `www.changupnote.com`, `changupnote.vercel.app`, `changupnote-noten.vercel.app`.

CLI 절차는 [Vercel 공식 deploy 문서](https://vercel.com/docs/cli/deploy)를 확인했다.

## 실제 스모크

2026-10-01 KST 배포 후 [changupnote.com](https://changupnote.com)에서 확인했다.

| 요청 | 응답 | 확인 |
|---|---:|---|
| `/` | 200 | HTML 제목·실제 홈 렌더링 |
| `/login` | 200 | HTML 제목·로그인 버튼 클릭 후 화면 렌더링 |
| `/api/auth/session` | 200 | 익명 세션 JSON 2 bytes |
| `/rhwp_bg.wasm` | 200 | application/wasm, 8,038,570 bytes |

WASM SHA256: `e09e8463291f3aded87bb8febdd21610e80b5159329666f114329e10195ea229`.

별도 agent-browser 세션에서 1440×1000 및 390×844 홈 화면, 390×844 로그인 화면을 캡처하고 직접 확인했다. 두 홈 viewport의 document scrollWidth는 각각 1440/390으로 가로 넘침이 없었다. 브라우저 errors 조회는 비어 있었다. 검증 세션은 종료했다.

- [홈 데스크톱](web-deployment-20261001/landing-1440.png)
- [홈 모바일](web-deployment-20261001/landing-390.png)
- [로그인 모바일](web-deployment-20261001/login-390.png)

이 증거는 웹 배포와 익명 진입 검증이다. 로그인 후 exact 공고의 승격 결과·자동입력·문안 생성·저장·다운로드 시연 인수는 별도 담당의 실제 계정 검증 범위다.
