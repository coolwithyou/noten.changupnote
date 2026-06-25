# 창업노트 — 통합 DB 스키마 (SSOT)

작성일: 2026-06-24 · Postgres(Supabase). 흩어진 테이블 정의를 한 곳으로. 타입은 개념(구현 시 확정).

## 관계 개요
```
users ─< user_company >─ companies ─< company_profiles (필드 단위 프로필)
  │                         │            └─ consents
  └─ app_refresh_tokens      └─< match_state >─ grants ─< grant_criteria
                                   └─ match_events ─< feedback        grants ─ grant_raw
company_enrichment_cache(provider+biz_no+scope)
golden_set · extraction_log · eval_runs · versions(model/prompt/ruleset/scoring/taxonomy)
reference: industry_taxonomy · region_hierarchy · size_thresholds · source_cursor · dedup_links
```

## 1. 계정·회사
**users** (NextAuth) `id pk · email uniq · name · created_at` (+ NextAuth accounts/sessions/verification_token 표준 테이블)
**app_refresh_tokens** `id pk · user_id fk · token_hash uniq · device_id · expires_at · revoked_at · rotated_from · created_at` (Flutter 앱 access/refresh JWT 회전·폐기 원장)
**companies** `id uuid pk · kind(active|preliminary) · biz_no uniq null · legal_type · name · verified bool · verified_at · verify_method · created_by fk users · created_at`
**user_company** `user_id fk · company_id fk · role(owner|member|viewer) · created_at` (pk: user_id+company_id)

## 2. 기업 프로필 (매칭 입력 절반)
**company_profiles** (필드 단위 레코드) `id pk · company_id fk · dimension · value jsonb · source(팝빌|국세청|codef|self_declared|ocr) · confidence · as_of · updated_at` (idx: company_id+dimension)
**company_enrichment_cache** `provider · biz_no · scope · raw_payload jsonb · canonical_payload jsonb · provider_result_code · provider_result_message · checked_at · fetched_at · expires_at · payload_hash · last_error jsonb` (pk: provider+biz_no+scope) — 팝빌/국세청 재과금·중복조회 방지. `company_profiles`는 이 캐시에서 파생된 회사별 canonical 투영.
**consents** `id pk · company_id fk · user_id fk · scope(기본정보|홈택스|4대보험) · purpose · granted_at · revoked_at` (신용정보법 동의 원장)

## 3. 공고 (정규화 grant = 계약)
**grant_raw** `id pk · source(kstartup|bizinfo|bizinfo_event) · source_id · payload jsonb · attachments jsonb(R2 ref) · raw_hash · collected_at · status(fetched|converted|extracted|normalized|published|failed)` (uniq: source+source_id)
**grants** `id pk · source · source_id · title · url · agency_관할 · agency_수행 · category_대 · category_중 · apply_start · apply_end · apply_method · support_amount jsonb · status(upcoming|open|closed) · f_regions[] · f_industries[] · f_biz_age_min/max_months · f_sizes[] · f_founder_traits[] · f_required_certs[] · embedding vector · overall_confidence · model_ver · prompt_ver · updated_at` (uniq: source+source_id; idx: status, f_regions, embedding)
**grant_criteria** `id pk · grant_id fk · dimension · operator(in|not_in|lte|gte|between|exists|text_only) · value jsonb · kind(required|preferred|exclusion) · weight · confidence · source_span · raw_text · needs_review bool` (idx: grant_id)
**dedup_links** `canonical_grant_id fk · member_grant_id fk · score · confirmed bool`

## 4. 매칭
**match_state** (현재상태, upsert) `company_id fk · grant_id fk · eligibility(eligible|conditional|ineligible) · match_score · fit/comp/value 분해 · rule_trace jsonb · match_confidence · ruleset_ver · scoring_ver · updated_at` (pk: company_id+grant_id)
**match_events** (이력, append) `id pk · company_id · grant_id · event(surfaced|clicked|saved|apply_click) · ruleset_ver · ts`
**feedback** `id pk · target_type(extraction|match) · target_id · type(implicit|explicit_relevant|explicit_irrelevant|outcome) · value jsonb · actor(user|reviewer) · ts`

## 5. 플라이휠
**extraction_log** `id pk · grant_id · input_ref · output jsonb · confidence · status(auto|review|labeled) · reviewer · model_ver · prompt_ver · ts`
**golden_set** `id pk · kind(extraction|matching) · ref(grant_id 또는 company+grant) · gold jsonb · curated_by · golden_ver`
**eval_runs** `id pk · target(extraction|matching) · version_refs jsonb · metrics jsonb · golden_ver · ts`
**versions** `id pk · type(model|prompt|ruleset|scoring|taxonomy) · hash · notes · activated_at`

## 6. 레퍼런스/운영 (매핑 자산)
**industry_taxonomy** `ksic · policy_tag · ver` · **region_hierarchy** `sigungu · sido · region_group` · **size_thresholds** `ksic · seg · 매출·고용 임계` · **source_cursor** `source · last_page · last_collected_at`

## 6.5 팝빌 canonical 투영
- `company_enrichment_cache.provider='popbill_bizinfo'`, `scope='bizinfo_check'`.
- `raw_payload`에는 팝빌 `BizCheckInfo` 원문을 보존하고, `canonical_payload`에는 `legal_type`, `size`, `industry.ksic`, `industry.raw_text`, `region.address`, `business_status`, `tax_type`, `establish_date`를 정규화해 저장한다.
- `provider_result_code/result_message/checked_at`은 팝빌 응답의 `result/resultMessage/checkDT`를 보존한다. API 오류(`PopbillException`)는 `last_error`에 저장하고 성공 캐시와 구분한다.
- `CEOName`은 대표자명 PII로 취급한다. 소유권 검증은 국세청 3요소가 주된 근거이며, 팝빌 대표자명은 사용자 표시/불일치 경고 용도로만 최소 보관한다.

## 7. 보안/RLS
- PII 테이블(company_profiles, consents, match_*, app_refresh_tokens): BFF에서 user→company 소유 확인 + (이중방어) Postgres RLS. 워커(service role)는 grants/추출 등 비PII 위주, PII 최소.
- 신용정보(홈택스·4대보험 파생): 분리 저장·컬럼 암호화·접근로그. consents 없는 접근 금지.
- 상세: `창업노트_계정권한_개인정보_설계.md`.
