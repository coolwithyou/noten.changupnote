# 종합 기능 시연 계정 준비 — 2026-10-01

## 목표/완료 조건
오늘 오후 일반 사용자 계정에서 맞춤 테스트 사업자로 실제 분석 완료 공고를 매칭하고,
제안서/문항 작성, RHWP 회사정보 자동 입력·편집·저장·다운로드, 지원서 AI 상담을
하나의 시나리오로 실제 검증한다. 판정/권한 예외나 성공 응답 fixture로 대체하지 않는다.

## 승인과 경계
사용자가 시연용 계정 생성·사업자 정보 입력·테스트를 요청했다. 신규 시연 계정/회사/초안의
범위에서 정상 서비스 쓰기와 한정된 실제 상담·문안 요청을 수행한다. 기존 고객 정보,
공고 분석 결과·운영 worker·원천 데이터를 바꾸지 않는다. 배포/공유 운영 설정 변경은 별도다.
개발 서버는 새로 시작하지 않고 현재 4010/배포 소스와 연결을 먼저 확인한다. 비밀번호/토큰은
gitignored private 파일/브라우저 stdin으로만 취급하며 코드·진행 파일·로그에 기록하지 않는다.

## 체크리스트/검증
- [x] 현재 서버/배포 기능·계정 구성·기존 작업 owner 확인:4010 main, prod login ordinarypassword; Vercel noten-dev/project changupnote 확인.
- [ ] 분석 완료+현재 신청 가능+RHWP 실제 source/필드 준비 후보 read-only 조사.
- [x] 시연 기업 초기 설정/사업 설명 저장: software supply SME2년/5인/연매출1.2억(합성). 한남 소프트웨어/SME/일반기업 조건에 맞춤, 공고검수 쟁점은 유지.
- [x] 정상 password 계정·회사·자료/사업 설명 구성 및 상담 요청 성공. 사용량 수동 증액 없음.
- [ ] 매칭→상세→workspace RHWP 자동입력/제안서·문안→AI상담→파일 저장/다운로드 브라우저 검증.
- [ ] 재현 시나리오/접속 안내/증거/남은 경계 기록, 관련 코드·문서 scoped commits.

## 결정 로그
- 기존 dirty main 코드 보존. 구현/문서는 clean authoring-first에서 진행.
- 우선 완전 분석된 기존 공고를 조사했다. 현행 v22 완료본이 없어 정상 단건 prepare까지 진행한다. 신규 live deep/Kordoc은 exact manifest 승인 전 실행하지 않는다.
- 매칭·자동입력 가능성을 실제 artifact/브라우저로 확인한 뒤 대상 기업 내용을 작성한다.

## 막힘
현재 조사 중. 실제 막힘은 대체 가능한 공고/정상 경로를 먼저 시도하고 기록한다.

## 실계정·운영 준비 증거
- 시연 계정 `demo-20261001@noten.im`, userId `f212886d-bb64-4fcf-aab5-43114ebc9e63`.
  일반 register 201 및 실제 password login 뒤 dashboard 확인. 비밀번호는 비공개 파일만 유지.
- 일반 회사 생성201, companyId `a0132dd3-9cb7-87a1-95ef-6cfc171a795f`.
  industry/target_type/region 정상 profile field API3회200. 경기 소프트웨어 개발 및 공급업 중소법인.
- 한남 공고 `b1d964ae-fe8b-4212-9fa7-31d65a4ded12`, 신청서 draft
  `8199e7d4-2c93-4dd1-b68e-42838ec0917b`: 실제 RHWP HWPX13쪽 열림, 서버 저장 성공12:48.
- 작성 등록정보 PUT200: 합성번호 `0000000000`, verified=false, 대표/담당자/주소/이메일.
  외부 verify/enrich 호출 없음. 합성 회사 소개 텍스트 source1개와 사업 설명8개 저장 안내 확인.
- prod 매칭 API: returned first20 중 verified11/discovery9, recommendable0.
  main 현재 admission 소스로 읽으면 verified0이지만 deployed/authoring은 historical serving으로
  verified를 보존한다. 이것을 회사 부적격이나 전체 분석 부재로 혼동하지 않는다.

## 확인된 기능 막힘과 정상 보완
- 한남 기존95필드(v8/역사roundtrip)와 현행v22 연결 계약이 달라 자동입력/항목AI 비활성.
- 실제 '작성 위치 찾기'에서도 필드 `9e0640d7-229a-47cb-9211-9a6897fdac58` 구조 missing으로
  차단됨. 예외로 건너뛰거나 성공 처리하지 않는다.
- 로컬 완료 roundtrip813/run1813/manifest140 조사에서 currentv22완료0.
  한남 역사 formal seq10 재prepare는 current prompt 계약 불일치로 exit1. live 모델은 미착수.
- 일반 RHWP(b)에서 기존 공고상담이 필드ready(a) 대화창 gate에 묶여 UI 진입 불가한 문제 발견.
  일반 상담 진입을 별도 허용하는 정상 제품 UI 수정·회귀검증 진행, preview write금지 보존.
- 신규 미분석 HWPX단건을 표준 current-inventory로 prepare하고 exact범위를 사용자에게 제시하는
  경로 조사 중. GateR 신규 모델실행/서비스promotion은 준비와 구분해 승인 전에 시작하지 않는다.

## 재개 검증 — 정상 준비 경로
- 현재 운영 세션에서 같은 회사/한남 draft 접근을 재확인했다. RHWP13쪽 열림과 missing 필드 오류는 동일하다.
- clean 실행 소스의 authoring-first에 main 전체 analysis-lab history12,552개를 복사하고 파일 SHA 전수 동일(차이0)을 확인했다. 얕은 worktree의 빈 이력을 unseen 판정에 사용하지 않는다.
- main 환경 파일은 gitignored symlink로만 연결했고 secret 값은 출력하지 않았다. package runtime freshness PASS.
- private 계정 접속 정보는 `/Users/ffgg/.codex/private/cunote-demo-20261001/access.json`(디렉터리700/파일600)에 보관한다.
- UI WorkspaceView render, ChatPanel render, chatRequestState 회귀 PASS. history 작업 중 typecheck 오류는 소유 agent에게 전달하고 최종 재검증한다.

