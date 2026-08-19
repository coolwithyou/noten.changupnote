# 문서 직접 편집 AI 에이전트 실행 계획

> **제품 방향 정정(2026-08-19):** 이 문서는 안전한 일반 본문 문단 개선 agent의 구현·운영 기록으로
> 보존한다. `/grants/[grantId]/workspace`의 현재 제품 정본은
> [`2026-08-19-field-aware-document-editor-agent.md`](./2026-08-19-field-aware-document-editor-agent.md)다.
> 새 구현은 Studio 옆의 field-aware rail과 exact field 자동 입력을 우선하며, 이 문서의
> quick-field 비종속/page-body candidate 결정은 주 흐름에 적용하지 않는다.

- 작성일: 2026-08-18
- 기준 브랜치: `codex/document-editor-ai-agent`
- 기준 커밋: `ed87aaee604cf75817addedbc4d175f1ce0ad958`
- 상태: feature flag 기본 off 상태의 구현·자동 검증·실문서 browser gate 완료
- 후속 실행 상태(2026-08-19): native command bridge, revision/agent persistence, 서버 제안 API,
  제안 Sheet와 적용/Undo 경로를 구현했다. 실제 HWP/HWPX에서 native apply/revert, 직접 입력,
  저장, 다운로드를 검증했다.
- 외부 의존성 처리: upstream PR merge와 npm publish가 maintainer 권한 대기라 exact source commit
  `104ed4da`의 `@rhwp/editor@0.8.5` tarball을 SHA-256과 함께 임시 vendoring한다. npm 게시 후에는
  exact registry `0.8.5`로 교체한다.
- 운영 DB migration은 적용·검증을 마쳤다. Cunote 배포와 feature flag enable은 승인된 후속 범위다.

## 1. 결론

v1은 **사용자가 쪽과 편집 후보를 고른 뒤에만 제안을 생성하고, 제안 하나를 명시적으로 승인한 뒤에만 현재 Studio 문서를 변경하는 구조**로 구현한다.

현재 설치된 `@rhwp/editor@0.7.19`의 공개 `RhwpEditor`에는 현재 selection/caret 조회, 부분 편집 command, transaction, native undo API가 없다. 존재하지 않는 SDK 기능이나 private `_request`를 가정하지 않는다. v1은 다음 앱 소유 어댑터를 사용한다.

```text
Studio의 현재 바이트 검증 export
  -> @rhwp/core로 안전한 단일 텍스트 컨테이너 추출
  -> 사용자가 후보 선택
  -> 현재 바이트를 revision checkpoint로 저장
  -> 서버가 공고·기업정보·serving 가능 딥분석으로 제안 생성
  -> 사용자가 제안 하나 승인
  -> 전체 문서 SHA + 구조 anchor + before/style/context exact 검증
  -> @rhwp/core snapshot/batch에서 단일 대상 치환
  -> 검증 export 및 semantic invariant 검사
  -> editor.loadFile()로 재적재
  -> 새 불변 revision으로 즉시 저장
```

Undo는 head를 과거로 이동하거나 전체 문서를 덮어쓰지 않는다. 가장 최근 AI 적용 건에 한해 현재 target이 exact `after` 상태인지 확인하고 `before`로 역패치한 뒤, 새 descendant revision을 저장한다.

이 방식은 빠른 작성의 `connectedFields`나 `fieldId`에 의존하지 않는다. 단, 재적재 무손실성과 Undo 보존성을 구현 Phase 0에서 먼저 증명해야 한다. GO 기준 하나라도 실패하면 API·DB·UI 구현을 중단하고 RHWP Studio native command bridge를 선행 과제로 전환한다.

## 2. 제품 계약

### 2.1 지켜야 할 불변식

1. 패널을 열거나 쪽을 바꾸거나 문서를 편집하는 것만으로 모델을 호출하지 않는다.
2. `현재 문서를 저장하고 제안 받기` 클릭 전에는 모델 호출이 0회다.
3. 후보 찾기, 제안 검토, 건너뛰기는 write 0회다. 모델 생성은 사용자가 `현재 문서를 저장하고 제안 받기`를 누른 경우에만 시작하며, 이 명시 동작은 현재와 byte-identical한 checkpoint revision으로 draft head를 전진시킨다. 모델이 실패하거나 유효 제안이 없어도 checkpoint는 저장 이력으로 남는다.
4. 각 카드에 대상 쪽·위치 설명, 사용 근거, 변경 전·후 diff를 모두 표시한다.
5. 사용자가 해당 카드의 `이 제안 반영`을 누르기 전에는 document transaction에 진입하지 않는다.
6. 클라이언트와 모델이 보낸 좌표·anchor·before text는 모두 신뢰하지 않는다. 서버가 checkpoint revision의 R2 바이트를 직접 열어 같은 검증기를 실행하고 다시 만든 후보만 사용한다.
7. fuzzy search, 동일 문자열의 첫 항목 선택, 가장 가까운 위치 추정은 금지한다.
8. 승인 직전 live Studio 바이트와 target preimage가 생성 시점과 정확히 같지 않으면 아무것도 바꾸지 않고 `stale` 처리한다.
9. 적용과 Undo는 각각 검증된 새 revision을 만든다. revision head를 뒤로 옮기지 않는다.
10. 기존 수동 저장, autosave, 빠른 작성 전환, 다운로드는 현재 전체-document export 경로를 계속 사용한다.
11. AI 경로는 기존 quick-field materialization 의미와 진행률을 바꾸지 않는다.
12. virtual company와 관리자 simulation/local preview에서는 버튼, 모델 호출, proposal DB write를 모두 비활성화한다.

### 2.2 v1에 포함하는 범위

- HWP와 HWPX persistent workspace의 문서 직접 편집 모드
- 사용자가 명시적으로 고른 1개 쪽과 1개 안전 후보에 대한 온디맨드 제안
- 한 요청당 최대 2개 문안 대안
- 제안별 승인 또는 건너뛰기
- exact stale 검증 후 한 제안 적용
- 적용 즉시 검증 저장
- 가장 최근 AI 적용 건의 exact 역패치 Undo
- 현재 문서, 공고, 기업정보, serving 가능 딥분석 근거 표시
- creator-private 제안 이력과 적용/Undo revision 결속
- 서버 기본값 off인 feature flag를 통한 제한적 롤아웃

### 2.3 v1에서 제외하는 범위

- Studio의 현재 selection/caret/viewport 자동 연동
- 모델의 자동 위치 선택, background/keystroke 호출, 문서 전체 자동 제안
- 일괄 승인과 `모두 반영`
- 한 요청에서 여러 target 연속 적용
- 다중 문단 치환, 문단 분리·합치기
- 표 셀 전체, 텍스트박스·도형, 머리말·꼬리말, 각주·미주
- 혼합 글자 서식 문단
- 서명·직인·날인·동의·서약·첨부·주민등록/여권/면허 계열
- AI가 빠른 작성 답변 또는 `fieldAnswers`를 갱신하는 동작
- 여러 탭 간 자동 merge/rebase, 저장 충돌 강제 해결
- private RHWP MessageChannel 호출 또는 SDK type cast 우회

## 3. 현재 구조 조사 결과

### 3.1 문서 편집과 빠른 작성

- `WorkspaceView.tsx`는 `connectedFields`로 빠른 작성 과제와 진행률을 만들지만, Studio 자체는 연결 필드가 없어도 전체 문서를 열 수 있다.
- Studio는 빠른 작성 화면과 전환되어도 mount를 유지한다. `saveAndReturn()`이 기존 전환 전 저장 경계다.
- `prepareRhwpWorkingDocument()`는 current head 또는 source 바이트를 열고 확정된 quick answer delta를 보수적으로 합친다. 기존 텍스트가 예상 preimage와 다르면 덮어쓰지 않는다.
- AI 후보 추출과 transaction은 `documentAuthoring.ts`, `FieldPanel.tsx`, `fieldAnchors.ts`의 고정 필드 계약 밖에 둔다.

### 3.2 RHWP 공개 API

- `@rhwp/editor@0.7.19` 공개 API는 load, page/render, 전체 HWP/HWPX export, destroy에 한정된다.
- `studioSaveProtocol.ts`는 미래 `getDirtyState`, `exportSnapshot`, change subscription을 feature-detect하지만 현 버전은 legacy/manual 경로다.
- `@rhwp/core@0.7.19`에는 `getParagraphCount`, `getTextRange`, char/paragraph format 조회, `replaceText`, `saveSnapshot`/`restoreSnapshot`, `beginBatch`/`endBatch`, HWP/HWPX export/reopen 검증 API가 있다. cell 편집 API도 있으나 cell 내부 control을 빠짐없이 열거하는 공개 API가 없어 v1 target으로 사용하지 않는다.
- 따라서 core patch/reload는 공개 API만으로 만들 수 있지만, Studio native undo/selection과 cursor 보존은 제공할 수 없다.

### 3.3 저장 프로토콜

- `RhwpStudioSurface.save()`는 Studio 전체 바이트를 export하고 core로 다시 열어 페이지 수를 검증한다.
- persistent save는 R2 object와 immutable `grant_document_revisions` row를 만든 뒤 `grant_document_revision_heads`를 compare-and-swap한다.
- 멱등 키는 `(draft, studioSession, documentEpoch, changeSeq, sha256)`이고, stale `baseRevisionId`는 409다.
- current snapshot origin은 `studio_autosave | studio_manual`이다. AI checkpoint/apply/undo를 구별하도록 타입과 route validation을 확장하고, checkpoint request와 apply/undo command 결속을 위한 first-class nullable columns를 revision table에 추가한다.
- 다운로드는 현재 탭 working bytes 또는 head revision을 우선한다. AI 적용도 동일 ref를 갱신한 뒤 기존 다운로드 경로를 통과시킨다.

### 3.4 근거 데이터

- 현재 field suggestion은 공고 grounding과 company profile, 모델 전 예산 검사, structured output, evidence quote 실재 검증, usage 합산을 제공한다.
- `loadServiceApplySheet()`는 현재 기업과 공고로 `satisfied`/`needsCheck` rule trace를 만들지만 release/run provenance를 노출하지 않으므로, 그것만으로 deep source를 판정하지 않는다.
- 딥분석은 raw/local lab/latest run을 직접 사용하지 않는다. 별도 exact serving loader가 active 또는 canary-passed release의 applied item, current promotion snapshot hash, `resolvePromotionServingEvidence()`를 모두 검증한 결과만 사용한다.
- held, failed, unpromoted result와 `spike-out` artifact 경로는 prompt와 evidence registry에서 제외한다.

