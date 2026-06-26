# S0-D 팝빌 CheckBizInfo 게이트

작성일: 2026-06-26 · 목적: 팝빌 기업정보조회가 창업노트 자동보강에 실제로 쓸 수 있는지 검증

## 1. 현재 확인 결과

로컬 `.env`에는 `POPBILL_API_KEY`만 존재한다. 값 형태상 팝빌 Node SDK의 `SecretKey` 별칭으로 사용할 수 있지만, `checkBizInfo` 호출에는 아래 값이 추가로 필요하다.

- `POPBILL_LINK_ID`: 팝빌 링크아이디
- `POPBILL_CORP_NUM`: 팝빌회원 사업자번호 10자리
- `POPBILL_CHECK_CORP_NUM`: 조회 대상 사업자번호 10자리
- `POPBILL_USER_ID`: 선택값이지만 운영 추적을 위해 권장

검증 명령:
```
node poc/popbill_checkbizinfo_probe.mjs
```

현재 실행 결과:
```
Missing required env keys: POPBILL_LINK_ID, POPBILL_CORP_NUM, POPBILL_CHECK_CORP_NUM
Current POPBILL_API_KEY is usable as POPBILL_SECRET_KEY, but LinkID/CorpNum/CheckCorpNum are still required.
```

## 2. 다음 실행 조건

`.env`에 아래 값을 추가한 뒤 다시 실행한다.
```
POPBILL_LINK_ID=
POPBILL_CORP_NUM=
POPBILL_CHECK_CORP_NUM=
POPBILL_USER_ID=
POPBILL_IS_TEST=true
POPBILL_IP_RESTRICT_ON_OFF=true
POPBILL_USE_STATIC_IP=false
POPBILL_USE_LOCAL_TIME_YN=true
```

패키지 설치 없이 일회성으로 SDK까지 포함해 실행하려면:
```
npm exec --package=popbill@1.64.2 -- node poc/popbill_checkbizinfo_probe.mjs
```

## 3. 통과 기준

1. `checkBizInfo` 호출이 `PopbillException` 없이 완료된다.
2. 응답의 `result/resultMessage/checkDT`가 기록된다.
3. 아래 필드의 채움 여부가 확인된다.
   - `corpScaleCode`
   - `industryCode`
   - `establishDate`
   - `addr`
   - `closeDownState`
   - `closeDownTaxType`
4. Vercel route와 로컬 또는 GCP 런타임 중 어디에서 호출 가능한지 확인한다.
5. 조회 원문 저장과 캐시 TTL이 팝빌 약관상 허용되는지 확인한다.

## 4. 판정 규칙

| 결과 | 판정 | 후속 |
|---|---|---|
| 주요 필드 4개 이상 채움 + Vercel 호출 가능 | 통과 | Next.js BFF에서 직접 호출 |
| 주요 필드 4개 이상 채움 + Vercel IP 제한 실패 | 조건부 통과 | GCP Cloud Run 고정 egress 경유 |
| `industryCode`/`addr`/`establishDate` 중 2개 이상 결측 | 조건부 | 자동보강은 일부만, progressive 자가신고 강화 |
| 호출 실패 또는 권한/상품 미개통 | 보류 | 팝빌 상품/계정 설정 재확인 |

## 5. 주의

- `CEOName`은 PII다. 소유권 검증의 주 근거로 쓰지 않고, 국세청 3요소 검증을 우선한다.
- `establishDate`가 개인사업자의 개업일과 항상 같은지 확인 전에는 업력 확정값으로 과신하지 않는다.
- 실패 결과도 반복 호출을 막기 위해 `company_enrichment_cache.last_error`에 저장한다.
