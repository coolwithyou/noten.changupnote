# 창업노트 — 공고 API 정리 및 응답 필드 분석

작성일: 2026-06-19 · 목적: 매칭용 데이터 표준화 스키마 설계의 1차 근거

실제 응답을 떠서 "매칭에 바로 쓸 수 있는 구조화 필드"와 "본문·첨부에 묻혀 추출이 필요한 비정형"을 구분했다.

---

## 1. 공고 API 3종 한눈에

| API | 제공처 | 인증 | 포맷 | 실응답 확보 | 성격 |
|---|---|---|---|---|---|
| 기업마당 지원사업 | 중기부/중소기업유통센터 (bizinfo.go.kr) | crtfcKey | XML / **JSON(dataType=json)** | ✅ 확보 | 자격요건 게이팅 강함 → **매칭 핵심** |
| 기업마당 행사 | 동일 | crtfcKey | XML / JSON | ✅ 확보 | 교육·세미나, 게이팅 약함 |
| K-Startup 공고 | 중기부/창업진흥원 (nidapi.k-startup.go.kr) | serviceKey | JSON | ✅ 확보 | **자격요건 대부분 구조화 필드 → 추출 低난도** |

> JSON은 `dataType=json` 파라미터로 받는 게 파싱에 유리(기본은 XML/RSS).
> 코드 fallback 키 `XiI87M`은 테스트용 — 운영 키 교체 필수.

---

## 2. 기업마당 지원사업 — 응답 필드맵

실제 레코드 예시: `[전남] 첨단로봇ㆍAI 활용 중소기업 제조혁신 사업 기업지원(기획 컨설팅) 모집 공고`

범례: 🟢 구조화(바로 매칭 가능) · 🟡 반구조화(파싱 필요) · 🔴 비정형(추출 필요)

| 필드 | 의미 | 예시값 | 매칭 활용 |
|---|---|---|---|
| `pblancId` | 공고 고유 ID | `PBLN_000000000123377` | 🟢 PK·dedup |
| `pblancNm` | 공고명 | `[전남] 첨단로봇…모집 공고` | 🟡 제목 `[지역]` prefix 파싱 가능 |
| `jrsdInsttNm` | 소관기관 | `전라남도` | 🟢 지역 1차 추론 |
| `excInsttNm` | 수행기관 | `전남테크노파크` | 🟢 |
| `pldirSportRealmLclasCodeNm` | 지원분야 대분류 | `기술` | 🟢 |
| `pldirSportRealmMlsfcCodeNm` | 지원분야 중분류 | `기술사업화/이전/지도` | 🟢 |
| `trgetNm` | 지원대상 | `중소기업` | 🟡 너무 거침, 단독 매칭 불가 |
| `hashtags` | 해시태그(콤마) | `기술,전남,로봇 제조기업,제조기업,AI,중소기업…` | 🟡 지역·업종 보조신호 |
| `reqstBeginEndDe` | 신청기간 | `2026-06-17 ~ 2026-07-10` | 🟡 range 문자열 split |
| `reqstMthPapersCn` | 접수방법 | `온라인 접수(…데이터플랫폼)` | 🔴 텍스트 |
| `pblancUrl` / `rceptEngnHmpgUrl` | 공고·접수 URL | … | 🟢 딥링크 |
| `fileNm`/`printFileNm`/`flpthNm`/`printFlpthNm` | 첨부 파일명·경로 | `…공고문.hwp` | 🔴 **실제 상세 자격요건 위치** |
| `creatPnttm`/`updtPnttm` | 생성·수정일 | `2026-06-18 …` | 🟢 신선도 |
| `inqireCo` / `totCnt` | 조회수 / 전체건수 | `2686` / `1545` | — 메타 |
| **`bsnsSumryCn`** | **사업요약(HTML)** | (아래) | 🔴 **핵심 자격요건 덩어리** |

