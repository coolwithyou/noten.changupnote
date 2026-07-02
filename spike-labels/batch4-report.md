# Gate 1 필드맵 라벨링 배치 4 리포트 (PDF/DOCX 잔여 샘플)

작성: opus-prelabel · 2026-07-02
대상: 14개 문서 (doc41~doc50 PDF 10 + doc51~doc54 Word 4) 사전 라벨링
기준서: `docs/gate1-field-map-labeling-guide.md` (golden_ver `field_map_v0`)
선행: 파일럿 5 + 배치2 10 + 배치3 16 = 31문서(HWP/HWPX 계열). 본 배치는 PDF/DOCX/DOC 포맷 계열.
샘플/manifest: `spike-samples3/` (files + manifest.csv)

> 본 산출물은 사전 라벨(pre-label)이다. 확신 없는 판정은 각 필드 `notes`에 "확인 필요:"로 표기했으며 사람 검수로 확정한다. 기준서 확정 규칙 1~9를 전부 적용했다.

## 0. 수집 결과 (교체 사유 포함)

DB `grant_attachment_archives`에서 작성형 양식 후보를 확장자별로 조회했다.

| 확장자 | 아카이브 전체 보유 | 작성형 양식 후보 | 확정 |
|--------|------------------|----------------|------|
| PDF | 398건(bytes≥10k) | 51건(키워드 필터) | **10건** |
| DOCX | **3건 (전체)** | 3건 | 3건 |
| DOC (레거시) | **1건 (전체)** | 1건 | 1건 |

### PDF 10건 (doc41~50)
공고당 1건 · sha256 중복 제거 · 파일명 정규화 중복 제거로 20건 선별 후, 첫 페이지 렌더 육안 검수로 작성형 확정한 상위 10건을 채택. 양식 유형 다양성(융자/시험수수료/입점/인증/투자/영화/기술혁신/고용보험/사회적기업/반도체) 우선.
- **교체 1건**: 후보 `pdf15 참여신청전산메뉴얼.pdf`(2026 청년일자리 도약장려금, PBLN_...119137)는 첫 페이지가 **참여신청서 처리 절차 순서도(안내 매뉴얼)** 로, 작성형 양식이 아니라 후보에서 제외. → 다음 순위인 사회적기업/반도체 서식으로 대체.
- 근접 유사템플릿 `pdf09 생물학적 시험평가인증` / `pdf12 GLP 시험평가인증`은 동일 기관 계열이나 서로 다른 공고·sha256 → 다양성상 문제없으나 최종 10건에는 pdf09(=doc 미채택)·pdf12(미채택) 대신 유형 겹침 회피 위해 둘 다 최종 세트에서 제외하고 다른 유형 우선 채택.

### Word 4건 (doc51~54) — **하드 데이터 한계: 목표 미달**
- **아카이브 전체에 DOCX가 3건, 레거시 DOC가 1건뿐**이다. 지시한 "DOCX 양식 10건"은 원천 데이터가 존재하지 않아 물리적으로 불가능하다. 확보 가능한 Word 계열 4건을 전부 채택:
  - doc51: 특별귀화 추천 신청(한/영 병기 제출용 서식) — DOCX
  - doc52: 연구실 안전관리 컨설팅 신청양식 — DOCX
  - doc53: 충남 수출입보험료 지원(공고문+【서식1~4】 합본) — DOCX (공고문 프리픽스 뒤에 실제 작성 서식 4종 포함, 작성형 확정)
  - doc54: 서울제로마켓 보조금 지원신청서+사업계획서 — 레거시 DOC (.doc)
- **doc55~doc60은 산출 불가**: DOCX/DOC 원본 부재. 이 부분은 사용자 결정 필요(§6 참조).
- **doc54 공고 중복 주의**: PBLN_...123336은 batch3 doc16에서 HWP 버전으로 이미 라벨된 **동일 공고**의 .doc 포맷 인스턴스다(해당 필드 notes 및 §5에 명시). 포맷 다양성 확보 목적상 채택했으나 공고 단위로는 중복.