## 정상 단건 manifest 준비 통과·승인 대기
- history consumer 수정 `ab28ce3`, 일반 RHWP 상담 UI `99c861f` 커밋. 전용/기존 preparation 테스트·web typecheck PASS. current-inventory 확장 28/30 중 2실패는 HEAD baseline에서도 동일(증거 문서 참조).
- 상담 UI finite browser 6 checks PASS: 일반 RHWP b 진입/합성 SSE/독립 context/재열기/390px/preview 차단. 실제 상담 API200과 UI합성증거는 분리한다. 운영 배포 전이다.
- 표준 `pnpm lab:launch:prepare-current -- --grant-ids=9837fd9b-0b15-4e70-b1b5-0fe3765e980c --concurrency=1 --analysis-mode=primary_and_application` exit0.
- exact manifest `c321820cea65b5df909921498e8e3a199681b03198072127aa7d06098a53bab5`, inventory `c7d1dc5e1d8ff00f8df34ce83a5743439d7641fe1c55e63ec749c94876bf1ba6`.
- 실행 계약: primary_and_application, claude-cli/claude-opus-5, Kordoc v22, concurrency1, source ab28ce3. history1008 제외. modelCalls0/serviceWrites0/liveExecutionAuthorized=false.
- 사용자에게 이 exact1건 Gate R 승인을 비동기 질문했다. 응답 없이는 grant/launch를 실행하지 않는다. promotion·배포는 별도 범위다.
- 후보: 싱가포르 현지 진출 국내 블록체인 기업, 신청기간9/28~10/8 14:00. 기존 합성software회사에 블록체인 문서근거/이력증명 SaaS 사업계획을 맞출 수 있지만 제품사실/영어피칭/출장조건을 자동확정하지 않는다.
- manifest/준비 영수증: docs/evidence/demo-account-20261001. 준비 성공은 완전분석·자동입력 성공이 아니다.

## 배포 준비 추가 검증
- `pnpm --filter @cunote/web build` exact source08e4e0b에서 exit0(컴파일/TypeScript/정적 생성 통과). 기존 NFT 추적 warning2건은 있으나 build실패 없음. 운영 배포 완료로 해석하지 않는다.
- `claude auth status --json`에서 loggedIn=true/authMethod=claude.ai/apiProvider=firstParty/subscriptionType=max 확인. 실제 실행 시 transport 공통 preflight로 다시 검증한다. 모델착수0 유지.
- 운영 브라우저 `/api/auth/session`200, demo-20261001@noten.im 인증 유지 재확인. 다운로드100742bytes/SHA·ZIP·sectionXML 무결성 재검증 PASS.

## 사용자 구독 분석 승인·착수
- 사용자 명시 승인: 모든 종류의 분석 실행을 승인하며 API token이 아닌 이 Mac 구독 모델만 사용(2026-10-01). 동일 목표 내 후속 분석도 이 승인 범위로 유지하고 target/material 식별을 기록한다.
- exact manifest c321820c...a53bab5에 grant `6790dfa8433d9b9b72729a5e811ba86d3e9df0a2b6b3fcf21d5f9c4d1c047847` 생성 성공.
- `ANALYSIS_LAB_TRANSPORT=claude-cli pnpm lab:launch -- --grant=6790dfa8433d9b9b72729a5e811ba86d3e9df0a2b6b3fcf21d5f9c4d1c047847` 착수. session19611, started1/1 로그 확인. 모델 완료와 구분한다.
- transport 자식환경에서 ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL, OAuth override, Bedrock/Vertex/Foundry override 제거 및 firstParty/max preflight 유지 확인.
- 신청관리에서 실제 문서 열기→companyId 유지→RHWP13쪽/서버저장12:48 재개 확인. GET회사/brief/autofill 모두200, companyowner/self_declared/미검증번호, briefrevision1/selectedsource1 보존.

## 구독 단건 분석 종결 및 구조 문제 — 13:29 KST
- launch session19611 exit0. 완료 receipt `c634172a8731ece151dc44544974ad4590bb0d8eab110749359d01fe4be40f19`, 종료 2026-10-01T04:28:47Z. primary=publishable, matching projection verified/conditional, application=held. 운영 결과 승격 없음.
- application roundtrip `roundtrip-2026-10-01T041138.341Z-800a5b`, Kordoc4.2.3/current v22/claude-cli. 신청서 후보89개 중 accepted66개, anchorReady66/anchorUnready0, unresolved0. 상위 readiness recognized0은 실제 추출0이 아니라 문서 review_required에서 차단한 결과다.
- 원인: 신청서 목표 고객(block3,row15,col3)의 인접 다열 빈값3개를 writer가 exact 결속하지 못한다는 structuralWarning1개. choice group이 있는 문서는 현행 isolation이 fail-closed한다. 일반 구조 결속 문제를 조사하며 데모 예외·게이트 완화·불변 영수증 수정은 하지 않는다.
- writing_workspace: 일반 다열 parser/writer 구조 조사·수정·회귀 검증. company_exploration: 완료 receipt 기반 application_only 정상 준비 및 기존 baseline 실패 영향 조사. 새 모델 호출은 기존 구독 분석 승인 범위로 진행하되 exact 대상과 material binding을 다시 기록한다.
- 독립 Codex 검수는 ChatGPT 구독 인증과 API credential 제거를 유지한다. 보류 신청서를 완전 준비 상태로 표시하지 않는다.

