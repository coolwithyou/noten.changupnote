# 공고 매칭 첫 미션 — 정확도 개선 통합 구현 계획

> 작성일: 2026-07-12\
> 상태: **구현 기준 문서 · Phase 0/1 ranking, Phase 2 추출·검수 게시 경계, Phase 3 planner 구현 · 실제 reviewed 평가셋 대기**\
> 목적: K-Startup·기업마당을 중심으로 수집한 지원사업 공고에서, 개인/법인 사업자가 사업자등록번호와 최소한의 추가 정보를 제공하면 **실제로 신청 가능한 공고를 누락 없이 찾고, 확인되지 않은 조건을 과장하지 않으며, 판단 근거를 설명하는 제품**을 구현한다.\
> 이 문서는 Codex와 사용자가 구현 중 함께 갱신하는 실행 SSOT다. 개별 세부 설계는 기존 문서를 참조하되, 우선순위·배포 순서·완료 판정은 본 문서를 따른다.

> 진행 메모 (2026-07-12): Phase 0 최소 vertical slice를 착수했다. `matching-v3` annotation schema, 20개 공고·5개 회사 seed manifest, v1/v2 호환 loader, 통합 baseline report와 verifier를 구현했다. 현재 검증 가능한 정답은 legacy 9쌍뿐이며 운영 정확도 근거가 아니다. baseline은 `docs/research/2026-07-12-matching-baseline-v0.md`에 기록했다. 다음 작업은 seed의 pending 프로필·기업마당 공고를 실제 draft/reviewed annotation으로 채우는 것이다.

> 진행 메모 (2026-07-12, Phase 1): `MatchQuality`와 `MatchRanking` 계약을 구현했다. `fit_score` 호환 필드는 필수·제외조건의 가중 확인 완성도이며, 원문 근거 커버리지·추출 준비도·자격 판정 신뢰도를 별도 제공한다. 관련성 v1은 업종/KSIC 70점 + 관심 목표 30점의 설명 가능한 고정 가중치이고 지역·업력은 재가점하지 않는다. 우선순위 v1은 마감 35% + 혜택 25% + 준비서류 15% + 미확인 조건 25%다. 기본 정렬은 recommendation tier → eligibility → extraction readiness → relevance → priority → deadline 순이며 ranking은 eligibility를 변경하지 않는다. 카드에는 관련성 높음/보통/낮음과 추천 순서 근거만 표시하고 퍼센트 및 선정 가능성 표현은 숨긴다.

> 진행 메모 (2026-07-12, ranking live audit): `pnpm report:match-ranking -- --limit=100 --asOf=...` 읽기 전용 리포트를 추가해 합성 회사 3종으로 활성 공고 100건을 측정했다. 첫 실행에서 `개발`·`제조` 범용 토큰이 업종 일치로 과대평가되는 문제를 발견해 stop word 처리했고, 관심 목표가 업종 criterion 문자열에 의해 오인되지 않도록 title/category만 목표 매칭에 사용한다. 활성 기업마당 100건의 `f_industries`는 0건이지만 industry criterion은 51건으로, 표준화 파생 필드 coverage가 병목임을 확인했다. 안전한 동의어(`SW`↔소프트웨어, 농식품 표기 변형, 외식 등)를 canonical token으로 묶은 뒤 software 표본은 high 2/medium 1, food 표본은 high 1/medium 2, 구체 금속 신호가 없는 manufacturing 표본은 high/medium 0으로 보수적으로 유지됐다. 목표 일치만으로는 최대 30점이고, 40점 미만 관련성은 UI 배지를 숨기고 정렬 보조로만 사용한다. 우선순위는 미확인 조건 때문에 high 0건이다. 이는 점수 확대 보정보다 Phase 2 업종·조건 추출 개선으로 계속 해결해야 한다. DB write는 없다.

> 진행 메모 (2026-07-12, evaluator live audit): 활성 기업마당 20건 dry-run에서 전량 ineligible이 나온 원인을 trace histogram으로 조사했다. size 문자열 동치(`중소`↔`중소기업`), 세부 규모 불확실성(`중소`→`소상공인`), 업력 임계 누락, label-only 업종 불일치를 fail이 아닌 unknown으로 교정했다. 동일 slice가 ineligible 20→15, conditional 0→5로 바뀌었고 잔존 hard fail은 지역 불일치 15건뿐이다. DB write는 하지 않았다. 상세는 baseline 문서의 Phase 1 운영 DB dry-run 절을 본다.

> 진행 메모 (2026-07-12, Phase 3): 여러 공고의 profile-resolvable unknown을 집계하는 question planner를 구현하고 dashboard의 기존 “첫 unknown” 선택을 교체했다. 활성 100건 dry-run에서 업종 질문이 21건에 영향, 규모 질문이 5건 영향·2건 즉시 확정으로 집계됐다. 업종·인증 등 positive-only 목록의 단일 응답은 전체 목록을 소진하지 않으므로 업종의 즉시 확정 수는 0건으로 보수 교정했다. list 질문 저장은 `mode=merge`와 `list_completeness=partial`로 자동조회 값을 보존하고, 전체 목록을 명시 편집하는 설정 저장은 `replace`와 `complete`를 유지한다. 원문 누락·text_only·검수 전·이미 탈락 공고는 질문 후보에서 제외한다. UI 시각 검수와 실제 답변 후 상태 전환 측정은 아직 남아 있다.

> 진행 메모 (2026-07-12, Phase 2 manifest slice): `GrantExtractionManifest` 계약, readiness/warning 계산기, source별 read-only report, publish 계획 집계, 매칭 추천 게이트를 구현했다. 저장소 조회 시 `grant_attachment_archives`와 최신 `grant_application_surfaces.extraction_status`를 합성해 구 raw JSON이 아닌 현재 변환 상태를 사용한다. 활성 기업마당 100건은 partial 98 / structured_unreviewed 1 / unstructured 1이었고, 첨부 상태는 pending 128 / skipped 32 / converted 4였다. 공고 전체가 partial/unstructured이면 사용자 질문 planner에서 제외하므로 현재 slice의 질문 후보는 0건이다. surface 미등록 활성 공고 20건을 dry-run으로 확인했지만 외부 변환 작업을 수반하는 `--write`는 실행하지 않았다.

> 진행 메모 (2026-07-12, Phase 0 reviewed workflow): seed manifest를 v2로 올려 K-Startup 20건과 기업마당 고위험 표본 10건으로 확장했다. JSONL 계약 로더, criterion extraction evaluator, redacted review task exporter와 검증기를 구현했다. `tmp/matching-v3-review-tasks.jsonl`과 `tmp/matching-v3-draft-grants.jsonl` 30건을 생성했으며 raw/storage URL은 포함하지 않는다. 예측 초안에는 criterion 125개(structured 83, text-only 42)가 있으나 자기 예측을 template로 만든 값이므로 `operationalReady=false`다. 실제 reviewed annotation은 아직 0건이며 운영 recall gate는 계속 닫혀 있다.

> 진행 메모 (2026-07-12, BizInfo extraction backstop): review task에서 `중소기업→소중기업` 오타와 `min_employees`처럼 evaluator가 소비하지 못하는 value key, LLM criteria 0건 사례를 발견했다. LLM 경계에서 규모 canonicalization과 employees/revenue alias 정규화를 추가했다. 또한 기업마당 structured field의 `trgetNm`, 제목 선두 지역 태그, 본문 `법인사업자/개인사업자`를 결정론적으로 추출해 LLM 결과와 중복 제거 병합한다. LLM이 빈 criteria를 반환해도 이 backstop이 size/region/target_type을 보존하는 테스트를 추가했다. 기존 DB 공고는 재추출 전까지 바뀌지 않는다.

> 진행 메모 (2026-07-12, BizInfo industry projection): ranking coverage report에서 활성 100건의 industry criterion value key가 `labels` 28건, `note` 25건, `industries` 2건이고 canonical `tags`는 0건임을 확인했다. `bizinfo-llm-criteria-v3`에서 prompt를 `value.tags`로 고정하고 labels/industries alias를 tags로 정규화한다. projection은 v2 저장본 alias도 읽을 수 있어 재정규화 시 `f_industries`를 복구한다. 현재 DB에는 쓰지 않았으므로 운영 `f_industries=0/100`은 backfill 전까지 유지된다.

> 진행 메모 (2026-07-12, industry projection backfill): 공용 `projectGrantIndustryTags()`를 추가해 required/preferred의 `tags/industries/labels/codes/ksic_codes`만 projection하고 exclusion·text_only는 제외한다. `backfill:bizinfo-industries`는 기존 source-derived 업종을 삭제하지 않는 additive/idempotent 계획이며 기본은 dry-run이다. 활성 전체 slice(`--limit=2000`, 실제 1,932건)에서 기업마당 1,523건 중 positive industry signal 415건, 갱신 후보 414건을 확인했다. write는 실행하지 않았다. 실제 반영에는 `--write --confirm=BACKFILL_BIZINFO_INDUSTRIES`가 모두 필요하고 optimistic before-array guard로 stale row에서 transaction 전체를 중단한다.

> 진행 메모 (2026-07-12, source-stratified ranking/K-Startup projection): 최신순 100건이 모두 기업마당이어서 ranking report를 활성 최대 2,000건 로드 후 소스 round-robin 표본으로 변경했다. 실제 활성 1,932건(기업마당 1,523, K-Startup 409)에서 50/50 표본을 평가한다. K-Startup의 positive industry projection은 기존 저장본 기준 409건 중 1건뿐이고 나머지 업종 criterion 대부분은 text_only다. `kstartup-field-parser-v3`부터 긍정 industry criterion을 `f_industries`로 projection하며 exclusion은 제외한다. 공용 backfill은 `--source=kstartup`도 지원하지만 현재 후보는 1건뿐이므로 핵심 병목은 DB projection이 아니라 K-Startup 업종 추출 coverage다. 과거 `kics_codes` 오타도 legacy alias로 읽고 신규 BizInfo 결과는 canonical `codes`로 정규화한다. write는 실행하지 않았다.

> 진행 메모 (2026-07-12, K-Startup parser ceiling): 기존 `renormalize-kstartup-cli`를 industry placeholder 1,000건에 dry-run한 결과 structured 전환 0, placeholder 유지 1,000(guard 39, 미지원 표현 961)이었다. 전체 placeholder 대상은 10,321건이다. 현재 결정론적 소수 룰을 넓혀 숫자를 만드는 것은 false-ineligible 위험이 크므로, 이 구간은 상세/첨부 source span을 사용하는 LLM 추출과 reviewed annotation gate로 해결한다. 단순 재정규화나 projection backfill만으로는 업종 coverage가 개선되지 않는다는 운영 근거다.

> 진행 메모 (2026-07-12, K-Startup LLM draft boundary): `buildKStartupExtractionInput()`이 신청대상 요약/상세, 제외대상, 우대사항, 지원지역/분류, 상세 신청방법/제출서류, 변환 첨부를 source block으로 분리한다. `kstartup-llm-criteria-v1` 어댑터는 모든 LLM criterion을 `needs_review=true`로 강제하고, source span이 실제 block에 없으면 `other/text_only`로 강등하며, 동일 dimension/span에서는 deterministic 결과를 우선한다. 근거 있는 structured 결과가 있으면 같은 dimension/kind의 deterministic placeholder만 제거한다. 활성 409건 중 hard text-only 후보는 221건(size 81, industry 184, certification 48, other 41)이고 전부 detail은 있으나 converted attachment 보유 후보는 0건이다. `extract:kstartup-criteria-drafts` 기본 모드는 외부 호출 0건의 plan이며, 실제 호출은 `--extract --confirm=EXTRACT_KSTARTUP_CRITERIA`가 필요하고 결과는 DB가 아닌 `operationalReady=false` JSONL draft로만 저장한다. 이번 세션에서는 외부 호출과 DB write를 실행하지 않았다.

> 진행 메모 (2026-07-12, K-Startup attachment archive boundary): 변환 첨부 0건의 원인은 detail에서 파일명/직접 URL로 만든 pending surface 425건이 모두 `archive_url/sha256` 없이 conversion poll에서 skipped되는 데 있었다. `kstartupAttachmentMarkdown` loader는 converted+storage key 첨부만 읽고 공고문 우선, YAML frontmatter 제거, storage key 검증, 첨부별 8k/전체 18k 문자 제한을 적용한다. 신규 수집에는 명시적 `--archive-attachments` 옵션을 추가했으며 기본과 cron은 비활성이다. 기존 활성 공고 중 아카이브 가능한 K-Startup 후보는 255건이고 `backfill:kstartup-attachments`는 최대 3개 변환 가능 문서를 공고문 우선으로 선택한다. 실제 반영은 `--write --confirm=ARCHIVE_KSTARTUP_ATTACHMENTS`가 필요하고 source cursor를 보존한다. filename 기반 legacy surface는 storage key 정체성으로 승격해 중복 surface를 만들지 않는다. 이번 세션에서는 첨부 다운로드/R2/DB/변환 job write를 실행하지 않았다.

> 진행 메모 (2026-07-12, reviewed publication boundary): K-Startup LLM 결과 JSONL은 `operationalReady=false`, LLM criterion 전건 `needs_review=true`, source ID 유일성, 제출서류 source span을 파서 단계에서 강제한다. `export:kstartup-draft-review-tasks`는 현재 DB 공고와 draft의 ID·제목을 대조해 redacted 검수 task와 annotation template을 만들며 기존 파일 덮어쓰기는 `--force`가 필요하다. `planReviewedGrantPublication()`은 `labelStatus=reviewed`, reviewer, 검수시각, 현재 공고와의 source/title 일치, 구조화 criterion source span을 모두 확인한 뒤에만 운영 criterion으로 승격한다. 게시 CLI는 기본 dry-run이며 `--write --confirm=PUBLISH_REVIEWED_GRANT_ANNOTATIONS`가 함께 있어야 한다. 게시된 공고의 기존 match_state는 삭제하여 stale 결과 노출을 막고 별도 refresh를 요구한다. 검수 증거는 기존 `extraction_log(status=labeled)`에 기록하고 repository가 이를 manifest의 `reviewedAt`/extractor version으로 수화한다. 초안 레코드는 같은 파일에 있어도 건너뛰며 절대 게시하지 않는다. 실제 reviewed annotation은 여전히 0건이고, 외부 호출·DB write는 실행하지 않았다.

> 진행 메모 (2026-07-12, independent/stale review gate): `reviewed` annotation은 로더 단계부터 annotator·reviewer가 모두 존재하고 서로 다른 식별자이며, 유효한 `annotatedAt ≤ reviewedAt` 순서를 가져야 한다. 알려진 AI 식별자는 reviewer로 허용하지 않는다. 공고 검수 template에는 당시 extraction manifest의 `sourceRevision`을 고정하고, 게시 시 현재 revision과 다르면 제목이 같아도 stale review로 차단한다. 이 계약은 운영 게시뿐 아니라 extraction 평가 리포트에도 동일하게 적용돼 자기 검수나 오래된 원문 라벨이 운영 정확도로 집계되는 경로를 닫는다.

> 진행 메모 (2026-07-12, audience P0/P6a): 개인·학생 전용 공고를 사업자 매칭 우주에서 제외하기 위한 `GrantAudience` 계약, deterministic 분류기, 읽기 전용 운영 리포트와 2인 검수 evaluator를 구현했다. 활성 1,932건의 보수적 결과는 company 1,863 / mixed 29 / unknown 34 / 안전한 individual 후보 6이다. K-Startup의 broad `aply_trgt` 개인 토큰 단독은 확정 근거로 쓰지 않고 제목/대상본문의 개인 전용 신호를 요구한다. 90건 층화 review packet을 생성했지만 reviewed=0이므로 individual precision gate는 닫혀 있다. 따라서 DB audience 컬럼 백필, `listActiveGrants` 제외 필터, match_state 삭제는 아직 적용하지 않았다.

> 진행 메모 (2026-07-12, audience ingestion boundary): K-Startup·BizInfo normalizer가 deterministic `Grant.audience`를 반환하도록 배선했다. P1 migration SQL이 enum/column/index만 생성됨을 로컬에서 확인했지만, 미적용 DB와 schema.ts 불일치가 실행 중 앱을 깨뜨리는 것을 방지하기 위해 schema·publisher·0045 생성본은 되돌렸다. DB migration 실행과 필터 활성화는 P6a 사람 검수 및 명시 승인 뒤 같은 배포 단위에서 수행한다.

> 진행 메모 (2026-07-12, active freshness guard): 활성 1,932건을 측정해 마감일 없는 공고가 946건임을 확인했다. 기업마당 847건은 대부분 2026년 공고라 유지하고, K-Startup 중 `status=unknown + apply_end 없음 + 제목의 최신 연도 ≤ 현재연도-2`인 명백한 과거 공고 34건(2012~2019)만 조회 우주에서 제외했다. guard 후 활성 우주는 1,898건, K-Startup은 409→375건이고 stale title-year 후보는 0이다. 제목에 과거·현재 연도가 함께 있으면 최신 연도를 사용하며, BizInfo·open 상태·마감일 보유·연도 미표기 공고는 제외하지 않는 회귀 테스트를 추가했다. DB write는 없다.

> 진행 메모 (2026-07-12, additional source probe): 과기정통부 사업공고 API의 타입 안전 fetch adapter와 키 비노출 read-only probe를 구현했다. 공식 API는 제목·게시일·상세 URL·첨부를 제공하고 이용허락 제한 없음이지만 현재 키가 해당 API에 승인되지 않아 live 호출은 `403 Forbidden / api_utilization_approval_required`다. 중기부 신규 공고 API는 기업마당 동일 원천이며 수정일 cursor 장점이 있지만 공공저작물 제3유형(변경금지)이라 ingestion 교체는 보류했다. 국고보조금 공모 API는 다음 probe 후보다. 상세 근거는 `docs/research/2026-07-12-additional-grant-api-probe.md`에 기록했다.

> 진행 메모 (2026-07-12, MSIT incremental coverage): 활용승인 직후 재작업 없이 판단할 수 있도록 전체 페이지 snapshot 수집과 최근 90일 순증 측정기를 추가했다. snapshot이 `totalCount`까지 완주했는지 `complete`로 명시하고, 기존 활성 공고 대비 `exact_title / high_confidence / review / likely_unique`를 분리한다. `conservativeIncrementalCount`는 사람 검토가 필요 없는 `likely_unique`만 집계하며, snapshot 미완주 또는 게시일 파싱 누락이 있으면 운영 판단에 사용할 수 없다. 현재 live 실행은 여전히 승인 전 `403`에서 중단되고 DB write는 수행하지 않는다.

> 진행 메모 (2026-07-12, MOEF subsidy probe): 국고보조금 공모 상세 API의 공식 Swagger에서 지원대상·제외대상·접수기간·선정기준·제출서류·수정일 필드를 확인하고 타입 안전 fetch adapter와 read-only probe를 추가했다. adapter 테스트는 통과했지만 현재 공용 키는 이 API에도 활용승인 전이라 live 호출은 `403 / api_utilization_approval_required`다. 기업 외 대상 혼입 가능성이 높아 승인 후 audience·순증 표본 검수 전에는 source/schema를 추가하지 않는다.