## 1. 문서별 필드 수 요약

| doc | 문서명(요약) | 포맷 | pageCount | 필드 | manual | applicantFills=F | 필드 없는 페이지 |
|-----|------------|------|-----------|------|--------|------------------|----------------|
| doc41 | 관악 중소기업육성기금 융자신청서+사업계획서+동의서 | PDF | 9 | 40 | 4 | 1 | p8하단(유의사항·작성요령 안내) |
| doc42 | 부천 유해물질 시험분석 수수료 지원 신청서 | PDF | 1 | 14 | 2 | 1 | 없음 |
| doc43 | 강릉 수출기업 홍보 웹사이트 입점 신청서+제품설명서 | PDF | 3 | 30 | 5 | 0 | 없음 |
| doc44 | 울산 산업안전보건 국제표준 인증 신청서+동의서+청구서 | PDF | 5 | 32 | 6 | 1 | 없음 |
| doc45 | 경남투자청 투자유치 원스톱(FDI/국내 배타서식)+동의서 | PDF | 3 | 60 | 2 | 1 | 없음 |
| doc46 | 제주 다양성영화 인프라 활용 지원신청서+결과보고서 | PDF | 5 | 31 | 4 | 0 | p3(첨부 지시 제목), p5(활용사진 첨부 지시 제목) → file 필드로 흡수 |
| doc47 | 기술·경영혁신 인증지원 신청서+계획서+확약서+동의서+적정성확인서 | PDF | 9 | 32 | 6 | 2 | 없음 |
| doc48 | 충남 1인 자영업자 고용보험료 신청서+동의서+위임장 | PDF | 3 | 25 | 10 | 0 | 없음 |
| doc49 | 보건복지형 예비사회적기업 지정신청서+계획서+사실확인서(배타)+명부+동의서 | PDF | 13 | 39 | 11 | 2 | p1(서류목록 목차 표지) |
| doc50 | 지능형 반도체 시험분석 지원신청서+계획서+동의서+적정성확인서 | PDF | 9 | 25 | 5 | 2 | p8(동의 약관 본문만, 서명·표는 p7) |
| doc51 | 특별귀화 추천 신청(한/영 병기 제출용) | DOCX | 14 | 21 | 6 | 0 | p1~2(정보성 기본요건/증빙 안내표) |
| doc52 | 연구실 안전관리 컨설팅 신청양식 | DOCX | 4 | 16 | 2 | 0 | p4(도면 삽입 빈칸+안내문) |
| doc53 | 충남 수출입보험료 지원(공고문+서식1~4 합본) | DOCX | 12 | 14 | 4 | 0 | p1~4(공고문), p7(상품안내문) |
| doc54 | 서울제로마켓 보조금 지원신청서+사업계획서+동의서 (.doc) | DOC | 6 | 19 | 4 | 0 | 없음 |
| **합계** | | | **96** | **398** | **71** | **13** | |

## 2. manual 필드 분포 (총 71개)
- **서명/날인**: 각 서식 말미 신청인·대표자 서명행. 다중 서식 묶음(doc47·doc49·doc48)에서 서식별 반복 인스턴스(확정 규칙 4·2). doc48이 10건으로 최다(신청서+동의2건+위임장 서명2건+부정수급 확약 체크+위임 동의 체크 등 밀집).
- **동의/서약 체크·서명**: 개인정보 수집·이용/제3자 제공, 통합관리시스템, 부정수급 확약(doc48), 준수확인서(doc49), 적정성확인서(doc47·doc50). 체크박스 없는 동의문+서명은 signature 1필드(확정 규칙 7).
- **자격 자가확인표**: 적정성확인서/사실확인서의 서약성 자가체크는 manual=true(확정 규칙 8). eligibility_check_table·fact_confirm_signature·compliance_signature.
- **고유식별정보 직접 기입**: doc49 붙임10 동의서 주민등록번호란(consent_resident_no, 규칙1 manual). 반대로 doc49 붙임8 유급근로자 명부는 생년월일만·주민번호 없음 → manual=false. doc51 특별귀화는 여권/외국인등록번호가 수집항목 나열에만 있고 직접 기입란 없음 → 필드 manual 없음.
- **이미지 삽입란**: doc43 상품사진·doc46 활용사진·doc51 사진란·doc52 도면 → file+manual(배치2 3-F 관행), notes "확인 필요".
- **첨부서류 목록**: 통합 1개 `attachments` file manual=true.

