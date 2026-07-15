# 공개 전체-공고 마감 캘린더 (`/calendar`) 실행 계획

> **🟢 구현 완료 (2026-07-15)** — 1~5단계 전부 커밋됨
> - ✅ 1단계 (5caef0e): 순수 자산 추출 — `lib/calendar/dates.ts` + `lib/server/calendar/ics.ts`, 개인 캘린더 리팩터(기능 변화 0)
> - ✅ 2단계 (69ecc32): 서버 데이터 계층 — core 지역 export, publicCalendar query/Core/Data(월 캐시)
> - ✅ 3단계 (23ab000): `/calendar` 페이지 + PublicCalendarView + 비로그인 GNB/푸터 링크
> - ✅ 4단계 (1ce8f2c): 공개 ICS 피드 + 연동 드롭다운(Google/Apple/Outlook/webcal/.ics)
> - ✅ 5단계: `verify:public-calendar` 체인, `CALENDAR_MIN_MONTH=2013-01`(DB 실측: 2012년은 2건뿐, 2013년부터 90건~). 게이트 전부 통과(typecheck·route-policy·드리프트 0·리그레션)
> - ✅ dev 수동 검증 완료(2026-07-15, 127.0.0.1:4010): 비로그인 렌더·GNB/푸터 링크·불량 month 폴백·과거 월(2015-03, 흐린 마감됨 스타일) 확인. 브라우저 실측: 필터 facet+count→URL(`?region=41`)→그리드 재계산·필터 초기화, 월 이동 필터 보존(`?month=2026-08&region=41`), 이벤트 팝오버(D-Day·기관/분야/지역·원문/내 조건 버튼), 연동 드롭다운 4종+캡션. ICS 피드: 헤더(public 캐시)·X-WR-CALNAME·300 상한·필터 적용(무필터 300, upcoming 26)·download=1 RFC 5987 확인. 이번 달 1,551건 — 필터 필수 판단 실증
> - **잔여(사용자 동반)**: 모바일 뷰포트 시각 확인(자동화 환경에서 창 리사이즈 미적용 — devtools 에뮬레이션으로), .ics Apple 캘린더 import, "원문 보기" 새 탭 실클릭. Google/Outlook 구독 확인은 프로덕션 배포 후.
> - **후속 과제**: grants 10만 건 도달 시 `grants_apply_start_idx` 추가 검토 · 기존 드리프트 부채 4파일(archive 뷰 등, 이번 범위 밖) · sitemap.ts(선택)

## 1. 배경과 목적

아카이브 규모(누적 ~2.9만 건, 활성 ~950건)가 실제 차별점인데, 공고 일정 데이터가 전부 로그인 게이트 뒤에 있어 랜딩에는 "로그인 없이 만져볼 수 있는 것"이 없다. 목업 3b/3c(마감 캘린더)의 UI를 **비로그인 공개 전체-공고 캘린더**로 재구성해 랜딩 GNB에서 진입시키고, "정보는 무료, 시간과 노동은 유료" 원칙에 따라 열람은 무료·행동(캘린더 연동, 맞춤 확인)은 전환 지점으로 삼는다.

조사 결과: 캘린더 그리드·날짜 유틸(KST)·ICS 렌더러·facet 엔진·라벨 사전이 이미 전부 구현돼 있으나 로그인 표면(개인 신청 캘린더 `/applications/calendar`, 아카이브 검색)에 잠겨 있다. 이 작업의 본질은 신규 개발이 아니라 **기존 자산의 공개 재노출 + 전환 설계**다.

## 2. 확정된 제품 결정

1. **공고 진입**: 팝오버 요약 + "원문 보기"(grants.url 외부 링크, 새 탭) + "내 조건으로 확인"(랜딩 히어로 `/` 퍼널). 공고 상세 `/grants/[id]`는 계속 비공개 — 건드리지 않음. (`/matches`는 세션 스토리지 없으면 빈 화면이라 퍼널 목적지로 부적합 — 검증됨)
2. **필터(표준)**: 지역(f_regions 시도코드→한글) · 분야(categoryL1) · 소스 · 상태(접수중/예정). URL searchParams 반영.
3. **캘린더 연동**: 현재 필터가 반영된 **공개 ICS 구독 피드** (Google/Apple/Outlook/webcal/.ics 드롭다운, 목업 3b). 공개 데이터라 토큰 불필요.
4. **GNB**: 비로그인 헤더 + 랜딩 푸터에만 "마감 캘린더" 링크. 로그인 GNB 무변경.

