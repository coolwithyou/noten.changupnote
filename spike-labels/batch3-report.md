# Gate 1 필드맵 라벨링 배치 3 리포트

작성: opus-prelabel · 2026-07-02
대상: 16개 문서 (doc13, doc14, doc15, doc16, doc17, doc18, doc19, doc20, doc21, doc22, doc24, doc25, doc26, doc27, doc28, doc30) 사전 라벨링
기준서: `docs/gate1-field-map-labeling-guide.md` (golden_ver `field_map_v0`)
선행: 파일럿 5개(`pilot-report.md`) + 배치 2 10개(`batch2-report.md`) — 도합 15문서(doc01~12, 23, 29, 31) 완료

> 본 산출물은 사전 라벨(pre-label)이다. 확신 없는 판정은 각 필드 `notes`에 "확인 필요:"로 표기했으며 사람 검수로 확정한다. 기준서 확정 규칙 1~6(민감정보 manual 한정, 배타/반복 서식 key 인스턴스 매칭, 계층 체크박스 대분류 분리, 말미 서명행 signature 강제, manual은 고유식별정보/서명/동의체크·서약/파일첨부에 한정, 표 key `_table` 접미어)을 전부 적용했다.

## 1. 문서별 필드 수 요약

| doc | 문서명(요약) | 소스 | pageCount | 필드 수 | manual | 필드 없는 페이지 |
|-----|------------|------|-----------|--------|--------|----------------|
| doc13 | 강원 바이오기업 애로해소 인허가 컨설팅 신청서+사업계획서 (서식1~5) | bizinfo:PBLN_000000000121397 | 12 | 53 | 8 | p8(동의서 안내문), p11(서식4 표지 제목만) |
| doc14 | 세종 EMS 해외물류비 사업신청서+계획서 (서식1~2) | bizinfo:PBLN_000000000121756 | 4 | 23 | 1 | p1(신청서 표지 제목), p3(계획서 표지 제목) |
| doc15 | 춘천 푸드테크 전시참가 지원신청서+계획서 (양식1~2) | bizinfo:PBLN_000000000122778 | 3 | 30 | 2 | p2(각주 잔여 "있음." 한 단어만) |
| doc16 | 서울제로마켓 활성화 지원신청서+사업계획서 | bizinfo:PBLN_000000000123336 | 6 | 36 | 4 | p5(서식4 표지 제목만) |
| doc17 | 대구 지역주력산업육성(레전드50+) 신청서+상세계획서 | bizinfo:PBLN_000000000123455 | 15 | 46 | 4 | p4(공백), p7(작성요령 안내), p15(장관 귀하 수신처만) |
| doc18 | 광주 OpenLAB 에너지신산업 기업지원 신청서+계획서 | bizinfo:PBLN_000000000123468 | 11 | 49 | 6 | p1(양식1 표지 제목만) |
| doc19 | 서대구산단 입주기업 수요맞춤형 지원 신청서+계획서 | bizinfo:PBLN_000000000123477 | 5 | 27 | 3 | 없음 (5쪽 전부 필드) |
| doc20 | 문화산업 완성보증 신청서+사업계획서 | bizinfo:PBLN_000000000123515 | 9 | 44 | 1 | p2(진흥원장 귀하 수신처만) |
| doc21 | 울산 수소산업 기술지원 신청서+시제품제작 계획서 (붙임12) | bizinfo:PBLN_000000000123618 | 7 | 35 | 3 | p4(섹션 헤더 "3.사업내용"만) |
| doc22 | 울산 소규모사업장 노후 안전시설 신청서+과제계획서 (서식1~5) | bizinfo:PBLN_000000000123647 | 14 | 47 | 9 | p12(서식4 표지 제목만) |
| doc24 | 진주 GAP 안전성 분석 신청서+개인정보제공동의서 | bizinfo:PBLN_000000000117269 | 3 | 15 | 5 | p3(완전 공백) |
| doc25 | 용인 통번역 서포터즈 배정 신청서+서약서 | bizinfo:PBLN_000000000118003 | 3 | 20 | 4 | p2(서약서 본문만, 서명은 p3) |
| doc26 | 지스타 경북 딥테크 부스터 참여신청서+동의서 | bizinfo:PBLN_000000000118910 | 3 | 29 | 6 | 없음 |
| doc27 | 전남 소상공인 상표출원 지원 신청서+동의서 (예시 양식) | bizinfo:PBLN_000000000119375 | 2 | 21 | 4 | 없음 (예시 프리필 다수) |
| doc28 | 광주 창업BuS 참가신청서+개인정보 이용동의서 | bizinfo:PBLN_000000000119817 | 3 | 27 | 6 | 없음 (p3 주민번호+서명) |
| doc30 | 부산 지역기업 온라인 입점지원 신청서식+동의서 | bizinfo:PBLN_000000000121635 | 7 | 28 | 6 | p3(p1 작성예시 재출력, 비라벨), p7(완전 공백) |
| **합계** | | | **107** | **530** | **72** | |

