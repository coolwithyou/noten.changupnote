# 매칭 데이터 소싱 — 미구현 필드 갭 분석 & 구현 계획

> 2026-07-12. 상태: **계획 · 착수 대기**.
> 단일 설계 참조: `docs/plans/2026-07-11-matching-data-sourcing.md`(§4 축↔소스, §6′ 신규 8축, §8 실행 순서).
> 키 매니페스트: `docs/plans/2026-07-11-sourcing-keys-manifest.md` · 발급 가이드: `2026-07-11-sourcing-keys-acquisition-guide.md`.
> 코드 실측 기준: `apps/web/src/lib/server/devServiceDataMonitor.ts`(dev 하네스 커넥터 5종), `apps/web/src/lib/server/serviceData.ts`(프로덕션 오버레이 = 팝빌+NTS+SMPP만).

## 0. 전제 — 어디까지가 "구현"인가

두 개의 격리 경계가 이 계획의 골격을 정한다.

1. **dev 하네스 vs 프로덕션 오버레이.** 신규 소싱 커넥터 5종(kcomwel·fsc·nice·codef + 이 계획의 신규)은 전부 `runExternalConnectors`(`devServiceDataMonitor.ts:954-970`) 안에서만 산다. 프로덕션 매칭 파이프라인(`serviceData.ts:379-388`, 팝빌→NTS→SMPP)은 **§6′-E 매칭팀 계약(known_flags 소스맵·positive-only 예외) 전까지 손대지 않는다**. → 이 계획의 Phase S1~S3은 전부 dev 하네스에 배선하고, 프로덕션 진입은 Phase S4(계약)로 게이트.
2. **커넥터 있음 ≠ 채워짐.** `ENV_KIPRIS`·`ENV_MOEL`은 상수만 선언돼 있고(`devServiceDataMonitor.ts:570,573`) 이를 읽는 커넥터가 없다 → 키를 넣어도 pending. "구현"은 **커넥터/배치 코드 + 값 매핑**까지를 말한다.

---

## 1. 갭 분석 — 지금 채워야 하는데 소싱 코드가 없는 필드

FIELD_COVERAGE_PLAN(`devServiceDataMonitor.ts:650-719`)을 3버킷으로 분류. **버킷 A만 이 계획의 착수 대상**이다.

### 버킷 A — 계획 소스는 있으나 커넥터/배치 코드가 없음 (착수 대상)

| # | 필드(row.key) | 계획 소스 | 구현 유형 | 매칭 방식 | polarity |
|---|---|---|---|---|---|
| A1 | `ip` | KIPRIS Plus | 단일 API 커넥터 | 출원인(상호/사업자번호) | positive-only |
| A2 | `sanction.participation_restricted` | 조달청 부정당제재 CSV **15137996** | 배치(registry) | **사업자번호·법인번호 정확** | **known-on-absence** |
| A3 | `certification`(공개명단분) | 벤처 **15084581**·이노비즈/메인비즈 **3033893**·사회적기업 **15090102**·연구소 KOITA | 배치(registry) | 상호+시도 퍼지 | positive-only(conf 0.55) |
| A4 | `sanction.serious_accident_listed` | 중대재해 **15090150**(`fileData.do` CSV) | 배치(registry) | 상호 퍼지 | present-only |
| A5 | `sanction.wage_arrears_listed` | 고용부 체불 명단(moel.go.kr 웹) | 배치(registry, 스크래핑) | 상호+대표자+주소 퍼지 | present-only |
| A6 | `investment.tips_backed` | jointips.or.kr 팀 목록(웹) | 배치(registry, 스크래핑) | 기업명 퍼지 | present-only(conf 0.9) |
| A7 | `insured_workforce.insured_count` | CODEF 4대보험 사업장 가입자명부 | CODEF 상품 확장(B층·인증) | 간편인증 후 판독 | — |
| A8 | `tax_compliance`(개인) | CODEF 납세증명·지방세납세증명 | CODEF 상품 확장(B층·인증) | 간편인증 후 판독 | present-only |

