# 매칭 정확도 baseline v0

> 측정일: 2026-07-12\
> fixture: `kstartup-sample-v1`, `kstartup-sample-v2`\
> 재현 명령: `pnpm report:matching-eval -- --format=markdown`

## 결과 요약

- 판정쌍: 9건
- 정답 일치: 9건
- legacy accuracy: 100.0%
- v3 호환 회사 annotation: 2건
- v3 호환 고유 공고 annotation: 8건
- v3 호환 판정쌍 annotation: 9건
- 평균 조건 확인도: 47%
- 평균 원문 근거 커버리지: 100%

이 수치는 운영 정확도가 아니라 기존 회귀 fixture가 새 평가 기반에서도 동일하게 재현되는지 확인하는 기준선이다.

## 클래스별 지표

| 클래스 | expected | predicted | TP | precision | recall |
|---|---:|---:|---:|---:|---:|
| eligible | 3 | 3 | 3 | 100.0% | 100.0% |
| conditional | 3 | 3 | 3 | 100.0% | 100.0% |
| ineligible | 3 | 3 | 3 | 100.0% | 100.0% |

## 혼동행렬

행은 expected, 열은 actual이다.

| expected \\ actual | eligible | conditional | ineligible |
|---|---:|---:|---:|
| eligible | 3 | 0 | 0 |
| conditional | 0 | 3 | 0 |
| ineligible | 0 | 0 | 3 |

## Unknown 차원

- industry: 6
- certification: 3
- size: 3
- business_status: 2
- other: 2
- credit_status: 1
- sanction: 1
- tax_compliance: 1

현재 작은 회귀셋에서조차 `industry`가 가장 빈번한 unknown이다. 자동채움 세션에서 업종 필드가 채워지더라도, 공고 측 업종 조건이 `text_only` 또는 불완전 구조화인지 별도로 측정해야 한다.

## 평가 공고의 criterion 차원

- biz_age: 9
- industry: 6
- region: 4
- certification: 3
- credit_status: 3
- size: 3
- tax_compliance: 3
- business_status: 2
- founder_age: 2
- other: 2
- sanction: 2
- financial_health: 1

## 추출 준비도

- partial: 6
- structured_unreviewed: 3

## 자격 판정 신뢰도

- low: 6
- medium: 3

legacy 분류 정답은 9/9로 재현됐지만, 조건 확인도의 평균은 47%에 불과하다. 이는 기존의 조건부 60~95점 “적합도”가 실제 확인 완료 수준을 과장했다는 기준선이며, 앞으로 `fitScore` 호환 필드는 조건 확인도로만 해석한다.

## 현재 한계

- K-Startup 단일 원천의 legacy golden 9쌍만 포함한다.
- 동일 작성자가 선택한 소규모 회귀셋이므로 운영 정확도나 일반화 성능을 증명하지 않는다.
- legacy pair에는 criterion 단위 hard-fail/unknown 정답과 reviewer 이중 라벨이 없다.
- 기업마당, 개인사업자, 법인사업자 층화 평가는 matching-v3 수동 라벨 확장 후 가능하다.
- 기존 9개 사례는 모두 development로 취급하며 holdout 근거로 사용하지 않는다.

## 다음 확장 gate

- K-Startup·기업마당 공고 총 20건의 v3 draft annotation을 채운다.
- 개인·법인 회사 프로필 5건으로 seed를 확장한다.
- criterion 단위 source span, hard fail, unknown 정답을 기록한다.
- 최소 20%를 두 번째 reviewer가 독립 검수한다.
- 공고 100건·회사 30건·판정쌍 500건 이전에는 운영 정확도를 주장하지 않는다.

## Phase 1 운영 DB dry-run 관찰

2026-07-12에 demo company와 활성 기업마당 공고 20건을 대상으로 다음 명령을 **쓰기 없이** 실행했다.

```bash
pnpm match:states:refresh -- --limit=20
```

초기 결과:

- eligible 0 / conditional 0 / ineligible 20
- hard fail: size 18, region 15, biz_age 3, industry 2

trace 표본 검토에서 다음 false-negative 원인을 발견하고 수정했다.

1. 공고 `중소기업`과 회사 프로필 `중소`를 단순 문자열 불일치로 탈락 처리
2. `중소` 근사값만으로 `소상공인` 세부요건을 탈락 처리
3. 업력 min/max가 추출되지 않았는데도 기존 사업자를 fail 처리
4. 회사의 넓은 업종 라벨 `ICT, SW`만으로 세부 업종 `게임` 미해당을 확정

수정 후 동일 dry-run:

- eligible 0 / conditional 5 / ineligible 15
- hard fail: region 15건만 잔존
- extraction readiness: partial 19 / structured_unreviewed 1
- eligibility confidence: low 20
- 평균 조건 확인도 36%, 원문 근거 커버리지 100%

남은 15건의 hard fail 표본은 인천·울산·경남·제주 등과 경기 demo company의 지역 불일치였다. 따라서 이 slice에서 확인된 size·biz_age·label-only industry false negative는 제거됐고, 추출 준비도가 낮은 5건은 탈락 대신 확인 필요로 보존된다. 아직 `eligible`이 0인 것은 20건 표본과 demo company 조합의 결과이며 전체 서비스 recall을 의미하지 않는다.

DB에는 쓰지 않았으므로 배포 시 `scoring-verification-v3` 기준으로 dry-run 분포를 다시 확인한 뒤 다음 명령으로 snapshot을 갱신해야 한다.

```bash
pnpm match:states:refresh -- --companyId=<uuid> --limit=<n> --write
```

## Phase 3 동적 질문 planner dry-run

고정 우선순위의 “첫 unknown” 대신 다음 정보를 합산하는 질문 planner를 구현했다.

- 영향을 받는 고유 공고 수
- 답변 하나로 판정이 확정될 수 있는 공고 수
- required/exclusion 조건 중요도
- 마감 긴급도
- 질문 입력 부담

원문 근거가 없거나 `text_only`, 검수 전 criterion, 이미 hard-fail인 공고는 사용자 질문으로 떠넘기지 않는다.

demo company와 활성 공고 100건의 read-only dry-run 결과:

- 전체 판정: eligible 8 / conditional 74 / ineligible 18
- hard fail: region 18건
- 1순위 `industry`: 21개 공고 영향, 단일 positive-only 답변으로 판정 확정되는 공고는 0개
- 2순위 `size`: 5개 공고 영향, 2개 공고 판정 확정 가능
- 3순위 `business_status`: 2개 공고 영향

점진 질문에서 업종·인증 같은 list 값을 하나 선택할 때 기존 API 자동채움 배열을 덮어쓰는 문제도 함께 수정했다. 질문 저장은 `mode=merge`를 사용하고, 설정 화면의 명시 편집은 기본 `replace`를 유지한다. merge 시 기존 authoritative dimension confidence를 self-declared confidence로 낮추지 않는다.

추가 안전장치로 목록형 필드에 `list_completeness=partial|complete` 계약을 도입했다. `partial` 또는 기존 미설정 값은 positive-only로 해석하므로, 입력된 값과 공고 조건이 일치할 때만 판정 근거로 사용하고 불일치는 `unknown`으로 남긴다. 사용자가 전체 목록을 명시한 `complete`에서만 부재를 required fail 또는 exclusion pass 근거로 사용한다. 따라서 question planner도 업종 단일 선택을 “판정 확정”으로 과대계상하지 않는다.

동일 dry-run의 최종 관찰값:

- 평균 조건 확인도 36%, 평균 원문 근거 커버리지 99%
- hard fail 18건은 모두 지역 조건
- 업종 21건, 규모 5건, 영업상태 2건 순으로 추가 질문 가치가 높음
- DB write 없음

## Phase 2 extraction manifest 운영 기준선

