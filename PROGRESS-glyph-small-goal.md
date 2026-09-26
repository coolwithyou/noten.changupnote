# 글리프의 실제 추천 흐름 완성

## 목표와 완료 조건

2026-09-26 사용자 승인으로 작업 방향을 전환했다. 기존 원문과 회사 정보를 활용해
글리프가 성수를 검토할 이유·원문 근거·남은 확인 사항을 사용자 화면에서 볼 수 있게 만든다.
후보 발견과 자격 확정을 구분하며, 분석·검수 HOLD를 통과로 바꾸지 않는다.
회사·공고 ID를 하드코딩하거나 미확인 회사 사실을 대신 답하지 않는다.

### 현재 작업 — 원문 근거가 있는 검토 후보

- [x] 기존 discovery 목록·상세 경로를 재사용해 일반화 가능한 원문 근거 전달 구현.
  검증: 현재 DB/R2 봉인 입력과 DTO/서비스 소비 경로 대조, 특정 공고 ID 분기 없음.
- [x] 후보·회사 사실·원문 발췌·추가 확인 사항을 자격 확정과 구분하여 표시.
  검증: 실제 상세 컴포넌트 SSR, 발견 근거 3건의 `satisfied=0`, 점수 숨김.
- [x] 성수·언론홍보·로켓십·기간 종료로 누락/오확정 확인.
  검증: 현재 Glyph 계정의 동일 서버 로더 읽기 전용 조회와 원문 fixture 테스트.
- [ ] 실제 계정 화면 검증 및 변경 범위 검증·커밋.
  검증: 실제 로그인·후보→상세 원문/회사 비교; 미실행 층은 명시.
- 실행 서버: 2026-09-26 현재 창업노트 dev server 없음. AGENTS의 사용자 직접 실행 규칙에
  따라 `cunote-coverage-review`에서 `pnpm dev:web` 시작과 주소를 비동기로 요청했다.
  이 응답을 기다리며 구현·서버 없는 검증을 계속한다.
- `2b7ce11e...` 보정 명세는 이번 작업의 실행 대상이 아니다. 추가 모델 호출·운영 DB 변경·
  배포 없이 구현부터 완성한다. 운영 적용은 구체적인 결과가 준비된 뒤 승인 경계를 따른다.
- 아래 9/25 실행/보정 기록은 역사이며 현재 진행 순서는 이 절이 우선한다.

### 2026-09-26 로컬 인수 증거

- `spike-out/glyph-small-goal-20260925/inspect-discovery-detail.ts`로 현재 Glyph 소유
  회사 범위의 `loadServiceApplySheet`를 읽기 전용 실행했다. 성수 931ms, 언론홍보 333ms,
  로켓십 732ms (각 1회, 로컬 서버 경로, 브라우저 지연 아님). 셋 모두
  `discovery/needs_core_review/scoreDisplay=hidden/satisfied=0`.
- 성수는 원본 신청대상, 공고문 자격, 신청 제외 조항의 발췌 3개 및 업력·등록·주소 이전·
  입주 이력·제외조건 확인 항목 5개를 표시한다. 언론홍보는 첨부 수집 실패를 밝히고,
  로켓십은 신청서 양식 대신 공고문에서 초기창업패키지 선정·졸업 조건을 제시한다.
  이는 공고 원문 발췌의 표시 확인이지 Glyph의 지원 자격 확정이 아니다.
- 2026-09-29 12:00 KST 가상 조회의 Glyph 후보 목록에서 성수는 제외됐다.
  기존 후보 1,510건은 현재 지원 가능 건수로 해석하지 않는다.
- 원문 근거는 현재 source revision이 목록 결속과 같을 때만 표시하고, 내용이나 첨부를
  읽지 못하면 기존 기본 안내로 돌아간다. 독립 검수 HOLD 결과를 승격하지 않았다.
- 현재 성수 source revision을 다른 SHA로 요청한 경우 원문 근거가 `null`로 거부됨을
  실제 DB/R2 읽기 전용 경로에서 확인했다.
