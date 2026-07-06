# 창업노트 SaaS 제품 이해 및 UX QA

감사일: 2026-07-01
대상: `/`, `/login`, `/dashboard`, `/account`, `/settings`, `/team`, `/billing`, `/grants/[grantId]`, `/applications`

## 제품 이해

창업노트는 실사업자 또는 예비창업자 프로필을 기준으로 정부지원사업을 표준화하고, 사용자에게 지금 가능한 기회와 준비하면 열릴 기회를 나눠 보여주는 SaaS다. 핵심 가치는 단순 공고 목록이 아니라 다음 4가지 흐름에 있다.

1. 사업자번호/회사 프로필로 지원사업 조건을 자동 판정한다.
2. `eligible`, `conditional`, `ineligible`, `now`, `preparable`, `soon` 상태를 분리해 사용자가 지금 할 일을 이해하게 한다.
3. 공고 상세에서는 조건 확인, 필요 서류, 복붙 프로필, AI 초안, 패키지 export로 신청 준비를 돕는다.
4. 계정, 회사 설정, 팀, 청구, 고객지원, 데이터 export/삭제 요청까지 SaaS 운영 루프를 한 제품 안에서 닫는다.

궁극적으로 사용자가 얻는 가치는 "내 회사가 받을 수 있는 지원사업을 놓치지 않고, 어떤 조건을 보강해야 하는지 알고, 신청 준비물을 빠르게 만드는 것"이다. 운영 관점에서는 사용자의 프로필 보강, 피드백, 신청 상태, 고객지원 기록이 매칭 품질 개선 플라이휠로 돌아간다.

## 과금성 외부 조회 사용량

- 팝빌 같은 과금성 기업정보 조회는 이번 QA에서 실행하지 않았다.
- 이번 라운드는 기존 설계/코드/로컬 서버 응답과 verifier만 사용했다.
- 사업자번호 보강 UX는 `/api/web/companies/enrich` 경로와 `CompanySettingsPanel` 동작을 코드 기준으로 검토했다.
- QA 중 내부 MVP용 `/api/matches/live`가 Popbill 직접 조회를 실행할 수 있는 별도 경로임을 발견했다. 이 경로는 관리자 전용으로 잠그고, 비관리자 HTTP verifier가 403을 확인하도록 보강했다.

## 캡처와 실행 한계

- `127.0.0.1:4010`에 로컬 서버가 실행 중이었다.
- Desktop Codex 후속 세션에서 인앱 브라우저와 Chrome extension 브라우저 연결은 가능했다.
- 사용자 확인 후 회복된 `https://dev.changupnote.com` 기준으로 desktop/mobile 캡처를 Playwright fallback으로 재수행했다.
- desktop 캡처 파일 9개를 `screenshots/`에 저장했다.
  - `01-home-desktop.png`
  - `02-login-desktop.png`
  - `03-dashboard-desktop.png`
  - `04-account-desktop.png`
  - `05-settings-desktop.png`
  - `06-team-desktop.png`
  - `07-billing-desktop.png`
  - `08-applications-desktop.png`
  - `09-grant-detail-desktop.png`
- mobile 캡처 파일 9개를 `screenshots/`에 저장했다.
  - `01-home-mobile.png`
  - `02-login-mobile.png`
  - `03-dashboard-mobile.png`
  - `04-account-mobile.png`
  - `05-settings-mobile.png`
  - `06-team-mobile.png`
  - `07-billing-mobile.png`
  - `08-applications-mobile.png`
  - `09-grant-detail-mobile.png`