### 3.5 확인된 테스트 공백

- current SDK에서 export -> core patch -> editor reload -> re-export의 실문서 무손실 증거가 없다.
- stale target, 승인 전 mutation 0회, per-card apply, Undo, 여러 탭 CAS에 대한 agent 전용 테스트가 없다.
- document revision service 자체의 apply/undo origin과 proposal receipt 결속 테스트가 없다.
- `studioTransport.test.ts`는 존재하지만 현재 aggregate script에 포함되지 않는다.

## 4. 접근법 비교와 결정

| 접근법 | 장점 | 위험/한계 | 결정 |
| --- | --- | --- | --- |
| RHWP Studio native command bridge | 현재 selection, viewport 유지, native transaction/undo | 현 SDK와 이 저장소에 API가 없다. 별도 Studio 배포가 선행돼야 한다. | 장기 목표 및 Phase 0 STOP 시 필수 대안 |
| Studio export -> core patch -> verified export -> `loadFile` | 현 저장소와 공개 API만 사용, exact preimage, quick field 비종속 | cursor/scroll 초기화 가능, 무손실을 먼저 증명해야 함 | **GO gate를 둔 v1** |
| 서버가 revision 바이트를 직접 변조 | 서버 감사가 단순해 보임 | 현재 미저장 편집과 분기되고 화면 밖 무단 변경이 생김 | 기각 |
| 복사 전용 제안 | 안전하고 SDK 의존 없음 | 승인 후 실제 위치 반영 목표 미충족 | Phase 0 STOP 시 임시 fallback만 가능 |

Deep-module 경계는 `DocumentAgentTransaction`으로 둔다. UI와 서버는 RHWP 메서드를 직접 호출하지 않고, 향후 native bridge가 생기면 이 어댑터 구현만 교체한다.

```ts
interface DocumentAgentTransaction {
  extractCandidates(bytes: Uint8Array, format: "hwp" | "hwpx", page: number): Promise<DocumentEditCandidate[]>;
  apply(input: ExactEditCommand): Promise<VerifiedEditResult>;
  undo(input: ExactUndoCommand): Promise<VerifiedEditResult>;
}
```

## 5. 결정된 사용자 흐름

### 5.1 후보 선택과 생성

1. persistent Studio가 ready이고 feature flag가 켜진 경우에만 `AI 작성 제안` 버튼을 표시한다.
2. 버튼은 shadcn `Sheet`를 연다. 열기 자체는 export나 모델 호출을 하지 않는다.
3. 현재 SDK에서 현재 쪽을 알 수 없으므로 `1..pageCount` 쪽 선택기를 명시적으로 제공한다. 기본값은 1쪽이며, 같은 세션에서 마지막 선택 쪽만 client state로 기억한다.
4. 사용자가 `이 쪽의 작성 위치 찾기`를 누르면 live Studio를 검증 export하고 core가 해당 쪽의 안전한 비어 있지 않은 본문 문단 후보를 최대 24개 로컬 추출한다. 이 단계는 모델 호출과 DB write가 없다.
5. 각 후보는 쪽, 인접 문단 라벨과 미리보기를 표시한다. 사용자가 후보 하나를 고른다. quick/manual/core field와 겹치는 reserved anchor는 목록에 나오지 않는다.
6. 사용자가 `현재 문서를 저장하고 제안 받기`를 누르는 순간 클라이언트가 UUID `checkpointRequestId`와 모델 run용 UUID `clientRequestId`를 한 쌍으로 한 번 생성해 reducer에 보존한다. shared mutex는 진행 중 저장을 기다리고, ACK가 확정되지 않은 직전 manual/autosave request가 있으면 그 legacy idempotency key로 먼저 재조회해 current head를 확정한다. 그 다음에만 현재 Studio 바이트를 `studio_agent_checkpoint` origin과 exact parent로 저장한다. checkpoint/POST 네트워크 재시도도 각각 같은 ID를 사용한다. 버튼 아래에 “제안이 실패해도 현재 문서 저장 이력은 남습니다”를 표시한다.
7. checkpoint는 기존 manual/autosave와 바이트·changeSeq가 같아도 재사용하지 않고 current head의 새 same-content child revision을 만든다. ACK 유실 재호출만 동일 `checkpointRequestId`로 그 revision을 되찾는다.
8. checkpoint 저장 결과의 `revisionId`와 서버 계산 `sha256`가 제안 run의 exact base다. 저장 409면 모델을 호출하지 않고 최신본 재로드 또는 현재 탭 다운로드 선택지를 보여준다.
9. 후보의 source SHA가 checkpoint SHA와 다르면 모델을 호출하지 않고 후보를 다시 추출한다.
10. POST를 받은 서버는 checkpoint revision의 R2 바이트를 exact ID로 읽고 SHA/format을 검증한 다음, 서버에서 현재 connected fields를 다시 읽어 reserved anchor를 만들고 `validateBodyParagraphCandidate()`로 선택 후보를 재구축한다. 클라이언트 후보는 candidate ID와 사용자가 고른 page/anchor 힌트일 뿐이다. 서버 재구축 결과와 ID가 다르면 모델 호출 0회로 거절한다.
11. 서버는 서버 재구축 후보 하나에 대해 최대 2개 대안을 생성한다.

### 5.2 검토와 승인

각 제안 `Card`에는 다음을 전부 표시한다.

- `N쪽 · <인접 문단 라벨> · 본문 문단`
- 변경 목적 한 문장
- before/after 단어 단위 diff. 단, 보조기술에는 삭제/추가 전문을 각각 읽을 수 있게 제공한다.
- 근거 `Badge`와 검증된 짧은 quote
- `이 제안 반영`, `건너뛰기`

`이 제안 반영` 클릭은 먼저 local shared mutex와 iframe overlay를 획득한 뒤 해당 suggestion만 `pending -> approved`로 CAS 전환한다. approve가 거절되면 즉시 잠금을 해제한다. 다른 대안은 아직 문서를 바꾸지 않는다.

### 5.3 적용

1. 승인 API가 run base revision이 여전히 current head인지 검사한 뒤 `pending -> approved`로 CAS한다. 아니면 suggestion을 `stale`로 만들고 409를 반환한다.
2. 클라이언트가 live Studio를 다시 검증 export한다.
3. 전체 SHA, source format/key, current connected-field authority anchors hash, anchor, before hash, format fingerprint, adjacent-context hash를 checkpoint와 exact 비교하고 현재 client manual anchor가 target과 충돌하지 않는지 검사한다.
4. 하나라도 다르면 document mutation 없이 `approved -> stale`로 기록한다.
5. exact하면 `start_apply`가 `operationState=apply_saving`과 새 `operationVersion`을 CAS한다. 클릭 시 이미 획득한 iframe/저장/빠른 작성 잠금을 유지한 채 core snapshot과 batch 안에서 대상 하나만 치환한다.
6. 대상 after와 비대상 semantic manifest를 검증하고 HWP/HWPX를 export/reopen한다.
7. 성공한 바이트만 `editor.loadFile()`로 재적재하고 local working refs, page count, synthetic epoch/changeSeq를 갱신한다.
8. 같은 transaction mutex 안에서 `studio_agent_apply` origin과 `{suggestionId, operation:"apply", operationVersion}`을 snapshot service에 전달한다. 클라이언트가 `runId`, command ID, origin을 권위값으로 보내지 않는다.
9. snapshot service가 승인 상태·base head를 다시 검증하고, revision/head 생성과 `approved -> applied`, `operationState -> idle`, `appliedRevisionId`, 서버 계산 before/after document SHA 기록을 한 DB transaction에서 완료한다.
10. 응답이 유실되면 unique command로 만들어진 current head를 서버가 재조회해 같은 저장 결과를 반환한다. 별도 `applied` receipt PATCH와 문서 재적용은 없다.
11. 한 대안이 적용되면 같은 run의 나머지 pending 대안은 전체 문서 binding이 바뀌었으므로 `stale` 처리한다.

적용 후 Studio reload가 됐음을 안내하고 대상 쪽 번호를 다시 표시한다. v1은 기존 cursor/scroll 복원을 약속하지 않는다.

### 5.4 실패와 저장 충돌

