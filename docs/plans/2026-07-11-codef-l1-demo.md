# CODEF L1(홈택스 간편인증) 연동 — 데모 페이지 실행 플랜

> **🟡 진행 상황 (2026-07-11 · 세션1)**
>
> - 계획 수립 완료. 구현 미착수.
> - 선행 리서치: `docs/research/2026-07-11-codef-field-sourcing-scenario.md` (14개 차원 소싱 시나리오, CODEF 공통 스펙 실측)
> - **확정된 결정**
>   - 데모 무대는 기존 `dev/service-data`(ServiceDataMonitor)에 "CODEF 간편인증" 섹션을 추가하는 방식 (새 페이지 만들지 않음 — 원천/신뢰도/캐시라이브 병합 UI 재사용)
>   - CODEF 코어는 `packages/core/src/codef/`에 배치 (popbill/nts 모듈과 동일 패턴)
>   - 2-way 세션 상태는 DB 테이블로 영속화 (Vercel serverless — 메모리 불가)
>   - `companyProfileSourceEnum`에 `codef` 이미 존재 → enum 마이그레이션 불필요
>   - 간편인증 입력값(생년월일)은 무저장 원칙, 주민번호 뒷자리 비공개(`isIdentityViewYN="0"`)
> - **남은 작업**: Phase A (P0) → B (P0) → C (P1) → D (P1). 착수 전 관문 의례(CALIBRATION-TEMPLATE) 확인
> - **선행 조건(사람 작업)**: codef.io 회원가입 → 데모버전 신청(사업자등록증명·부가세과세표준증명·재무제표) → clientId/clientSecret/publicKey를 `.env.local`에 등록

---

## 1. 배경·목표

공고 매칭 14개 차원(`packages/contracts/src/index.ts:1-16` `CRITERION_DIMENSIONS`) 중 7개를 **간편인증 1회**로 국세청 확정값으로 채우는 파이프라인을 검증한다:

| 차원 | CODEF 출력 근거 |
|---|---|
| `region` | 사업자등록증명 `resUserAddr` |
| `biz_age` | 〃 `resOpenDate` (개월 계산) |
| `industry` | 〃 `resBusinessTypes`/`resBusinessItems` → KSIC 매핑 (`packages/core/src/industry/ksic`) |
| `target_type` | 〃 `resBusinessmanType` (법인/개인) |
| `founder_age` | 간편인증 입력 생년월일 8자리 (증명서 아님 — 무저장, 연령만 파생 저장) |
| `founder_trait`(성별) | UI 1탭 입력 (주민번호 수집 회피) |
| `revenue` | 부가세과세표준증명 (같은 간편인증 세션 SSO 연속 호출) |

**데모 목표(Definition of Done)**: `dev/service-data`에서 사업자번호 + 이름/생년월일/전화/인증앱 입력 → 카카오톡 등에서 승인 → 매칭 필드 테이블에 위 7개 차원이 `source=codef`, `라이브 호출` 뱃지로 병합되어 표시. 재조회 시 캐시(`company_enrichment_cache`) 재사용 표시.

**비목표(이번 플랜에서 제외)**: 재무제표 파싱 고도화(표준손익계산서 항목 파싱은 C에서 스파이크만), sminfo(L2)·4대보험(L3), 크레딧 과금 연결, 프로덕션 온보딩 UI, 커넥티드아이디.

## 2. 아키텍처 (기존 패턴 준수)

