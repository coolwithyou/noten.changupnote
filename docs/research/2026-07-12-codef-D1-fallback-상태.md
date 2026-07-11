# CODEF D1 실측 — Fallback 진행 상태 (2026-07-12)

> STEP 1(D1 실계정 휴대폰 승인)은 대표자 휴대폰 승인이 필요해 세션이 대신 실행할 수 없다.
> 사용자 실시간 부재로 **Fallback 경로**(런북 STEP 1 명시)로 STEP 2·3을 먼저 완주했다.
> 이 문서는 D1이 재개될 때 무엇을 측정·튜닝해야 하는지의 단일 체크리스트다.

## Fallback 결정 (왜 D1 없이 진행했나)

런북·핸드오프가 이 경우를 위해 **구현이 D1을 기다리지 않도록** 설계했다:
- **SSO 양쪽 경로 모두 구현**: `orchestrator.ts`가 사업자등록증명 성공 후 같은 `id`로 VAT를 1차 시도(SSO 성립 가정, `CODEF_VAT_SSO_MODE=true`)하고, CF-03002면 2차 승인 유도(SSO 미성립 폴백)로 자동 분기.
- **부가세 응답 필드명 방어 탐색 유지**: `vat-base-certificate.ts`의 `TAX_BASE_*_KEYS`가 후보 키를 넓게 탐색.
- **CF-00003(상품 미신청) 관용**: VAT 상품이 아직 미승인이어도 사업자등록증명만으로 프로필 완성.

→ D1 결과가 나오면 **코드 2곳만 튜닝**하면 된다(아래 §튜닝 훅).

## D1 재개 시 실행 (사용자)

부가세과세표준 상품 승인 확인 후, **3종 계정**으로 각각:

```bash
pnpm verify:codef -- --name <이름> --birth <yyyyMMdd> --phone <숫자> --app kakaotalk --bizno <10자리>
# 대상: 법인 1 · 일반과세 개인 1 · 간이/면세 개인 1
# 앱코드: kakaotalk|samsungPass|kbMobile|pass|naver|shinhan|toss|banksalad|nh|woori (pass면 --telecom SKT)
# 기간 조정: [--start yyyyMM --end yyyyMM]  /  body 선확인: [--dry-run]
```

## 기록할 3항목 (GO 판정 = ①∧③ ∧ ②수용가능)

1. **① 세션 SSO**: 부가세과세표준이 **2번째 승인 없이** 처리됐나(CLI가 GO/NO/미측정 자동 출력).
2. **③ 개인 매출 커버리지**: 간이/면세 개인도 `taxBaseWon` 반환됐나(핵심 대상).
3. **부가세 응답 실제 필드명**: 성공 응답의 과세표준/연도 필드 원문 키.
4. **② 단가**: CODEF 상담(사람 작업, CLI 대상 아님).

## 튜닝 훅 (D1 결과 반영 지점 — 코드 2곳)

- **① SSO 결과 → `apps/web/src/lib/server/codef/orchestrator.ts`의 `CODEF_VAT_SSO_MODE`**(현재 `true`). NO면 `false`로 두면 사업자등록증명 성공 직후 곧장 2차 승인 유도.
- **③ 필드명 → `packages/core/src/codef/products/vat-base-certificate.ts`의 `TAX_BASE_AMOUNT_KEYS`/`TAX_BASE_LIST_KEYS`/`TAX_BASE_YEAR_KEYS`**를 실측 원문 키로 고정(현재 방어적 넓은 탐색).

## Phase B·C 완주 산출 (D1 없이 동작 확인된 것)

- 마이그레이션 `0042_lumpy_epoch`(운영 Supabase apply 성공): `codef_two_way_state` enum + `codef_two_way_sessions` + `codef_tokens`.
- 서버: `session-store.ts`(세션 CRUD·토큰 캐시·enrichment 캐시·best-effort companyProfiles), `orchestrator.ts`(양쪽 SSO·CF-00003 관용·마스킹).
- dev API: `api/dev/codef/simple-auth`(+`/complete`).
- dev UI: `CodefSimpleAuthPanel` + ServiceDataMonitor 병합(국세청 7축 `국세청(CODEF)` 원천·codef 최우선·passive 캐시 커넥터).
- 게이트: core build 0 · web typecheck 0 · web build 0 · 드리프트 신규 0.
- 커밋: `2a6fb16`(B1) · `0636211`(B2-B5) · `c32b510`(C).

## D1 후 남은 것 (범위 밖)

- 사용자 동반 dev 서버 E2E 시각검수(입력→승인→국세청 7축 병합 표시 + 재조회 캐시 뱃지).
- §6′-E known_flags 계약(매칭팀) 후 프로덕션 `serviceData.ts` 승격.
- L2/L3 상품(중소기업확인서·4대보험) 연동.
