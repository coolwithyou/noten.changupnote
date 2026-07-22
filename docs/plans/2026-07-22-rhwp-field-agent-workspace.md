# rhwp 필드 에이전트 워크스페이스 상세 구현 계획

> **상태: 구조 앵커 v3·문자 서식 계승 구현 완료 · 한컴 수동 개방 검증 대기 (2026-07-22)**
>
> 이 문서는 `/grants/[grantId]/workspace`를 **원본 HWP/HWPX 프리뷰 → 필드 선택 → 근거 기반 안내/대화 → 사용자 확인 → 원본 형식 내보내기**의 한 흐름으로 연결하는 실행 정본이다. 구현·검증·잔여 제한도 이 문서에 함께 갱신한다.

## 1. 목표와 성공 조건

사용자는 변환 이미지가 아닌 rhwp가 렌더링한 원본 문서를 보면서 입력 위치를 선택하고, 창업노트가 이미 가진 회사 정보와 공고 근거를 바탕으로 다음 세 가지 중 하나를 받는다.

1. 바로 확인할 수 있는 추천 값
2. 사용자가 답해야 할 1~2개의 구체 질문
3. 수치·단위·작성 범위 등 해당 칸의 작성 가이드

추천은 자동으로 문서에 반영하지 않는다. `suggested` 상태는 검토 화면에만 존재하며, 사용자가 `이 값으로 채우기` 또는 직접 수정을 확정한 뒤에만 `accepted|edited`가 되어 내보내기에 포함된다.

완료 조건은 다음과 같다.

- HWP/HWPX 원본을 회사·사용자 소유권 검증 뒤 브라우저로 전달한다.
- rhwp WASM은 작업공간에서 조건부 로드하고, 현재 페이지만 SVG로 렌더링한다.
- 기존 bbox 오버레이와 필드 카드가 같은 `selectedFieldId`를 공유한다.
- 필드 대화는 후속 턴에도 필드 문맥을 유지하고 `guidance | needs_input | proposal` 결과를 표현한다.
- 제안 값은 사용자 확인 전에는 내보내지 않는다.
- HWP는 rhwp 자기 재로드·페이지 수·바이트 길이 검증을 통과한 파일만 내려받는다.
- HWPX도 rhwp로 다시 열어 페이지 수를 비교하고, 실패하면 기존 서버 HWPX 내보내기로 안전하게 폴백한다.
- 파싱·내보내기 실패 시 기존 서버 페이지 이미지/기존 HWPX 다운로드를 유지한다.

## 2. 현재 상태와 변경 이유

이미 구현된 기반:

- 작업공간의 페이지 이미지, 정규화 bbox 오버레이, 필드 선택, 필드별 `suggested/accepted/edited/dismissed` 상태
- 프로필 시드와 사용자 확인 게이트, 동시 저장 충돌을 피하는 필드 단위 PATCH
- 공고 첨부 markdown을 이용한 Anthropic citations 채팅
- 필드 단위 LLM 제안과 근거 검증
- HWPX XML 기반 서버 내보내기
- rhwp 0.7.19 기반 개발 랩의 HWP/HWPX 파싱, 페이지 SVG, 셀 삽입, HWP 자기 검증, HWP/HWPX 내보내기

현재 결손:

- 실제 작업공간은 rhwp가 아니라 변환 서버의 페이지 이미지만 사용한다.
- 채팅의 `fieldContext`가 첫 턴 뒤 사라지고, 구조화된 제안/추가 질문을 UI에서 실행할 수 없다.
- HWP 다운로드는 기존 HWPX XML 채움 경로로 합류할 수 없으며, HWP 원본 보존 내보내기가 없다.
- 원본 파일을 실제 작업공간에 안전하게 전달하는 인증 API가 없다.

이 계획은 `docs/plans/2026-07-09-apply-experience-v2.md`의 ADR-1/P6을 **작업공간의 점진적 rhwp 우선 렌더링에 한해 갱신**한다. 당시 rhwp가 skeleton이었던 전제와 달리 현재 설치 버전은 페이지 렌더링·텍스트 검색·셀/폼 편집·HWP/HWPX 내보내기·HWP 자기 검증을 제공한다. 단 서버 이미지 폴백은 없애지 않는다.

