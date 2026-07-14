# Claude Design 전면 적용 디자인 QA — 2026-07-14

## 범위와 기준

- 디자인 정본: `docs/design/2026-07-14-changupnote-frames.dc.html`
  - 지원서 작성 도우미 `s8`: 35~225
  - 랜딩 v3·캘린더: 227~473
  - 로그인·알림·계정 인접 화면 `adj`: 476~618
  - 회사 확인 `s2`: 620~658
  - 매칭 결과·내 정보 `s3*`, `s4`: 660~1013
  - 공고 요약 `s5`: 1015~1057
  - 신청 관리 `s6`: 1059~1103
  - 대시보드 `s7`: 1105~1139
- 공유 컴포넌트 정본: `docs/design/2026-07-14-components/`
- 구현 대상: `http://127.0.0.1:4010`
- 검증 사업자번호: `893-81-00911` — 캐시된 `(주) 바톤` 데이터 사용
- 대표 실제 공고:
  - `8688f77b-6107-4e68-a1b8-4d64f5699d46`
  - `f20d0e5d-a565-4092-82e7-4c841390482f`
  - `0fd0ea1a-ac91-4c75-8b10-e0ca052ae166`
- 비교 방식: 동일 Orca 브라우저 검토 컨텍스트에서 정본 프레임과 실제 구현을 화면 단위·집중 영역 단위로 함께 대조했다. 데스크톱 1440 구조와 디자인에 별도 프레임이 있는 모바일 390 흐름을 기준으로 삼았다.

## Full-view comparison evidence

- 랜딩과 회사 확인: 랜딩 v3의 단일 히어로 입력, 실데이터 공고 수, 데모 카드, 마키, 3단계, FAQ, 회사 확인 3상태가 기존 퍼블릭 퍼널과 연결된다.
- 매칭 결과: 결과 헤드라인 → 정밀도 게이지 → 다음 질문 1개 → 상태별 공고 목록 → 내 정보 시트 순서를 유지하며, 모바일에서는 질문 카드를 첫 작업으로 올린다.
- 공고 요약: 제목·기관, 핵심 3지표, 주 CTA 1개, 아코디언 3개, 푸터 링크의 5단 구조를 유지한다.
- 대시보드·신청 관리·캘린더: 다음 행동 카드 1장과 3개 탭, 3그룹 신청 목록, 월 이동 가능한 캘린더가 정본 정보 구조와 일치한다.
- 지원서 작성 도우미: ladder a/b일 때 60/40 문서 프리뷰·인터뷰, 하나씩/전체 목록, 모바일 상단 프리뷰 크롭을 구현했다. 다만 현재 허용된 실제 데이터는 모두 ladder c이므로 이 핵심 상태의 라이브 시각 증거는 아직 만들 수 없다.

## Focused region comparison evidence

- 공고 상태 SSOT는 `open`, `one_answer`, `check_source`, `closed` 네 가지로 고정했다. 예정 공고는 신청 가능으로 표현하지 않고 `check_source`로 내린다.
- `one_answer`는 고유한 progressive 질문이 정확히 1개이고 다른 미해결 조건이 없을 때만 표시한다.
- 신청 관리는 추천 목록을 복제하지 않고 초안·저장·메모·제출 등 사용자 행동이 있는 공고만 편입한다. 동적 재검증에서 진행 중이 84건에서 실제 추적 중 4건으로 정리됐다.
- 대시보드 매칭 탭은 Phase 3의 공고 표현과 PrecisionGauge를 재사용한다.
- 작업공간 채팅은 실제 질문에 응답했고, 응답 후 입력 잠금이 해제됐다. 25초 타임아웃·중단·재시도 상태는 순수 상태 테스트로 보강했다.
- 앱 셸은 데모 접근에서도 로그인 링크 대신 데모 계정·제품 링크를 표시해 실제 데이터 상태와 일치시켰다.

## Findings

### 해결한 P1

