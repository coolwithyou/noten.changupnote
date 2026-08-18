## Imported Claude Cowork project instructions

창업노트 서비스를 개발할거야

## 승인 범위 지속성과 재확인

- 사용자의 명시적 승인은 `목표 + exact 대상 + 허용한 최대 변경 단계`의 범위로 해석한다. 그
  범위는 목표가 완료되거나 사용자가 중단·변경할 때까지 유지되며, 네트워크 중단, 실패한
  불변 산출물의 상위 revision, 같은 구현의 재시도만으로 새 승인을 요구하지 않는다.
- 다시 확인하는 경우는 대상·데이터·외부 시스템·사용자 노출·쓰기 위험 상한이 승인 범위를
  실질적으로 벗어날 때뿐이다. 단지 새 commit/hash/release ID가 생겼다는 이유만으로 반복
  승인을 추가하지 않는다. 새 식별자는 기존 exact 결속과 동일한지 검증해 범위를 이어간다.
- 시스템 내부의 준비자/검수자/승인자/실행자 역할 분리는 사용자 재승인과 구분한다. 사용자가
  승인한 범위 안의 역할 분리 단계는 추가 질문 없이 수행한다.
- 과거의 더 엄격한 실험 규칙은 그 실험의 live 실행에만 적용한다. 해당 규칙을 관련 없는
  읽기·오프라인 검증·release 처리·일반 개발 작업으로 확대하지 않는다.

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

## 딥분석 권한 종류 분리 (2026-08-18 런칭 정책)

- **Gate R은 live 모델 실행 전용이다.** 모델 호출, 신규/대체 cohort 선정, 실행 lease, 비정상
  종료 recovery처럼 모델 실행을 시작·재개하는 작업에만 적용한다. 과거 exact 실험은 target별
  authority를 보존하지만, 런칭 batch는 exact manifest 전체에 대한 사용자 승인 한 번과
  `analysis-launch-grant-v1` 하나를 사용한다. 같은 manifest의 target별·sequence별 재승인이나
  15분 approval 만료를 만들지 않는다.
  읽기 전용 조사, 오프라인 테스트, 이미 봉인된 receipt를 소비하는 release 처리에 Gate R의
  target별 승인 규칙을 전이하지 않는다.
- **exact release 처리 권한은 범위로 유지한다.** 사용자가 exact grantId/run/source revision과
  처리 상한(예: `release approve까지`)을 승인하면 `prepare → aggregate → shadow → dry-run →
  release approve`가 하나의 연속 범위다. immutable gate 실패로 같은 cohort의 상위 release
  revision을 만들 때 같은 grant/run, 분석 input, attachment manifest, promotion plan, 현재 DB
  snapshot 결속이 모두 같으면 새 사용자 승인을 묻지 않고 기존 범위를 이어간다. source
  provenance hash만 갱신된 경우에는 current revision으로 다시 봉인하고, 이들 material binding
  중 하나가 바뀌거나 cohort/run이 달라질 때만 새로운 exact 범위로 취급한다.
- **CLI의 준비자/승인자 분리는 사용자 재승인이 아니다.** `lab:release --approve`의 다른 actor는
  자기 승인 방지를 위한 원장 역할 분리이며, 승인된 처리 범위 안에서 수행한다.
- **실제 서비스 변경은 별도다.** `lab:promote --write`, 배포, Cloudflare 변경, 운영
  `observe_only` 해제는 release 준비·gate·approve 권한에 포함되지 않으며 각각 명시적 사용자
  승인이 필요하다. 반대로 이 쓰기 경계 때문에 그 이전 단계에 반복 승인을 추가하지 않는다.

## 딥분석 모델 실행 경로 — 구독(claude CLI) vs API (2026-08-18 런칭 전환)

- **현재 런칭 실행 경계**: 정식 대량 실행은 `lab:launch:prepare → lab:launch:grant → lab:launch`를
  사용한다. prepare는 exact allowlist의 현재 input/attachment SHA, model/prompt/validator/package
  runtime, Kordoc 포함 여부와 동시성을 content-addressed manifest로 봉인한다. 사용자가 이 manifest
  범위를 승인한 뒤 grant를 한 번 기록하며, 실행은 manifest 전체를 하나의 DB runtime lease 아래
  연속 처리한다. 전체 git SHA는 관측 telemetry이고 unrelated commit 변화만으로 재봉인하지 않는다.
  package runtime·validator·prompt 같은 material execution contract가 바뀌면 새 manifest가 필요하다.
