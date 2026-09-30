# 작성 중심 구현 진행

- 목표: `docs/plans/2026-09-30-authoring-first-implementation.md` 전체 범위를 따라 작성 중심 기능을 구현·검증한다.
- 시작: 2026-09-30. 브랜치 `coolwithyou/authoring-first`, base `ab4e7254aa5bef09e8c3fb4d0de40394efa696a9`.
- 격리 위치: `/Users/ffgg/orca/workspaces/cunote/authoring-first`. 메인의 미커밋 코드와 디자인 세션 보존.
- 사용자 지시: 상세 구현 시작. 계획만으로 완료하지 않음. 운영 배포·DB 변경·신규 유료 실행은 별도 경계 유지.

## 단계와 검증

- [ ] P0 기존 양식/파일 경로: `pnpm test:apply-workspace`, `pnpm test:document-agent`, 실제 양식 왕복.
- [ ] P1 매칭 독립 작성 진입/재개: 작성 CTA·capability·권한/문서선택 회귀.
- [ ] P2 회사 자료·brief: contracts/schema/API/UI, 격리 DB 권한·충돌·재사용.
- [ ] P3 문항 초안·질문·반영: 근거·버전·Undo·저장, 실제 양식 인수.
- [ ] P4 유연한 후보 탐색·필요한 정보원: 조건 경계/unknown 보존 회귀.
- [ ] P5 실제 사용자 5명·양식 3종 파일럿과 판단 보고.
- [ ] P6 결과에 따른 후속 범위 결정(독립 양식·미등록 공고 등).

## 현재 확인

- Orca 실행 상태 확인. 메인에 디자인 검토 세션이 활동 중이며 제품 구현 파일을 이 세션에서 덮어쓰지 않는다.
- Cunote 4010/4011 개발 서버 없음. 포트3001은 다른 프로젝트. 브라우저 실제 인수는 서버/환경 준비 후 진행.
- 새 워크트리 의존성 설치 완료. 운영 `.env`는 복사하지 않는다.

## 외부 의존성

- 실사용자 자료·실계정 인증과 파일럿 참여는 아직 확보하지 않음. 합성 검증을 실사용 근거로 취급하지 않는다.
- 운영 변경이나 사용자 대면 유료 모델 실측 없이 진행할 수 있는 코드·격리 검증부터 수행한다.

## 2026-09-30 구현·검증 기록

- 기준선: 의존성 설치, build:packages, test:apply-workspace, test:document-agent, test:profile-autofill PASS.
- P0 부분 증거: `CUNOTE_REQUIRE_INSTITUTION_FORM_FIXTURES=1 pnpm test:product-postgres` PASS. 실제 기관 HWP/HWPX 원본으로 RHWP 편집→격리 PostgreSQL/메모리 저장소 저장→재열기. R2·브라우저·외부 한글 인수는 미실행.
- W1: discovery라도 HWP/HWPX 양식이 있으면 workspace로 진입. PDF preview만으로 원본 편집/80% 자동 입력을 약속하지 않음. 기존 작성 CTA logic 회귀 PASS.
- W2/W3: company_writing_sources, document_writing_briefs 및 draft별 API/자료 패널 추가. 회사 공통/신청 전용 scope, immutable 원문 SHA, 요청 멱등성, 자료 철회, brief revision 충돌과 입력 보존.
- source 목록은 본문을 가져오지 않고 metadata만 조회. 생성 근거는 선택한 자료 10개/60,000자 상한, 원문은 30,000자 상한. 철회는 이후 생성 차단이며 기존 문서 텍스트를 지우지 않음.
- `writingContextPostgres.integration.ts`를 기존 격리 runner에 연결. 새 migration 포함 95개 적용, cross-tenant/forged role/viewer/scope/retry/CAS/철회/불변성 검증 PASS (`/tmp/cunote-authoring-first-writing-pg.log`).
- `pnpm typecheck`, `pnpm verify:route-policy`, `pnpm verify:openapi` PASS(새 grounding 연결 전). 이후 수정에 해당 gate 갱신 필요.
- 기존 DB snapshot이 0080에 멈춰 있어 generate의 기존 0081~0093 객체 재생성을 제거하고 새 writing 2개 테이블 SQL만 유지. snapshot은 현재 schema로 정렬. bigint 기본값 `1n`은 drizzle-kit JSON 직렬화 오류를 일으켜 의미가 같은 SQL `1`로 변경.
- 기존 DELETE confirmations route가 policy 목록에서 누락된 것을 확인하고 session-protected 목록에 보완.
- 문단 AI 근거에 회사 자료/신청 계획을 별도 kind로 연결. 생성·수락 단계 모두 현재 근거를 재구성하여 brief/source drift와 철회를 반영. 문항 composer 전체 구현과 실제 모델 품질 확인은 아직 남음.

