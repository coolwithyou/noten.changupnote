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