## 독립 구독 검수 종결 — 13:35 KST
- `lab:independent-review:codex` exit0, ChatGPT 구독/gpt-6-sol, 한 packet 완료/실패0. API credential을 빈 환경값으로 덮고 runner의 child credential 제거 유지.
- manifest `5264f735ce5c339ed2174123859162adb032f3362e4fa05d403119ddf86dbf1c`, aggregate `3d390827e1797f09a59ce1d321efff4a5a338b596328844d9985113d47b20b44`, aggregate exit0/admission HOLD. 조건 correct17/needs_edit3/unsure2, 빈 축11개 confirmed_absent.
- 결함: 블록체인 기술 보유를 업종 tag로 대체, 회생 개시 신청·개인회생 범위, 직전년도 결산 자본전액 잠식 기준 보존. 미해결: 중소기업 OR 스타트업 경로와 업력10년 적용 범위. 재분석에서 불명확한 원문은 조건부/원문 확인으로 보존한다.
- primary publishable은 독립 검수 PASS가 아니다. 정상 독립 검수 repair를 준비하며 matching-only 승격으로 FULL 시연을 대체하지 않는다.

## 구독 실행 경계 재확인
- 현재 chat route는 createAnthropic/API key 경로, fieldSuggest·sectionComposer는 운영 API 모델 경로다. 운영 precompute는 API 고정/실험실 구독 import 금지 회귀가 있다. 사용자 최신 API 금지 요청 뒤 새 운영 상담·문안 생성 모델 호출은 하지 않는다.
- 로컬 deep/Kordoc/독립 검수 및 후속 repair는 승인된 구독 경로를 사용한다. 운영 사용자 대면 경로를 시연용 CLI 예외로 바꾸지 않는다. 운영 결과 승격·배포는 별도 명시 승인 경계이며, 먼저 분석·검수·검증된 exact 결과를 준비한다.

## 정상 재분석 결속 수정 검증
- `3c94d82`: application-only가 기존 primary를 신규prompt와 비교하던 오류를 원source manifest의 model/transport/prompt exact대조로 수정. 실행 시에도 동일 검증 강화. 역사 matching-onlyv28 완료계약은 정밀한 오프라인 whitelist로만 소비하며 신규live admission을 열지 않는다.
- agent 도구 증거: current-inventory-launch31/31 및 `pnpm lab:launch:test` 전체 PASS, web typecheck PASS. 실제 완료run SHA `362d1584d5ba36e207ab5da1d6b651aa550c7070f5fea67f808d39e195f3ed54`/22조건 bytes 보존 offline PASS.
- 이번 공고에는 primary 보정도 필요하므로 공식 independent-review repair가 적합하다. 원source primary_and_application을 계승해 2레인을 실행하며, 기존review_required 신청서는 strict reuse되지 않고 new_analysis를 수행한다. 구조 수정 검증/커밋 후 exact prepare→grant→구독 launch를 진행한다.

## 구조 수정 완료와 재분석 준비 경로
- `f4647c1`: covered dummy를 독립 셀로 세지 않고, 기존 accepted 하위 라벨의 exact span/value/occurrence 결속을 coverage에 반영. source 후보·스키마·writer 계약 변경 없음(v22유지).
- `lab:roundtrip:test`13 suites 및 `lab:application-materialization:test`3 suites PASS. root 최종 web typecheck exit0(session88174). R2 원본SHA 검증→native unique binding→insert/export/reopen PASS. 전체8tables/514logicalcells에서 무편집export 대비 고객군 값셀1곳만변경. 원본→무편집export의 기존공백직렬화1곳은별도기록.
- 불변applicationanalysis는 보존. 복제후보 계산은 accepted/anchorReady66/unresolved0 및 coveragecomplete를 확인했지만 신규모델/release인수로 대체하지 않는다. [상세 증거](docs/research/2026-10-01-병합-하위필드-결속-검증.md).
- independent review repair 실제prepare는 동일target의 unsure2 때문에 exit1. 설계상 결함target에서 unresolvedtarget을 제외하는 gate이므로 결과·gate를 바꾸지 않는다.
- 표준 terminal-repair 준비는 exit0: manifest `5cb5740398850dbe3fd563ee34a0f3c728abc137a62113c36363aec5abaeee20`, inventory `06e5ffd8bcaf702117a91c9279bc1d3caf2db1b57e83db622d3240fc4f0b2771`. originalseq0/exactgrant1/원input·첨부SHA보존/sourcef4647c1. model0/servicewrite0/grant미발급.
- terminalrepair는 검수feedback를 전달하지 않으므로 위manifest를 바로반복실행하지 않는다. company_exploration에 일반 extractor 의미보존규칙+회귀보완 위임. 새 source/provenance에서 같은terminalreceipt에 결속된 새manifest를준비하고 기존구독승인으로실행한다. 특정공고예외·검수HOLD해제는금지.

## 일반 의미 보존 수정 및 구독 재분석 착수 — 14:00 KST
- `a61f540`: lab-deep-v30/validator-v24. 원문 OR범위·기술보유·절차신청단계·재무기준연도가 현재 canonical에서 무손실 표현되지 않으면 text_only 보존/재보정. 명시 공통 업력과 canonical로 이미 지원되는 상태는 유지.
- `verify:deep-analysis-contract`, launch전체suite, completedreader5case, normalizerprovenance, confirmation 및 web typecheck PASS. [검증 근거](docs/evidence/demo-primary-meaning-preservation-20261001.md). 옛 v29/v23/v22 완료 영수증은 exact 오프라인 ancestry 소비만 허용하며 livecurrent 계약은 v30/v24다.
- 정상terminalprepare exit0: manifest `601ef168693799c9096d0fc92e9165556367ebe6c00265100b2054739cfb528e`, inventory `460520c4ce9d27b475da54a6e0bed46233994f290e625382f9d37809816f9a45`. 원grant1/inputSHA/attachmentSHA 전수 동일. 새 source a61f540. 과거 5cb574 manifest/grant 미실행.
- 사용자 지속 구독분석 승인으로 grant `f638bb949abdfb95db933d0ac33458c32e6abe9bdff0e80f2ae894ea9b400694` 기록 후 `ANALYSIS_LAB_TRANSPORT=claude-cli pnpm lab:launch -- --grant=f638bb949abdfb95db933d0ac33458c32e6abe9bdff0e80f2ae894ea9b400694` 실행. session26725, target1/1 started 확인. 완료/승격과구분.
- 같은 source의 production build session87565 실행중. 운영배포·새운영API모델호출 없음.