> 진행 메모 (2026-07-12, Phase 6 feedback provenance): match feedback 저장 직전에 서버가 현재 grant revision·ruleset/scoring version·eligibility·extraction readiness·criterion result를 다시 계산해 provenance를 붙인다. 회사 fact와 source span 원문은 저장하지 않고 dimension별 존재 여부·confidence·SHA-256 hash와 criterion/source-span hash만 보존한다. 공고/회사를 찾지 못하면 `grant_missing/company_missing`으로 명시해 추적 완전성을 과장하지 않는다. correction은 사람 reviewer, 제출자와 다른 식별자, 시간 순서, 완전한 provenance, 현재 grant revision 일치를 모두 통과해야 evaluation candidate가 되며 자동 golden 승격은 하지 않는다. 검토 task exporter, 기본 dry-run publication CLI, 월간 read-only quality report를 구현했다. 2026-07 DB 기준선은 사용자 feedback 0건이라 `operationalReady=false`다. DB write는 실행하지 않았다.

> 진행 메모 (2026-07-12, scoped feedback refresh): accepted reviewer feedback의 `pair/company/grant` 범위를 실제 match_state refresh 계획으로 연결했다. 새 상태와 기존 상태의 eligibility·fit score·ruleset/scoring version·transition window·rule trace를 비교해 변경 행만 저장 대상으로 만든다. `grant`는 회사 전체, `company`는 활성 공고 전체, `pair`는 단일 쌍만 계산한다. 기본은 dry-run이고 write에는 reviewer feedback ID, `--correction-applied`, `--write`, 확인 문자열이 모두 필요하다. 후보가 limit에 잘리면 불완전 refresh write를 거부한다. 현재 reviewer feedback 0건이므로 실제 write는 실행하지 않았다.

> 진행 메모 (2026-07-12, v3 pair draft slice): 실제 사업자정보를 포함하지 않는 synthetic 회사 archetype 3개(개인 2, 법인 1)를 `draft`로 추가하고, 기존 공고 검토 초안 30건과 교차한 eligibility pair review task 90건을 생성했다. 현재 엔진 예측 분포는 conditional 46 / ineligible 36 / eligible 8이지만 모두 `ENGINE_PREDICTION_REQUIRES_INDEPENDENT_REVIEW`이며 운영 정답에서 제외된다. pair task는 company raw value와 사업자번호·대표자 필드를 포함하지 않고 criterion ID/result만 제공한다. 사람 라벨을 보기 전에 SHA-256 pair ID를 source×개인/법인 층 내에서 정렬해 development 63 / holdout 27을 고정했다. 기본 진행 보고서는 development만 계산하며 holdout 공개에는 별도 확인 문자열이 필요하다. 진행 보고서 기준 annotated draft 0, reviewed 0, `sliceReady=false`, `missionReady=false`다. 현재 slice는 첫 미션의 reviewed 500쌍 목표를 대체하지 않는다.

> 진행 메모 (2026-07-12, offline review workbench): synthetic 회사 3건, 공고 30건, development pair 63건을 서버 없이 검수할 수 있는 단일 HTML workbench 생성기를 추가했다. CSP는 network connect를 차단하고 redacted task만 embed하며 `</script>` escape와 생성된 client script 문법을 테스트한다. 검수자는 annotation JSON을 편집하고 독립 검토 확인 후 1차 annotator 또는 별도 reviewer 메타데이터를 적용해 JSONL로 내보낸다. prediction placeholder가 남아 있거나 pair의 `resolvableByProfileInput`을 확정하지 않으면 완료 표시를 막는다. 실제 브라우저 검증에서 inline script newline escape 오류와 pair localStorage가 grantId로 충돌하는 문제를 발견해 수정했고, 최종 화면에서 회사 3·공고 30·pair 63, 서로 다른 저장 ID, 필수 검수 오류 문구를 확인했다. holdout 포함 workbench는 별도 확인 문자열 없이는 생성할 수 없다.

> 진행 메모 (2026-07-12, reviewed batch gate): workbench가 내보낸 회사·공고·pair JSONL을 함께 검증하는 batch gate와 기본 dry-run finalizer를 추가했다. task ID 집합, company kind/source fixture, grant source/title/revision, pair 참조/split, criterion ID 존재성, eligibility와 hard-fail/unknown 논리, annotator/reviewer 독립성을 검증한다. current draft에 실행하면 prediction placeholder와 annotator metadata 누락 등 349개 오류로 `batchReady=false`가 되어 미검수 초안의 최종화를 차단한다. 통과한 reviewed batch의 파일 최종화에도 `--write --confirm=FINALIZE_MATCHING_V3_REVIEW_BATCH`가 필요하며 DB는 변경하지 않는다.

> 진행 메모 (2026-07-12, first-mission scale draft): 소형 workflow 검증 후 첫 미션 목표 수량의 draft packet을 생성했다. synthetic 회사는 개인 15·법인 15, 15개 지역·30개 업종 라벨과 업력·규모·재무·결격 변형을 포함한다. 활성 universe 1,898건을 잘림 없이 읽어 K-Startup 50·기업마당 50 공고를 추출 준비도와 criterion 위험도로 층화했다(structured 21 / partial 74 / unstructured 5). 100×30=3,000쌍에서 모든 공고·회사를 포함하며 source·business kind·예측 클래스를 균형화한 500쌍을 선택하고 development 350 / holdout 150을 사전 고정했다. 예측 분포는 ineligible 259 / conditional 218 / eligible 23이다. 확장 workbench가 브라우저에서 회사 30·공고 100·development pair 350으로 로드됨을 확인했다. reviewed는 여전히 0이므로 목표 수량의 작업 큐만 준비됐을 뿐 운영 평가셋은 아니다.

> 진행 메모 (2026-07-12, expanded review handoff): 확장 검수 시 소형 패킷 경로를 잘못 참조하지 않도록 진행 보고와 batch finalizer에 `--packet=expanded` 프리셋을 추가했다. 이 프리셋은 회사 30·공고 100·pair 500 task와 별도 `reviewed-expanded` 출력 경로를 선택한다. 기본은 development 350쌍만 평가하고 holdout 150쌍은 명시 확인 없이는 열지 않으며, finalizer는 여전히 dry-run이다. development 전용 workbench export에서 잠긴 holdout 150쌍을 누락 annotation으로 잘못 세던 진행 보고 경계도 교정했다. matching unit/eval/review verifier, feedback/refresh verifier, package build, web/admin typecheck, OpenAPI, `git diff --check`를 모두 통과했다. DB·외부 API·holdout·fixture write는 수행하지 않았다.

> 진행 메모 (2026-07-12, question resolution impact): 점진 질문 저장 API가 저장 전·후 동일 활성 공고 40건을 재판정해 `targetedConditionalCount`, 해당 dimension 해소 건수, `conditional→eligible|ineligible` 확정 건수, 잔존 conditional, event 단위 `conditionalResolutionRate`를 반환하도록 연결했다. 응답은 `scope=active_grant_window`, `windowLimit=40`, 실제 `evaluatedGrantCount`를 함께 제공해 전체 활성 공고 지표로 과장하지 않는다. 대시보드 질문 카드는 단순 “결과 갱신” 대신 실제 판정 변화 건수를 보여준다. 분모는 답변 전에 해당 dimension의 required/exclusion hard unknown이었던 공고로 한정한다. positive-only 업종 부분 목록의 비일치는 계속 unknown으로 보존하고, complete 목록에서만 fail을 확정하는 회귀 테스트를 추가했다. 앱 API는 별도 `CompanyProfileUpdateEnvelope`로 OpenAPI를 갱신해 조회용 프로필 응답과 분리했다. 이 지표는 현재 요청 단위 응답이며, 사용자 전체의 p50 질문 수나 월간 해소율을 산출할 영속 이벤트 저장은 아직 추가하지 않았다.

> 진행 메모 (2026-07-12, question quality telemetry): `profile_question_events` 최소수집 이벤트와 회사 멤버 RLS를 추가했다. 이벤트에는 session ID, 질문 dimension, 평가 window, 전환 집계, ruleset과 시각만 저장하고 답변 원문·사업자번호·프로필 값·source span은 저장하지 않는다. 웹은 HttpOnly·SameSite=Lax 30분 세션 쿠키, 앱은 선택적 `questionSessionId`를 사용한다. 마이그레이션 미적용·runtime adapter에서는 프로필 저장을 실패시키지 않고 `persisted=false` receipt를 반환한다. 월간 report는 전체 이벤트 30건·세션 10개 이상에서 가중 `conditional_resolution_rate ≥ 0.60`, 판정이 처음 확정될 때까지 질문 수 p50 ≤ 3을 gate로 계산하며 dimension별 병목도 출력한다. 서로 다른 ruleset이 섞이면 운영 gate를 닫고 `--ruleset=<version>`으로 동일 버전만 비교한다. `0045_mushy_daimon_hellstrom.sql`은 생성했지만 실제 DB migration은 실행하지 않았다.

> 진행 메모 (2026-07-12, active cross-source dedup): dedup을 `auto_duplicate / review / distinct`로 분리하고 연도·회차·비중첩 신청기간 충돌은 자동 병합하지 않도록 했다. 동일 canonical URL, exact normalized title+기관/동일 기간, 또는 title 0.9 이상+강한 기관/기간 근거만 자동 확정한다. canonical occurrence는 키 정렬이 아니라 structured criterion·변환 첨부·URL·기간·기관·서류·confidence·최신 revision 순으로 선택한다. confirmed 그룹을 사용자 목록에서 한 건으로 접을 때 canonical identity와 criteria는 유지하고 모든 occurrence 중 가장 이른 접수 시작일, 가장 늦은 마감일, 최신 updatedAt, 파생 region/industry/size/trait/cert 합집합을 보존한다. 활성 1,898건 전체 read-only audit에서 auto 4쌍, review 1쌍, 중복 excess 4건, 추정 카드 노출률 0.21%를 확인했다. 현재 confirmed active link는 0건이라 실제 억제는 0건이고 publicationReady=false다. publisher dry-run은 5개 링크 중 auto 4개만 `confirmed=true`, review 1개는 false로 계획했다. 사용자 활성 조회는 confirmed 그룹만 collapse하며 dedup 재평가·품질 report는 숨긴 occurrence까지 포함한다. CLI 기본값은 dry-run이고 write에는 `--write --confirm=PUBLISH_DEDUP_LINKS`가 모두 필요하다. DB write는 실행하지 않았다.

> 진행 메모 (2026-07-12, revision invalidation/grant-scope refresh): 정규화 publisher가 raw hash, 첨부 변환 상태, parser/model/prompt version뿐 아니라 자격·정렬에 쓰는 grant projection과 ID를 제외한 criteria 전체의 안정 hash를 매칭 revision으로 비교하도록 연결했다. 따라서 같은 원문·같은 모델 버전에서 재추출 결과만 달라져도 stale 상태를 놓치지 않는다. 첨부 fingerprint는 서명 URL과 fetched/converted 시각은 제외하고 archive 존재, storage/content checksum, conversion readiness만 비교해 무의미한 재계산도 막는다. 변경 공고는 같은 confirmed dedup component의 canonical/member `match_state`까지 게시 transaction 안에서 삭제한 뒤, 실제 삭제된 상태의 회사만 같은 transaction에서 canonical grant-scope로 재계산한다. 한 행이라도 재계산이 누락되거나 실패하면 공고 게시까지 rollback하므로 handoff 유실이 없다. 결과에는 `revisionCounts`, 무효화·재계산 수, 대상 UUID가 포함되고 K-Startup/BizInfo archive 및 cron 응답도 이를 보존한다. `refresh:grant-revision-scope`는 운영 복구·사전 점검용으로 UUID/source ID와 선택적 company ID를 받아 같은 범위를 재현하며, 전체 회사 모드 write는 후보가 limit에 잘리면 거부한다. 실제 DB read-only 검증은 BizInfo 공고 1건 × 전체 회사 113개와 명시 회사 1개 범위 모두 `candidateComplete=true`였고, 명시 회사 모드는 정확히 상태 1개만 계획했다. `apply_end`는 match-state transition window가 아니라 최신 grant에서 직접 읽는 필드이므로 deadline-only 변경은 상태 행을 억지로 바꾸지 않는다. confirmed occurrence 합성은 별도 회귀 테스트에서 가장 늦은 마감일을 보존한다. 실제 publish/refresh DB write는 실행하지 않았다.

> 진행 메모 (2026-07-12, prior_award P0~P2): 문자열 exact-match false pass 때문에 차단돼 있던 수혜 이력에 self/program/program_type 판별 계약, 상태·기간, self-kind별 flag, program/program-type known 커버를 추가했다. 미질의 program과 연도 미상은 pass가 아니라 unknown이고, legacy 문자열도 canonical 사전으로 비교하되 partial 목록의 부재는 확정하지 않는다. profile update와 Drizzle codec이 records/self flags/known coverage를 보존하며 자가신고 confidence 0.6을 기록한다. question planner는 self/program context를 섞지 않고 가장 영향 큰 한 context·한 program씩 묻고, dashboard 전용 폼은 yes/no·상태·필요 연도를 구조화 응답으로 저장한다. OpenAPI와 생성본도 동기화했다. L1 deterministic splitter, L2 LLM downgrade, L3 contract ban은 P3~P5 원자 해제 전까지 그대로 유지한다. 실제 DB write와 dev 서버 시각 검수는 수행하지 않았다.

> 진행 메모 (2026-07-12, prior_award P3/P4): 기본 off 독립 splitter가 동일과제·중복입주·프로그램 이력·타부처 중복과 최근 N년/개월을 v2 값으로 파싱한다. 이어 L3 계약 허용과 L2 LLM emit을 같은 변경으로 열었다. 신규 exclusion은 `scope`와 유효한 self/program/state/within, source_span 없이는 구조화될 수 없고, v1 required/preferred는 읽기 호환을 유지한다. P4 정규화/계약 17건, L1 미생성 회귀 21건, 전체 `test:matching-unit`, 루트 typecheck, OpenAPI 27 paths가 통과했다. L1의 실제 normalizer 배선·활성화, 운영 백필, 사람 검수는 아직 실행하지 않았으며 DB write·유료 LLM 호출도 하지 않았다.

> 진행 메모 (2026-07-12, prior_award 설정/P3 배선): 설정의 자유 텍스트 기수혜 입력을 구조화 편집기로 교체해 self 범위별 미확인/해당 없음/해당, 중복입주, 사업별 상태·연도, canonical known 범위를 replace 저장하도록 했다. HTTP verifier도 구조화 저장·canonical roundtrip·confidence 0.6을 확인하도록 갱신했다. P3 splitter는 K-Startup normalizer의 명시 옵션까지 연결했고 기본 false와 true를 모두 회귀 검증했다. 혼합된 `체납 문장. 중복지원 문장.`이 한 span으로 합쳐지던 ASCII 마침표 분할 누락도 수정했다. 개발 서버 부재로 HTTP/시각 e2e는 아직 실행하지 않았고 운영 flag, DB write, 백필은 건드리지 않았다.

> 진행 메모 (2026-07-12, prior_award P5 초기 read-only gate): 운영 재조회에서 prior_award 38건(활성 30), 활성 legacy exclusion 4건, 그중 scope 없는 계약 위반 not_in 2건을 확인했다. 초기 활성 K-Startup raw 310건 비교에서 과대 span 위험 5건을 찾아 운영 flag를 보류했고, 바로 아래 span 정밀화 메모의 후속 결과로 대체했다.

> 진행 메모 (2026-07-12, prior_award span 정밀화): 불릿·한글 번호·prior 시작구문·절차 조건 경계를 추가해 prior_award 절만 소비하고 허위서류·업종·제재는 residual로 보존했다. 표제-only emit도 차단했다. 재실측은 활성 K-Startup 9개 공고·10 criteria(self 5/program 4/program_type 1), parse failure 0, 계약 위반 0, 자동 과대/mixed span 위험 0으로 automated quality gate를 통과했다. 그러나 독립 사람 검수 10건 중 승인 0건이므로 `autoActivationReady=false`와 운영 flag off는 유지한다.

> 진행 메모 (2026-07-12, prior_award 독립 검수 배선): 9개 공고·10 criteria를 기존 matching-v3 task/draft annotation/독립 검수 HTML로 내보내는 `export:prior-award-review-tasks`를 추가했다. 감사 CLI는 reviewed JSONL을 입력받아 독립 human reviewer 메타데이터와 현재 예측의 criterion ID·operator·value·source span 완전 일치를 검증한다. 생성된 draft를 다시 넣었을 때 accepted 0/10, `autoActivationReady=false`를 확인했으며 reviewer 확정 전 발행·DB write 경로는 없다.

> 진행 메모 (2026-07-12, prior_award P6 dry-run): K-Startup 재정규화 CLI에 기본-off split 옵션과 reviewed annotation preflight를 연결했다. 활성/unknown 409건 dry-run은 criteria 1,297→1,307, prior_award 10건, 오류 0이었고 draft annotation 입력은 승인 0/10으로 write-ready가 되지 않았다. BizInfo 활성 legacy exclusion 4건은 2건 deterministic v2 후보, 2건 기관 범위/polarity human rewrite 대상으로 분류했으며 별도 4건 workbench를 생성했다. DB write, normalizer version 범프, match_state 재계산은 수행하지 않았다.

> 진행 메모 (2026-07-12, prior_award actual-candidate false-pass matrix): 활성 K-Startup에서 생성된 실제 10개 criterion을 현재 매칭 엔진에 넣어 미응답/명시적 비해당/해당 이력 3상태를 각각 검증했다. 30/30이 `unknown/pass/fail` 기대와 일치했고 실패 0건이다. 이 결과는 자동 구조화 판정 안전성을 보강하지만 독립 사람 검수 0/10을 대체하지 않으므로 운영 flag는 계속 off다.

> 진행 메모 (2026-07-12, prior_award P7 golden): self/program/program_type, 미질의, 연도미상, 기간 밖/안쪽을 포함한 11개 영속 golden을 추가했다. criterion 계약과 현재 매칭 엔진의 trace·eligibility를 함께 검증하며 unknown 3/pass 4/fail 4 전건이 통과한다. `verify:prior-award-golden`을 prior_award 통합 테스트에 포함했다. 운영 38건 legacy 형식 snapshot과 실제 HTTP/시각 e2e는 아직 남아 있다.

> 진행 메모 (2026-07-12, prior_award legacy 38 snapshot): 운영 38행을 eligibility 정답이 아닌 형식 호환 regression으로 고정했다. 실측 value key는 note 33/program 단수 2/awards 2/labels 3/period 1/support_type 1/years 1이며, 빈 프로필 38/38은 unknown이다. snapshot이 단수 `program` 누락과 비canonical 사업의 `free:free:` 이중 prefix 버그를 발견해 수정했고 `verify:prior-award-legacy-regression`을 통합 테스트에 포함했다. 이 snapshot은 독립 사람 검수를 대체하지 않는다.

> 진행 메모 (2026-07-12, prior_award serverless e2e 보강): 개발 서버 부재 상태에서 runtime repository의 구조화 save→resolve→매칭 ineligible 전환과 unrelated revenue 저장 후 prior_award 잔존을 검증했다. 설정 편집기도 React SSR로 렌더해 self scope, 중복입주, 기존 TIPS 이력·연도, known program, 미확인 안전 문구, 저장 액션이 마크업에 존재함을 확인했다. 이는 실제 HTTP·브라우저 시각 e2e를 대체하지 않으며 서버 기동 후 verifier를 다시 실행해야 한다.

> 진행 메모 (2026-07-12, prior_award 실제 등급 영향): 신규 prior_award 후보 9개 공고 × 현재 회사/사용자 프로필 scope 113개, 총 1,017쌍을 DB read-only로 비교했다. 구조화 prior_award 프로필은 0/113이어서 trace 1,017건이 모두 unknown이었고 eligibility·recommendation tier 전이는 0건이었다. 미응답을 pass로 오판하지 않은 안전 결과지만, 파서·백필만 켜서는 추천 품질이 바뀌지 않으므로 설정 편집기와 공고별 lazy 질문을 함께 배포하고 응답 수집 후 동일 명령으로 전이를 재측정해야 한다. 독립 검수 0/10, 운영 flag off, DB write 미실행 상태는 그대로다.

