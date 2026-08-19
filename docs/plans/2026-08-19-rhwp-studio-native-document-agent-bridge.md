# RHWP Studio native document-agent command bridge 선행 계획

> **제품 방향 연결(2026-08-19):** 이 문서는 native command/revision 기반 기술의 역사와 계약을
> 보존한다. 사용자-facing 제품 방향은
> [`2026-08-19-field-aware-document-editor-agent.md`](./2026-08-19-field-aware-document-editor-agent.md)가
> 우선한다. body paragraph command는 향후 보조 `문장 다듬기`에 사용하고, 주 흐름은 exact field
> navigation/selection/apply command로 확장한다.

- 작성일: 2026-08-19
- 상위 계획: `docs/plans/2026-08-18-document-editor-ai-agent.md`
- 기준 브랜치: `codex/document-editor-ai-agent`
- 상태: upstream bridge·Cunote adapter·compatible Studio 배포·실제 문서 제품 gate 완료.
  upstream merge/package publish 대기 중에는 exact source commit `c02f422c`의 `0.8.5` tarball을
  SHA-256으로 검증해 Cunote에 임시 vendoring한다.
- 범위: Studio/@rhwp/editor 공개 command bridge 설계와 재개 gate를 확정한다. Cunote의 DB, API,
  모델 호출, 사용자 노출 UI, 배포와 feature flag enable은 이 문서 범위가 아니다.

## 0. 실행 상태 (2026-08-19)

- RHWP upstream에 public method 5개, strict DTO/capability/event, snapshot apply/revert, command journal,
  HWP/HWPX browser e2e를 구현했다. Studio 983개 테스트 중 982 pass·1 skip, SDK 32개 테스트,
  production build와 package dry-run이 통과했다.
- Cunote에 `studioDocumentAgentProtocol.ts`, `StudioCommandDocumentAgentTransaction`, Studio command와
  byte-for-byte 같은 format/adjacent evidence projection을 구현했다. 기존 core/reload adapter는 서버
  candidate authority와 독립 검증용으로만 유지한다.
- `/dev/document-agent-phase0`는 초기 1회 load 뒤 native apply/export/focus/revert/event를 검사하도록
  전환했다. command 중 `loadFile()` 호출은 0회다.
- `pnpm test:document-agent`, web typecheck, `pnpm build:web`이 통과했다.
- self-hosted Studio는 `changupnote-rhwp-studio.vercel.app`에 compatible build로 배포했고, 실제
  HWP/HWPX에서 native apply/revert, target focus, 직접 입력, 수동 저장, 다운로드를 통과했다.
- Cunote DB/API/UI는 상위 계획에서 feature flag 기본 off로 구현·검증했다. upstream PR merge와
  package publish가 끝나기 전까지 production도 동일한 packed `0.8.5` artifact를 사용하도록
  `apps/web/vendor`에 provenance를 고정한다.

## 1. 결론

`export -> @rhwp/core patch -> editor.loadFile()` 어댑터는 제품 경로로 진행하지 않는다.

core 단독 HWP/HWPX apply/export/reopen/Undo는 통과했지만, 실제 Studio 재적재는 이미 사용자가
처리한 문서 확인창을 다시 열고 `loadFile()` 응답을 멈춘다. 이 동작은 AI 적용과 Undo마다 사용자에게
문서 전체를 다시 여는 경험을 만들고, 저장 mutex를 해제할 수 없게 한다. 서버 검증을 client-only로
낮추거나 확인창을 DOM 조작으로 닫지 않는다.

선행 과제는 **이미 열린 Studio의 in-memory 문서에 exact 단일 문단 command를 실행하고, 같은
Studio transaction에서 검증·렌더·focus·revert까지 끝내는 공개 versioned bridge**다. Cunote는 이
bridge를 `DocumentAgentTransaction` seam의 두 번째 adapter로 사용한다. capability가 없으면 문서
agent는 계속 off다.

## 2. Phase 0 STOP 증거

### 2.1 통과한 범위

- `pnpm test:document-agent`: HWP/HWPX deterministic fixture의 후보 추출, apply, export/reopen,
  target 밖 편집 보존 Undo와 Studio load/reload 순서 테스트 통과
