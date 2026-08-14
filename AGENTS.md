## Imported Claude Cowork project instructions

창업노트 서비스를 개발할거야

## Development server

- 개발 서버는 사용자가 직접 띄운다.
- Codex는 명시 요청이 없는 한 `pnpm dev:web`, `pnpm dev`, `next dev` 등 장기 실행 개발 서버를 시작하지 않는다.
- 브라우저 검증이 필요하면 먼저 현재 실행 중인 서버와 포트를 확인하고, 서버가 없으면 사용자에게 실행을 요청한다.

## 관리자 전용 UI

- 관리자·검수자만 접근하는 화면은 클라이언트 서비스용 커스텀 디자인 토큰을 새로 확장하기보다 설치된 `shadcn/ui` 컴포넌트를 우선 조합한다.
- 검색·필터 폼은 `Field`/`FieldGroup`, `InputGroup`, `Select`, `Button`을 사용하고, 상태 표시는 `Badge`, 정보 묶음은 `Card`, 펼침 영역은 `Accordion`/`Collapsible`, 긴 목록은 `ScrollArea` 등 의미에 맞는 shadcn 컴포넌트를 적극 활용한다.
- 원시 `select`·임의 버튼 스타일·개별 색상값은 같은 역할의 shadcn 컴포넌트나 semantic variant가 없을 때만 사용한다.
- 공용 shadcn 기본 변형에 사용자 서비스용 TDS 시각값이 포함되어 있으면 관리자 화면은 명시적인 `admin`/`compact` variant를 사용한다. 전역 토큰이나 기본 variant를 바꿔 일반 사용자 화면에 영향을 주지 않는다.
- 관리자 화면의 전체 룩은 공식 `@shadcn` block 구성을 우선 참고한다. 클라이언트 TDS와 시각적으로 분리해야 할 때는 관리자 루트에 scoped shadcn semantic token 테마를 적용하고, Portal 표면에도 같은 테마를 전달한다.
- 관리자 데이터 표면은 넓은 테이블을 무조건 사용하지 않는다. 열 잘림이나 수평 스크롤로 핵심 작업이 가려지면 카드·목록·접힘 구조로 바꾸고, 주요 상태·첨부파일·행동 버튼이 현재 뷰포트 안에서 완결되게 한다.
- 이 원칙은 관리자 전용 화면에 한정한다. 일반 사용자 화면의 기존 디자인 시스템을 일괄 교체하거나 관리자 작업을 이유로 수정하지 않는다.

## Vercel deployment authentication

- 이 저장소의 Vercel CLI 배포는 저장소 루트의 gitignored `.env.vercel.local`을 인증 정본으로 사용한다.
- `.env.vercel.local`의 `VERCEL_CLI_TOKEN_FULL`을 현재 셸의 `VERCEL_TOKEN`으로 매핑한 뒤 Vercel 명령을 실행한다. 기본 `vercel whoami` 결과나 대화형 로그인 상태만 보고 권한이 없다고 결론내리지 않는다.
- 이 토큰은 `noten-dev` 사용자와 `NOTEN` 팀(팀 slug: `noten`)으로 확인되어야 한다. 명시적인 scope가 필요한 명령에서만 `--scope noten`을 사용한다.
- 토큰 값은 출력·커밋·명령 인자(`--token`)에 직접 넣지 않는다. 셸 환경변수로만 전달한다.
- 배포 전 `.vercel/project.json` 또는 해당 앱의 `.vercel/project.json`을 확인하고, 토큰을 적용한 `vercel whoami`와 `vercel project inspect`로 프로젝트/팀을 검증한다.
- `changupnote` 웹 프로젝트는 모노레포 루트에서 배포한다. Vercel 프로젝트의 Root Directory가 `apps/web`이므로 `apps/web`에서 배포해 `apps/web/apps/web` 경로를 만들지 않는다.
- `changupnote-ops`도 `NOTEN` 팀(팀 slug: `noten`) 소유이며 저장소 루트의 `.env.vercel.local` 토큰으로 접근한다. `apps/admin/.vercel/project.json`이 project id `prj_O71GjH8sXqXl4nNxOanOrWalfNHG`, org id `team_BJyTgrYdYTPFbzAQYqkViRAc`를 가리키는지 확인하고, 토큰을 적용한 `vercel whoami = noten-dev`와 `vercel project inspect changupnote-ops --scope noten = NOTEN/changupnote-ops`를 둘 다 확인한다.
- ops 프로젝트도 Root Directory가 `apps/admin`이므로 `apps/admin`에서 직접 배포하면 `apps/admin/apps/admin` 이중 경로가 된다. clean commit의 모노레포를 `.git`, `.env*`, `.vercel`, `node_modules`, build 산출물 없이 임시 디렉터리에 복사하고 `apps/admin/.vercel/project.json`만 임시 루트 `.vercel/project.json`으로 둔 뒤, 저장소 루트의 `.env.vercel.local` 토큰을 환경변수로 적용하여 임시 루트에서 `--scope noten`으로 배포한다.
- 프로덕션 배포는 관련 검증과 커밋·push가 끝난 정확한 소스 상태로 수행하고, 배포 URL·프로덕션 alias·라이브 스모크를 확인한다.