- A2~A6은 **공용 배치 인프라 `registry_index` 위에서 매핑만 다르게** 얹힌다(설계 §6′-C). → 마이그레이션 1건 + 다운로드/정규화/퍼지매처 1벌 + 소스별 어댑터.
- A7~A8은 **CODEF 상품 확장**이라 CODEF L1 go/no-go 이후에 붙는다(설계 §6, `codef-Phase-B-C:7.1,7.5`).

### 버킷 B — 커넥터는 구현됐으나 운영 전제(키·계약·브리지) 미충족 (착수 대상 아님, 확인 필요)

| 필드 | 상태 | 남은 전제 |
|---|---|---|
| `employees`, `insured_workforce.employment_insurance_active` | kcomwel 커넥터 완료 | data.go.kr 백엔드 **502** 복구 후 라이브 재스모크(`sourcing.md:206`) |
| `revenue`(법인), `financial_health.*`(법인) | FSC 15043459 커넥터 완료·**live 확인** | **법인등록번호 브리지** 필요(현재 apick 유료만, 팝빌 미제공 — `sourcing.md:205` Phase 2 별과제) |
| `tax_compliance.*`(법인), `credit_status.*`(법인) | NICE OCCD03/06 커넥터 완료 | **NICE 실계약**(현재 무계약 데모, OCCD01=부도는 403 미프로비저닝) |
| `revenue`(개인), `region/biz_age/industry/target_type/founder_age`(확정) | CODEF passive 커넥터 완료 | 사용자 **간편인증 실행**(D1 실계정 3종 승인) |

### 버킷 C — 자가신고 종착 / defer (소싱 대상 아님)

- 자가신고 상한(공개·자동 소스 없음): `founder_trait`(청년·시니어), `prior_award`, `tax_compliance.customs/social_insurance`, `credit_status.asset_seizure/guarantee_restricted`, `sanction.subsidy_fraud/law_violation/obligation/agreement_breach`, `insured_workforce.no_layoff`, `investment.total_raised_krw/last_round`, `other`.
- defer(예약축): `premises`, `export_performance`.
- `prior_award`는 매칭팀 후속 트랙에서 구조화 진행 중(3중 방어층으로 자동 소싱 차단) — `HANDOFF-2026-07-12-p6-prior-award-design.md`.

---

## 2. 구현 계획 (Phase)

착수 순서 권고: **S1(KIPRIS, 독립·저마찰) → S2(registry 배치, 최고가치·키스톤) → S3(CODEF 확장, L1 게이트) → S4(매칭팀 계약 → 프로덕션 배선)**. S1·S2는 병렬 가능(의존 없음).

### Phase S1 — KIPRIS 커넥터 (`ip`)  〔마이그레이션 0 · 배치 없음〕

가장 자족적. 단일 조회 API. 착수 즉시 가능(키 발급만 선행).

1. **선행**: `KIPRIS_SERVICE_KEY` 발급(kipris.or.kr Plus, 문서상 미발급 — `manifest:93`). data.go.kr 공유키 체계와 별개 계정.
2. **커넥터** `packages/core/src/kipris/check-ip.ts` — 원본 미러 `smpp/check-certificates.ts`. 입력=상호(+대표자), 출력=특허/실용신안/상표 건수. 출원인명 퍼지(사업자번호 미포함 API라 상호 기반) → conf 0.55~0.6. fixture 테스트.
3. **dev 배선**: `runExternalConnectors`에 `runKiprisConnector` 추가 → `results.set("ip", …)`. 키 없으면 무결과(pending 유지) 패턴 준수(`runKcomwelConnector:979-980` 동형).
4. **검증**: dev `/dev/service-data`에서 `ip` 행이 라이브 전환. fixture 파서 단위 테스트.

**규모**: 소(single connector). **Opus 위임 적합**.

### Phase S2 — registry_index 배치 인프라 + 5 명단 (키스톤)  〔마이그레이션 1건〕