## 이어서 할 일

- P1 실제 렌더 동선과 문서 재개, 준비 큐의 현재 기능 재확인.
- P2 PDF 자료 수집/추출, 자료 UI 상호작용 검증과 기존 권한 회귀.
- P3 문항 계약·생성 원장·문항 UI·안전한 반영·질문·숫자 일관성 검증을 구현. 기존 문단 AI만으로 P3 완료 처리하지 않음.
- P4 유연한 탐색 정책, P5 실사용 인수, P6 파일럿 기반 결정은 미완료.

## 문항 생성 연결과 실제 양식 검증

- W5 부분 구현: long_text 필드는 여러 문단의 section composer를 사용한다. 회사 내용/사용자 계획/검토 제안을 구분하고 질문은 최대 3개다. 자료의 인용·숫자·단위 대조, 문항별 사용량·생성 결과 저장, 기존 반영/Undo를 연결했다. 실제 모델 품질은 미검증.
- brief/선택 자료의 SHA 결속을 생성 요청, start_apply, 최종 snapshot 저장까지 확인한다. 변경·철회 후 오래된 초안의 반영은 차단하며 Undo는 허용한다.
- 이번 세션 확인: `/tmp/cunote-authoring-first-gate.log` 체인(typecheck, writing-context, document-agent, apply-workspace, route-policy, openapi) exit 0. 웹 build `/tmp/cunote-authoring-first-build.log` exit 0.
- 96개 migration을 적용한 격리 PG PASS: `/tmp/cunote-authoring-first-section-pg.log`. 새 DB/API 권한, source/brief CAS·철회, start_apply 시 binding 변경 거절 포함.
- 실제 사업계획서 추가 표본: `PBLN_000000000123505`, 로컬 `16_3852550670afd359-바이오스타_2.0_-_사업계획서.hwpx`. 합성 회사 자료+brief로 KIST 연구팀 매칭, 기술고도화/PoC, 사업화/투자유치의 서술형 활용계획을 연결하는 회귀를 추가.
- **미통과:** 앞의 두 셀에 각각 여러 문단을 입력하면 표의 뒤쪽 셀이 페이지 높이 밖으로 이동하고 세 번째 위치가 missing이 된다. 설치된 RHWP core 0.8.4, Node의 결정적 폭 계산에서 재현. 원본 표는 `pageBreak=CELL`이다. 실제 브라우저/외부 한글에서 동일한지 미검증이며, resolver의 페이지 경계 보호를 해제해 통과시키지 않는다.
- 재현 명령: `CUNOTE_REQUIRE_WRITING_FORM_FIXTURES=1 pnpm test:product-postgres`. 기존 기관 양식 marker 회귀와 다른 범위이므로 별도 opt-in이며, 이 작성 회귀의 실패를 기존 PASS로 대체하지 않는다. 실패 로그 `/tmp/cunote-authoring-first-narrative-pg.log`, 로컬 probe `spike-out/authoring-first/narrative-probe.hwpx`.
- 남은 작업: RHWP 표 분량/페이지 처리와 실제 Studio 반영 확인, 자동 반영 위치가 없는 문항의 문안 보관/복사, PDF 자료, 문서 전체 일관성, 유연한 탐색, 파일럿. W4~W7 완료 아님.

## 유연한 탐색과 명시적 양식 준비