### 범위 제외 (명시)

공고 상세 공개 전환 · 로그인 GNB 변경 · 개인화(사업자번호 필터) · grant_criteria 22축 필터 · sitemap.ts(후속 선택) · DB 마이그레이션(29k 규모에서 `grants_apply_end_idx`로 충분. **후속 과제**: 10만 건 도달 시 `grants_apply_start_idx` 추가).

## 3. 모듈 구조

**원칙: 순수 로직(날짜·ICS)은 공용 모듈로 추출(서버에서 써야 하는데 `"use client"` 파일/module-private에 갇혀 있어 추출이 필수), 시각 컴포넌트(셀·팝오버)는 복제**(이벤트 kind·팝오버 내용·월 이동 방식이 달라 일반화 비용 > 중복 비용). 기존 `ApplicationCalendarView` 리팩터링은 유틸 이동만으로 최소화.

### 신규 파일 (~14개, 테스트 6 포함)

| 경로 | 역할 |
|---|---|
| `apps/web/src/lib/calendar/dates.ts` (+`.test.ts`) ✅ | 순수 날짜 유틸(KST): `calendarDays`·`dateKey`·`monthStart`·`calendarDday`·`koreaDateParts`·`indexEventsByDate`(제네릭화)·`formatMonth`·`formatFullDate`·`addMonths` + 신규 `monthKey`/`parseMonthKey`. 서버·클라 공용 |
| `apps/web/src/lib/server/calendar/ics.ts` (+`.test.ts`) ✅ | ICS 렌더러: `CalendarIcsEvent`·`renderIcsCalendar`(optional `calendarName`→`X-WR-CALNAME`)·`renderIcsEvent`·`escapeIcsText`·`foldIcsLine`·`toIcsDate` 등 + `IcsDateError` |
| `apps/web/src/lib/publicCalendar/query.ts` (+`.test.ts`) | `PublicCalendarFilters`, searchParams 파싱/직렬화(정렬·dedupe로 정규 URL), month clamp 상수(`CALENDAR_MIN_MONTH`~현재+12개월) |
| `apps/web/src/lib/server/publicCalendar/publicCalendarCore.ts` (+`.test.ts`) | DB 비의존 순수: DTO, `deriveCalendarStatus`(읽기 시점 상태 파생), `normalizeRegionBuckets`(오염 토큰→전국 버킷), `buildPublicCalendarEvents`(applyEnd→deadline, applyStart→start), `applyPublicCalendarFilters`, `buildPublicCalendarFacets` |
| `apps/web/src/lib/server/publicCalendar/publicCalendarData.ts` | `loadPublicCalendarMonth({monthKey})` — grants 전용 얕은 쿼리 + 모듈 스코프 promise 캐시(`serviceData.ts:164-206` 패턴, TTL 5분, 키=monthKey만, 엔트리 상한 24, drizzle 어댑터일 때만). `loadPublicCalendarFeed`(피드용 rolling 월 병합) |
| `apps/web/src/features/public-calendar/PublicCalendarView.tsx` | client 뷰(~400줄): 월 그리드·이벤트 칩·팝오버·필터바·"다가오는 일정"·연동 드롭다운. props는 직렬화 가능 DTO만 |
| `apps/web/src/features/public-calendar/publicCalendarLinks.ts` (+`.test.ts`) | 피드 경로→webcal/Google/Outlook/.ics URL 빌더 (origin은 클라에서 `window.location.origin` 조립) |
| `apps/web/src/app/(marketing)/calendar/page.tsx` | 서버 페이지: `await searchParams`→파싱→로더→뷰. `generateMetadata`. `dynamic="force-dynamic"` 관례 |
| `apps/web/src/app/api/web/public-calendar/route.ts` | 공개 ICS 피드 (GET) |

### 수정 파일