- 검수용 contact sheet는 `screenshots/desktop-contact-sheet.png`, `screenshots/mobile-contact-sheet.png`에 저장했다.
- contact sheet 시각 검수에서 desktop/mobile 18개 캡처 모두 실제 화면으로 accept했다.
- `/dashboard`, `/settings`는 1.5초 시점에 회사정보 영역의 `불러오는 중`이 보였지만, 5초 안정 상태에서 사라지는 것을 확인하고 안정 상태 캡처로 교체했다.
- 모든 mobile 캡처에서 `documentElement.scrollWidth > clientWidth` 기준의 가로 overflow는 없었다.
- 현재 dev 서버의 주요 HTML 응답은 `/` 약 5.03초, `/login` 약 0.04초, `/dashboard` 약 5.06초, `/account` 약 5.15초, `/settings` 약 0.05초, `/team` 약 4.90초, `/billing` 약 8.29초, `/applications` 약 4.92초, `/grants/[grantId]` 약 0.34초로 확인했다.
- 초기 `CUNOTE_HTTP_VERIFY_BASE_URL=http://127.0.0.1:4010 pnpm verify:web-http`는 현재 dev 서버에서 장시간 출력 없이 진행됐으나, DB pool 조정 후 재실행에서는 `ok: true`로 통과했다. 신규 랜딩 이벤트 API도 별도 `curl`로 정상/오류 경계를 확인했다.
- 추가 진단에서 단일 요청 기준 `/dashboard` HTML은 약 14.5초, `/api/web/billing/statement`와 `/api/web/billing/payment-instructions`는 약 13.8초, `/api/web/settings/report`는 약 27.0초가 걸렸다. 앱 DB 클라이언트의 connection pool 기본값이 1이라 한 화면/문서의 병렬 읽기 조회가 큐잉되는 구조였고, `CUNOTE_DB_MAX_CONNECTIONS`로 1-8 범위에서 조정 가능하게 바꿨다. 변경 후 같은 dev 서버에서 `/dashboard` HTML 약 3.45초, `/api/web/billing/statement` 약 2.93초, `/api/web/billing/payment-instructions` 약 9.38초, `/api/web/settings/report` 약 7.10초로 개선됐다.

## SaaS 필수 UX QA

| 영역 | 기대 경험 | 현재 평가 | 조치 |
| --- | --- | --- | --- |
| 인증 | 이메일/소셜 로그인, 비밀번호 재설정, 회원가입 동의가 명확해야 한다. | `/login`, `/forgot-password`, `/reset-password`, auth API가 존재한다. 로그인 화면은 소셜+이메일 진입이 명확하지만, mock이 아닌 환경에서도 NextAuth provider API에 demo provider가 노출될 수 있었다. | mock 환경에서만 demo provider를 등록하도록 정리 |
| 마이페이지 | 표시 이름, 비밀번호, 보안 상태, 알림, 고객지원 기록, 데이터 export가 한 화면에서 이어져야 한다. | `/account`가 기능을 모으고 있으나 일부 오류가 필드와 직접 연결되지 않았다. | 프로필/비밀번호 오류를 필드 `aria-invalid`, `aria-describedby`, `FieldError`로 연결 |
| 탈퇴/삭제 요청 | 삭제 위험성과 절차, 확인 문구, 접수 상태가 분명해야 한다. | 즉시 삭제가 아니라 개인정보 요청 티켓으로 접수하는 정책은 타당하다. 확인 문구 안내와 오류 연결은 약했다. | 확인 문구 설명과 클라이언트 선검증, 서버 오류 문구, 필드 오류 연결 개선 |
| 데이터 이동권 | 사용자 데이터 export가 직접 가능해야 한다. | `/api/web/account/export`가 계정/워크스페이스/동의/청구/지원/법무 정보를 JSON으로 내려준다. | 추가 수정 없음 |
| 회사 설정 | 동의, 사업자 검증, 수기 프로필, 알림 설정을 조정할 수 있어야 한다. | 기능은 모여 있으나 토글의 명시적 접근성 이름, 상태 변경 안내, 과금성 조회의 캐시 우선 설명이 약했다. | 동의/알림 스위치 `aria-label`, 상태 라이브 영역, 사업자번호 10자리 숫자 정규화, 캐시 우선 조회 설명 개선 |
| 팀/권한 | 초대, 재발행, 철회, 역할 변경, 좌석 제한이 설명되어야 한다. | `/team`에서 좌석 한도, 초대 링크, 메일 handoff, 권한 제한 안내가 구현되어 있다. | 추가 수정 없음 |
| 청구 | 플랜, 사용량, 결제수단, 세금계산서, 증빙, 상담 흐름이 있어야 한다. | `/billing`에 구독 상태, 청구 프로필, 증빙, payment provider 경계가 있다. | 추가 수정 없음 |

## 핵심 비즈니스 플로우 QA