> 진행 메모 (2026-07-12, business-number first-result baseline): 자동채움 세션이 추가한 `autofill/coverage` 원천·완전성 계약을 수정하지 않고 매칭 평가에서 재사용했다. synthetic 개인 15·법인 15의 full profile을 현재 구현된 사업자번호 기본 경로(region, biz_age, industry partial, size, business_status, business kind partial)로 보수 투영해 활성 1,898건, 56,940쌍을 read-only 평가했다. 즉시 eligible/ineligible 확정률은 39.24%, hard condition known rate는 44.96%, grant-weighted coverage는 65.43%였고 full profile 대비 위험한 조기 ineligible은 0건이었다. 그러나 recommendable은 346쌍(0.61%)뿐이며 기업마당은 0건이다. 원인은 56,940쌍 중 extraction readiness가 partial 54,270 / structured_unreviewed 2,310 / unstructured 360 / reviewed 0이기 때문이다. hard unknown은 industry 26,898, other 23,220, size 12,618, target_type 7,440 순이고 모든 synthetic 회사의 첫 profile-resolvable 질문은 founder_age였다. 이는 실제 사업자번호 조회 정확도 근거가 아니라 현재 필드 계약에서의 coverage ceiling이며, 계획된 무료 API는 실 connector 검증 전 projection에 포함하지 않았다.

> 진행 메모 (2026-07-12, extraction impact queue): 사업자번호 직후 결과 baseline과 extraction manifest를 결합한 read-only 우선순위 리포트를 추가했다. 활성 공고 1,898건 × synthetic 회사 30개에서 개선 후보는 1,773건이고, 조건상 `eligible`이지만 extraction/review gate 때문에 추천하지 못한 조합은 4,606건이다. action은 `register_or_convert_attachments` 1,590건, `archive_attachments` 117건, `reextract` 47건, `human_review` 19건으로 분류됐다. 공급원별 blocked eligible은 기업마당 3,829건, K-Startup 777건이다. 상위 20개 기업마당 첨부 등록/변환 후보만으로 blocked eligible 600건, K-Startup 상위 20개는 440건이 걸려 있어 전수 재처리보다 exact `sourceIds` 소량 배치를 우선한다. 기존 surface 등록·K-Startup archive·conversion poll 명령에 최대 100개의 `--sourceIds` 필터를 연결했고, 모든 CLI write는 별도 confirmation string을 요구한다. 실제 archive/변환/DB write는 실행하지 않았다.

> 진행 메모 (2026-07-12, extraction action chain 보정): 최신 DB read-only 재측정은 활성 1,898건 중 reviewed 0, structured_unreviewed 77, partial 1,809, unstructured 12였다. 기업마당 unstructured 12건 중 10건은 유효 archive가 있어 운영 다음 단계가 `reextract`로 분류됨을 확인했다. 이 과정에서 개선 플래너가 `첨부 처리 → 재추출 → 사람 검수`를 계산해도 운영 action resolver가 첫 action만 받아 첨부 처리 완료 후 무조건 `human_review`로 보내는 경계 오류를 수정했다. 이제 전체 action chain을 받아 archive·surface·linkage·conversion을 순서대로 해소한 뒤 `reextract` 또는 `human_review`로 이동한다. 복합 action 회귀 테스트, web typecheck, 실 DB 1,773건 리포트 재생성이 통과했고 현재 집계 archive 1,667 / OCR 40 / reextract 47 / human review 19를 유지했다. DB write·외부 추출은 실행하지 않았다.

> 진행 메모 (2026-07-12, BizInfo stored-raw reextract draft): 기업마당 `reextract` 후보는 있지만 실행 계약에 K-Startup 명령만 있던 공백을 메웠다. `extract:bizinfo-criteria-drafts`는 현재 DB의 활성 공고·stored raw를 읽어 `--sourceIds` exact scope의 unstructured/criteria_missing/text_only/source-missing 후보만 계획한다. 기본 모드는 DB write·외부·유료 호출 0이며, `--extract --confirm=EXTRACT_BIZINFO_CRITERIA`와 API key가 모두 있을 때만 Anthropic을 호출해 `operationalReady=false` 검수 draft JSONL만 쓴다. 실 DB unstructured 후보 10건 계획에서 전건 선택, 전건 current criterion 0, converted attachment 1~2개, API field만으로 deterministic 규모/region 복구 1~2건을 확인했다. 확인 문자열 없이 `--extract`를 주면 외부 호출 전 즉시 거부된다. 이 회차에는 계획 모드만 실행했고 paid call·draft 파일 생성·DB write는 0이다.

> 진행 메모 (2026-07-12, BizInfo offline review bridge): K-Startup 전용이던 criteria draft JSONL 계약·review-task builder·exporter를 source 판별 공통 경로로 확장했다. 기존 `kstartup_criteria_draft`와 명령은 하위호환을 유지하고, `bizinfo_criteria_draft`는 source/title/current raw revision 일치, criterion과 sourceId/grant_id 일치, criterion contract, LLM `needs_review`, 서류 source span, input SHA-256을 동일하게 검증한다. 유료 호출 없이 `--emit-deterministic-drafts`로 unstructured 10건의 규모·지역 criterion 18개를 draft로 내보내고, 현재 DB revision을 대조한 review task 10건·annotation template 10건·network 차단 grant-only HTML workbench를 생성했다. 산출물은 `tmp/bizinfo-deterministic-drafts.jsonl`, `tmp/bizinfo-deterministic-review-tasks.jsonl`, `tmp/bizinfo-deterministic-draft-annotations.jsonl`, `tmp/bizinfo-deterministic-review-workbench.html`이다. 모두 `operationalReady=false`며 독립 사람 검수·reviewed publication 전에는 운영 criterion으로 쓰이지 않는다. 실제 draft annotation을 publication CLI에 넣었을 때 `no reviewed grant annotations found`로 DB 접속·write 전 거부되는 것도 확인했다. K-Startup/BizInfo draft 파서 회귀, review workbench 생성, 루트 typecheck이 통과했고 DB write·paid call은 0이다.

> 진행 메모 (2026-07-12, unreviewed hard-fail safety/ruleset v5): BizInfo deterministic draft 10건·18 criteria를 synthetic 개인 15·법인 15에 적용한 300쌍 read-only 비교에서, 검수 전 criterion이 237쌍을 조기 `ineligible`로 만드는 엔진 안전 공백을 발견했다. deterministic draft 전건에 `needs_review=true`를 강제하고, 매칭 엔진은 검수 전 required/exclusion의 fail을 `unknown + needs_core_review`로 보존하도록 바꿔 `RULESET_VERSION`을 `ruleset-kstartup-spine-v5`로 올렸다. 재측정은 300쌍 중 `conditional→eligible` 39, `conditional→conditional` 261, ineligible 0, tier 300/300 `needs_core_review`, full profile 대비 false/unsafe ineligible 0이다. 현재 활성 1,898건×30프로필 전체는 v4 기준선 대비 initial ineligible 17,394→17,306(-88), conditional 34,594→34,682(+88), recommendable 346 변화 없음이었다. reviewed 또는 검수 불필 구조화 criterion의 기존 hard fail은 그대로 유지한다. `report:match-state-ruleset`을 추가해 저장 상태를 식별자 없이 집계했고, 현재 147,139행이 v1 128 / v2 527 / v3 146,484, v5 0이어서 `refreshRequired=true`다. 기본 데모 회사 1개×1,898건 v5 scoped dry-run은 saved 0, eligible 227 / conditional 1,356 / ineligible 315, recommendable 26 / core review 1,555 / profile input 2 / not recommended 315를 보고했다. 라이브 매칭은 v5를 계산하지만 저장 기반 알림·스냅샷 혼재를 막으려면 운영 배포 후 scoped dry-run→전이 검토→승인된 v5 match_state 재계산이 필요하며 이 회차에는 DB write를 실행하지 않았다.

> 진행 메모 (2026-07-13, ruleset v5 initial stale-row plan — 후속 전체 회사 감사로 범위 대체): 초기 `plan:ruleset-match-state-refresh`는 stale row가 존재한 회사 76개 전부 단일 멤버, 프로필 누락 0, 활성 1,898건을 확인했다. 76×1,898=144,248쌍에서 기존 저장 147,139행, 폐쇄·비활성 삭제 후보 2,891, eligibility 변경 31,996, 버전만 갱신할 후보 112,252였다. 전이는 `ineligible→conditional` 30,820, `ineligible→eligible` 750, `conditional→ineligible` 426이었다. 강화 426쌍은 기업마당 region 6개 공고×71쌍, 완화 750쌍은 기업마당 150개 공고×5쌍이었다. 다만 이 방식은 상태가 전혀 없는 회사 37개를 발견할 수 없었고, 아래 전체 회사 coverage audit 이후 운영 scope는 113개·214,474쌍으로 교체했다. 전이 검토 대상 156개 공고와 기존 행 전이 집계는 유지된다.

> 진행 메모 (2026-07-13, restrictive transition review bridge): `export:ruleset-transition-review-tasks`는 refresh plan의 ruleset/scoring/scope SHA-256을 검증하고 `conditional→ineligible` 공개 공고만 현재 DB title·raw revision과 다시 대조한다. region 강화 공고 6건에 대해 전체 현재 criteria·source field·원문 span을 담은 review task 6건과 draft annotation 6건, grant-only offline workbench `tmp/ruleset-v5-restrictive-transition-review-workbench.html`을 생성했다. workbench는 CSP `connect-src 'none'`이며 company/user ID, archive/storage/source URI 필드가 0건이다. 독립 사람 검수가 완료되지 않았으므로 annotation은 전부 draft, `operationalReady=false`, match_state write 승인 근거로 아직 사용할 수 없다.

> 진행 메모 (2026-07-13, ruleset v5 atomic refresh executor): 기존 행별 `Promise.all` 갱신은 대량 부분 성공과 obsolete 2,891행 잔존 위험이 있어 전체 v5 반영에 재사용하지 않았다. `refresh:ruleset-match-states`는 기본 dry-run이며 `--write --confirm=REFRESH_MATCH_STATES_RULESET_V5`를 모두 요구한다. 계획에는 회사 scope뿐 아니라 as-of, resolved profile, 활성 공고·criteria·extraction manifest, 기존 match_state를 안정 정렬한 비식별 `evaluationInputHash`를 추가했다. 실행 시 같은 입력을 전수 재계산해 plan과 정확히 비교하고, 단일 멤버·활성 우주 완전성·ruleset/scoring·전이 집계도 재검증한다. 실제 write는 30분 이내 fresh plan만 허용하며, advisory lock과 기존 scope `FOR UPDATE` hash를 확인한 단일 transaction에서 scope 전체 삭제 후 회사별 250행 batch insert를 수행하고, 최종 v5 행 수 214,474가 일치하지 않으면 rollback한다. `conditional/eligible→ineligible`뿐 아니라 `ineligible/conditional→eligible`도 추천 안전성에 영향이 있으므로 전체 전이 공고 156건(강화 6, 완화 150)을 독립 검수·reviewed publication 필수 대상으로 확장했다. `tmp/ruleset-v5-all-transition-review-tasks.jsonl`, draft annotation 156건, CSP network 차단 602KB workbench를 생성했다. 실 DB dry-run은 plan/input hash 일치, reviewed 0/156, published 0/156, `writeReady=false`를 확인했고 확인 문자열 없는 `--write`는 DB 접속 전에 거부됐다. DB write는 실행하지 않았다.

> 진행 메모 (2026-07-13, whole-company match_state coverage correction): `report:match-state-coverage`로 stale 행 유무가 아니라 전체 `companies`를 분모로 재감사했다. 전체 113개 회사는 모두 단일 멤버·프로필 resolve 성공이지만, 76개만 활성 1,898건 상태가 완전하고 37개는 저장 상태가 0건이었다. 따라서 stale-row 기반 계획은 70,226개 활성 pair를 누락했다. 계획기와 실행기 scope를 `단일 멤버 + 프로필 resolve + 현재 ruleset 활성 공고 coverage 미완료`로 교체해 대상 113개, 계획 214,474행, 기존 147,139행, missing active 70,226행, obsolete 2,891행으로 재생성했다. 새 scope hash는 `541eadfd1245ed0e72c51bd3790637a82dc6bbd4a379aedb3c16162bd7aab798`이며 계획/실행 input hash가 일치한다. 기존 행의 강화 6·완화 150 검토 목록은 변하지 않았고 새 scope hash로 task/annotation/workbench를 다시 생성했다. DB write는 0이다.

> 진행 메모 (2026-07-13, first-mission HTTP re-verification): 사용자가 실행 중인 `127.0.0.1:4010` 서버를 재사용했다. DB route verifier는 invalid 사업자번호 paid-call 전 차단, manual profile teaser 성공, 응답 8건과 평가 universe 1,898건 분리, 명시적 nextQuestion, `모름` 질문 반복 억제, web/app universe parity를 통과했다. 실제 HTTP `POST /api/web/teaser`도 법인 target type 프로필에서 1,898건 평가·8건 반환·첫 질문 `biz_age`를 반환했고 `/dev/service-data`는 HTTP 200이었다. 다른 세션 소유의 자동채움 가이드와 dev page는 수정하지 않았다. 연결된 인앱 브라우저가 없어 시각 검수는 수행하지 못했으며 DB write·유료 connector 호출도 실행하지 않았다.

> 진행 메모 (2026-07-12, first-result runtime path): 로그인 후 dashboard/matches/next-question가 `limit=40`을 공고 평가 범위와 화면 반환 수에 함께 사용해 최신 40건만 판정하던 오류를 수정했다. 이제 기본 최대 5,000건(+1 sentinel)까지 활성 공고 전체를 평가하고 상위 12~40건만 반환·`match_state` 저장한다. 상한 초과 시 일부 결과를 정상 응답으로 가장하지 않고 `active_grant_scan_incomplete`로 실패한다. 사업자정보 보강 API 응답의 `initialMatch`에는 평가 공고 수, recommendation tier 집계, 상위 공고, 다음 최소 질문, ruleset/scoring version이 포함된다. 잘못된 checksum은 유료 조회 전에 400으로 차단한다. read-only 실제 DB 검증은 활성 1,898건 전체 평가/12건 반환, eligible 45·conditional 1,853, recommendable 17·reviewNeeded 1,881, 다음 질문 `region`(49건 영향)이었으며 CLI+DB 포함 2.73초였다. `buildDashboard`의 전 공고 이중 매칭도 단일 패스로 줄였다. 별도로 web/app matches API는 1,898개 전체 카드 집합을 만든 뒤 cursor/status/sort를 적용하도록 변경했고 전체 카드 조립도 2.87초였다. app 응답은 필터 적용 후 `total`을 명시한다. 실제 사업자번호 enrich write와 브라우저 결과 갱신은 사용자가 개발 서버를 실행한 뒤 검증한다.

> 진행 메모 (2026-07-12, stable match pagination): 실행 중인 `127.0.0.1:4010` web 서버에서 read-only matches API를 호출해 첫 두 페이지 사이 공고 1건이 중복되는 문제를 발견했다. 다수 공고의 recommendation/priority/deadline/fit이 모두 같을 때 정렬이 DB 입력 index에 의존한 것이 원인이었다. `sortMatchedGrants`의 최종 tie-break를 stable `grantId`로 고정하고 입력 배열을 역순으로 넣어도 같은 순서를 만드는 회귀 테스트를 추가했다. 수정 후 `total=1,898`, page cursor `5→10`, 페이지 간 overlap 0, `status=ineligible` 필터 total 318/반환 5건을 HTTP 200으로 확인했다. warm dev 응답은 약 2.1~2.4초였다. 인앱 브라우저 backend가 없어 시각 검수는 수행하지 못했지만 dev 페이지 자체는 HTTP 200이었다.

> 진행 메모 (2026-07-12, full-universe question transition): web/app 프로필 질문 저장 경로가 전후 impact를 최신 40건에서만 계산하던 불일치를 제거하고 첫 결과와 같은 최대 5,000건 sentinel universe를 사용한다. 저장 응답 `CompanyProfileUpdateResult`에 갱신된 `initialMatch`를 필수로 추가해 profile, 전체 전환 impact, telemetry receipt, 추천/확인 필요 집계, 상위 공고, 다음 질문을 한 번에 반환한다. ProgressiveQuestionCard는 이 응답으로 현재 추천/확인 필요 수를 즉시 안내한 뒤 화면을 refresh한다. `first-mission-flow.test.ts`에서 reviewed 대표자 연령 공고 60건이 답변 전 conditional 60/질문 영향 60에서 답변 후 eligible 30·ineligible 30·conditional 0, resolution rate 1.0으로 바뀌는 전체 흐름을 검증했다. 실제 운영 데이터의 해소율 목표 달성 증거는 아니며, 사용자 E2E와 최소 30개 실제 event 측정은 계속 필요하다.

> 진행 메모 (2026-07-12, profile evidence preservation): 자동채움 dev 하네스의 `sourceKind/asOf/axisCompleteness`가 실제 `CompanyProfile` 저장에서 confidence만 남기고 사라지는 경계를 보완했다. `profile_evidence[dimension]`은 `authoritative_api/public_registry/auth_supplied/self_declared/derived`, provider, 기준시각, 완전성, 해당 관측 confidence를 값과 분리해 보존한다. web/app 질문 저장은 서버가 `self_declared`, `cunote_profile_question`, 동일 `asOf`를 지정한다. 권위 원천의 scalar/replace 값은 확인 절차 없이 자가응답으로 덮어쓸 수 없고, positive-only 목록 `merge`는 권위 primary evidence를 유지하면서 self-declared 관측을 `supplemental`에 추가한다. merge confidence는 기존 최대 confidence와 사용자 관측 confidence를 혼동하지 않도록 각각 보존한다. DB는 JSON profile을 사용하므로 migration은 필요 없다. 자동조회 커넥터가 이 메타를 실제 profile에 붙이는 승격 작업은 병행 자동채움 세션의 source-specific 결과 계약을 따른다.

> 진행 메모 (2026-07-12, source evidence promotion slice): 현재 제품 보강 경로의 Popbill/NTS/SMPP 값을 `profile_evidence`에 연결했다. Popbill 지역·업종·사업상태는 `authoritative_api`, 설립일 파생 업력·기업규모 후보는 `derived`로 구분하며 업종은 positive-only `partial`이다. NTS 휴·폐업 상태는 `authoritative_api/nts/complete`로 business_status primary를 교체한다. SMPP 여성·장애인 보유 확인은 founder_trait·certification에 `authoritative_api/smpp/partial`로 추가하며 certification confidence를 known으로 만들지 않는다. 기존 primary가 있으면 supplemental 관측으로 보존한다. NTS 11개, SMPP 11개, KSIC/Popbill 33개 검증이 통과했다. positive-only SW 업종만으로 “제조업 제외”를 자동 통과시키던 오래된 테스트 기대도 현행 안전 정책에 맞춰 unknown으로 고치고, 업종 목록이 `complete`일 때만 pass하는 대조 검증을 추가했다. KCOMWEL·FSC·CODEF·registry 등 병행 세션 커넥터는 각 source 결과가 확정되는 순서대로 같은 계약에 승격해야 한다.

