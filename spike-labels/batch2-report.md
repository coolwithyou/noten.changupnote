# Gate 1 필드맵 라벨링 배치 2 리포트

작성: opus-prelabel · 2026-07-02
대상: 10개 문서 (doc01, doc03, doc04, doc05, doc06, doc07, doc08, doc09, doc11, doc12) 사전 라벨링
기준서: `docs/gate1-field-map-labeling-guide.md` (golden_ver `field_map_v0`)
선행: 파일럿 5개(doc02/10/23/29/31, `spike-labels/pilot-report.md`)

> 본 산출물은 사전 라벨(pre-label)이다. 확신 없는 판정은 각 필드 `notes`에 "확인 필요:"로 표기했으며 사람 검수로 확정한다. 파일럿 확정 규칙 3건(민감정보 manual, 배타/반복 서식 key, 계층 체크박스 대분류 분리)을 적용했다.

## 1. 문서별 필드 수 요약

| doc | 문서명(요약) | 소스 | pageCount | 필드 수 | manual | 필드 없는 페이지 |
|-----|------------|------|-----------|--------|--------|----------------|
| doc01 | 관악구 중소기업육성기금 융자신청서+사업계획서 (HWPX) | bizinfo:PBLN_000000000118094 | 11 | 50 | 5 | p9(공백), p11(관악구청장 귀중 수신처만) |
| doc03 | 서초구 시중은행 협력자금 대출신청서+사업계획서 (HWPX) | bizinfo:PBLN_000000000118093 | 9 | 43 | 8 | p6(각서 준수사항 안내문), p9(공백) |
| doc04 | 서초구 융자 신청서+사업계획서 (HWPX) | bizinfo:PBLN_000000000118098 | 9 | 35 | 6 | p6(각서 준수사항 안내문), p9(공백) |
| doc05 | 공공기관 기술나눔 특허활용계획서+제3자 제공 동의서 (HWPX) | bizinfo:PBLN_000000000122670 | 3 | 12 | 4 | p3(기관장 귀하 수신처만) |
| doc06 | 안전관리 우수연구실 인증제 신청서 등 (HWPX) | bizinfo:PBLN_000000000119234 | 10 | 21 | 5 | p2(작성방법·처리절차 안내), p9([첨부5] 표지 제목만) |
| doc07 | 시니어 인턴십 기업 신청서 (HWPX) | bizinfo:PBLN_000000000119698 | 10 | 39 | 6 | p1(제출서류 안내), p6(공백), p10(귀하 한 줄) |
| doc08 | 경기도 공동활용 연구장비 사용료 지원 신청서+관련서류 [서식1-9] (HWPX) | bizinfo:PBLN_000000000120012 | 19 | 92 | 18 | p4·p6·p8·p10·p12·p16·p17·p18·p19 (공백·제목·고시 안내) |
| doc09 | 청년 일경험 참여기업 신청서류(신청서·확인서·협약서·서약서·운영계획서) (HWP) | bizinfo:PBLN_000000000120863 | 8 | 55 | 6 | p2(서식2 확인서 표지 제목만) |
| doc11 | 인천 서구 제품인증획득 지원신청서(doc10 동일계열) (HWP) | bizinfo:PBLN_000000000117671 | 6 | 41 | 5 | p6(공백) |
| doc12 | 광주 Stand-up 맞춤지원 신청서+계획서 (HWP) | bizinfo:PBLN_000000000120427 | 19 | 60 | 15 | p3(이행서약서 본문 서약문만), p11(첨부 안내문구), p16(결과보고서 작성 안내문) |
| **합계** | | | **104** | **448** | **78** | |

### 순수 안내/공백 페이지 총평
- **완전 공백**: doc01 p9, doc03 p9, doc04 p9, doc07 p6, doc08 p4, doc11 p6.
- **수신처(귀하/귀중) 한 줄만**: doc01 p11, doc05 p3, doc07 p10, doc08 p6.
- **안내문/작성방법/고시**: doc06 p2, doc08 p16·p17·p18·p19, doc12 p11·p16.
- **표지/제목만**: doc06 p9, doc08 p8·p10·p12, doc09 p2.
- **서약 본문만(실제 서명·기입은 다음 페이지)**: doc03 p6, doc04 p6, doc12 p3.

## 2. manual 필드 분포 (총 78개)

