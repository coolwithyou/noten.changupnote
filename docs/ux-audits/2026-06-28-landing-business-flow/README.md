# 첫 랜딩 사업자번호 입력 플로우 UX 감사

감사일: 2026-06-28
대상: `http://127.0.0.1:4010/` 첫 랜딩에서 사업자번호를 입력한 뒤 티저 결과와 기회 맵으로 이어지는 흐름

## 감사 범위

- 사용자가 첫 랜딩에서 사업자번호 10자리를 입력한다.
- `/api/web/teaser`가 1차 매칭 티저를 만든다.
- 사용자가 `기회 맵 보기`를 눌러 회사 프로필 저장과 대시보드 이동을 시도한다.
- 현재 코드에 있는 행동 추적 지점과 빠진 추적 지점을 확인한다.

## 증거

- 현재 dev 서버: `127.0.0.1:4010`, 기존 `node` 프로세스가 실행 중이었다.
- 환경 상태 요약: DB URL, Popbill, K-Startup 키가 존재했다. `CUNOTE_AUTH_MODE`, `CUNOTE_AUTH_REQUIRED`, `CUNOTE_WEB_DATA_SOURCE`는 명시되지 않았다.
- HTTP 검증:
  - 잘못된 사업자번호 `123`: `POST /api/web/teaser` -> `400`, `invalid_biz_no`, 0.008초.
  - 10자리 입력 `1234567890`: `POST /api/web/teaser` -> `200`, 0.320초, `eligible=2`, `conditional=3`, `ineligible=8`, `deadlineSoon=0`.
  - 같은 입력으로 `POST /api/web/companies` -> `201`, 0.381초, 로컬에서는 인증 강제 없이 mock user 회사가 생성됐다.
- 코드 근거:
  - 입력/티저/저장 흐름: `apps/web/src/features/home/HomeExperience.tsx:172`, `apps/web/src/features/home/HomeExperience.tsx:237`
  - 랜딩 입력 UI: `apps/web/src/features/home/HomeExperience.tsx:289`
  - 티저 상세 카드 위치: `apps/web/src/features/home/HomeExperience.tsx:343`, 뉴스레터가 그보다 먼저 렌더링됨: `apps/web/src/features/home/HomeExperience.tsx:332`
  - 현재 match event 클라이언트: `apps/web/src/lib/client/matchEvents.ts:3`
  - 현재 지원 event enum: `apps/web/src/lib/server/matches/matchEvents.ts:4`
  - 대시보드 카드 클릭 이벤트 기록: `apps/web/src/features/opportunity-map/OpportunityMap.tsx:298`

## 캡처 제한

인앱 브라우저와 Chrome 확장 브라우저 목록이 모두 비어 있어 스크린샷을 캡처하지 못했다. Product Design audit 지침상 Playwright fallback은 사용자 확인이 필요하므로, 이 문서는 코드와 HTTP 실행 증거 기반의 1차 감사다. 스크린샷 캡처가 승인되면 같은 폴더의 `screenshots/`에 단계별 이미지를 추가한다.

## 단계별 평가

| 단계 | 사용자 행동 | 현재 상태 | 건강도 |
| --- | --- | --- | --- |
| 1 | 랜딩 진입 후 사업자번호 입력 영역을 찾음 | 히어로 안에 바로 입력 폼이 있고 가치 제안은 명확함. 오른쪽 예시 carousel은 시선을 끌지만 입력 집중을 분산시킬 수 있음. | 양호 |
| 2 | 사업자번호 입력 | 숫자 이외 문자를 제거하고 10자리로 제한함. 잘못된 입력은 submit 후 오류가 뜸. | 양호, 즉시 피드백 부족 |
| 3 | `내 기회 확인` 클릭 | 로딩 버튼과 API 오류 처리가 있음. 10자리 입력은 0.32초 내 티저 생성. | 양호 |
| 4 | 티저 결과 확인 | 상세 티저는 뉴스레터 뒤에 렌더링되어 사용자가 결과가 생긴 줄 모를 수 있음. 위의 `OpportunityPreview` 숫자는 바뀌지만 충분히 결과처럼 보이지 않을 수 있음. | 위험 |
| 5 | 매칭 카드 탐색 | 티저 카드에는 `detailUrl`이 있음에도 랜딩 티저의 `MatchPreview`는 링크가 아니고 직접 행동이 없다. 사용자는 `기회 맵 보기` 하나로만 다음 단계에 간다. | 위험 |
| 6 | `기회 맵 보기` 클릭 | 로컬에서는 회사 저장 후 대시보드 이동 가능. 인증 강제 환경에서는 sessionStorage에 요청을 보관하고 로그인으로 보냄. | 기능은 있음, 기대치 설명 부족 |
| 7 | 대시보드 이후 카드 클릭/신청 | 대시보드 카드 클릭과 신청 클릭은 `match_events`로 기록 가능. 하지만 랜딩 입력, 티저 노출, CTA 클릭, 저장 성공/실패는 추적되지 않음. | 추적 부족 |

## UX 리스크

