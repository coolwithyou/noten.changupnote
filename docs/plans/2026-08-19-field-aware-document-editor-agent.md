# 필드 인식 문서 편집 AI 에이전트 실행 계획

- 작성일: 2026-08-19
- 적용 화면: `/grants/[grantId]/workspace`
- 기준 상태: `origin/main` `2891e84231adbbbebf28f14849636f911be7cfe0`
- 상태: **제품 방향 정본 · Phase 1 atomic text, Phase 2 양방향 field loop, Phase 3 choice/form text 구현·실사용 검증 완료**
- 선행 기반:
  - [`2026-07-22-rhwp-field-agent-workspace.md`](./2026-07-22-rhwp-field-agent-workspace.md)
  - [`2026-08-18-document-editor-ai-agent.md`](./2026-08-18-document-editor-ai-agent.md)
  - [`2026-08-19-rhwp-studio-native-document-agent-bridge.md`](./2026-08-19-rhwp-studio-native-document-agent-bridge.md)

> 이 문서는 문서 작성 제품의 최상위 방향 정본이다. 위 선행 문서와 충돌하는 제품 흐름, 화면 구성,
> AI target 결정은 이 문서가 우선한다. 선행 문서의 Studio 저장·revision·native command·검증 자산은
> 재사용하지만, `빠른 작성 우선`과 `일반 본문 문단 우선 AI` 결정은 더 이상 제품 주 흐름이 아니다.

## 0. 사용자 확정 방향

이 작업의 핵심은 다음 한 문장으로 고정한다.

> **완전한 HWP/HWPX 편집기를 작업공간의 중심에 두고, 그 옆의 AI 패널이 문서의 구조화된 필드를
> 인식해 근거 있는 값을 제안하며, 사용자가 대안을 선택하면 열린 문서의 정확한 필드에 즉시
> 자동 입력하고 검증된 revision으로 저장한다.**

여기서 각 표현은 다음 의미를 가진다.

- `완전한 편집기`: 사용자가 문서 전체를 직접 편집할 수 있는 rhwp Studio다. 이미지 프리뷰나
  별도 textarea가 본체가 아니다.
- `옆의 AI 패널`: 데스크톱에서 Studio와 동시에 보이는 영속 레일이다. 별도 모드로 전환해 Studio를
  가리거나 빠른 작성 화면으로 돌아가야만 사용할 수 있는 패널이 아니다.
- `필드 인식`: AI 작업 단위의 권위값은 `ConnectedDocumentField.fieldId`와 서버가 현재 revision에서
  재구축한 exact 구조 anchor다. 쪽 번호나 임의 본문 문단이 주 target이 아니다.
- `값 제안`: LLM은 필드 label/type/current value와 검증된 공고·기업·사용자 근거를 사용해 0~2개의
  대안을 만든다. 좌표·셀 인덱스·fieldId를 새로 만들지 않는다.
- `선택`: 사용자가 제안 대안을 명시적으로 고른다. 사용자 승인 없는 문서 mutation은 없다.
- `자동 입력`: 승인 후 이미 열린 Studio의 in-memory 문서에서 exact field command를 실행한다.
  복사 안내나 다음 진입 때 일괄 materialize하는 것을 자동 입력 완료로 부르지 않는다.
- `저장`: 문서 revision head와 필드 workflow 상태가 한 작업으로 함께 확정돼야 한다.

## 1. 방향이 다시 벗어나지 않기 위한 우선순위

아래 우선순위는 구현 편의나 기존 코드량보다 높다.

1. **편집기가 본체다.** `/workspace` 진입 후 지원되는 HWP/HWPX가 있으면 Studio가 주 작성 표면이다.
2. **필드가 AI의 기본 작업 단위다.** 일반 문단 개선은 필드 흐름 완성 뒤의 보조 기능이다.
3. **편집기와 AI 필드 레일은 동시에 존재한다.** `quick | studio` 상호배타 토글을 주 흐름으로 두지 않는다.
4. **문서가 저장 진실의 원본이다.** `fieldAnswers`가 최신 문서 revision보다 앞서 확정된 상태가 되지 않는다.
5. **사용자가 적용을 승인한다.** 제안 생성과 문서 변경을 구분한다.
6. **LLM은 의미를, rhwp는 위치와 보존을 책임진다.** 모델 출력으로 구조 target을 정하지 않는다.
7. **지원하지 않는 필드는 정직하게 수동 편집으로 남긴다.** fuzzy 위치나 첫 번째 문자열 선택을 하지 않는다.

이 중 하나라도 충족하지 못하는 구현은 기반 기술 진척일 수는 있어도 이 계획의 제품 milestone을
완료한 것으로 기록하지 않는다.

## 2. 현재 구현에서 재사용할 것과 교정할 것

### 2.1 그대로 재사용할 기반

- `RhwpStudioSurface`의 전체 문서 편집, 수동 저장, autosave, 다운로드
- `grant_document_revisions`와 head CAS, R2 artifact, 멱등 저장
- `resolveRhwpFieldAnchorsExact()`와 수동 anchor 보정
- native Studio command capability, document epoch/change sequence, exact receipt
- 서버의 공고·기업정보·검증된 deep grounding
- LLM structured output, 근거 quote 검증, usage ledger
- apply/Undo operation version, 저장 실패·재시도·복구 원칙
- HWP/HWPX export/reopen과 page-count/semantic 검증

### 2.2 제품 주 흐름에서 교정할 현재 결정

- 기본 `authoringMode="quick"`와 `빠른 작성 | 문서 직접 편집` 상호배타 토글
- quick `FieldPanel`에서 값을 확정한 뒤 Studio 진입 시 나중에 materialize하는 흐름
- `AI 작성 제안`에서 쪽과 일반 본문 문단을 사용자가 다시 고르는 흐름
- connected field와 겹치는 모든 위치를 AI 후보에서 제외하는 흐름
- AI suggestion 상태와 `fieldAnswers`·document revision이 서로 다른 lifecycle을 갖는 흐름
- Studio에서 현재 과제 label만 보여주고 필드 목록·근거·대안을 숨기는 화면

### 2.3 보조 기능으로 내릴 현재 일반 문단 에이전트

현재 `document-agent-v1`의 안전한 단일 본문 문단 개선은 삭제하지 않는다. 다만 다음 조건을 지킨다.