- **서명/날인/직인**: 각 문서 대표자·신청인·기관장·연구실책임자 서명행. 반복(신청서·사업계획서·각서·동의서 각각)이 잦다. doc03·doc04는 공동사업자 서명까지 별도.
- **동의/서약 체크·서명**: 개인정보 수집·이용, 제3자 제공, 과세정보 조회, 행정정보 공동이용, 참여 실행서약. doc08(9종 서식 중 서약·동의 다수)·doc12(동의서 3건+이행서약)가 manual 집중.
- **증빙 파일 첨부**: 구비서류/제출서류 목록을 통합 1개 `attachments` file 필드로 처리(파일럿 3-A 관행). doc06 연구실 배치도(lab_layout)는 도면 작성·삽입이라 첨부성 manual 처리.
- **민감 개인정보 직접 기입**: 파일럿 3-C 확정 규칙 적용. doc08 서식8호 주민등록번호(`ceo_resident_no`) manual=true. doc05 생년월일 단독란은 애매 케이스로 보수적 manual=true 처리(아래 3-D).

doc08(18)·doc12(15)가 manual 최다 — 다중 서식 묶음이라 서식별 동의·서약·서명이 반복 누적된다.

## 3. 새 애매 케이스 (판정 사례집 추가 후보)

### 3-A. 계열 문서 간 서명행 처리 불일치 (doc10 vs doc11)
doc11은 doc10과 동일 양식(인천 서구 제품인증획득)인데, doc10 파일럿은 신청서·사업계획서 말미 서명행 페이지를 "필드 없음"으로 처리했고 doc11은 동일 구조를 `signature` 필드(applicant_signature/plan_signature)로 라벨했다. **동일 서식의 서명행을 필드로 셀지 여부**가 계열 문서 간 갈렸다. 검수 시 doc10/doc11 통일 필요. → 제안 규칙: "제출용 신청서 말미의 대표자 서명행은 rep_signature/응당 signature 필드로 항상 카운트(manual=true)."

### 3-B. 조건부/선택 서식의 required 판정 (doc08 서식5~9호)
doc08은 [서식1-9] 묶음이나 서식5호(법위반 개인정보동의)·6호(법위반 확약서)·7호(치유이행각서)·8호(이의·구제신청서)·9호(대미관세피해 증빙)는 "해당 시/1차 접수 시"만 작성하는 조건부 서식. 필드는 라벨하되 required=false 처리했다. → 제안 규칙: "조건부(해당 시) 서식의 required는 false로 두고 notes에 조건 명시. 배타/조건부 서식 반복 key는 파일럿 3-D 인스턴스 매칭으로 처리."

### 3-C. 담당자/연구실 다항목 인적 블록의 필드 단위 (doc06 담당자·연구실 현황)
doc06 담당자 블록(부서명/성명·직책/전화/휴대전화/팩스/전자우편)과 연구실 현황 블록(연구실명/책임자명·직책/전화/전자우편/종사자수)은 한 논리 블록에 물리 칸이 5~6개다. 파일럿 3-E와 동일한 "복합 셀 다값" 경계. 본 배치는 **블록 단위 table 1필드**로 통합(파일럿 doc23 인적사항 통합과 일관). 검수 시 항목별 분해(연락처=phone_office/phone_mobile/fax/email 등)와의 통일 필요.

### 3-D. 생년월일 단독 기입란의 manual 등급 (doc05 생년월일 8자리)
파일럿 3-C 확정 규칙은 "주민등록번호/고유식별정보 직접 기입 = manual". 그러나 doc05는 **생년월일(8자리) 단독** 기입란이다. 주민번호 뒷자리가 없어 고유식별정보는 아니나 개인식별정보다. 보수적으로 manual=true 처리하고 notes에 "확인 필요" 표기. → 검수 결정 필요: 생년월일 단독은 manual=false로 완화할지, 개인정보 성격으로 유지할지. (파일럿 doc10 "대표자(생년월일)" 복합셀은 manual 미부여였음 — 계열 불일치 소지.)

### 3-E. 예시값이 프리필된 셀 (doc06 연구활동종사자표/과제표, doc09 운영계획서)
doc06 첨부2 표(교수/박사수료/석사과정, 2020~2027년, 내부·외부수탁과제)와 doc09 서식5 운영계획서에 예시값이 회색으로 미리 채워져 있다. 신청자가 덮어써야 하는 기입 대상으로 간주해 필드로 라벨. → 제안 규칙: "예시 프리필 셀은 신청자 기입 필드로 카운트하되 notes에 '예시값 프리필' 명시."

### 3-F. 도면·배치도 작성란의 type (doc06 연구실 레이아웃 배치도)
doc06 p7은 배치도 예시 이미지이며 신청자는 자기 연구실 배치도를 작성·삽입해야 한다. 순수 첨부(file)와 도면 직접 작성의 경계라 `file`+manual로 처리하고 notes에 "확인 필요" 표기. → 검수: 도면/이미지 삽입란을 file로 볼지 별도 처리할지.

## 4. 신규 표준 key 사전 승격 후보

파일럿 사전에 없던, 이번 배치에서 신규 사용한 key (재사용도 높은 순, 검수 후 승격):