- `pnpm test:rhwp-field-agent`: 기존 quick-field resolver 회귀 통과
- `pnpm typecheck`: root/web/admin 타입 검사 통과
- `pnpm build:web`: Next.js 16.2.9 production build 통과
- 생성된 `.next/**/*.nft.json`에서 `rhwp_bg.wasm` trace 확인
- Node singleton loader가 HWP/HWPX fixture를 모두 열고 재개방하는 smoke 통과
- 실제 문서 후보 scan은 HWP 21.3ms, HWPX 46.6ms로 2초 상한 이내

이 증거는 core transaction과 build packaging 가능성을 증명한다. Studio 사용자 흐름, 제품 저장,
production 배포 준비를 증명하지 않는다.

### 2.2 실패한 실제 Studio 범위

로컬 사용자가 실행한 `127.0.0.1:4010`의 `/dev/document-agent-phase0`에서 저장·모델 호출 없이
다음을 확인했다.

1. HWP 실문서 최초 load에서 `로컬 글꼴 감지`를 처리해 ready가 됐다.
2. apply 후 같은 editor에 patched bytes를 `loadFile()`하자 `로컬 글꼴 감지`가 다시 나타났다.
3. HWPX 실문서 최초 load에서 `HWPX 비표준 감지 -> 그대로 보기`를 처리해 ready가 됐다.
4. apply 후 같은 editor에 patched bytes를 `loadFile()`하자 `HWPX 비표준 감지`가 다시 나타났다.
5. 두 경우 모두 host의 `loadFile()` Promise가 확인창에서 대기해 자동 apply/re-export/Undo를 끝내지
   못했다.

이는 상위 계획의 `reload 시 권한/글꼴 modal이 반복되지 않음` GO 조건을 직접 위반한다. HWPX
자동 보정이나 강제 폴백을 대신 선택하는 것은 원문 의미·레이아웃 보존 결정을 바꾸므로 해결책으로
간주하지 않는다.

## 3. 제품 불변식

1. AI 적용과 Undo는 열린 문서에서 동작하며 `loadFile()`을 호출하지 않는다.
2. host가 private `_request`를 호출하거나 SDK type cast로 숨은 method를 쓰지 않는다.
3. mutation은 capability handshake를 통과한 공개 SDK method로만 실행한다.
4. command는 body paragraph 1개, 전체 문단 치환, 4,000자 이하로 제한한다.
5. 전체 문서 SHA, target before/style/context, document epoch/change sequence가 exact하지 않으면
   mutation 0회다.
6. fuzzy search, 첫 문자열 선택, 좌표 기반 추정, selection 자동 승인은 금지한다.
7. Studio 내부 apply와 revert는 각각 한 transaction이며 중간 render 상태를 host에 노출하지 않는다.
8. apply 후 비대상 semantic manifest와 page count가 달라지면 Studio가 즉시 rollback한다.
9. revert는 해당 Studio 세션에서 가장 최근 성공한 agent command가 현재 exact after 상태일 때만
   허용한다.
10. Studio command Undo와 Cunote revision Undo를 구분한다. Studio의 revert 뒤에도 Cunote는 새
    descendant `studio_agent_undo` revision을 저장한다.
11. command bridge는 사용자의 일반 Studio undo stack과 충돌하지 않아야 한다. 일반 편집이 agent
    command 뒤에 발생하면 자동 revert를 거부한다.
12. bridge capability가 없거나 contract version이 다르면 기능을 숨기고 API도 계속 404로 닫는다.

## 4. deep module과 seam

앱이 아는 interface는 기존 `DocumentAgentTransaction` 하나로 유지한다.

```ts
interface DocumentAgentTransaction {
  extractCandidates(
    bytes: Uint8Array,
    format: "hwp" | "hwpx",
    page: number,
  ): Promise<DocumentEditCandidate[]>;
  apply(input: ExactEditCommand): Promise<VerifiedEditResult>;
  undo(input: ExactUndoCommand): Promise<VerifiedEditResult>;
}
```

adapter는 실제로 두 개가 된다.

- `CoreReloadDocumentAgentTransaction`: 현재 Phase 0 검증용. 제품에서는 사용하지 않는다.
- `StudioCommandDocumentAgentTransaction`: 새 공개 SDK command를 쓰는 제품 adapter.

UI, hook, snapshot service는 어느 adapter가 Studio transaction, semantic manifest, focus와 receipt를
만드는지 알지 않는다. capability 선택·오류 정규화·command receipt 검증은 adapter 안에 둔다.

## 5. 공개 SDK interface