## 3. HWP 대비 PDF/DOCX 구조 차이 관찰 (핵심)

### 3-A. PDF (doc41~50) — 전부 flat print form, **AcroForm 필드 0**
- 조사한 10개 PDF **전부 pypdf `get_fields()` 결과 0개**. 즉 자동채움 가능한 form field(AcroForm)가 하나도 없고, 빈 셀·밑줄·□ 글리프로만 작성란을 표현하는 **인쇄용 평면 PDF**다.
- **자동채움 경로 함의**: HWP와 마찬가지로 PDF도 구조적 필드 앵커가 없어, 좌표/OCR 기반 오버레이 또는 HWP·DOCX 원본 역추적이 필요. AcroForm이 있었다면 필드명 직결 매핑이 가능했을 텐데 부재. → Gate 2 자동채움 설계 시 "PDF도 HWP와 동일하게 무구조 렌더로 취급" 전제 확정.
- **예시 프리필 광범위**: doc44·doc45·doc46·doc50은 파란/회색 예시값이 표 전반에 프리필(㈜000, 123-45-67890, 예시 서술 등). 라벨 값으로 오인 금지 — notes에 프리필 명시. HWP 계열보다 예시 프리필 비중이 체감상 높음(특히 doc50 반도체는 전 표 프리필).

### 3-B. DOCX/DOC (doc51~54) — LibreOffice(Word→PDF) 렌더 관찰
- **표 재현도 양호**: 표 그리드·병합셀·점선 내부선(doc51 인적표)·음영 헤더 셀(파랑/회색)이 깨끗하게 렌더. 복합 중첩 예산표(doc54 서식3, p3→p4 걸침)도 구조 보존.
- **체크박스**: 폼 컨트롤이 아니라 리터럴 `[ ]`/`□` 글리프로 렌더 → 옵션 판독은 오히려 일부 HWP 음영 체크박스보다 쉬움.
- **예시 프리필 식별 용이**: 이탤릭 회색으로 렌더(doc52·doc54)되어 필드 라벨과 명확히 구분.
- **페이지 분할이 원본 Word와 다를 수 있음**: LibreOffice가 섹션을 원본과 다른 지점에서 분할 → 표·서명행이 페이지 경계에 걸침(doc51 인적표 p4↔p5, doc52 서명행 p1↔p2, doc54 산출내역표 p3↔p4). 필드 page는 라벨 앵커 기준 페이지로 기록하고 notes에 걸침 표기. **주의**: 이 배치의 DOCX pageCount는 LibreOffice 렌더 기준이라 native Word 페이지 수와 다를 수 있음(향후 변환 서버가 LibreOffice 경로면 일관됨 — Gate 0에서 LibreOffice+H2Orestart 확정과 정합).
- **공고문+양식 합본(doc53)**: 앞 4페이지가 순수 공고문, 이후 【서식1~4】가 실제 작성 서식. 한 파일에 공고·양식 혼재 → 수집 필터에서 "공고문" 파일명이라도 내부에 양식 포함 가능(doc53은 파일명이 "공고문"이나 작성형). 향후 수집 파이프라인은 파일명만으로 양식/공고 판별 불가 — 내부 서식 마커(【서식N】) 탐지 필요.

## 4. 신규 표준 key 사전 승격 후보

기존 사전(배치1~3) 재사용을 우선했고, 없던 것만 신규 사용. 재사용도 높은 순 검수 후 승격 판단.