- `start_apply`/`authorize_undo`부터 각 저장·복구 action까지 모든 transition은 현재 `operationVersion` CAS에 성공한 경우에만 version을 1 증가시킨다. mount마다 `sessionStorage`에 생성한 `operationClientId`를 start에서 저장하고 `apply_save_failed|undo_save_failed`, retry, 로컬 바이트 기반 abandon에 같은 값을 요구한다. 로컬 바이트를 쓰지 않는 timeout recovery에는 이 ID를 요구하지 않는다.
- core 검증 실패 전: `endBatch()`를 보장한 뒤 snapshot을 restore/discard하고 editor는 건드리지 않는다. `abandon_apply`가 `approved -> stale`, operation idle, 새 operationVersion과 failure code를 기록한다.
- `loadFile()` 실패: `preparedRef`를 바꾸지 않고 검증된 before 바이트 재적재를 1회 시도한다. before 재적재가 성공하면 `abandon_apply`로 `approved -> stale`, operation idle을 기록한다. 둘 다 실패하면 iframe은 계속 잠근 채 error 상태, before 바이트 다운로드, 최신 head 재로드만 제공한다.
- `loadFile()` 성공 후 저장이 성공하거나 로컬 rollback이 끝날 때까지 iframe, 기존 저장, 빠른 작성 전환을 계속 잠근다. 후속 사용자 편집을 허용하지 않는다.
- apply 저장 실패: 클라이언트가 current version으로 `apply_save_failed`를 PATCH하고, 서버가 head가 여전히 base임을 확인해 `approved/apply_save_failed`와 새 version으로 CAS한다. 실패 PATCH의 ACK가 유실되면 GET으로 상태를 재조회하며 `applied`라고 표시하지 않는다.
- apply 저장 재시도: 같은 operation client의 live SHA가 직전 검증된 after SHA이고 server head가 base checkpoint일 때 `retry_apply_save`가 `apply_save_failed -> apply_saving`과 새 version으로 전환한다. core mutation/load를 다시 실행하지 않고, 같은 `agentCommandId`와 새 operationVersion으로 이미 메모리에 보존한 after bytes만 다시 저장한다. timeout recovery 뒤에는 이 경로를 사용하지 않고 head reload 후 새 start부터 반복한다.
- apply 포기: 같은 operation client에서 live SHA가 exact after일 때 checkpoint before bytes를 재적재·검증한 뒤 `abandon_apply`가 `approved -> stale/idle`, 새 version, `apply_rolled_back`을 기록한다. exact하지 않으면 rollback하거나 잠금을 풀지 않는다.
- Undo 저장 실패: `undo_save_failed`가 head가 applied revision인지 확인해 `applied/undo_save_failed`와 새 version으로 CAS한다. 같은 operation client의 live SHA가 exact inverse-before일 때만 `retry_undo_save`로 같은 undo command와 새 version을 저장 재시도하며 core mutation은 반복하지 않는다. 캡처한 exact applied bytes를 재적재·검증한 경우에만 `abandon_undo`가 `applied/idle`, 새 version, `undo_rolled_back`으로 복원한다.
- snapshot save가 CAS 409를 반환하면 재시도나 inverse rollback을 금지한다. 사용자는 충돌 중인 현재 탭을 선택적으로 다운로드할 수 있지만, 이후 최신 server head의 바이트·revision을 **반드시** 불러와 Studio와 모든 working refs를 재적재해야 한다. 재적재 성공 뒤 apply는 `abandon_apply`로 `approved -> stale/idle`, Undo는 `abandon_undo`로 `applied/idle`, 둘 다 새 version과 `revision_conflict`를 기록한 다음에만 잠금을 해제한다. 최신 head 재적재도 실패하면 잠금을 유지한다.
- `apply_saving|undo_saving`이 5분을 넘긴 `recover_operation`은 creator의 어느 탭에서든 호출할 수 있다. 서버는 row lock에서 같은 command revision 부재와 current head를 재검증하고 이전 version을 fence한다. apply는 head가 run base이면 `approved/idle`, 아니면 `stale/idle`; Undo는 `applied/idle`로 전환하고, 모두 새 version과 `operation_recovered`를 기록하며 `operationClientId`를 null로 지운다. `save_failed`로 추측하지 않는다. 이전 탭의 늦은 retry/abandon/upload는 ID/version 불일치로 거부한다. recovery를 본 모든 탭은 server head를 재적재한 뒤 새 operationClientId로 apply/Undo를 처음부터 다시 시작해야 한다.
- 각 성공/복구 경로는 `preparedRef`, `sessionDocumentRef`, page count, epoch/changeSeq를 재적재된 바이트 기준으로 한 번만 갱신한다.
- 모델/네트워크 실패: editor 바이트와 `fieldAnswers`는 바뀌지 않고 동일-content checkpoint head는 남는다. 같은 `clientRequestId` 재조회로 중복 과금을 막는다.

### 5.5 Undo

v1 Undo는 **현재 head에 해당하는 가장 최근 `applied` AI suggestion 한 건**에만 활성화한다. 이 제한으로 오래된 제안을 역순 없이 취소해 의도하지 않은 편집을 섞는 일을 막는다.

1. Undo 클릭은 먼저 local shared mutex와 iframe overlay를 획득한다. undo authorization API가 current head가 suggestion의 `appliedRevisionId`인지 확인하고 `operationState=undo_saving`과 새 `operationVersion`을 CAS한다. 거절되면 잠금을 해제한다.
2. 클라이언트는 live Studio를 export한다. target text/format/context가 exact after 상태인지 검사한다.
3. exact after가 아니면 `abandon_undo`로 operation을 idle/applied에 되돌리고 `undo_conflict`를 표시한다. document는 바꾸지 않는다.
4. snapshot/batch 안에서 같은 anchor를 before text로 역패치하고 원래 uniform format을 복원한다.
5. 비대상 semantic manifest와 export/reopen을 검증한다.
6. `editor.loadFile()` 후 snapshot service에 `{suggestionId, operation:"undo", operationVersion}`을 전달해 `studio_agent_undo` descendant revision을 즉시 저장한다.
7. snapshot service가 head/parent/applied 상태를 재검증하고 revision/head 생성과 `applied -> undone`, `operationState -> idle`, `undoneRevisionId`를 한 DB transaction에서 기록한다.
8. 응답 유실은 unique undo command current head를 재조회한다. 별도 `undone` PATCH는 없다.

Undo 뒤에도 revision head를 과거로 옮기지 않는다. 적용 뒤 사용자가 같은 target을 수정했거나 다른 revision을 저장했으면 자동 Undo를 차단한다. 사용자는 기존 전체 문서 편집으로 직접 수정하거나 새 제안을 요청할 수 있다.

## 6. 안전 후보와 transaction 계약

### 6.1 versioned contract

공유 schema version은 `document-agent-v1`로 고정한다.

```ts
type DocumentEditAnchor = {
  kind: "body_paragraph";
  section: number;
  paragraph: number;
  charOffset: 0;
  length: number;
};

interface DocumentEditCandidate {
  schemaVersion: "document-agent-v1";
  candidateId: string;
  sourceKey: string;
  documentSha256: string;
  reservedAnchorsSha256: string;
  anchor: DocumentEditAnchor;
  location: {
    page: number;       // 1-based UI page
    label: string;
    box?: { x: number; y: number; width: number; height: number };
  };
  beforeText: string;
  beforeSha256: string;
  formatSnapshot: Record<string, unknown>;
  formatSha256: string;
  adjacentContext: string;
  adjacentContextSha256: string;
}
```

`reservedAnchorsSha256`는 client/server가 같은 checkpoint bytes와 connected fields에서 `resolveRhwpFieldAnchorsExact()`로 다시 만들 수 있는 **connected-field authority anchor projection만** canonical hash한 값이다. projection은 `fieldId`와 구조 target 좌표만 fieldId/좌표 순으로 정렬하고 client-only manual anchor, box, appearance, choices는 넣지 않는다.

`candidateId = sha256(canonicalJson({schemaVersion, sourceKey, documentSha256, reservedAnchorsSha256, anchor, beforeSha256, formatSha256, adjacentContextSha256}))`다. canonical JSON은 key 정렬, UTF-8, 숫자 정수화 규칙을 테스트로 고정한다.

### 6.2 허용 후보

- v1 target은 **비어 있지 않은 본문 한 문단 전체**뿐이다. 표 셀은 cell 내부 control/nested path 부재를 공개 API로 완전하게 증명할 수 없어 제외한다.
- 길이 1..4,000자, 인접 context는 앞/뒤 합계 최대 600자다.
- page/box는 core `getCursorRect`와 `getSelectionRects`로 계산한다.
- location label은 모델이 쓰지 않는다. `본문 {section+1}구역 {paragraph+1}문단`을 기본으로 하고, 같은 section의 직전 non-empty 본문 첫 40자를 미리보기로 별도 표시한다. 앞/뒤 adjacent context는 각각 최대 300자로 자른 뒤 구분자를 포함해 canonical hash한다.
- `getCursorRect` DTO는 strict `{pageIndex: nonnegative int, x: finite, y: finite, height: finite}`다.
- `getSelectionRects` DTO는 위 `pageIndex`와 finite `x,y,width,height`를 가진 strict object array다. 시작과 끝 rect가 모두 같은 `pageIndex`에 있고 사용자가 고른 1-based page와 일치해야 한다.
- `getControlTextPositions` DTO는 nonnegative integer array다. 빈 배열인 문단만 허용한다.
- char/paragraph/style JSON은 의미 필드를 선택하지 않고 “JSON-serializable plain object, 모든 숫자 finite”로 검증한 전체 canonical object를 fingerprint한다. 같은 key/value 전체가 승인 직전에도 일치해야 한다.
- DTO에 필수 key 누락, extra key, 비정상 숫자, parse error가 있으면 후보를 제외한다.

### 6.3 제외 판정

- 문단의 모든 character offset에서 `getCharPropertiesAt`의 canonical fingerprint가 같지 않으면 혼합 서식으로 제외한다. sampling하지 않는다.
- paragraph `getControlTextPositions()`가 비어 있지 않으면 제외한다.
- 문단의 모든 offset에 `getFieldInfoAt()`을 호출하고 하나라도 `inField=true`이면 제외한다. 결과는 strict `{inField:boolean, fieldId?, startCharIdx?, endCharIdx?, isGuide?, guideName?, editableInForm?}`로 검증하며 parse 실패도 제외한다.
- `fieldSuggest.ts`의 현재 `MANUAL_LABEL_KEYWORDS`와 `isManualLabel()`을 새 shared `manualFieldPolicy.ts`로 그대로 이동해 field suggestion, browser candidate, server candidate가 같은 predicate를 쓴다. target+앞뒤 context를 공백만 제거한 문자열에서 현재 17개 금지어를 검사하고, 원문에는 주민/외국인등록번호 `(?:^|\\D)\\d{6}-?[1-8]\\d{6}(?:\\D|$)`, 여권형 `\\b[A-Z][0-9]{8}\\b`, 운전면허형 `\\b\\d{2}-\\d{2}-\\d{6}-\\d{2}\\b`도 검사한다. 하나라도 일치하면 client/server 모두 제외한다.
- client와 server의 canonical `reservedAnchors`는 현재 connected fields만 exact resolver로 구조 target 집합에 정규화한다. 후보 paragraph가 같은 paragraph이거나 field range와 일부라도 겹치면 제외한다. core 자체 field는 위 `getFieldInfoAt()` 전수 검사로 별도 제외한다.
- `manualAnchors`는 candidate ID, POST, run binding에 넣지 않는다. client preview에서 추가 후보 필터로만 사용하고, 승인 직전 현재 manual anchor와 target 충돌을 한 번 더 검사한다. 충돌하면 mutation 없이 `stale` 처리한다.
- 연결 필드가 0개인 문서도 추출은 동작하므로 빠른 작성에 종속되지 않는다. 연결 필드가 있는데 client/server exact resolver 중 하나라도 `missing|ambiguous`면 문서 전체에서 생성을 막으며 client `manualAnchors`로 보완하지 않는다.

