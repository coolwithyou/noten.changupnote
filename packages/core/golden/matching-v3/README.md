# Matching v3 annotation dataset

이 디렉터리는 매칭 첫 미션의 운영 정확도를 평가하기 위한 annotation 계약과 seed manifest를 보관한다.

## 파일

- `annotation-schema.json`: JSONL record 한 줄의 JSON Schema. `company`, `grant`, `eligibility_pair` 세 종류를 허용한다.
- `seed-manifest.json`: K-Startup 20건·기업마당 10건과 5개 회사 슬롯. `pending`은 정답 라벨이 아니라 작업 대기 상태다.
- `company-profiles.draft.jsonl`: 실제 사업자정보가 아닌 개인사업자 2개·법인 1개의 synthetic draft archetype. 자동조회 정확도 근거가 아니다.
- `holdout-manifest.json`: 사람 라벨을 보기 전에 pair ID hash로 source×개인/법인 층화해 고정한 30% holdout 목록.
- `company-profiles.expanded.draft.jsonl`: 첫 미션 규모 검수를 위한 개인 15·법인 15 synthetic 회사 archetype.
- `expanded-seed-manifest.json`: K-Startup 50·기업마당 50 공고 snapshot.
- `expanded-holdout-manifest.json`: 확장 500쌍 중 사전 고정된 holdout 150쌍.
- 실제 annotation JSONL은 공고 원문 저작권과 회사정보 비식별화 정책을 확인한 후 추가한다.

## 라벨 상태

- `legacy`: 기존 v1/v2 회귀 fixture를 호환 변환한 값. 운영 정확도 근거로 사용하지 않는다.
- `draft`: 한 명의 annotator가 작성한 값.
- `reviewed`: 근거를 검수하고 확정한 값.

`reviewed`는 `annotatorId`, `annotatedAt`, 서로 다른 사람의 `reviewerId`, `reviewedAt`이 모두 있어야 한다. 공고 annotation은 검수 당시 원문의 `sourceRevision`도 보존해야 하며, 운영 게시 시 현재 revision과 다르면 재검수가 필요하다.

## 개발셋과 holdout

- `development`: parser, prompt, rule 개선 중 열람할 수 있다.
- `holdout`: 최종 평가 때만 실행한다. seed manifest 단계에서는 아직 배정하지 않는다.
- 최소 20%는 두 번째 reviewer가 독립적으로 검수한다.

## 데이터 원칙

- 공고 원문 전체를 복제하지 않고 archive ID/checksum과 짧은 source span을 기록한다.
- 실제 사업자번호, 대표자명, 상세주소는 fixture에 저장하지 않는다.
- `eligible` 정답에는 required/exclusion 조건별 근거가 있어야 한다.
- 판단할 정보가 없으면 억지로 eligible/ineligible을 만들지 않고 conditional로 라벨한다.

## 검증

```bash
pnpm verify:matching-eval-v3
pnpm report:matching-eval
pnpm report:matching-eval -- --format=markdown
pnpm export:matching-v3-review-tasks -- --output=tmp/matching-v3-review-tasks.jsonl
pnpm export:matching-v3-pair-review-tasks -- --force
pnpm verify:matching-v3-pair-review-tasks
pnpm report:matching-v3-pair-review-progress
pnpm export:matching-v3-review-workbench -- --force
pnpm export:matching-v3-company-archetypes -- --force
pnpm export:matching-v3-expanded-review-tasks -- --force
pnpm export:matching-v3-expanded-pair-review-tasks -- --force
pnpm verify:matching-v3-expanded-review-slice
```

## 검수 작업 흐름

1. `pnpm export:matching-v3-review-tasks -- --force`를 실행한다.
2. `tmp/matching-v3-review-tasks.jsonl`에서 source field, 첨부 상태, 예측 criterion을 확인한다.
3. `tmp/matching-v3-draft-grants.jsonl`의 annotation template을 실제 원문 기준으로 수정한다.
4. 1차 annotator는 `annotatorId`, `annotatedAt`을 기록하되 `labelStatus=draft`를 유지한다.
5. 독립 reviewer가 근거·누락 조건을 확인한 뒤에만 `reviewerId`, `reviewedAt`, `labelStatus=reviewed`를 기록한다.
6. 확정 파일을 `packages/core/golden/matching-v3/grants.jsonl`로 옮기고 다음을 실행한다.

```bash
pnpm report:criteria-extraction-eval
pnpm verify:criteria-extraction-eval
```