### 순수 안내/공백/표지 페이지 총평
- **완전 공백**: doc17 p4, doc24 p3, doc30 p7.
- **수신처(귀하/귀중) 한 줄만**: doc17 p15, doc20 p2.
- **표지/서식 제목만**: doc13 p11, doc14 p1·p3, doc16 p5, doc18 p1, doc22 p12.
- **안내문/작성요령/서약 본문만(실제 체크·서명은 다음 페이지)**: doc13 p8, doc17 p7, doc25 p2.
- **섹션 헤더만**: doc21 p4.
- **작성예시 재출력(별도 서식 아님)**: doc30 p3.
- **각주 잔여**: doc15 p2("있음." 한 단어).

## 2. manual 필드 분포 (총 72개)

- **서명/날인/직인**: 각 문서 신청서·계획서·서약서·동의서 말미의 대표자/신청인/기술책임자 서명행. 확정 규칙 4에 따라 말미 서명행을 전부 signature(manual=true)로 강제. doc22(서식 5종)·doc13(서식 5종)에 반복 누적.
- **동의/서약 체크**: 개인정보 수집·이용, 제3자 제공, 준수사항 서약, 통합관리시스템 동의 등(확정 규칙 5). consent_* 계열 key는 doc10/doc11 재사용.
- **증빙 파일 첨부 지시**: 첨부서류 목록을 통합 1개 `attachments` file 필드(manual=true)로 처리(파일럿 3-A 관행).
- **이미지 삽입란**: doc22 현장사진(`site_photo`), doc26 기업로고(`company_logo`), doc30 상품이미지(`product_image`) — 도면·사진 직접 삽입은 file+manual로 처리(배치2 3-F 관행). notes에 "확인 필요".
- **고유식별정보(주민등록번호) 직접 기입**: 확정 규칙 1 적용. doc17 참여자 인적사항표(주민번호+자필서명, table+manual), doc28 개인정보동의서 주민등록번호란(`consent_resident_no`, manual=true). 그 외 생년월일·성명·연락처·사업자번호는 일반 개인정보로 manual=false.

doc22(9)·doc13(8)이 manual 최다 — 다중 서식 묶음이라 서식별 서명·동의가 반복 누적.

## 3. 신규 애매 케이스 (기준서 확정 규칙 1~6으로 커버 안 되는 것만)

배치 1·2에서 이미 후보로 올린 케이스(예시 프리필 셀 카운팅 3-E, 인적 블록 다값 필드 단위 3-C·3-E, 도면/이미지 삽입 file 유형 3-F, 조건부 서식 required 3-B)는 이번에도 동일 관행으로 처리했으므로 재보고에서 제외한다. 아래는 이번 배치에서 새로 관찰된, 확정 규칙으로 판정이 안 서는 것만 정리한다.

### 3-A. 체크박스가 없는 동의문/서약문의 필드 유형 (doc25 서약 동의문, doc30 서식3 통합관리시스템 동의문)
확정 규칙 5는 "동의 체크 **또는** 서명"을 묶어 manual로 본다. 그러나 doc25/doc30 일부 동의문은 `[동의함]` 체크박스 없이 "위 내용에 동의합니다" 서술문 + 하단 서명만 존재한다. 이때 필드를 `checkbox`로 잡을지 `signature`로 잡을지 기준이 없다.
- 본 배치는 **동의 의사 표현이 서명으로 귀결되면 signature 1필드**, **명시 옵션이 있으면 checkbox**로 처리하되 notes에 "확인 필요" 표기.
- **제안**: "동의·서약문에 체크박스가 없고 서명만 있으면 signature(manual=true) 1필드로 라벨한다"를 규칙에 명문화.