```
packages/core/src/codef/          ← 순수 로직 (popbill/ 모듈과 대칭)
  env.ts          readCodefEnvConfig()  — CODEF_CLIENT_ID/SECRET/PUBLIC_KEY/ENVIRONMENT
  token.ts        토큰 발급·캐시 (유효 7일, DB 캐시는 web 레이어에 위임 — 함수는 순수)
  rsa.ts          publicKey RSA 암호화 유틸 (node:crypto)
  client.ts       requestProduct() — 공통 POST, result.code 분기, CF-03002 감지
  two-way.ts      2-way 상태 타입·전이 (TwoWaySession: params snapshot + twoWayInfo)
  products/
    corporate-registration.ts     사업자등록증명 (요청 빌더 + 응답 정규화)
    vat-base-certificate.ts       부가세과세표준증명
  normalize.ts    응답 → CompanyProfile 파생 (profile-from-popbill.ts와 대칭:
                  buildCompanyProfileFromCodef())
  types.ts / codef.test.ts

apps/web/src/lib/server/codef/    ← 오케스트레이션 (serviceData.ts 패턴)
  session-store.ts  codef_two_way_sessions CRUD + 토큰 DB 캐시
  orchestrator.ts   startSimpleAuth() / completeSimpleAuth() — 증명 2종 연속 호출,
                    company_enrichment_cache(provider='codef') upsert,
                    companyProfiles(dimension별, source='codef', confidence) upsert

apps/web/src/app/api/dev/codef/
  simple-auth/route.ts        POST 시작(1차 요청 → CF-03002 대기 상태 저장)
  simple-auth/complete/route.ts  POST 승인확인(is2Way 재요청 → 결과 병합)
  (runtime="nodejs", dynamic="force-dynamic", envelope.ts 봉투 — 기존 관례)

apps/web/src/features/dev/ServiceDataMonitor.tsx  ← CODEF 섹션 추가
```

**DB 변경 (마이그레이션 1건)** — `pnpm db:generate` → `pnpm db:migrate` 순서 엄수 (`db:push` 금지, CLAUDE.md):

```
codef_two_way_sessions
  id (pk), biz_no, user_id, product_scope ('l1_bundle'),
  state pgEnum: pending_approval | completing | done | failed | expired,
  request_snapshot jsonb   ← 1차 파라미터 (생년월일·전화 포함 → 완료/만료 시 즉시 NULL 처리)
  two_way_info jsonb       ← jobIndex/threadIndex/jti/twoWayTimestamp
  error_code, created_at, expires_at (now + 4분30초)
codef_tokens (또는 kv 재사용): access_token, expires_at
```

- `company_enrichment_cache`: 스키마 변경 없음. `provider='codef'`, `scope='corporate-registration' | 'vat-base'`로 행 추가
- `consents`: 기존 `hometax` scope 사용 — 데모 페이지에서도 동의 체크박스 → consents 기록 (프로덕션 전환 대비)

## 3. Phase별 작업

### Phase A — CODEF 코어 모듈 (P0, 순수 로직만·네트워크는 fixture)