`@rhwp/editor`에 다음 method와 DTO를 정식 export한다. 이름만 추가하고 private transport를 얇게
노출하지 않는다. 각 method는 capability 검사, strict response decoding과 error normalization을
포함한다.

```ts
type RhwpBodyParagraphTargetV1 = {
  kind: "body_paragraph";
  section: number;
  paragraph: number;
  charOffset: 0;
  length: number;
};

type RhwpDocumentStateV1 = {
  schemaVersion: 1;
  format: "hwp" | "hwpx";
  documentEpoch: number;
  changeSeq: number;
  dirty: boolean;
  pageCount: number;
  documentSha256: string;
};

type RhwpSelectionContextV1 = {
  schemaVersion: 1;
  documentEpoch: number;
  changeSeq: number;
  page: number; // 1-based host UI value
  editable: boolean;
  collapsed: boolean;
  target: RhwpBodyParagraphTargetV1 | null;
  selectedTextSha256: string | null;
};

type RhwpApplyTextCommandV1 = {
  schemaVersion: 1;
  commandId: string;
  expectedDocumentEpoch: number;
  expectedChangeSeq: number;
  expectedDocumentSha256: string;
  target: RhwpBodyParagraphTargetV1;
  expectedBeforeSha256: string;
  expectedFormatSha256: string;
  expectedAdjacentContextSha256: string;
  replacement: string;
};

type RhwpRevertTextCommandV1 = {
  schemaVersion: 1;
  commandId: string;
  expectedDocumentEpoch: number;
  expectedChangeSeq: number;
  expectedAfterDocumentSha256: string;
  expectedAfterSha256: string;
};

type RhwpTextCommandReceiptV1 = {
  schemaVersion: 1;
  commandId: string;
  operation: "apply" | "revert";
  documentEpoch: number;
  beforeChangeSeq: number;
  afterChangeSeq: number;
  beforeDocumentSha256: string;
  afterDocumentSha256: string;
  beforeTextSha256: string;
  afterTextSha256: string;
  formatSha256: string;
  adjacentContextSha256: string;
  pageCountBefore: number;
  pageCountAfter: number;
  target: RhwpBodyParagraphTargetV1;
};

editor.getDocumentState(): Promise<RhwpDocumentStateV1>;
editor.getSelectionContext(): Promise<RhwpSelectionContextV1>;
editor.applyTextCommand(command: RhwpApplyTextCommandV1): Promise<RhwpTextCommandReceiptV1>;
editor.revertTextCommand(command: RhwpRevertTextCommandV1): Promise<RhwpTextCommandReceiptV1>;
editor.focusTarget(target: RhwpBodyParagraphTargetV1): Promise<{ focused: boolean; page: number }>;
```

`getSelectionContext()`는 향후 selection 기반 UX와 진단을 위한 공개 capability다. Cunote v1의 target
권위값으로 사용하지 않는다. v1 사용자는 계속 쪽과 서버 재구축 가능한 후보를 명시적으로 고른다.

## 6. Studio 내부 command 계약

### 6.1 apply

Studio는 한 event-loop transaction 안에서 다음을 수행한다.

1. 현재 document epoch/change sequence와 전체 문서 SHA를 command expectation과 비교한다.
2. target 구조 좌표, paragraph length, before hash, uniform char/paragraph/style hash와 adjacent context
   hash를 다시 계산한다.
3. snapshot을 만들고 batch를 시작한다.
4. `replaceText` 후 기존 `charShapeId`, `paraShapeId`를 새 전체 range에 복원한다.
5. target text/format과 비대상 semantic manifest, page count를 검증한다.
6. 검증 실패 시 batch 종료, snapshot restore/discard 후 render와 change event 0회로 끝낸다.
7. 성공 시 snapshot을 command journal의 latest reversible entry로 보존하고 render를 한 번 commit한다.
8. `changeSeq`를 정확히 1 증가시키고 strict receipt와 `documentChanged(reason="agent_apply")`를
   반환한다.

전체 document SHA 계산과 semantic manifest 구축이 3초 interaction 상한을 넘으면 command를 시작하지
않고 `COMMAND_TOO_SLOW`로 fail-closed한다. worker로 옮기더라도 in-memory document와 final commit은
같은 epoch/version fence를 사용한다.

### 6.2 revert