| 플로우 | 현재 평가 | 리스크 |
| --- | --- | --- |
| 랜딩 사업자번호 티저 | 기존 `docs/ux-audits/2026-06-28-landing-business-flow/README.md`에서 티저 위치, 카드 행동, funnel event 부족을 이미 식별했다. 이번 라운드에서 성공 후 결과 영역 스크롤/포커스, 티저 카드 상세 링크, 비식별 funnel event 수신 경로를 추가했다. | 실제 브라우저에서 모션, 포커스 순서, 모바일 위치는 스크린샷 QA가 필요하다. |
| 대시보드 기회 맵 | `DashboardView`가 설정 완료도, 회사 설정, 액션 큐, 알림, 기회 맵, 로드맵을 한 화면에 배치한다. `OpportunityMap`은 필터/정렬/더보기/API 오류 상태를 갖고 있다. 낮은 근거의 적격 카드는 `추정 적격`으로 완화해 표시한다. | 첫 사용자에게 화면 밀도가 높다. 브라우저 캡처로 모바일 정보 과밀을 확인해야 한다. |
| 공고 상세 신청 준비 | `ApplySheetView`는 조건, 서류, 첨부 묶음, 패키지 export, 복붙 프로필, AI 초안 경계를 보여준다. 자동 제출이 아니라 신청 준비 보조라는 설명이 있다. 초안 생성/저장/검토완료/섹션 재생성/다운로드 후 완료 상태 메시지를 남긴다. | 실제 브라우저에서 다운로드 시작과 상태 메시지 위치가 충분히 보이는지 확인해야 한다. |
| 신청 파이프라인 | `/applications`와 application calendar/report/reminder handoff API가 있다. 상태 이동과 후속 관리 저장 후 완료 메시지를 남긴다. | 실제 사용자가 "저장→준비→제출→결과"를 한 번에 이해하는지는 플로우 캡처가 필요하다. |
| 회사정보 보강 | 기본정보 동의 gate 후 `/api/web/companies/enrich`를 호출한다. 서버는 `company_enrichment_cache`를 먼저 확인하고 fresh hit이면 Popbill 조회 없이 `popbill_cache` evidence를 반환한다. 랜딩/설정 카피도 저장 결과를 먼저 확인한다고 안내한다. | 실제 운영 계정에서 같은 사업자번호 2회차가 `cacheStatus=hit`로 떨어지는지 브라우저/DB 로그 결합 검증이 필요하다. 이번 QA에서는 조회 0회. |
| 내부 실시간 매칭 | `/internal/live-match`는 Popbill, K-Startup, 기업마당, LLM 추출을 한 번에 실행하는 내부 검증 도구다. | 과금성 외부 조회가 포함되므로 공개/일반 세션에서 접근되면 비용과 데이터 오남용 위험이 크다. 관리자 권한 없이는 페이지가 403 안내만 렌더하고 `/api/matches/live`도 `admin_forbidden`으로 차단되게 정리했다. |

## 요구사항별 완료 증거

| 요구사항 | 현재 증거 | 판정 |
| --- | --- | --- |
| 제품 이해와 사용자 가치 정리 | 이 문서의 `제품 이해` 섹션에 지원사업 자동 판정, 준비 가능 기회 분리, 신청 준비물 생성, SaaS 운영 루프까지 정리했다. | 충족 |
| SaaS 기본 UX QA 목록화 | 인증, 마이페이지, 탈퇴/삭제 요청, 데이터 이동권, 회사 설정, 팀/권한, 청구 영역을 표로 분리했다. | 충족 |
| 핵심 비즈니스 플로우 QA 목록화 | 랜딩 티저, 대시보드 기회 맵, 공고 상세 신청 준비, 신청 파이프라인, 회사정보 보강, 내부 실시간 매칭을 표로 분리했다. | 충족 |
| 자체 QA 후 개선 | 필드 오류 연결, status live region, 낮은 근거 매칭 표시, funnel event, 신청/초안 완료 피드백, DB pool, 내부 live-match 관리자 경계를 코드에 반영했다. | 충족 |
| Popbill 과금 조회 제한 | 이번 QA에서 직접 Popbill 유료 조회는 실행하지 않았다. 일반 web/app 회사 보강은 동의와 write 권한 후 공통 캐시 우선 함수로 진입한다. 내부 live-match는 관리자 전용으로 차단했다. | 충족 |
| 캐시 동작 검증 | `pnpm verify:runtime-repositories`가 `runtime_enrichment_cache_fresh`, `runtime_enrichment_cache_expired`, `runtime_enrichment_cache_permanent`를 확인했다. | 충족 |
| 실제 브라우저 화면 QA | `https://dev.changupnote.com` 기준 desktop/mobile 18개 캡처와 contact sheet를 저장했다. | 충족 |
| desktop/mobile 시각 QA | contact sheet에서 18개 캡처 모두 실제 화면으로 accept했다. mobile 가로 overflow는 없었고, 일부 화면의 과밀/초장문 리스크는 아래 개선 리스트로 분리했다. | 충족 |

