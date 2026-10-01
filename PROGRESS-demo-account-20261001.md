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