공고 전체 입력 완전성을 criteria 존재 여부만으로 추정하지 않도록 `GrantExtractionManifest`를 도입했다. 다음 명령은 회사 프로필과 무관하게 활성 공고의 source field, criterion 근거, 첨부 수집·변환 상태를 현재 DB 정본에서 읽는다.

```bash
pnpm report:extraction-readiness -- --limit=100 --samples=20
```

2026-07-12 활성 공고 100건 결과:

- source: 기업마당 100건
- readiness: partial 98 / structured_unreviewed 1 / unstructured 1
- attachment status: pending 128 / skipped 32 / converted 4
- warning 공고 수: attachment_conversion_incomplete 78, text_only_criterion_present 68, criterion_review_required 8
- criteria_missing 1, source_field_missing 1, source_section_missing 1
- recommendable 0, needs_core_review 82, not_recommended 18
- DB write 없음

`grant_raw.attachments`의 과거 상태만 사용하면 최신 변환 성공을 놓치므로, repository가 `grant_attachment_archives`와 `grant_application_surfaces.extraction_status`를 합성한 뒤 manifest를 계산한다. `preview_ready|fields_ready`는 converted, `skipped`는 처리 종결, `pending`만 conversion incomplete로 센다.

이 gate를 적용한 뒤 현재 100건의 `profileQuestionPlan`은 빈 배열이다. 이전 Phase 3 기준선의 업종 21건은 criterion만 보면 사용자 답변 가치가 있었지만, 공고 전체가 partial인 상태에서는 답변 후에도 추천 가능으로 승격할 수 없으므로 질문을 노출하지 않는 것이 맞다. 따라서 다음 실제 병목은 사용자 필드 추가가 아니라 pending 첨부 변환과 text_only 재추출이다.

surface 미등록 활성 기업마당 공고를 다음 명령으로 확인했으며, 제한 20건 모두 후보였다.

```bash
pnpm backfill:attachment-surfaces -- --source=bizinfo --limit=20
```

`--write`는 surface 생성과 외부 변환 작업 등록을 일으키므로 승인·비용·변환 서버 상태 확인 후 소량부터 실행한다.

## Phase 0 v3 검수 패킷 기준선

seed manifest를 `matching-v3-seed-v2`로 갱신했다.

- K-Startup 20건
- 기업마당 10건
- 회사 프로필 슬롯 5건

다음 명령으로 현재 predictor 결과와 짧은 source field, 첨부 상태를 함께 담은 redacted review task를 생성했다.

```bash
pnpm export:matching-v3-review-tasks -- --force
pnpm verify:matching-v3-review-tasks
```

생성 결과:

- `tmp/matching-v3-review-tasks.jsonl`: 검수 작업 30건
- `tmp/matching-v3-draft-grants.jsonl`: annotation template 30건
- partial 24 / structured_unreviewed 5 / unstructured 1
- predictor criterion 125개: structured 83 / text-only 42
- raw URL, archive URL, storage key, sha256 미포함 검증 통과

draft template은 predictor의 출력을 복사한 시작점이므로 정답이 아니다. draft template을 predictor와 비교하면 recall 100%가 나오는 것이 당연하며, evaluator는 이 상태를 `operationalReady=false`로 표시한다. 실제 운영 recall은 독립 reviewer가 `labelStatus=reviewed`로 확정한 `grants.jsonl`이 생긴 후에만 출력한다.

검수 패킷에서 확인된 즉시 수정 가능 오류:

- `중소기업`이 `소중기업`으로 저장된 size 오타
- `min_employees`, `min_revenue_krw`처럼 evaluator가 읽지 않는 alias key
- 기업마당 structured field에 중소기업·지역·법인사업자 조건이 있는데 LLM criteria가 0건인 사례

후속 코드에서는 size canonicalization, numeric alias 정규화, `trgetNm`·제목 지역 태그·사업요약 사업자 유형의 결정론적 backstop을 추가했다. 이 변화는 extractor 재실행 후 DB에 반영되므로 현재 운영 기준선 수치에는 아직 포함하지 않는다.