### 3-B. 자격 자가진단/체크리스트 표의 manual 등급 (doc22 p10 자격확인 체크표, doc13 적정성확인서)
신청자가 "기본요건 충족 / 결격사유 미해당"을 스스로 체크·확인하는 표다. 서약성(자격 확약)으로 보면 manual=true, 단순 정보 표기로 보면 manual=false다.
- 본 배치는 **자격 확약 성격이면 manual=true**로 보수적 처리(notes 명시). doc22 `eligibility_check_table`, doc13 `eligibility_check_table`.
- **제안**: "자격 요건 자가확인/자가진단 표는 서약성 여부로 manual을 가른다 — 서명·확약 문구가 붙으면 manual=true, 순수 정보 확인이면 false"를 사례집에 추가.

### 3-C. 생년월일·사업자번호 겸용 단일 셀 (doc24 "생년월일(사업자등록번호)")
한 셀이 개인이면 생년월일(확정 규칙 1상 manual=false), 사업자면 사업자등록번호(일반, manual=false)로 겸용된다. 두 값 다 manual=false로 귀결되므로 판정 자체는 안전하나, **key를 `birth_date`로 둘지 `biz_reg_no`로 둘지** 겸용란 명명 규칙이 없다.
- 본 배치는 대표 성격(개인사업자 통념)에 따라 `birth_date` + notes "사업자번호 겸용"으로 처리.
- **제안**: 겸용란은 우세 성격 key + notes 병기로 통일. manual은 두 성격 모두 false이므로 영향 없음.

### 3-D. 옵션이 비어 있는 체크박스 셀 (doc28 창업구분·주요기술구분)
양식에 대분류 라벨만 있고 선택지 셀이 비어 있어 options를 특정할 수 없다(HWP 원본에 드롭다운/후속 옵션표가 있을 가능성).
- 본 배치는 `checkbox`로 라벨하되 options 미상, notes에 "확인 필요: 옵션 원본 확인" 표기.
- **제안**: 렌더 이미지만으로 옵션을 못 읽는 체크박스는 type=checkbox 유지 + notes에 옵션 미상 명시(unknown 남발 금지).

## 4. 신규 표준 key 사전 승격 후보

파일럿·배치2 사전에 없던, 이번 배치에서 신규 사용한 key. 재사용도 높은 순으로 검수 후 승격 판단.