## 3. 사용자 흐름

```text
작업공간 진입
  ├─ 원본 HWP/HWPX 인증 조회 성공
  │    └─ rhwp 파싱 → 현재 페이지 SVG + 같은 문서 구조에서 계산한 필드 앵커
  └─ 실패/미지원
       └─ 기존 서버 페이지 이미지 + 기존 필드 오버레이

프리뷰 필드 또는 우측 카드 선택
  └─ 같은 selectedFieldId로 양쪽 포커스 동기화
       ├─ 저장된 프로필/제안 표시
       └─ "이 항목 물어보기"
            └─ 공고 인용 답변 + 구조화 결과
                 ├─ guidance: 작성 기준 안내
                 ├─ needs_input: 답변할 질문 1~2개
                 └─ proposal: 추천 값 + 근거 + "이 값으로 채우기"

사용자 확인
  └─ 기존 field-answers PATCH → accepted|edited
       └─ rhwp EditPlan 적용
            ├─ HWP: exportHwpVerify → exportHwp
            └─ HWPX: exportHwpx → 재파싱/페이지 수 검증
```

## 4. 기술 설계

### 4.1 인증된 원본 파일 공급

`GET /api/web/document-drafts/[draftId]/source-file`을 추가한다.

- `requireCompanyAccess()`와 `getGrantDocumentDraft()`로 소유권을 검증한다.
- draft의 `sourceAttachment`를 grant source/sourceId와 `grant_attachment_archives`로 재해석한다.
- 클라이언트가 전달한 임의 R2 key는 받지 않는다.
- 매직바이트로 실제 `hwp|hwpx`를 판별하고 포맷·파일명을 응답 헤더로 제공한다.
- `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`를 사용한다.

### 4.2 rhwp 프리뷰와 필드 포커스

- dev 전용 `rhwp-client.ts`의 WASM 단일 초기화와 안전 내보내기를 공용 `lib/rhwp`로 이동한다.
- 작업공간 전용 프리뷰는 `draftId`가 있고 사다리 (a)/(b)인 경우에만 동적 import한다.
- 문서는 한 번 파싱하고 현재 페이지만 `renderPageSvg()`로 렌더링한다. 전체 페이지 선렌더링은 하지 않는다.
- DB의 기존 bbox는 반복 라벨을 구분하는 탐색 힌트로만 사용한다. rhwp 프리뷰 위에는 rhwp가 같은
  문서 인스턴스에서 계산한 표 셀·텍스트 선택 영역만 표시한다.
- `human_review` 등 근사 bbox는 rhwp 렌더링 위에 표시하지 않는다. 구조 앵커를 확정하지 못한 필드는
  카드에서는 유지하되 문서 오버레이는 숨겨 잘못된 위치를 확신 있게 보여주지 않는다.
- 프리뷰 페이지 수와 좌표계는 rhwp 문서가 소유한다. 변환 이미지의 페이지 수가 다르다는 이유만으로
  rhwp를 버리지 않으며, rhwp 자체 렌더링과 앵커가 항상 같은 좌표계를 사용하게 한다.
- 체크박스 필드는 셀 단위 앵커와 옵션 텍스트 선택 영역을 함께 계산한다. LLM은 의미 매핑만 도울 수
  있고 좌표를 생성하거나 보정하지 않는다.
- 자동 앵커가 맞지 않으면 사용자가 `문서에서 입력 위치 다시 지정`을 누르고 rhwp 표 셀을 직접
  선택할 수 있다. 이 보정은 현재 작업공간 세션에만 적용되며 프리뷰와 같은 회차의 원본 다운로드가
  동일한 구조 셀을 사용한다. 공용 필드 DB를 일반 사용자 입력으로 덮어쓰지 않는다.