review task와 draft template은 extractor의 현재 예측이므로 정답이 아니다. draft를 예측과 비교한 100% recall은 파이프라인 연결 검증일 뿐 운영 정확도로 사용하지 않는다.

### 회사 프로필과 eligibility pair 검수

`company-profiles.draft.jsonl`은 실제 사업자번호·대표자·주소를 포함하지 않는 통제된 synthetic 프로필이다. 다음 명령은 공고 30건과 프로필 3개를 교차해 90개 pair review task를 만든다.

```bash
pnpm export:matching-v3-pair-review-tasks -- --force
pnpm verify:matching-v3-pair-review-tasks
pnpm report:matching-v3-pair-review-progress
```

`tmp/matching-v3-draft-pairs.jsonl`의 `expectedEligibility`, hard-fail/unknown criterion ID는 현재 엔진 예측이다. annotator는 공고 annotation과 synthetic 회사 fact를 독립적으로 대조해 수정하고, reviewer가 확정하기 전에는 `labelStatus=draft`를 유지한다. 현재 90쌍은 개발 slice이며 첫 미션 기준인 reviewed 500쌍을 대체하지 않는다. holdout은 엔진과 불일치한 사례를 본 뒤 선택하면 안 되며 별도의 사전 층화 배정이 필요하다.

현재 holdout은 이미 `holdout-manifest.json`에 27쌍으로 고정돼 있고 나머지 63쌍이 development다. 기본 진행 보고서는 development 결과만 계산한다. 최종 평가 시에만 다음 명시적 gate로 holdout을 연다.

```bash
pnpm report:matching-v3-pair-review-progress -- \
  --open-holdout \
  --confirm=OPEN_MATCHING_V3_HOLDOUT
```

### 오프라인 review workbench

JSONL 직접 편집 오류를 줄이기 위해 네트워크가 완전히 차단된 단일 HTML workbench를 생성할 수 있다.

```bash
pnpm export:matching-v3-review-workbench -- --force
open tmp/matching-v3-review-workbench.html
```

기본 workbench에는 synthetic 회사 3건, 공고 30건, development pair 63건이 들어간다. 항목별 redacted 근거와 엔진 예측을 비교하고 annotation JSON을 편집한다. 1차 완료 표시에는 검수자 ID, 독립 검토 확인, prediction placeholder 제거가 필요하다. reviewer 확정에는 기존 annotator와 다른 사람 ID가 필요하며 알려진 AI reviewer 식별자는 차단한다. 편집 내용은 packet별 localStorage에 임시 저장되고 현재 탭을 JSONL로 내보낼 수 있다. 내보낸 파일은 여전히 repository CLI validator를 통과해야 한다.

holdout workbench는 최종 평가 시에만 명시적으로 만든다.

```bash
pnpm export:matching-v3-review-workbench -- \
  --include-holdout \
  --confirm=BUILD_MATCHING_V3_HOLDOUT_WORKBENCH \
  --force
```

### review batch 검증과 최종화

workbench에서 회사·공고·판정쌍 탭을 각각 JSONL로 내보낸 뒤 batch gate를 실행한다. 기본은 검증만 하고 파일이나 DB를 쓰지 않는다.

```bash
pnpm finalize:matching-v3-review-batch -- \
  --stage=reviewed \
  --companies=<matching-v3-company-annotations.jsonl> \
  --grants=<matching-v3-grant-annotations.jsonl> \
  --pairs=<matching-v3-pair-annotations.jsonl>
```

batch gate는 다음을 한 번에 확인한다.

- task와 annotation의 ID 집합·중복 여부
- 회사 business kind·source fixture 고정
- 공고 source/title/revision 고정
- pair의 grant/company 참조와 preassigned split 고정
- prediction placeholder 제거와 독립 검수 메모
- hard-fail/unknown criterion ID가 reviewed grant에 실제 존재하는지
- eligible/conditional/ineligible과 hard-fail/unknown 배열의 논리 일관성
- annotator/reviewer 독립성과 관련 회사·공고의 reviewed 상태

통과한 development reviewed batch를 fixture 후보 디렉터리에 쓰려면 별도 확인이 필요하다. 이는 운영 DB publication이 아니다.

```bash
pnpm finalize:matching-v3-review-batch -- \
  --stage=reviewed \
  --companies=<...> --grants=<...> --pairs=<...> \
  --write \
  --confirm=FINALIZE_MATCHING_V3_REVIEW_BATCH
```

### 첫 미션 규모 확장 slice

소형 30×3 packet의 workflow를 검증한 뒤 다음 명령으로 첫 미션 목표 수량의 draft packet을 재현한다.