- `pnpm exec tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/analysis-serving/discoverySourceEvidence.test.ts`,
  `.../features/grant-overview/DiscoverySourceReview.render.test.tsx`,
  `pnpm build:packages`, `pnpm --filter @cunote/web typecheck`, `pnpm verify:openapi`
  (28 paths), `pnpm verify:package-runtime-freshness`, `git diff --check` PASS.
- 변경 커밋 `f429e9695bee53e0fdb3ccb25160b28d8f2d229d`을 작업 브랜치에 push했다.
  같은 SHA에서 `pnpm build:web` PASS. Turbopack의 기존 analysis-lab `run-store.ts`
  경유 NFT 추적 경고 3개가 있었고 컴파일·TypeScript·정적 페이지 생성은 완료됐다.
- 실제 브라우저 Glyph 로그인 검증은 개발 서버가 없어 미실행이다. 4010/4011
  LISTEN이 없음을 확인했고 사용자 직접 서버 실행 규칙에 따라 시작을 요청했다.
  운영 DB 쓰기·모델 호출·배포는 실행하지 않았다.

## 재개 위치

- checkout: `/Users/ffgg/noten.works/cunote-coverage-review`
- branch: `codex/matching-coverage-artifact-recovery`; 메인 checkout의 별도 변경은 보존.
- 실행/구현 소유: Root. 기존 Sol agent는 서비스 인증 오류로 중단되어 Root가 작업을 인수했다.
- 상세 계획·증거: [소규모 인수](docs/plans/2026-09-25-글리프-소규모-매칭-인수.md).
- 영속 artifact: 메인 checkout `spike-out/glyph-small-goal-20260925/` 및
  `spike-out/analysis-lab/launch/`. 현재 checkout의 `spike-out` symlink는 커밋하지 않는다.

## 체크리스트와 검증

- [x] 8건 원문 비교 및 BTS 실제 계정 조건→규모 질문 이동 확인.
  검증: DB/R2 읽기 전용 조회, 공식 원문 대조, agent-browser 로그인·상세·질문 이동.
  브라우저 관측은 이전 턴 증거이며 이번 턴 재검증으로 주장하지 않는다.
- [x] 검색 분류가 자격 입력/추출 결과에 섞이는 경로 수정 (`f73a845`).
  검증: lab input, core extraction-input, core llm-criteria, pilot search-filter 테스트;
  package build, web typecheck, package runtime freshness; 실제 2건 입력 전후 대조.
- [x] 검색 휴리스틱만 있는 공고의 분석 존재 오분류 수정 (`b0ef774`).
  검증: readiness loader 12, supply 9, campaign 29 테스트 및 web typecheck;
  성수 현재 조회가 condition_analysis → await_approved_model_run으로 이동.
- [x] 성수 exact 1건 정상 matching campaign 준비 및 사용자 실행 승인.
  검증: manifest/inventory 바이트 SHA; 현재 입력·첨부·runtime/auth preflight.
- [x] 승인된 단건 `lab:launch:grant` → `lab:launch` 실행.
  검증: exact manifest/grant/terminal receipt와 LabRun 바이트 SHA, terminal 상태, runtime 종료 상태.
- [x] gpt-6-sol 독립 검수 및 원문 대조. 결과 HOLD (수정 5개·누락 축 4개).
  검증: packet/aggregate 결속; 기본 업력·신산업 예외·이전 주소·결격 예외의 범위.
- [ ] 발행 가능한 결과의 release inspect → prepare → 관련 gate.
  검증: 현재 원문 결속, 실제 회사별 전환 사유, 서비스 승격 dry-run.
- [ ] 운영 반영 경계의 구체 결과 보고 후 승인된 반영·계정 인수.
  검증: 적용 대상·정확한 소스/배포·실제 글리프 화면. 현재 단계에서 운영 반영 완료 아님.

## 승인된 실행