## 캡처 기반 확정 개선 리스트

| 우선순위 | 화면 | 증거 | 개선 필요 |
| --- | --- | --- | --- |
| P1 | 앱 공통 내비게이션 | `03-dashboard-mobile.png`, `04-account-mobile.png`, `06-team-mobile.png`, `07-billing-mobile.png`, `08-applications-mobile.png`, `09-grant-detail-mobile.png` | 로그인된 샘플 세션 화면에서도 상단 내비게이션에 `로그인`이 계속 노출된다. 사용자 상태와 CTA가 충돌하므로 계정 메뉴 또는 로그아웃/계정 상태로 바꿔야 한다. |
| P1 | 모바일 신청 파이프라인 | `08-applications-mobile.png` | Kanban 단계가 모바일에서 세로로 길고 상태 비교가 어렵다. 모바일은 단계 탭/세그먼트와 현재 단계 카드 중심으로 전환하는 편이 낫다. |
| P1 | 모바일 대시보드 | `03-dashboard-mobile.png` | 설정 완료도, 회사 설정, 알림, 액션 큐, 기회 맵이 한 화면 흐름에 모두 쌓여 첫 행동이 묻힌다. 모바일 첫 화면은 `이번 주 먼저 할 일`과 `지금 적격`으로 압축하고 보조 설정은 접기/하단 이동이 필요하다. |
| P2 | 계정 | `04-account-desktop.png`, `04-account-mobile.png` | 계정, 보안, 법무 동의, 고객지원, 삭제 요청 이력이 한 페이지에 길게 이어진다. 모바일에서는 보안/법무/지원/삭제 요청을 접이식 섹션이나 탭으로 나눠야 한다. |
| P2 | 팀 | `06-team-desktop.png`, `06-team-mobile.png` | 멤버 관리보다 긴 권한/감사 정보가 화면을 압도한다. 초대/멤버 작업을 상단에 고정하고 감사 로그와 API 권한은 접힌 보조 섹션으로 내려야 한다. |
| P2 | 청구 | `07-billing-desktop.png`, `07-billing-mobile.png` | Early Access 안내, 청구 프로필, 결제 안내, 세금계산서/증빙이 긴 단일 문서처럼 이어진다. 결제 연동 전 상태에서는 핵심 상태와 다음 행동을 먼저 보이고 세부 증빙 정보는 접기 처리하는 것이 좋다. |
| P2 | 설정 | `05-settings-desktop.png`, `05-settings-mobile.png` | `회사정보 보강`의 캐시 우선 카피는 보이지만, 보강/검증 버튼이 과금성 조회인지 캐시 확인인지 버튼 레벨에서 즉시 구분되지는 않는다. 버튼 옆에 `저장 결과 먼저 확인` 같은 짧은 보조 라벨이 필요하다. |
| P3 | 로그인 | `02-login-desktop.png`, `02-login-mobile.png` | demo provider는 보이지 않아 개선 완료 상태다. 남은 개선은 소셜 로그인 실패/이메일 오류 상태의 브라우저 검수다. |
| P3 | 랜딩 | `01-home-desktop.png`, `01-home-mobile.png` | desktop/mobile 모두 첫 CTA와 사업자번호 입력은 명확하다. 남은 개선은 실제 티저 제출 후 결과 영역 스크롤/포커스 이동을 브라우저 상호작용으로 검수하는 것이다. |
| P3 | 공고 상세 | `09-grant-detail-desktop.png`, `09-grant-detail-mobile.png` | 신청 준비/AI 초안 경계는 명확하다. 남은 개선은 다운로드 시작, 초안 저장, 섹션 재생성 후 status 메시지가 실제 조작 직후 보이는지 확인하는 것이다. |

## 이번 개선 내역