- SVG 파싱/렌더 오류, 지원하지 않는 원본, 메모리 해제 실패는 UI를 깨뜨리지 않고 `PreviewCanvas`로 폴백한다.
- 컴포넌트 unmount와 문서 교체 때 `HwpDocument.free()`를 호출한다.

### 4.3 필드 대화 에이전트

기존 `/api/web/chat`을 유지한다. 일반 공고 채팅은 변경하지 않고 `draftId + fieldContext`가 검증된 턴에만 구조화 결과를 추가한다.

```ts
type FieldAssistOutcome =
  | { status: "guidance"; fieldId: string; label: string; guidance: string }
  | { status: "needs_input"; fieldId: string; label: string; guidance: string; questions: string[] }
  | {
      status: "proposal";
      fieldId: string;
      label: string;
      guidance: string;
        proposal: { value: string; basis: string; basisKind: "announcement" | "profile" | "user" };
    };
```

- 서버는 draft 소유권, grant 일치, `fieldId + label` 연결을 재검증한다.
- 1차 응답은 기존 citations 스트림을 그대로 사용한다.
- 2차 구조화 분석은 1차 답변과 검증된 필드 메타데이터만 정규화한다.
- 제안 근거가 실제 공고/프로필에 없거나 필드가 수동 작성·중복 라벨이면 `proposal`을 내리지 않는다.
- 사용자가 대화에서 직접 제공한 사실은 `basisKind=user`와 원문 부분 문자열 검증을 통과한 경우에만 제안 근거로 쓴다.
- 구조화 결과는 AI SDK persistent `data-fieldAssist` part로 보내고 JSONB 메시지에도 선택적으로 보존한다.
- 채팅은 활성 필드 문맥을 후속 질문에도 유지하며, Sheet를 닫거나 다른 필드를 고르면 명시적으로 전환한다.
- `proposal` CTA가 눌린 때만 기존 field-answer PATCH를 호출한다.

### 4.4 rhwp EditPlan과 안전한 내보내기

내보내기는 `accepted|edited`만 대상으로 순수 EditPlan을 만든 뒤 클라이언트의 같은 `HwpDocument`에 적용한다.

우선순위:

1. 이름 있는 필드/폼 컨트롤과 확정 가능한 앵커
2. 라벨 텍스트가 있는 표 셀의 같은 행 오른쪽 빈 셀
3. 근거가 불충분하면 건너뛰고 사용자에게 미채움 사유 표시

안전 불변식:

- 기존 내용이 있는 셀을 임의로 덮어쓰지 않는다.
- 정규화 라벨 충돌은 자동 반영하지 않는다.
- 체크박스/라디오의 옵션 앵커가 확정되지 않으면 텍스트로 위장해 입력하지 않는다.
- HWP는 `exportHwpVerify().recovered === true`, 페이지 수 동일, 검증 바이트 길이 동일일 때만 다운로드한다.
- HWPX는 export 결과를 새 `HwpDocument`로 다시 열고 페이지 수가 동일할 때만 다운로드한다.
- 실패한 필드는 성공한 필드와 함께 결과 요약에 표시한다.
- 폴백 HWPX 내보내기는 기존 서버 경로를 유지한다.

## 5. 구현 단계와 파일

### Phase A — 계약과 소스 파일 경계

- `lib/server/documents/draftSourceFile.ts`: grant/archive/R2 조회와 포맷 판별
- `api/web/document-drafts/[draftId]/source-file/route.ts`: 인증 응답
- `routePolicy.ts`: 세션 라우트 등재
- 단위/라우트 정책 테스트

수용 기준: 다른 회사 draft는 404, 임의 key 입력 없음, HWP/HWPX 외 형식은 415, 응답은 private/no-store.

### Phase B — rhwp 작업공간 프리뷰

- `lib/rhwp/client.ts`: WASM 단일 초기화, 검증 내보내기, 다운로드
- `features/document-viewer/RhwpPreviewCanvas.tsx`: 현재 페이지 SVG, 오버레이, 폴백 신호
- `WorkspaceView.tsx`: rhwp 우선/이미지 폴백 연결
- dev 랩 import를 공용 모듈로 전환