> 진행 메모 (2026-07-12, enrichment merge boundary): source profile에 evidence를 붙여도 최종 `mergeCompanyProfilesForEnrichment()`가 이를 버리고, revenue/employees/ip/target_types/financial_health/insured_workforce/investment를 아예 병합하지 않던 저장 경계를 수정했다. 이제 전체 구조화 프로필 축을 병합하며 source priority는 authoritative API > public registry > auth supplied > self declared > derived 순이다. 같은 원천 등급은 최신 `asOf`가 primary가 되고 나머지는 supplemental에 남는다. 낮은 우선순위 derived 값은 기존 FSC 권위 매출을 덮지 못하고, complete 권위 목록은 partial 자가값을 교체하며, partial 목록은 합집합으로 보존한다. list completeness와 원천별 confidence도 함께 병합한다. 확장 verifier는 KCOMWEL 직원, KIPRIS IP, FSC 재무, 고용보험, 투자, target type, 증거 우선순위와 supplemental 보존을 포함한 7개 경계를 검증한다. 이로써 병행 세션의 KCOMWEL/FSC/CODEF/registry connector가 `CompanyProfile`과 `profile_evidence`를 반환하면 별도 필드별 저장 배선 없이 제품 merge가 소비할 수 있다.

> 진행 메모 (2026-07-12, explicit unknown answer state): 질문의 `모름`을 profile 값이나 confidence로 저장하지 않는 `question_answer_state[dimension]` 계약을 추가했다. 상태는 self-declared, answeredAt, expiresAt, ruleset을 보존하고 기본 TTL 30일 동안 같은 dimension을 planner 후보에서 제외한다. TTL 만료 후에는 질문이 다시 가능하며 실제 사용자 값 저장 또는 더 높은 우선순위 connector evidence 적용 시 해당 unknown 상태가 제거된다. web/app profile field API는 `{field, unknown:true}`를 받고 동일한 impact/event/initialMatch 응답을 반환한다. ProgressiveQuestionCard의 checklist/number group/scalar 모두 기본값 없는 `모름` 버튼을 제공한다. 60개 공고 flow에서 모름 후 조건부 60건이 그대로 유지되면서 동일 질문만 숨겨지고, 실제 답변 후 eligible 30/ineligible 30으로 전환되는 것을 검증했다. enrichment verifier는 적용되지 않은 낮은 우선순위 derived 매출이 unknown을 지우지 않고, 실제 적용된 KCOMWEL 직원 evidence만 unknown을 지우는 경계를 확인한다.

---

## 0. 한 줄 결론

현재 시스템은 **구조화된 조건을 판정하는 규칙 엔진은 강하지만**, 공고 조건 추출의 완전성, 사업자 프로필 자동 채움, 실제 운영 평가셋이 약하다. 따라서 다음 순서로 개선한다.

1. 실제 정확도를 측정할 평가셋과 지표를 먼저 만든다.
2. `지원자격`, `확인완성도`, `관련성`, `추천우선순위`를 분리한다.
3. 공고 조건 추출 누락을 측정하고, 근거가 부족한 `eligible`을 사용자에게 확정 표현하지 않는다.
4. 사업자번호 자동 조회 후 **현재 후보 공고를 가장 많이 확정하는 최소 질문**만 묻는다.
5. 공급원을 확장하되, 순증 공고와 중복률을 측정해 가치가 있는 소스만 유지한다.
6. 실제 사용자 피드백과 신청 결과를 평가셋으로 환류한다.

---

## 1. 미션과 제품 계약

### 1.1 첫 미션

입력:

- 개인 또는 법인 사업자의 사업자등록번호
- 사업자번호로 자동 확보할 수 없는 최소 추가 정보
- 필요할 때만 사용자가 제공하는 증빙 또는 인증 동의

출력:

- 현재 확인된 정보로 지원 가능성이 높은 공고
- 한두 가지 정보만 더 확인하면 판정 가능한 공고
- 공고 원문 검토가 필요한 공고
- 확인된 필수조건 때문에 현재 신청할 수 없는 공고
- 각 판정의 통과·미확인·불충족 조건과 원문 근거

### 1.2 사용자에게 보장하는 것과 보장하지 않는 것

보장:

- 확인하지 못한 필수조건을 자동 통과시키지 않는다.
- 탈락 판정에는 반드시 구조화된 hard fail 근거가 있다.
- 추천 판정에는 공고 원문 근거와 기업정보 출처가 있다.
- 정보가 부족하면 해당 공고를 숨기지 않고 확인 필요 상태로 남긴다.

보장하지 않음:

- 최종 선정 가능성 예측
- 기관의 법적·행정적 최종 자격심사를 대체
- 사업자번호 하나만으로 모든 개인사업자 재무·체납·수혜이력을 자동 확정
- 공고문에 없는 심사위원의 정성 평가 예측

### 1.3 제품 문구 계약

내부 enum은 당분간 `eligible | conditional | ineligible`을 유지하되 사용자 문구는 아래로 고정한다.

| 내부 상태·게이트 | 사용자 문구 | 허용 조건 |
|---|---|---|
| `eligible + recommendable` | 지원 가능성이 높아요 | 핵심 조건 구조화·프로필 확인·근거 보유 |
| `conditional + needs_profile_input` | 이 정보만 확인하면 판정할 수 있어요 | 사용자 답변으로 해소 가능한 unknown |
| `conditional + needs_core_review` | 공고 원문 확인이 필요해요 | 추출 누락·text_only·검수 필요 |
| `ineligible + not_recommended` | 현재는 지원이 어려워요 | required/exclusion hard fail 존재 |

서비스 어디에서도 `eligible`만 보고 “지원 가능 확정”으로 표현하지 않는다.

---

## 2. 현재 상태 기준 진단

### 2.1 유지할 자산

- `packages/core/src/matching/match.ts`
  - 22개 criterion dimension 평가
  - required/exclusion hard fail
  - unknown 보수 처리
  - 결격 `known_flags` 게이트
  - `rule_trace`, `next_question`, `review_gate`
- `packages/core/src/bizinfo/llm-criteria.ts`
  - 기업마당 원문·첨부 기반 구조화
- `packages/core/src/kstartup/normalize.ts`
  - K-Startup structured 필드 정규화
- `packages/core/src/dedup/grant-dedup.ts`
  - 공급원 간 중복 후보 연결
- `apps/web/src/lib/server/matches/matchFeedback.ts`
  - 사용자·검수자 피드백 저장 기반
- `apps/web/src/lib/server/admin/matchingEval.ts`
  - 평가 실행·조회 기반
- 기존 상세 계획
  - `2026-07-11-matching-dimension-expansion.md`
  - `2026-07-11-matching-data-sourcing.md`
  - `2026-07-12-사업자번호-우선-자동채움-실행가이드.md`
  - `2026-07-12-audience-gate.md`
  - `2026-07-12-prior-award-structuring.md`

### 2.2 현재 가장 큰 정확도 위험

1. **추출 누락 false eligible**\
   공고 조건을 하나 놓치면 evaluator는 그 조건의 존재를 알 수 없다.
2. **기업 프로필 결손**\
   사업자번호 자동조회가 region·biz_age·business_status·industry 일부에 편중돼 있다.
3. **점수 의미 혼합**\
   현재 `fit_score`는 사실상 조건 확인 비율인데 사용자에게 적합도로 읽힐 수 있다.
4. **평가셋 과소**\
   현재 golden은 6건+3건으로 회귀 테스트에는 유효하지만 운영 정확도 주장의 근거가 아니다.
5. **공급원 중복과 수정 이력**\
   같은 공고가 K-Startup·기업마당·부처 사이트에 중복되고, 연장·수정·재공고가 별개 공고처럼 보일 수 있다.
6. **개인 대상 공고 혼입**\
   사업자 서비스 매칭 우주에 개인·학생·일반인 전용 공고가 들어오면 추천 품질이 희석된다.

---

## 3. 성공 지표와 배포 게이트

### 3.1 핵심 품질 지표

단순 accuracy를 주지표로 사용하지 않는다.

| 지표 | 정의 | MVP 배포 게이트 | 안정화 목표 |
|---|---|---:|---:|
| `eligible_precision` | 추천 가능으로 분류한 쌍 중 전문가 기준 실제 지원 가능 비율 | ≥ 0.90 | ≥ 0.95 |
| `eligible_recall` | 실제 지원 가능한 쌍 중 추천 또는 확인 필요로 보존한 비율 | ≥ 0.95 | ≥ 0.98 |
| `ineligible_precision` | 지원 어려움으로 제외한 쌍 중 실제 hard fail 비율 | ≥ 0.97 | ≥ 0.99 |
| `criteria_required_recall` | 공고 필수조건 중 구조화하거나 명시적 text_only로 보존한 비율 | ≥ 0.90 | ≥ 0.95 |
| `criteria_exclusion_recall` | 공고 제외조건 중 구조화하거나 명시적 text_only로 보존한 비율 | ≥ 0.95 | ≥ 0.98 |
| `evidence_coverage` | 판정에 사용한 criterion 중 source span 또는 structured source field가 있는 비율 | 100% | 100% |
| `conditional_resolution_rate` | 추가질문 완료 후 conditional이 확정되는 비율 | ≥ 0.60 | ≥ 0.80 |
| `question_burden_p50` | 첫 유용 결과까지 사용자가 답한 추가 질문 수 | ≤ 3 | ≤ 2 |
| `fresh_active_coverage` | 활성 공고 중 최신 원문·마감일·상태가 검증된 비율 | ≥ 0.95 | ≥ 0.99 |

### 3.2 오분류 비용 원칙

- false ineligible: 사용자가 받을 수 있는 지원을 놓치므로 가장 위험하다.
- false eligible: 제품 신뢰를 직접 훼손하므로 recommendable 게이트에서 엄격히 차단한다.
- 애매한 경우: 숨기지 않고 `conditional`로 보존한다.
- extractor가 불확실한 경우: criterion을 삭제하지 말고 `text_only + source_span`으로 남긴다.

### 3.3 평가 표본 최소 조건

운영 정확도 숫자를 외부에 사용하려면 다음을 충족해야 한다.

- 공고 100건 이상
- K-Startup과 기업마당 각각 30건 이상
- 지역·업력·업종·기업규모·개인/법인 층화
- 기업 프로필 30개 이상
- 기업×공고 판정쌍 500개 이상
- 개발셋과 holdout 분리
- 동일 인물이 만든 정답만으로 평가하지 않고 최소 20% 이중 라벨링

---

## 4. 목표 아키텍처

```text
[공고 공급원]
  K-Startup / 기업마당 / 과기정통부 / 후속 NTIS
        ↓
[원문·첨부 아카이브 + revision]
        ↓
[audience 분류 + 중복/연장/수정 연결]
        ↓
[자격조건 추출]
  criterion + source_span + source_field + confidence + review state
        ↓
[공고 준비도 게이트]
  recommendable / profile-input / core-review
        ↓
[사업자 프로필]
  authoritative API → registry → auth supplied → self declared → derived
        ↓
[규칙 판정]
  eligibility + rule trace
        ↓
[별도 점수]
  verification completeness / relevance / priority
        ↓
[사용자 결과]
  가능성 높음 / 정보 확인 / 원문 확인 / 지원 어려움
        ↓
[피드백·신청 결과]
  평가셋 후보 → 검수 → golden 승격
```

핵심 불변식:

- 공고 준비도와 회사 준비도는 별개다.
- 자격 판정과 관련성 순위는 별개다.
- 원문 개정 시 이전 추출 결과를 덮어쓰지 않고 revision 기준으로 재계산한다.
- 외부 API 실패는 기존 프로필을 삭제하지 않고 fail-open 한다.
- 값의 부재와 조회 실패를 구분한다.

---

## 5. 계약 변경 설계

### 5.1 `MatchResult` 확장

파일:

- `packages/contracts/src/index.ts`
- `packages/contracts/src/dto.ts`
- `packages/contracts/src/openapi.ts`
- `packages/core/src/matching/match.ts`

추가 계약:

```ts
interface MatchQuality {
  eligibilityConfidence: "high" | "medium" | "low";
  verificationCompleteness: number; // 0..100, 필수조건 확인 완성도
  evidenceCoverage: number;         // 0..100
  extractionReadiness:
    | "reviewed"
    | "structured_unreviewed"
    | "partial"
    | "unstructured";
}

interface MatchRanking {
  relevanceScore: number | null; // 자격과 분리
  priorityScore: number | null;  // 마감·혜택·준비비용 포함
  reasons: string[];
}
```

`MatchResult`에 다음 optional 필드를 추가한다.

```ts
quality?: MatchQuality;
ranking?: MatchRanking;
```

하위 호환:

- `fit_score`는 즉시 제거하지 않는다.
- 1차에서는 `fit_score = verificationCompleteness`로 의미를 명확히 하고 UI 명칭을 “확인도”로 바꾼다.
- `relevanceScore`가 검증되기 전에는 적합도 퍼센트를 표시하지 않는다.
- OpenAPI 필드는 optional로 추가하고 소비자 전환 후 별도 버전에서 `fit_score` 폐기를 검토한다.

### 5.2 criterion 추출 품질 메타

`GrantCriterion`에 이미 있는 `source_span`, `source_field`, `needs_review`를 유지하고 다음을 추가한다.

```ts
extraction_method?: "structured" | "deterministic" | "llm" | "reviewer";
extraction_confidence?: number; // 0..1
document_revision?: string;
```

추가 불변식:

- required/exclusion criterion은 `source_span` 또는 검증된 structured field를 반드시 가진다.
- LLM criterion은 reviewer 승인 전 `extraction_method=llm`, `needs_review=true`가 기본이다.
- deterministic parser도 원문 span 없이 새 고위험 criterion을 만들지 않는다.
- 원문 전체를 `raw_text`에 복제하지 않는다.

### 5.3 회사 프로필 원천 메타

기존 dimension별 value/confidence에 다음 공통 메타를 저장할 수 있어야 한다.

```ts
interface CompanyProfileFactMeta {
  sourceType:
    | "authoritative_api"
    | "public_registry"
    | "auth_supplied"
    | "self_declared"
    | "derived";
  provider: string;
  observedAt: string;
  expiresAt?: string | null;
  confidence: number;
  status: "live" | "cached" | "stale" | "failed" | "not_applicable";
}
```

1차 구현은 기존 `company_profiles` 행의 `source`, `confidence`, JSON value를 활용한다. dimension별 provenance 조회가 불가능하면 별도 `meta` JSON 또는 profile fact table 확장을 Phase 4에서 결정한다.

### 5.4 목록형 프로필의 완전성 계약

업종·대표자 속성·인증·기수혜·지식재산·신청대상은 값이 하나 존재한다는 사실과, 그 외 값이 존재하지 않는다는 사실을 분리한다.

```ts
type ListProfileCompleteness = "partial" | "complete";

interface CompanyProfile {
  list_completeness?: Partial<Record<
    "industry" | "founder_trait" | "certification" | "prior_award" | "ip" | "target_type",
    ListProfileCompleteness
  >>;
}
```

- `partial` 또는 미설정: positive-only다. exact hit는 pass/fail 근거가 되지만 no-hit는 `unknown`이다.
- `complete`: 사용자가 전체 목록을 명시 제출했거나 소진적 authoritative source로 확인했다. 이때만 no-hit를 required fail 또는 exclusion pass로 쓸 수 있다.
- 점진 질문의 단일 선택은 `merge + partial`로 저장한다.
- 설정의 전체 목록 저장은 `replace + complete`로 저장한다.
- 기존 DB 행은 완전성 값이 없으므로 자동으로 positive-only로 해석한다. 별도 마이그레이션 없이 JSON value에 함께 저장한다.
- 질문 planner는 positive-only 단일 답변을 `resolvesGrantCount`에 포함하지 않는다.

이 계약은 “ISO 인증 하나를 입력했으니 여성기업 인증은 없다”, “ICT를 입력했으니 게임업은 아니다” 같은 false ineligible을 차단한다.

---

## 6. Phase 0 — 평가 기준선과 골든셋 구축

> 최우선. 이 단계 없이 extractor·소싱을 개선하면 좋아졌는지 증명할 수 없다.

### 6.1 신규 디렉터리

```text
packages/core/golden/matching-v3/
  README.md
  grants.jsonl
  company-profiles.jsonl
  eligibility-pairs.jsonl
  annotation-schema.json
  holdout-manifest.json
```

대용량 원문과 첨부는 저장소에 직접 복제하지 않고 기존 archive ID와 checksum을 참조한다. 저작권·개인정보가 없는 짧은 근거 span만 fixture에 둔다.

### 6.2 라벨 스키마

공고 라벨:

- audience: company / individual / mixed / unknown
- required criteria
- exclusion criteria
- preference criteria
- criterion별 dimension, operator, value
- criterion별 source span
- extractor가 구조화하지 못해도 보존해야 하는 text-only 조건
- reviewer confidence와 이견 메모

기업×공고 라벨:

- expected eligibility
- hard fail criterion IDs
- unknown criterion IDs
- 추가 질문으로 해소 가능한지
- 판단 불가능 사유
- 정답 근거

### 6.3 신규 평가 스크립트

파일:

- `packages/core/scripts/report-criteria-extraction-eval.ts` (`--verify`로 배포 gate 실행)
- `packages/core/scripts/verify-matching-eval-v3.ts`
- `packages/core/scripts/report-matching-eval.ts`

출력:

- 전체 및 소스별 precision/recall
- dimension별 extraction recall
- required/exclusion 분리 recall
- 개인/법인, 지역, 업력, 업종별 eligibility metric
- `eligible → conditional`, `conditional → eligible`, `eligible → ineligible` confusion matrix
- source span 없는 판정 수
- 추천 가능으로 잘못 승격된 건의 목록

package scripts:

```json
"report:criteria-extraction-eval": "tsx packages/core/scripts/report-criteria-extraction-eval.ts",
"verify:criteria-extraction-eval": "tsx packages/core/scripts/report-criteria-extraction-eval.ts --verify",
"verify:matching-eval-v3": "tsx packages/core/scripts/verify-matching-eval-v3.ts",
"report:matching-eval": "tsx packages/core/scripts/report-matching-eval.ts"
```

현재 구현:

- `parseV3AnnotationJsonl()`은 company/grant/pair 계약, criterion enum, ID 중복을 검증한다.
- `evaluateCriterionExtraction()`은 structured recovery와 text-only preservation을 분리하고 source/dimension/kind별 recall을 출력한다.
- `report:criteria-extraction-eval`은 reviewed 파일이 없으면 `operationalReady=false`로 정상 보고한다.
- `verify:criteria-extraction-eval`은 reviewed 라벨, required recall 0.90, exclusion recall 0.95, gold evidence coverage 1.0을 충족하지 못하면 실패한다.
- `export:matching-v3-review-tasks`는 현재 DB·K-Startup sample에서 redacted 검수 task와 별도 draft annotation template을 만든다.
- `parseKStartupCriteriaDraftJsonl()`은 draft/error JSONL, provenance, review-only 불변식과 제출서류 근거를 검증한다.
- `export:kstartup-draft-review-tasks`는 K-Startup LLM draft를 현재 공고와 대조한 검수 패킷으로 변환한다.
- `planReviewedGrantPublication()`과 `publish:reviewed-grant-annotations`는 사람 검수 완료 annotation만 운영 criterion으로 승격한다.

### 6.3.1 K-Startup draft → review → publish 실행 계약

1. 외부 호출 없이 후보와 입력 완전성을 확인한다.

```bash
pnpm extract:kstartup-criteria-drafts -- --limit=5
```

2. 비용과 대상 source ID를 승인한 경우에만 LLM draft를 만든다. 이 결과는 DB에 쓰이지 않으며 항상 `operationalReady=false`다.