> **진행(2026-07-12)**: S2.0~S2.4 + S2.7 **완료·커밋**(`5cff976`·`eb20021`·`c97222a`). registry_index 마이그레이션(0043 운영 apply)·공용 인프라·조회 배선(runRegistryConnector)·제네릭 적재기(`scripts/registry/build.ts`)·CSV 어댑터 3종(조달청·중대재해·벤처확인, 57 테스트 통과)·인증 합집합 배선까지. 조달청 벌티컬 슬라이스(참여제한 known_on_absence) 완성. **잔여**: S2.5 체불·S2.6 TIPS(스크래핑, 아래 실측 발견 참조)·S2.3 나머지 인증 데이터셋. serviceData 오버레이는 S4 게이트로 미접촉.
>
> **소스 실측 발견(2026-07-12, data.go.kr/웹 확인)**:
> - 15137996 조달청 부정당: **사업자등록번호 포함**(정확 매칭 확정). 18컬럼 실측. ✅ 구현.
> - 15090150 중대재해: 11컬럼, 사업자번호·대표자 없음 → 상호+지역 퍼지. 명단 스냅샷(유효기간 없음). ✅ 구현.
> - 15084581 벤처확인: 13컬럼(업체명·대표자명(익명)·벤처확인유형·지역·유효시작/종료일). 사업자번호 없음. ✅ 구현.
> - **15090102 사회적기업 = 잘못된 데이터셋**: 개별 기업이 아니라 **연도별 집계 통계**(연도/신청/인증/현재유지)다. 개별 명단은 별도 "고용노동부_사회적기업 목록" 필요 → 데이터셋 id 재확인 요.
> - 3033893 혁신형중소기업(이노비즈/메인비즈): 사업자명·대표·업종·지역·유효기간. **이노비즈/메인비즈 구분 컬럼 불명확** → 실제 CSV 열람 후 매핑 확정 필요(구분 없으면 canonical 1개로 수렴 불가).
> - moel 체불사업주(A5): **정적 HTML 테이블**(성명·나이·사업장명·업종·주소지(사업주)·소재지(사업장)·체불액·구분(연도/차수)), 검색 없이 목록 노출·79페이지 페이지네이션. 스크래퍼는 실제 DOM(th/td/class) 캡처 후 fixture-first로 구현(개념 컬럼만으론 셀렉터 확정 불가). robots·ToS 확인 선행.
> - jointips TIPS(A6): companies.php **404** — 목록 엔드포인트/구조 미확인(JS 렌더 가능성). 정확한 소스 URL·구조 확인 필요.

설계 §6′-C의 "명단 일반화". A2~A6을 하나의 테이블·인프라로 흡수.

#### S2.0 마이그레이션 — `registry_index` 테이블

`apps/web/src/lib/server/db/schema.ts`에 신규 pgTable. `pnpm db:generate` → `db:migrate`(db:push 금지, generate에 기존 객체 재생성 섞이면 제거 — CLAUDE.md 마이그레이션 규칙).

컬럼(설계 §6′-C 기반):
- `registry_type` enum: `certification | sanction | investment`
- `flag_or_cert` text: 매핑 대상(예: `participation_restricted`, `벤처기업확인서`, `tips_backed`)
- `polarity` enum: `known_on_absence | present_only`
- `biz_no` text nullable, `corp_no` text nullable (정확 매칭용, 있을 때만)
- `name_normalized` text, `representative` text nullable, `region_sido` text nullable (퍼지 매칭용)
- `source` text(데이터셋 id), `source_fetched_at` timestamptz, `confidence` real
- 인덱스: `(biz_no)`, `(name_normalized)`, `(registry_type, flag_or_cert)`

#### S2.1 공용 배치 인프라 `packages/core/src/registry/`

- `download.ts` — data.go.kr fileData/CSV · 웹 스크래핑 소스별 fetch(어댑터 주입).
- `normalize.ts` — 상호 정규화(주식회사/㈜/공백/영문 통일), `CANONICAL_CERTS`(`certification/certs.ts:18-36`) 재사용.
- `fuzzy-match.ts` — 상호+대표자+시도 퍼지 스코어러(임계값·동점 처리). 사업자번호 있으면 정확 매칭 우선.
- `upsert.ts` — 소스별 전량 재적재(truncate-by-source 후 insert) 또는 증분.
- 실행기: `scripts/registry/build-<source>.ts`(tsx, 수동/크론). **갱신 주기는 문서 근거 없음 → 소스별 실측 후 확정**(체불·TIPS는 갱신지연 있음 — `sourcing.md:140`).