| key | 의미 | 등장 문서 |
|---|---|---|
| total_assets | 자산총액 | doc01, doc03, doc04 |
| application_date | 신청일자 | doc01, doc03, doc04 |
| contact_person | 담당자 성명+연락처(한 줄) | doc03, doc04 |
| company_intro | 기타 회사소개(100자) | doc03, doc04 |
| company_history_table | 기업체 연혁 표 | doc01, doc03, doc04 |
| ceo_career_table | 대표자 경력·포상 표 | doc01, doc03, doc04 |
| borrowing_status_table | 차입금 현황 표 | doc01, doc03, doc04 |
| product_overview_table | 제품 개요 표 | doc03, doc04 |
| sales_performance_table | 판매실적(연차) 표 | doc03, doc04 |
| main_partners_table | 주요거래처 현황 표 | doc03, doc04 |
| tech_personnel_table | 기술인력 보유현황 표 | doc03, doc04 |
| ip_status_table | 산업재산권 획득현황 표 | doc03, doc04 |
| real_estate_collateral_table | 부동산 담보물 표 | doc03, doc04 |
| credit_guarantee_table | 신용보증담보 표 | doc03, doc04 |
| fund_usage_table / fund_usage_detail_table | 자금 신청내용/사용계획 표 | doc03, doc04 |
| repayment_plan (기존) | 자금상환계획 | doc03, doc04, doc12 |
| consent_tax_info | 과세정보 조회 동의 | doc03, doc04 |
| consent_egov_info | 행정정보 공동이용 동의 | doc01, doc06 |
| consent_applicant_signature | 동의서 신청인 서명 | doc03, doc04 |
| patent_name / patent_utilization_plan / commercialization_plan / product_sales_record | 특허명/활용방안/사업화계획/판매실적 | doc05 |
| birth_date | 생년월일(단독) | doc05 |
| certification_type | 인증/재인증 구분 | doc06 |
| institution_type | 기관유형 체크 | doc06 |
| contact_person_table / lab_status_table | 담당자/연구실 현황 블록 | doc06 |
| research_personnel_table / research_project_table | 연구활동종사자/연구개발과제 표 | doc06 |
| equipment_status_table / hazard_material_table | 연구장비/위험물질 보유현황 표 | doc06 |
| lab_layout / space_separation | 연구실 배치도/공간 분리여부 | doc06 |
| pledge_* (address/company_name/institution_name/signature) | 각서·서약서 기입·서명 | doc03, doc04, doc06 |
| co_applicant_signature | 공동사업자 서명 | doc03, doc04 |
| (doc07) work_hours / wage_condition / self_check_items / operation_plan / employee_count_type / company_certification / internship_support_type / intern_recruit_method / contract_period | 근무시간/임금/자체점검/운영계획 등 | doc07 |
| (doc08) equipment_usage_table / equipment_host_org / national_project_table / law_violation_check_table / law_violation_cure_table / ceo_resident_no / tariff_* / economic_performance_table 등 | 장비활용·법위반·관세피해 서식 전용 | doc08 |
| (doc09) job_title / recruit_headcount / weekly_task_plan / participant_required_competency / employment_insurance_* | 일경험 신청·운영계획 | doc09 |
| (doc11) applicant_signature / plan_signature | 신청서·계획서 서명(doc10 계열 재사용 key 다수) | doc11 |
| (doc12) support_field / requested_amount / exec_org_* / expert_profile / project_schedule_table / consulting_log_* / result_budget_evidence | Stand-up 수요기업·수행기관·결과보고 | doc12 |

**주의(key 일관성)**: 표(table) key가 급증했다. 검수 시 `_table` 접미어 컨벤션 확정 및 유사 표(예: doc01/03/04 재무·거래처·기술 표군)의 key 통일 필요. doc11은 doc10 key를 최대한 재사용했으므로 doc10과 함께 검수해 계열 일관성을 맞출 것.

## 5. 요청된 핵심 보고 (배치 2 총평)

- **문서별 필드 수 / manual 수**: 위 1절 표 참조. 총 **448 필드, 78 manual, 104 페이지**.
- **가장 애매했던 판정 2가지**:
  1. **계열 문서 서명행 처리 불일치(3-A)** — doc10(필드없음) vs doc11(signature 필드). 동일 양식인데 파일럿과 이번 배치의 판정이 갈려 지표 안정성에 직접 영향. 검수 최우선 통일 대상.
  2. **생년월일 단독란의 manual 등급(3-D)** — 파일럿 3-C(주민번호 manual)의 경계. doc05는 보수적 manual=true, doc10 파일럿의 생년월일 복합셀은 manual 미부여로 계열 불일치. manual recall 분모에 직결되므로 명문화 필요.
- **순수 안내 페이지 목록**: 위 1절 표 "필드 없는 페이지" 열 + "순수 안내/공백 페이지 총평" 참조.