1. command journal의 최신 reversible entry가 같은 `commandId`인지 확인한다.
2. 현재 epoch/change sequence, 전체 document SHA, target after hash가 receipt와 exact인지 확인한다.
3. 일반 편집이나 다른 command가 뒤에 있으면 `COMMAND_NOT_LATEST`로 mutation 0회다.
4. 보존 snapshot 또는 검증된 inverse patch를 한 batch에서 적용한다.
5. before target/format, target 밖 현재 편집, page count와 manifest를 검증한다.
6. 성공 시 새 `changeSeq`를 만들고 journal entry를 terminal `reverted`로 바꾼다.

snapshot이 target 밖 후속 편집을 덮어쓰는 구조라면 revert 구현에 snapshot restore를 사용하지 않는다.
그 경우 exact inverse patch를 쓰되 최신 command 이후 변경 0회 조건을 유지한다.

### 6.3 focus

`focusTarget()`은 구조 좌표로 현재 paragraph를 선택하고 해당 쪽을 viewport 중앙에 둔다. command
성공과 focus 성공은 분리한다. focus 실패가 이미 검증된 document mutation을 rollback하거나 receipt를
바꾸지 않으며, Cunote는 위치 텍스트를 계속 표시한다.

## 7. MessageChannel protocol

기존 protocol version 1 envelope와 session/origin 검증을 유지하고 handshake capability를 추가한다.

```text
document-state-v1
selection-context-v1
document-agent-command-v1
target-navigation-v1
document-change-events-v1
```

- `applyTextCommand`와 `revertTextCommand`는 `document-agent-command-v1` 없이는 request 자체를
  보내지 않는다.
- legacy `window.postMessage` fallback에서는 read/export만 허용하고 mutation capability는 false다.
- method allowlist는 Studio와 SDK 양쪽에 정적으로 둔다. 임의 method name dispatch를 열지 않는다.
- request/response는 exact `version + sessionId + id`를 요구하고 extra key/unsafe integer/non-finite
  number를 거절한다.
- document content, before/after text와 profile 근거는 event에 싣지 않는다. command ID, epoch/seq,
  timing, failure code만 관측한다.
- 늦은 response/event는 document epoch와 change sequence가 다르면 버린다.
- command ID replay는 같은 current receipt state면 같은 receipt를 반환하고, binding이 다르면
  `COMMAND_REPLAY_MISMATCH`다.

## 8. 오류 contract

SDK는 Studio 오류를 다음 allowlist로 정규화한다.

```text
CAPABILITY_UNSUPPORTED
INVALID_COMMAND
DOCUMENT_EPOCH_MISMATCH
CHANGE_SEQ_MISMATCH
DOCUMENT_SHA_MISMATCH
TARGET_NOT_FOUND
TARGET_PREIMAGE_MISMATCH
TARGET_FORMAT_MISMATCH
TARGET_CONTEXT_MISMATCH
PAGE_COUNT_CHANGED
NON_TARGET_CHANGED
COMMAND_NOT_LATEST
COMMAND_REPLAY_MISMATCH
COMMAND_TOO_SLOW
TRANSACTION_FAILED
RENDER_FAILED
```

모든 mismatch는 mutation 0회다. `TRANSACTION_FAILED|RENDER_FAILED`는 snapshot 복구까지 성공한 경우와
복구 자체가 실패한 fatal case를 구분하는 `recovered: boolean`을 SDK Error에 포함한다. fatal이면
Cunote iframe 잠금을 유지하고 현재 문서 다운로드와 server head 재로드만 제공한다.

## 9. 구현 저장소와 변경 단위

이 bridge의 권위 구현은 Cunote 저장소가 아니라 self-hosted RHWP Studio와 `@rhwp/editor` package다.
정확한 upstream checkout/배포 프로젝트를 먼저 식별한 뒤 별도 작업 범위에서 다음 순서로 구현한다.

1. Studio core adapter: exact validator, semantic manifest, apply/revert transaction, command journal
2. Studio host protocol: method allowlist, capability handshake, documentChanged event
3. `@rhwp/editor`: public types/methods, strict DTO decoder, capability guard, transport tests
4. upstream browser e2e: HWP/HWPX 실제 문서, modal 0회, cursor/focus, native typing, normal Ctrl+Z
5. package release와 self-hosted Studio compatible deployment

배포는 별도 외부 변경이다. package publish와 `changupnote-rhwp-studio` 배포는 정확한 source commit,
artifact와 rollback target을 확인한 별도 사용자 승인 뒤에만 수행한다.