| key | 의미 | 등장 문서 |
|---|---|---|
| fund_type / fund_request_table / fund_source_table / operating_fund_table / facility_fund_table | 융자자금 구분/신청·조달·운전·시설 자금 표 | doc41 |
| collateral_method / collateral_detail_table / loan_repayment_table / loan_bank | 담보제공방법/담보물표/상환현황/대출은행 | doc41 |
| company_history_table / ceo_career_table / asset_detail_table / foreign_earning_table / ip_holdings | 기업연혁/대표자경력/자산내역/외화가득/지재권보유 | doc41 |
| test_report_count / test_report_table / test_reason / support_amount | 시험성적서 수·표/시험사유/지원금 | doc42 |
| shelf_life / export_unit_price / consumer_unit_price / hs_code / storage_method / export_amount_table | 유통기한/수출·소비자단가/HS코드/보관방법/수출액표 | doc43 |
| fax_no / cert_institution / cert_date / review_period / review_cost_table / claim_* / improvement_content / suggestion | 팩스/인증기관·일자/심사기간·비용표/청구계열/개선내용/제안 | doc44 |
| ceo_name_ko / ceo_name_en / ceo_nationality / ceo_gender / visa_type / visa_expiration_date / ceo_age_group / applicant_* / invest_amount / capital / listing_status / referral_path | FDI 외국인 대표자·신청자·투자·자본·상장·경로 | doc45, doc51 |
| work_* / running_time / producer_info_table / individual_info_table / main_crew_table / utilization_purpose / future_plan / *_career_table / utilization_photo / result_* | 영화 작품·제작진·활용·결과보고 계열 | doc46 |
| consulting_request / consulting_past_year / current_certifications / ip_status_table / rep_tech_info_table / tech_differentiation_table / business_model | 컨설팅 신청/기수혜/보유인증/지재권·대표기술·차별성표/BM | doc47 |
| employment_insurance_no / insurance_join_date / bank_account_table / fraud_pledge_check / fraud_pledge_signature / delegator_* / delegatee_* | 고용보험번호/가입일/계좌표/부정수급확약/위임장 계열 | doc48 |
| org_type / designation_type / certification_requirement_plan_table / beneficiary_status_table / worker_status_table / regional_contribution_table / mixed_type_table / paid_worker_roster_table / labor_law_compliance_table / compliance_signature / nurturing_participation | 예비사회적기업 유형·인증계획·수혜·근로자·지역기여·근로자명부·준수 계열 | doc49 |
| company_scale_table / priority_check / test_target_content / test_institution / test_plan_table / budget_product_detail_table / consent_info_use_signature | 반도체 시험 규모·우선순위·대상·기관·계획·예산·동의 계열 | doc50 |
| applicant_photo / personal_info_table / education_table / research_achievement_table / patent_table / national_contribution_plan / settlement_intent / recommender_signature / recommend_date | 특별귀화 사진·인적·학력·연구실적·특허·국익기여·정착·추천인 서명 | doc51 |
| lab_info_table / main_research_field / safety_mgmt_status / lab_photos / koita_researcher_count / etc_request | 연구실 정보·분야·안전현황·사진·연구원수·기타요청 | doc52 |
| export_revenue_table / support_target / insurance_company_info_table / insurance_consent_signature / consent_integrated_system | 수출실적·지원대상·보험사정보·보험동의·통합시스템 동의 | doc53 |

**주의(key 일관성, §검수 필요)**:
- **인적 블록 통합 vs 분해**: `contact_person_table` / `manager_profile_table` / `staff_profile_table` / `personal_info_table` 계열이 문서마다 통합/분해 혼재(배치2 3-C 미결과 동일). doc45는 항목 분해(ceo_name_ko 등), doc51은 표 통합(personal_info_table). 검수 시 일괄 정책 확정.
- **사업비/성과 표군**: `budget_table` / `budget_detail_table` / `budget_summary_table` / `budget_product_detail_table` / `review_cost_table` / `claim_cost_table` 난립. canonical `budget_table` 지정 규칙 필요(배치3 4절 잔존 과제).
- **동의/서명 계열**: `consent_privacy_use` / `consent_privacy_thirdparty` / `consent_signature` / `consent_resident_no` / `consent_integrated_system` / `insurance_consent_signature` — doc10/11 계열 재사용 유지.
- **자격/사실확인 서명군**: `eligibility_check_table` / `eligibility_signature` / `fact_confirm_signature` / `compliance_signature` / `fraud_pledge_signature` — 서약성 서명 계열 canonical 통일 검수.