#### S2.2~S2.6 소스 어댑터 (우선순위 순)

| 순 | 어댑터 | 데이터셋 | 매칭 | polarity | 값 |
|---|---|---|---|---|---|
| S2.2 | 조달청 부정당(A2) | data.go.kr 15137996 CSV | **사업자번호 정확** | known_on_absence | `participation_restricted` |
| S2.3 | certification 공개명단(A3) | 15084581·3033893·15090102·KOITA | 상호+시도 퍼지 | present_only(0.55) | 각 확인서 |
| S2.4 | 중대재해(A4) | 15090150 `fileData.do` CSV | 상호 퍼지 | present_only | `serious_accident_listed` |
| S2.5 | 체불사업주(A5) | moel.go.kr 웹 | 상호+대표자+주소 퍼지 | present_only | `wage_arrears_listed` |
| S2.6 | TIPS(A6) | jointips.or.kr 웹 | 기업명 퍼지 | present_only(0.9) | `tips_backed` |

- **S2.2를 최우선**: 참여제한은 near-universal 결격 게이트이고, 유일하게 사업자번호 정확 매칭 + known-on-absence(부재 확정 → pass 근거)라 가치·정밀도가 가장 높다.
- **known-on-absence는 소진적 소스만**(§3.3): 조달청 CSV(A2)만 부재를 `known_flags`로 확정. 나머지 명단(A3~A6)은 **present-only** — 매칭 시 present만 신뢰, 부재는 자가신고 보완(false-clear 방지).

#### S2.7 dev 배선

`runExternalConnectors`에 `runRegistryConnector(bizNo, profile, results)` 추가 — registry_index를 조회해 매칭된 행의 flag/cert를 `results.set(key, …)`. present-only는 present일 때만 set(부재 시 무결과=pending 유지). 사업자번호 정확 매칭(A2) → 부재도 known 결과(부재 확정)로 set.

**규모**: 대(마이그레이션+인프라+5어댑터). **Opus 위임 · 어댑터 단위 분할**. 스크래핑(A5·A6)은 원천 변동 취약 → fixture 고정 + 실패 시 pending fail-open.

### Phase S3 — CODEF 상품 확장 (`insured_count`, 개인 `tax_compliance`)  〔CODEF L1 GO 게이트〕

CODEF passive 커넥터(`runCodefConnector`)는 이미 7축을 채우나 4대보험 명부·납세증명은 미커버(L2/L3 잔여 — `codef-Phase-B-C:7.5`).

1. **선행**: CODEF L1 스파이크 go/no-go 통과(개인 매출 커버리지 확인 — 설계 §6). 실계정 3종 승인(D1, 사용자 실행).
2. **A7 `insured_count`**: CODEF 4대보험 사업장 가입자명부 상품 추가 → `codef/` 파서 + `runCodefConnector`에 scope 추가 → `results.set("insured_workforce.insured_count", …)`. **주의**: 피보험자수 ≠ 상시근로자수(산정 근거법 상이 — `sourcing.md:145`), 별도 축으로 유지.
3. **A8 개인 `tax_compliance`**: CODEF 납세증명·지방세납세증명 상품 추가 → 개인사업자 결격의 유일 A/B층 경로(`sourcing.md:122`).

**규모**: 중. **CODEF Phase B/C 오케스트레이터 재사용**(세션·캐시 배선 완료).

### Phase S4 — 매칭팀 계약(§6′-E) → 프로덕션 오버레이 배선  〔전 Phase의 프로덕션 게이트〕

dev에서 검증된 소싱을 프로덕션 매칭에 넣는 유일한 관문. **코드보다 계약이 선행**.