### `bsnsSumryCn` 안에 묻힌 것 (= 추출 대상)
> "(수혜기업) **공고일 기준 사업자등록증상 전남도 소재 중소기업**(본사, 지사, 공장)으로, 로봇 도입 희망, 로봇 제조기업, 공급기업, SIㆍSW 기업…"
> "기획 비용 지원 (**기업당 최대 4백만원**)"

여기서 뽑아야 할 구조화 항목:
- **지역요건**: 전남도 소재 (본사/지사/공장 인정)
- **기업규모**: 중소기업
- **업종요건**: 로봇 제조·공급·SI·SW 등
- **지원금액**: 최대 4,000,000원
- **필수 vs 우대** 구분
- (이 공고엔 없지만 흔함) **업력**: "창업 N년 이내"

---

## 3. 기업마당 행사 — 응답 필드맵

실제 예시: `[전국] KOCCA×NETFLIX 2026 프로덕션 아카데미 …교육생 모집`

| 필드 | 의미 | 예시값 | 비고 |
|---|---|---|---|
| `eventInfoId` | PK | `EVEN_000000000068782` | 🟢 |
| `nttNm` | 행사명 | `[전국] KOCCA×NETFLIX…` | 🟢 |
| `eventInfoTyNm` | 행사유형 | `교육` | 🟢 |
| `pldirSportRealmLclasCodeNm` | 분야 | `인력` | 🟢 |
| `areaNm` | 지역 | `서울` | 🟢 (지원사업보다 지역이 구조화됨) |
| `eventBeginEndDe` | 행사기간 | `20260710 ~ 20260710` | 🟡 |
| `rceptPd` | 접수기간 | `~2026-06-29` | 🟡 |
| `originEngnNm` | 주관기관 | `한국콘텐츠진흥원` | 🟢 |
| `nttCn` | 내용(HTML) | … | 🔴 |
| `bizinfoUrl`/`orginlUrlAdres` | URL | … | 🟢 |

→ 행사는 자격 게이팅이 거의 없어(누구나 신청) 정규화 난도가 낮다. **난관은 지원사업에 집중.**

---

## 4. K-Startup (✅ 실응답 확보 — S0-A 완료)

- **엔드포인트(신버전, 15125364)**: `https://nidapi.k-startup.go.kr/api/kisedKstartupService/v1/getAnnouncementInformation` (apis.data.go.kr 구버전은 403/404 — K-Startup 자체 도메인으로 이전됨)
- 파라미터: `serviceKey, page, perPage, returnType=json`. **totalCount 29,187** (누적, 활성은 일부). 응답 30개 필드.
- 실샘플: `samples/kstartup_announcement_sample.json`

### 🎯 핵심 발견 — K-Startup은 자격요건이 대부분 구조화 필드로 온다
기업마당과 달리, 매칭 차원이 **전용 필드**로 제공됨:

| 필드 | 의미 | 실값 예 | 매칭 활용 |
|---|---|---|---|
| `supt_regin` | 지원지역 | 서울 / 경기 / 전국 | 🟢 지역 |
| `biz_enyy` | 대상 업력(복수) | `예비창업자,7년미만` / `1년미만…10년미만` | 🟢 업력 + **예비창업 네이티브 태깅** |
| `biz_trgt_age` | 대상 연령(복수) | `만20세이상~39세이하,만40세이상` | 🟢 대표자 연령 |
| `supt_biz_clsfc` | 지원분야 | 사업화 / 판로·해외진출 / 행사·네트워크 | 🟢 분야 |
| `aply_trgt` | 대상유형(복수) | `일반기업,1인 창조기업,대학…` | 🟢 대상 |
| `aply_excl_trgt_ctnt` | 제외대상 | "수도권 소재 기업 제외…" | 🟡 scoped 텍스트(배제) |
| `aply_trgt_ctnt` | 신청대상 상세 | "서울 소재 중소기업…" | 🟡 scoped 텍스트(업종·규모 nuance) |
| `pbanc_rcpt_bgng_dt`/`end_dt` | 접수 시작/종료 | 20260623 | 🟢 일정 |
| `aply_mthd_*_istc` | 신청방법(온/오프/이메일/팩스/방문/우편) | URL/값 | 🟢 |
| `pbanc_sn` · `detl_pg_url` · `pbanc_ntrp_nm` · `sprv_inst` | PK·상세URL·공고기관·주관유형 | | 🟢 |
| `pbanc_ctnt` · `prfn_matr` | 공고내용·유의사항 | (본문) | 🔴 보조 추출 |