### 6.4 서버 권위 후보 재구축

- client POST schema는 `{checkpointRevisionId, clientRequestId, selectedPage, anchor:{section,paragraph}, candidateId}`만 받는다. before/context/format/location/reserved anchor/source key/SHA는 받더라도 버리는 것이 아니라 schema extra-key 거절 대상이다.
- `documentRevisions.ts`에 `loadDraftRevisionFile({draftId, revisionId, access})`를 추가한다. revision이 현재 head이자 `studio_agent_checkpoint`이고 creator/checkpoint request가 일치하는지 조회한 뒤 exact revision의 R2 object를 읽고, signature로 format을 다시 감지하고 DB SHA와 실제 bytes SHA를 비교한다. 기존 `loadDraftHeadRevisionFile()`의 storage/error mapping을 공유하되 latest로 치환하지 않는다.
- 새 `apps/web/src/lib/server/rhwp/documentAgentCore.ts`는 Node runtime 전용 async singleton이다. `await import("@rhwp/core")`로 native ESM을 로드하고, `createRequire(import.meta.url).resolve("@rhwp/core")`로 package `main`인 `rhwp.js`를 찾고 sibling `rhwp_bg.wasm`을 `readFileSync`한 뒤 `initSync({module: wasmBytes})`를 정확히 한 번 호출한다. 설치된 `@rhwp/core@0.7.19`의 package `files`와 d.ts가 각각 이 WASM 파일과 `BufferSource|WebAssembly.Module` sync input을 선언한다. edge runtime에서는 import조차 하지 않는다.
- `next.config.mjs`에 `serverExternalPackages: ["@rhwp/core"]`와 `outputFileTracingIncludes: {"/*": ["./node_modules/@rhwp/core/rhwp_bg.wasm"]}`를 추가한다. include 값은 Next.js 공식 규칙대로 `apps/web` project root 상대 경로이며, 기존 excludes는 유지한다. 패키지는 native Node ESM으로 로드하고 WASM만 명시적으로 trace한다.
- browser와 server가 함께 쓰는 `validateBodyParagraphCandidate(document, input)`는 6.2/6.3의 전체 text, page/layout strict DTO, control/field 전수 검사, uniform format, before/context, PII 제외를 한 번만 구현한다. client scan은 UX를 위한 예비 결과이고 server 실행 결과만 run에 저장한다. manual anchor filter는 이 canonical 함수 바깥의 client-only 단계다.
- `fieldAnchors.ts`에는 기존 quick-writing resolver의 내부 candidate enumeration을 공유하는 새 `resolveRhwpFieldAnchorsExact()`를 추가한다. 결과는 필드마다 `{fieldId,status:"unique",anchor,candidateCount:1}` 또는 `{fieldId,status:"missing",candidateCount:0}` 또는 `{fieldId,status:"ambiguous",candidateCount:n}`다. 서로 다른 구조 target이 2개 이상이면 position/score 차이나 동률 여부와 무관하게 ambiguous다. 기존 `resolveRhwpFieldAnchors()`는 같은 enumeration 위에서 현재 ranking/hint 선택 의미를 그대로 유지한다.
- 서버 reserved anchors는 `loadWorkspaceDocumentContext()`에서 draft의 active document/surface/source attachment 선택 seam을 별도 export해 `loadConnectedDocumentFields()`와 같은 binding으로 다시 읽고, server-opened checkpoint document에 exact resolver를 실행해 만든다. 연결 필드가 0개면 빈 집합을 허용한다. 하나라도 missing/ambiguous이거나 section/range가 비정상이면 client의 `manualAnchors`로 보완하지 않고 그 문서의 agent 생성을 fail-closed한다.
- 서버는 선택 page의 안전 후보를 최대 24개 같은 순서로 다시 만들고, 요청 anchor와 candidate ID가 동시에 일치하는 단 하나만 허용한다. 0개/복수, source key·page·location·before/context/format 불일치는 모델 호출 전에 409 `candidate_stale`다. rebuilt DTO와 ID만 run/prompt에 들어간다.
- Phase 0은 Node loader가 HWP/HWPX fixture를 여는 테스트, `pnpm build:web` 성공, 생성된 `.next/**/*.nft.json` 중 server trace에 `rhwp_bg.wasm` 포함, build 산출물 환경에서 loader smoke를 모두 요구한다. 하나라도 실패하면 **서버 권위 검증을 client 검증으로 낮추지 않고 전체 기능을 STOP**한다.