- 필드 에이전트 MVP와 같은 CTA 이름을 쓰지 않는다.
- 기본 레일과 workspace 진입 흐름에 노출하지 않는다.
- 추후 `문장 다듬기` 보조 기능으로만 제공한다.
- 선택한 장문 필드 또는 사용자가 명시적으로 선택한 일반 문단에서만 실행한다.
- 필드 agent의 완료 증거로 일반 문단 apply/Undo 테스트를 대신하지 않는다.

## 3. 금지하는 대체 구현

다음은 기능이 비슷해 보여도 이 계획의 구현으로 인정하지 않는다.

1. Studio를 전체 화면으로 열고 AI 필드 패널을 다른 모드나 다른 URL에 두는 것
2. 기존 빠른 작성 카드에 AI를 추가한 뒤 최종 다운로드 때만 문서에 합치는 것
3. 쪽 번호와 본문 문단을 고르게 하고 이를 필드 인식이라고 부르는 것
4. bbox, label 문자열의 첫 일치, 모델이 만든 좌표로 입력 위치를 선택하는 것
5. 제안 선택 시 `fieldAnswers`만 갱신하고 열린 Studio 문서를 바꾸지 않는 것
6. 열린 Studio를 바꾼 뒤 revision 저장 실패를 성공으로 표시하는 것
7. 지원하지 않는 표·선택지·병합 셀을 일반 textarea로 축약하는 것
8. AI가 자동으로 적용한 뒤 사용자가 취소하도록 만드는 opt-out 방식
9. 일반 문단 에이전트의 테스트를 필드 자동 입력 수용 테스트로 재사용하는 것
10. 단위·빌드 통과만으로 실제 HWP/HWPX 통합 milestone을 완료 처리하는 것

## 4. 목표 사용자 흐름

```text
지원서 작성 시작
  -> 최신 draft revision을 연 rhwp Studio
  -> 오른쪽 AI 필드 레일에 현재 문서의 필드 목록 표시
  -> 첫 미완료 필드 선택
  -> Studio가 exact field anchor로 이동·강조
  -> 현재 값, 작성 기준, 검증 근거 표시
  -> 사용자가 "제안 받기"
  -> LLM이 해당 fieldId에 결속된 대안 0~2개 반환
  -> 사용자가 대안 선택 또는 직접 수정
  -> "이 값으로 채우기"
  -> 열린 Studio exact field command
  -> export/reopen 검증
  -> revision head + suggestion + field workflow 원자 저장
  -> 다음 미완료 필드로 이동
```

### 4.1 데스크톱 화면

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 공고명 · 문서 선택 · 저장 상태 · 진행률                                    │
├──────────────────────────────────────────────┬───────────────────────────────┤
│                                              │ AI 작성 도우미                │
│              rhwp Studio 72%                 │ 검색 · 미완료 필드 목록       │
│                                              │───────────────────────────────│
│   선택 필드 focus/highlight                  │ 현재 필드 label/type/value   │
│   전체 문서 직접 편집 가능                   │ 작성 기준 · 검증 근거         │
│                                              │ 제안 A / 제안 B / 직접 수정  │
│                                              │ [이 값으로 채우기]            │
└──────────────────────────────────────────────┴───────────────────────────────┘
```

- 기본 비율은 Studio 72%, AI 레일 28%다.
- 사용자는 레일을 접을 수 있지만 Studio와 레일은 같은 route와 같은 session을 유지한다.
- 1280px 미만에서는 Studio를 전면으로 두고 AI 레일을 오른쪽 Sheet로 연다.
- 768px 미만에서는 선택 필드 요약을 하단 고정 bar에 표시하고 Sheet에서 제안을 검토한다.

### 4.2 양방향 선택 동기화

- 레일에서 필드를 선택하면 Studio가 exact target으로 이동하고 강조한다.
- Studio에서 연결 필드를 선택하면 레일의 활성 `fieldId`가 바뀐다.
- Studio selection이 연결 필드가 아니면 `연결되지 않은 문서 영역`이라고 표시한다.
- focus 실패 시 페이지까지만 이동하고 `정확한 입력 위치를 찾지 못했습니다`를 표시한다.
- focus 실패한 필드에는 자동 입력 CTA를 제공하지 않는다.

### 4.3 제안과 적용

- deterministic profile 값은 `기업정보` 출처의 추천으로 표시할 수 있다.
- LLM 제안은 공고·기업·사용자가 제공한 사실·검증된 deep source에 근거해야 한다.
- 제안 카드는 값, 작성 이유, 근거 source/quote, 생성 시점 current value를 표시한다.
- 선택 전에는 문서를 변경하지 않는다.
- `이 값으로 채우기`가 성공하면 열린 Studio에서 즉시 값이 보여야 한다.
- 적용 성공 뒤에만 `적용됨`과 새 revision 저장 상태를 표시한다.
- 적용 실패 또는 충돌 시 field workflow를 완료로 만들지 않는다.

## 5. 필드 권위 계약

### 5.1 AI target

AI target은 서버가 현재 document revision에서 재구축한 다음 binding이다.

```ts
type FieldEditTargetV1 =
  | {
      kind: "table_cell_text";
      section: number;
      parentPara: number;
      controlIndex: number;
      cellIndex: number;
      cellParagraph: number;
    }
  | {
      kind: "form_text";
      section: number;
      paragraph: number;
      fieldId: number;
    }
  | {
      kind: "choice_control";
      section: number;
      parentPara: number;
      controlIndex: number;
      optionTargets: Array<Record<string, number>>;
    }
  | {
      kind: "field_bound_longform";
      section: number;
      paragraph: number;
      charOffset: 0;
      length: number;
    };