| # | 작업 | 파일 | 완료 기준 |
|---|---|---|---|
| A1 | env 로더 | `packages/core/src/codef/env.ts` | `readPopbillEnvConfig` 패턴. `CODEF_ENVIRONMENT=demo\|production` → `https://development.codef.io` / `https://api.codef.io` 분기. 누락 시 명시적 에러 |
| A2 | RSA 유틸 | `codef/rsa.ts` | publicKey(Base64 DER)로 `crypto.publicEncrypt`(PKCS1). 테스트: 로컬 생성 키쌍으로 왕복 검증 |
| A3 | 토큰 로직 | `codef/token.ts` | `POST oauth.codef.io/oauth/token` (Basic auth, `grant_type=client_credentials&scope=read`). 응답 URL-decode 주의. 만료 판정 함수 분리 |
| A4 | 공통 클라이언트 | `codef/client.ts` | `result.code` 분기: `CF-00000` 성공 / `CF-03002`+`continue2Way` → TwoWayRequired 반환 / 그 외 CodefError(code, message). **응답 전문은 URL-encoded JSON — decode 처리** |
| A5 | 상품 빌더 2종 | `products/*.ts` | loginType="5"(회원 간편인증) 파라미터 빌더. `id`(SSO 세션키) = `사용자ID+bizNo 해시`. `isIdentityViewYN:"0"`, `usePurposes:"99"`, `submitTargets:"99"`(→ 오픈 결정 #1) |
| A6 | 정규화 | `normalize.ts` | 증명 응답 → `{dimension, value, confidence, asOf}` 배열. region 주소 원문 보존 + 시도/시군구 파싱, biz_age 개월 계산, industry는 ksic 매핑 함수 호출, revenue 원 단위 정수화 |
| A7 | 테스트 | `codef/codef.test.ts` | `node:assert/strict` + check() 미니 러너(기존 관례). 실제 응답 fixture(데모 키로 1회 채집한 JSON, 개인정보 마스킹) 기반 정규화·2-way 전이 검증 |

### Phase B — 서버 오케스트레이션 + 2-way 상태머신 (P0)

| # | 작업 | 파일 | 완료 기준 |
|---|---|---|---|
| B1 | 마이그레이션 | `db/schema.ts` + drizzle | `codef_two_way_sessions`, 토큰 캐시. generate 결과에 기존 객체 재생성 섞이면 SQL에서 제거(0018~0025 전례) |
| B2 | 세션 스토어 | `lib/server/codef/session-store.ts` | 만료 세션 정리(조회 시 lazy), request_snapshot은 완료·실패·만료 즉시 NULL 갱신 |
| B3 | 오케스트레이터 | `lib/server/codef/orchestrator.ts` | `startSimpleAuth(bizNo, {name, birth8, phone, telecom, authApp, gender})`: 1차 요청 → CF-03002면 세션 저장 후 `{sessionId, guide}` 반환. `completeSimpleAuth(sessionId)`: is2Way 재요청 → 성공 시 **같은 id로 부가세과세표준 연속 호출**(세션 SSO 실측 — 실패 시 두 번째 상품도 2-way 재수행 폴백) → cache upsert → companyProfiles upsert(source='codef', confidence 0.95) |
| B4 | 라우트 2본 | `api/dev/codef/...` | 기존 `api/dev/service-data` 인증 가드와 동일한 dev 가드 적용. 미승인 상태 complete 호출 시 CF-12872 대비 — 서버에서 재시도 카운트 제한(최대 2회) |
| B5 | 로깅·마스킹 | 공통 | 생년월일·전화·주민번호·certPassword 로그 금지(토큰 금지 규칙과 동일 수준). transactionId만 기록 |
| B6 | 검증 스크립트 | `scripts/verify-codef.ts` + `verify:codef` | env 존재 → 토큰 발급 → (선택) 휴폐업 등 비인증 상품 1건 스모크. CI 체인 편입 여부는 데모 키 쿼터(일 100건) 고려해 수동 실행으로 시작 |

### Phase C — 데모 UI (P1)

**UI 규칙(CLAUDE.md 최우선) 적용: 착수 전 `.claude/skills/shadcn` 스킬 로드, primitive는 `npx shadcn@latest add`, 토큰만 사용, 드리프트 스캔 0 유지.**

| # | 작업 | 파일 | 완료 기준 |
|---|---|---|---|
| C1 | CODEF 섹션 추가 | `features/dev/ServiceDataMonitor.tsx` (또는 하위 `CodefSimpleAuthPanel.tsx` 분리) | 입력 폼: 이름/생년월일/휴대폰/통신사/인증앱(11종 select)/성별(founder_trait용). hometax 동의 체크 → 시작 버튼 |
| C2 | 승인 대기 UX | 〃 | "카카오톡에서 인증을 승인해주세요" 상태 + [승인 완료] 버튼(폴링 아님 — 사용자 탭 후 complete 호출). 남은 시간 표시(4분30초), 만료/실패 시 재시작 |
| C3 | 필드 병합 표시 | 〃 | `FieldSourceLabel`에 `"codef"` 추가, `SourceBadge` 라벨 "국세청(CODEF)". `mergeFieldsWithQna()` 우선순위: codef > popbill/apick > qna. 신뢰도 95%, 캐시/라이브 뱃지 연동 |
| C4 | founder_age/trait 병합 | 〃 + orchestrator | 생년월일 → 연령(만) 파생값만 저장·표시. 성별 입력 → founder_trait. 원천 라벨은 "간편인증 입력" 구분 (codef와 별도 소스로 할지 → 오픈 결정 #2) |

### Phase D — 실기업 E2E + 재무제표 스파이크 (P1)

| # | 작업 | 완료 기준 |
|---|---|---|
| D1 | E2E 실측 | 데모 키로 실기업 최소 3곳(법인 1·일반과세 개인 1·간이 1) 전 플로우. 세션 SSO로 2상품 연속 호출이 실제 1회 인증으로 되는지 **실측 기록** (안 되면 B3 폴백 확정) |
| D2 | 엣지 기록 | 면세사업자 상호 빈값, 공동대표, 신규 사업자(부가세 신고 이력 없음 → revenue 빈 응답) 케이스를 research 문서에 추가 |
| D3 | 재무제표 스파이크 | `standard-financial-statements` 1회 호출 → `resIncomeStatement` 매출액 코드 확인만 (08~22시 제약·IP 차단 경고 유의, 파싱 구현은 후속 플랜) |
| D4 | 비용 산정 | 정식버전 견적 문의 발송(호출량 = 예상 인증 사용자 × 상품 2~3종) — 사람 작업 |

## 4. 구현 순서·위임

- 세션 운영: **A → B → C → D 직렬**. A+B는 Opus 서브에이전트에 위임(구현), 메인은 설계 검수 (CLAUDE.md 작업 체계)
- 커밋 단위: A(코어+테스트) / B1(마이그레이션 단독) / B2-B6 / C / D 문서. 커밋 메시지 한국어, git 쓰기 전 stale-lock 처리 (`mkdir -p .git/stale-locks && mv .git/*.lock ...`)
- 예상 규모: A ~600줄, B ~500줄+마이그레이션, C ~400줄 (데모 범위 기준)

## 5. 오픈 결정 (구현 중 확정 필요)

1. **usePurposes/submitTargets 값**: "99:기타"로 시작하되, CODEF 기술문의로 서비스 성격(지원사업 자격확인)에 맞는 권장값 확인
2. **founder_age/trait의 source enum**: `codef`로 통칭할지 `self_declared`(간편인증 입력)로 구분할지 — 정합성상 후자 권장이나 UI 신뢰도 표기와 상충 검토
3. **세션 SSO 미동작 시**: 상품 2종 각각 간편인증(사용자 승인 2회)을 감수할지, 사업자등록증명만으로 축소할지 — D1 실측 후
4. **데모 키 쿼터(일 100건)** 내 팀 공유 규칙 — verify:codef 수동 실행 원칙
5. 예비창업자(사업자 미등록) 분기는 이 플랜 범위 밖 — Q&A 경로 유지 확인만

## 6. 리스크

| 리스크 | 대응 |
|---|---|
| 샌드박스가 추가인증 미지원 → 2-way는 데모 키+실계정으로만 테스트 가능 | A는 fixture 기반, B부터 데모 키 필요. 선행 조건에 명시 |
| 스크래핑 태생: 홈택스 개편 시 일시 장애 | result.code 계측 + 실패 시 기존 소스(팝빌) 폴백 유지 |
| 민감정보(생년월일·전화) 취급 | request_snapshot 즉시 파기, 로그 마스킹(B5), 동의 기록(consents.hometax) |
| 재요청 제한(제한시간 내 동일계정 차단) | 세션 단위 락 — 진행 중 세션 있으면 시작 버튼 비활성 |
| 응답 전문 URL-encoding·대소문자 필드명(`resUserIdentiyNo` 오타 포함) | fixture 기반 정규화 테스트(A7)로 고정 |

## 문서 지도

- 소싱 시나리오(근거): `docs/research/2026-07-11-codef-field-sourcing-scenario.md`
- 매칭 데이터 보강 선행 플랜: `docs/plans/2026-07-05-matching-data-enrichment.md`
- 데모 무대: `apps/web/src/features/dev/ServiceDataMonitor.tsx`, `apps/web/src/app/dev/service-data/page.tsx`
- 대칭 참조 구현: `packages/core/src/popbill/`, `packages/core/src/company/profile-from-popbill.ts`