1. **known_flags 소스맵 계약**: "소스→커버 플래그 맵"을 매칭팀 C1 "문항→플래그 맵"(확장 문서 §2.3)과 대칭으로 공유. 소스가 커버하는 flag만 known, 나머지는 문항이 커버(완전성 테스트 = 합집합).
2. **positive-only 예외 승인**: 소진적 소스(NICE 신용·조달청 CSV)만 known-on-absence 허용. 어떤 소스를 소진적으로 볼지 합의.
3. **프로덕션 배선**: `serviceData.ts:379-388` 오버레이 체인에 검증된 커넥터를 순서대로 삽입(base→SMPP→kcomwel→registry→[법인]금융위·NICE). fail-open·per-bizno 상한·캐시 가드(§3.4).
4. **FSC↔NICE 경합 해소**: 법인번호 브리지 경로에서 revenue/financial 키 경합(`Promise.all` 순서 의존) → 소스 우선순위 확정(FSC 무료 우선, NICE 폴백).
5. **confidence·원천 표기**: 자가신고 0.6 vs 소싱 0.85~0.9, 매칭 메시지에 원천 노출.

**규모**: 중(계약 합의가 임계경로). 매칭팀 동반 필수.

---

## 3. 선행 — 키·계정 발급 체크리스트

| 키/계정 | 대상 필드 | 상태 | 조치 |
|---|---|---|---|
| `KIPRIS_SERVICE_KEY` | A1 ip | **미발급** | kipris.or.kr Plus 발급(S1 선행) |
| data.go.kr 15137996(조달청 부정당) | A2 | 활용신청 필요 | 활용신청(파일데이터) |
| data.go.kr 15084581·3033893·15090102(인증 명단) | A3 | 활용신청 필요 | 활용신청(연간 CSV) |
| data.go.kr 15090150(중대재해 fileData) | A4 | 활용신청 필요 | `fileData.do` 다운로드(런타임 키 아님) |
| (moel 체불 웹 / jointips 웹) | A5·A6 | 키 없음(스크래핑) | robots·이용약관 확인 |
| CODEF 실계정 3종 | A7·A8 + 버킷B | **.env 준비·D1 미실행** | 사용자 간편인증 실행 |
| NICE 실계약 | 버킷B(법인 결격) | 무계약 데모 | 단가 견적 → 계약(unit-economics 게이트) |

- data.go.kr는 계정당 인증키 1개 공유(`CUNOTE_DATA_GO_KR_SERVICE_KEY` 우선 → 소스별 폴백, `dataGoKrServiceKey.ts`). 신규 데이터셋은 활용신청만 추가.

## 4. 마이그레이션·검증·작업체계

- **마이그레이션**: 필수 **1건**(`registry_index`, S2.0). KIPRIS·CODEF는 `company_enrichment_cache` free-text 재활용으로 불필요. `pnpm db:generate`→`db:migrate` 순서 준수.
- **검증**: 각 Phase는 dev `/dev/service-data`에서 해당 필드가 pending→live 전환됨을 확인(하네스가 검증 무대). 커넥터는 fixture 파서 단위 테스트. 스크래핑은 실패 시 pending fail-open(흐름 미파괴).
- **작업체계**(CLAUDE.md): 구현 대량작업 Opus 위임, 메인(Fable) 설계·검수. git 쓰기 전 stale-lock 처리. 관문 착수 전 `docs/research/CALIBRATION-TEMPLATE.md` 외부 대조.

## 5. 요약 — 한 줄

지금 채워야 하는데 소싱 코드가 없는 필드는 **8개**(ip · 참여제한 · 인증 공개명단 · 중대재해 · 체불 · TIPS · 피보험자수 · 개인 납세). 이 중 6개(참여제한·인증·중대재해·체불·TIPS)는 **`registry_index` 배치 인프라 1벌 + 어댑터 5개**로 흡수되고, ip는 **KIPRIS 단일 커넥터**, 나머지 2개는 **CODEF 상품 확장**이다. 전부 **dev 하네스에 먼저 배선**하고, 프로덕션 매칭 진입은 **매칭팀 known_flags 소스맵 계약(S4)** 이후로 게이트한다.