1. 신청 관리가 추천 공고 84건을 실제 신청처럼 노출하던 문제
   - 수정: 사용자 행동이 있는 공고만 파이프라인에 포함하고 feedback-only 이력은 계속 보존한다.
   - 재검증: `/applications`에서 진행 중 4, 결과 대기 0, 종료 0.
2. 예정 공고와 복수 미해결 조건이 `지금 신청 가능` 또는 `답하면 확정`으로 과장되던 문제
   - 수정: 상태·질문 수·원문 확인 조건을 함께 검사하고 실재하는 CTA만 만든다.
3. 공개 프로필 입력이 영속 저장처럼 보이던 문제
   - 수정: `이 결과에 반영`, `방금 반영됨`으로 실제 범위를 명시한다.
4. 작업공간 채팅 요청이 장기 pending 상태에서 입력을 잠그던 문제
   - 수정: 25초 타임아웃, 요청 중단, 입력 해제, 같은 질문 재요청을 추가했다.
5. 데모 데이터 화면의 셸이 비로그인 상태로 보이던 문제
   - 수정: 비강제 인증의 앱 그룹에서 데모 계정 헤더를 사용한다.

### 남은 P1 — 구현이 아닌 데이터 게이트

- `f20d0e5d-a565-4092-82e7-4c841390482f`, `0fd0ea1a-ac91-4c75-8b10-e0ca052ae166`에는 HWP/HWPX archive와 markdown 변환본은 있지만 `grant_application_surfaces`, page artifact, `grant_document_fields`가 모두 0건이다.
- 이 상태에서 구현은 정직하게 ladder c의 채팅·초안 폴백을 보여준다. 문서 프리뷰나 필드를 가짜로 승격하지 않았다.
- attachment surface 백필 dry-run에서는 두 sourceId의 첨부 4건·2건이 후보로 확인됐다. 실제 쓰기는 DB surface 생성, 외부 변환 job, R2 산출물 업로드를 동반하고 자동 rollback이 없으므로 이번 구현 범위에서 실행하지 않았다.
- ladder b 라이브 검증에는 surface 등록과 conversion poll이, ladder a에는 별도의 field candidate 검수·적용이 추가로 필요하다.

### 비차단 P2

- 신청 행의 overflow 메뉴는 정본 예시 3개보다 기능 밀도가 높다.
- 공고 요약의 `대상`은 원문 audience 문구보다 판정 집계를 우선한다.
- 대시보드의 일부 정보 보완 CTA는 필드 단위 앵커보다 회사 설정 섹션으로 이동한다.

## Primary interactions tested

- 사업자번호 입력 → 회사 확인 → 매칭 결과 진입
- 매칭 다음 질문과 내 정보 반영 흐름
- 대시보드 3개 탭 전환
- 공고 요약 아코디언 열기/닫기
- 신청 행 overflow 메뉴와 캘린더 진입
- 캘린더 7월 → 8월 → 7월 이동
- 작업공간 질문 전송 → 실제 답변 수신 → 입력 잠금 해제
- `/`, `/dashboard`, `/applications`, `/applications/calendar` HTTP 200

## Console errors checked

- Orca 동적 검토에서 확인한 콘솔 error: 0건

## 정적·빌드 검증

- contracts/core/web typecheck: 통과
- landing, match, first mission, grant overview, dashboard, applications, calendar, workspace, chat, login, safe redirect, settings 집중 테스트: 통과
- production build: 사용자 dev 서버의 `.next`를 건드리지 않는 격리 사본에서 통과
- OpenAPI: 28 paths
- route policy: 132 API / 10 cron / 6 protected pages
- service use cases, active grant filter, application calendar subscription: 통과
- raw control drift: 정확히 37건 유지
- 이번 diff의 신규 hex 하드코딩: 0건
- 금지 확률·합격 약속 문구: 0건
- `git diff --check`: 통과
- `verify:web-http`: 기본 실행은 환경변수 미설정으로 명시적 skip. 계정·회사 생성 POST를 포함하므로 라이브 4010에는 별도 실행하지 않았다.

## Comparison history