**파싱 주의**: `biz_enyy`/`biz_trgt_age`/`aply_trgt`는 **허용 항목의 콤마 집합**(예: "예비창업자,7년미만" = 예비 + 7년 이내 허용) → 집합으로 해석, 상한·예비포함 도출.

### 시사점
- **K-Startup 추출 부담 = 낮음.** grant_criteria의 지역·업력·연령·분야·대상·일정을 **필드 파싱**으로 채우고, LLM 추출은 `aply_trgt_ctnt`/`aply_excl_trgt_ctnt`의 짧은 scoped 텍스트(업종·규모·특수조건)에만. HWP·본문 헤집기 불필요.
- 즉 **기업마당(HWP·본문 비정형, 高난도)과 K-Startup(필드 구조화, 低난도)은 추출 프로파일이 완전히 다름** → MVP는 K-Startup 우선이 저위험 wedge.
- `biz_enyy`에 `예비창업자`가 값으로 존재 → **예비창업 매칭이 K-Startup에선 사실상 공짜.**

---

## 5. 핵심 결론 — 표준화 프로토콜이 필요한 이유

1. **매칭에 바로 쓸 수 있는 구조화 필드는 일부뿐**: 분야(대/중분류), 기관, 신청기간, 거친 대상.
2. **정작 매칭을 가르는 자격요건(업력·정확한 지역·업종 상세·규모·지원금액·필수/우대)은 `bsnsSumryCn` HTML + 첨부 HWP에 비정형으로** 들어있다.
3. `hashtags`는 표준은 아니지만 지역·업종 1차 태깅에 쓸만한 **보조신호**.
4. 따라서 수집 → **정규화(추출) 레이어**가 반드시 필요. 이 레이어의 품질이 매칭 정확도의 천장.

### 정규화 타깃 스키마 (초안)
```
grant {
  id, source(kstartup|bizinfo), title, url, attachments[],
  agency_관할, agency_수행,
  category_대, category_중,
  region[]            // 추출+시도코드 정규화
  target_업력_min/max // 추출 (개월)
  target_업종[]        // 추출 + KSIC/표준태그 매핑
  target_규모[]        // 소상공인|중소|중견 (추출)
  target_대표자속성[]  // 청년|여성|장애인 (추출)
  support_amount       // 추출
  req_필수[], req_우대[]// 추출 + 구분
  apply_start, apply_end, apply_method,
  raw_summary_html, hashtags[],
  _field_confidence{}, _as_of   // 필드별 신뢰도·시점
}
```
각 추출 필드에 **신뢰도와 출처(원문 span)** 를 달아야, 매칭 결과에 "왜 이 사업인지" 근거를 보여주고 골든셋으로 정확도를 측정할 수 있다.

---

## 6. 다음 액션
- [x] K-Startup 신엔드포인트 실응답 확보 → 필드 확정(S0-A).
- [x] 첨부 HWP 파서 PoC → pyhwp `hwp5html` 채택(S0-B). 스캔형 PDF/HWP만 OCR 잔여.
- [x] K-Startup scoped 텍스트·기업마당 HWP MD → Claude tool-use 추출 PoC(S0-C1).
- [ ] 골든셋: 지원사업 50~100건 수동 라벨링으로 추출/매칭 정답 구축(S0-C2, 엄밀 P/R).
- [ ] 팝빌 테스트계정으로 기업정보 커버리지·캐시 가능 범위 검증(S0-D).
- [ ] K-Startup↔기업마당 dedup 실측(S0-E).