## 최종 build와 정상 등록정보 엔진 부분 검증
- sourcea61f540 `pnpm --filter @cunote/web build` exit0(session87565): compile/typecheck/static5 PASS. 기존 NFT trace warning1, build실패없음. 같은source의typecheck별도반복하지않음.
- `0642ace` 유한 실제StudioSDK/selfhost/정상profiletransaction probe: 등록정보dialog에서회사명1개 적용→export/reopen 유지. 514표좌표대비해당값셀1개만변경. [receipt](docs/evidence/native-autofill-20261001/2026-10-01T04-58-44-395Z/report.json).
- 진입자동seed는 실제0개. 기존번호2개 already_filled 보호, 대표자profilebinding0 유지. 임의입력/역할추정없음. held불변분석materializable=false 유지. 이 증거는 엔진부분검증이며 FULL자동입력/승격/운영UI인수가아니다. 모델/운영DB쓰기0; 유한서버/브라우저/임시bundle정리true.

## 새 구독 신청서 분석 완료 — primary는 실행 중
- 실제 새 roundtrip `roundtrip-2026-10-01T050056.268Z-98c796`, currentv22/claude-cli/duration292515ms. 신청서 application_form accepted66/anchorReady66/coveragecomplete, unresolved0/structuralwarning0. failureCode/error null.
- 원문SHA `ceb2c53a1a4ff825e3661deecd5a7533d23a4d55f2e82126a240b6de3f06e150` 유지. announcement 문서의partial3은 신청서ready판정과구분. 모델실행영수증과저장본은새불변artifact이며옛heldartifact를수정하지않음.
- launch26725/primary실행중이므로전체release준비·운영승격완료선언아님.

## 두 레인 완전 분석 종결 및 독립 검수 착수 — 14:11 KST
- launch26725 exit0, receipt `6aa595478fd36e92203b692168d084180b2057e1cfba3f648a0e62a2e204d3e6`, started05:00:47Z/finished05:11:45Z. primarypublishable, applicationcomplete/authoringready, matchingready/conditional, recognized66, publishable1/held0/failed0/systemicFailure null.
- run `run-2026-10-01T050054.083Z-40f6e4`, SHA `c4bf4db3245e96957746671d0d53d918d2866faf0fc4e8ccaad398afefb92a2b`. 완전분석과 회사의 모든자격확정은구분. [불변 영수증 사본](docs/evidence/demo-account-20261001/terminal-repair-receipt-v30.json).
- 새독립검수 manifest `8972f411f59da6cc9b0c84607552fdae7537bca903816305420f496eee14ee7d`, CodexChatGPT구독+APIcredential제거, session4441 실행중. 이전HOLD를수정하지않고 새leaf로판단한다.
- `c779614` 제품자동입력 의미guard: URL주소/영문회사명/법인번호를우편주소·기본상호·사업자번호에매핑차단. startupseed도동일guard. 관련4suites/tsc/diffPASS. 분석실행코드·후보·스키마수정없음.
- 최종제품sourcec779614 build28406 실행중. 운영승격/배포/새API모델호출없음.

## 새 독립 검수 보정과 완료 신청서 재사용
- Codex구독검수4441 exit0, aggregate21720 exit0/`30398a1abcb63a752b744d337e7dba67f1b984df03f99c51169ddf0b24e0406e`: correct22/defect2/unresolved0(HOLD). 기존5finding은해소. 새결함: 명부등재·등록을일반loan_default로대체, 확인서묶음제목을독립탈락조건으로추출.
- unresolved0이라 정상 independent-review repair prepare exit0. exactmanifest `fa72ee62e6bbf59d4cd95fd6e863646e3d99eb58002334e8b0fa8a508f34d79e`, sourceec0e3ef/seq0/grant1/noinputdrift. 신청서는strict `reuse_reviewed_v1`로완료본보존하고 primary에봉인된2finding을전달한다.
- 기존사용자구독분석승인으로 grant `5565cdc7655959b94215b944133bf2a5074e03eeec442692c2dbc479dbaaf490` 생성, `ANALYSIS_LAB_TRANSPORT=claude-cli pnpm lab:launch -- --grant=5565cdc7655959b94215b944133bf2a5074e03eeec442692c2dbc479dbaaf490` session91441 실행. gate/검수result/원artifact수정없음.
- 최종제품sourcec779614 build28406 exit0(compile/typecheck/staticPASS), 기존NFTwarning2. 실행코드수정후검증이며배포완료로해석하지않음.

## 최종 릴리스 소비 계약 검증
- `pnpm lab:release:test` exit0(session42905): completedreader5/5, buildprovenance, deep/launchpromotion, aggregateevidence, release/replacement, applicationroundtrip admission/import, precomputebundle, servingprovenance 모두PASS.
- 이는새검수지시repair의완료신청서재사용을정상릴리스소비경로에서처리하는계약회귀다. 실제최종leaf의독립검수PASS와read-onlyreleaseinspect는별도로확인해야한다. 운영releaseprepare/approve/promote/write/배포없음.

## 구독 보정 타임아웃 및 동일 grant 재시도 — 14:35 KST
- session91441 exit0이나 target failed: primary 모델 요청이 900000ms에서 timeout. receipt `56cc29f039366ea896b4b2755893794a564af4bb2626885ee18246bca7432d71`, systemicFailure null. 신청서 complete/66필드/authoringready 재사용은 유지되며 matching은 primary_failed로held다. CLI exit0을 분석성공으로 해석하지 않는다.
- 동일 material binding과 지속 구독 승인에 따라 `ANALYSIS_LAB_TRANSPORT=claude-cli pnpm lab:launch -- --grant=5565cdc7655959b94215b944133bf2a5074e03eeec442692c2dbc479dbaaf490 --retry-errors` 실행(session54676). 모델/API 경로 변경·timeout gate 완화·운영쓰기 없음. 새 영수증 종결 후 새독립검수와 read-only inspect를 이어간다.