수용 기준: 필드 선택 양방향 동기화, 페이지 이동/줌 유지, 실패 시 기존 이미지 정상 표시, unmount 메모리 해제.

### Phase C — 필드 대화와 실행 가능한 제안

- `lib/chat/messageContent.ts`: typed field-assist 계약/검증
- `lib/server/chat/fieldAssist.ts`: 구조화 분석과 fail-closed 검증
- `app/api/web/chat/route.ts`: 필드 턴에만 custom data part 합성
- `ChatPanel.tsx`: 활성 필드 멀티턴, 안내/질문/제안 카드
- `WorkspaceView.tsx`: 제안 확인 콜백

수용 기준: 일반 채팅 회귀 없음, 필드 후속 질문 문맥 유지, 잘못된 data part 무시, 사용자 클릭 전 내보내기 미포함.

### Phase D — rhwp 내보내기

- `lib/rhwp/editPlan.ts`: label variants, EditPlan 실행, 미채움 사유
- `features/apply-workspace/RhwpDownloadButton.tsx`: 원본 로드·적용·검증·다운로드·결과 안내
- `FieldPanel.tsx` 또는 download 영역: 원본 형식 다운로드와 HWPX 폴백

수용 기준: HWP 자기 검증 실패 차단, HWPX 재파싱 실패 차단, accepted/edited만 반영, 사용자에게 skipped 필드 공개.

### Phase E — 회귀 검증과 운영 문서

- 순수 계약·EditPlan·컴포넌트 테스트
- route policy, chat grounding, field answers, apply workspace, web typecheck/build
- 실제 서버는 사용자가 해당 워크트리에서 실행한 뒤 브라우저 E2E를 최종 확인
- 이 문서 상태와 `docs/README.md` 링크 갱신

### Phase F — 구조 앵커 v2와 객관식 입력

- `lib/rhwp/fieldAnchors.ts`: 라벨 검색 → 표 구조 → 오른쪽 입력 셀/옵션 선택 영역을 하나의
  결정적 리졸버로 통합한다.
- `RhwpPageSurface.tsx`와 `PreviewCanvas.tsx`: rhwp 페이지 수·SVG·구조 앵커를 같은 문서
  인스턴스에서 공급하고 근사 bbox 출력은 중단한다.
- `editPlan.ts`: 프리뷰와 동일한 구조 앵커를 재사용해 텍스트·안내문·단위 셀·체크박스를 편집한다.
- `FieldCard.tsx`: 체크박스의 추출 옵션을 객관식 선택 UI로 제공한다.

수용 기준:

- 라벨 셀이 아니라 실제 입력 셀에 박스가 맞는다.
- 변환 이미지와 rhwp의 페이지 수가 달라도 rhwp 프리뷰와 앵커는 함께 정상 동작한다.
- `창업자 유형` 같은 체크박스는 사용자가 옵션을 고르고, 내려받은 문서에는 선택한 옵션만 표시된다.
- `(천원)` 같은 단위 텍스트는 보존하고 값은 그 앞에 입력한다.
- 파란 안내문처럼 source span으로 확인 가능한 템플릿 안내문만 교체하며, 기존 실제 값은 덮어쓰지 않는다.
- 구조 위치를 확정하지 못하면 근사 박스를 대신 표시하거나 그 위치에 저장하지 않는다.

### Phase G — 시각 자간 라벨과 입력 문자 서식

- `lib/rhwp/fieldAnchors.ts`: `성 명`, `성  명`처럼 문자 사이 공백으로 자간을 표현한 라벨을
  `getPageTextLayout()`의 셀별 run으로 정규화해 찾는다. DB 페이지 힌트가 있으면 해당 페이지만
  조회하고, 페이지 레이아웃은 문서 인스턴스당 한 번만 캐시한다.