interface FieldBindingV1 {
  schemaVersion: "field-agent-v1";
  draftId: string;
  revisionId: string;
  documentSha256: string;
  fieldId: string;
  fieldKey: string;
  label: string;
  fieldType: string;
  target: FieldEditTargetV1;
  targetFingerprint: string;
  currentValueSha256: string;
  formatSha256: string;
  adjacentContextSha256: string;
}
```

- `fieldId`, `fieldKey`, label/type, target은 서버가 `connectedFields`와 exact resolver로 만든다.
- 클라이언트는 `fieldId`를 선택 힌트로 보낼 수 있지만 target 좌표를 권위값으로 보내지 않는다.
- LLM은 target을 입력받아도 그대로 출력할 필요가 없고 좌표를 생성할 수 없다.
- 서버는 suggest와 apply 직전에 binding 전체를 다시 계산한다.
- revision/document/current value/target/format/context 중 하나라도 바뀌면 기존 제안은 `stale`이다.

### 5.2 1차 지원 필드

가장 빠른 실제 vertical slice는 다음으로 제한한다.

- exact resolver가 `unique`로 확정한 `table_cell_text`
- 기존 값이 비어 있거나, 마지막 agent apply 값과 exact 일치하는 셀
- 단일 문자열 값, 최대 4,000자
- 기존 셀 서식과 단위 suffix를 보존할 수 있는 셀
- HWP와 HWPX 모두 동일 command contract를 통과하는 필드

다음은 후속 phase다.

- checkbox/radio/select
- form field
- 장문 body region
- 반복 행 추가/삭제
- 병합 셀 복합 편집
- 이미지·서명·도장·첨부

지원하지 않는 target은 필드 레일에는 남기되 `문서에서 직접 작성`으로 표시한다.

## 6. LLM 제안 계약

### 6.1 입력

모델에는 다음만 전달한다.

- `fieldId`, label, field type, 작성 범위와 길이 제한
- 현재 필드 값과 field-local adjacent context
- 동일 문서의 관련 섹션 제목·표 머리글
- 검증된 공고 원문
- 현재 회사 profile과 사용자가 확인한 사실
- serving 가능한 deep source
- 선택지 필드인 경우 서버가 읽은 exact option 목록

전체 문서 바이트, 구조 좌표, R2 key, 다른 회사 데이터는 전달하지 않는다.

### 6.2 출력

```ts
interface FieldSuggestionAlternativeV1 {
  fieldId: string;
  value: string;
  rationale: string;
  evidenceRefs: Array<{ sourceId: string; quote: string }>;
}
```

- 한 요청에서 같은 필드 대안은 최대 2개다.
- 출력 `fieldId`가 요청 binding과 다르면 폐기한다.
- choice 값은 exact options에 포함된 값만 허용한다.
- 길이·제어문자·줄바꿈·필드 종류별 validator를 통과해야 한다.
- 근거 quote가 source에 실제로 없으면 폐기한다.
- 근거가 부족하면 빈 대안을 정상 결과로 반환한다.
- prompt injection 문자열은 source 데이터로만 다룬다.

### 6.3 호출 시점

- workspace open, 필드 선택, 문서 selection 변경만으로 모델을 호출하지 않는다.
- 사용자가 `제안 받기`를 누른 경우에만 해당 필드 모델 호출을 시작한다.
- 선택한 여러 필드의 제안을 준비하는 batch 기능은 별도 명시 버튼과 예산 표시가 있을 때만 추가한다.
- 동일 request ID와 binding 재시도는 모델 호출과 usage를 한 번만 기록한다.

## 7. deep module과 seam

UI가 알아야 할 외부 interface는 하나로 제한한다.
`createFieldAwareDocumentAgent({ draftId, adapters })`가 draft에 결속된 아래 module을 반환하며,
호출자가 route·Studio command adapter를 각각 조립하지 않는다.

```ts
interface FieldAwareDocumentAgent {
  loadSession(): Promise<FieldEditorSessionView>;
  requestSuggestions(input: {
    fieldId: string;
    clientRequestId: string;
  }): Promise<FieldSuggestionSet>;
  applySuggestion(input: {
    suggestionId: string;
    operationClientId: string;
    expectedRevisionId: string;
    expectedStateVersion: number;
  }): Promise<FieldApplyResult>;
  undoLastApply(input: {
    applyId: string;
    operationClientId: string;
    expectedRevisionId: string;
  }): Promise<FieldUndoResult>;
}
```

이 module의 implementation이 다음 복잡성을 숨긴다.

- field binding 재구축과 stale 판정
- grounding과 LLM output 검증
- Studio focus/apply/revert command
- export/reopen 검증
- snapshot upload와 revision head CAS
- suggestion/field workflow 원자 전환
- retry, ACK 유실, timeout recovery
- 현재 필드와 다음 미완료 필드 계산

실제 seam은 두 곳이다.

1. **서버 remote seam**: production HTTP adapter와 테스트용 in-memory adapter
2. **Studio embed seam**: `@rhwp/editor` command adapter와 테스트용 fake Studio adapter

UI가 route 호출 순서, operation version, command receipt를 직접 조립하지 않는다. 테스트도 위 interface를
통해 관찰 가능한 session/suggestion/document/revision 결과를 검증한다.

## 8. Studio field command bridge

현재 body paragraph command를 field command로 가장하지 않는다. 공개 capability를 확장한다.

```text
field-target-navigation-v1
field-selection-events-v1
field-agent-command-v1
```

```ts
editor.focusFieldTarget(target): Promise<{ focused: boolean; page: number }>;
editor.getSelectedFieldContext(): Promise<FieldSelectionContextV1>;
editor.applyFieldCommand(command): Promise<FieldCommandReceiptV1>;
editor.revertFieldCommand(command): Promise<FieldCommandReceiptV1>;
```

`applyFieldCommand`는 한 Studio transaction에서 다음을 수행한다.

1. document epoch/changeSeq/SHA와 exact target fingerprint를 확인한다.
2. current value/format/context를 binding과 비교한다.
3. snapshot과 batch를 연다.
4. field kind에 맞는 native mutation을 실행한다.
5. target 값, 비대상 semantic manifest, page count를 검증한다.
6. 실패하면 render/change event 없이 rollback한다.
7. 성공하면 render 1회, changeSeq +1, strict receipt를 반환한다.

일반 사용자의 Studio undo stack과 agent command journal은 충돌하지 않아야 한다. agent apply 뒤 사용자가
해당 필드나 다른 영역을 편집했다면 자동 revert를 거부하고 새 제안을 만들게 한다.

## 9. 문서와 필드 상태의 단일 저장 계약

### 9.1 진실의 원본

- 최신 `grant_document_revision_heads.revision_id`의 문서 바이트가 작성 결과의 정본이다.
- `fieldAnswers`는 문서 head에서 확인 가능한 workflow/evidence projection이다.
- `accepted|edited` field answer에는 `materializedRevisionId`와 `valueSha256`가 있어야 한다.
- head에 아직 반영되지 않은 suggested value는 `suggested`일 수 있지만 `accepted`로 표시하지 않는다.

### 9.2 apply 원자 흐름

```text
서버 apply authorization
  -> current field binding/state version 확인
  -> Studio field command
  -> 검증 export
  -> snapshot upload
  -> DB transaction
       revision insert
       head CAS
       suggestion applied
       field answer accepted/materialized
       field task state confirmed 또는 review_required
  -> ACK