참고: [Next.js output file tracing 공식 문서](https://nextjs.org/docs/app/api-reference/config/next-config-js/output), [Next.js serverExternalPackages 공식 문서](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages)

### 6.5 apply/undo 구현 규칙

- body는 `replaceText(section, paragraph, 0, length, afterText)`만 사용한다.
- 성공 순서는 `saveSnapshot -> beginBatch -> replaceText/format -> endBatch(finally) -> validate/export -> discardSnapshot`이다.
- mutation/format 예외 순서는 `endBatch(finally) -> restoreSnapshot -> discardSnapshot`이다. `beginBatch()`가 실패했으면 `endBatch()`를 호출하지 않고 restore/discard한다. restore나 discard 실패는 원래 오류와 함께 fatal transaction error로 합성하며 editor를 건드리지 않는다.
- captured `getCharPropertiesAt().charShapeId`와 `getParaPropertiesAt().paraShapeId`가 nonnegative integer인지 검사한다. replacement 뒤 core `getParagraphLength()`를 다시 읽어 그 범위 전체에 `setCharShapeId`, 문단에는 `setParaShapeId`를 사용하며 JS string length나 getter object를 format input으로 재사용하지 않는다. 기존 style ID는 변경하지 않고 승인 후 exact 재검증한다.
- after text 최대 4,000자, NUL/control character 금지, 문단 경계 삽입 금지다.
- 전체 page count는 전후 같아야 한다. 이 조건은 v1에서 엄격하다. 문장이 길어 page count가 바뀌면 제안을 반영하지 않고 더 짧게 다시 생성하도록 안내한다.
- semantic manifest는 section count, paragraph count, 모든 body text hash, paragraph별 raw control-position array, paragraph/style/char-format canonical hash, page count, `getDocumentInfo()` canonical hash를 포함한다. target의 text/char-format만 허용된 after 값으로 바뀌고 나머지는 같아야 한다.
- 공개 core API가 embedded binary payload 전체를 독립 열거하지는 않으므로 이 manifest를 byte-level 무손실 증명이라고 부르지 않는다. HWP/HWPX export/reopen과 실제 Studio roundtrip Phase 0 gate가 이 한계를 보완하며, 이 증거 수준이 통과하지 않으면 native bridge로 STOP한다.
- exported bytes는 `exportVerifiedRhwpDocument()`로 자기 재개방한다. 이후 Studio 재적재 후 다시 export하여 같은 semantic manifest인지 검사하는 것은 Phase 0과 브라우저 smoke의 필수 조건이다.

## 7. 모델·근거·비용 경계

### 7.1 모델 호출

- 운영 사용자 경로는 Anthropic API만 사용한다. 로컬 구독 `claude` CLI를 연결하지 않는다.
- `DOCUMENT_AGENT_MODEL`, 없으면 기존 `CHAT_DRAFT_MODEL`, 다시 없으면 field suggestion과 같은 default를 사용한다.
- `generateObject` + Zod structured output, temperature `0.2`, `maxOutputTokens: 4_000`, provider retry `0`, request abort + 45초 timeout을 사용한다.
- 호출 전 기존 `assertChatBudget`을 실행한다. `fieldSuggest.ts`의 private usage writer를 `generativeUsage.ts`의 idempotent event writer로 추출해 두 기능이 공유하며, event가 `started -> reported`로 처음 finalize될 때만 기존 chat daily usage에 합산한다. document agent는 성공/실패/fence loser 모두 provider attempt와 보고된 usage를 `(runId, attempt, leaseVersion)`으로 기록한다.
- 한 draft/user에서 in-flight run은 DB partial unique index와 fenced lease로 1개다. mount, page 변경, 후보 추출, 승인, Undo는 모델 호출을 만들지 않는다.

### 7.2 입력 한도

- request JSON 최대 64KiB
- 선택 후보 1개, before 최대 4,000자, context 최대 600자
- 현재 문서 source block 최대 6,000자
- 공고 grounding은 기존 12,000-token cap과 cache-control을 재사용
- 생성 대안 최대 2개, replacement 각각 최대 4,000자
- rationale 최대 400자
- evidence 최대 4개, quote 각각 최대 400자

모델 output schema는 `{suggestions: Array<{candidateId, replacement, rationale, evidenceRefs: Array<{sourceId, quote}>}>}`만 허용한다. anchor, location, before, format, document SHA는 output schema에 넣지 않으며 서버가 run의 candidate에서 복사한다.

### 7.3 source registry

서버가 결정론 registry를 만들고 모델은 registry ID만 돌려준다.

```text
current_document:<candidateId>
company_profile:<profile-key>
grant_announcement:<block-index>
deep_analysis:<criterion-dimension>:<sha256(criterionStableKey)>
```

- current document는 untrusted data로 감싸며 안의 지시를 수행하지 않는다.
- company profile은 실제 저장 primitive를 key별 source로 만든다.
- announcement는 `buildGrantGrounding()`의 실제 document block과 정규화 quote를 사용한다.
- deep analysis는 `ApplySheet`를 provenance 판정에 사용하지 않는다. `documentAgentGrounding.ts`의 exact serving loader가 다음 순서로 source를 만든다.

  1. draft의 exact `grantId`로 `analysis_lab_promotion_items`와 release를 join한다.
  2. item `status=applied`, `appliedAt IS NOT NULL`, `rolledBackAt IS NULL`, release `active|canary_passed`만 남긴다.
  3. 각 row를 `resolvePromotionServingEvidence()`에 통과시킨다. production evidence는 연결 deep run `status=passed`와 non-null `sourceRevisionSha256`, local evidence는 manifest artifact의 검증된 `sourceRevisionSha256`도 요구한다.
  4. `loadPromotionGrantSnapshot()`과 `promotionGrantSnapshotStateSha256()`로 현재 criterion/question/dedup state를 다시 계산하고 item `afterSha256`와 exact 비교한다.
  5. manifest의 해당 grant plan이 item `planSha256`와 `runId`에 exact 결속되는지 다시 확인한다.
  6. 통과 row를 `appliedAt DESC`로 정렬한다. 가장 최신 시각이 같은 row가 2개 이상이면 deep source 전체를 fail-closed한다. 유일한 최신 row만 선택한다.
  7. 선택 manifest의 `promotionPlan.criterionStableKeys`와 current snapshot criterion을 stable key로 교차한다. stable key가 null/빈 문자열이거나 manifest/snapshot 어느 쪽에서든 중복되면 해당 criterion을 제외한다.
  8. 통과 criterion은 `{stableKey, dimension, value, sourceSpan}` 단위로 registry entry를 만들고 source ID를 `deep_analysis:<dimension>:<sha256(stableKey)>`로 계산한다. 서로 다른 entry가 같은 source ID를 만들면 충돌 entry를 모두 제외한다. 같은 dimension에 여러 criterion이 있어도 서로 다른 full ID로 보존한다.

- run `groundingProvenance`에는 deep content가 아니라 `{promotionItemId, releaseDbId, releaseId, releaseStatus, appliedAt, runId, deepAnalysisRunId, planSha256, manifestSha256, afterSha256, servingEvidenceKind, sourceRevisionSha256}`와 모든 registry entry의 `{sourceId, contentSha256}`만 저장한다. 정렬된 전체 registry metadata의 `groundingBindingSha256`도 first-class run column에 둔다.
- 위 단계가 하나라도 실패하면 deep source만 생략하고 current document/company/announcement로 계속한다. raw run, held result, artifact storage key는 읽거나 저장하지 않는다.
- 모델이 반환한 `candidateId`는 요청 target과 같아야 한다.
- evidence ref는 축약 dimension이 아니라 위 full source ID를 저장·표시한다. `sourceId`가 registry에 없거나 quote가 그 exact entry의 정규화 부분 문자열이 아니면 해당 대안을 폐기한다.
- 새 회사 사실·수치·고유명사를 추가한 replacement가 current document만 근거로 들면 폐기한다.
- 유효 대안이 0개면 `empty`로 끝내고 editor를 바꾸지 않는다.

### 7.4 지연 관측

- content 없이 `candidateScanMs`, `checkpointSaveMs`, `groundingMs`, `modelMs`, `applyCoreMs`, `reloadMs`, `snapshotSaveMs`, 후보/제안 수, timeout/failure code만 계측한다.
- 후보 scan은 사용자가 고른 쪽을 문서 순서로 탐색하고 page index가 단조 증가함을 확인한 뒤 선택 쪽을 지난 시점에 중단한다. 단조성이 깨지면 전체 scan으로 fallback하지 않고 후보 추출을 fail-closed한다.
- Phase 0 실제 두 문서에서 candidate scan이 주 스레드를 2초 넘게 점유하거나 apply core+reload가 upload 제외 3초를 넘으면 GO하지 않는다. 이때 web worker 또는 native bridge를 별도 설계하며 임의로 한도를 늘리지 않는다.
- 모델은 45초에 중단하고 사용자가 명시적으로 다시 누르기 전 자동 재호출하지 않는다. 취소가 이미 발생한 provider 과금을 되돌린다고 안내하지 않는다.

## 8. 서버 상태·API·DB

### 8.1 상태 머신

```text
run: generating -> ready | empty | failed | cancelled

suggestion content: pending -> approved -> applied -> undone
                    pending -> dismissed
                    pending | approved -> stale

operationState: idle -> apply_saving -> idle
                apply_saving -> apply_save_failed -> apply_saving
                apply_saving | apply_save_failed -> idle(stale/abandoned)
                idle(applied) -> undo_saving -> idle(undone)
                undo_saving -> undo_save_failed -> undo_saving
                undo_saving | undo_save_failed -> idle(applied/abandoned)
                apply_saving -> idle(approved/recovered)
                undo_saving -> idle(applied/recovered)
```

content 상태는 `statusVersion`, operation 상태는 `operationVersion` CAS다. **성공, 실패, 재시도, 포기, timeout recovery를 포함한 모든 operation transition이 version을 정확히 1 증가**시킨다. `operationStartedAt`은 `apply_saving|undo_saving`에서만 non-null이고 다른 상태 전환에서 null로 지운다. `operationClientId`는 saving/save_failed 동안 유지하고 성공/abandon/recover에서 null로 지우며, 다시 시작하는 apply/Undo는 새 client ID를 설정한다. 문서 저장 성공 전에 `applied`, Undo 저장 성공 전에 `undone`으로 기록하지 않는다. `failureCode`는 `core_validation_failed | reload_failed | snapshot_upload_failed | revision_conflict | undo_conflict | apply_rolled_back | undo_rolled_back | operation_recovered` allowlist만 저장하고 provider/원문 오류를 넣지 않는다.

### 8.2 API

- `GET /api/web/document-drafts/[draftId]/agent-suggestions`
  - creator의 active/recent run과 receipt 상태를 조회한다.
- `POST /api/web/document-drafts/[draftId]/agent-suggestions`
  - exact checkpoint ID와 선택 힌트를 받아 서버가 checkpoint bytes에서 후보를 재구축한 뒤 run을 생성한다.
- `PATCH /api/web/document-drafts/[draftId]/agent-suggestions/[suggestionId]`
  - `{action: "approve" | "dismiss" | "stale" | "start_apply" | "apply_save_failed" | "retry_apply_save" | "abandon_apply" | "authorize_undo" | "undo_save_failed" | "retry_undo_save" | "abandon_undo" | "recover_operation"}`를 처리한다.

모든 route를 `SESSION_WEB_ROUTES`와 exact route-policy 검사에 추가한다.

두 agent-suggestion route는 `export const runtime = "nodejs"`를 명시한다. server candidate authority/core loader는 이 route에서만 동적 import하며 Edge fallback은 만들지 않는다.

- GET은 company membership, POST/PATCH는 write permission을 요구한다.
- body의 `companyId`, `grantId`, storage key는 받지 않는다. `getGrantDocumentDraft({draftId, access})`에서 소유권과 grant를 얻는다.
- POST는 `baseRevisionId === current head`, revision sha256 === server-loaded bytes SHA, checkpoint request 결속, server-rebuilt candidate ID 일치를 모델 호출 전에 확인한다.
- approve는 current head가 run base인지와 현재 source registry metadata의 `groundingBindingSha256`가 run 값과 같은지를 재검사한다. 둘 중 하나라도 다르면 `stale`이다. start_apply는 current head가 run base인지, authorize_undo는 current head가 applied revision인지 다시 검사한다.
- `applied`와 `undone` client action은 없다. agent snapshot save가 revision/head와 suggestion 상태를 한 transaction에서 전환한다.

### 8.3 멱등성과 lease

- `clientRequestId`는 UUID이며 unique `(draftId, createdBy, clientRequestId)`다.
- `requestBindingSha256 = sha256(canonicalJson({schemaVersion,draftId,createdBy,baseRevisionId,documentSha256,candidateId,modelVersion,promptVersion,groundingBindingSha256}))`로 고정하고 server-rebuilt 값만 넣는다.
- `status=generating`에 대해 partial unique `(draftId, createdBy)`를 둬 동시에 두 run이 생성되지 않게 한다.
- 같은 ID와 같은 `requestBindingSha256`면 기존 run을 반환한다.
- 같은 ID와 다른 binding이면 409다.
- run에는 `leaseOwner` UUID, `leaseVersion` integer, `leaseExpiresAt`을 둔다. 생성과 임대는 한 DB transaction에서 처리한다.
- lease TTL은 120초, provider timeout은 45초다. valid `generating` lease가 있으면 새 request ID여도 202와 기존 run ID를 반환한다.
- 만료 run을 회수할 때 request binding이 원래 row와 같아야 한다. 회수 transaction은 먼저 이전 tuple의 남은 `started` usage event를 `unavailable`로 finalize한다. binding이 같으면 같은 row에서 `attempt += 1`, `leaseVersion += 1`, 새 owner/expiry를 CAS한다. 다른 binding이면 같은 transaction에서 이전 row를 `failed/lease_expired`로 fence해 partial unique slot을 비운 뒤 새 run을 insert하며, 기존 row를 새 입력에 재사용하지 않는다.
- provider 호출 직전에 모든 attempt는 terminal fencing 결과와 무관하게 `generative_usage_events`의 `(runId, attempt, leaseVersion)` 행을 `started`로 한 번 만든다. 응답 또는 usage를 포함한 provider error를 받으면 같은 행을 `reported`로 finalize하고 실제 billable usage와 provider request ID를 한 번 기록한다. usage를 제공하지 않는 timeout/error도 `unavailable`로 종결해 호출 사실을 숨기지 않는다. 그 다음 완료/실패 update와 suggestion insert는 `(id, status=generating, leaseOwner, leaseVersion)`을 모두 조건으로 한다. fencing을 잃은 호출은 usage event 외 결과·suggestion·run token aggregate를 버린다.
- apply command ID는 suggestion ID, undo command ID는 `${suggestionId}:undo`다.
- revision first-class `agentCommandId` unique가 응답 유실과 중복 save를 조정한다.

### 8.4 새 테이블

`grant_document_agent_runs`

- `id`, `draftId`, `createdBy`, `clientRequestId`
- `status`, `statusVersion`, `attempt`, `leaseOwner`, `leaseVersion`, `leaseExpiresAt`
- `requestBindingSha256`, `baseRevisionId`, `documentSha256`
- `studioSessionId`, `documentEpoch`, `changeSeq`
- `selectedPage`, candidate contract JSON, `candidateId`
- `modelVersion`, `promptVersion`, `groundingBindingSha256`, `groundingProvenance`
- input/output/cache read/cache write token counts
- `failureCode`, `createdAt`, `completedAt`

`grant_document_agent_suggestions`

- `id`, `runId`, `draftId`, `createdBy`, `ordinal`
- anchor/location/before/after/format/rationale/evidence JSON
- `status`, `statusVersion`, `operationState`, `operationVersion`, `operationStartedAt`, `operationClientId`, `failureCode`
- `appliedDocumentSha256`, `undoneDocumentSha256`
- `appliedRevisionId`, `undoneRevisionId`
- `approvedAt`, `appliedAt`, `undoneAt`, `updatedAt`
- unique `(runId, ordinal)`

`generative_usage_events`

- `id`, `companyId`, `userId`, `grantId`, `sourceKind`, `sourceRequestId`
- document agent의 `runId`, `attempt`, `leaseVersion`; field suggestion은 모델 호출 전에 만든 UUID를 `sourceRequestId`로 사용한다.
- `model`, `usageStatus=started|reported|unavailable`, nullable provider request ID, input/output/cache read/cache write token counts, `createdAt`, `finalizedAt`
- document agent partial unique `(runId, attempt, leaseVersion) WHERE runId IS NOT NULL`
- field suggestion partial unique `(sourceKind, sourceRequestId) WHERE runId IS NULL`; 한 route invocation 안의 start/finalize가 같은 server-generated UUID를 사용한다.
- `beginGenerativeUsage()`는 event를 `ON CONFLICT DO NOTHING`으로 만든다. `finalizeGenerativeUsage()`는 `started` row를 lock해 reported counts를 한 번 기록하고, 그 전환이 성공한 경우에만 같은 DB transaction에서 기존 일일 chat usage aggregate를 증가시킨다. 그래서 ACK 유실, lease loser, terminal retry에도 reported provider usage는 한 번만 예산에 반영된다.

기존 `grant_document_revisions`에 다음 nullable first-class columns를 추가한다.

- `checkpointRequestId`, `agentCommandId`, `agentOperation`, `agentRunId`, `agentSuggestionId`
- checkpoint partial unique `(draftId, createdBy, checkpointRequestId) WHERE checkpointRequestId IS NOT NULL`
- 기존 `(draftId, studioSessionId, documentEpoch, changeSeq, sha256)` 멱등 index는 `WHERE checkpointRequestId IS NULL`인 partial unique로 교체해 checkpoint가 same-content manual/autosave revision에 흡수되지 않게 한다.
- unique partial `agentCommandId IS NOT NULL`
- agent paired CHECK: command/operation/run/suggestion 네 값은 전부 null이거나 전부 non-null이고 `agentOperation IN ('apply','undo')`
- `studio_agent_checkpoint` origin은 `checkpointRequestId`만 필수이고 agent command 네 값은 null이다. `studio_agent_apply|studio_agent_undo`는 checkpoint ID가 null이고 agent command 네 값이 필수다. 다른 origin은 다섯 값이 모두 null이다.

checkpoint request는 `checkpointRequestId`, origin, parent revision ID와 bytes만 받는다. 서버는 current head와 parent를 일치시키고 SHA를 계산한다. 동일 request ID retry는 draft/creator/origin/parent/SHA가 모두 같고 그 revision이 current head일 때만 기존 결과를 반환하며 하나라도 다르면 409다. 같은 bytes/changeSeq의 기존 manual/autosave revision은 checkpoint로 재사용하지 않는다.

legacy manual/autosave replay도 head를 뒤로 보낸 성공 응답을 만들지 않는다. 기존 legacy idempotency row가 current head면 그대로 반환한다. 그 row의 direct child인 current head가 same-SHA `studio_agent_checkpoint`이면 current checkpoint head를 no-op ACK로 반환한다. 그 외 existing row가 current head가 아니면 409다. checkpoint 뒤 최초의 새로운 legacy key는 partial index에 따라 정상 child revision을 만들 수 있다.

agent snapshot request는 suggestion ID, operation, operationVersion만 받는다. route는 R2 upload 전에 current user/draft/suggestion의 operation authorization을 읽어 불필요한 object upload를 막고, `saveStudioSnapshot()` DB transaction 안에서 같은 조건을 다시 잠금 검증한다. expected command/run/origin은 서버가 파생한다. apply는 parent가 run base revision이고 parent SHA가 run document SHA인지, undo는 parent가 applied revision이고 parent SHA가 stored after document SHA인지 확인한다. 새 revision의 SHA는 업로드 body에서 서버가 계산한다. revision/head insert와 suggestion의 applied/undone 전환은 같은 transaction이다.

동일 command 재호출은 current head가 그 `agentCommandId` revision이고 draft/creator/origin/operation/run/suggestion/parent SHA가 모두 같을 때만 기존 결과를 반환한다. command가 다른 revision에 있거나 current head가 아니면 409다. 요청의 revision ID나 `verification` JSON은 이 판정의 권위값으로 쓰지 않는다.

`apply_saving|undo_saving`이 5분을 넘었고 동일 command revision이 없을 때 creator는 어느 탭에서든 `recover_operation`을 호출할 수 있다. 서버는 row lock 후 timeout, command 부재, current head를 다시 확인한다. apply는 head가 run base이면 `approved/idle`, 아니면 content `stale/idle`; Undo는 `applied/idle`로 바꾸고, operationVersion을 1 증가시키며 `operationClientId=null`, `failureCode=operation_recovered`를 기록한다. 늦게 도착한 이전 upload/retry/abandon은 version/client 검증에서 실패하며 head나 suggestion을 바꾸지 못한다.

원문 prompt, 전체 공고문, 전체 profile, 전체 document bytes, R2 key를 run/suggestion 두 테이블에 저장하지 않는다. 필요한 선택 target의 before/after와 짧은 evidence만 draft 수명 동안 보관하고 draft 삭제 시 cascade한다. usage event에는 content/evidence를 넣지 않는다.

세 테이블은 `ENABLE/FORCE ROW LEVEL SECURITY`를 적용한다. run/suggestion은 creator이면서 현재 draft company member인 사용자만 SELECT할 수 있고 writer만 자신의 row를 INSERT/UPDATE할 수 있다. usage event는 server writer만 INSERT하고 `userId=current user`이면서 현재 company member인 행만 SELECT할 수 있다. `generative_usage_events_writer_update` 정책은 같은 writer가 자기 company/user의 `usageStatus='started'` 행만 대상으로 삼고, WITH CHECK에서 동일 company/user와 `reported|unavailable`만 허용한다. `finalizeGenerativeUsage()`도 `WHERE id=? AND usage_status='started'`인 단방향 update만 실행하며 event 전환과 daily aggregate 증가는 같은 transaction이다. DELETE 정책은 열지 않는다. 세 테이블과 usage UPDATE policy를 `REQUIRED_TABLES`, `RLS_TABLES`, `verify-rls-policy.ts`의 새 migration 검증 목록에 추가한다.

`grant_document_draft_events`에는 content 없이 run started/completed, suggestion approved/applied/undone/stale와 ID/revision ID만 append한다. `generative_usage_events`는 감사 event가 아니라 billable usage 멱등 원장이다.

## 9. UI와 client 소유권

### 9.1 구성

- `RhwpStudioSurface`는 editor ref, export/reload, save mutex와 working refs를 계속 소유한다.
- `useDocumentAgent`는 UI/run state만 소유하고 editor 객체를 직접 받지 않는다.
- `DocumentAgentTransaction` adapter 메서드만 `RhwpStudioSurface`가 hook에 주입한다.
- agent transaction과 기존 save는 동일 mutex를 사용한다. apply/undo/checkpoint 중 기존 save 버튼과 iframe interaction을 overlay로 잠근다.
- 현재 `save()`는 persistence 실패 시 tab snapshot을 반환하므로 agent 성공 판정에 직접 재사용하지 않는다. 내부 export/working-ref 조립을 공용 helper로 추출하되, agent용 `persistAgentSnapshot()`은 `{kind:"persisted", document, revision} | {kind:"failed", tabDocument, error}` discriminated result를 반환한다. `persisted`만 applied/undone 성공으로 취급하고 기존 manual/autosave의 사용자 동작은 바꾸지 않는다.

### 9.2 shadcn 구성

이미 설치된 `Sheet`, `Card`, `Badge`, `ScrollArea`, `Alert`, `Button`, `Spinner`, `Skeleton`을 조합한다. lucide icon과 기존 semantic token만 사용하며 전역 token, shadcn 기본 variant, 일반 사용자 디자인 시스템을 바꾸지 않는다.

접근성 요구:

- Sheet title/description 필수
- 상태 변경은 `aria-live=polite`, 오류는 alert
- diff는 색만으로 구분하지 않고 `삭제`, `추가` 텍스트와 `<del>/<ins>` 사용
- keyboard focus는 승인 dialog -> 적용 중 -> 결과/Undo로 예측 가능하게 이동
- destructive-looking Undo 전 확인 dialog에는 대상 위치와 변경 전 문장을 다시 표시
- reduced motion에서 Sheet 이외의 추가 animation 없음

### 9.3 feature flag

- server env `CUNOTE_DOCUMENT_AGENT_ENABLED`가 명시적으로 `true|1`일 때만 `workspaceData.documentAgentAvailable=true`다.
- persistent workspace + write permission + flag가 모두 true여야 버튼을 표시한다.
- API도 같은 server flag를 검사해 UI 우회 호출을 404로 닫는다.
- `.env*` 파일을 구현 계획에 포함하지 않는다. 운영 flag enable과 배포는 별도 승인 범위다.

## 10. 변경 예상 파일

### 10.1 새 파일

- `apps/web/src/lib/rhwp/documentAgentContract.ts`
  - versioned anchor/candidate/command/result type, canonical hash
- `apps/web/src/lib/documents/manualFieldPolicy.ts`
  - 기존 17개 manual keyword와 agent PII pattern의 browser/server 공용 predicate
- `apps/web/src/lib/rhwp/documentAgentCandidates.ts`
  - safe body-only 후보, reserved anchor 제외, Zod decoder
- `apps/web/src/lib/rhwp/documentAgentManifest.ts`
  - semantic manifest와 target/non-target 비교
- `apps/web/src/lib/rhwp/documentAgentTransaction.ts`
  - snapshot/batch apply/undo, verified export
- `apps/web/src/lib/rhwp/documentAgentApi.ts`
  - GET/POST/PATCH client
- `apps/web/src/features/apply-workspace/documentAgentState.ts`
  - client reducer와 illegal transition 방지
- `apps/web/src/features/apply-workspace/useDocumentAgent.ts`
- `apps/web/src/features/apply-workspace/DocumentAgentSheet.tsx`
- `apps/web/src/features/apply-workspace/DocumentAgentDiff.tsx`
- `apps/web/src/lib/server/documents/documentAgentAvailability.ts`
- `apps/web/src/lib/server/rhwp/documentAgentCore.ts`
  - Node-only `@rhwp/core`/WASM singleton loader와 production-runtime smoke seam
- `apps/web/src/lib/server/documents/documentAgentCandidateAuthority.ts`
  - exact checkpoint R2 bytes, server connected-field anchors, shared candidate 재구축
- `apps/web/src/lib/server/documents/documentAgentGrounding.ts`
  - exact promotion serving loader와 공고/profile/current-document source registry
- `apps/web/src/lib/server/documents/documentAgentPrompt.ts`
- `apps/web/src/lib/server/documents/documentAgentRuns.ts`
- `apps/web/src/lib/server/documents/generativeUsage.ts`
- `apps/web/src/app/api/web/document-drafts/[draftId]/agent-suggestions/route.ts`
- `apps/web/src/app/api/web/document-drafts/[draftId]/agent-suggestions/[suggestionId]/route.ts`
- 위 모듈별 `.test.ts`, `DocumentAgentSheet.render.test.tsx`

### 10.2 수정 파일

- `apps/web/src/features/apply-workspace/RhwpStudioSurface.tsx`
  - shared mutex, checkpoint/apply/undo adapter, reload/ref/state 갱신, Sheet 배치
- `apps/web/src/features/apply-workspace/RhwpStudioSurface.render.test.tsx`
- `apps/web/src/features/apply-workspace/WorkspaceView.tsx`
  - server availability prop 전달만 추가
- `apps/web/src/lib/server/documents/workspaceData.ts`
  - persistent/write/flag 기반 availability, agent route가 같은 active document/surface/attachment binding을 얻는 read seam export
- `apps/web/src/lib/rhwp/studioSnapshots.ts`
  - AI origin union, typed agent command discriminant, persisted/failed result
- `apps/web/src/lib/rhwp/fieldAnchors.ts`, `apps/web/src/lib/rhwp/fieldAnchors.test.ts`
  - 내부 candidate enumeration 공유, quick resolver 의미 불변, agent용 unique/missing/ambiguous exact resolver
- `apps/web/src/app/api/web/document-drafts/[draftId]/studio-snapshots/route.ts`
  - origin allowlist 확장
- `apps/web/src/lib/server/documents/documentRevisions.ts`
  - exact revision file loader, checkpoint request 멱등성, AI origin/first-class command 검증, agent snapshot과 suggestion 원자 전환, 서비스 테스트 seam
- `apps/web/src/lib/server/documents/fieldSuggest.ts`
  - manual predicate를 shared policy로, usage writer를 `generativeUsage.ts`로 이동하고 동작 불변
- `apps/web/src/lib/server/chat/grounding.ts`
  - 결정론 announcement/profile source builder export; 기존 chat output 불변
- `apps/web/src/lib/server/db/schema.ts`
- `apps/web/src/lib/server/db/requirements.ts`
- `apps/web/src/lib/server/auth/routePolicy.ts`
- `apps/web/next.config.mjs`
  - `@rhwp/core` server externalization과 `rhwp_bg.wasm` output trace include
- `packages/contracts/scripts/verify-rls-policy.ts`
- `package.json`
  - `test:document-agent` 추가, `studioTransport.test.ts`를 aggregate에 포함
- Drizzle 생성 migration `db/migrations/0071_<generated>.sql`
- `db/migrations/meta/0071_snapshot.json`, `db/migrations/meta/_journal.json`

### 10.3 의도적으로 수정하지 않는 파일/의미

- `documentAuthoring.ts`, `FieldPanel.tsx`: quick-field 계약에 agent를 합치지 않는다. `RhwpStudioSurface`는 connected exact authority anchors와 client-only manual anchors를 분리해 후보 제외에만 사용한다.
- `workingDocument.ts`: 기존 quick delta의 fail-closed 의미를 바꾸지 않는다.
- `WorkspaceFooter.tsx`와 download route: 기존 latest working/head bytes 선택을 유지한다.
- Studio URL 또는 private transport protocol: 변경하지 않는다.
- 전역 CSS/shadcn token: 변경하지 않는다.

## 11. 단계별 구현 순서

### Phase 0 — client/server RHWP feasibility gate

이 단계에서는 API, DB, 모델, 사용자 노출 UI를 만들지 않는다.

1. `documentAgentContract`, candidate decoder, semantic manifest, transaction 순수 모듈과 테스트만 작성한다.
2. `HwpDocument.createEmpty()`에서 본문/혼합 서식/본문 control을 구성하여 HWP와 HWPX deterministic fixture bytes를 테스트 중 생성한다.
3. non-empty body paragraph의 extract/apply/undo, exact connected-field resolver의 unique/missing/ambiguous, 표·field·reserved paragraph 제외를 두 형식에서 검증한다. 기존 quick resolver 결과가 바뀌면 STOP한다.
4. Node-only core loader와 `next.config.mjs`의 server externalization/WASM trace include를 추가하고 HWP/HWPX fixture open test를 실행한다.
5. `@rhwp/editor` fake로 load/export ordering, before fallback, ref 갱신을 검증한다.
6. `pnpm build:web`을 실행해 production build가 성공하고 server `.nft.json` trace에 `rhwp_bg.wasm`이 포함되며 build 환경 loader smoke가 두 fixture를 여는지 확인한다.
7. 사용자가 띄운 기존 개발 서버에서 실제 소유 application HWP 1건, HWPX 1건으로 checkpoint 없는 local browser spike를 수행한다. 실제 문서는 저장소 fixture로 복사하지 않는다.
8. 아래 GO 조건을 모두 만족한 증거를 테스트 로그와 구현 PR 설명에 남긴다.

GO 조건:

- HWP/HWPX 모두 apply -> export -> core reopen 성공
- Node server loader가 두 format을 열고 production build trace/runtime에서 WASM을 찾음
- 전후 page count 동일
- target 외 semantic manifest 동일
- patched bytes를 Studio `loadFile`한 뒤 re-export한 semantic manifest 동일
- Undo 후 target text/format과 비대상 manifest가 before와 동일
- Undo가 target 밖 수동 편집을 보존
- reload 시 권한/글꼴 modal이 반복되지 않음
- reload 후 입력, 수동 저장, 빠른 작성 복귀, 다운로드 정상
- 실제 두 문서에서 안전 후보가 최소 1개 이상이며 위치 설명이 사용자가 구별 가능

STOP 조건은 GO의 반대 및 다음 항목이다.

- body paragraph의 control-position/layout DTO가 설치 버전의 실제 출력과 맞지 않음
- mixed format 제외 때문에 실제 신청서에서 유용한 후보가 0개
- current selection 또는 cursor 보존이 제품상 필수로 확인됨
- Node loader, Next production bundle, Vercel-compatible output trace 중 하나라도 WASM을 결정론적으로 찾지 못함

STOP이면 이후 phase를 진행하지 않는다. `@rhwp/editor`의 versioned capabilities에 `getSelectionContext`, `applyTextCommand`, `revertCommand`, `focusTarget`을 추가하는 별도 Studio/native bridge 계획을 작성한다.

### Phase 1 — persistence와 보안 계약

1. schema에 run/suggestion/usage event 세 테이블, revision의 first-class checkpoint/agent command columns와 enum/check/index/FK를 추가한다.
2. `pnpm db:generate`로 migration과 meta를 생성한다. 생성 migration이 세 새 테이블과 명시한 revision columns/index/check 외 기존 schema를 바꾸면 중단한다.
3. generated SQL에 ENABLE/FORCE RLS, creator+company membership 정책, usage writer의 started -> reported|unavailable 전용 UPDATE 정책을 명시적으로 추가한다.
4. requirements와 RLS verifier를 같은 migration tag로 갱신한다.
5. route policy와 feature-flag availability를 구현·테스트한다.
6. snapshot origin union과 checkpoint request partial unique, agent snapshot 원자 상태 전환을 checkpoint/apply/undo까지 확장한다.

### Phase 2 — grounding와 모델 run

1. shared usage event writer를 추출하고 field suggestion 회귀 테스트로 동작 불변을 증명한다.
2. exact revision byte loader와 server connected-field reservation seam, `documentAgentCandidateAuthority`를 구현한다. server/client shared validator parity가 깨지면 모델 경로를 진행하지 않는다.
3. exact promotion loader와 collision-safe source registry를 current document/company/announcement/verified deep 순으로 조립한다.
4. prompt와 Zod output, candidate/evidence/quote 검증을 순수 함수로 먼저 테스트한다.
5. run lease/idempotency와 POST/GET API를 구현하고, route가 실제 production build에서 Node runtime core loader를 통과하는지 다시 확인한다.
6. 모델 실패·timeout·cancel/fence loser에서 문서 mutation 0회, 결과 폐기, usage 1회 기록을 검증한다.

### Phase 3 — 제안 전용 UI

1. reducer, API client, Sheet, target picker, diff/evidence Card를 구현한다.
2. click 때 만든 `checkpointRequestId`로 checkpoint 저장 성공 뒤에만 최소 candidate hint POST를 연결한다.
3. 이 phase에서는 apply callback을 test stub으로 두어 승인 전 문서 변경이 구조적으로 불가능함을 테스트한다.
4. virtual/admin/local preview와 flag off에서 UI/API 호출 0회를 확인한다.

### Phase 4 — 승인 적용과 즉시 저장

1. shared mutex 안에 approve -> exact validation -> core patch -> reload -> apply save를 연결한다.
2. first-class revision command와 snapshot service의 applied 원자 전환/멱등 복구를 연결한다.
3. apply_saving/apply_save_failed, version을 증가시키는 retry/abandon, timeout recovery, CAS 409 후 mandatory head reload UI를 구현한다.
4. 한 run의 sibling stale와 한 번만 적용되는 멱등성을 검증한다.

### Phase 5 — Undo

1. latest applied/head authorization을 구현한다.
2. exact after 검증과 inverse transaction을 연결한다.
3. undo_saving/undo_save_failed, version을 증가시키는 retry/abandon/timeout recovery와 snapshot service의 undone 원자 전환/멱등 복구를 연결한다.
4. same-target manual edit, later saved revision, duplicate undo를 각각 conflict/idempotent로 검증한다.

### Phase 6 — 회귀와 제한 롤아웃 준비

1. targeted, aggregate, typecheck, build 순으로 검증한다.
2. 사용자 실행 개발 서버에서 HWP/HWPX browser smoke를 반복한다.
3. flag off 기본값과 API 404를 확인한다.
4. flag enable, 배포, 운영 관측은 이 구현과 별도의 사용자 승인 작업으로 남긴다.

## 12. 테스트 전략

### 12.1 core/transaction

- non-empty body paragraph 후보, empty paragraph/모든 table cell 제외
- HWP/HWPX export/reopen
- mixed format, body control, core field, quick/manual reserved anchor, manual/PII 제외
- shared 17-keyword/manual policy와 주민·외국인등록/여권/운전면허 exact regex의 browser/server 동일 제외, 기존 field suggestion predicate 회귀 불변
- 같은 connected reserved target/부분 중첩 field range 제외, connected anchor missing/ambiguous 시 문서 전체 fail-closed
- exact connected-field resolver의 unique/missing/ambiguous, 점수가 다른 복수 구조 후보도 ambiguous; 기존 quick resolver ranking 결과는 회귀 불변
- manual anchor가 있어도 client/server canonical candidate ID가 같고, preview 및 승인 직전 local collision은 별도로 stale
- malformed page/control JSON fail-closed
- exact before apply, already-after idempotent, changed-before stale
- page count 변화 거부
- target 외 body/control/format/document-info manifest 불변
- mutation 예외 시 snapshot restore
- exact inverse Undo, changed-after Undo conflict
- target 밖 편집 보존

### 12.2 server

- unauthenticated 401, viewer write 403, 다른 회사 draft 404
- flag off 404
- UUID/SHA/page/length/JSON body 한도
- checkpoint head/sha mismatch 409 및 모델 호출 0회
- checkpoint ACK 유실 뒤 같은 request ID/origin/parent/SHA는 같은 revision 반환, 한 필드라도 다른 replay는 409
- byte-identical manual ACK 유실을 legacy key 재조회로 current head에 화해한 뒤 checkpoint가 그 child revision을 만들고, 이후 같은 legacy key replay는 checkpoint head를 no-op ACK해 head를 되돌리지 않음; checkpoint 뒤 새 legacy key는 index 충돌 없이 child 생성
- exact revision R2 body signature/SHA/format mismatch fail-closed
- client before/context/format/location/reserved anchor extra key 거절, forged anchor/candidate ID와 서버 재구축 불일치에서 모델 0회
- client/server `validateBodyParagraphCandidate` golden parity, manual anchor 존재 시 ID parity, server 연결 필드 missing/복수 anchor에서 전체 생성 fail-closed
- Node RHWP singleton init, HWP/HWPX open, production build trace의 `rhwp_bg.wasm`, built runtime smoke
- budget 429, model key 없음, timeout/cancel
- 같은 request ID/same binding replay, different binding 409
- concurrent POST partial-unique 1 run/1 model call, valid lease 202
- 120초 expired lease same binding만 row 회수; different binding은 old `failed/lease_expired` fence와 new row insert가 한 transaction
- 같은 `(runId,attempt,leaseVersion)` usage finalize 중복은 event/일일 aggregate 1회; expired old attempt와 current winner는 서로 다른 tuple로 각 provider 호출 1회 기록, loser의 suggestion/run aggregate 0회
- field suggestion의 같은 `(sourceKind,sourceRequestId)` begin/finalize 중복은 event와 aggregate 1회
- FORCE RLS를 실제 적용한 writer transaction에서 started -> reported/unavailable finalize만 성공하고 reported 재수정, 다른 user/company update, DELETE는 거부
- prompt injection 문자열을 instruction으로 실행하지 않음
- 모델 생성 anchor 무시, 잘못된 candidate/source/quote 폐기
- held/unpromoted/invalid provenance deep source 미주입
- promotion current-state hash drift, multiple newest appliedAt tie에서 deep source 미주입
- 유일한 newest serving verified source의 manifest stable-key criterion만 주입
- 같은 dimension의 서로 다른 stable key가 서로 다른 full deep source ID를 얻고, null/중복 stable key 및 계산된 source ID 충돌은 모두 제외
- company/announcement/deep registry metadata drift 뒤 approve가 suggestion을 stale 처리하고 mutation 0회
- creator RLS 격리와 writer 정책
- approve/start_apply/authorize_undo/operation failure의 illegal 상태·version 거부
- 모든 start/failure/retry/abandon/recover/success transition마다 operationVersion +1, stale version 거부
- 5분 전 operation recovery 거부; 5분 후 no-command에서 어느 creator 탭이든 recovery 가능, apply head=base면 `approved/idle`·head drift면 `stale/idle`, Undo는 `applied/idle`, client ID null, 늦은 upload 거부
- 다른 `operationClientId`의 failure/retry/abandon 거부; timeout recover는 ID 불요, creator 아닌 호출 거부
- agent snapshot이 creator/origin/operation/run/suggestion/parent SHA 불일치 거부
- revision/head와 applied/undone 원자 전환, unique command 응답 유실 recovery

### 12.3 UI/integration

- mount, Sheet open, page selection, candidate scan에서 모델 0회
- `현재 문서를 저장하고 제안 받기` 클릭 전 write/model 0회, 클릭 뒤 동일-content checkpoint와 model 1회
- 모델 실패/empty에서도 checkpoint 이력과 안내 유지
- checkpoint/POST ACK 유실 재시도 동안 UUID 쌍 유지, page/후보를 새로 고른 명시 동작에서만 새 UUID 쌍 생성
- 위치/근거/before-after를 모두 표시
- 승인 전 editor mutation 0회
- 승인 카드 한 개만 transaction 1회
- stale에서 mutation 0회
- apply_saving/apply_save_failed/undo_saving/undo_save_failed 동안 iframe/save/quick 전환 잠금
- apply 저장 뒤 working refs와 download bytes가 after
- quick mode 복귀 후 after 유지, quick delta가 AI text를 덮어쓰지 않음
- apply save 실패를 applied로 오표시하지 않고 exact after만 재시도/rollback
- undo save 실패에서 exact inverse-before만 재시도하고 exact applied bytes만 rollback
- retry가 core patch/reload를 반복하지 않고 동일 command+새 operationVersion으로 저장만 재호출
- apply/undo CAS 409에서 선택적 다운로드 뒤 최신 head reload 성공 전 잠금 유지; 성공 후 각각 stale/idle·applied/idle 전환
- 원래 탭 종료 뒤 다른 creator 탭이 timeout recovery 가능; 모든 탭은 recovery 뒤 server head reload 전 잠금/재시작 불가, 이전 client ID의 retry/abandon 불가
- 각 reload/rollback에서 refs와 epoch/changeSeq가 정확히 한 번 전진
- Undo 저장 뒤 before, 다른 위치 편집 보존
- local/admin preview와 flag off API/DB write 0회
- 여러 탭에서 두 번째 save 409, 자동 merge 없음
- legacy save protocol과 future change-event autosave 모두 회귀

### 12.4 실행 명령

구현자는 현재 lockfile대로 pnpm을 사용한다.

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

브라우저 검증은 AGENTS.md에 따라 사용자가 개발 서버를 띄운 뒤 수행한다. Codex가 임의로 `pnpm dev`를 시작하지 않는다.

## 13. 완료 기준

다음 항목이 모두 충족돼야 구현 완료로 선언할 수 있다.

- Phase 0 GO 증거가 HWP/HWPX와 실제 문서 양쪽에 있다.
- 승인 전 editor mutation이 테스트와 브라우저 모두 0회다.
- 제안 카드가 위치, 근거, before/after를 빠짐없이 표시한다.
- stale/fuzzy/ambiguous target은 모두 fail-closed한다.
- checkpoint R2 bytes에서 서버가 후보를 재구축하며 client 후보 필드는 권위값이 아니다.
- 적용과 Undo가 검증된 새 revision을 만들고 기존 head CAS를 보존한다.
- checkpoint와 apply/undo 저장 ACK 유실이 중복 revision·중복 mutation·head 후퇴를 만들지 않는다.
- apply save 실패를 성공으로 오표시하지 않으며 versioned retry/abandon, 충돌 시 mandatory head reload 경로가 있다.
- provider attempt usage가 fence 승패와 무관하게 idempotent ledger에 남는다.
- 빠른 작성, 수동 저장, autosave, 다운로드 회귀가 없다.
- preview/flag off 환경에서 model call과 DB write가 0회다.
- route policy, RLS, targeted/aggregate tests, typecheck, production build가 모두 통과한다.
- feature flag는 기본 off다. 배포/enable은 수행하지 않는다.

## 14. 구현 중 판단 금지 목록

구현자는 다음을 편의상 완화하지 않는다.

- current page/selection을 추측하지 않는다. 사용자가 쪽과 후보를 고른다.
- private editor transport를 호출하지 않는다.
- 전체 문서 SHA 또는 target preimage가 다르면 적용하지 않는다.
- table/control type을 예외 probing으로 추정하지 않는다.
- mixed formatting을 대충 sampling하여 허용하지 않는다.
- page count 변화나 비대상 semantic 변화가 있는 결과를 저장하지 않는다.
- 모델이 만든 사실, anchor, quote를 검증 없이 쓰지 않는다.
- raw/held/unpromoted deep result를 prompt에 넣지 않는다.
- 승인 API에서 서버 revision 바이트를 직접 바꾸지 않는다.
- 저장 성공 전에 `applied`, Undo 저장 성공 전에 `undone`으로 표시하지 않는다.
- save 409를 자동 merge, force save, silent reload로 숨기지 않는다.
- quick-field 상태와 agent proposal 상태를 같은 JSONB에 합치지 않는다.

이 문서의 기본 제품 결정은 명시적 쪽/후보 선택, 비어 있지 않은 body paragraph-only v1, creator-private draft-lifetime 제안 보관, 적용 후 cursor/scroll 초기화 허용(Phase 0 UX gate 조건), 가장 최근 적용 건만 Undo다. 이 결정을 다시 열어야 하는 요구가 생기면 구현 도중 임의 변경하지 말고 계획을 개정한다.