1. 결과가 사용자 눈앞에 오지 않는다. `teaser-section`이 뉴스레터 뒤에 있어서 submit 직후 사용자는 폼 주변에 머물며 결과를 못 보고 이탈할 수 있다.
2. 티저 카드가 행동으로 이어지지 않는다. 카드에 지원사업 제목과 점수는 보이지만 클릭, 자세히 보기, 저장, 조건 확인 같은 액션이 없다.
3. 첫 입력 이후의 핵심 funnel이 측정되지 않는다. 지금 저장되는 event는 grant별 `surfaced/clicked/saved/apply_click`인데, 실제 첫 funnel에는 `input_started`, `teaser_submitted`, `teaser_success`, `dashboard_cta_clicked`, `company_create_success`, `auth_required`가 필요하다.
4. 결과 신뢰도가 약해질 수 있다. 실행 결과에서 일부 `eligible` 항목은 `fitScore=100`인데 `ruleTrace=[]`, `matchConfidence=0`이었다. 사용자는 왜 적격인지 설명을 받지 못한다.
5. 금액 가치 제안이 빈 값에 약하다. 실행 결과의 `estimatedMaxAmount`와 `conditionalUpside`가 0이면 `금액 미확인`류 문구가 반복되어 첫 랜딩의 "받을 수 있는 기회" 약속이 약해진다.
6. 인증 전환이 숨어 있다. 인증 강제 환경에서는 `기회 맵 보기`가 로그인으로 이동하지만 버튼 문구는 저장/로그인 필요성을 설명하지 않는다.

## 접근성 리스크

- 오류 Alert가 입력 필드와 `aria-describedby`로 연결되어 있지 않다. 스크린 리더 사용자는 어떤 필드 오류인지 맥락을 놓칠 수 있다.
- 티저 결과가 새로 생겨도 포커스 이동이나 결과 영역 안내가 없다. `aria-live="polite"`는 있으나 새로 삽입되는 영역이 폼과 멀리 떨어져 있으면 발견성이 낮다.
- carousel은 `prefers-reduced-motion`을 확인하고 hover/focus pause가 있으나, 명시적인 일시정지 컨트롤은 없다.
- 뉴스레터가 핵심 결과보다 먼저 나오면 키보드/스크린 리더 사용자에게도 주요 task 순서가 흐려진다.

## 추천 추적 이벤트

현재 `match_events`는 company/grant 이후 행동에 맞다. 랜딩 전환은 raw 사업자번호를 저장하지 않는 별도 funnel event가 더 안전하다.

| 이벤트 | 시점 | 속성 |
| --- | --- | --- |
| `landing_viewed` | 랜딩 첫 렌더 | `stats_open_count`, `data_source`, `auth_required` |
| `biz_no_input_started` | 입력 필드 최초 변경 | raw bizNo 저장 금지, `input_length_bucket` |
| `biz_no_validation_failed` | 10자리 실패 | `length`, `reason` |
| `teaser_submitted` | `/api/web/teaser` 요청 직전 | `request_id` |
| `teaser_succeeded` | 티저 성공 | `duration_ms`, `eligible_count`, `conditional_count`, `ineligible_count`, `deadline_soon_count`, `has_amount`, `avg_confidence_bucket` |
| `teaser_failed` | 티저 실패 | `duration_ms`, `error_code` |
| `teaser_result_seen` | 결과 영역이 viewport에 들어옴 | `eligible_count`, `conditional_count` |
| `teaser_match_clicked` | 랜딩 티저 카드 클릭 | `grant_id`, `eligibility`, `ruleset_ver` |
| `dashboard_cta_clicked` | `기회 맵 보기` 클릭 | `from_teaser=true`, `auth_required` |
| `company_create_succeeded` | 회사 생성 성공 | `duration_ms`, `verified`, `profile_confidence_bucket` |
| `auth_resume_started` | 로그인 필요로 resume 시작 | `pending_request=true` |
| `dashboard_loaded_after_teaser` | resume 또는 생성 후 대시보드 도착 | `company_id`, `match_total` |

## 개선안

### P0

1. `teaser-section`을 `OpportunityPreview` 바로 아래, 뉴스레터보다 위로 옮기고 submit 성공 시 결과 영역으로 scroll 또는 focus 이동을 한다.
2. 랜딩 funnel event 저장 계층을 추가한다. raw 사업자번호는 저장하지 않고 request id, duration, count, confidence bucket만 남긴다.
3. 랜딩 티저 카드에 `detailUrl` 링크 또는 `조건 확인`, `자세히 보기`, `기회 맵에서 보기` 액션을 붙인다.
4. `eligible`인데 설명이 없는 카드에는 "자동 확인된 조건"과 "원문 확인 필요"를 분리해 보여준다. `matchConfidence=0`인 적격은 "적격" 단독 표시를 피한다.
5. 인증 강제 환경 문구를 분리한다. 예: `기회 맵 저장하고 계속 보기`, 로그인 필요 시 `로그인 후 방금 조회한 결과를 이어서 보여드려요.`

### P1

1. 입력 필드 아래에 실시간 길이 상태를 제공한다. 예: `7/10자리`.
2. 오류 Alert를 입력 필드와 연결한다. `aria-describedby`와 `aria-invalid`를 추가한다.
3. 티저 성공 후 `teaser_result_seen`을 IntersectionObserver로 기록한다.
4. 금액 정보가 없는 결과에서는 "지원금 총액" 대신 "금액 확인 전 공고"와 "금액 확인된 공고"를 분리한다.
5. carousel에 명시적 pause 버튼을 추가하거나 첫 입력 focus 시 자동 진행을 멈춘다.

## 다음 검증

1. Playwright fallback 승인을 받은 뒤 desktop/mobile 스크린샷을 저장한다.
2. 스크린샷 기준으로 결과 위치, 모바일 버튼 줄바꿈, carousel 대비, 키보드 포커스 순서를 재검증한다.
3. funnel event 구현 후 `teaser_submitted -> teaser_succeeded -> teaser_result_seen -> dashboard_cta_clicked -> dashboard_loaded_after_teaser` 전환율을 첫 번째 운영 지표로 삼는다.