```

- DB transaction 실패 시 성공 UI를 표시하지 않는다.
- Studio mutation 뒤 저장 실패는 existing apply failure/retry/rollback contract를 재사용한다.
- retry는 같은 after bytes와 command ID를 저장만 재시도하며 field mutation을 반복하지 않는다.
- 다른 탭이 head를 전진시킨 409에서는 자동 merge하지 않고 최신 head를 다시 불러온다.
- ACK 유실 재시도는 같은 revision과 field state를 반환한다.

### 9.3 suggestion persistence

기존 일반 문단 agent history에 field target을 억지로 넣지 않는다. field-specific run/suggestion entity를
추가한다.

```text
grant_document_field_agent_runs
  draft, field, base revision, field binding, grounding binding,
  request/lease/model/usage/status

grant_document_field_agent_suggestions
  run, alternative value/evidence, status/version,
  applied revision, undo revision, operation state/version
```

기존 `grant_document_agent_*` row와 API는 일반 문단 기능의 역사와 보조 기능으로 유지한다.

## 10. 구현 단계

### Phase 0 — 방향 고정과 회귀 가드

- 이 문서를 제품 정본으로 연결한다.
- 기존 세 계획에 새 정본 우선 표시를 추가한다.
- `WorkspaceView` render test에 다음 실패 조건을 먼저 추가한다.
  - 지원 가능한 persistent draft에서 Studio와 field rail이 동시에 존재하지 않으면 실패
  - 기본 화면에 `빠른 작성 | 문서 직접 편집` 주 모드 토글이 있으면 실패
  - field agent CTA가 page/body candidate API를 호출하면 실패
- 일반 문단 agent flag와 새 field editor agent flag를 분리한다.

수용 기준: 코드 변경을 시작하기 전에 잘못된 quick-first/paragraph-first UI가 테스트에서 red가 된다.

### Phase 1 — 한 필드 end-to-end vertical slice

대상은 exact `table_cell_text` 한 종류로 제한한다.

1. workspace를 Studio + field rail 동시 레이아웃으로 바꾼다.
2. current connected fields와 exact anchor 상태를 rail에 표시한다.
3. rail에서 필드를 선택하면 Studio `focusFieldTarget()`으로 이동한다.
4. 기존 field suggestion grounding을 field-bound run/suggestion으로 옮긴다.
5. 제안 하나를 선택해 native `applyFieldCommand()`로 열린 문서에 입력한다.
6. 검증 snapshot과 field workflow를 한 revision에 저장한다.
7. 가장 최근 field apply를 exact revert하고 새 undo revision을 저장한다.

수용 기준:

- 실제 HWP와 HWPX 각각 1개에서 같은 시나리오가 통과한다.
- 편집기와 AI rail이 동시에 보인다.
- 필드 선택 즉시 정확한 셀로 이동한다.
- 적용 전 mutation 0회, 적용 후 열린 문서에서 값이 즉시 보인다.
- 새로고침과 다운로드 뒤에도 값이 유지된다.
- 문서 head와 accepted field state가 같은 revision을 가리킨다.

### Phase 2 — 양방향 선택과 작업 루프

- Studio `selectionChanged`에서 field context를 부모에 전달한다.
- Studio selection → rail active field 동기화
- next incomplete field navigation
- 완료, 미완료, 근거 부족, 수동 작성, stale 상태
- rail 검색·필터와 keyboard navigation
- desktop rail, tablet/mobile Sheet

수용 기준: rail→Studio와 Studio→rail 양방향 선택이 actual document에서 동일한 `fieldId`를 가리킨다.

### Phase 3 — 필드 종류 확장

순서는 다음과 같다.

1. atomic text + 단위 suffix
2. checkbox/radio/select
3. form text
4. field-bound longform
5. 반복 표의 existing-row cell

각 종류는 target resolver, validator, command, revert, HWP/HWPX corpus가 모두 있을 때만 활성화한다.
반복 행 생성, 병합 구조 변경, 서명/도장은 별도 계획 전까지 수동 편집이다.

### Phase 4 — 기존 빠른 작성 상태 이전

- 기존 `suggested` field answer는 rail의 미적용 제안으로 읽을 수 있다.
- 기존 `accepted|edited` 값은 head의 `materializedAnswers`와 exact 일치할 때만 적용 완료로 표시한다.
- 불일치 값은 `review_required`로 보내며 문서를 자동 덮어쓰지 않는다.
- 지원 문서에서는 quick-first 화면을 기본 진입에서 제거한다.
- Studio capability가 없거나 HWP/HWPX가 없는 문서에서만 기존 빠른 작성을 fallback으로 유지한다.

수용 기준: fallback이 정상 제품 경로를 가리거나 완료 증거로 사용되지 않는다.

### Phase 5 — 일반 문장 개선 보조 기능

- 현재 `document-agent-v1`을 `문장 다듬기`로 이름과 CTA를 분리한다.
- field-bound longform 또는 명시 selection에서만 연다.
- 필드 레일의 `제안 받기`와 다른 상태·API·telemetry를 사용한다.
- field agent rollout 완료 전에는 production 주 CTA에 노출하지 않는다.

### Phase 6 — 제한 롤아웃

- 내부 계정
- exact anchor가 모두 unique인 HWP/HWPX 문서
- atomic text field만 있는 cohort
- 선택지/longform 순차 확장
- unsupported target과 오류율을 관측한 뒤 확대

## 11. 파일 변경 지도

| 위치 | 계획된 책임 |
| --- | --- |
| `WorkspaceView.tsx` | quick/studio 모드 대신 integrated editor session 조립 |
| `RhwpStudioSurface.tsx` | Studio 본체와 저장 상태, field command adapter 연결 |
| `FieldAgentRail.tsx` | 필드 목록, 현재 필드, 근거, 대안, 적용/Undo UI |
| `fieldAwareDocumentAgent.ts` | UI가 사용하는 깊은 module interface와 coordinator |
| `fieldBindings.ts` | revision 기준 서버 권위 field binding 재구축 |
| `fieldAgentPrompt.ts` | field-aware structured prompt/output 검증 |
| `studioFieldTransaction.ts` | focus/apply/revert command와 receipt 검증 |
| `documentRevisions.ts` | field apply/undo revision과 workflow 원자 전환 |
| `fieldAnchors.ts` | exact target resolver; 좌표 생성은 계속 금지 |
| `@rhwp/editor`/Studio | field navigation/selection/command capability |

파일명은 구현 전 현재 구조와 충돌을 다시 확인한 뒤 확정하되, 책임을 여러 UI caller에 흩뜨리지 않는다.

## 12. 테스트 전략

### 12.1 interface 테스트

`FieldAwareDocumentAgent` interface에서 다음을 검증한다.

- session load가 current revision과 field binding을 반환
- suggest는 fieldId/revision/binding에 결속
- invalid fieldId, stale revision, forged target에서 model/mutation 0회
- apply 전 document mutation 0회
- apply 성공 시 document/revision/field state 동시 전환
- apply ACK 유실의 멱등 복구
- undo가 가장 최근 exact field apply에만 성공
- 두 탭 head CAS에서 loser가 문서를 덮어쓰지 않음

### 12.2 Studio command 테스트

- HWP/HWPX `table_cell_text` focus/apply/revert
- current value, anchor, format, context mismatch mutation 0회
- 단위 suffix와 비대상 셀/문단/서식 보존
- page count와 semantic manifest 불변
- command replay와 binding mismatch
- 일반 편집 뒤 revert 거부
- capability 미지원 시 자동 입력 CTA 비활성화

### 12.3 브라우저 수용 테스트

대상 URL:

```text
http://127.0.0.1:4010/grants/{grantId}/workspace
https://changupnote.com/grants/{grantId}/workspace
```

필수 시나리오:

1. 편집기와 AI field rail 동시 표시
2. rail field 선택 → exact cell focus
3. Studio cell 선택 → 같은 rail field 활성화
4. 제안 생성 → 근거/현재값/대안 표시
5. 대안 선택 → `이 값으로 채우기` → 열린 문서 즉시 반영
6. 새로고침 → 같은 revision/value 복원
7. 다운로드 → rhwp 및 한컴오피스 재개방
8. Undo → before value 복원과 새 revision
9. 두 탭 충돌 → loser reload 전 잠금
10. unsupported field → 수동 작성 안내, 자동 CTA 없음

뷰포트는 1440px, 1024px, 390px를 확인한다.

### 12.4 회귀 명령

```bash
pnpm test:document-agent
pnpm test:rhwp-field-agent
pnpm test:apply-workspace
pnpm verify:route-policy
pnpm verify:rls-policy
pnpm verify:grant-document-drafts
pnpm typecheck
pnpm build:web
pnpm test
git diff --check
```

기존 명령 통과는 필요조건일 뿐 field editor agent 완료 증거는 아니다. 새 interface·Studio field command·
실문서 browser test를 별도로 추가한다.

## 13. rollout과 feature flag

- 새 서버 flag: `CUNOTE_FIELD_EDITOR_AGENT_ENABLED`
- 기존 `CUNOTE_DOCUMENT_AGENT_ENABLED`는 일반 문단 보조 기능과 분리한다.
- UI는 workspace server data의 availability만 사용하고 public env로 권한을 판단하지 않는다.
- flag off에서는 field model call, proposal write, field command가 모두 0회다.
- flag on이어도 field target capability와 exact binding이 없으면 자동 입력을 숨긴다.
- 원문·회사 입력값·제안 전문을 telemetry에 기록하지 않는다.

관측 이벤트:

```text
field_agent_session_opened
field_agent_field_selected
field_agent_focus_succeeded|failed
field_agent_suggestion_requested|ready|empty|failed
field_agent_apply_started|saved|failed|rolled_back
field_agent_undo_saved|failed
field_agent_revision_conflict
```

## 14. PR 드리프트 게이트

이 계획을 구현하는 모든 PR은 설명에 다음 답을 포함한다.

1. 이 PR 뒤 persistent workspace에서 Studio와 field rail이 동시에 보이는가?
2. AI target이 server-authoritative `fieldId + exact binding`인가?
3. 일반 page/body candidate를 primary target으로 다시 사용하지 않았는가?
4. 제안 적용이 열린 Studio의 exact field command를 호출하는가?
5. 적용 성공이 document revision과 field workflow를 함께 확정하는가?
6. 사용자 승인 전 mutation이 0회인가?
7. unsupported target이 fail-closed하는가?
8. 실제 HWP/HWPX browser 증거가 있는가? 없다면 어떤 단계의 기반 작업인가?

1~7 중 하나라도 `아니오`이면 제품 milestone PR로 merge하지 않는다. 8이 없으면 기반 PR로만 표시하고
해당 phase 완료를 선언하지 않는다.

## 15. 완료 정의

다음을 모두 만족해야 이 계획의 MVP가 완료된다.

- `지원서 작성 시작` 뒤 지원 문서에서는 integrated editor workspace가 기본으로 열린다.
- 데스크톱에서 완전한 Studio와 AI field rail이 동시에 보인다.
- 사용자가 field rail 또는 문서에서 필드를 선택할 수 있고 양쪽이 같은 fieldId로 동기화된다.
- LLM 대안이 해당 필드와 current revision에 exact 결속된다.
- 대안 선택 전 문서 mutation은 0회다.
- `이 값으로 채우기` 뒤 열린 문서의 정확한 필드에서 값이 즉시 보인다.
- apply/Undo가 검증된 descendant revision을 만들고 field state와 같은 revision에 결속된다.
- 새로고침, 빠른 재접속, 다운로드 뒤 값과 서식이 유지된다.
- HWP/HWPX 실제 corpus와 한컴오피스에서 손상 경고 없이 열린다.
- 지원하지 않는 필드는 임의 자동 입력 없이 수동 편집으로 남는다.
- 기존 빠른 작성은 capability fallback일 뿐 기본 제품 흐름이 아니다.
- 일반 본문 문단 개선은 field agent와 구분된 보조 기능이다.

## 16. 착수 순서

구현은 다음 세 단위로 시작한다.

1. **방향 가드 테스트**: integrated layout과 field target 계약을 실패하는 테스트로 고정
2. **atomic text vertical slice**: 실제 HWP/HWPX 한 필드의 focus → suggest → apply → save → undo
3. **양방향 field loop**: 문서 selection과 rail active field 동기화, 다음 미완료 필드 진행

이 세 단위를 통과하기 전에는 일반 문단 agent 확장, batch 제안, 복합 표 자동 생성, 시각 polishing을
진행하지 않는다.

## 17. 계획 변경 규칙

다음은 구현 중 자유롭게 조정할 수 있다.

- 내부 파일명과 함수명
- 테스트 fake와 fixture 구성
- 72:28 레이아웃의 세부 픽셀값
- field-specific table의 물리 column 배치
- phase 안에서 충돌 없는 작업 순서

다음은 사용자 확인과 이 문서 개정 없이는 바꾸지 않는다.

- 완전한 Studio가 제품의 기본 작성 표면이라는 결정
- Studio와 field-aware rail을 동시에 보여주는 결정
- `ConnectedDocumentField.fieldId + exact binding`이 AI target이라는 결정
- 사용자 선택 뒤 열린 문서에 즉시 자동 입력하는 결정
- document revision과 field workflow를 함께 확정하는 결정
- 기존 빠른 작성과 일반 문단 agent를 fallback/보조 기능으로 두는 결정

기술 제약이 생기면 quick-first 또는 paragraph-first로 조용히 되돌아가지 않는다. 해당 phase를
`blocked`로 기록하고, 제약 증거와 가능한 adapter/범위 축소안을 이 문서에 먼저 추가한다.

## 18. 구현 진행 기록

### 2026-08-19 — Phase 0 완료, Phase 1 기반 착수

완료:

- persistent ladder (a) workspace에서 Studio와 `FieldAgentRail`을 동시에 렌더링한다.
- 기본 `빠른 작성 | 문서 직접 편집` 주 모드 토글을 통합 경로에서 제거했다.
- 일반 본문 문단 agent CTA를 통합 필드 경로에서 숨겼다.
- `CUNOTE_FIELD_EDITOR_AGENT_ENABLED`를 기존 문단 agent flag와 분리했다.
- current working document bytes에서 `fieldId`별 exact binding을 `unique | missing | ambiguous`로 해석해 rail에 표시한다.
- `fieldAwareDocumentSession`이 rollout, field kind, exact binding, suggestion 상태를 한 읽기 모델로 조립한다.
- `rhwp-studio`와 `@rhwp/editor`에 mutation 없는 `focusFieldTarget(table_cell_text)` native command를 추가했다.
- rail에서 field를 선택하면 해당 exact 표 셀 target으로 Studio 커서와 뷰포트를 이동한다.

검증:

- Cunote `test:apply-workspace`, `test:document-agent`, web typecheck 통과.
- rhwp Studio 변경 대상 controller/router/SDK 테스트 41개 통과.
- rhwp Studio `build:no-hwpctrl` 통과.
- rhwp Studio 전체 테스트의 나머지 4개 실패는 현재 Node 26이 테스트 드라이버의
  `--experimental-transform-types` 옵션을 거부한 환경 실패이며, 변경 대상 테스트 실패는 없다.

아직 완료하지 않은 Phase 1 핵심:

- field-bound run/suggestion 전용 저장 모델과 API
- `applyFieldCommand`/revert receipt, 열린 Studio 즉시 반영
- document revision과 field workflow의 원자 저장 및 CAS
- 새로고침/다운로드/Undo 실제 HWP·HWPX 브라우저 검증

따라서 이 상태는 **통합 UI + exact binding + native focus 기반 PR**이며, atomic text MVP 완료로 선언하지 않는다.

### 2026-08-20 — Phase 1 HWPX vertical slice 구현 및 실사용 검증

완료:

- field-bound run/suggestion 전용 테이블, creator-private RLS, API와 migration을 추가하고 운영 DB에 적용했다.
- 서버가 immutable base revision을 다시 열어 `fieldId + exact table_cell_text target + before/format/context`를
  재구축하며, client target이 다르면 모델 호출 전에 거절한다.
- Studio native `applyFieldCommand`/`revertFieldCommand`와 공개 SDK/RPC capability를 연결했다.
- 8자 IME atomic replace 제한과 필드 값 길이를 분리했다. 긴 필드 값은 같은 snapshot transaction 안에서
  deferred delete + insert 후 pagination을 한 번만 flush하고 exact postimage를 검증한다.
- apply/Undo snapshot 저장이 revision insert, head CAS, suggestion 상태, `fieldAnswers` projection을 같은 DB
  transaction에서 확정한다.
- 모델 요청에 45초 timeout과 retry 0회 경계를 추가하고, Next/Turbopack 서버에서 `@rhwp/core` WASM을
  실제 runtime cwd 기준으로 찾도록 수정했다.

실사용 증거:

- URL: `http://127.0.0.1:4010/grants/c5327ffd-d4a4-459a-b8c7-482b8f46d613/workspace`
- 8쪽 HWPX에서 Studio와 AI 필드 레일이 동시에 표시됐고 26개 중 7개 exact 위치를 확인했다.
- `아이템명`에 사용자가 제공한 원문을 넣어 실제 Anthropic 제안을 생성했다.
- `AI 기반 사업계획서 작성 서비스`를 열린 Studio의 exact 셀에 반영하고 UI의 `문서 반영됨`을 확인했다.
- apply revision `1287d564-792e-4e21-92b5-b6f2ce0bec24`가 suggestion/run, after SHA,
  materialized field value와 함께 저장됐다.