## GCP deep-analysis deployment authentication

- deep-analysis Cloud Build/Cloud Run/Scheduler 확인과 배포에는 전용 gcloud configuration `cunote-codex-dev`를 사용한다.
- 이 configuration의 base account는 `sw@noten.im`, project는 `changupnote-com`, region은 `asia-northeast3`이며, 실제 API 호출은 keyless impersonation으로 `cunote-codex-dev@changupnote-com.iam.gserviceaccount.com`이 수행한다.
- 서비스 계정 JSON key를 만들거나 `sw@ba-ton.kr` 계정으로 우회하지 않는다. 실행 전 `gcloud auth print-access-token --configuration=cunote-codex-dev`의 tokeninfo email이 위 전용 서비스 계정인지 확인한다.
- Cloud Build source staging은 `--gcs-source-staging-dir=gs://changupnote-com_cloudbuild/cunote-codex-dev/source`를 명시한다. 로그 스트리밍만을 위해 project Viewer나 project-wide Storage Viewer를 추가하지 않고, build 상태는 `gcloud builds describe`로 확인한다.
- 배포 대상은 `cunote-deep-analysis`, `cunote-deep-analysis-input-preparation`, `cunote-deep-analysis-serving-monitor` 세 Cloud Run Job이다. 태그가 아닌 build가 반환한 image digest를 사용하고 `GIT_COMMIT_SHA`를 exact commit으로 맞춘다.
- 메인 worker는 bounded claim gate가 별도로 통과하기 전 `DEEP_ANALYSIS_WORKER_MODE=observe_only`를 유지한다. 업데이트 후 기존 runtime service account, command/args, env와 secret 참조를 다시 읽어 보존 여부를 확인한다.

## Cloudflare access control memory

- Production hosts `changupnote.com`, `www.changupnote.com`, `dev.changupnote.com`, `ops.changupnote.com`, and `dev.ops.changupnote.com` are intentionally Cloudflare-proxied.
- Cloudflare zone id: `2b6743da9feeba07518367807bf6a7c7`.
- Current WAF custom ruleset id: `7f1e1bddf00a42f2b88da2c0cfa33467`.
- Current allowlist rule id: `350e2f8e8a964261b035b527a2f56c22`.
- Current allowlist expression: `(http.host in {"changupnote.com" "www.changupnote.com" "dev.ops.changupnote.com"} and not ip.src in {125.184.29.37/32 183.96.140.195/32})`.
- `dev.ops.changupnote.com` DNS CNAME points to the local Cloudflare Tunnel target `be924b5d-a8af-4c43-802c-cb000f391255.cfargotunnel.com`; local ingress is in `/Users/ffgg/.cloudflared/changupnote-dev.yml` and routes to `http://127.0.0.1:4011`.
- Legacy web admin block rule id: `efe33e603ce3475e80d2f0124c6f9f11`.
- Legacy web admin block expression: `(http.host in {"changupnote.com" "www.changupnote.com"} and (starts_with(http.request.uri.path, "/admin") or starts_with(http.request.uri.path, "/internal/live-match") or starts_with(http.request.uri.path, "/api/admin") or http.request.uri.path eq "/api/matches/live"))`.
- Use `.env` `CLOUDFLARE_TOKEN`; never print or commit the token.
- Use `node tools/cloudflare-ip-allowlist.mjs status` before changing access.
- To open the site quickly, run `node tools/cloudflare-ip-allowlist.mjs disable`.
- To restrict again, run `node tools/cloudflare-ip-allowlist.mjs enable` or `node tools/cloudflare-ip-allowlist.mjs restrict <CIDR...>`.
- To add/remove IPs, run `node tools/cloudflare-ip-allowlist.mjs add <CIDR...>` or `node tools/cloudflare-ip-allowlist.mjs remove <CIDR...>`.
- DNS proxy can be restored with `node tools/cloudflare-ip-allowlist.mjs proxy-on`; turning it off bypasses Cloudflare WAF.