- `fallbackHeaderUserForDemoAccess`: demo access로 렌더되는 SaaS 화면에서도 헤더가 `로그인` CTA 대신 계정 메뉴를 표시하도록 보강했다.
- `/dashboard`, `/account`, `/settings`, `/team`, `/billing`, `/applications`, `/grants/[grantId]`: demo access fallback user를 공통 헤더에 전달하도록 정리했다.
- `DashboardView`: 모바일 첫 흐름에서 액션 큐와 기회 맵이 회사 설정 패널보다 먼저 나오도록 배치했다.
- `ApplicationPipelineView`: 모바일에서 단계 탭/세그먼트를 추가하고 현재 단계 lane만 표시하도록 전환했다. 데스크톱은 기존 8-column Kanban을 유지한다.
- `CompanySettingsPanel`: 회사정보 보강 버튼을 `캐시 확인 후 보강`, 검증 버튼을 `소유권 검증`으로 바꿔 캐시 우선 보강과 검증 동작을 버튼 레벨에서 구분했다.
- `AccountPageView`: 고객지원 기록, 비밀번호 변경, 삭제 요청, 서비스 문서 링크를 `보조 관리` disclosure로 묶어 프로필/보안/알림 우선 흐름을 만들었다.
- `TeamManagementPanel` / `TeamPageView`: 팀 초대/멤버 작업은 상단에 유지하고 초대 이력, 권한 변경 감사 로그, 워크스페이스 목록을 disclosure로 접었다.
- `BillingPageView`: 현재 플랜, 청구 상태, 사용량, 유료 전환 체크, 상담 요청은 먼저 보이고 세금계산서/증빙, 결제수단/청구 이력, 상담 기록은 disclosure로 접었다.
- `AccountProfilePanel`: 프로필 저장 오류를 이름 입력 필드에 직접 연결했다.
- `AccountPasswordPanel`: 현재 비밀번호, 새 비밀번호, 확인 입력의 오류 위치를 분리했다.
- `AccountDeletionRequestPanel`: 확인 문구 안내와 클라이언트 선검증을 추가하고, 이메일/확인 문구 오류를 필드에 연결했다.
- `/api/web/account/deletion-request`: 확인 문구 서버 오류 메시지를 사용자가 바로 고칠 수 있게 구체화했다.
- `authOptions`: mock 환경이 아닐 때 NextAuth provider 목록에서 동작하지 않는 demo provider가 노출되지 않게 정리했다.
- `CompanySettingsPanel`: 동의/알림 스위치에 명시적 접근성 이름을 붙이고, 설정 상태를 `role="status"` 라이브 영역으로 노출했다.
- `CompanySettingsPanel`: 사업자번호 보강/검증 입력을 숫자 10자리로 화면에서 정규화했다.
- `CompanySettingsPanel`: 회사정보 보강 영역을 `캐시 우선 확인`으로 설명하고, 저장된 팝빌 결과가 있으면 추가 조회 없이 재사용한다고 안내했다.
- `StatusBadge`: 재사용 배지가 `role`, `aria-live` 같은 기본 HTML 속성을 받을 수 있게 했다.
- `HomeExperience`: 티저 성공 후 결과 섹션으로 스크롤하고 제목에 포커스를 이동하도록 개선했다.
- `HomeExperience`: 사업자번호 입력 오류를 입력 필드에 연결했다.
- `HomeExperience`: 랜딩 사업자번호 확인 버튼과 진행 문구를 캐시 우선 조회 흐름에 맞게 바꿔 반복 과금 불안을 줄였다.
- `HomeExperience`: 랜딩 티저 카드에 `detailUrl` 링크와 `조건과 신청 준비 보기` 액션을 붙이고, 클릭 시 grant 단위 match event와 landing funnel event를 함께 보낸다.
- `HomeExperience` + `/api/web/landing-events`: raw 사업자번호 없이 `biz_no_input_started`, `teaser_submitted`, `teaser_succeeded`, `teaser_failed`, `teaser_match_clicked`, `dashboard_cta_clicked`, `company_create_succeeded`, `auth_resume_started` 같은 funnel event를 받는 비차단 경로를 추가했다.
- `HomeExperience` / `OpportunityMap`: `eligible`이지만 `matchConfidence`가 낮거나 `ruleTrace`가 비어 있는 카드는 `추정 적격`과 원문 확인 문구로 표시해 거짓 확신을 줄였다.
- `DocumentDraftWorkspace`: 초안 생성, 저장, 검토 완료, 섹션 재생성, 다운로드 시작 후 사용자가 완료 여부를 확인할 수 있는 `role="status"` 메시지를 추가했다.
- `ApplicationPipelineView`: 상태 이동과 후속 관리 저장 후 완료 메시지를 추가했다.
- `db/client`: SaaS 화면과 리포트 다운로드가 여러 읽기 조회를 병렬 실행할 때 한 커넥션에 과도하게 큐잉되지 않도록 앱 런타임 DB pool 기본값을 4로 조정하고 `CUNOTE_DB_MAX_CONNECTIONS` 환경변수로 제어 가능하게 했다.
- `/internal/live-match` + `/api/matches/live`: Popbill 직접 조회가 가능한 내부 MVP 도구를 관리자 전용으로 제한하고, 일반 세션/비로그인 상태에서는 403 경계로 멈추게 했다.