- 같은 세션에서 Undo 후 descendant revision `5e1e7440-0ed1-4d2a-999e-49cb995f1b82`가 생겼고,
  suggestion은 `undone/idle`, `아이템명` answer와 materialized value는 원래 빈 상태로 복원됐다.
- 실패 실험 두 건도 partial revision 없이 `stale/core_validation_failed`로 닫혀 fail-closed 동작을 확인했다.

자동 검증:

- Cunote document-agent tests, web typecheck, route policy 146개, RLS policy, production build 통과.
- rhwp Studio 변경 대상 controller/embed/public SDK tests 42개 통과.
- 16자 실제 제안값을 포함한 native field apply/revert 회귀 테스트 13개 통과.
- rhwp Studio `build:no-hwpctrl` 통과.
- 전체 rhwp test의 기존 4개 실패는 Node 26의 제거된 `--experimental-transform-types` 옵션을 쓰는
  자식 드라이버 환경 문제이며 변경 대상 테스트와 무관하다.

남은 수용 범위:

- 실제 HWP 문서의 동일 browser vertical slice
- Studio selection → rail의 양방향 `fieldId` 동기화
- 두 탭 CAS 충돌 UAT
- 대안 최대 2개, choice/form/longform 등 Phase 2~3 확장

따라서 **HWPX atomic text vertical slice는 실사용 검증 완료**지만, 위 HWP·재개방·양방향 selection
수용 기준이 남아 있어 전체 Phase 1/MVP 완료로는 아직 선언하지 않는다.