- **대상 오류 격리**: target의 `held`, non-publishable, 현재 input/attachment drift, source unavailable,
  Kordoc partial/held, 개별 timeout·응답 오류는 해당 target을 `held|failed`로 종결하고 다음 target을
  계속한다. 임의 대체 target은 넣지 않는다. manifest/grant 손상, Max 인증 공통 preflight 실패,
  DB runtime lease 충돌·상실, 프로세스 abort, Max window 소진처럼 공유 실행 무결성이 깨질 때만
  cohort 전체 신규 착수를 중단한다. 품질 비율·구조화 비율·명목 비용은 telemetry이며 실행 admission이 아니다.
- `deep-repair-experiment`의 exact-next parent receipt와 통계 evaluator는 deep-v18~v22 역사 receipt
  검증·recovery에 보존한다. 신규 런칭 batch의 진행 gate나 target별 재승인으로 사용하지 않는다.
  `lab:smoke`, generic `lab:batch` non-dry, `lab:agent --execute`, 검수·감사·confirmations의 legacy live
  호출은 계속 정적 admission이 차단되고, 검증된 launch capability 안에서만 batch core가 열린다.
- **로컬 실험실(analysis-lab)의 4레인 전부 구독 스위치를 따른다**: 추출(opus-5)·AI 검수(fable-5)·블라인드 감사(sonnet-5)·confirmations. `ANALYSIS_LAB_TRANSPORT=claude-cli` env가 스위치이고, 미설정이면 기존 API 경로(운영 무영향). 공용 transport는 매 실행 scope의 첫 모델 요청 전 `claude auth status --json`이 `claude.ai/firstParty/max`임을 증명하지 못하면 모델 착수 0회로 종료한다. 검수 레인 전환 근거는 `docs/research/2026-08-04-검수레인-구독전환-일치율-검증.md`(원문 대조 41:26 GO).
- 현재 일반 허용 명령은 `lab:batch -- --dry-run`, `lab:agent` plan-only, `lab:experiment:test`,
  `lab:experiment:prepare -- --series=deep-v23`, `lab:roundtrip:preflight`,
  `lab:experiment:recover -- --inspect=<authority-sha256>`, `lab:launch:prepare` 같은 모델 무호출 경로다.
  `lab:launch:grant`는 사용자가 출력된 exact manifest 범위를 승인한 뒤 실행하고, 같은 grant의
  `lab:launch -- --retry-errors`는 동일 material binding의 실패 target 재시도이므로 새 승인을 요구하지 않는다.
  `lab:experiment:issue`와 `lab:roundtrip:canary`는 승인된 exact cohort 안에서 현행 운영 증거와
  paused runtime을 검증해 한 target씩 실행한다. recovery mutation은 비정상 종료를 확인한 별도
  사용자 approval이 있을 때만 exact expired lease를 해제한다. 과거 `--max-cost-usd`는 구독에서
  1회 경고 후 무시되며 active 실행 정책이나 스냅샷에는 저장하지 않는다.
- **정식 출시 전환 코호트(2026-08-17, 역사 범위)**: `deep-v22` 준비는 과거 formal 표본뿐 아니라 기존 로컬
  딥분석·Kordoc 이력 전체를 제외한다. 층화된 30건 계획은 evaluator 호환을 위해 유지하되 첫 10건은
  보관 원문 SHA가 일치하고 실제 Kordoc 신청 양식 probe가 통과하며 초기 복잡도 상한 안인 후보로
  정렬한다. 실제 live 범위는 사용자가 승인한 exact 첫 10건까지만이며 나머지 20건은 자동 권한이 아니다.
  각 publishable deep receipt 뒤에만 같은 공고의 Kordoc preflight/canary를 결속했다. seq 0~9의
  단건 receipt chain은 그대로 역사·release 증거로 유지하고 새 launch manifest로 재실행하지 않는다.
- **deep-v23 신규 모집단 층화(2026-08-18 승인)**: 전체 과거 이력을 계속 제외한다. 그 결과 현재
  `bizinfo/thick`과 `kstartup/thick` 비중복 재고가 모두 0건이므로 `deep-repair-strata-v3`는
  `bizinfo/medium`, `bizinfo/thin`, `kstartup/medium`, `kstartup/thin` 4층을 첫 15건의 필수
  커버리지로 둔다. thick 두 층은 새 비중복 재고가 유입되면 선택 가능한 optional 층이며, 이를 위해
  과거 target을 다시 편입하지 않는다. v1의 6층과 v2의 5층 의미는 변경하지 않는다.