| key | 의미 | 등장 문서 |
|---|---|---|
| region / support_program | 지역 / 지원(세부)사업명 | doc13, doc15, doc17 |
| research_institute | 연구기관/수행기관 | doc13 |
| model_name / product_item / sub_product | 모델명/품목/부품목 | doc13, doc21 |
| support_scope / support_type / support_items_table | 지원범위/지원유형/지원항목 표 | doc13, doc19 |
| utilization_plan | 활용계획 | doc13, doc18 |
| expected_sales_table / sales_forecast_table / revenue_table | 예상매출/매출전망/매출 표 | doc13, doc19, doc20 |
| expected_employment_table / employment_status_table | 예상고용/고용현황 표 | doc13 |
| ripple_effect / business_growth / market_competition | 파급효과/사업성장성/시장경쟁 | doc13 |
| eligibility_check_table / eligibility_signature | 자격 자가확인 표/서명 | doc13, doc22 |
| consent_signature / consent_date | 동의서 서명/일자 | doc13, doc19, doc26 |
| consent_personnel_table | 동의(주민번호+자필서명) 인적표 | doc13, doc17, doc22 |
| export_amount / export_item / export_stage | 수출액/수출품목/수출단계 | doc14 |
| logistics_shipping_table / shipping_product_info / shipping_purpose | 물류·발송 표/발송품 정보/목적 | doc14 |
| disaster_damage_type | 재해피해 유형 | doc14 |
| main_business_field / business_field | 주요 사업분야 | doc15, doc26 |
| desired_exhibition / participant_table | 희망 전시/참가자 표 | doc15 |
| past_support_table / gov_support_table / gov_support_history_table | 기 정부지원 이력 표 | doc13, doc15, doc22, doc26 |
| application_field / apply_program / apply_content_check | 신청분야/신청프로그램/신청내용 체크 | doc16, doc18 |
| sales_channel / open_market_channel / mail_order_no | 판매채널/오픈마켓/통신판매번호 | doc16, doc30 |
| subsidy_revocation | 보조금 교부결정 취소내역 | doc16 |
| budget_summary_table / budget_detail_table / project_content_table | 사업비 요약·세부·내용 표 | doc16, doc18, doc22 |
| receipt_no / receipt_date | 접수번호/접수일자 (기관기입, applicantFills:false) | doc17, doc27 |
| manager_profile_table / staff_profile_table / participant_personnel_table | 책임자/참여인력/참여자 인적 표 | doc17, doc20 |
| product_tech_table / progress_status_table | 제품기술/진행현황 표 | doc17, doc20 |
| qualitative_goal / quantitative_goal_table / qualitative_effect / quantitative_effect_table | 정성·정량 목표/효과 | doc17 |
| participant_resident_no_table / consent_resident_no | 참여자 주민번호 표 / 동의서 주민번호란 (manual=true) | doc17, doc28 |
| integrity_pledge_signature / contribution_pledge_signature / data_pledge_signature / pledge_signature | 청렴/출자/자료제공/서약 서명 | doc17, doc18, doc25 |
| location_type / tenant_location / relocation_target | 입지유형/입주위치/이전대상 | doc18, doc19, doc26 |
| research_org_type / institution_type | 수행기관 유형 | doc18 |
| performance_goal_table / performance_effect_table / exec_result_table / exec_schedule_table | 성과목표·효과/추진실적·일정 표 | doc18 |
| contribution_summary_table / contribution_detail_table | 기업부담금 요약·세부 표 | doc18 |
| necessity / application_content / application_reason | 필요성/신청내용/신청사유 | doc19, doc25, doc27 |
| final_goal_table / performance_usage_table | 최종목표/성과활용 표 | doc19 |
| total_budget_table / total_project_cost_table / total_production_cost | 총사업비/총제작비 표 | doc19, doc20 |
| presale_contract_table / content_field / content_name / content_plan_summary / content_intro | 선판매계약/콘텐츠 분야·명·계획·소개 | doc20 |
| self_check_table / certification_award_table | 자가점검/인증·수상 표 | doc20 |
| company_competitiveness / development_goal / production_funding_plan / marketing_plan / market_analysis | 경쟁력/개발목표/제작자금/마케팅/시장분석 | doc20 |
| project_execution_system / main_content | 사업추진체계/주요내용 | doc20 |
| loan_amount_detail_table / repayment_plan_table / repayment_plan_basis | 대출금액 세부/상환계획 표·근거 | doc20 |
| debt_ratio / execution_plan / contact_dept_position | 부채비율/추진계획/담당부서·직위 | doc21 |
| cover_* (project_period / project_cost / target_company / ceo_signature / manager_signature) | 계획서 표지 기입·서명 계열 | doc21 |
| accident_history / support_budget_table / facility_status_problem / site_photo | 재해이력/지원예산 표/시설현황문제/현장사진 | doc22 |
| ceo_birth_date / ceo_specialty / ceo_contact / ceo_email | 대표자 생년월일/전문분야/연락처/이메일 | doc22, doc26 |
| achievement_goal / detail_strategy / role_assignment_table / tech_goal_table | 성과목표/세부전략/역할분담·기술목표 표 | doc22 |
| document_checklist_table | 제출서류 체크리스트 표 | doc22 |
| member_count / inspection_detail_table / gap_cert_table | 회원수/검사세부·GAP인증 표 | doc24 |
| desired_language / interpretation_request_table / translation_request_table / requested_supporter_table | 희망언어/통역·번역 요청·서포터 표 | doc25 |
| consent_pledge_check | 서약 동의 체크 | doc25 |
| investment_stage / investment_target_amount / investment_raised_amount / investment_history_table | 투자단계/목표·유치액/투자이력 표 | doc26, doc28 |
| company_logo / product_image | 기업로고/상품이미지 (이미지 삽입, manual=true) | doc26, doc30 |
| consent_followup_duty / consent_privacy_thirdparty / consent_integrated_system | 사후관리·제3자·통합시스템 동의 | doc26, doc30 |
| corp_biz_flag / existing_trademark / trademark_to_apply / trademark_goods_service / prev_trademark_support | 법인·개인 구분/기존·출원 상표/지정상품/기 지원 | doc27 |
| application_confirm / contact_mobile_email / eligibility_check | 신청확인/연락처(휴대폰·메일)/자격확인 | doc27 |
| startup_type / investment_raised_amount | 창업유형/투자유치액 | doc28 |
| manufacturing_type / product_info_table / product_detail_name / product_price_table / product_intro_table / product_feature / product_certification | 제조유형/상품 정보·상세·가격·소개 표·특징·인증 | doc30 |