- P4 부분 구현: `projectDiscoveryCard`를 teaser 선택과 목록 표시에서 사용. matcher eligibility를 덮어쓰지 않고 source_changed/미검수/필수 unknown/우대 fail을 탐색 후보로 유지한다. flat 조건의 일부 fail과 pass/unknown을 AND로 추측하지 않는다. 현재 원문 SHA·검수 상태·조건 근거가 있고 필수 조건 전체가 fail인 경우만 제외한다.
- source-bound 검수 복합식이 주어진 경우 기존 `evaluateCompoundProjection`을 사용한다. 현재 serving 저장소에는 이 복합식 공급 경로가 없으므로 새 자동 OR 해석/검수 발행을 완료한 것은 아니다. 연결 전에는 혼합 결과를 검토 후보로 유지한다.
- KST 날짜만 있는 당일 마감은 유지하고, 마감 시각·지난 날짜는 후보에서 제외한다. 마감된 카드가 검토 슬롯을 채우지 않는다. 기존 작성본 접근/삭제 경로는 변경하지 않는다.
- 회사 정보가 여러 개 부족한 `preparable`을 '현재 신청 어려움'에서 분리해 '회사 정보를 더 확인할 후보'로 노출. 제외 목록은 접힌 '제외된 공고 보기'로 구분한다. 전체 제외 목록의 별도 조회·사용자 복원 저장 기능은 아직 남음.
- `/tmp/cunote-authoring-first-discovery-cases.log` PASS: core build, discovery 경계, match-results logic, first-mission-flow, match-explanation, match-card. Programs 정적 렌더와 build-initial-company-match도 PASS. 실제 후보 사람 대조는 미실행.
- P1 보완: pending 수만으로 '분석 중'을 약속하지 않는다. 페이지 mount의 자동 변환 POST를 제거하고 명시적 준비 버튼으로 기존 45초/3양식 sweep을 실행. 완료/추가 확인/실패/실행 불가를 구분하며 회사 편집 권한과 선택 회사 헤더를 적용한다. 관리자·가상 기업 미리보기는 요청 UI 제외.
- 최신 UI/서버 번들 build `/tmp/cunote-authoring-first-current-build.log` exit 0. grant-overview logic와 route policy(158 API methods) PASS. 그 뒤 제안 이력의 회사 scope 재검사를 추가해 별도 PG/typecheck 진행.
- 기존 field-agent GET 이력이 created_by만으로 조회되던 간격을 보완: 현재 membership과 draft.companyId를 검사한 후 근거/문단을 반환. 다른 회사가 선택된 동일 사용자와 membership 철회 사례를 격리 DB 회귀에 추가.
- 추가 권한 변경까지 `/tmp/cunote-authoring-first-access-pg.log` PASS(96 migrations, 기관 HWP/HWPX 포함), `/tmp/cunote-authoring-first-final-types.log` web typecheck PASS. 서술형 3문항 별도 회귀는 여전히 미통과이며 이 PASS에 포함하지 않는다.

## 자동 입력 위치와 독립적인 문안 보관