```bash
pnpm extract:kstartup-criteria-drafts -- \
  --extract \
  --confirm=EXTRACT_KSTARTUP_CRITERIA \
  --sourceIds=<comma-separated-source-ids> \
  --output=tmp/kstartup-llm-drafts.jsonl
```

3. 현재 DB 공고와 대조한 검수 task와 annotation template을 생성한다.

```bash
pnpm export:kstartup-draft-review-tasks -- \
  --input=tmp/kstartup-llm-drafts.jsonl \
  --output=tmp/kstartup-llm-review-tasks.jsonl \
  --annotations-output=tmp/kstartup-llm-draft-annotations.jsonl
```

4. annotator가 source field·첨부·근거 span을 확인해 criterion을 수정하고 `annotatorId`, ISO `annotatedAt`을 기록한다. 서로 다른 사람인 reviewer가 누락·과잉 구조화를 다시 확인한 뒤에만 `labelStatus=reviewed`, `reviewerId`, ISO `reviewedAt`을 기록한다. exporter가 넣은 `sourceRevision`은 수정하지 않는다. 예측을 그대로 승인하거나 source span이 없는 structured criterion을 만들지 않는다.

5. 게시 계획을 먼저 읽기 전용으로 확인한다. 한 파일에 섞인 `draft|legacy`는 `unreviewedAction=skipped`로 보고되며 게시 대상이 아니다.

```bash
pnpm publish:reviewed-grant-annotations -- \
  --input=tmp/kstartup-llm-draft-annotations.jsonl
```

6. 계획의 공고·criterion 수, reviewer, `sourceRevision`을 승인한 뒤에만 게시한다. 검수 뒤 공고가 갱신됐다면 게시가 실패하므로 새 review packet으로 다시 검수한다.

```bash
pnpm publish:reviewed-grant-annotations -- \
  --input=tmp/kstartup-llm-draft-annotations.jsonl \
  --write \
  --confirm=PUBLISH_REVIEWED_GRANT_ANNOTATIONS
```

게시 transaction은 공고 criterion 교체, positive industry projection 병합, parser/confidence 갱신, stale match_state 삭제, labeled extraction log 기록을 한 단위로 처리한다. 게시 후 `matchStateRefreshRequired=true`가 출력되며, 관련 회사 범위의 match-state refresh가 완료되기 전에는 배포 완료로 보지 않는다. 현재 구현은 stale 상태를 안전하게 삭제하지만 모든 회사 재계산을 자동 실행하지 않는다.

### 6.4 표본 선정 순서

1. 활성 공고 60건: K-Startup 30, 기업마당 30
2. 마감 공고 40건: 수정·연장·복잡한 첨부 중심
3. 조건 빈도 기준 층화: 지역, 업력, 업종, 인증, 매출, 고용, 결격, prior_award
4. 회사 프로필 30개: 개인/법인 각 15개 이상
5. 쌍 생성: 명백한 pass/fail과 애매한 conditional을 균형 있게 구성
6. 70% development, 30% holdout 고정

### 6.5 완료 기준

- [ ] 공고 100건 라벨 완료
- [ ] 기업 프로필 30건 라벨 완료
- [ ] 판정쌍 500건 이상
- [x] 공고 100·회사 30·판정쌍 500 draft review packet 및 development 350 / holdout 150 사전 분리
- [x] 개인 2·법인 1 synthetic profile draft와 30×3=90 pair review packet 생성
- [x] 라벨 확인 전 development 63 / holdout 27 사전 고정 및 기본 holdout 비공개 gate
- [ ] synthetic profile 3건과 pair 90건 독립 사람 검수
- [ ] holdout은 extractor 프롬프트·규칙 개발 중 열람하지 않음
- [ ] 기존 v1/v2 golden 100% 유지
- [ ] metric report가 CI와 로컬에서 재현됨

---

## 7. Phase 1 — 점수와 상태 의미 분리

### 7.1 엔진 변경

`packages/core/src/matching/match.ts`:

- `scoreFit()`을 `scoreVerificationCompleteness()`로 분리한다.
- eligibility 계산은 기존 hard fail/unknown 규칙을 유지한다.
- 확인도 계산 시 required와 exclusion만 분모에 포함하고 preference는 제외한다.
- `text_only`, `needs_review`, source span 부재는 미확인으로 센다.
- authoritative profile과 self-declared profile은 eligibility 결과는 같아도 confidence에서 구분한다.
- extraction readiness가 `partial/unstructured`이면 recommendable 금지.

권장 계산:

```text
verificationCompleteness =
  confirmed_required_or_exclusion_weight /
  all_required_or_exclusion_weight * 100
```

가중치 초기값:

- exclusion: 2
- required core dimension: 2
- required non-core: 1
- preference: 계산 제외

가중치는 학습하지 않고 고정 설정으로 시작하며 평가셋 결과로만 변경한다.

### 7.2 관련성 점수 v1

신규 파일:

- `packages/core/src/matching/relevance.ts`
- `packages/core/src/matching/relevance.test.ts`

자격과 독립적으로 계산한다.

입력:

- 회사 KSIC/업태/종목/상품·서비스 키워드
- 공고 지원분야, 목적, 업종, 기술분류
- 회사가 선택한 관심목표: 사업화, 고용, R&D, 수출, 자금, 공간 등

v1은 임베딩보다 설명 가능한 taxonomy/keyword 점수로 시작한다.

- industry exact/ancestor match
- support category match
- company goal match
- region/biz age는 eligibility에만 사용하고 relevance 중복 가점 금지

완료 전에는 UI에 퍼센트를 표시하지 않고 정렬 보조로만 사용한다.

구현 상태(2026-07-12): 완료. 업종/KSIC 70점, 관심 목표 30점의 고정 가중치를 사용한다. `개발`, `제조`, `기술`, `서비스` 같은 범용 토큰은 제외하며, 계산 근거가 없으면 0이 아니라 `null`을 반환한다. 운영 분포의 낮은 점수를 임의 보정하지 않고 업종 추출 coverage 개선 대상으로 남긴다.

### 7.3 우선순위 점수 v1

신규 파일:

- `packages/core/src/matching/priority.ts`

입력:

- 마감일까지 남은 시간
- 지원금/혜택 구조화 여부
- required document 수
- 미확인 조건 수
- 사용자가 저장·관심 표시한 카테고리

우선순위는 eligibility를 뒤집지 않는다. 정렬 키 순서는 고정한다.

```text
recommendation tier
→ eligibility
→ extraction readiness
→ relevance score
→ priority score
→ deadline
```

구현 상태(2026-07-12): 완료. 종료 공고는 0점이며, 점수와 이유는 MatchResult/MatchCard의 optional `ranking`에 실린다. 기존 저장된 match state의 자격 결과를 시간에 따라 오염시키지 않도록 dashboard/teaser 조립 시점에 계산한다.

### 7.4 카드·API·UI 변경

파일:

- `packages/core/src/use-cases/match-card.ts`
- `packages/core/src/use-cases/select-match-cards.ts`
- `packages/core/src/use-cases/build-teaser.ts`
- `apps/web/src/features/match-results/Programs.tsx`
- 관련 API route와 OpenAPI 계약

변경:

- `fitScore` 라벨을 “확인도”로 변경
- 관련성은 검증 전 `높음/보통/낮음` 또는 숨김
- 추천 가능 / 정보 확인 / 원문 확인 / 지원 어려움 4개 bucket
- 각 카드에 판정 근거, 데이터 기준일, 다음 질문 표시
- teaser는 recommendable만 “가능성이 높음” 섹션에 넣는다.

### 7.5 완료 기준

- [x] eligibility와 verification score가 독립 테스트됨
- [x] extraction partial 공고가 100점 추천으로 노출되지 않음
- [x] 관련성이 낮아도 eligibility 판정은 변하지 않음
- [x] 기존 API consumer가 optional 필드 추가로 깨지지 않음
- [x] UI에서 “적합도 72%” 같은 혼합 의미 표현이 사라짐

---

## 8. Phase 2 — 공고 조건 추출 완전성 개선

### 8.1 문서 단위 추출 준비도

공고별로 다음 상태를 계산한다.

```ts
type ExtractionReadiness =
  | "reviewed"
  | "structured_unreviewed"
  | "partial"
  | "unstructured";
```

판정 기준:

- `reviewed`: 핵심 source fields와 첨부 원문이 처리됐고 reviewer 또는 golden 검증 완료
- `structured_unreviewed`: 모든 필수 섹션을 처리했으나 사람 검수 전
- `partial`: 첨부 누락, 변환 실패, 일부 섹션만 처리
- `unstructured`: criteria 0 또는 원문 접근 불가

### 8.2 입력 완전성 manifest

신규 타입:

```ts
interface GrantExtractionManifest {
  grantId: string;
  revision: string;
  sourceFieldsSeen: string[];
  attachmentsExpected: number;
  attachmentsFetched: number;
  attachmentsConverted: number;
  sectionsDetected: string[];
  extractorVersion: string;
  completedAt: string;
  warnings: string[];
}
```

파일 후보:

- `packages/core/src/extraction/manifest.ts`
- `apps/web/src/lib/server/ingestion/normalizedGrantPublisher.ts`
- `apps/web/src/lib/server/ingestion/grantAttachmentArchive.ts`
- `apps/web/src/lib/server/ingestion/normalize-grant-documents.ts`

DB는 기존 archive/insight 구조 재사용 가능성을 먼저 확인한다. 불가능하면 `grant_extraction_runs` 테이블을 추가한다.

현재 구현 결정:

- 별도 마이그레이션 없이 `raw + criteria + grant_attachment_archives + grant_application_surfaces`에서 소비 시점 manifest를 계산한다.
- `preview_ready|fields_ready` surface는 converted, `failed`는 failed, `pending`은 incomplete로 해석한다.
- archive `skipped`는 처리 완료 상태로 보되 converted 수에는 포함하지 않는다.
- criteria 0건, text_only, needs_review, hard criterion 근거 누락, source field/section 누락, 첨부 fetch/conversion 상태를 서로 다른 warning code로 기록한다.
- `matchNormalizedGrant()`를 제품 경로의 진입점으로 사용해 criteria-only 테스트 경로와 공고 전체 추천 경로를 분리한다.
- `report:extraction-readiness`는 회사 프로필과 무관하게 source별 readiness와 우선 검수 표본을 출력한다.

권장 컬럼:

- grant_id, revision, status
- extractor/ruleset/model version
- input checksum
- attachments expected/fetched/converted
- criteria count by kind
- warning codes
- started_at/completed_at
- unique(grant_id, revision, extractor_version)

### 8.3 K-Startup 추출

우선순위:

1. structured fields를 SSOT 근거로 사용
2. `aply_trgt_ctnt`, `aply_excl_trgt_ctnt`, `prfn_matr`를 각각 독립 섹션으로 파싱
3. 상세 원문·첨부의 자격/제외/우대 섹션으로 보완
4. 동일 span을 deterministic과 LLM이 중복 발행하지 않도록 consumed-span 적용
5. 구조화 실패 문장은 `other/text_only`로 보존

현재 구현:

- `kstartup-field-parser-v3`: deterministic positive industry projection, exclusion 분리
- `buildKStartupExtractionInput`: API/detail/attachment source block과 source field 보존
- `kstartup-llm-criteria-v1`: source-span containment gate, LLM 전건 review gate, deterministic 우선 병합
- `report:kstartup-extraction-candidates`: 활성 text-only 후보·입력 완전성 read-only 측정
- `extract:kstartup-criteria-drafts`: 명시 confirmation이 있을 때만 외부 호출, DB 미발행 draft 생성
- `kstartupAttachmentMarkdown` + `backfill:kstartup-attachments`: R2 markdown 제한 로드와 기존 URL-only 첨부 아카이브 경계

남은 게이트:

- reviewed K-Startup annotation으로 extraction recall/precision 검증
- 운영 후보 첨부 archive/convert 실행 후 markdown coverage 재측정
- draft 승인 후 revision publish와 해당 grant match_state 재계산
- reviewed required documents의 별도 운영 저장 계약 확정(현재는 검수 패킷 참고 정보이며 criteria 게시 범위에 포함되지 않음)

### 8.4 기업마당 추출

우선순위:

1. API의 지원대상·사업개요·신청기간·신청방법 structured field
2. 본문출력파일
3. 첨부 공고문
4. 신청서식은 자격조건보다 제출서류 추출에 사용

LLM 추출 개선:

- JSON schema validation 실패 시 1회 repair
- criterion별 source span 필수
- source span 없는 신규 고위험 dimension 강등
- prior_award는 전용 계획의 방어층 해제 전까지 기존 차단 유지
- prompt/model version을 extraction run에 기록
- 동일 input checksum은 재호출하지 않음

구현된 결정론적 backstop:

- `trgetNm`의 소상공인·소기업·중소기업·중견기업·대기업 → size required
- 제목 선두 `[서울ㆍ경기…]` → region required
- 사업요약의 명시적 `법인사업자/개인사업자` → target_type required
- LLM size 오타·employees/revenue alias를 evaluator canonical value로 교정
- deterministic과 LLM의 동일 dimension/kind/operator/value는 한 건으로 중복 제거

### 8.5 reviewer queue

기존 admin review 기반에 다음 큐를 추가한다.

- recommendable인데 extraction readiness가 reviewed가 아닌 공고
- 조건 수가 비정상적으로 적은 고위험 공고
- LLM과 deterministic 결과 충돌
- 사용자 “자격이 맞지 않음” 피드백 발생
- 활성 공고 중 조회량이 높은 상위 공고

reviewer 동작:

- criterion 승인/수정/삭제
- 누락 criterion 추가
- source span 수정
- extraction readiness reviewed 승격
- 수정 후 해당 grant의 match_state만 재계산

### 8.6 완료 기준

- [ ] required/exclusion extraction recall이 Phase 0 gate 충족
- [x] 판정 criterion evidence coverage를 매칭 품질 지표로 산출
- [x] 첨부 수집·변환 미완료 공고는 recommendable 아님
- [ ] revision 변경 시 extraction run과 match_state 재계산
- [ ] 기업마당 재추출 전후 metric report 생성
- [ ] holdout 기준 false eligible이 기존 대비 감소

---

## 9. Phase 3 — 사업자 프로필 자동 채움과 최소 질문

세부 소스 구현은 `2026-07-12-사업자번호-우선-자동채움-실행가이드.md`를 따른다. 본 Phase는 매칭 제품과 연결하는 계약을 정의한다.

### 9.1 자동조회 순서

```text
NTS/Popbill base
→ 공식 exact API
→ 공개 registry exact
→ 허용된 fuzzy registry positive hit
→ 인증 기반 데이터
→ 사용자 응답
→ 파생값
```

우선 구현 축:

1. business_status, target_type, region, biz_age, industry
2. employees, insured_workforce
3. certification, ip
4. 법인 revenue, financial_health
5. 결격 tax/credit/sanction
6. prior_award
7. 개인사업자 매출·재무는 인증 또는 자가응답

### 9.2 충돌 해결

- authoritative API가 self-declared보다 우선한다.
- 최신 authoritative 값이 오래된 authoritative 값을 대체한다.
- registry fuzzy hit는 exact API를 덮어쓰지 않는다.
- self-declared와 API가 충돌하면 자동 덮어쓰기보다 사용자 확인 상태로 둔다.
- derived 값은 원천 값이 바뀌면 재계산한다.
- stale 값은 표시할 수 있으나 hard fail의 단독 근거로 사용하지 않는다.

### 9.3 동적 질문 선택기

신규 파일:

- `packages/core/src/matching/question-planner.ts`
- `packages/core/src/matching/question-planner.test.ts`
- `packages/core/src/use-cases/plan-profile-questions.ts`

현재 `nextQuestion()`의 고정 dimension 우선순위를 확장해 정보가치를 계산한다.

질문 가치:

```text
question_value =
  해소 가능한 활성 공고 수
  × 공고별 중요도(required/exclusion > preference)
  × 답변 후 판정 확정 가능성
  × 마감 긴급도
  ÷ 사용자 응답 비용
```

질문 선택 규칙:

- 한 번의 질문으로 여러 공고의 unknown을 해소하는 항목 우선
- hard exclusion 질문 우선
- 사용자가 이미 답했거나 authoritative source가 있는 질문 제외
- 질문은 객관식/boolean/date/number 구조 입력 우선
- positive-only 목록 단일 선택은 영향을 받는 공고 수에는 포함하되 즉시 판정 확정 수에는 포함하지 않음
- 민감한 결격 질문은 왜 필요한지와 보관·수정 경로 표시
- 최초 결과 전 최대 3개, 이후 공고별 추가 질문으로 점진 공개

### 9.4 답변 저장과 재판정

답변은 기존 `company_profiles` write path를 사용하며 다음을 검증한다.

- company/user scope
- source=self_declared
- answeredAt/version
- 문항이 커버한 `known_flags`
- 기존 unrelated profile dimension 잔존
- 저장 후 영향받은 conditional match만 재계산
- 사용자가 설정에서 정정하면 다시 재계산

### 9.5 완료 기준

- [x] 사업자번호 조회 직후 1차 결과 생성(API 계약·전체 공고 read-only 경로 검증 완료, 실제 브라우저 E2E는 20.3에 남음)
- [x] 첫 3개 질문이 고정 설문이 아니라 현재 공고군에 따라 달라짐
- [x] 답변 후 conditional→eligible/ineligible 전환이 trace와 동일 응답 `impact`/`initialMatch`에 반영됨(순수 전체-flow 검증, 실제 브라우저 E2E는 20.3에 남음)
- [ ] p50 추가 질문 수 ≤ 3
- [ ] 질문 완료 후 conditional resolution ≥ 0.60
- [x] 개인사업자와 법인사업자 질문 경로가 분리됨(Popbill `personCorpCode` 권위 투영·개인/법인 상호배타 판정·유형별 nextQuestion 회귀 테스트 완료, 실제 브라우저 확인은 20.3에 남음)

---

## 10. Phase 4 — audience·prior_award·결격 안전 게이트

### 10.1 audience

`2026-07-12-audience-gate.md`를 그대로 실행한다.

통합 순서상 조건:

- individual precision ≥ 0.95 이전에는 write/filter 활성화 금지
- individual 전용 공고는 사업자 매칭 우주에서 제외
- mixed 공고는 회사 신청 가능 조건을 별도 criterion으로 보존
- audience 변경 시 stale match_state 삭제

2026-07-12 read-only filter simulation:

- `simulateBusinessAudienceFilter`와 `report:business-audience-filter-simulation`을 추가했다. 현재 deterministic classifier가 `individual && safeToExcludeFromBusinessMatching`으로 확정한 공고만 가상으로 제외하고, `unknown`과 `mixed`는 그대로 보존한다. repository·DB·match_state는 변경하지 않으며 `matchingFilterEnabled=false`로 고정한다.
- 실제 활성 1,898건은 company 1,838 / mixed 29 / unknown 25 / safe individual 6으로 분류됐다. 가상 사업자 매칭 우주는 1,892건이다.
- synthetic 30개 회사 기준 recommendable pair는 전후 346건으로 동일했고 false-ineligible/unsafe-ineligible도 모두 0을 유지했다. partial/unstructured recommendable도 0이다.
- initial conditional은 34,594 → 34,529(-65), 최종 conditional은 33,559 → 33,509(-50)로 줄었다. 첫 판정 전환 질문 p50은 1로 동일하며 cohort 해소율은 2.99% → 2.95%(-0.04%p)였다. 이는 분모에서 개인 대상 공고가 빠진 결과이며 운영 정확도 근거가 아니다.
- 기존 audience annotation 81건은 현재 active revision과 모두 일치하지만 reviewed 0건이다. 따라서 `reviewed_audience_gate_not_passed`, `activationReady=false`이며 실제 필터는 활성화하지 않았다. 2인 검수와 individual precision 0.95 gate 통과 후에도 별도 활성화 승인이 필요하다.

