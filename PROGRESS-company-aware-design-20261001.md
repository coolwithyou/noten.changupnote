# 사업자 정보 기반 디자인 개선 진행

- 목표/완료 조건: [계획](docs/plans/2026-10-01-company-aware-design.md)의 전 범위.
- 시작: clean authoring-first 0f8c434, 기존 Claude 세션은 입력 대기. main dirty는 별도 보존.
- [x] 최신 세션/작업트리 확인, 계획과 검증 범위 확정.
- [x] 탐색 화면 구현/검증/커밋: `6577e43`, context/A·B/미확인 + 관련 7 tests/typecheck.
- [x] 상세와 신청 관리 구현/검증/커밋: `3a79067`, `5be0e21`, condition/render/logic·pipeline render/typecheck.
- [x] 작성 화면 구현/검증/커밋: `83650d5`, Workspace/RHWP render·필드 session·transaction·안전반영 tests/typecheck.
- [x] 통합 브라우저 fixture/화면 캡처/관련 tests/typecheck: 31 checks/21 captures PASS, 원본 편집 인수는 명시 분리.
- [x] 목표 전체 audit, 검증 결과/잔여 경계 기록, 최종 scoped commit: 제품/문서/fixture 완료, 배포 경계 유지.

## 결정 로그
- 익명/로그인 모두 실제 사업자 정보를 기반으로 하는 UI. 회사별 사실·원문 비교를 핵심으로 한다.
- 문구만 교체하지 않고 구조와 동선을 개선한다. 기존 권한·원문·저장/Undo는 유지한다.
- CLAUDE.md의 구현 위임 규칙에 따라 탐색/작성은 파일 범위를 분리한 보조 에이전트에 위임한다.
- 사용자 서버를 교체하지 않으며 제한된 fixture 브라우저를 통해 현재 소스 화면을 검증한다.

## 막힘
- 현재 없음. 실로그인 운영 저장/AI·배포는 이번 로컬 구현 검증과 분리한다.

## 구현 및 검증 기록

- 제품 소스 최종 검증 기준: `3efae522d705c4123adc478203f951be29088344`.
- 탐색: 회사명/값/출처/기준일, 미확인·partial·분쟁, 익명 임시 상태, 자동 패널 제거,
  조건 대조와 정보 보완 접힘. 모바일 실캡처를 보고 지역·업종만 우선 노출하도록 조정.
- 상세: 선택 회사 문맥 전달, 회사 정보 펼침, 조건 대조 기본 펼침, 원문 조건/회사값/결과,
  회사별 프로필 링크. 자격 fail과 저장본 복귀 독립 유지.
- 작성: 원본+문항 병렬/모바일 전환, 기존 mounted input 유지, 파일 저장·내보내기 상단 배치.
  saved-text 비교 후 최신 revision/text와 위치 재검증. unique table-cell 빈칸/원래 안내문,
  ≤4,000자만 반영. body/기존 내용/위치 미확정/긴 문안은 복사. 기존 manual verification
  transaction과 rollback/lock을 재사용하고 서버 DTO·DB를 바꾸지 않음.
- 신청 관리: 다음 작업·최근 저장·복귀 버튼 우선, 자격·작성 기능 보조 펼침, 마감 저장본 정상 명도.
- 관련 검사 통과: CompanyMatchingContext, MatchResultsExperience, Programs.render, matching logic,
  profileSourceHelp, ownedMatchingClient, DashboardView.render, EligibilityMatchAccordion.render,
  grant-overview logic, ApplicationPipelineView.render, WorkspaceView.render, RhwpStudioSurface.render,
  fieldAwareDocumentSession, studioProfileAutofillTransaction, studioFieldAgentTransaction,
  writingFieldApplication; web typecheck 및 git diff --check.
- 최종 회사 요약/모바일 대조 수정 뒤 관련 context/condition/application tests와 typecheck 재확인.
- 전체 build/전체 suite 미실행: 공유 계약·판정 엔진·DB 변경 없음. 영향 컴포넌트 테스트와
  typecheck 및 실제 제품 컴포넌트 browser fixture로 국소 화면 변경을 검증한다.
- 원본 HWPX 실제 편집·다운로드·운영 저장 인수는 이번 합성 fixture에 포함하지 않는다.
  실제 RhwpStudioSurface의 source unavailable 상태와 저장 버튼 제한만 browser로 확인하며,
  성공 편집/반영 안전성은 기존 transaction 회귀 테스트 범위다.

- 최종 브라우저 결과: [검증 기록](docs/evidence/company-aware-design-20261001/README.md), [receipt](docs/evidence/company-aware-design-20261001/report.json). 31 checks/21 captures PASS. 실패 자격 쟁점과 회사 문맥을 보존한 저장본 복귀도 390px에서 확인.
