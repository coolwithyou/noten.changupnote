# S0-D 팝빌 CheckBizInfo 게이트

작성일: 2026-06-26 · 목적: 팝빌 기업정보조회가 창업노트 자동보강에 실제로 쓸 수 있는지 검증

## 1. 현재 확인 결과

2026-06-26 현재 로컬 `.env`에는 아래 값이 설정되어 있다.

- `POPBILL_SECRET_KEY`: 팝빌 SecretKey
- `POPBILL_LINK_ID`: 팝빌 링크아이디
- `POPBILL_CORP_NUM`: 팝빌회원 사업자번호 10자리
- `POPBILL_DEMO_CHECK_CORP_NUM`: 조회 대상 사업자번호 10자리

검증 명령:
```
tmpdir=$(mktemp -d /tmp/cunote-popbill.XXXXXX) && npm install --prefix "$tmpdir" popbill@1.64.2 >/dev/null 2>&1 && NODE_PATH="$tmpdir/node_modules" node poc/popbill_checkbizinfo_probe.mjs; code=$?; rm -rf "$tmpdir"; exit $code
```

로컬 실행 결과:
```
{
  "result": 100,
  "resultMessage": "성공",
  "checkDT": "20260626101802",
  "hasCorpName": true,
  "hasCorpScaleCode": true,
  "hasIndustryCode": true,
  "hasEstablishDate": true,
  "hasAddress": true,
  "closeDownState": 1,
  "closeDownTaxType": 10
}
```

## 2. 판정

**조건부 통과.**

- 로컬 Node 런타임에서는 `checkBizInfo` 호출이 성공했다.
- 자동보강 핵심 후보(`corpScaleCode`, `industryCode`, `establishDate`, `addr`, `closeDownState`, `closeDownTaxType`)가 모두 채워졌다.
- 따라서 팝빌은 기창업 회사 프로필의 **규모·업종·업력 후보·주소·휴폐업/과세 상태 자동보강 소스**로 사용 가능하다.
- 남은 조건은 Vercel route 실행 가능 여부와 원문 응답 캐시/TTL의 약관 허용범위 확인이다.

## 3. 통과 기준

1. ~~`checkBizInfo` 호출이 `PopbillException` 없이 완료된다.~~ 완료.
2. ~~응답의 `result/resultMessage/checkDT`가 기록된다.~~ 완료.
3. ~~아래 필드의 채움 여부가 확인된다.~~ 완료.
   - `corpScaleCode`
   - `industryCode`
   - `establishDate`
   - `addr`
   - `closeDownState`
   - `closeDownTaxType`
4. Vercel route와 로컬 또는 GCP 런타임 중 어디에서 호출 가능한지 확인한다. **남음**
5. 조회 원문 저장과 캐시 TTL이 팝빌 약관상 허용되는지 확인한다.

## 4. 판정 규칙

| 결과 | 판정 | 후속 |
|---|---|---|
| 주요 필드 4개 이상 채움 + Vercel 호출 가능 | 통과 | Next.js BFF에서 직접 호출 |
| 주요 필드 4개 이상 채움 + Vercel 미검증 또는 IP 제한 실패 | 조건부 통과 | Vercel 검증 후, 실패 시 GCP Cloud Run 고정 egress 경유 |
| `industryCode`/`addr`/`establishDate` 중 2개 이상 결측 | 조건부 | 자동보강은 일부만, progressive 자가신고 강화 |
| 호출 실패 또는 권한/상품 미개통 | 보류 | 팝빌 상품/계정 설정 재확인 |

## 5. 주의

- `CEOName`은 PII다. 소유권 검증의 주 근거로 쓰지 않고, 국세청 3요소 검증을 우선한다.
- `establishDate`가 개인사업자의 개업일과 항상 같은지 확인 전에는 업력 확정값으로 과신하지 않는다.
- 실패 결과도 반복 호출을 막기 위해 `company_enrichment_cache.last_error`에 저장한다.