```bash
pnpm report:business-audience-filter-simulation -- \
  --limit=2000 \
  --asOf=<ISO> \
  --annotations=tmp/grant-audience-draft-annotations.jsonl
```

### 10.2 prior_award

`2026-07-12-prior-award-structuring.md`를 그대로 실행한다.

통합 순서상 조건:

- 계약·evaluator·프로필 준비 전에 3중 방어층 해제 금지
- L3 계약 허용과 L2 LLM emit은 원자 배포
- 특정 사업 수혜와 “동일/유사 사업” 자기참조를 구분
- known_programs가 없는 exact exclusion은 pass 금지

### 10.3 결격 데이터

- 소진적·권위 소스만 known-on-absence 허용
- 공개 명단 fuzzy no-hit는 pass 근거가 아님
- stale registry는 hard pass/fail 근거에서 제외
- 사용자의 결격 자가응답은 원천과 응답시각을 표시
- 결격 hard fail은 사용자에게 과도한 세부 신용정보를 노출하지 않고 공고 조건 중심으로 설명

### 10.4 완료 기준

- [ ] 사업자 대상 매칭 우주에서 individual-only 공고 0
- [ ] prior_award false pass 방어 테스트 전건 통과
- [ ] 미질의 결격 플래그 unknown 유지
- [ ] registry freshness 만료 시 자동 pass로 사용되지 않음

---

## 11. Phase 5 — 공급원 확장과 중복 통합

### 11.1 공급원 우선순위

1. K-Startup: 창업 특화 structured 조건
2. 기업마당: 중앙부처·지자체·유관기관 범용 공고
3. 중소벤처기업부 공공데이터포털 신규 지원사업 API: 기업마당의 증분·수정 조회 안정화 경로
4. 과학기술정보통신부 사업공고 API: R&D 순증 공고 보완
5. NTIS: 공개 API/RSS/이용조건 확인 후 다부처 R&D 보완
6. 기관별 크롤링: API/RSS가 없고 순증 가치가 검증된 경우에만

공식 확인 경로:

- 기업마당 지원사업정보 API: <https://www.bizinfo.go.kr/apiDetail.do?id=bizinfoApi>
- 중소벤처기업부 중소기업 지원사업 공고 조회 서비스: <https://www.data.go.kr/data/15157820/openapi.do>
- 과학기술정보통신부 사업공고 API: <https://www.data.go.kr/data/15074634/openapi.do>
- NTIS 국가R&D 통합공고: <https://www.ntis.go.kr/rndgate/eg/un/ra/mng.do>
- NTIS OpenAPI: <https://www.ntis.go.kr/rndopen/api/mng/apiMain.do>

### 11.2 소스 추가 전 측정

각 후보 소스에 대해 최근 90일 공고를 표본 수집하고 다음을 계산한다.

- 총 공고 수
- 기존 소스와 exact/likely duplicate 비율
- 활성 순증 공고 수
- 회사 신청 가능 audience 비율
- 원문·첨부 접근 가능률
- 신청기간 구조화 가능률
- 자격조건 extraction readiness
- 유지비용과 호출 제한

go 기준:

- 활성 순증 공고가 월 20건 이상이거나
- 특정 중요 카테고리의 recall을 10%p 이상 개선하거나
- 기존 소스의 revision/freshness 안정성을 유의미하게 개선

### 11.3 revision과 dedup

`packages/core/src/dedup/grant-dedup.ts` 확장:

- source ID exact
- canonical original URL
- title normalized + agency + application period
- attachment checksum
- 공고번호
- 수정/연장/재공고 관계

단일 canonical grant 아래 source occurrence와 revision을 연결한다.

```ts
type GrantRelation =
  | "same_announcement"
  | "revision"
  | "extension"
  | "reannouncement"
  | "related_program";
```

주의:

- 연장공고는 마감일과 원문이 바뀔 수 있으므로 무조건 duplicate 삭제하지 않는다.
- revision 변경은 criteria 재추출과 match_state 재계산을 트리거한다.
- 여러 소스 중 원문·첨부가 가장 완전한 occurrence를 extraction primary로 고른다.

### 11.4 완료 기준

- [x] K-Startup·기업마당 활성 전체 중복 후보와 노출률 read-only report 존재
- [ ] 신규 소스별 순증/중복/원문 가용률 보고서 존재
- [ ] 같은 공고 카드 중복 노출률 < 1%
- [x] 수정·연장공고의 최신 마감일 반영(confirmed occurrence 최대 마감일 보존 회귀 테스트; 실제 confirmed extension 표본은 아직 0건)
- [ ] 과기정통부 API 추가 여부를 데이터로 go/no-go 결정
- [ ] NTIS는 이용 가능 경로 확인 전 핵심 ingestion에 포함하지 않음

실행 계약:

```bash
# 활성 전체, confirmed member도 포함한 읽기 전용 품질 보고
pnpm report:active-grant-dedup -- --limit=2000 --asOf=<ISO>

# 자동 확정/review 링크 계획만 확인. 기본값이 dry-run이며 DB write 없음
pnpm publish:dedup -- --limit=2000 --asOf=<ISO>

# 후보·canonical 판단을 승인한 뒤 manifest의 exact pair만 게시
pnpm publish:dedup -- \
  --limit=2000 --asOf=<ISO> \
  --pair=<canonicalGrantKey>,<memberGrantKey> \
  --write --confirm=PUBLISH_DEDUP_LINKS

pnpm verify:dedup
pnpm verify:dedup-publish
```

`auto_duplicate` publication 전에는 report의 후보 제목·source·충돌 신호를 확인한다. `review`, `extension`, `reannouncement`는 사람 확인 전 사용자 목록에서 숨기지 않는다.

2026-07-12 exact dedup approval batch:

- 수동 `publish:dedup --write`는 이제 한 개 이상의 반복 가능한 `--pair=<canonical>,<member>`가 없으면 실행을 거부한다. 요청 pair가 현재 dedup 후보에서 사라졌거나 중복 scope이면 write 전에 실패한다. 신뢰 서버 cron은 기존 자동 pipeline 계약을 유지하고, 수동 승인 CLI만 exact scope를 강제한다.
- `prepare:dedup-write-batch`는 같은 `asOf`의 active dedup audit와 전체 dry-run을 대조해 아직 confirmed되지 않은 `auto_duplicate`만 선택한다. `review` 관계는 packet과 write scope에서 제외한다.
- 실제 활성 1,898건에서 auto 4쌍·review 1쌍 중 auto 4쌍만 `dedup-c6f6429eb79f7dfd` packet으로 고정됐다. scoped dry-run은 requested 4 / candidate 4 / link 4 / confirmed 4이며 review link 0이다.
- `compare:dedup-write-batch`는 write receipt의 exact requested pair·resolved link·unresolved key와 post-write audit의 confirmed suppression을 함께 검증한다. visible universe가 1,898 → 1,894로 정확히 줄고, 4쌍 confirmed, unconfirmed auto 0, `publicationReady=true`여야 `writeOutcomeVerified=true`다.
- write 없는 음성 대조는 `comparable=true`지만 receipt·confirmed suppression이 없어 `writeOutcomeVerified=false`였다. 이번 회차에는 dedup DB write를 실행하지 않았다.

```bash
pnpm --silent prepare:dedup-write-batch -- \
  --audit=tmp/dedup-audit-before.json \
  --dryRun=tmp/dedup-dry-run.json \
  --output=tmp/dedup-write-batch.json

# 승인 후 write stdout을 receipt로 보존한 다음
pnpm --silent compare:dedup-write-batch -- \
  --manifest=tmp/dedup-write-batch.json \
  --audit=tmp/dedup-audit-after.json \
  --writeReceipt=tmp/dedup-write-receipt.json \
  --require-verified
```

---

## 12. Phase 6 — 피드백 루프와 운영 평가

### 12.1 피드백 종류 확장

기존 feedback 저장에 다음 의미를 지원한다.

- `wrong_eligibility`: 지원 가능/불가 판정 오류
- `missing_condition`: 공고 조건 누락
- `wrong_company_fact`: 기업정보 오류
- `duplicate_grant`: 중복 공고
- `stale_grant`: 마감/상태/원문 오래됨
- `applied`: 실제 신청
- `rejected_at_eligibility`: 기관 자격검토 탈락
- `accepted_for_review`: 서류/평가 단계 진입

기관 최종 선정 여부는 자격 판정 정답과 분리한다. 사업성이 낮아 탈락한 사례를 eligibility 오류로 학습하지 않는다.

구현 상태:

- [x] 기존 `kind/outcome/correction`과 별도로 위 오류 의미를 `reasonCode` 계약에 추가
- [x] `duplicate_grant`, `stale_grant`, `missing_condition`, `wrong_company_fact`를 별도 운영 큐로 집계 가능
- [x] API/OpenAPI와 서버 정규화 허용 목록 동기화

### 12.2 자동 재계산 정책

- 사용자 기업정보 정정: 해당 회사의 관련 match 재계산
- 공고 condition 수정: 해당 grant의 전 회사 match_state 만료
- revision 수집: 해당 grant 재추출 후 재계산
- reviewer 승인: 해당 grant 즉시 재계산
- 단순 관련성 피드백: eligibility를 바꾸지 않고 ranking feature에만 반영

현재 실행 계약:

```bash
# 장애 복구 또는 운영 사전 점검: publisher 결과 UUID를 사용한 읽기 전용 영향 확인
pnpm refresh:grant-revision-scope -- \
  --grantIds=<uuid,uuid> \
  --companyLimit=10000 \
  --asOf=<ISO>

# 자동 transaction이 실패해 rollback된 경우에만 원인 교정 후 명시적으로 복구
pnpm refresh:grant-revision-scope -- \
  --grantIds=<uuid,uuid> \
  --companyLimit=10000 \
  --asOf=<ISO> \
  --write \
  --confirm=REFRESH_GRANT_REVISION_MATCH_STATES
```

운영 기본 순서는 하나의 transaction 안에서 `수집·정규화 게시 → confirmed component stale state 삭제 → 삭제된 회사만 grant-scope 재계산 → 수량 완전성 확인 → commit`이다. 실패하면 전부 rollback한다. 수동 CLI는 자동 경로를 대체하지 않고 장애 분석·복구와 배포 전 dry-run에만 사용한다. 추후 queue로 분리하더라도 같은 grant UUID, 실제 영향 회사 집합, company completeness guard를 유지해야 한다.

### 12.3 golden 승격

운영 피드백은 바로 golden으로 넣지 않는다.

```text
user feedback
→ evidence 확인
→ reviewer 판정
→ regression candidate
→ 중복 제거·개인정보 제거
→ golden 또는 holdout 다음 버전 승격
```

구현된 안전 경계:

- `export:match-feedback-review-tasks`: 미검수 correction만 redacted JSONL로 내보냄
- `publish:reviewed-match-feedback`: 기본 dry-run, write는 `--write --confirm=publish-reviewed-feedback` 필요
- reviewer는 제출자와 달라야 하며 알려진 AI 식별자는 거부
- 피드백 당시 revision과 현재 공고 revision이 다르면 stale review로 차단
- accepted review도 `evaluationCandidate=true`일 뿐 v3 annotation/golden으로 자동 게시되지 않음
- accepted review의 영향 범위는 `grant/company/pair/manual/none`으로 계획되며, 조건·공고 오류는 grant, 회사 fact 오류는 company, 일반 판정 correction은 pair로 제한

correction 반영 후 범위 refresh:

```bash
pnpm refresh:reviewed-feedback-scope -- \
  --reviewerFeedbackId=<review-feedback-uuid> \
  --correction-applied

# dry-run 결과와 candidateComplete=true 확인 후에만
pnpm refresh:reviewed-feedback-scope -- \
  --reviewerFeedbackId=<review-feedback-uuid> \
  --correction-applied \
  --write \
  --confirm=REFRESH_REVIEWED_FEEDBACK_SCOPE
```

실행기는 임의 scope/company/grant 입력을 받지 않고 게시된 reviewer record에서 원본 feedback과 범위를 역참조한다. 기존 상태와 동일한 행은 write하지 않으며, `manual/none`은 match_state를 변경하지 않는다.

### 12.4 운영 대시보드

`apps/web/src/lib/server/admin/matchingEval.ts` 확장 지표:

- 소스별 활성 공고 수·freshness
- extraction readiness 분포
- criterion dimension 분포
- recommendable/conditional/ineligible 분포
- 질문 전후 상태 전환
- feedback 유형과 발생률
- ruleset/extractor/profile-source 버전별 오류율
- 상위 false eligible 원인

현재 CLI slice:

```bash
pnpm report:monthly-match-quality -- --month=YYYY-MM
```

피드백 수, provenance coverage, correction/review backlog, kind/reason/dimension/source/ruleset 분포를 DB write 없이 출력한다. 운영 준비 조건은 사용자 피드백이 1건 이상이고 complete provenance coverage가 95% 이상이며 유효하지 않은 reviewer record가 0건인 경우다. 정기 스케줄과 admin 시각화는 후속이다.

### 12.5 완료 기준

- [x] 피드백 한 건에서 원문 revision·criterion·company fact hash·match version 추적 가능
- [x] reviewer 승인 전 피드백이 자동 정답으로 사용되지 않음
- [x] reviewer 승인 시 최소 영향 범위 계획 생성
- [x] 계획된 영향 범위의 변경 행만 match_state refresh하는 실행기 연결
- [ ] 실제 accepted correction 1건 이상으로 dry-run→write→재보고 검증
- [x] 월간 matching quality read-only report 수동 실행 가능
- [ ] 월간 report 정기 실행과 admin 시각화

---

## 13. DB 마이그레이션 계획

Phase별로 한 번에 거대한 마이그레이션을 만들지 않는다.

### M1 — extraction run/provenance

필요성 확인 후 생성:

- `grant_extraction_runs`
- revision/input checksum/version/status/manifest

### M2 — grant occurrence/revision relation

기존 dedup 테이블로 표현 불가능할 때만:

- `grant_occurrences`
- `grant_relations`

### M3 — 평가셋 운영 저장

초기 golden은 파일 fixture로 유지한다. admin에서 라벨링·이중검수를 운영할 때만:

- `matching_eval_cases`
- `matching_eval_labels`
- `matching_eval_runs`

### 마이그레이션 안전 규칙

- `pnpm db:generate` 결과에 unrelated object가 섞이면 제거
- enum은 제거가 어려우므로 신설 전 계약 검토
- backfill은 항상 dry-run → active slice → 전체 순서
- write 전 before distribution 저장
- rollback SQL 또는 이전 revision 포인터 준비
- 기존 사용자 match_state를 장시간 혼합 버전으로 두지 않음

---

## 14. 테스트 전략

### 14.1 테스트 피라미드

1. parser/evaluator 순수 함수 단위 테스트
2. criterion contract 테스트
3. fixture 기반 source normalization 테스트
4. golden extraction 평가
5. golden eligibility 평가
6. repository persistence e2e
7. API contract 검증
8. 실행 중 서버가 있을 때 브라우저 시각 검증

### 14.2 필수 회귀 명령

```bash
pnpm test:matching-unit
pnpm verify:matching-eval
pnpm verify:matching-eval-v2
pnpm verify:matching-eval-v3
pnpm verify:criteria-extraction-eval
pnpm verify:extraction-manifest-hydration
pnpm verify:matching-v3-review-tasks
pnpm verify:match-state-refresh
pnpm verify:match-feedback-loop
pnpm verify:dedup
pnpm verify:teaser-first-mission-route
pnpm verify:teaser-first-mission-route:database
pnpm verify:archive-container-inspection
pnpm verify:grant-image-ocr
pnpm verify:business-audience-filter-simulation
pnpm typecheck
```

실제 package script 이름이 다른 경우 구현 Phase에서 package.json과 이 문서를 함께 갱신한다.

### 14.3 데이터 회귀

각 backfill/reextract 전후로 다음을 저장한다.

- 활성 grants 수
- criteria 0건 공고 수
- required/exclusion criterion 평균·분포
- extraction readiness 분포
- match tier 분포
- source/dimension별 unknown 비율
- recommendable 증가·감소 공고 목록
- false eligible/false ineligible golden 변화

### 14.4 브라우저 검증

개발 서버는 사용자가 실행한다. 서버가 이미 실행 중인지 먼저 확인하고, 없으면 사용자에게 실행을 요청한다.

확인 화면:

- 사업자번호 입력 직후
- 자동채움 출처 표시
- 첫 질문 1~3개
- 질문 전후 공고 bucket 이동
- 카드 근거·원문 span
- 점수 명칭과 숨김 정책
- 개인/법인 모바일·데스크톱

---

## 15. 구현 순서와 병렬 가능 범위

### 15.1 임계경로

```text
P0 평가셋·지표
→ P1 상태/점수 분리
→ P2 추출 완전성
→ P3 동적 질문
→ P4 안전 게이트
→ P5 공급원 확장
→ P6 피드백 운영
```

### 15.2 병렬 가능

- P0 라벨링 도구와 P1 계약 설계
- P2 K-Startup 추출과 기업마당 추출
- P3 자동 소싱 커넥터와 질문 planner 순수 함수
- P5 공급원 probe와 dedup relation 설계

### 15.3 병렬 금지 또는 원자 배포

- MatchResult 계약과 UI 소비자 불일치 배포
- prior_award L3 계약 허용과 L2 emit 분리
- extraction revision publish와 match_state 재계산 분리
- audience individual 필터와 stale match_state 정리 분리
- registry known-on-absence와 freshness 검증 분리

---

## 16. 회차별 실제 작업 계획

### 1회차 — 측정 기반 만들기

범위:

- matching-v3 fixture schema
- 1차 공고 20건·회사 5건 seed
- extraction/matching metric script 골격
- 현재 v1/v2를 새 report에 함께 표시

완료 산출물:

- 첫 baseline report
- 라벨링 가이드
- 다음 extractor 개선의 최우선 dimension 목록

### 2회차 — 점수·문구·bucket 바로잡기

범위:

- MatchQuality/MatchRanking 계약
- verification completeness 계산
- 4개 사용자 bucket
- “적합도” 표현 제거

완료 산출물:

- API/엔진/UI 회귀
- recommendable 오노출 방지 테스트

### 3회차 — 추출 준비도와 manifest

범위:

- extraction manifest
- K-Startup/기업마당 input completeness
- source span/evidence gate
- partial 공고 추천 차단

완료 산출물:

- source별 extraction report
- 재추출 dry-run 계획

### 4회차 — 최소 질문 planner

범위:

- question value 계산
- 최대 3개 질문
- 답변 저장·부분 재계산
- 개인/법인 경로

완료 산출물:

- 질문 전후 conditional resolution report

### 5회차 — 안전 게이트 통합

범위:

- audience plan 실행
- prior_award plan 실행 또는 방어층 유지 확인
- registry freshness/known-on-absence 계약

### 6회차 — 공급원 확장

범위:

- 과기정통부 API probe
- 기업마당 신규 공공데이터 API 비교
- NTIS 이용 가능 경로 확인
- 순증·중복 보고 후 go 소스만 ingestion

### 7회차 — 운영 피드백과 품질 대시보드

범위:

- feedback taxonomy
- reviewer-to-golden 흐름
- 월간 quality report

---

## 17. 전체 완료 기준

다음 항목을 모두 충족해야 첫 미션 v1 구현 완료로 본다.