- 대상: `301e4b86-bc46-4c06-8ed1-6f59bf01fd9b` (성수).
- manifest: `67732d914aa6947780553e087dd521d592c1f0c38e11b259d9003ccc7d42c615`
- inventory: `f1ef4c57610ea26b5767af7338f7230069b66e439295b5b92ca2281649d874d7`
- input: `96afdb891131a9ccd0f9bc673413db2da776dc97aa98efd11cc628c69d417f28`
- attachment: `8984be6d372a4e46e0fe2e7968fecd45e9c4498d4b18ac11506675efa45ba67a`
- Claude Max `claude-opus-4-8`, matching_only, concurrency 1, 신청서 없음.
- 이번 사용자 '진행해줘'는 위 명세 분석과 Sol 검수 승인이다. 중복 승인 요청하지 않는다.
- grant: `72aad76b7bc060d9b5cd2cd0b65b4a1c430c63fd8349cc6103dea7264882843a`
- 시작: 2026-09-25 13:36:54Z. 13:41:56Z root가 status 파일을 읽어 1/1 running,
  receipt 미생성, 기록된 오류 없음을 확인했다. 이 status는 관측용이며 terminal 증거가 아니다.
- 지연 관측: 13:47Z 이후에도 동일 첫 Claude 자식이 생존했다. 코드 기본 540,000ms와 달리
  `apps/web/.env.development.local` 및 실제 자식 환경의 `ANALYSIS_LAB_TIMEOUT_MS=900000`을
  root가 확인했다. 이번 요청의 제한은 15분이며, 9분 초과 자체를 timeout 결함으로 판정하지 않는다.
  자식 환경은 해당 키만 필터링해 확인했고 인증 값은 출력·기록하지 않았다.

## 결정·제약·막힘

- 2026-09-25 최신 사용자 자율 진행 지시 적용: 작은 단계 완료만으로 중단하지 않는다.
  코드·검증·문서·작업 브랜치 커밋을 계속하고 실제 승인 경계/실험으로 확인한 막힘만 보고한다.
- exact19와 기존 3건/seq0 repair는 별도. 이번 성수 실행에 합산하거나 대신 실행하지 않는다.
- 운영 배포·서비스 DB 승격, 다른 대상/변경된 material의 신규 모델 실행은 프로젝트 승인 규칙 유지.
- 기존 pilot 전체 테스트의 normalization repair 순서 기대 실패는 남아 있다. 변경 전 기준선
  재현은 하지 않았으며 관련 신규 소비 경로 회귀 PASS와 구분한다.
- 글리프 기업규모는 사용자 답변 대기. 성수 분석·검수 작업의 선행 조건이 아니다.
- 원문 대조 기준: 일반 업력 7년과 신산업 10년 예외, 현 소재지 제한 없음과 계약 후 이전,
  신용·중복 입주 결격의 예외를 보존한다. 매출·고용·투자는 평가이며 수치 자격으로 만들지 않는다.
  공간별 10/12/16인은 최소 직원 수가 아니고, 여성·특화 가점 합산 상한은 3점이다.
- 실행·검수 결과와 현재 막힘은 아래 최신 기록을 따른다.

## 2026-09-25 실행 결과와 후속 수정

- 성수 launch는 13:49:02Z 종료, 약 12분 9초. receipt
  `b72e38a14b0e458d0bf3fdd287f266fc224234bf980e2b567b438c70ad66a475`,
  publishable 1 / held 0 / failed 0 / systemicFailure null.
- run `run-2026-09-25T133654.550Z-f55f20`, 바이트 SHA
  `10a85b97f6eb28940389aad2333d4b84f06e33cb80df929c20c80667063313bc` root 확인.
  primary 1회 726,527ms, 내부 repair 0회. 지연은 첫 primary 응답에 집중됐다.
  input 13,841자, usage outputTokens 54,861. 토큰 수는 실행 기록이며 과금 증거가 아니다.
- Sol 검수 manifest `83712d5b5cfc3c7a789d4ed77348a69809cc81852497bd8abcc84a49c55abae3`,
  aggregate `a9b89c4fd86c3b1504ee1efce573f8b3701c14e442a50acc2796a867015fa3cc`
  바이트 SHA root 확인. admission HOLD, consensus defects 9.
- 수정 5개: 업력·신산업 대안 범위, 신용 예외 누락, 신용 이상 범위 축소,
  7대 허브 현재 입주 누락, 여성기업 가점 상한의 projection 유실.
  누락 축 4개: revenue/employees/investment의 평가 효과 및 other의 재량 제외·평가.
