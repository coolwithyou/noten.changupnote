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

- **현재 실행 중단(2026-08-14 Gate R)**: 사용자 승인으로 `deep-v18` sequence 0~11의 exact-next 단건 실행은 완료됐고 마지막 runtime은 `paused`, 잔존 lease 0이다. 이후 매칭 준비도 정책 변경으로 해당 plan의 git provenance가 과거 checkout에 고정됐으므로 같은 plan을 계속 실행하지 않는다. `lab:smoke`, `lab:batch` non-dry, `lab:agent --execute`, 자동 대상 선정, 단건/repair, 검수·감사·confirmations의 legacy live 호출은 계속 정적 admission이 차단한다. 다음 live는 새 코드가 봉인된 새 proposal/plan과 별도 사용자 승인 뒤에만 진행한다.
- **로컬 실험실(analysis-lab)의 4레인 전부 구독 스위치를 따른다**: 추출(opus-5)·AI 검수(fable-5)·블라인드 감사(sonnet-5)·confirmations. `ANALYSIS_LAB_TRANSPORT=claude-cli` env가 스위치이고, 미설정이면 기존 API 경로(운영 무영향). 검수 레인 전환 근거는 `docs/research/2026-08-04-검수레인-구독전환-일치율-검증.md`(원문 대조 41:26 GO).
- 현재 일반 허용 명령은 `lab:batch -- --dry-run`, `lab:agent` plan-only, `lab:experiment:test`, `lab:experiment:prepare -- --series=deep-v18`, `lab:experiment:recover -- --inspect=<authority-sha256>` 같은 모델 무호출 경로뿐이다. `lab:experiment:issue`는 사용자가 exact canary를 승인한 뒤에만 approval SHA를 받아 현행 운영 증거와 paused runtime을 검증하고 단건 authority를 발급한다. recovery mutation도 비정상 종료를 확인한 별도 사용자 approval이 있을 때만 exact expired lease를 해제한다. 과거 `--max-cost-usd`는 구독에서 1회 경고 후 무시되며 active 실행 정책이나 스냅샷에는 저장하지 않는다. 승인된 live 실행은 legacy batch가 아니라 exact plan/receipt-bound `lab:experiment` Adapter가 한 target씩 소유한다.
- 2026-08-14 실제 사용된 `deep-v18` proposal은 `0da79215...`, plan은 `e150c42a...`였고 sequence 0~11이 exact receipt chain으로 종결됐다. 이 artifact는 과거 실행 증거이며 변경된 코드의 신규 live 권한으로 재사용하지 않는다.
- **매칭 후보 원칙(사용자 확정)**: 22축 전체의 완벽한 확정을 요구하지 않는다. 순수 `ambiguous`/`input_missing`만 남고 확인된 축이 2개 이상이면 `primaryValidationOutcome=publishable`, `matchingReadiness=conditional`로 기록해 확인된 조건으로 랜딩 매칭 후보에 포함한다. 확인된 축이 1개 이하이거나 unresolved 축에 criterion mismatch가 남으면 `held/deferred`로 보류한다. 확정 탈락은 공고 전체를 제외하는 값이 아니라 등록 사업자와 criterion을 비교하는 matcher가 판정한다.
- `publishable`은 deep primary 결과가 매칭·후속 검수에 사용 가능하다는 뜻이지 Kordoc 완료를 뜻하지 않는다. Kordoc은 명시적 application-roundtrip 실행과 별도 artifact가 있을 때만 완료로 본다.
- **원칙(사용자 확정)**: 고단가 모델(fable-5 등)을 API로 돌리지 않는다 — 로컬 대량 작업은 구독이 기본. 단, 구독 실행은 **로컬 dev·실험실 한정**(약관 경계) — 운영 worker·Cloud Run·사용자 대면 경로는 API 유지.
- `/dev/analysis-lab`의 기존 실행 UI와 CLI는 진행 관측·dry-run 용도로만 남고 live start는 Gate R admission에서 거부된다.
- 운용 안내 정본: `docs/explainers/구독모델로-딥분석-돌리는-법.md`; 현재 구조·재개 판정 정본: `docs/research/2026-08-14-구독-딥분석-반복실패-구조진단-및-개선-설계.md`; 최근 실패 증거: `docs/research/2026-08-13-딥분석-처리속도-트랙-리뷰-정리.md`. `HANDOFF-2026-08-03.md`는 역사 기록이다.

## 딥분석 — 운영 크론과 로컬 구독의 겹침 방지 (2026-08-04 조사 확정)

- **운영의 유료 LLM 딥분석은 자동으로 돌리지 않는다**: 2026-08-14 재인증 뒤 Cloud Run 메인 워커 generation 97을 다시 확인했다. `DEEP_ANALYSIS_WORKER_MODE=observe_only`, 안전 worker가 미설정 scope를 fail-closed `unconfigured`로 해석하며, 비종결 Cloud Run execution은 0건이다. 개발 기간에는 이를 유지하고 로컬 구독 lab도 변경된 코드가 봉인된 새 proposal과 사용자 승인 전까지 정적 admission으로 중단한다. 조사 정본: `docs/research/2026-08-04-운영-딥분석-크론과-로컬-구독-겹침-조사.md`.
- proposal/plan의 git SHA는 로컬 구독 canary를 실행할 checkout 출처이고, 운영 evidence의 `GIT_COMMIT_SHA`는 현재 배포된 Cloud Run worker 출처다. 전자는 현재 로컬 git/package/validator와, 후자는 현재 Cloud Run UID/generation/etag/image/env 및 `ec8cec75566e9ba5d07aead3837ce48501b1b6a9` safe worker contract ancestry와 각각 exact 검증하지만 서로 같은 커밋일 필요는 없다. ancestry를 로컬 checkout에서 증명할 수 없으면 fail-closed하며 자동 fetch하지 않는다. Gate R 증거를 맞추기 위해 운영 worker를 로컬 HEAD로 재배포하지 않는다.
- 로컬 LabRun과 분석 결과는 DB가 아니라 `spike-out`에 저장한다. proposal preparation과 authority issuer는 DB read-only이고, 사용자 승인 뒤의 단건 live Adapter와 비정상 종료 recovery만 exact-generation runtime lease 제어행을 갱신한다. recovery는 분석 결과나 attempt artifact를 삭제·재실행하지 않는다. 분석 결과를 서비스 DB에 쓰는 접점은 `lab:promote --write`뿐이며 3중 확인(release+write+confirm)이 걸려 있다.
- 승격 보호 구현(`c79e2c0`) 자체는 유지되지만 현재 Gate R 동안 local release `--approve`와 `lab:promote --write`는 별도 admission이 차단한다. Gate R과 exact end-to-end authority 없이 실발행하지 않는다.
- 운영 딥분석을 켤 때는(사용자 결정) `CLAIM_SCOPE=bounded`(cohort sha256 화이트리스트)로 시작하고 로컬 lab 코호트와 상호배타 집합 유지, 켜기 전 pending 큐(누적 중) 정리.