1. 첫 비교: 개발 서버 미실행으로 동적 검토 차단.
2. 서버 재시작 후 비교: 신청 추천 홍수, 셸 불일치, 채팅 장기 pending, s8 데이터 게이트를 발견.
3. 수정 후 비교: 신청 4건, 일관된 데모 계정 헤더, 실제 채팅 응답과 입력 해제를 확인. 코드 P0/P1은 남지 않았다.
4. s8 재검토: 두 실제 공고 모두 surface/page/field 0건임을 확인해 데이터 게이트로 분리했다.

## 2026-07-15 HWPX 워크스페이스 재검증

- source visual truth path: `/var/folders/90/3_v527vj59d6wv2ql7_k6rzm0000gn/T/orca-paste-1784062940395-717f5b5e-f8fe-4390-b379-d291774b6886.png`
- implementation route: `http://127.0.0.1:4010/grants/kstartup%3A178390/workspace`
- implementation screenshot path: unavailable — 이 세션에는 Codex in-app Browser 제어 도구가 노출되지 않았다.
- viewport: source 2048 × 1170; 동일 viewport 구현 캡처 불가
- state: 기창업자용 HWPX 원본 양식 프리뷰가 선택된 지원서 작성 워크스페이스

### Full-view comparison evidence

- 시각 비교는 브라우저 구현 캡처가 없어 수행하지 않았다.
- HTTP 렌더 결과에서는 기존 `작성형 서류가 없습니다`/`원본 양식 채움을 지원하지 않습니다` 상태가 사라졌고, 두 HWPX 신청서가 `hwpxTemplateAvailable: true`인 작성 문서로 노출되며 `page-image` 프리뷰 마커가 존재한다.
- 이 기능 증거는 시각 일치 판정을 대체하지 않는다.

### Focused region comparison evidence

- 문서 프리뷰, 상단 진행률, 우측 확인 카드의 동일 viewport 캡처가 없어 집중 비교를 수행하지 않았다.
- primary interactions tested: HTTP route load only; 브라우저의 문서 전환·페이지 이동·필드 확인 상호작용은 확인하지 못했다.
- console errors checked: unavailable.

### Findings

- [P1] 목표 이미지와 구현의 시각적 동일성 미검증
  - Location: 지원서 작성 워크스페이스 전체
  - Evidence: 원본 이미지는 열 수 있지만 동일 상태의 구현 스크린샷을 캡처할 필수 in-app Browser 도구가 없다.
  - Impact: HWPX 렌더링 데이터 경로는 확인됐지만 60/40 비율, 타이포그래피, 간격, 색상, 페이지 크롭, 우측 인터뷰 카드가 목표와 같은지는 확정할 수 없다.
  - Fix: Codex in-app Browser가 가능한 세션에서 2048 × 1170로 해당 route를 열고 기창업자용 양식을 선택한 뒤 원본과 결합 비교한다.

### Required fidelity surfaces

- Fonts and typography: blocked — 구현 캡처 없음.
- Spacing and layout rhythm: blocked — 구현 캡처 없음.
- Colors and visual tokens: blocked — 구현 캡처 없음.
- Image quality and asset fidelity: blocked — HWPX page image의 선명도·크롭을 시각 확인하지 못함.
- Copy and content: HTTP 응답에서 신청서 두 종류와 프리뷰 상태만 확인; 배치·줄바꿈은 blocked.

### Comparison history

1. 기존 비교에서는 실제 ladder a/b 데이터가 없어 지원서 프리뷰 시각 검증이 차단됐다.
2. 첨부 archive·surface 변환·작성 문서 연결을 복구해 실제 `178390` 응답에서 두 HWPX 양식과 page-image를 확인했다.
3. 필수 in-app Browser 도구 부재로 동일 viewport 구현 캡처와 원본 결합 비교는 수행하지 못했다.

### Implementation checklist

- 동일 viewport 구현 스크린샷 캡처
- 원본과 구현을 한 비교 입력에 결합
- 문서 전환·페이지 이동·필드 확인과 콘솔 오류 점검
- 발견된 P0/P1/P2 수정 후 재캡처

final result: blocked