- `document_writing_sections`와 요청별 `document_writing_section_runs`를 추가(0096). 회사 권한·RLS를 적용하고 문안의 CAS 버전과 생성 요청을 분리했다. 입력 위치나 native revision 없이 기존 양식의 서술형 문항을 작성·저장·복사한다. 분석에서 문항이 사라져도 저장한 문안은 유지한다.
- 같은 요청 ID는 모델을 다시 호출하지 않는다. 문항별 진행 중 요청은 중복 착수를 거절하고 90초가 지난 요청은 실패로 표시한다. 생성 중 문안 수정은 보존하고 오래된 제안으로 표시한다. 회사 자료 철회·사업 설명·문항 변경이 발생하면 생성 결과를 저장하지 않는다.
- `WritingSectionsPanel`에서 문안 저장·복원·충돌 비교·초안/질문/인용 확인·복사를 지원한다. 이 저장은 실제 양식 파일 반영이 아니라고 표시한다. 새 AI 경로는 독립 `CUNOTE_WRITING_SECTION_AGENT_ENABLED=true|1`일 때만 열리며 기본 비활성이다. 플래그가 꺼져도 저장 문안의 조회·수정·복사는 유지한다.
- `/tmp/cunote-authoring-first-manuscript-pg.log` exit 0: 97 migrations, 실제 PostgreSQL의 문안 권한/RLS/CAS, 중복·동시 생성, 생성 중 수정·철회, 만료 요청 재시도, 문항 삭제 후 보존. 생성기는 주입한 합성 응답이며 실제 모델 품질 증거가 아니다. 이번 실행의 기관 원본 fixture는 SKIP이며 이전 기관 파일 PASS를 반복 실행하지 않았다.
- `/tmp/cunote-authoring-first-manuscript-types.log` web typecheck exit 0. 4010/4011 listener 재확인 결과 없음. 브라우저 인수와 외부 한글 검증은 미실행.
- 기존 field-agent 원장은 `base_revision_id`와 물리 입력 target을 필수로 요구한다. 이를 가짜 좌표로 채우거나 nullable로 완화하지 않고 문안 생성 요청만 별도 원장에 보관했다. 문안은 저장/생성 상태를 가지며 실제 파일 적용·Undo는 기존 원장이 담당한다.
- 레이아웃 후속: 설치된 core의 `reflowLinesegs()`는 해당 편집본에서 0을 반환하며 문제가 유지된다. 표 pageBreak 값을 재설정해도 이 fixture의 잘림은 유지(`/tmp/cunote-authoring-first-reflow.log`). upstream [#7288](https://github.com/edwardkim/rhwp/issues/7288)에도 0.8.6의 표 페이지 분할·용지 밖 넘침 신고가 열려 있다. 같은 원인이라고 확정하지 않으며 의존성을 무조건 올리거나 원본 표 속성을 제품에서 바꾸지 않는다.
- 브라우저 검증용으로 사용자가 직접 실행할 authoring-first 개발 서버와 테스트 회사 정보를 비동기로 요청했다. 서버 시작 금지 규칙은 유지하고 독립 구현을 계속한다.
- 문안 패널까지 웹 build `/tmp/cunote-authoring-first-manuscript-build.log` exit 0, route policy 161 API methods PASS, `git diff --check` PASS.

## 회사 PDF 자료

- 0097에 원본 PDF 불변 메타데이터 추가. 별도 Node PDF.js 프로세스에서 텍스트 추출 후 AES-256-GCM 암호문만 R2 adapter에 저장한다. 회사/신청/요청/원본 SHA를 인증 문맥으로 결속하며 원본 다운로드는 회사 권한·자료 철회·암호문/원본 SHA를 재검사한다.
- 4MiB·30쪽·30,000자, 20초, V8 heap 128MiB, 프로세스당 동시 추출 2개 상한. 스캔/암호/빈 텍스트 페이지/부분 실패는 보관 완료로 처리하지 않는다. 새 PDF는 사용자가 추출 결과를 확인하고 선택하기 전 생성 자료에 자동 편입하지 않는다.
- 운영 `CUNOTE_WRITING_SOURCE_KEY_BASE64`와 R2 설정을 생성/변경하지 않았다. 설정이 없는 환경은 PDF 업로드 비활성, 텍스트 자료 계속 사용. 원본 암호화·키 교체 한계·미참조 암호문 회수 미구현은 [운용 설명](docs/explainers/회사자료-PDF-보관.md)에 기록.
- `/tmp/cunote-authoring-first-pdf-writing.log` PASS: 기존 작성 근거 suite와 실제 PDF.js 파서·암호화·동시 추출 상한. `/tmp/cunote-authoring-first-pdf-final-pg.log` exit 0(98 migrations): 실제 격리 DB/메모리 저장소 PDF 왕복·재시도·scope·불변성·원본 변조·다운로드 중 철회 포함. 실제 R2·모델 호출 없음.
- 웹 typecheck `/tmp/cunote-authoring-first-pdf-types.log` exit 0. 새 API route policy 163 methods PASS. PDF 본체/worker가 Next trace에 포함됨을 확인했다. 최신 source 기준 build `/tmp/cunote-authoring-first-pdf-final-build.log` exit 0. 운영 subprocess와 실자료 추출 품질은 미실행.

## 표 넘침 자동 저장 보호

- field-agent의 표 입력 저장 전에 원본 revision과 결과 바이트를 같은 RHWP core로 읽고 해당 표의 모든 셀 조각을 용지 경계와 비교한다. 새 넘침·누락된 셀 위치는 409로 거절하며 객체 업로드/DB head 변경을 하지 않는다. Undo와 수동 편집 저장은 이 자동 입력 보호의 대상이 아니다.
- 기존 클라이언트는 자동 적용 후 서버 저장 실패 시 native revert를 수행하는 경로를 사용한다. 이 브라우저 rollback은 이번에 실제 실행하지 않았으며 기존 transaction 회귀(`/tmp/cunote-authoring-first-layout-transaction.log`)만 PASS다.
- `CUNOTE_REQUIRE_WRITING_LAYOUT_SAFETY=1 pnpm test:product-postgres` exit 0(`/tmp/cunote-authoring-first-layout-safety-pg.log`, 98 migrations). 실제 바이오스타 HWPX 원본에서 20문단 넘침을 재현하고 거절 후 업로드 0회·이전 head/원본 SHA 보존을 확인했다. 이는 실패의 안전한 격리 증거이며 3문항 작성 왕복 성공이 아니다.
- `tableLayoutGuard.test.ts` PASS(여러 쪽 셀 조각, 기존 넘침 개선, 새 넘침/누락/잘못된 page 거절), web typecheck `/tmp/cunote-authoring-first-layout-safety-types.log` exit 0. 별도의 `CUNOTE_REQUIRE_WRITING_FORM_FIXTURES=1` 작성 인수 실패는 유지한다.

## 저장 문안 점검과 지침 분리

- 보관한 문안/사업 설명에 명시된 `항목: 값`의 사업명·사업기간 순서·동일 연도/실적/목표 수치와 한 문안 안의 총사업비=정부지원금+자부담을 점검한다. 단위 환산은 정수 연산으로 수행하며, 연도/목표가 다른 값·복합 단위·자유 문장·빠진 합계 항목은 추측하지 않는다. 자동 수정이나 제출 가능 판정은 없다.
- 점검 UI는 저장된 문안만 대상으로 표시하고 미저장 변경이 있으면 저장을 안내한다. 실제 HWP/HWPX의 전체 문서 일관성 검증과 구분한다. 문안 변경을 저장하면 이전 점검 결과를 지운다.
- `writingConsistency.test.ts` PASS, `/tmp/cunote-authoring-first-consistency-pg.log` exit 0(98 migrations, 실제 저장 문안의 합계 불일치 반환 포함), web typecheck `/tmp/cunote-authoring-first-consistency-types.log` exit 0.
- 문단 AI의 dynamicContext 전체가 회사 프로필 근거로 분류되던 부분을 수정. 회사 프로필과 승인 작성 지침을 별도 source kind로 보존하고 문단 prompt v4에서 지침 예시를 회사 실적으로 사용하지 않도록 명시했다. `writingGuidanceSources.test.ts`, 기존 chat grounding와 문단 prompt 회귀 PASS. 문항 composition 검증에서도 writing_guide를 회사 사실 근거로 거절한다. 실제 모델의 의미 정확성은 여전히 미검증이다.
- 저장 문안 UI와 근거 분리까지 웹 build `/tmp/cunote-authoring-first-consistency-build.log` exit 0. 새 회귀는 기존 `test:writing-context`와 `test:document-agent` 명령에 포함했다.

## 브라우저 인수 전 남은 경계

- Next Link 이동은 beforeunload가 발생하지 않아, 회사 자료/문안이 dirty일 때 내부 링크 이동을 막고 저장을 안내하도록 보완했다. 새 탭·다운로드·같은 페이지 anchor는 유지한다. browser history와 프로그램에 의한 router 이동은 실제 인수 대상이며 모든 이탈 방지를 완료했다고 주장하지 않는다.
- 실제 실행할 [인수 목록](docs/plans/2026-09-30-authoring-first-acceptance.md)에 권한·충돌·문안·PDF·양식 증거와 미완료를 분리했다. 4010/4011에는 여전히 사용자 실행 서버가 없고 실제 사용자/회사 자료·모델 품질 실행 범위도 없다. 운영 쓰기 없이 확인한 코드/격리 증거까지만 현재 결과다.
- 내부 링크 보호 변경의 web typecheck `/tmp/cunote-authoring-first-navigation-types.log` exit 0. 문서의 상대 링크와 `git diff --check`를 확인했다. 전체 build는 직전 저장 문안/근거 분리 상태의 증거이며 마지막 링크 보호의 실제 브라우저 동작 증거로 대체하지 않는다.

## 제외 공고 조회와 사용자 복원

- 목표: 추천 페이지에서 빠진 활성 공고의 제외 이유를 별도 조회하고 회사별 복원을 저장한다. 매칭 적격성과 작성본은 변경하지 않고 마감은 복원보다 우선한다.
- [x] 전체 활성 카드 집합의 제외/복원 페이지와 회사 문맥 API: `discoverySelections.test.ts` PASS, route policy 165 API methods PASS. 추천 페이지와 별도 조회하며 서버의 전체 활성 집합 상한 초과 오류를 숨기지 않는다.
- [x] 0098 회사별 복원 선택/CAS/RLS와 현재 membership 재검사: `pnpm test:product-postgres` exit 0, 99 migrations(`/tmp/cunote-authoring-discovery-pg.log`). 동시 저장 1회 성공, 회사 간 격리·viewer/철회 권한·마감/숨긴 공고 차단 PASS.
- [ ] UI 복원/취소·페이지 조회·회사 전환: web build 및 사용자 실행 서버에서 브라우저 인수.
- 결정: 마감 공고는 사용자 요청대로 새 검토 대상에서 제외한다. 기본 매칭 결과를 덮지 않고 ‘다시 살펴볼 공고’ 목록으로 복원한다. 신규 공급자·유료 호출은 추가하지 않는다.
- 복원/취소는 회사 공유 선택이며 현재 사용자별 계산된 자격 결과는 그대로 표시한다. CAS 충돌은 자동 덮어쓰지 않고 재조회를 안내한다. 회사별 컴포넌트와 요청 취소로 늦게 도착한 이전 회사 응답을 분리했다. 실제 브라우저 동작은 미검증.
- 기존 Programs 정적 렌더 회귀 PASS. 첫 typecheck의 fixture 필수 필드 누락을 수정한 뒤 최종 웹 build(`/tmp/cunote-authoring-discovery-build.log`, TypeScript 포함) exit 0. 이 결과는 브라우저 복원 버튼 인수를 대신하지 않는다.

## 바이오스타 표 페이지 분할 후속 실험

- 서버의 마감 처리를 재추적했다. `toMatchCard`가 이미 주어진 `asOf`로 만료 상태를 `closed`에 투영하므로 이번에 기본 추천 경로를 중복 수정하지 않았다.
- 실패 편집본에서 `pageBreak`만 변경한 기존 실험과 달리, 대상 표의 `treatAsChar=false`를 설정하면 native 5쪽→6쪽으로 분할되고 세 번째 ‘사업화 / 투자유치’ 입력 위치가 unique로 복원됐다. `pageBreak=1`/`2` 단독은 해결하지 못하며 이 fixture에서는 inline 배치가 핵심 분기다. 다른 문서 전체로 일반화하지 않는다.
- 공개 원본을 새로 열어 이 속성 하나를 명시적으로 바꾼 후 같은 길이의 3개 서술 문항을 모두 입력했다. HWPX export/reopen 후 셀 3/5/11의 문안·나머지 셀 문구 보존, 나머지 표 속성 동일, 기존 용지 넘침 guard PASS. 원본 양식 파일은 변경하지 않았다.
- 재현: `pnpm exec tsx --tsconfig apps/web/tsconfig.json spike-out/authoring-first/verify-flow-roundtrip.ts`; 로그 `/tmp/cunote-authoring-flow-roundtrip.log`. 검토 파일 `spike-out/authoring-first/narrative-flow-roundtrip.hwpx`, SHA `e505d64c9b4950a5cb0df8c3c2490c2cdadf9a0023ea41bbd269cde4dbb68c23`.
- 이 실험은 원본 속성을 보존하는 기존 `CUNOTE_REQUIRE_WRITING_FORM_FIXTURES=1` 실패를 대체하지 않는다. 배치 변경으로 x 좌표도 일부 바뀌므로 사용자에게 숨긴 자동 수정은 추가하지 않았다. 실제 Studio에서 표 속성 변경을 선택하고 저장/Undo/외부 한글 재열기한 시각 증거가 필요하다. 사용자 실행 서버 요청은 답변 대기이며 실제 모델 호출은 없다.