## 동일 grant 구독 재시도 성공 및 독립 검수 착수 — 14:42 KST
- retry session54676 exit0, receipt `888a8cf54460911a8fe9eca6ef1384dfe67260d9ce727e36959161a8010974f7`, started05:34:58Z/finished05:41:38Z. publishable1/held0/failed0/systemicFailure null. primary matching projection verified/conditional, applicationcomplete/authoringready/recognized66, source/input/첨부결속유지.
- run `run-2026-10-01T053459.988Z-10abcc.json`, SHA `b44cb39b3f7f431e8b2522bb73e5e50efea8288e57e87a3ec16f40b168adc712`. gitChangedSincePreparation=true는진행문서커밋추가이며 material execution contract 변경없음.
- 새독립검수prepare84498 exit0/manifest `ab8ef433c1013bc3ecac190bedd34ee6a1f455d1f42a3551d9e9693e5e1af972`, publishablepacket1/held0. Codex ChatGPT구독/APIcredential제거 runner session7646 실행중. 이전HOLD를대체하는새leaf검수이며결과확정전운영반영없음.

## 최종 구독 검수 PASS와 read-only 릴리스 인수 — 14:44 KST
- Codex ChatGPT구독 검수7646 exit0/completed1/failed0, aggregate98698 exit0. aggregate `e82b4fbdd05fbc231929ff99af36bc2070df7099bc57b4a3f5eace7f7232bcb1` admissionPASS: correct22/confirmed_absent12/defects0/unresolved0/held0. 원문 명부등재·신용정보등록은 text_only로보존되고 묶음제목은독립조건에서제거됐다.
- `pnpm lab:release -- --inspect --launch-receipts=888a8cf54460911a8fe9eca6ef1384dfe67260d9ce727e36959161a8010974f7 --review-manifest=ab8ef433c1013bc3ecac190bedd34ee6a1f455d1f42a3551d9e9693e5e1af972 --grantIds=9837fd9b-0b15-4e70-b1b5-0fe3765e980c` session45260 exit0. exactgrant1/dispositionconditional/reasons0/unresolvedAxes0/22criteria, applicationv22complete/66fields/reusedFrom050056기존완료신청서확인. 모델·DB쓰기0.
- source revision `af06d57888cd094f3fcbd8bd74cab312ddd8fb03cac92cef40fc5c85a4b3173d`, input `a4a70dbdaae820a9a179819fee58dec0711f5c265a11e664455d578c80aa2cb4`, attachment `8a0656b462de03e9c55a1352affb877a04b8a13653edececa97ccc37db8dd663` 유지. 불변검수영수증사본 저장. 분석완료와 FULL운영시연완료는구분한다.

## 남은 운영 경계와 재개 조건
- 구독 분석·보정·독립 검수·read-only검사 및 제품코드/build/계약테스트는완료. 실제운영승격과검증제품배포는 AGENTS.md의 별도 명시승인 대상이다. 현재 exact1grant/receipt888a/reviewab8e/aggregatee82b를대상으로 releaseprepare→aggregate→shadow(testcompanya0132dd3-9cb7-87a1-95ef-6cfc171a795f)→dry-run→서로다른actor releaseapprove→promotewrite→verifypromotion까지, 동일검증제품sourcec779614의 clean후속commit배포·라이브스모크 범위승인이필요하다. 신규공고·모델API분석·운영worker활성화는범위에없다.
- 모든 분석은 사용자승인대로 Mac구독모델로수행했다. 운영AI상담/문안생성은현재API경로이므로, 전체시연의 해당부분을실행하려면 사용자가운영기능의 API호출을허용할지결정해야한다. 별도허용전에는새API모델호출을하지않는다. 운영상담을구독으로바꾸는시연예외는만들지않는다.
- 승인후정상운영공고를새draft로선택하고Singapore8field합성brief를저장→일반등록정보dialog/자동입력→문안작성/AI상담(별도허용범위)→서버저장→다운로드ZIP/XML→재열기SHA·RHWP화면인수. 기존Hanammanualbaseline이나로컬부분probe로FULL인수를대체하지않는다.

## 운영 반영 승인 대기 중 현재 상태 재확인 — 14:47 KST
- 앞선 goal turn은 구독 retry 성공·독립검수PASS·read-onlyrelease인수로실제진행했다. 현재continuation은승인응답이아니므로운영승격·배포·새API모델호출권한을추가하지않는다.
- 정상DB read-only transaction(2026-10-01T05:47:15.525Z): exactSingaporegrant open/visible/file_form, promotionItems0, HWPX표면2개 모두preview_ready. 로컬66field검수PASS는아직운영fields_ready에반영되지않았다. [읽기전용snapshot](docs/evidence/demo-account-20261001/production-readonly-before-approval.json). 모델/API호출0, DB쓰기0.
- DB apply_end는2026-10-08T00:00:00Z(09:00KST)이며원공고의명시마감14:00KST와차이가있다. 시나리오의원문마감과DB관측을혼합하지않으며, 현재10/1지원가능상태에는영향없음. 원문/운영수정은승인대상으로유지한다.
- 같은진짜막힘은운영반영별도승인과운영AI API호출범위미확정이다. 승인된로컬분석·제품수정·검증은완료했고추가모델분석으로권한경계를해결할수없다. 전체goal은미완료/active유지.

## 반복 막힘 감사 및 목표 blocked 판정
- 3개연속goal turn에서동일경계확인: 최초PASS완료보고의운영승격·배포/API호출범위확인요청 → 다음continuation의운영preview_ready/read-only재확인 → 이번continuation에도실제승인응답없음. 자동goalcontinuation은명시승인이아니다.
- 현행AGENTS.md99–101의운영promotewrite/배포별도명시승인과사용자최신구독모델요청이계속적용된다. 로컬분석·검수·제품수정·빌드/릴리스suite는완료이고추가허용작업으로FULL운영인수를달성할수없음. 워크트리clean확인.
- 목표는미완료이며blocked로기록한다. 해제에필요한입력: exactSingaporegrant1건(최종receipt888a/reviewab8e/aggregatee82b) 운영release처리·승격과검증웹배포승인, 운영AI상담/문안생성API호출범위결정. 범위승인후동일결속·정상경로로재개하며추가분석승인은묻지않는다.

