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

## 문항 AI 작성 활성화 revision

전체 기능 시연·운영 웹 배포·이번 API 합산 $20 상한의 사용자 승인 범위와 루트의 GO를 받아, 정상 기능 플래그 `CUNOTE_WRITING_SECTION_AGENT_ENABLED`만 production에 활성화했다. 특정 사업자·공고 예외나 제품 소스 변경은 없다. 다른 환경변수·키는 변경하지 않았다.

사전 read-only 조사에서 이 플래그는 production에 없었다. 서버 기본값은 false이고 `1` 또는 `true`만 활성 값이다. 문항 GET의 canGenerate는 쓰기 권한과 플래그로 결정되며 UI는 현재 양식에서 연결된 문항에만 버튼을 보여준다. 생성 POST는 기존 회사 쓰기 권한·문서 소유 회사·RLS·revision·원문/필드 binding을 적용한다. composer는 기존 회사별 예산 확인과 사용량 원장을 쓰며 현재 문안을 직접 덮어쓰지 않는다. 루트가 별도로 `sectionComposer.test.ts` PASS(session62610)와 기존 migration97 권한/RLS/CAS/독립 플래그 증거를 확인한 후 실행했다.

공식 [환경변수 CLI 문서](https://vercel.com/docs/cli/env) 및 설치 CLI help를 확인하고 다음 일반 경로를 실행했다.

1. `vercel env add CUNOTE_WRITING_SECTION_AGENT_ENABLED production --value true --no-sensitive --yes --scope noten`: 추가 성공.
2. `vercel env run -e production --scope noten -- python3 ...`: 자식 환경의 해당 플래그 하나만 조회해 `value=true`, `enabled=true` 확인. 비밀값은 출력하거나 파일에 보관하지 않았다.
3. 동일 exact git archive를 새 사본에 추출하고 `vercel deploy --prod --yes --scope noten --meta sourceCommit=d745bfcde9483185147e54b505dba64487288dd5 --meta deploymentRevision=section-ai-enabled` 실행.

archive SHA는 최초 배포와 같은 `f308f2e4f43add3d23c36e27c766cf82e259423c3b805e3e8bd132f1fd64f122`이고 당시 HEAD와 제품 소스 diff도 0이었다. 임시 사본의 제외 규칙·프로젝트 연결·환경 인증 전달은 최초 배포와 동일하다.

- 새 deployment: `dpl_8oT3DKnTg67YrJvR9un9UJrqAHpc`, [production URL](https://changupnote-7csgqvp24-noten.vercel.app).
- [Vercel inspect](https://vercel.com/noten/changupnote/8oT3DKnTg67YrJvR9un9UJrqAHpc), target production, READY.
- REST metadata sourceCommit은 exact `d745bfcde9483185147e54b505dba64487288dd5`, deploymentRevision은 `section-ai-enabled`였다.
- 도메인 재inspect 결과 changupnote.com은 새 ID/READY와 일치했다. www 및 두 Vercel aliases도 동일 배포에 결속됐다.
- 원격 build의 compile·TypeScript·static5 PASS. 기존 동적 추적 NFT warning3건.
- 새 alias의 `/`, `/login`, `/api/auth/session` GET 200 확인.
- 새 로컬 태그: `deploy-web-20261001-d745bfc-section-ai` → exact 소스 SHA. main/태그 remote push 없음.

여기까지는 플래그 설정·새 배포·도메인 결속 증거다. 로그인 후 실제 canGenerate/문항 AI 버튼과 모델 품질·원문 반영 인수는 루트가 동일 $20 원장을 순차 관리하며 수행한다. 배포 담당 모델 호출은 0회다.

## 필드 결속·문항 생성 최종 안전 수정 배포

루트의 검증 완료 GO 후 exact 소스 `139f5f1bb8dc31a01cc38c4979994b53d4ec04c6`를 배포했다. 시작 checkout은 clean이었다. 이 소스에는 `39d8319`의 원문 라벨 순번/숫자 단위 셀 결속 안전 수정과 `139f5f1`의 문항 생성 실패 진단/출처 작성 규칙 수정이 함께 포함된다. 루트가 document-agent suite·writing-context suite·TypeScript 및 최종 build(session61137 compile/typecheck/static PASS)를 검증했고, 배포는 고정 커밋 archive로 수행했다.

### Studio 분리 확인

`RhwpStudioSurface.tsx`는 `use client`이고 export한 원문을 호스트의 WASM HwpDocument로 다시 열어 `resolveRhwpFieldAnchorsExact` 또는 `resolveStudioFieldBindings`를 호출한다. 후자의 표 셀 결속도 같은 `fieldAnchors.ts`를 호출한다. 따라서 변경된 target resolver는 Cunote 웹 번들에 포함되며 iframe Studio의 native 명령에 exact target을 전달한다. 이번 수정에는 별도 Studio·SDK·WASM 변경이나 배포가 필요하지 않았다.

참고로 read-only 조사한 실제 Studio 프로젝트는 NOTEN의 `changupnote-rhwp-studio` / `prj_FFlmBcmhSSMvsczZ2vPAv0oyPLj3`, Root Directory `.`이다. rhwp checkout의 로컬 `rhwp-studio/.vercel/project.json`은 과거 별도 project ID를 가리켜 현재 alias의 연결 정본으로 쓸 수 없었다. 실제 Studio alias는 `dpl_FKVLqzWxqpV9QjdieWMykh1yTkun` READY였고 이 배포에서 변경하지 않았다.

### 배포 결과

- archive SHA256: `034df0185b4f86fb097d39beb87632facea6f8db6f1c9e062045e6b9f86f97d7`. 최초와 동일한 제외 규칙으로 새 커밋 사본을 만들었다.
- production 플래그는 공식 env run으로 `true`/enabled를 재확인했다. 이번 revision의 환경변수 쓰기는 0회다.
- deployment: `dpl_PjjfQPfU95ohntK67EsGLRmbkw1j`, [production URL](https://changupnote-w6ya7s7cn-noten.vercel.app), [inspect](https://vercel.com/noten/changupnote/PjjfQPfU95ohntK67EsGLRmbkw1j).
- READY/production, REST metadata exact sourceCommit `139f5f1bb8dc31a01cc38c4979994b53d4ec04c6`, deploymentRevision `native-binding-section-safety` 확인.
- `inspect changupnote.com` 재조회에서 동일 ID/READY 확인. www 및 두 Vercel aliases도 같은 배포에 결속됐다.
- remote build compile·TypeScript·static5 PASS. 기존 동적 추적 NFT warning4건.
- live `/`, `/login`, `/api/auth/session`, `/rhwp_bg.wasm` GET 200. WASM 8,038,570 bytes와 최초 기록 SHA가 동일했다.
- 로컬 태그 `deploy-web-20261001-139f5f1`은 exact 소스를 가리킨다. main/태그 remote push와 모델 호출은 0회다.

새 배포 READY 즉시 루트에 전달했다. 로그인 후 실제 문항 생성 결과·52개 unique/14개 fail-closed 원문 결속·원문 반영의 최종 인수는 루트의 실제 계정 검증으로 별도 기록한다.

## 원문 인용 공백 정규화 수정 배포

exact source `e09df5d48bdbd3fc979baa2867e36b2f53472921`를 배포했다. 수정은 quoteExists 호출자의 원문 공백 정규화 계약 적용이다. 루트가 실제 exact quote 회귀와 잘못된 source ID/의역 거부 테스트 및 전체 writing-context suite·TypeScript PASS를 확인했다. 제품 소스의 미커밋 diff는 없었고, 별도 세션의 실패 화면 artifact는 사본에 섞지 않았다.

- archive SHA256: `a7e5e6ed48e5d58a8c5d856bba07538c4cfd404c3296826532f7d286a9c48f46`, 동일 제외 규칙의 커밋 사본.
- 최종 deployment: `dpl_Hz2ndpkiTRbp8xJHhAauXQY9xGHP`, [production URL](https://changupnote-poz51596w-noten.vercel.app), [inspect](https://vercel.com/noten/changupnote/Hz2ndpkiTRbp8xJHhAauXQY9xGHP).
- READY/production, REST sourceCommit이 exact SHA와 일치, deploymentRevision `quote-whitespace-safety` 확인.
- changupnote.com 재inspect는 같은 ID/READY. www와 두 Vercel aliases도 일치.
- 원격 compile·TypeScript·static5/build PASS. 기존 NFT warning3건.
- 공식 env run으로 운영 문항 AI 플래그 `true` 재확인. 환경변수·Studio·키 변경과 배포 담당 모델 호출은 0회다.
- 기존 `CunoteDeploySmoke/1.0` User-Agent의 홈/login/auth session GET 200. 기본 Python User-Agent 요청은 403을 반환해 동일 smoke 조건으로 재확인했다.
- 로컬 태그 `deploy-web-20261001-e09df5d` → exact SHA.

최초 배포 시 sourceCommit 메타데이터 전체 SHA의 기입 오류를 발견했다. 업로드 소스 자체는 exact archive였지만 메타데이터 무결성을 위해 빌드 `dpl_41ac4EbdMfGYYKZ5mXmEkdGFNFPU`를 운영 alias 전환 전에 공식 cancel API로 취소하고 `CANCELED` 응답을 확인했다. 이 빌드를 인수 증거로 사용하지 않고 새 배포의 메타데이터를 다시 exact 대조했다. 최종 READY/alias 결과는 실제 문항 재인수 담당 루트에 즉시 전달했다.