### 2026-08-20 — 재접속·다운로드·반응형 실사용 검증 보강

추가 완료:

- 최근 field run을 workspace 재접속 시 다시 불러와 `문서 반영됨`/Undo 상태가 사라지지 않게 했다.
- Studio 세션의 로컬 command journal이 새로 만들어진 뒤에도 서버가 봉인한 applied document SHA,
  applied text, exact binding을 모두 확인한 경우에만 inverse field command로 Undo할 수 있게 했다.
- 재접속 뒤 Undo 성공과 잘못된 applied SHA의 fail-closed를 transaction 단위 테스트로 고정했다.
- 1280px 미만에서 Studio는 유지하고 AI 필드 도우미를 Sheet로 여는 반응형 경로를 추가했다.
- persistent workspace에도 현재 in-memory 편집본을 export/reopen 검증한 뒤 내려받는
  `편집본 다운로드`를 제공한다.
- 공용 `ScrollArea` root의 누락된 overflow 경계를 복구해 필드 목록과 제안 카드가 겹치던 실제
  데스크톱 패널 결함을 수정했다.

실사용 증거:

- 두 번째 실제 run에서 apply revision `74cdae7f-c516-4fc3-b6ff-1db91265a0f1`을 만든 뒤 페이지를
  새로고침했으며, 같은 current value와 `문서 반영됨`, Undo CTA가 복원됐다.