## 사용자 운영·API 승인과 정상 승격 — 14:51–14:58 KST
- 사용자명시승인: 운영승격+웹배포+이번시연API호출합산$20상한. 기존구독분석원칙유지, 운영AI기능호출만별도예산. blocked원인은해소되어실행재개.
- exactrelease `deep-afternoon-demo-20261001-r1-20261001T055109Z-d745bfcd`, manifest `f2b25ec31e434f8b53b9945114d380907a98bc83c776434878c98f8586e93fff`, plan `e1c13f3fe4f7c11d00eaaac0037cbc16a793521f53286551a7082f3059ef329f`. prepare69389/aggregate61496/shadow16115/dry32208/approve38611/promote28176/verify95807모두exit0. aggregateGO/sourceDrift0, shadow회사1issues0/PASS, drybaseline1/1/PASS, 승격성공1실패0/canary_passed, verifycanaryPASS/issues0.
- actor분리 codex-demo-preparer→codex-demo-reviewer→codex-demo-executor. currentsource/input/첨부·review결속유지. 신청서bundle정상materialization(surface2), 운영작성가이드1/1. [정상릴리스영수증](docs/evidence/demo-account-20261001/operational-release/manifest.json).
- company_exploration 배포source d745bfc 고정 clean archive, 정식CLI/인증프로젝트검증후 deploymentREADY/aliaschangupnote.com보고, 별도live인수증거정리중. root는유한일반브라우저로그인/회사자가신고/작성흐름진행. 비밀번호출력없음.
- 합성회사일반UI에서세금/보험체납·신용문제·제재없음자가신고를저장했고해당공고중복수혜조건에아니오를답했다. 공식검증이나공고자격전체자동확정으로표시하지않음. 최초운영화면4/7→6/7→현재재조회검증중. API모델호출아직0.

## 실제 운영 자동 입력·상담과 후속 일반 안전 수정 — 15:01–15:10 KST
- 새draft `efc28b23-5fe5-46ab-9a59-51c485ed318f`, SingaporeHWPX/RHWP7쪽. 합성brief8항목을일반회사자료dialog에서저장했다. 최초회사명자동seed1개+등록정보dialog17개채우기성공toast/15:01서버저장. UIdownload `/tmp/cunote-demo-20261001/singapore-autofill.hwpx` 성공.
- writingagent 실제파일514셀읽기대조: 입력변경18셀(회사명startup1+주소1+성명4+이메일4+전화8), 기존serializer공백변경1셀, 나머지495셀/span보존. 홈페이지/영문회사명/법인번호/기존template사업자번호변경0. 저장SHA `47ef0224` prefix/99411bytes. 자동입력화면숫자17과startup1을구분.
- 정상일반AI상담2turn 완료/DB이력보존. 최초변동지원액을확정금액으로표현한부분을후속질문으로정정, 마지막답변에서확정지원액없음/약250만원한도변동/자체예산확보명시. [이력](docs/evidence/demo-live-20261001/consultation-messages.json). 신규reported토큰비용추정 $0.0174911, SDKretry확인불가라chat2회총$3예약잔여보수유지.
- sectionflag정상활성화재배포dpl_8oT3DKnTg67YrJvR9un9UJrqAHpcREADY/source동일d745bfc/운영canGeneratetrue버튼확인. unitsectionComposer62610PASS. 첫기업소개sectionAPI는providerusage reported/비용추정$0.051783이나후단검증failed(초안유실없이문서보존). maxRetries0+reported단일요청이므로cost대조후section예약해제. 총reported신규$0.0692741+미확인chat예약$2.9825089, cap$20유지.
- 실제nativefield결속62/66이라도일부달러unique가잘못된행으로밀리는것을writingagent읽기증거로확인했다. 숫자필드에입력하지않고일반resolver의wholecell라벨occurrence/원문좌표/명시samecell계약검증을강화중. 원modelartifact·gate예외없음. 정상separatelabel서술형은유지할예정.
- section검증실패원인이generic오류로숨겨지는문제는일반안전failurecode/명시sourcekindprompt보완을browseragent에위임(원문/키로그출력금지,validator완화금지). 초안근거용합성회사·제품소개자료를일반dialog에추가/선택저장중.

## 일반 안전 수정 검증 및 재배포 착수 — 15:15 KST
- `39d8319`은라벨source occurrence를wholecell순서에서먼저선택하고source row/col을검증한다. 단위만있는값셀은명시samecell쓰기계약없으면차단. 실제잘못결속된숫자5개를차단했고52/66위치확인/14자동반영제외. 문서에이전트전체suite/웹tscPASS. [native실증](docs/research/2026-10-01-native-라벨-순번-입력결속-안전검증.md). 웹client가exportbytes를hostWASM으로해석하는resolver이므로Studio재배포는필요없다.
- `139f5f1`은section검증/응답형식/provider실패를고정코드·안전한국어로분리하고 source.kind허용표와정확quote/숫자유지규칙을명시한다. 기존validator/model/maxRetries0/출력6000/45초한도유지. test:writing-context전체+웹tscPASS. providerusage존재하는형식오류는reported보존. 과거failed원인은원문미저장이라소급추정하지않는다.
- root변경diff검수+`pnpm --filter @cunote/web build` session61137 exit0/compile12.4s/tsc17.3s/static5PASS, 기존NFTwarning3. 동일139f5f1 clean snapshot 정상웹재배포GO. flagtrue보존/Studio·원본엔진변경없음. 사용자지속운영웹승인범위이며신규승인불필요.
- 일반자료dialog에서합성회사·제품소개를신청전용user_statement자료로추가하고선택·사업설명저장완료. 내용은실제기업증빙아님/기존실적없음/향후조건부계획을명시. 기존Hanambrief보존. 최종새배포후AI초안→검토저장→native위치비교/반영→다운로드/재열기를확인한다.