- 구조 앵커는 입력 셀과 함께 왼쪽 라벨 셀 인덱스를 보관한다. 저장 시 대상 셀의 원래 글꼴,
  라벨의 본문색, 셀 높이·너비와 입력값 길이를 이용해 글자 크기를 계산한다.
- 안내문은 `trim()`된 길이가 아니라 실제 셀 문단 전체 길이로 삭제한다. source span으로 확인된
  안내문뿐 아니라 파란색·회색·이탤릭 문자 모양과 `기재 시`, `선택기입`, `작성 예시` 같은 강한
  안내 표현이 함께 있는 경우도 교체 대상으로 인정한다. 일반 기존 값은 계속 덮어쓰지 않는다.
- 한글 빈 셀에 남아 있는 단일 공백도 빈 값으로 취급하고 실제 입력값으로 교체한다.

수용 기준:

- `성명(대표자)`가 원문에서 `성 명(대표자)`로 저장돼 있어도 첫 장의 오른쪽 입력 셀에 정확히 매칭된다.
- 9pt 파란 이탤릭 안내문이 있던 전화번호 셀은 안내문 전체가 사라지고, 값만 11pt 검정 일반체로 남는다.
- HWPX 내보내기 후 새 `HwpDocument`로 재개방해도 값·글자 크기·페이지 수가 유지된다.

## 6. 검증 명령

```bash
pnpm build:packages
pnpm --filter web typecheck
pnpm test:rhwp-field-agent
pnpm test:chat-grounding
pnpm test:field-answers
pnpm test:apply-workspace
pnpm verify:route-policy
NEXT_DIST_DIR=.next-build pnpm --filter @cunote/web build
```

관련 스크립트가 패키지에 없으면 동일 범위의 Vitest 파일을 직접 실행하고, 최종 문서에 실제 명령을 기록한다.

## 7. 범위 밖과 후속 과제

- 양식 개체가 아닌 임의 도형 체크박스, 이미지 체크박스: 구조 텍스트/폼 컨트롤로 확인되지 않으면
  자동 선택하지 않는다.
- 자유 편집기 전체 통합: rhwp Studio는 별도 고급 편집 진입점으로 유지하며 이번 흐름은 필드 확인 중심이다.
- 서버에서 rhwp WASM을 실행하는 내보내기: 이번 슬라이스는 브라우저 자기 검증이며, 실제 문서 corpus가 쌓인 뒤 서버 이중 검증을 검토한다.
- PDF/PPTX 원본 편집: 파싱·가이드에는 합류할 수 있으나 원본 양식 편집은 별도 엔진이 필요하다.

## 8. 구현 기록

- 2026-07-22: 메인 작업트리 `7b26092`가 clean 상태임을 확인했다. 커밋할 미반영 변경은 없었다.
- 2026-07-22: Orca worktree `rhwp-field-agent-workspace`, branch `coolwithyou/rhwp-field-agent-workspace`를 생성하고 `.env`, `.env.local`, `.env.vercel.local`을 복사했다.
- 2026-07-22: draft 소유권 기반 원본 파일 API와 route policy를 추가했다. R2 key는 클라이언트에 노출하지 않으며 매직바이트가 HWP/HWPX가 아니면 차단한다.
- 2026-07-22: 작업공간 프리뷰에 rhwp 현재 페이지 SVG를 연결했다. SVG는 DOM 주입 대신 object URL 이미지로 격리한다. 초기 버전은 페이지 수 불일치도 이미지 폴백으로 취급했으나 구조 앵커 v2에서 이 조건을 제거했다.
- 2026-07-22: 필드 채팅의 문맥을 멀티턴으로 유지하고 `data-fieldAssist` 결과를 추가했다. 공고/프로필/사용자 직접 제공 정보의 근거 검증을 통과한 제안만 CTA로 표시하며 클릭 전에는 내보내기에 포함되지 않는다.
- 2026-07-22: rhwp EditPlan은 이름 있는 누름틀(안내문 포함)과 유일한 라벨 오른쪽 빈 셀을 지원한다. 기존 값·중복 위치·중복 라벨은 덮어쓰지 않고 미채움으로 보고한다.
- 2026-07-22: 원본 형식 HWP/HWPX 내보내기와 실제 산출물 재로드/페이지 수 검증을 연결했다. HWP는 `exportHwpVerify`도 함께 통과해야 하며 HWPX는 기존 서버 내보내기를 폴백으로 유지한다.
- 2026-07-22: 실문서 검증에서 기존 `human_review` bbox가 표의 입력 셀이 아니라 행 전체/인접 라벨을
  감싸고, 변환 프리뷰(11쪽)와 rhwp 레이아웃(환경에 따라 8쪽)의 페이지 수 차이 때문에 rhwp가 항상
  이미지로 폴백하는 근본 원인을 확인했다. Phase F는 이 두 좌표계를 혼합하지 않는 구조 앵커 v2다.