- `deep-v20`은 `deep-repair-strata-v2`를 사용한다. 2026-08-15 실측에서 현재 유효·비중복 후보 551건은 충분했지만 `kstartup/thick`은 과거 표본이 현행 재고 7건을 모두 소진했다. v2는 나머지 5층을 첫 15건의 필수 커버리지로 두고, `kstartup/thick`은 새 재고가 있을 때 포함 가능한 선택 층으로 유지한다. 과거 v1 계획의 6층 의미는 변경하지 않는다.
- 2026-08-14 실제 사용된 `deep-v18` proposal은 `0da79215...`, plan은 `e150c42a...`였고 sequence 0~11이 exact receipt chain으로 종결됐다. 이 artifact는 과거 실행 증거이며 변경된 코드의 신규 live 권한으로 재사용하지 않는다.
- 2026-08-15 `deep-v19` proposal `6d8eb80a...`, plan `63ee3bb8...`의 sequence 0~9를 순차 종결했다. 10건 모두 기록상 `claude-cli`였지만, 당시 자식 프로세스가 루트 `.env`의 `ANTHROPIC_API_KEY`를 상속한 결함이 있었으므로 이 필드만으로 Max 구독 과금을 증명할 수 없다. Anthropic Console 로그와 실행 시각이 일치한 Kordoc sequence 1은 API 과금 경로로 취급하고, 같은 pre-fix Adapter로 실행한 deep-v19·Kordoc 전체도 Billing 대조 전까지 API 과금 위험 범위로 본다. 이후 공용 transport에서 API credential·provider override를 자식 환경에서 제거했고, 첫 모델 요청 전 `claude.ai/firstParty/max` 인증을 증명하는 preflight를 회귀 테스트로 고정했다. publishable 9건의 Kordoc preflight는 ready 5·not_applicable 1·source_unavailable 3으로 분류했다. sequence 7은 receipt `2503e071...`, sequence 1은 receipt `dd5db646...`로 complete, sequence 3은 receipt `f1ddb830...`, sequence 6은 receipt `06ce82ce...`, sequence 0은 receipt `d47cb185...`로 partial 종결했다. sequence 1은 exact HWPX 2개·구조 필드 408개에서 추천 입력 180개, 미해결·구조 경고 0을 확보해 보정된 수렴 규칙의 실제 적용을 확인했다.
- **매칭 후보 원칙(사용자 확정)**: 22축 전체의 완벽한 확정을 요구하지 않는다. 순수 `ambiguous`/`input_missing`만 남고 확인된 축이 2개 이상이면 `primaryValidationOutcome=publishable`, `matchingReadiness=conditional`로 기록해 확인된 조건으로 랜딩 매칭 후보에 포함한다. 확인된 축이 1개 이하이거나 unresolved 축에 criterion mismatch가 남으면 `held/deferred`로 보류한다. 확정 탈락은 공고 전체를 제외하는 값이 아니라 등록 사업자와 criterion을 비교하는 matcher가 판정한다.
- `publishable`은 deep primary 결과가 매칭·후속 검수에 사용 가능하다는 뜻이지 Kordoc 완료를 뜻하지 않는다. Kordoc은 명시적 application-roundtrip 실행과 별도 artifact가 있을 때만 완료로 본다.
- **Kordoc 반복 보류 원칙(2026-08-15)**: 동일 후보를 독립 판정 2회 모두 `is_user_input=true`, confidence 0.65 이상으로 판단하지만 확정 임계 0.75에 못 미치면 값을 추정하지 않는 optional 사용자 확인 입력으로 보존한다(`37b7afc`). 전역 입력·거절 임계값은 0.75로 유지하고, 저신뢰 `is_user_input=false`는 자동 제외하지 않고 기존 review 상태를 유지한다.
- **Kordoc 코호트 진행 판정(2026-08-18 런칭 정책)**: 신청서 한 건의 품질 상태와 코호트 진행 verdict를
  분리한다. 정확한 위치를 확정할 수 없어 입력 대상에서 안전하게 제외한 구조 경고는
  `status=partial`, `targetDisposition=conditional`, `cohortVerdict=CONTINUE`로 기록한다. 미해결
  후보·불완전 재판정·문서별 분석 실패는 해당 target을 `held`로 격리하고 다음 exact target을
  계속한다. 이 target들은 release/promotion 대상이 아니다. 개별 source/input/attachment drift와
  개별 timeout·HTTP·invalid response도 target 실패로 격리한다. manifest/grant 자체의 불일치,
  공통 Max 인증 실패, lease 상실, Max window 소진처럼 모든 잔여 target에 영향을 주는 공유 실행
  경로의 신뢰를 잃은 경우에만 `cohortVerdict=STOP`으로 전체 신규 착수를 중단한다. 기존
  immutable receipt는 수정·삭제하지 않으며 새 정책 적용을 위해 같은 모델 분석을 재실행하지 않는다.