- root의 오프라인 실행 재현: 이번 run criterion[12]를 `evaluatePriorAward`에 전달하고,
  7개 program을 모두 확인한 synthetic profile의 공덕 이력만 바꾸면
  participating → pass, completed → fail. 원문 FAQ는 현재·과거 모두 제외하므로 추출 결함이다.
  실제 글리프 회사의 입주 이력을 추정한 실험이 아니다.
- Sol의 `lab:release --inspect` 결과: `독립 검수 PASS launch target이 없습니다`.
  현재 결과는 release prepare/운영 승격 불가. 원본 run·receipt를 보존한 채 공통 검증·변환 수정 진행.
- 사용자 감시 인계 fingerprint
  `853f934a31f589d0c331a158e1476f35fecc6b3d7b6039fd6e89b7a91de699ec` 수신.
  감시자의 §71 기록/ack와 후속 소유 유지 알림이며 새 실행·서비스 쓰기 승인이 아니다.
  exact19의 18 publishable / 1 held와 합산하지 않는다.

### 남은 체크리스트

- [x] 현재/과거 범위와 가점 설명 유실을 공통 검증·변환 계층에서 수정.
  검증: 실제 재현 fixture, 반대 사례, 관련 suite와 typecheck.
- [x] 실제 현재 입력의 input·attachment SHA 재확인 후 새 validator로 재현.
  검증: `spike-out/glyph-small-goal-20260925/seongsu-postfix-validation.md`.
  normalized criteria/axes로 진단용 raw 배열을 재구성한 범위이며 원시 모델 응답 재검증이 아니다.
- [x] `pnpm test:matching-unit`, `pnpm lab:matching:projection:test`,
  `pnpm --filter @cunote/web typecheck`, `pnpm build:packages`,
  `pnpm verify:package-runtime-freshness` PASS.
  로그: `spike-out/glyph-small-goal-20260925/test-matching-unit.log`,
  `test-matching-projection.log`, `typecheck-web.log`.
- [x] `pnpm verify:deep-analysis-contract` 집계 검증 PASS.
  로그: `spike-out/glyph-small-goal-20260925/verify-deep-analysis-contract.log`.
- [x] 변경된 코드·미실행 경계를 기록하고 다음 exact 준비물을 봉인.
  검증: 관련 diff, source/runtime/input 결속, 기존 receipt 불변.
- 막힘: 현재 분석은 독립 검수 HOLD라 발행할 수 없다. 공통 코드 수정·오프라인 검증은 계속 가능하다.

## 재개 명세와 현재 승인 경계

- 코드 commit: `6728017b29fe68a169aa52fa5f5dc85ce7781d8b` (소스/테스트 9개).
- 보정 manifest: `2b7ce11e62e5244b1539b925ce4c24367ddc57c2f36e3b3700e6cf158e749491`.
  root가 원본 바이트 SHA, 성수 1건, blockingCount 9와 검수 aggregate 결속을 확인했다.
- 설정: `independent_review_repair`, Claude Max `claude-opus-4-8`, matching_only,
  concurrency 1, 신청서 없음. 기존 원문 input·attachment SHA 동일.
- package runtime: `54131b6f02238cd2a5e08a51ced0764bb30afa8889a5d73f977871895d4cd414`;
  validator v26, normalizer v4. 이 material 변경은 새 명세에 결속된다.
- 준비 후 Sol runtime 관측: paused, generation 461, owner 없음, active lease 0.
- 다음 모델 실행은 위 새 exact 명세에 대한 사용자 승인 대기다. 프로젝트 AGENTS.md의
  `lab:launch:grant` 규칙에 따른 실제 경계이며 문서 업데이트나 commit SHA만 바뀐 탓이 아니다.
- 승인되면 같은 checkout에서 다음 명령으로 grant를 발급한 뒤 출력 grant로 launch,
  Sol 검수, source 대조, 통과 시 release 점검을 이어간다. 운영 승격은 별도 범위다.

```sh
pnpm lab:launch:grant -- --manifest=2b7ce11e62e5244b1539b925ce4c24367ddc57c2f36e3b3700e6cf158e749491 --approved-by=ffgg-user
```

현재 완료 범위는 공통 코드 수정·오프라인 검증·다음 실행 준비다. 실제 추천 1건 노출 목표와
초대 베타 인수는 미완료다. 분석 속도 개선도 아직 입증하지 못했다.