| 경로 | 수정 |
|---|---|
| `ApplicationCalendarView.tsx` ✅ | 로컬 날짜 유틸 삭제→공용 import. 기존 export 3종은 re-export로 계약 보존. 그 외 무변경 |
| `ApplicationCalendarView.test.ts` ✅ | 케이스 `dates.test.ts` 이관(KST 경계 보존), re-export 계약 가드만 잔존 |
| `applicationCalendar.ts` ✅ | ICS 렌더러 삭제→공용 import. `IcsDateError`→`ApplicationCalendarError` 재래핑으로 에러 계약 동일 유지 |
| `grantArchiveSearch.ts` | `sourceLabel`·`statusLabel` export 추가 (현재 module-private) |
| `packages/core/src/index.ts` | `REGION_CODES`·`REGION_LABELS`·`METRO_REGION_CODES` + regions 유틸 named export 추가 (현재 export 체인에 없음 — 확인됨). **core 수정이므로 build 필요** |
| `components/app/app-header.tsx` | 비로그인 else 분기에 "마감 캘린더" 링크 — 전 브레이크포인트 노출. doc 주석 갱신 |
| `features/landing/marketing-sections.tsx` | `LandingFooter` nav 맨 앞에 `/calendar` |
| `lib/server/auth/routePolicy.ts` | `PUBLIC_WEB_ROUTES`에 `"GET /calendar"`, `"GET /api/web/public-calendar"` (미등록 시 verify-route-policy CI 실패) |
| `package.json` | `verify:public-calendar` 체인 스크립트 |

## 4. 데이터 흐름

- **쿼리**: `grantArchiveData`(criteria JOIN + 20k 스캔, 공개 트래픽 부적합)를 쓰지 않고 grants 단독 얕은 쿼리 — `(apply_end ∈ 월범위 KST) OR (apply_start ∈ 월범위 KST)`, 선택 컬럼은 DTO 필드만, LIMIT 5001 sentinel(초과 시 503). 월 경계는 KST 자정→UTC 변환(-9h).
- **status/활성 조건을 SQL에 걸지 않음**: status는 stale(마감 경과 자동 closed 잡 없음 — 검증됨). 읽기 시점 `deriveCalendarStatus(row, todayKey)`로 파생(applyEnd<오늘→closed 교정). 조건 없는 월 쿼리가 캐시 재사용성도 최대화.
- **캐시**: 키=monthKey만. 필터·facet은 캐시된 rows에서 in-memory(히트율 보존). asOf 민감값(dDay·파생 상태)은 캐시 밖 매 요청 재계산.
- **필터·facet**: 지역은 `expandRegionToken`(수도권→3코드) 버킷, 오염 토큰만 있거나 빈 배열이면 **전국 취급**(자격 판정이 아닌 발견 표면이므로 포용). facet은 필터 적용 집합 count + 선택 옵션 항상 포함. 라벨: `REGION_LABELS`+"전국", `sourceLabel`/`statusLabel`.
- **DTO 과노출 방지**: `f_*` 자격 필드·confidence·embedding·criteria 제외. 노출: id/kind/date/dDay/title/source(+라벨)/agency/categoryL1/regionLabels/파생status/supportAmountLabel/url(원문). 내부 상세 링크 없음.

## 5. 페이지·URL

- `/calendar?month=2026-07&region=11,41&category=창업교육&source=kstartup&status=open` — 전 파라미터 검증·불량값 drop·정렬 직렬화. month 불량/범위 밖→현재 KST 월 폴백.
- **서버**: searchParams→로더→DTO. **월 이동은 `<a href>` 서버 재렌더**(필터 보존, SEO). **클라**: 팝오버·필터 인터랙션(`router.push`)·연동 드롭다운만.
- 팝오버: 제목·마감일·D-day·기관·지원금 + `[원문 보기]`(outline, 새 탭, url null이면 숨김) + `[내 조건으로 확인]`(primary→`/`).
- 과밀 날: 칩 2개 + "+N개" 클릭 팝오버(그날 전체 리스트). 모바일: 색점(마감=`text-destructive`, 접수시작=`text-success`) + "다가오는 일정" 리스트(목업 3c).
- **과거 월 허용**(하한 `CALENDAR_MIN_MONTH`, DB min 실측 조정): 아카이브 강점 + SEO 롱테일. 과거 월은 "마감됨" 흐린 스타일.
- metadata: `"{Y}년 {M}월 지원사업 마감 캘린더 | 창업노트"`, canonical은 `?month=`만(필터 제외 — 중복 색인 방지).
- 하단: `BizLookupProvider`+`FinalCta`+`LandingFooter` 재사용.