- **Kordoc release admission(2026-08-17)**: release의 application precompute는 LabRun 내부 참조를
  추정하지 않고 `deep terminal receipt → Kordoc proposal execution target → v3 canary receipt`를
  exact 검증한다. legacy v2 canary는 current ancestry에서 검증되는
  `application-roundtrip-canary-policy-receipt-v1`이 있을 때만 같은 경로로 정규화한다. proposal의
  grant/sequence/deep receipt/source SHA와 canary의 run/artifact SHA가 모두 같고
  `ready|conditional/CONTINUE`인 target만 release evidence에 봉인한다. `held`는 제외하고
  `blocked/STOP`, hash·provenance 불일치, 동일 deep receipt의 admission 중복은 fail-closed한다.
  Kordoc 결속이 필수인 exact release prepare는 `--require-kordoc`을 사용한다. 재시도 때문에 같은
  deep sequence의 역사 terminal receipt가 여러 개면 후속 sequence가 parent로 채택한 유일한 최장
  chain만 사용하며, 같은 최종 sequence까지 둘 이상의 branch가 이어지면 임의 선택하지 않는다.
- **원칙(사용자 확정)**: 고단가 모델(fable-5 등)을 API로 돌리지 않는다 — 로컬 대량 작업은 구독이 기본. 단, 구독 실행은 **로컬 dev·실험실 한정**(약관 경계) — 운영 worker·Cloud Run·사용자 대면 경로는 API 유지.
- `/dev/analysis-lab`의 기존 실행 UI와 generic CLI는 진행 관측·dry-run 용도로만 남고 live start는
  Gate R admission에서 거부된다. 런칭 live start의 유일한 일반 경로는 승인된 `lab:launch`다.
- 운용 안내 정본: `docs/explainers/구독모델로-딥분석-돌리는-법.md`; 현재 구조·재개 판정 정본: `docs/research/2026-08-14-구독-딥분석-반복실패-구조진단-및-개선-설계.md`; 최근 실패 증거: `docs/research/2026-08-13-딥분석-처리속도-트랙-리뷰-정리.md`. `HANDOFF-2026-08-03.md`는 역사 기록이다.

## 딥분석 — 운영 크론과 로컬 구독의 겹침 방지 (2026-08-04 조사 확정)

- **운영의 유료 LLM 딥분석은 자동으로 돌리지 않는다**: Cloud Run main worker는
  `DEEP_ANALYSIS_WORKER_MODE=observe_only`를 유지한다. 배포·worker 설정 변경 때 이 계약을 다시
  확인하되, 변경 없는 로컬 launch의 매 target·매 재시도마다 gcloud 인증과 generation을 반복
  검사하지 않는다. 각 launch 시작에서는 DB runtime `paused`, owner/expiry 없음, active deep/application
  lease 0을 한 snapshot으로 읽고 cohort 전체에 exact-generation lease 하나를 획득한다. 조사 정본:
  `docs/research/2026-08-04-운영-딥분석-크론과-로컬-구독-겹침-조사.md`.
- proposal/plan의 git SHA는 로컬 구독 canary를 실행할 checkout 출처이고, 운영 evidence의 `GIT_COMMIT_SHA`는 현재 배포된 Cloud Run worker 출처다. 전자는 현재 로컬 git/package/validator와, 후자는 현재 Cloud Run UID/generation/etag/image/env 및 `ec8cec75566e9ba5d07aead3837ce48501b1b6a9` safe worker contract ancestry와 각각 exact 검증하지만 서로 같은 커밋일 필요는 없다. ancestry를 로컬 checkout에서 증명할 수 없으면 fail-closed하며 자동 fetch하지 않는다. Gate R 증거를 맞추기 위해 운영 worker를 로컬 HEAD로 재배포하지 않는다.
- 로컬 LabRun과 분석 결과는 DB가 아니라 `spike-out`에 저장한다. launch prepare는 DB/R2 read-only이고,
  승인된 launch 실행은 cohort 전체 DB runtime lease 제어행만 갱신한다. target receipt와 최종
  `analysis-launch-receipt-v1`은 로컬 immutable artifact다. 분석 결과를 서비스 DB에 쓰는 접점은
  `lab:promote --write`뿐이며 3중 확인(release+write+confirm)이 걸려 있다.
- 승격 보호 구현(`c79e2c0`)은 유지한다. local release prepare/gate/approve는 Gate R이 아니라
  receipt 기반 promotion admission과 승인된 exact release 범위를 따른다. `lab:promote --write`는
  실제 서비스 변경이므로 별도 명시 승인이 없으면 실행하지 않는다.
- K-Startup 상세 재수집에서 `detail.fetched_at` 같은 관측 메타데이터만 바뀐 경우 raw payload와
  rawHash를 다시 쓰지 않는다. 최신 관측 시각은 `grant_raw.collected_at`으로 기록하고, 신청 방법,
  제출서류, 첨부 등 실제 상세 내용이 달라진 경우에만 source revision을 전진시킨다.
- 운영 딥분석을 켤 때는(사용자 결정) `CLAIM_SCOPE=bounded`(cohort sha256 화이트리스트)로 시작하고 로컬 lab 코호트와 상호배타 집합 유지, 켜기 전 pending 큐(누적 중) 정리.