- 2026-07-22: 구조 앵커 v2를 구현했다. `searchAllText`의 셀 문맥과 `getTableCellBboxes`를 조합해
  라벨 오른쪽의 실제 입력 셀을 찾고, 기존 bbox는 반복 라벨의 페이지/거리 힌트로만 사용한다.
- 2026-07-22: 객관식 원문(`□`, `☐`, `동의( )`)을 선택 UI로 변환하고 정적 체크 glyph는 선택한
  항목만 `■`로 편집한다. 단위 전용 텍스트는 보존하고 값은 앞에 삽입하며, source span으로 검증된
  안내문만 삭제 후 교체한다.
- 2026-07-22: 프리뷰가 데스크톱/모바일 DOM에 이중 mount되어 문서와 WASM 메모리가 두 벌 생기던
  구조를 단일 반응형 노드로 합쳤다.
- 2026-07-22: 4020 실문서 브라우저에서 rhwp blob 이미지 1개, rhwp 페이지 `1 / 8`, 첫 페이지
  구조 오버레이 14개를 확인했다. `창업자 유형` 입력 셀은 `left 21.9856% / top 30.4855% /
  width 67.0908% / height 2.30735%`로 표의 실제 오른쪽 셀과 일치했고, 객관식 선택 및 사용자의
  직접 셀 보정 토스트까지 확인했다. DB 저장/파일 다운로드는 사용자 데이터 변경을 피하려 브라우저
  자동화에서 실행하지 않았다.
- 2026-07-22: 첫 장의 `성 명(대표자)`는 공백 없는 `성명(대표자)` 검색이 다른 페이지의 동명
  라벨만 찾던 누락 원인을 실문서에서 재현했다. 페이지 텍스트 run을 셀 단위로 합쳐 공백·기호를
  정규화하는 구조 앵커 v3로 대상 셀 `cellIdx=2`를 확정했다.
- 2026-07-22: `연락전화번호` 입력 셀은 선행 공백이 9pt 검정, 안내문이 9pt 파란 이탤릭으로
  분리돼 있었고, 기존 `trim()` 길이 삭제가 마지막 안내문자를 남기던 원인을 확인했다. 전체 15자를
  삭제한 뒤 셀 비례 11pt·검정·일반체를 적용하도록 수정했다.
- 2026-07-22: `/tmp/cheorwon-source.hwpx` 메모리 편집·HWPX 재직렬화·재개방으로 `김창업`과
  `010-1234-5678`이 각각 정확한 셀, 11pt 검정 일반체, 8페이지로 유지됨을 확인했다. 4020 브라우저의
  전체 목록에 `성명(대표자)` 오버레이가 생성되고 선택 시 표의 정확한 빈 셀이 강조되는 것도 확인했다.
- 자동 확인 완료: `build:packages`, web `typecheck`, `test:rhwp-field-agent`, `test:field-answers`,
  `test:chat-grounding`, `test:apply-workspace`, `verify:route-policy`, 격리 dist의 web production build.
- 잔여 수동 확인: 사용자가 실제 값을 확정해 내려받은 HWP/HWPX를 한컴오피스에서 열어 체크 표시,
  안내문 교체, 단위 보존과 무결성 경고 부재를 최종 확인한다.