## 10. Cunote 재개 작업

compatible Studio와 SDK가 준비된 뒤에만 상위 계획을 다음처럼 재개한다.

1. `@rhwp/editor` exact version을 lockfile에 고정한다.
2. `studioDocumentAgentProtocol.ts`에서 capability와 receipt decoder를 구현한다.
3. `StudioCommandDocumentAgentTransaction` adapter를 추가한다.
4. Phase 0 browser harness를 core/reload가 아니라 native apply/revert 경로로 바꾼다.
5. HWP/HWPX 실제 문서에서 apply 뒤 modal 0회, target focus, 직접 입력, 수동 저장, 빠른 작성 복귀,
   download와 Undo를 다시 검증한다.
6. bridge GO receipt를 남긴 뒤에만 상위 계획 Phase 1 persistence/schema를 시작한다.

현재 `CoreReloadDocumentAgentTransaction`과 Node core loader 테스트는 서버 candidate authority와 독립
검증에 재사용할 수 있다. 제품 apply/Undo에 연결하지 않는다.

## 11. 테스트 전략

### 11.1 upstream module/interface

- capability handshake와 legacy mutation 차단
- invalid origin/session/version/extra key 거절
- selection body/cell/control/none strict DTO
- exact body paragraph apply, mixed format/control/field 거절
- stale epoch/changeSeq/document/before/format/context 각각 mutation 0회
- page count 및 non-target semantic 변화 rollback
- apply command replay same binding idempotent, different binding conflict
- latest command exact revert, 일반 편집 뒤 revert conflict
- apply/revert마다 changeSeq +1과 event 1회
- render 실패 복구와 fatal recovery 분리
- focus 성공/실패가 mutation receipt와 독립

### 11.2 Cunote adapter

- capability 없으면 버튼/API/DB write 0회
- 승인 전 command 0회
- per-card apply가 public SDK method 1회만 호출
- private `_request` 접근 없음
- receipt와 export된 bytes SHA/manifest 불일치에서 snapshot save 0회
- apply/Undo snapshot CAS 409에서 server head 재로드 전 잠금 유지
- 기존 quick-field, manual save, autosave와 download 회귀

### 11.3 실제 문서 browser gate

HWP와 HWPX 각각 최소 1개의 실제 신청서에서 다음을 모두 만족해야 한다.

- 초기 문서 확인 후 apply/revert 동안 추가 modal 0회
- 안전 후보 1개 이상, 위치 설명과 focus가 구별 가능
- apply + render 3초 이내
- target text/format exact, page count 동일
- target 밖 semantic manifest 동일
- apply 뒤 Studio 직접 입력 가능
- 수동 저장, 빠른 작성 복귀, 재진입, download 정상
- apply 직후 exact revert가 target만 before로 복원
- apply 뒤 일반 편집이 있으면 agent revert를 거부하고, 일반 undo stack으로 사용자 편집과 agent
  transaction을 순서대로 되돌릴 수 있음

브라우저 gate가 통과해도 한컴에서의 물리적 문서 호환이나 production readiness를 자동으로 증명하지
않는다. 릴리즈 전 대표 실제 문서군과 한컴 수동 열기 검증을 별도로 수행한다.

## 12. 재개 GO/STOP

### GO

- public SDK 다섯 method와 capability가 exact package version에 존재
- self-hosted Studio가 같은 protocol contract를 광고
- upstream protocol/unit/e2e와 Cunote adapter tests 통과
- 실제 HWP/HWPX browser gate에서 반복 modal 0회
- apply/revert, 직접 입력, 저장, quick 복귀, download가 모두 정상
- feature flag 기본 off와 unsupported capability 404 유지

### STOP

- command가 private transport 또는 DOM automation을 요구함
- Studio in-memory transaction이 non-target/page count를 보존하지 못함
- command journal이 사용자 일반 undo/typing과 정확히 fence되지 않음
- 실제 문서 apply/revert 중 확인창 또는 full reload가 필요함
- package/Studio protocol version이 독립적으로 drift할 수 있는데 fail-closed 검사가 없음

STOP이면 Cunote는 자동 문서 반영을 제공하지 않는다. 제안 문안을 복사하는 read-only fallback만 별도
제품 결정으로 검토하며, 상위 계획의 DB/API/UI를 부분 구현해 숨겨 두지 않는다.