## 현재 운영 재배포 및 두 번째 문항 검증 — 15:18 KST
- source `139f5f1bb8dc31a01cc38c4979994b53d4ec04c6`, deployment `dpl_PjjfQPfU95ohntK67EsGLRmbkw1j` READY와 운영 alias 결속 확인. 일반 section 플래그 true 유지. 저장 자료 GET revision2/brief8/source1 및 서버 head GET 200/99411bytes/SHA `47ef0224f1c6acd2cf898076e8a779534f90ff33940edc9f81ac9d575d7b4904`로 실제 다운로드와 일치.
- 두 번째 기업 소개 request `97c5fc64-6ee9-4beb-851b-8e20bdc64b31`는 provider reported input8947/output1456 후 `section_evidence_invalid` 실패. 초안·문안·원본 반영 없음. reported 토큰 비용 추정 $0.048681을 ledger에 반영하고 maxRetries0 단일 요청 예약을 대조 해제했다. 신규 합계 $0.1179551/미확인 chat 예약 $2.9825089, $20 cap 유지.
- 재현 가능한 caller 결함: quoteExists의 두 번째 인수는 공백 정규화 원문인데 sectionComposer만 raw content를 전달하여 정확한 multiline quote도 거부한다. 다른 문서 경로와 같은 normalizeWs 계약 수정·정상/오인용 회귀 검증을 진행한다. 실패 raw 응답은 보관하지 않아 해당 실제 요청의 원인으로 소급 확정하지 않는다. validator 약화·원문 artifact 수정·demo 예외 없음.

## 인용 공백 계약 수정과 운영 재인수 — 15:25–15:35 KST
- `e09df5d48bdbd3fc979baa2867e36b2f53472921`은 quoteExists에 normalizeWs(source.content)를 전달하여 기존 caller 계약을 준수한다. CRLF·탭·다중공백 exactquote 승인과 paraphrase·없는quote·틀린ID 거부 회귀, test:writing-context 전체·웹typecheck PASS. 원문/SHA/validator/model/maxRetries0 보존. root diff 검수 PASS.
- exact source 운영 배포 `dpl_Hz2ndpkiTRbp8xJHhAauXQY9xGHP` READY, alias changupnote.com 동일ID/source metadata fullSHA 확인. 원격 build/tsc/static5·기존smokeUA HTTP200 PASS, sectionflagtrue 유지. 최초 metadata오기입 build는 alias 전환 전 CANCELED로 종결했고 source정본으로 재배포했다. 증거 `34455ca`와 deploy-web-20261001-e09df5d 태그.
- 검증 브라우저 reload 무응답 후 해당 검증 daemon만 종료하여 복구하고 새 named session `cunote-afternoon-demo-reopen`에서 정상 로그인·동일 workspace/draft를 열었다. 7쪽·15:01 서버 저장 상태·기존 문안0 확인, 등록정보/자료 재생성이나 추가model호출 없이 보존.
- section-3 보수예약$7을 선기록했고 새배포의 실제 UI에서 기업 소개 초안 요청을 실행했다. 응답 인수 진행중; 성공으로 아직 표시하지 않는다.

## 원문 후보 선택 방식으로 문항 생성 개선 — 15:34 KST
- section-3 request `546224b2-d4a0-41a5-b574-7a1e84c67d52`도 `section_evidence_invalid`로 종결. providerreported input8947/output1474/비용추정$0.048951, maxRetries0 단일예약대조해제. 신규reported합계$0.1669061+미확인chat예약$2.9825089, $20한도이내. 기존문안0·원본파일보존.
- 공백 caller 결함 수정은 회귀로 유효하나 이번 실제 응답의잘못된quote/ID는 raw미저장으로확정불가. 반복 요청만으로 해결하지 않고, 정상제품의 모델 출력 근거를 freequote/긴sourceId 작성에서 서버가 원문에서 만든 exact인용 후보ID enum선택으로 개선한다. 서버가원sourceId/quote를결속해기존 모든 validator로 검증하며public저장/UI계약은유지한다. 원문개작·수치검증완화·데모예외없음.

## 서버 인용 후보 선택 구조 검증 — 15:45 KST
- `0732c485f95a9e88862434f181a627fe0d0e37eb`: 원문줄·한국어문장별≤500char exactsubstring에서 sourceId/SHA/offset/quote 기반 deterministic 후보ID 생성. 모델은현재ID enum만선택, 서버가원sourceId+quote를복원한뒤기존출처·계획·수치·길이검증을전부적용. freequote/긴sourceId 재생성 제거. 저장/public UI WritingComposition 및 usage source_kind writing-section-v1 유지.
- unknownID/없는인용·틀린출처·plan-as-fact·수치조작·Unicode500boundary·emptyproposal 회귀와 writing전체suite/typecheck PASS. 최종동일커밋 localbuild PASS(compile8.3s/tsc15.3s/기존NFTwarning1). root diff검수 PASS.
- read-only 현행자료4개(company1/계획1/공고2)에서候補85개(company7/계획23/공고55), fullsource7375chars/units7308chars/enum2126bytes. 모델·DB쓰기·브라우저0. provider공식stringenum지원/optional·union상한에맞는구조확인; 실제provider생성인수는운영UI에서별도진행. 동일승인범위 clean0732c48 재배포착수.