- 새 Studio 세션에서 Undo revision `e563bd95-019e-4b12-ad2b-e26db7c46e32`을 저장했고 suggestion은
  `undone/idle`, 상태 버전 2, operation 버전 4로 종결됐다.
- 390×844와 1024×768에서 하단 현재 필드 bar와 `AI 도우미` Sheet를 실제로 열어 Studio와 같은
  field session을 사용하는 것을 확인했다.
- 최종 실제 run `fdca9032-8572-4140-b9d8-84f6c3771b09`에서 suggestion
  `3abfa61a-7418-4e0d-b43c-72ad5877090b`을 생성하고, `AI 기반 사업계획서 작성 서비스`를 열린
  HWPX의 아이템명 exact 셀에 적용했다.
- 적용 revision `872cc177-898b-4e7e-bd6e-2672a430b739` 상태에서 내려받은
  `/Users/ffgg/Downloads/창업노트-작업본-작업본 (3).hwpx`는 ZIP 검증을 통과했고 내부 XML에도
  같은 값이 한 번 존재했다.
- 해당 파일을 한컴오피스 한글 Viewer에서 직접 열어 손상 경고 없이 `1/8쪽`을 렌더링했고,
  첫 페이지 아이템명 셀에 적용값이 보이는 것을 확인했다.
- 테스트 종료 후 Undo revision `f989640b-78a7-44ce-acde-d0418cf97ccc`이 현재 head가 됐으며,
  해당 field의 `fieldAnswers`, `filledFields`, `materializedAnswers`가 모두 원래 빈 상태로 복원됐다.

현재 남은 수용 범위:

1. 실제 `.hwp` corpus에서 같은 focus → suggest → apply → download/reopen → Undo 시나리오
2. Studio 셀 선택 → rail active field의 양방향 selection event/bridge
3. 두 탭이 같은 head에서 apply할 때 loser가 409 뒤 최신 revision을 다시 여는 브라우저 UAT
4. 대안 최대 2개 선택 UX와 choice/form/field-bound longform command 확장

따라서 **HWPX atomic text의 재접속·다운로드·한컴 재개방까지 수용 검증을 마쳤다.** 실제 HWP와
양방향 selection이 남아 있으므로 전체 MVP 완료 선언은 계속 보류한다.

### 2026-08-20 — 실제 HWP·양방향 selection·복수 대안 실사용 검증

추가 완료:

- Studio가 `field-selection-events-v1` capability와 strict `getFieldSelectionContext`/
  `fieldSelectionChanged`를 제공한다. exact 셀 좌표가 바뀌거나 셀을 벗어날 때만 이벤트를 발행하고,
  SDK는 capability별 event routing과 listener cleanup을 수행한다.
- Studio 셀 target과 서버가 확정한 field target을 좌표 key로 연결해 Studio에서 셀을 선택하면 field rail의
  활성 fieldId가 바뀐다. rail 선택이 다시 Studio focus를 호출하지 않아 왕복 이벤트 loop도 만들지 않는다.
- 실제 HWP field command에서 raw document handle export와 SDK persisted export의 SHA가 달라지던 결함을
  수정했다. selection-only fence는 raw SHA로 안정적으로 유지하고, terminal receipt는 저장 시점 caret hook을
  거친 실제 SDK export bytes에 결속한다.
- 한 필드의 생성 요청은 검증된 대안을 최대 2개까지 저장한다. 사용자가 하나를 apply하기 시작하면 같은
  run의 다른 pending 대안은 `stale`로 종결한다. 복수 대안은 선택 전 단일 `fieldAnswers` 슬롯에 미리
  투영하지 않으므로 두 번째 대안도 정당하게 선택할 수 있다.
- 필드 rail에 검색, 전체/미완료/확인 필요 필터, Arrow/Home/End 키보드 이동, 다음 미완료 exact field
  이동을 추가했다. 적용 뒤에는 다음 미완료 과제로 자동 이동한다.

실사용·브라우저 증거:

- URL: `http://127.0.0.1:4010/grants/c5327ffd-d4a4-459a-b8c7-482b8f46d613/workspace`
- HWPX 8쪽 문서에서 `E-mail` 셀에서 실제 `핸드폰번호` 셀을 클릭하자 rail heading과 현재 과제가
  `핸드폰번호`로 바뀌었다. rail → Studio와 Studio → rail이 같은 exact fieldId를 가리켰다.
- 같은 pending suggestion을 연 두 탭 중 첫 탭만 apply됐고, 두 번째 탭은
  `필드 제안 상태가 다른 탭에서 변경되었습니다.` 409로 차단됐다. 이후 첫 탭 Undo로 문서를 복원했다.
- 실제 `public/samples/biz_plan.hwp`를 headless browser Studio에서 열고 exact table cell focus → apply →
  HWP export/reopen → revert → 복원본 export/reopen을 수행했다. 두 재개방 모두 HWP format과 page count,
  셀 값, target 서식/비대상 표 문맥을 보존했고 경고 modal은 0회였다.