```bash
pnpm export:matching-v3-company-archetypes -- --force
pnpm export:matching-v3-expanded-review-tasks -- --force --asOf=2026-07-12T00:00:00.000Z
pnpm export:matching-v3-expanded-pair-review-tasks -- --force
pnpm verify:matching-v3-expanded-review-slice
pnpm report:matching-v3-expanded-review-progress
pnpm export:matching-v3-review-workbench -- \
  --companies=packages/core/golden/matching-v3/company-profiles.expanded.draft.jsonl \
  --grant-tasks=tmp/matching-v3-expanded-grant-review-tasks.jsonl \
  --pair-tasks=tmp/matching-v3-expanded-pair-review-tasks.jsonl \
  --output=tmp/matching-v3-expanded-review-workbench.html \
  --force
```

현재 확장 packet은 활성 universe 1,898건을 limit 잘림 없이 읽어 만든 공고 100건(K-Startup 50, 기업마당 50), 회사 30건(개인 15, 법인 15), 판정쌍 500건이다. 모든 공고·회사를 최소 한 번 포함하며 development 350 / holdout 150으로 사전 고정했다. 현재 예측은 ineligible 259 / conditional 218 / eligible 23이고 reviewed는 0이다.

이 수량은 draft 작업 큐가 준비됐다는 뜻이며 정답 500쌍이 완성됐다는 뜻이 아니다. 사람 annotator와 독립 reviewer 확정 전에는 운영 정확도 지표에 포함하지 않는다.

workbench에서 내보낸 확장 annotation의 development 진행률과 batch 계약은 다음처럼 확인한다. `--packet=expanded`는 작은 패킷이 아니라 확장 회사·공고·pair task 경로를 고정한다.

```bash
pnpm report:matching-v3-expanded-review-progress -- \
  --annotations=<matching-v3-expanded-development-pair-annotations.jsonl>

pnpm finalize:matching-v3-review-batch -- \
  --packet=expanded \
  --stage=reviewed \
  --companies=<matching-v3-expanded-company-annotations.jsonl> \
  --grants=<matching-v3-expanded-grant-annotations.jsonl> \
  --pairs=<matching-v3-expanded-pair-annotations.jsonl>
```

기본 검증은 development 350쌍만 대상으로 하고 holdout 150쌍은 열지 않는다. 최종 평가 시에만 `--include-holdout --holdout-confirm=OPEN_MATCHING_V3_HOLDOUT`을 finalizer에 추가한다. 검증을 통과해도 파일 쓰기는 별도의 `--write --confirm=FINALIZE_MATCHING_V3_REVIEW_BATCH` 없이는 수행되지 않는다.

### K-Startup LLM draft 검수와 운영 게시

LLM 초안은 golden 또는 운영 criterion이 아니다. 다음 경계로만 이동한다.

```bash
# 외부 호출 없는 후보 계획
pnpm extract:kstartup-criteria-drafts -- --limit=5

# 승인 후에만 외부 호출, DB write 없음
pnpm extract:kstartup-criteria-drafts -- \
  --extract --confirm=EXTRACT_KSTARTUP_CRITERIA \
  --sourceIds=<source-id-1,source-id-2> \
  --output=tmp/kstartup-llm-drafts.jsonl

# 현재 공고와 대조한 검수 패킷 생성
pnpm export:kstartup-draft-review-tasks -- \
  --input=tmp/kstartup-llm-drafts.jsonl \
  --output=tmp/kstartup-llm-review-tasks.jsonl \
  --annotations-output=tmp/kstartup-llm-draft-annotations.jsonl

# reviewed 레코드만 게시 가능한지 dry-run
pnpm publish:reviewed-grant-annotations -- \
  --input=tmp/kstartup-llm-draft-annotations.jsonl
```

annotator가 `annotatorId`, `annotatedAt`을 기록하고, 서로 다른 사람인 reviewer가 `labelStatus=reviewed`, `reviewerId`, `reviewedAt`을 채우며 structured criterion의 `sourceSpan`을 확인하기 전에는 게시할 수 없다. template의 `sourceRevision`은 검수 대상 원문을 고정하므로 수정하지 않는다. 현재 revision이 달라지면 새 packet으로 재검수한다. 실제 쓰기는 별도 `--write --confirm=PUBLISH_REVIEWED_GRANT_ANNOTATIONS` 승인이 모두 필요하다. 게시 시 해당 공고의 stale `match_state`가 삭제되므로 이후 match-state refresh가 필요하다. `draft|legacy` 레코드는 같은 파일에 있어도 건너뛴다.