## 6. ICS 피드

- `GET /api/web/public-calendar?region=..&category=..&source=..&status=..` (+`download=1`→attachment). 페이지와 동일 파서.
- rolling window: 오늘~+120일, 상한 300 이벤트(날짜순 slice). `SUMMARY: 마감: {title}` / `접수 시작: {title}`, DESCRIPTION에 기관·분야·지원금·원문 링크. UID `pub-{kind}-{grantId}@cunote`.
- 종일 이벤트(`DTSTART;VALUE=DATE`, KST dateKey) — VTIMEZONE 불필요. `X-WR-CALNAME:창업노트 마감 캘린더`.
- `cache-control: public, max-age=1800, s-maxage=3600, stale-while-revalidate=3600`.
- 드롭다운: `.ics 내려받기` / Apple(`webcal://`) / Google(`calendar.google.com/calendar/r?cid=`) / Outlook(`addfromweb`) + 캡션 "현재 필터가 그대로 적용된 구독 주소예요."

## 7. 엣지 케이스

| 케이스 | 처리 |
|---|---|
| applyEnd null(상시) | 마감 이벤트 없음, applyStart 있으면 접수시작만. 둘 다 null이면 미표시 |
| stale status | `deriveCalendarStatus` 읽기 시점 교정 |
| 지역 코드 오염 | 오염 토큰 drop→코드 0개면 전국 버킷 |
| 빈 월 | 그리드 유지 + `Empty` + 필터 초기화 링크 |
| 미래 월 | +12개월 clamp |
| 행 폭주 | 월 5,000행 sentinel 초과 시 503 |

## 8. 작업 순서 (단계별 독립 커밋)

| 단계 | 내용 | 리그레션 게이트 |
|---|---|---|
| **1. 순수 자산 추출** ✅ | dates.ts + ics.ts 신설, 개인 캘린더 리팩터(기능 변화 0) | 이관 테스트 + `verify:application-calendar-subscription` + typecheck — **전부 통과** |
| **2. 서버 데이터 계층** | core index export(+build), 라벨 export, query/Core/Data + 테스트 | 신규 단위 테스트 + `verify:package-boundaries` |
| **3. 페이지+뷰+GNB** | shadcn 스킬 참조, PublicCalendarView, page.tsx+metadata, routePolicy, 헤더·푸터 | `verify:route-policy` + 드리프트 스캔 0 + 수동 렌더 |
| **4. ICS 피드+연동 메뉴** | 피드 라우트, routePolicy, publicCalendarLinks + 뷰 배선 | curl VCALENDAR + validator |
| **5. 마무리** | `verify:public-calendar` wiring, `CALENDAR_MIN_MONTH` 실측, 수동 시나리오 | 아래 검증 계획 전체 |

실행 방식: 구현은 Opus 서브에이전트에 단계 단위 위임, 메인이 설계·검수. 커밋은 명시 스테이징(add -A 금지).

## 9. 검증 계획

1. **단위**: dates(KST 경계)·ics(골든 문자열)·query(파싱/직렬화 왕복·clamp)·publicCalendarCore(이벤트/상태 파생·지역 버킷·facet)·publicCalendarLinks(URL 인코딩) — `verify:public-calendar` 체인.
2. **리그레션**: 개인 캘린더 테스트, `verify:application-calendar-subscription`.
3. **정적**: `pnpm verify:route-policy` · `pnpm typecheck` · 드리프트 스캔(`rg "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**'` = 0) · `verify:package-boundaries`.
4. **수동** (dev 서버는 사용자 기동): 시크릿 창 `/calendar` 렌더·월 이동·필터 URL 왕복, 팝오버 원문 새 탭·퍼널 CTA, `curl /api/web/public-calendar` ICS + Apple 캘린더 import, 모바일 뷰포트, 불량 `?month=` 폴백, 과거 월 스타일. Google/Outlook 구독은 프로덕션 배포 후.