## 인용 존재 통과 후 출처 종류 제한 개선 — 15:53 KST
- source0732c48 배포 `dpl_HX6aFnEZ11naUdYDd6QKDSUPmbc6` READY/exactmetadata/alias동일, build·tsc·HTTPS스모크PASS/flagtrue유지(증거17815fe). 실제UI section-4 request `e8702e2c-9f24-4bc2-b740-8b7b08f59c00`는 인용존재검증을통과했으나 `section_company_source_invalid`로failed. company_fact에공고/계획출처를선택한유형오류차단이며검증문안·원본반영없음.
- providerreported input19419/output1348/추정$0.078477, 단일maxRetries0예약대조해제. 신규합계$0.2453831+미확인chat예약$2.9825089, 승인$20이내. 실제failed상태이력보존.
- 정상제품의paragraph schema를종류별출처enum으로강화한다: 회사fact는허용company/currentdoc이며plan표현없는unit, plan은application_plan/currentdoc기본출처필수, ancillary자료별도, proposal은제안표시유지. 기존verify모든정책불변/public저장형식불변. 후보ID선택과sourcekind관계를생성스키마에서도강제하여자동반영이나demo예외없이재검증한다.

## 문단 종류별 생성 출처 스키마 검증 — 16:03 KST
- `2f44317fe164b7e77bdf7886048d9098a3fc1959`: company_fact는회사kind및미래표현없는인용unit min1/max5, plan은application_plan/current_document primary 필수+supporting max4, proposal은최대5개/빈근거가능. 적격근거가없는kind분기는제외하고provider-supported anyOf 구조로생성스키마제약. 후보별allowedForCompanyFact/allowedForPlanPrimary를prompt에도표시.
- 공개WritingComposition/기존서버검증/model/45초/retry0/출력6000/usage kind 유지. unknownunit·잘못된종류·planprimary누락·계획의사실화·수치조작·없는근거·emptyproposal·anyOf(JSONoneOf없음) 회귀와 writing전체suite/typecheck/finalbuild PASS. compile54s/tsc80s/static5/기존NFTwarning2, Mac전역부하반영. rootdiff검수PASS. 운영쓰기·모델·브라우저변경0. 승인된동일웹scope clean2f44317 재배포중.

## 수치 실패의 정확한 단건 진단 — 16:18 KST
- 실제web section5 `9f95ee0b-1703-4b0c-9176-982584243301`는 sourcekind/인용존재 gate 통과 후quantity_mismatch. provider23965/1406/추정$0.092985 reported, 무재시도단건예약대조해제. 기존문안·양식보존.
- 승인API한도내 $7선예약후 exact production2f44317의동일normal권한/자료/prompt/schema/model/retry0/45초를 로컬유한진단1회실행: request `68df727d-9a16-41bd-91fd-a2928dacb553`, provider23965/1364/추정$0.092355 reported. begin/finalizeGenerativeUsage도정상writing-section-v1원장에포함. rawoutput는소유자private0700폴더/0600파일에만저장, 콘솔은수치·인용길이·출처kind요약만출력. 진단은운영UI성공증거로대체하지않는다.
- 정확원인: plan문단2의2026년이인용에서빠짐. 선택된추진일정 인용은11월행사문장66char로서같은185char사업설명항목의앞문장2026년이문장분할로제외됐다. 다른plan문단3이모든일정문장인용할때동일2026년검증PASS. B2B의2는실제인용에있어이번실패원인아님.
- 정상structured application_plan은항목별label:value줄이원자적계획자료다. ≤500char항목은원문줄전체단일인용으로보존하고긴항목만기존문장/500chunk분할을사용하도록수정한다. 다른sourcekind/companyfact정책·수치검증불변. 실제비공개출력의참조를새wholeline로재결속하여offline전체validatorPASS를확인한뒤동일소스테스트/build/운영배포로이어간다.
- 현재신규reported추정$0.4307231+미확인chat예약$2.9825089, 사용자합산$20상한준수. invoice금액이아닌토큰추정이다.

## 계획 항목 맥락 보존 배포 및 실제 UI 재인수 — 16:34 KST
- source `39184d298a6d5ca57146f7c026d51751c284ebcd`: application_plan의 ≤500char 항목 줄을 exact 원문 단위로 보존하여 연도·조건·예산 맥락이 문장 분할로 유실되지 않게 한다. 다른 자료 종류·출처·수치 validator는 그대로다. 실제 비공개 응답의 문안·종류를 바꾸지 않고 새 인용 단위에 결속한 offline 전체 검증 PASS, 회귀·writing suite·typecheck·final build PASS. 공개 proof는 `docs/evidence/afternoon-demo-api-budget-20261001/section-plan-context-offline-proof.json`.
- feature branch source391 push와 태그 `deploy-web-20261001-39184d2` push 완료. clean archive 운영 배포 `dpl_62b8nM37d7WtR2TfKicbvmzKiERy` READY/source391/운영 alias 동일 확인, 원격 build·tsc·HTTPS 3경로 200/flagtrue 유지. 배포 증거 commit b294fd1.
- 동일 정상 UI 세션 reload 후 기업 소개 section-6을 보수 예약 $7 안에서 요청. 응답 인수 진행 중이며 아직 초안 성공·양식 반영으로 표시하지 않는다.

## 실제 초안 생성 성공과 양식 반영 검수 — 16:36 KST
- 운영 section6 request `85ee30ca-f281-4e15-a8c0-a5382361a49b` 기업 소개 ready/4문단/11인용. 서버 출처·인용·수치 전체검증 PASS. 정상 UI에서 초안 가져오기·문안 저장 revision1, 문항 맥락에 맞게 회사 사실 2문단만 343char로 검토하고 revision2 저장. 합성기업/기능시연/현재실적없음 명시 유지. proof `docs/evidence/demo-live-20261001/section6-ready-readback.json`.
- 정상 '저장 문안과 양식 비교'에서 안전한 빈칸·안내문을 확인하지 못해 반영 차단. native 읽기검증상 해당 셀은 비어 있으므로 현재 앵커/비교 안전계약을 조사한다. 직접 편집으로 우회하지 않고 일반 경로 수정을 검증한다. 기존 양식 bytes 변경0.
- section6 provider reported22617/1209/추정$0.085986, 단일무재시도 예약대조해제. 신규reported합계$0.5167091 + 미확인chat예약$2.9825089. section7 사업계획은 별도 $7예약 후 정상 UI 생성 진행 중.