- [ ] 공고 100건, 기업 30건, 판정쌍 500건 이상의 평가셋
- [ ] holdout 기준 `eligible_precision ≥ 0.90`
- [ ] 실제 가능한 공고를 추천 또는 확인 필요로 보존하는 recall ≥ 0.95
- [ ] `ineligible_precision ≥ 0.97`
- [ ] required extraction recall ≥ 0.90, exclusion recall ≥ 0.95
- [ ] 추천 판정 criterion evidence coverage 100%
- [ ] partial/unstructured 공고가 recommendable로 노출되지 않음
- [ ] 사업자번호 입력 직후 1차 결과 제공
- [ ] 최초 추가 질문 p50 ≤ 3
- [ ] 추가 질문 후 conditional resolution ≥ 0.60
- [ ] 개인/법인 프로필 경로 분리
- [ ] individual-only 공고가 사업자 매칭 우주에 없음
- [ ] 동일 공고 중복 카드 노출률 < 1%
- [x] revision·마감 연장 반영과 부분 재계산 동작(코드·회귀 테스트·실DB grant-scope dry-run 완료, 운영 write 미실행)
- [ ] UI에서 eligibility·확인도·관련성·우선순위가 혼동되지 않음
- [ ] 사용자 판정 피드백이 reviewer 검수 후 평가셋으로 환류
- [ ] 전체 타입체크와 매칭·dedup·feedback 검증 통과
- [ ] 실행 중인 개발 서버에서 모바일·데스크톱 시각 검수 완료

---

## 18. 중단·의사결정 게이트

다음 상황에서는 임의 구현을 확대하지 않고 사용자와 결정한다.

1. 유료 API가 사용자 1명당 예상 수익 대비 과도한 비용을 요구
2. 개인사업자 민감 재무·체납 조회에 별도 동의·법무 검토가 필요
3. 새 공급원의 이용약관이 재배포·변경·저장을 제한
4. extraction 품질 향상에 대규모 LLM 재처리 비용이 발생
5. DB backfill이 활성 서비스의 match_state를 장시간 혼합 상태로 만듦
6. holdout 개선 없이 개발셋만 상승해 과적합이 의심됨

---

## 19. 문서 유지 규칙

각 구현 회차 종료 시 본 문서에 다음을 갱신한다.

- Phase 상태: `대기 / 진행 / 차단 / 완료`
- 실제 변경 파일
- 실행한 검증 명령과 결과
- baseline 대비 metric 변화
- 남은 외부 blocker
- 설계와 실제 구현이 달라진 이유

개별 세부 문서와 충돌할 경우:

- 해당 도메인의 안전 계약은 세부 문서를 따른다.
- 전체 우선순위·배포 순서·완료 판정은 본 문서를 따른다.
- 충돌을 발견한 회차에서 두 문서를 함께 수정한다.

---

## 20. 바로 다음 구현 작업

최소 vertical slice, 점수 의미 분리, 동적 질문 planner까지 구현됐으므로 다음 임계경로는 **실제 정답 확장 → 추출 완전성 측정 → 질문 전후 전환 검증**이다.

### 20.1 다음 회차 A — v3 실제 annotation 채우기

1. [x] seed manifest를 K-Startup 20건·기업마당 10건으로 확장하고 원문 필드·현재 criteria 검수 packet을 만든다.
2. [x] 개인 2·법인 1 synthetic company draft와 90개 eligibility pair 엔진 초안을 만든다.
3. [x] pair task/annotation redaction·계약 verifier와 reviewed-only 진행 보고서를 만든다.
4. [x] 공고·development pair를 로컬에서 편집하고 JSONL로 내보내는 오프라인 review workbench를 만든다.
5. [x] 회사·공고·pair 간 참조·revision·판정 논리를 검증하는 reviewed batch gate를 만든다.
6. [x] 첫 미션 수량의 공고 100·회사 30·pair 500 draft packet과 확장 workbench를 만든다.
   - 진행률: `pnpm report:matching-v3-expanded-review-progress -- --annotations=<pair-jsonl>`
   - batch dry-run: `pnpm finalize:matching-v3-review-batch -- --packet=expanded --stage=reviewed --companies=<company-jsonl> --grants=<grant-jsonl> --pairs=<pair-jsonl>`
7. [ ] `grants.jsonl`, `company-profiles.jsonl`, `eligibility-pairs.jsonl`에 사람이 검수한 annotation을 작성한다.
8. criterion별 `source_span`, required/exclusion/preference, hard fail/unknown 정답을 기록한다.
9. 최소 4개 공고와 관련 pair는 두 번째 reviewer가 독립 검수한다.
10. [x] legacy/draft/reviewed를 분리하고 reviewed=0이면 운영 metric을 금지한다.

완료 판정:

- 기업마당과 K-Startup이 각각 포함된 reviewed annotation 존재
- 개인/법인 프로필 모두 존재
- false eligible·false ineligible을 dimension별로 집계 가능

### 20.2 다음 회차 B — extraction manifest와 criterion recall

1. [x] `GrantExtractionManifest` 계약과 순수 readiness 계산기를 추가한다.
2. [x] K-Startup structured field, 기업마당 본문·첨부의 expected/fetched/converted 상태를 publish·repository 경로에 연결한다.
3. [x] source span 없는 required/exclusion과 첨부 변환 미완료를 `partial`로 강등한다.
4. [x] reviewed annotation 기준 source·dimension·kind별 recall과 quality gate를 출력하는 evaluator를 구현한다.
5. [x] 기존 활성 공고를 write 없이 평가하여 readiness와 recommendable 변화 목록을 만든다.
   - `pnpm report:extraction-improvement-priority -- --limit=2000 --samples=20 --asOf=<ISO>`
   - `eligibleBlockedCompanyCount`를 최우선으로, conditional 해소 가능성·마감·작업비용을 다음 순서로 반영한다.
   - manifest 경고의 `register_or_convert_attachments`는 1차 분류로만 유지한다. 운영 리포트에서는 archive의 `sha256/storageKey`, surface 존재, pending surface와 archive의 filename/storageKey 연결을 DB에서 읽어 `archive_attachments` → `register_attachment_surfaces` → `repair_attachment_linkage` → `convert_attachments`로 다시 분해한다.
6. [x] 우선순위 batch의 exact `sourceIds`를 archive/surface/link-repair/poll 명령에 전달하는 필터와 CLI write confirmation을 구현한다.
   - BizInfo attachment-only batch: `backfill:bizinfo-attachments`, confirmation `ARCHIVE_BIZINFO_ATTACHMENTS`
   - K-Startup attachment-only batch: `backfill:kstartup-attachments`, confirmation `ARCHIVE_KSTARTUP_ATTACHMENTS`
   - legacy surface linkage: `repair:attachment-surface-links`, confirmation `REPAIR_ATTACHMENT_SURFACE_LINKS`
6.1. [x] BizInfo `reextract` 후보를 stored raw 기반 exact `sourceIds` draft·공통 review task·grant-only offline workbench로 연결한다. LLM 호출은 `--extract --confirm=EXTRACT_BIZINFO_CRITERIA`를 강제하고, deterministic draft와 LLM draft 모두 reviewed publication 전에는 운영 불가다.
7. [ ] 승인 후 상위 20건을 아래 순서로 소량 실행하고 같은 `asOf`의 전후 report를 비교한다.

BizInfo unstructured 10건 오프라인 검수 재현:

```bash
pnpm extract:bizinfo-criteria-drafts -- \
  --sourceIds=<exact csv> --limit=10 \
  --emit-deterministic-drafts \
  --output=tmp/bizinfo-deterministic-drafts.jsonl

pnpm export:bizinfo-draft-review-tasks -- \
  --input=tmp/bizinfo-deterministic-drafts.jsonl \
  --output=tmp/bizinfo-deterministic-review-tasks.jsonl \
  --annotations-output=tmp/bizinfo-deterministic-draft-annotations.jsonl \
  --force

pnpm export:matching-v3-review-workbench -- \
  --grant-tasks=tmp/bizinfo-deterministic-review-tasks.jsonl \
  --output=tmp/bizinfo-deterministic-review-workbench.html \
  --grant-only --force

pnpm measure:bizinfo-draft-impact -- \
  --drafts=tmp/bizinfo-deterministic-drafts.jsonl
```

```bash
# 1. 항상 dry-run으로 대상과 수량부터 확인
pnpm backfill:bizinfo-attachments -- \
  --sourceIds=<report의 쉼표 구분 ID> \
  --limit=20

pnpm backfill:attachment-surfaces -- \
  --source=bizinfo \
  --sourceIds=<동일 ID> \
  --limit=20

# 2. 승인된 batch에만 write confirmation을 추가
pnpm backfill:bizinfo-attachments -- \
  --sourceIds=<동일 ID> \
  --limit=20 \
  --write \
  --confirm=ARCHIVE_BIZINFO_ATTACHMENTS

pnpm backfill:attachment-surfaces -- \
  --source=bizinfo \
  --sourceIds=<동일 ID> \
  --limit=20 \
  --write \
  --confirm=REGISTER_ATTACHMENT_SURFACES
```

archive가 유효해진 다음 같은 리포트를 다시 실행한다. action이 `repair_attachment_linkage`면 repair CLI, `convert_attachments`면 poll CLI를 각각 dry-run한 뒤 해당 confirmation으로 write한다. K-Startup도 surface 등록보다 먼저 `backfill:kstartup-attachments`를 실행한다. ID는 리포트 결과를 그대로 사용하고 수동 재선정하지 않는다.

2026-07-12 dry-run 확인:

- 기존 generic action: `register_or_convert_attachments` 1,590건, `archive_attachments` 117건
- archive/surface 실제 상태 결합 후: `archive_attachments` 1,707건, human review 19건, reextract 47건
- 기존 surface dry-run은 BizInfo/K-Startup 상위 각 20건 모두 `candidateGrants=0`, poll은 40건 모두 archive URL/SHA 연결 부재로 skip
- 새 BizInfo archive dry-run은 상위 20건 전부 후보이며 28개 첨부 선택
- K-Startup archive dry-run은 지정 상위 20건 중 18건 후보이며 33개 첨부 선택

2026-07-12 후속 운영 분류 보정:

- raw 첨부에 실제 다운로드 URL과 지원 포맷이 있는지까지 결합하자 `archive_attachments` 1,556건, `inspect_unsupported_attachments` 151건, human review 19건, reextract 47건으로 분리됐다.
- 151건은 메타데이터 누락이 아니라 주로 zip/xlsx 등 현재 extractor가 소비하지 못하는 파일이다. 이들을 archive 가능 대상으로 가장하거나 “지원하지 않는 형식이므로 완료”로 처리하지 않는다.
- K-Startup 포스터에는 이미지와 같은 내용을 담은 UTF-8 `.txt` 대체텍스트가 함께 제공된다. `.txt`를 archive 후보에 포함하고 별도 변환 서버 없이 markdown으로 보관하도록 연결했다.
- 그 결과 우선순위 K-Startup 20건과 archive dry-run 후보가 정확히 20건으로 일치하며, 선택 첨부는 31개다. 기업마당도 20건·28개로 일치한다.
- `backfill:kstartup-details`는 과거 write 기본값을 제거했다. 이제 기본 dry-run이며 `--sourceIds` 필터를 지원하고, write에는 `--write --confirm=BACKFILL_KSTARTUP_DETAILS`가 필요하다.

2026-07-12 컨테이너 첨부 확장:

- 미지원 첨부의 실제 분포는 zip 105개, jpg 20개, xlsx 14개, png 26개, pptx 2개였다.
- `inspect:unsupported-grant-attachments`는 DB/R2 write 없이 최대 다운로드 크기, 내부 entry 수, 전체 비압축 크기, 경로탈출, 내부 지원 문서를 검사한다.
- 우선순위 20개 source ID에서 컨테이너 첨부 14개를 실제 검사했고 14개 모두 안전한 경로와 HWP/HWPX/PDF 또는 XLSX text payload를 포함했다.
- ZIP은 내부 경로탈출을 거부하고 최대 500 entries, 선택 10개, entry당 20 MiB, 합계 50 MiB 아래의 HWP/HWPX/PDF/DOCX/TXT만 별도 archive 항목으로 확장한다. XLSX/PPTX는 XML payload도 entry당 10 MiB, 합계 50 MiB로 제한해 markdown으로 변환한다.
- 운영 재분류 결과 `archive_attachments`는 1,556 → 1,667건으로 111건 늘었고, `inspect_unsupported_attachments`는 151 → 40건으로 줄었다. 남은 형식은 jpg 16개·png 25개이며 OCR 또는 사람 검수 전에는 계속 partial이다.
- 이전 미지원 상위 source ID를 BizInfo archive dry-run에 다시 넣자 13개 공고·14개 컨테이너 첨부가 후보로 잡혔다. inspector는 검사용 네트워크 read와 메모리 다운로드만 수행했고 파일·R2·DB에는 보존하지 않았으며, archive dry-run 자체도 write를 실행하지 않았다.

2026-07-12 이미지 OCR 연결:

- 남은 이미지 후보 40건을 `ocr_images`라는 별도 action으로 분리했다. 이미지 형식이라는 이유만으로 conversion `skipped` 또는 extraction 완료로 만들지 않는다.
- 외부 유료 API 없이 운영자가 실행할 수 있는 macOS Vision OCR adapter와 `probe:grant-image-ocr` read-only CLI를 추가했다. 입력은 20 MiB 이하 PNG/JPG로 제한하고 임시 파일은 호출 후 삭제한다.
- 실제 우선순위 이미지 20건은 모두 OCR에 성공했고 20건 모두 archive gate(신뢰도 ≥ 0.60, 20자 이상)를 통과했다. 평균 신뢰도 min/p50/max는 0.630/0.756/0.867, 추출 문자 수 min/p50/max는 287/708/2,505자였으며 지원대상·신청기간·지원금·제외조건 같은 공고 텍스트가 확인됐다.
- archive 연결은 기본 신뢰도 0.60과 최소 20자 게이트를 통과한 경우에만 markdown `converted`로 저장하고 `ocr_provider`, `ocr_confidence`, converter version을 provenance로 남긴다. 미달·무텍스트·adapter 미설정은 `failed`로 남겨 partial gate를 유지한다.
- BizInfo image batch dry-run은 `--imageOcr=macos_vision`을 명시해야 이미지를 후보에 포함한다. 실제 write에는 기존 `--write --confirm=ARCHIVE_BIZINFO_ATTACHMENTS`가 추가로 필요하다.

2026-07-12 self-hosted PaddleOCR 운영 경로:

- macOS Vision에 종속되지 않도록 기존 layout-eval의 `PADDLEOCR_SERVER_URL` 설정을 공고 이미지 archive provider에도 연결했다. `backfill:bizinfo-attachments -- --imageOcr=paddleocr`와 `probe:grant-image-ocr -- --provider=paddleocr`를 지원한다.
- [PaddleX PP-StructureV3 공식 serving 계약](https://paddlepaddle.github.io/PaddleX/latest/en/pipeline_usage/tutorials/ocr_pipelines/PP-StructureV3.html)의 `result.layoutParsingResults[].markdown.text`만 본문으로 사용하고, `prunedResult.overall_ocr_res.rec_scores`를 우선 confidence로 집계한다. overall score가 없을 때만 하위 `rec_scores`를 사용하며 score 자체가 없으면 0으로 두어 archive confidence gate를 통과하지 못하게 한다.
- 요청은 `returnMarkdownImages=false`, `visualize=false`, `formatBlockContent=false`로 보내 base64 결과 이미지와 이미지 placeholder를 공고 본문에 섞지 않는다. 입력은 기존과 같은 20 MiB, 응답 본문은 200,000자로 제한한다.
- provider가 선택됐는데 `PADDLEOCR_SERVER_URL`이 없거나 URL이 HTTP(S)가 아니면 dry-run 단계부터 실행을 거부한다. `PADDLEOCR_ENGINE_VERSION`은 실제 container image/pipeline 버전을 conversion provenance에 남긴다.
- 공식 응답 fixture, table score fallback, score 미제공=0, 빈 markdown, URL scheme, 20 MiB 제한을 단위 테스트했다. 현재 환경에는 PaddleOCR server URL이 없어 live server 호출은 하지 않았으며 operational-ready 판정도 보류한다.
- 공통 provider 연결 뒤 macOS Vision 상위 3건을 다시 read-only probe한 결과 3/3 인식·3/3 archive gate 통과·실패 0이었다. confidence min/p50/max는 0.694/0.756/0.806, 문자 수 min/p50/max는 345/759/1,114로 기존 로컬 경로 회귀가 없었다.

2026-07-12 OCR 승인 packet:

- `prepare:extraction-write-batch -- --action=ocr_images --ocrProbe=<json>`을 추가했다. priority의 상위 ID, `--imageOcr=<provider>` archive dry-run의 실제 선택 파일, 같은 provider의 OCR probe 파일이 source ID와 filename 단위로 정확히 일치해야 한다.
- 선택 파일에 이미지 외 형식이 섞였거나, 한 파일이라도 OCR 실패·confidence 0.60 미만·20자 미만·converter 누락이면 packet 생성을 거부한다. `recognizedCount`, `passingArchiveGateCount`, `failureCount` 요약만 맞고 실제 파일 결과가 다를 때도 거부한다.
- 실제 BizInfo 상위 20건·이미지 20개를 macOS Vision으로 다시 probe해 20/20 인식·20/20 gate 통과·실패 0을 확인하고 `extraction-a02a74136133fad6` packet으로 고정했다. eligible-blocked pair는 156건, confidence min/p50/max는 0.630/0.756/0.867, 문자 수 min/p50/max는 287/708/2,505다.
- write 없는 음성 대조 비교는 전 ID 추적과 동일 공고 우주가 확인되어 `comparable=true`였지만 action 이동과 archive identity 증가는 없어 `writeOutcomeVerified=false`였다. 비교 CLI의 화면 요약 `ok`도 comparability가 아니라 최종 `writeOutcomeVerified`를 사용한다.
- 이 packet 역시 `authorization.approved=false`이며 실제 실행에는 `--write --confirm=ARCHIVE_BIZINFO_ATTACHMENTS`가 별도로 필요하다. 이번 회차에는 R2/DB write를 실행하지 않았다.

2026-07-12 파일별 write receipt gate:

- BizInfo·K-Startup archive write 결과에 선택 파일별 `archiveIdentityValid`, sha256, storage key/archive URL 존재 여부, conversion status·converter·error, OCR provider·confidence를 출력한다. presigned URL 전체는 receipt에 남기지 않는다. ZIP에서 생성된 내부 문서는 `generatedAttachments`로 분리해 원래 승인 파일과 혼동하지 않는다.
- `compare:extraction-write-batch`는 이제 `--writeReceipt=<archive-write-output.json>`을 받아 manifest의 source ID·filename과 write 결과를 정확히 대조한다. grant 단위 실패, 선택 파일 누락, archive identity 누락, conversion 상태 누락이 있으면 최종 gate를 닫는다.
- OCR batch는 추가로 선택 provider, `converted` 상태, probe와 동일 converter, confidence 0.60 이상, conversion error 없음, bundle failure 0을 요구한다. summary count만 성공이고 파일별 provenance가 다른 경우 성공으로 인정하지 않는다.
- `comparable`은 같은 공고 우주를 비교할 수 있다는 뜻만 유지한다. `writeOutcomeVerified`는 action 이동·archive identity 증가·매칭 안전 gate뿐 아니라 `writeReceiptVerified=true`여야 한다. receipt가 없으면 `write_receipt_missing`으로 실패한다.
- write stdout은 `pnpm --silent ... --write ... > tmp/<batch>-write-receipt.json`으로 보존하고, 그 파일을 after priority/business report와 함께 comparison CLI에 전달한다.

```bash
pnpm --silent prepare:extraction-write-batch -- \
  --priority=tmp/extraction-priority-before.json \
  --business=tmp/business-number-before.json \
  --dryRun=tmp/bizinfo-image-archive-dry-run.json \
  --ocrProbe=tmp/bizinfo-image-ocr-probe.json \
  --source=bizinfo \
  --action=ocr_images \
  --output=tmp/bizinfo-image-ocr-write-batch.json
```

따라서 현재 승인 대상의 첫 write는 surface/poll이 아니라 BizInfo·K-Startup archive batch다. `ocr_images`는 OCR 신뢰도 gate 또는 사람 검수 전 자동 완료하지 않는다. archive write 승인 전에는 baseline 변화가 없으므로 전후 지표를 개선됐다고 표시하지 않는다.

2026-07-12 승인 배치 증거 계약:

- `prepare:extraction-write-batch`는 같은 `asOf`의 extraction priority report, business-number baseline, source별 archive dry-run 세 파일을 입력으로 받는다.
- priority 상위 20개 ID와 archive dry-run의 요청 ID·실제 후보 ID가 정확히 일치하지 않거나, 한 건이라도 선택 첨부가 없거나, 공고 우주 수가 다르면 manifest 생성을 거부한다.
- manifest의 `batchId`는 `asOf`, source, action, source ID, 선택 첨부명으로 만든 안정 해시다. 생성된 manifest 자체는 승인이 아니며 `authorization.approved=false`를 유지하고 실제 write는 기존 confirmation을 다시 요구한다.
- priority report의 각 selected candidate에는 write 전 archive/surface 상태를 포함한다. write 후에는 `--trackSource`와 `--trackSourceIds`로 같은 ID만 다시 관찰해 `validArchivedCount` 증가, action 이동, readiness warning을 비교한다.
- business-number report는 `recommendableByExtractionReadiness`를 추가로 출력한다. `partial` 또는 `unstructured` 공고가 recommendable이면 전후 비교 gate가 실패한다.
- `compare:extraction-write-batch --require-verified`는 같은 `asOf`와 공고 우주, 전 ID 추적, 전 ID archive identity 증가, action 이동, false-ineligible 비회귀, readiness gate 유지를 모두 확인해야 exit 0이다.
- JSON evidence를 파일로 보존할 때는 pnpm 실행 배너가 섞이지 않도록 반드시 `pnpm --silent`를 사용한다.

```bash
AS_OF=2026-07-12T03:00:00.000Z

# 1. 쓰기 전 read-only evidence. 첫 priority report에서 sourceIds를 그대로 복사한다.
pnpm --silent report:extraction-improvement-priority -- \
  --limit=2000 --samples=0 --asOf=$AS_OF \
  > tmp/extraction-priority-before.json

pnpm --silent report:business-number-first-results -- \
  --limit=2000 --asOf=$AS_OF \
  > tmp/business-number-before.json

pnpm --silent backfill:bizinfo-attachments -- \
  --sourceIds=<priority report의 bizinfo:archive_attachments ID> \
  --limit=20 --scanLimit=2000 --asOf=$AS_OF \
  > tmp/bizinfo-archive-dry-run.json

# 2. 세 evidence가 정확히 맞을 때만 승인 packet을 만든다. 이 단계는 write가 아니다.
pnpm --silent prepare:extraction-write-batch -- \
  --priority=tmp/extraction-priority-before.json \
  --business=tmp/business-number-before.json \
  --dryRun=tmp/bizinfo-archive-dry-run.json \
  --source=bizinfo \
  --output=tmp/bizinfo-extraction-write-batch.json

# 3. 사용자가 manifest의 ID·첨부·비용을 승인한 뒤에만
#    manifest.commands.approvedWriteTemplate의 exact argv를 실행한다.

# 4. write 뒤 manifest.commands.afterPriorityReport와
#    afterBusinessNumberReport를 실행해 JSON을 저장하고 비교한다.
pnpm --silent compare:extraction-write-batch -- \
  --manifest=tmp/bizinfo-extraction-write-batch.json \
  --priority=tmp/extraction-priority-after.json \
  --business=tmp/business-number-after.json \
  --output=tmp/bizinfo-extraction-write-comparison.json \
  --require-verified
```

실제 DB read-only packet 생성에서는 BizInfo 상위 20건·첨부 28개가 `extraction-e1961cb6cc15c6a8`, K-Startup 상위 20건·첨부 31개가 `extraction-f38e6672a4159777`로 고정됐다. 선택 batch의 eligible-blocked pair는 각각 600건과 440건이다. 기준선은 활성 공고 1,898건, operational candidate 1,773건, archive action 1,667건, synthetic 30개 회사 기준 recommendable pair 346건이며 false/unsafe ineligible은 모두 0이었다. BizInfo packet을 write 없이 같은 evidence로 비교하자 `comparable=true`지만 delta는 모두 0, 20건의 `validArchivedCountDelta=0`, `writeOutcomeVerified=false`였다. 이는 기존 legacy archive/surface row가 있더라도 sha256/storage identity가 없으면 성공으로 인정하지 않는 음성 대조군이다. 이번 확인에서는 R2/DB write를 실행하지 않았다.

전후 비교 항목:

- 해당 source ID의 archive/surface/conversion 상태
- `candidateCount`와 action 이동(`archive` → `register_or_convert` → `reextract/review`)
- `totalEligibleBlockedCompanyCount` 감소량
- business-number baseline의 recommendable 증가량
- false eligible 방지를 위한 readiness/review gate 유지 여부

완료 판정:

- 입력 누락과 extractor 누락을 서로 다른 warning code로 구분
- partial/unstructured 공고 recommendable 0건
- required/exclusion recall을 baseline과 비교 가능

### 20.3 다음 회차 C — 질문 저장 E2E와 해소율 측정

1. [ ] 사용자가 개발 서버를 실행한 뒤 사업자번호 입력 → 대시보드 질문 → 저장 → 결과 갱신을 브라우저로 확인한다.
2. select가 빈 placeholder로 시작하며 임의 첫 옵션을 저장하지 않는지 확인한다.
3. `merge + partial`이 기존 자동조회 목록과 confidence를 보존하는지 실제 DB row에서 확인한다.
4. [x] scalar/소진적 응답과 positive-only 목록 응답의 `resolvesGrantCount`·실제 해소 차이를 순수 evaluator 회귀 테스트로 확인한다.
5. [x] 프로필 필드 저장 응답에 질문 전후 `conditional → eligible|ineligible|conditional` 요청 단위 report를 포함한다.
6. [x] 질문 응답 event 최소수집 schema·repository·30분 session·월간 품질 report를 구현한다.
7. [x] web/app 질문 저장 impact와 갱신 `initialMatch`가 동일한 전체 활성 공고 universe를 사용하도록 통합한다.
8. 승인 후 `pnpm db:migrate`로 `0045_mushy_daimon_hellstrom.sql`을 적용하고 실제 저장 receipt가 `persisted=true`인지 확인한다.
9. 실제 이벤트 30건·세션 10개 이상에서 `pnpm report:profile-question-quality -- --month=YYYY-MM --ruleset=<version>`을 실행한다.
10. [x] 비로그인 web/app teaser도 공용 full-universe loader와 동일한 질문 planner를 사용하고, 결과 화면에서 가장 영향도 높은 보완 필드로 연결한다.
11. [x] 팝빌 `personCorpCode`(1 법인, 2 개인)를 authoritative `target_type`으로 투영하고, 구 캐시 raw payload 보정·수동 유형 입력·개인/법인별 질문 분기 테스트를 추가한다.
12. [x] 비로그인 teaser의 직접입력 프로필이 IP·기수혜·결격·재무·고용보험·투자 축을 버리지 않도록 전체 계약을 정규화하고, client provenance 위조 폐기·self-declared confidence 0.6 상한·권위 API 우선 병합을 적용한다.
13. [x] teaser `nextQuestion`에 select/number/boolean/text뿐 아니라 결격 checklist와 재무·고용·투자 number-group 입력기를 연결하고, 대시보드와 질문→payload 변환 함수를 공유한다. `모름` TTL은 서버에서 최대 30일로 재검증한다.
14. [x] `pnpm verify:teaser-first-mission-route`로 web/app teaser의 잘못된 사업자번호 선차단, 수동 프로필 입력, 전체 평가 수와 8개 반환 제한 분리, `nextQuestion` 명시 계약, `모름` 질문 억제, 확장 프로필 수용, web/app 평가 universe 일치를 서버 없이 검증한다.

teaser 계약에는 `nextQuestion: NextQuestionDto | null`을 명시한다. 화면에 반환하는 8개 카드와 별개로 질문의 `affectedGrantCount`는 전체 활성 공고를 기준으로 계산하며, 사용자가 최근 30일 안에 `모름`으로 답한 축은 반복하지 않는다. web과 app 모두 `loadServiceGrantUniverse`의 초과 감지 sentinel과 사업자번호 체크섬 선검사를 사용하므로, 일부 공고만 조용히 평가하거나 명백한 오입력으로 유료 조회를 시작하지 않는다.

2026-07-12 route verifier는 sample universe 9건과 실제 DB 활성 universe 1,898건을 각각 모두 평가하고 8개 카드만 반환했으며 첫 질문은 두 모드 모두 `biz_age`였다. `pnpm verify:teaser-first-mission-route:database`는 외부 유료 조회나 저장 없이 실제 Drizzle repository를 거쳐 web/app 평가 universe 일치까지 확인한다. 실제 브라우저 E2E는 실행 중인 4010 서버가 이전 컴파일 오류 bundle을 유지하고 있고 인앱 브라우저 backend가 없어 아직 완료하지 않았다. 사용자가 서버를 재시작한 뒤 20.3의 1번 절차와 실제 사업자번호 조회·저장까지 별도로 확인한다.

같은 날 live `db:doctor` read-only 확인에서는 기존 필수 테이블과 RLS는 정상이지만 `profile_question_events`만 없고 Drizzle 적용 이력은 45건이었다. 따라서 0045는 아직 운영 DB에 적용되지 않았으며 질문 저장 E2E의 `persisted=true`는 증명되지 않았다. doctor는 이 단일 누락에서 데모 seed·공고 재발행을 권하지 않고, 대상 DB 확인 → `pnpm db:migrate` → doctor 재확인 → 질문 저장 E2E만 안내한다.

사업자 유형은 팝빌 공식 코드에서 `1 → 법인`, `2 → 개인사업자`만 확정하고 `99/미상`은 추측하지 않는다. `target_type` 축에는 창업기업·1인 창조기업 등 독립 태그도 섞여 있으므로 목록 전체는 `partial`로 유지하고, `profile_evidence.target_type.sourceKind=authoritative_api`로 원천을 남긴다. evaluator는 공고 조건과 회사 값이 모두 개인/법인 유형만 가리킬 때에만 상호배타성을 이용해 반대 유형을 확정 탈락시킨다. “창업기업” 같은 다른 target no-hit는 계속 unknown이다. 이 때문에 반대 법적 유형 전용 공고만 질문 후보에서 제외되고, 개인은 개인 전용 공고의 질문, 법인은 법인 전용 공고의 질문을 받는다. 기존 팝빌 캐시에 canonical 유형이 없더라도 raw `personCorpCode`가 있으면 조회 과금 없이 응답 시 보정하되, 이미 저장된 canonical 유형은 덮지 않는다.

teaser `profile`은 신뢰 경계 밖의 client payload다. 따라서 client가 보낸 `profile_evidence`는 폐기하고 서버가 실제 값이 존재하는 축에만 `self_declared/cunote_teaser_manual` evidence를 다시 만든다. confidence는 소수값을 보존하되 최대 0.6으로 제한하고, 값이 없는 축의 confidence는 제거한다. 팝빌 등 authoritative 값과 충돌하면 권위값을 primary로 유지하고 수동값은 supplemental evidence로만 남긴다. 재무·고용·투자처럼 한 축을 여러 번 나눠 입력하는 객체는 client draft merge에서 하위 필드를 보존한다.

비로그인 질문 답변은 로그인 전 현재 매칭 재계산에 사용할 수 있지만, 세금·신용·제재·상세 재무·고용보험·투자 원값은 localStorage 초안에서 제거한다. 페이지 메모리와 현재 요청에만 존재하며, 브라우저 장기 저장에는 비민감 기본 프로필과 원값이 아닌 `question_answer_state`만 남긴다. 로그인 후 저장 경로는 기존 회사 프로필 접근제어와 이벤트 최소수집 계약을 따른다.

전체 공고 평가 범위 회귀 확인:

```bash
pnpm report:dashboard-first-mission -- \
  --limit=12 \
  --asOf=<ISO>
```

`evaluatedGrantCount`는 활성 공고 전체, `returnedMatchCount`는 첫 화면 제한이어야 한다. 두 값이 같아지거나 평가 수가 다시 40으로 줄면 회귀다. 이 명령은 `writeMatchStates=false`다.

사업자번호 직후 synthetic coverage baseline:

```bash
pnpm report:business-number-first-results -- \
  --limit=2000 \
  --asOf=<ISO>
```

기본 출력은 회사 원값 없이 전체·개인/법인·공급원별 지표만 제공한다. 개발 진단에서 회사별 결과가 꼭 필요할 때만 `--include-companies`를 추가한다. `operationalAccuracyEvidence=false`인 동안 이 수치를 실제 자동조회 성공률이나 운영 정확도로 표현하지 않는다.

순차 질문 synthetic answer-oracle baseline:

```bash
pnpm report:question-flow-simulation -- \
  --scanLimit=5000 \
  --maxQuestions=10 \
  --asOf=<ISO>
```

이 리포트는 사업자번호 초기 프로필에서 시작해 30개 synthetic 개인/법인 프로필의 숨겨진 완전값을 planner 순서대로 한 축씩 공개한다. `questionsToFirstResolutionP50`, 최초 conditional cohort의 최종 해소율, 질문 event 단위 해소율을 분리하고, 남은 conditional을 extraction readiness와 hard-unknown dimension으로 분해한다. 실제 사용자 응답률·자동조회 정확도·운영 release gate를 대체하지 않으며 `operationalAccuracyEvidence=false`로 고정한다.

2026-07-12 `asOf` read-only baseline(활성 1,898건 × synthetic 30개, 최대 10문항):

- 첫 판정 전환 질문 p50: 1개
- 최초 conditional 34,594건 중 1,035건 해소, cohort 해소율 2.99%
- 질문 event 분모 3,205건 중 eligibility 확정 1,035건, event 해소율 32.29%
- 최종 conditional 33,559건의 readiness: reviewed 0, structured-unreviewed 59, partial 33,140, unstructured 360
- 가장 많은 잔여 hard unknown: `other` 16,746, `industry` 16,696, `size` 10,200, `target_type` 6,308

따라서 질문 수 p50 자체는 synthetic 기준을 통과하지만 conditional resolution 0.60은 통과하지 못한다. 이 결과에서 다음 병목은 질문 UI가 아니라 partial 공고의 원문·첨부 extraction/review이며, 20.2 상위 batch를 실행한 뒤 동일 `asOf`로 이 리포트를 재실행해 개선량을 비교한다.

완료 판정:

- company/user scope와 unrelated dimension 보존
- UI와 DB의 list completeness 일치
- `conditional_resolution_rate`와 질문 부담 p50 산출

검증 명령:

```bash
pnpm verify:profile-question-quality
pnpm verify:teaser-first-mission-route
pnpm verify:teaser-first-mission-route:database
pnpm verify:runtime-repositories
pnpm verify:rls-policy
pnpm verify:openapi
```

자동채움 세부 구현은 병행 문서 `2026-07-12-사업자번호-우선-자동채움-실행가이드.md`의 소유 범위를 존중하며, 이 문서에서는 매칭 계약과 검증 결과만 통합한다.

### 20.4 다음 회차 D — MSIT 순증 공급원 go/no-go

1. [x] 타입 안전 fetch adapter와 키 비노출 read-only probe를 구현한다.
2. [x] API 전체 페이지 완주 여부와 최근 90일 필터를 구현한다.
3. [x] 기존 활성 공고 대비 exact/high-confidence/review/likely-unique 분류와 보수적 순증 수를 계산한다.
4. [ ] 공공데이터포털에서 과기정통부 사업공고 API 활용신청을 승인받는다.
5. [ ] `pnpm probe:msit-announcements`를 재실행하고 `snapshotComplete=true`, 게시일 파싱 누락 0을 확인한다.
6. [ ] review 후보와 likely-unique 후보의 기업·mixed audience 및 신청 가능 기간을 사람 검수한다.
7. [ ] 순증 활성 공고와 유지비용을 비교해 source enum·migration·ingestion 추가 여부를 결정한다.

완료 판정:

- 전체 snapshot이 완주된 상태에서 최근 90일 순증 수가 재현 가능
- exact/high-confidence는 중복 후보, review는 수동 판정 대상으로 분리
- `GrantSource`와 DB schema 변경은 go 결정 후에만 수행

### 20.5 다음 회차 E — 국고보조금 기업지원 적합성 판정

1. [x] 공식 Swagger의 공고·접수·자격·심사·서류 필드를 코드 계약으로 만든다.
2. [x] 현재 사업연도의 필드 커버리지를 확인하는 키 비노출 read-only probe를 만든다.
3. [ ] 공공데이터포털에서 국고보조금 공모사업 상세 API 활용신청을 승인받는다.
4. [ ] 지원대상·제외대상 표본을 검수해 company/mixed/individual/unknown 비율을 산출한다.
5. [ ] 기존 K-Startup·기업마당 대비 최근 90일 순증률을 계산한다.
6. [ ] 기업 대상이면서 실제 접수 중인 순증 공고가 유지비용을 정당화할 때만 ingestion을 설계한다.

완료 판정:

- audience와 활성 기간을 판정할 원문 필드 커버리지가 수치로 확인됨
- 비기업 대상 자동 제외는 별도 reviewed audience gate를 통과
- 활용승인·표본 검수 전에는 운영 공고 우주에 포함되지 않음

### 20.6 다음 회차 F — 운영 피드백 품질 루프

1. [x] 피드백 저장 시 현재 공고·회사·매칭을 서버에서 다시 읽어 provenance를 생성한다.
2. [x] 회사 원값과 source span 대신 SHA-256 참조를 저장해 추적성과 최소수집을 함께 지킨다.
3. [x] 독립 사람 reviewer·시간 순서·현재 revision을 강제하는 review publication 계약을 만든다.
4. [x] review task exporter와 기본 dry-run publication CLI를 만든다.
5. [x] 월간 provenance coverage·correction·review backlog 보고서를 만든다.
6. [ ] 실제 사용자 피드백이 쌓인 뒤 provenance coverage 95%를 확인한다.
7. [x] accepted correction의 `grant/company/pair/manual/none` 최소 refresh 범위를 계획한다.
8. [x] 게시된 reviewer feedback에서 범위를 읽어 변경 match_state만 갱신하는 기본 dry-run 실행기를 만든다.
9. [ ] accepted correction을 별도 v3 annotation 검수로 옮기고 실제 dry-run→write→재보고를 검증한다.
10. [ ] 월간 report를 cron/admin quality dashboard에 연결한다.

완료 판정:

- 피드백 원문 값 복제 없이 당시 판정 입력 revision과 결과를 재현 가능
- reviewer 승인 전과 승인 후 모두 golden 자동 승격 없음
- 수정이 확정되면 전체가 아닌 영향 범위만 refresh