## 딥분석 실행 경로 — 구독(claude CLI) vs API (2026-08-04 확정)

- **로컬 실험실(analysis-lab)의 4레인 전부 구독 스위치를 따른다**: 추출(opus-5)·AI 검수(fable-5)·블라인드 감사(sonnet-5)·confirmations. `ANALYSIS_LAB_TRANSPORT=claude-cli` env가 스위치이고, 미설정이면 기존 API 경로(운영 무영향). 검수 레인 전환 근거는 `docs/research/2026-08-04-검수레인-구독전환-일치율-검증.md`(원문 대조 41:26 GO).
- 대량 배치 명령(정본): `ANALYSIS_LAB_TIMEOUT_MS=900000 ANALYSIS_LAB_TRANSPORT=claude-cli ANALYSIS_LAB_MODEL=claude-opus-5 pnpm lab:batch -- --limit=30` (구독 실행의 명목 USD는 API 환산 telemetry일 뿐 실행 상한이 아니다). 검수: `ANALYSIS_LAB_TRANSPORT=claude-cli pnpm lab:ai-review -- --model=claude-fable-5 ...`. 과거 `--max-cost-usd`를 구독 명령에 넘기면 1회 경고 후 무시되며 active 실행 정책이나 스냅샷에는 저장하지 않는다.
- **원칙(사용자 확정)**: 고단가 모델(fable-5 등)을 API로 돌리지 않는다 — 로컬 대량 작업은 구독이 기본. 단, 구독 실행은 **로컬 dev·실험실 한정**(약관 경계) — 운영 worker·Cloud Run·사용자 대면 경로는 API 유지.
- 배치의 시각적 실행·관리: dev 서버 `/dev/analysis-lab` → "배치 운영" 탭(깔때기·transport 선택·진행 스트림, CLI 시작 배치도 표시). dev 웹 레인의 구독 스위치는 `apps/web/.env.development.local`(파일 삭제+재기동으로 API 복귀). **웹·CLI 배치 동시 실행 금지**(코드 가드 있음).
- 운용 안내 정본: `docs/explainers/구독모델로-딥분석-돌리는-법.md`, 트랙 상태 정본: `docs/plans/HANDOFF-2026-08-03.md`. 검수 사이드카는 모델별(`.ai-review.<model>.json`)이라 `--model=claude-fable-5` 명시 필수(기본 sonnet-5로 돌리면 전부 재검수됨).

## 딥분석 — 운영 크론과 로컬 구독의 겹침 방지 (2026-08-04 조사 확정)

- **현재 운영의 유료 LLM 딥분석은 자동으로 돌지 않는다**: Cloud Run 메인 워커가 `DEEP_ANALYSIS_WORKER_MODE=observe_only` + `CLAIM_SCOPE=unconfigured` 2단 fail-closed(하트비트만 기록). 개발 기간에는 이 상태를 유지하고 **분석은 로컬 구독 lab이 유일 경로**다. 조사 정본: `docs/research/2026-08-04-운영-딥분석-크론과-로컬-구독-겹침-조사.md`.
- 로컬 lab은 DB에 런을 쓰지 않는다(spike-out 파일). DB 쓰기 접점은 `lab:promote --write` 순간뿐이며 3중 확인(release+write+confirm)이 걸려 있다.
- ~~⚠️ 승격 전 필수 선행~~ → **P1 구현 완료(2026-08-04, 커밋 c79e2c0)**: 수집 publisher가 승격 보호(stable_key 행 존재) grant의 criteria 교체를 스킵하고, 보호 지문을 대칭 계산한다. 수동 CLI 2종(renormalize·publish-reviewed)도 tx 내 락+재판별 가드. **`lab:promote --write` 실발행 금지 조건은 해제됨** — 게이트 통과 시 실발행 가능(운용 조건: `pnpm verify:promotion-protection`이 test 체인에 배선돼 회귀를 잡는다).
- 운영 딥분석을 켤 때는(사용자 결정) `CLAIM_SCOPE=bounded`(cohort sha256 화이트리스트)로 시작하고 로컬 lab 코호트와 상호배타 집합 유지, 켜기 전 pending 큐(누적 중) 정리.