**주의(key 일관성)**: 표(table) key와 사업비/성과 계열 key가 다시 급증했다. 특히 아래 통일이 검수 필요:
- **사업비/예산 표군**: `budget_table` / `budget_summary_table` / `budget_detail_table` / `total_budget_table` / `total_project_cost_table` / `apply_program_budget_table` 등이 문서·위치별로 난립. 한 문서 내 복수 사업비 표는 인스턴스 매칭(확정 규칙 2·6)이나, canonical `budget_table` 지정 규칙 필요.
- **매출/고용/정부지원 이력 표군**: `revenue_table` / `sales_forecast_table` / `expected_sales_table`, `past_support_table` / `gov_support_table` / `gov_support_history_table` — 의미가 겹치는 표는 계열 간 key 통일.
- **인적 블록**: `contact_person_table` / `manager_profile_table` / `staff_profile_table` / `ceo_contact` — 배치2 3-C 미결(블록 통합 vs 항목 분해)과 동일. 검수 시 일괄 정책 확정.
- **동의 계열**: `consent_privacy_use` / `consent_thirdparty` / `consent_signature` / `consent_resident_no` 는 doc10/doc11 계열 재사용을 유지했다.

## 5. 규칙 1~6 적용 사례 요약

- **규칙 1(민감정보 manual 한정)**: doc17 참여자 인적표·doc28 동의서 주민번호란만 manual=true. 생년월일 단독(doc22 `ceo_birth_date`), 성명·연락처·사업자번호는 전부 manual=false로 통일 — 배치2 doc05 생년월일 보수적 manual과 달리 이번엔 규칙 5 확정본을 따라 false 처리.
- **규칙 2(배타/반복 서식 key 인스턴스)**: doc17 시제품제작(p2~8) vs 애로기술지원(p9~10) 배타 서식, doc13 서식1~5 반복 — 같은 key가 문서 내 다회 등장(정상), 인스턴스 단위 라벨.
- **규칙 3(계층 체크박스 대분류 분리)**: doc16 신청분야, doc18 신청내용(3대분류)은 대분류 경계가 명시적이면 분리, 헤더만 있고 대분류 라벨이 약하면 1개 통합 후 notes에 분리 가능성 명시(doc18 `apply_content_check` — 검수 판단 위임).
- **규칙 4(말미 서명행 signature 강제)**: 16문서 전부의 신청서·계획서·서약서·동의서 말미 서명행을 signature(manual=true)로 카운트. 배치2 3-A(doc10 vs doc11 불일치)를 이 규칙으로 해소 — 필드없음 처리한 페이지는 순수 표지/공백뿐.
- **규칙 5(manual 범위)**: 서명·날인 + 동의/서약 체크·서명 + 파일첨부 지시 + 고유식별정보 기입에만 manual=true. 일반 개인정보·정보성 체크는 false.
- **규칙 6(표 key `_table` 접미어)**: 모든 표 필드에 `_table` 접미어 부여. 계열 문서 간 동일 의미 표는 동일 key 재사용 시도(단 4절 통일 과제 잔존).

## 6. 배치 3 총평

- **총계**: 16문서 · **107 페이지 · 530 필드 · 72 manual · applicantFills:false 4개**(doc17 receipt_no/date, doc19 접수번호, doc27 receipt_no — 기관 기입란).
- **스키마 검증**: 16파일 전부 valid JSON, 필수 필드(key/label/section/type/required/applicantFills/manual/page/bbox/notes) 누락 0, type 위반 0, `labeledBy`/`labeledAt`/`docRef` 규격 준수.
- **doc19 페이지 수 정정**: manifest 상 예상과 달리 실제 렌더는 5페이지(doc19-1~5). pageCount=5로 확정.
- **누적 진행**: 파일럿 5 + 배치2 10 + 배치3 16 = **31문서 완료**. 55개 PoC 샘플 중 HWP/HWPX 30 + PDF/DOCX/웹폼 계열 잔여는 별도 배치.
- **검수 최우선**: (1) 사업비/매출/이력 표군 canonical key 통일(4절), (2) 체크박스 없는 동의문의 필드 유형(3-A), (3) 자격 자가진단 표 manual 등급(3-B).