## 검증

- `pnpm --filter @cunote/web typecheck` 통과
- `git diff --check` 통과
- 쿠키 없는 `127.0.0.1:4010` HTML 응답 기준 `/dashboard`, `/account`, `/settings`, `/team`, `/billing`, `/applications`, `/grants/[grantId]` 헤더에 `계정 메뉴 열기`가 렌더되고 `nav-login`은 미노출 확인
- 브라우저 390px viewport 기준 `/applications`: 단계 탭 8개 표시, active lane 1개만 visible 확인
- 브라우저 1280px viewport 기준 `/applications`: 단계 탭 hidden, desktop Kanban lane 8개 visible 확인
- 브라우저 390px viewport 기준 `/dashboard`: 액션 큐와 기회 맵이 회사 설정 패널보다 위에 배치됨을 bounding rect로 확인
- 브라우저 기준 `/settings`: `캐시 확인 후 보강`, `소유권 검증` 버튼 문구와 계정 메뉴 렌더 확인
- 브라우저 390px viewport 기준 `/account`: `보조 관리` disclosure 1개가 닫힌 상태로 표시되고 프로필/알림 우선 영역은 유지됨
- 브라우저 390px viewport 기준 `/team`: 감사 로그와 워크스페이스 목록 disclosure가 닫힌 상태로 표시되고 `팀원을 링크로 초대` 작업은 유지됨
- 브라우저 390px viewport 기준 `/billing`: 세금계산서, 결제 기록, 상담 기록 disclosure 3개가 닫힌 상태로 표시되고 `플랜 전환 요청` 작업은 유지됨
- 브라우저 기준 `/billing`: 첫 disclosure summary 클릭 후 `open=true`로 전환됨 확인
- `pnpm test` 통과
- `pnpm --filter @cunote/web typecheck` 통과
- `pnpm verify:route-policy` 통과
- `pnpm verify:admin-routes` 통과
- `pnpm verify:account-deletion-email-handoff` 통과
- `pnpm verify:account-security-report` 통과
- `pnpm verify:app-auth` 통과
- `/api/auth/providers` 현재 dev 서버 응답에서 mock 전용 demo provider 미노출 확인
- `pnpm verify:settings-report` 통과
- `pnpm verify:runtime-repositories` 통과
- `pnpm verify:company-enrichment` 통과
- `pnpm verify:saas-readiness` 통과
- `pnpm verify:dashboard-report` 통과
- `pnpm verify:landing-grants` 통과
- `pnpm verify:grant-document-drafts` 통과
- `pnpm verify:document-draft-html-export` 통과
- `pnpm verify:grant-document-draft-metrics` 통과
- `pnpm verify:application-calendar-subscription` 통과
- `pnpm verify:application-reminder-email-handoff` 통과
- `/api/web/landing-events` 정상 이벤트: `202 Accepted`
- `/api/web/landing-events` 비허용 이벤트: `400 invalid_landing_event`
- `/internal/live-match` 비관리자 HTML: 403 안내 렌더 확인
- `/api/matches/live` 비관리자 POST: `403 admin_forbidden`
- `CUNOTE_HTTP_VERIFY_BASE_URL=http://127.0.0.1:4010 pnpm verify:web-http` 통과

## 남은 QA 항목

1. 랜딩 티저 결과 영역의 실제 브라우저 스크롤/포커스와 모바일 위치를 확인한다. Popbill 과금 조회는 실행하지 않는다.
2. `/dashboard`, `/account`, `/settings`, `/team`, `/billing`, `/grants/[grantId]`, `/applications`에서 P1/P2 개선을 적용한 뒤 desktop/mobile 재캡처로 회귀 확인한다.
3. 사업자번호 보강은 운영 캐시가 있는 테스트 계정으로 1회만 조회하고, 같은 사업자번호 재조회가 캐시를 타는지 확인한다.
4. 신청 준비 초안의 생성, 저장, 재생성, 다운로드, 피드백 제출까지 단일 공고로 이어서 검수한다.