## 5. 규칙 1~9 적용 사례 요약
- **규칙 1(고유식별정보 manual 한정)**: doc49 붙임10 주민번호란(consent_resident_no) manual=true. 붙임8 명부(생년월일만) manual=false. doc51 여권/외국인등록번호는 직접 기입란 부재로 필드 manual 없음.
- **규칙 2(배타/반복 서식 key 인스턴스)**: doc45 FDI(p1)/국내(p2) 배타 서식 — 같은 key p1·p2 반복(필드 60개 원인). doc49 붙임3~7 사실확인서 배타 — fact_confirm_signature 5회 인스턴스. doc51 한/영 병기 서식은 한국어 제출용을 인스턴스로 라벨, 영문 병렬은 notes 기록.
- **규칙 4(말미 서명행 signature 강제)**: 다중 서식 묶음(doc41·44·47·48·49·50·53·54) 서식별 말미 서명행 전부 signature manual=true. doc50 '날인불필요' 표기 서명행도 규칙4로 signature 유지(notes 표기).
- **규칙 7(체크박스 없는 동의문+서명 = signature 1필드)**: doc44 개인정보 동의서, doc47·50 정보이용 동의서, doc53 서식3/4 '법인인감 날인'.
- **규칙 8(자격 자가확인표 서약성 manual)**: doc47·50 적정성확인서, doc48 부정수급 확약, doc49 준수확인서.
- **규칙 9(겸용 셀 주 용도 key)**: doc41 대표자 성명/생년월일 겸용 블록, 이메일/홈페이지 겸용 블록 — 우세 성격 key + notes 병기.

## 6. 배치 4 총평 및 검수 최우선

- **총계**: 14문서 · **96 페이지 · 398 필드 · 71 manual · applicantFills:false 13개**. 스키마 검증 14파일 전부 valid JSON, 10-key 스키마 위반 0, type 위반 0.
- **누적 진행**: 파일럿 5 + 배치2 10 + 배치3 16 + 배치4 14 = **45문서 완료**.
- **⚠️ DOCX 수집 목표 미달(하드 한계)**: 지시는 "PDF 10 + DOCX 10"이나, 아카이브 전체 DOCX 3 + DOC 1 = **Word 계열 4건이 상한**이다. PDF 10은 목표 달성, Word는 4/10만 가능. **사용자 결정 필요**: (a) Word 목표를 4건으로 하향 확정, (b) HWPX(구조상 XML 기반으로 DOCX와 유사)로 잔여 6건 대체, (c) 향후 아카이브에 DOCX가 추가 수집되면 doc55~60 별도 배치. → 현재 PoC 55개 목표(HWP 30 + PDF 10 + DOCX 10 + 웹폼 5) 중 DOCX 슬롯은 원천 데이터 제약으로 재조정 불가피.
- **PDF/DOCX 구조 핵심 발견**: 10개 PDF 전부 **AcroForm 0** — PDF도 HWP와 동일한 무구조 렌더로 취급해야 하며, 자동채움에 활용할 form field 앵커가 없음. 향후 자동채움 경로 설계의 중요 입력.
- **검수 최우선**: (1) DOCX 슬롯 목표 재조정 사용자 결정(§6), (2) 인적 블록 통합/분해 정책 확정(§4, 배치2 3-C 미결), (3) 사업비/성과 표군 canonical key 통일(§4, 배치3 4절 잔존), (4) doc45 FDI/국내 배타서식 60필드 인스턴스 매칭 검수, (5) doc54 공고 중복(batch3 doc16과 동일 공고) 처리 방침.