- 실제 Anthropic 요청은 같은 사용자 근거에서 서로 다른 대안 2개를 반환했다. 두 번째 대안을 선택하자
  첫 번째 대안은 stale 처리되고 열린 문서에 선택값이 반영된 뒤 다음 미완료 필드로 이동했다.
- 최종 run `e942995e-9cfa-4e42-9552-8ca75565c35b`에서 ordinal 0 suggestion
  `b4405e59-6acd-4c2a-8fd0-d158405550eb`은 `stale`, 선택한 ordinal 1 suggestion
  `b6487869-49bf-41ff-885b-5e2aad69670b`은 apply revision
  `3d593072-b983-4319-8b1b-96101a1a64fb` 뒤 Undo revision
  `05ecf803-f0d5-4623-8b2b-165c1af74cf7`로 `undone` 종결됐다.
- 테스트 종료 뒤 현재 head origin은 `studio_agent_undo`, `materializedAnswers={}`, 아이템명
  `fieldAnswers`/`filledFields`는 모두 비어 있어 문서와 projection을 원상 복원했다.

자동 검증:

- rhwp Studio field HWP E2E 24개 assertion과 기존 HWP/HWPX body command E2E 30개 assertion 통과.
- rhwp Studio 변경 대상 controller/embed/SDK 테스트 60개와 `build:no-hwpctrl` 통과.
- Cunote `test:document-agent`, `test:apply-workspace`, web typecheck 통과.
- rhwp 전체 977개 중 970 pass, 3 skip, 기존 4개 파일은 Node 26이 제거된
  `--experimental-transform-types` 옵션을 자식 드라이버에서 거부해 환경 실패했다.

현재 남은 확장 범위:

1. checkbox/radio/select의 option-bound native command와 HWP/HWPX corpus
2. HWP form text control 전용 resolver/validator/command/revert
3. field-bound longform과 반복 표 existing-row cell 확장

따라서 **atomic `table_cell_text` MVP와 양방향 field loop, 복수 대안 선택은 실제 HWP/HWPX 경로에서
검증 완료**다. choice/form/longform은 같은 exact command 원칙을 만족할 때만 순차 활성화한다.

### 2026-08-20 — 선택형과 본문 누름틀 확장·프로덕션 검증

추가 완료:

- checkbox/radio/select 계열은 원본 문서에서 추출한 선택지와 exact 일치하는 값만 제안하고, 해당 셀의
  전체 preimage를 native field command로 교체한다. 임의 선택지나 원본에 없는 값은 적용하지 않는다.
- 본문 `clickhere` 누름틀은 `fieldId + section + paragraph`를 exact target으로 사용한다. 표 셀 resolver를
  우선 보존하고, 표 셀이 없을 때만 누름틀 이름과 connected field의 `fieldKey|label`을 NFKC exact 비교한다.
- 중첩 누름틀, 셀 내부 누름틀, 동명 누름틀, 편집 불가 필드는 fail-closed한다.
- Studio controller, embed RPC, npm SDK, Cunote 서버 권위 resolver와 browser transaction이 같은
  `form_text` target·format/context 증거·apply/revert receipt를 사용한다.
- 기존 표 셀과 누름틀의 차이는 공용 field binding/transaction 모듈 안에 두고, workspace와 rail은 같은
  target union만 사용한다.

검증·배포 증거:

- choice field는 프로덕션 HWPX의 `창업자 유형`에 `예비창업자`를 적용하고 새 revision 저장 뒤 Undo로
  원문과 `fieldAnswers`/`filledFields`/`materializedAnswers`를 복원했다.
- 실제 `field-01.hwp`의 `회사명` 누름틀에서 focus → `주식회사 노튼` apply → HWP export/reopen →
  다른 exact 값 probe → revert → 복원본 reopen을 수행했다. 값, format/context SHA, page count,
  changeSeq, public selection/document event가 모두 일치했다.
- Studio 프로덕션 배포 `dpl_5taWEH5EYRKcfemFdbgVTUe7QsnC`와 Cunote 프로덕션 배포
  `dpl_4icr2yCiGrktg2ccQKJ5d1fyTJbu`가 Ready이며 각각
  `https://changupnote-rhwp-studio.vercel.app`, `https://changupnote.com`에 연결됐다.
- `https://changupnote.com/grants/c5327ffd-d4a4-459a-b8c7-482b8f46d613/workspace`의 새 브라우저
  세션에서 8쪽 Studio와 AI field rail이 동시에 열리고, `아이템명` rail 선택이 현재 과제와 exact Studio
  위치를 함께 바꾸는 것을 확인했다.
- 프로덕션 DB/R2의 현재 revision 3건을 읽기 전용 조사했으나 지원 가능한 본문 누름틀 문서는 0건이었다.
  따라서 Cunote form-text 통합의 실제 서비스 데이터 apply는 신규 누름틀 양식 유입 전까지 검증할 수 없다.

자동 검증:

- RHWP local field E2E: table cell 24개, form text 16개 assertion 통과.
- RHWP production public SDK form-text smoke: 9개 assertion 통과.
- Cunote `test:document-agent`, `test:apply-workspace`, web typecheck와 production build 통과.
- RHWP 전체 982개 중 975 pass, 3 skip. 기존 4개 파일은 Node 26에서 제거된
  `--experimental-transform-types` 옵션 때문에 환경 실패하며 이번 변경 대상 테스트는 모두 통과했다.

현재 남은 확장 범위:

1. field-bound longform의 stable region resolver/validator/command/revert와 실제 HWP/HWPX corpus
2. 반복 표의 existing-row 다중 항목 binding 정책과 corpus. 기존 unique 셀은 이미 atomic path를 재사용한다.
3. 반복 행 생성/삭제, 병합 구조 변경, 서명/도장은 별도 구조 편집 계획 전까지 수동 편집 유지
4. `@rhwp/editor@0.8.5` npm 게시. 패키지 dry-run은 통과했지만 현재 머신의 npm publish 인증이 없다.

따라서 **완전 편집 가능한 Studio 옆에서 LLM이 exact 필드를 인지하고 제안·선택·자동 입력하는 핵심 흐름은
atomic text, 선택형, 본문 누름틀까지 구현·배포됐다.** 다음 구현은 안정적인 장문 범위 메타데이터와 반복 표
binding corpus가 확보된 뒤 같은 exact command 원칙으로 확장한다.
