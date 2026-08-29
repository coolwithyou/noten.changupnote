# Kordoc 선분석에서 RHWP 실시간 작성 가이드로 전환

## 1. 목표

공고 수집·딥분석과 신청서 편집을 독립적으로 종결 가능한 두 흐름으로 분리한다.

1. 공고 분석은 신청 자격·평가 방향·제출 절차와 근거를 검증해 서비스용
   `authoring-guide-v1`을 발행한다.
2. 신청서 편집은 보관된 HWP/HWPX를 RHWP Studio에서 열고 현재 draft/revision 문맥에서
   문단·셀·누름틀을 편집한다.
3. LLM은 사용자가 요청한 시점에만 공고 작성 가이드, 회사의 확인된 정보, 현재 문서 문맥을
   사용해 문안을 제안한다.
4. LLM은 문서 좌표를 만들지 않는다. 적용 대상은 RHWP 구조와 서버가 재구성한 exact target,
   또는 사용자의 현재 선택으로 결정한다.
5. 과거 Kordoc 산출물과 immutable receipt는 감사·복구를 위해 보존한다. 2026-08-28부터 정식
   로컬 구독 대량분석은 검증된 구조 파서를 내부 필드 분석 adapter로 실행하되, 구형 빠른 작성
   UI나 workspace 진입 시 복구 작업은 되살리지 않는다.

> 2026-08-28 목표 보정: “딥분석과 필드 분석 완전 분리”보다 “앞으로의 정식 대량분석 결과는
> RHWP field-aware 작성에 바로 쓸 수 있어야 한다”를 우선한다. 따라서 `lab:launch` formal plan은
> 22축 딥분석과 신청서 필드 분석을 하나의 material manifest에 결속한다. 운영 Cloud Run worker와
> 사용자 진입 경로에서의 자동 분석은 계속 금지한다.

## 2. 비목표와 금지 경계

- 이 전환 작업에서 운영 딥분석 `observe_only`를 해제하지 않는다.
- live 모델 batch, `lab:promote --write`, 배포, Cloudflare 변경을 실행하지 않는다.
- 기존 Kordoc receipt, release manifest, DB 이력 테이블을 삭제하거나 다시 쓰지 않는다.
- RHWP target이 `missing|ambiguous|stale`이면 LLM 문안을 좌표에 강제 적용하지 않는다.
- 공고 분석이 없거나 stale이어도 RHWP의 기본 열기·수동 편집·저장·다운로드를 막지 않는다.
- RHWP 호환 문서가 없어도 공고 딥분석과 일반 작성 가이드가 실패한 것으로 간주하지 않는다.

## 3. 목표 구조

```text
공고 원본 + 첨부 manifest
  -> 22축 딥분석 + 독립 감사
  -> promotion plan
  -> authoring-guide-v1 + grant_criteria 발행
  -> 서비스 grounding

보관 HWP/HWPX
  -> draft/revision 생성
  -> RHWP Studio load
  -> 현재 문단/셀/누름틀 exact target
  -> 사용자 요청
  -> authoring-guide-v1 + 회사정보 + 현재 문서 문맥으로 LLM 제안
  -> 사용자 승인
  -> exact apply -> 새 revision -> exact Undo
```

### 3.1 공고 분석 모듈의 interface

입력:

- exact `grantId`, source revision SHA, attachment manifest SHA
- 검증된 22축 criteria와 axis assessment
- `programIntent`
- 공고 기본 정보와 제출서류·일정

출력:

- `authoring-guide-v1`
- 각 내용의 source run/revision provenance
- hard fact와 advisory guidance의 명시적 분리

`authoring-guide-v1`은 다음을 포함한다.

- 사업 목적 한 줄 요약
- 목표 지원자상
- 평가 포인트
- 지원 혜택 요약
- 주의사항
- 검증된 criteria에서 파생한 사실·증빙 체크리스트
- source run ID, source input SHA, source revision SHA, attachment manifest SHA

평가 포인트와 조언은 advisory이고 매칭 hard condition이 아니다. 지원 조건의 사실 근거는
검증된 `grant_criteria`와 source span만 사용한다.

### 3.2 RHWP 작성 모듈의 interface

입력:

- persistent draft ID와 exact head revision
- 현재 HWP/HWPX bytes와 semantic manifest
- 사용자가 요청한 현재 문단·셀·누름틀
- 현재 공고의 fresh `authoring-guide-v1`
- 확인된 회사 프로필과 이번 턴 사용자 사실

출력:

- 최대 2개의 근거 포함 문안 제안
- exact target binding과 before hash
- 사용자 승인 전 mutation 0회
- 승인 후 descendant revision 1건
- 동일 target의 exact inverse Undo

## 4. 전환 단계

### Phase 0 — 계약과 기준선

- 본 문서를 전환 정본으로 등록한다.
- 신규 Kordoc 생성자와 모든 소비자를 분류한다.
  - production deep worker enqueue
  - application-precompute worker/backfill
  - workspace recovery API
  - ladder A admission과 `connectedFields`
  - release `--require-kordoc`와 materialization
  - ops 관제 및 사용자 카피
- 기존 자동 테스트를 기준선으로 통과시킨다.

수용 조건:

- 신규 흐름과 역사 호환 흐름의 파일·DB·CLI 범위가 구분된다.
- 기존 receipt 삭제가 계획에 포함되지 않는다.

### Phase 1 — verified authoring guide 발행

- 공용 contracts에 `GrantAuthoringGuideV1`을 추가한다.
- `planGrantPromotion()`이 LabRun에서 guide를 결정적으로 만든다.
- `grants.authoring_guide` JSONB에 현재 guide를 저장한다.
- promotion snapshot/hash/rollback에 guide를 포함한다.
- source revision이 달라지거나 promotion snapshot이 drift하면 grounding에서 guide를 사용하지 않는다.

수용 조건:

- 동일 LabRun은 byte-stable guide를 만든다.
- program intent가 없으면 `null` 또는 검증된 criteria-only guide로 정직하게 종결한다.
- release plan hash, before/after hash, rollback이 guide 변경을 포함한다.

### Phase 2 — 운영·사용자 진입 기반 Kordoc 실행 차단

- production deep processor에서 Kordoc enqueue를 제거한다.
- Cloud Run main worker에서 application-precompute cycle을 제거한다.
- 사용자 `field-analysis` 복구 호출을 제거한다.
- application-precompute worker/backfill CLI를 신규 운영 명령에서 제거한다.
- 과거 artifact 검증 코드는 `legacy` 경로로만 남긴다.
- 예외적으로 승인된 로컬 구독 `lab:launch`는 같은 exact target의 신청서 필드 분석 sidecar를
  필수 실행한다. 이는 사용자 화면의 이미지 기반 빠른 작성 기능이 아니라 RHWP 위치 map 생성이다.

수용 조건:

- 신규 공고 딥분석 한 건이 application-precompute job을 생성하지 않는다.
- 운영 worker 딥분석 성공/실패 receipt에는 신규 application-precompute outcome이 없다.
- formal launch receipt에는 필드 분석 상태와 지원 문서 수·준비 문서 수·인식 필드 수가 있다.
- 운영 worker 실행이 application-precompute heartbeat·claim·비용 ledger를 쓰지 않는다.

### Phase 3 — RHWP workspace admission 전환

- ladder 의미를 고정한다.
  - `a`: 역사 `connectedFields`를 가진 field-aware 호환 화면
  - `b`: RHWP direct document editing + 문단/선택 기반 작성 가이드
  - `c`: RHWP 비지원 문서의 채팅·텍스트 fallback
- HWP/HWPX 원본과 persistent draft가 있으면 Kordoc 상태와 무관하게 Studio를 열 수 있게 한다.
- `applicationPrecomputeStatus`와 `fieldAnalysisRecoveryNeeded`를 신규 workspace interface에서 제거한다.
- 역사 `connectedFields`는 있으면 사용할 수 있지만 Studio admission의 필수값이 아니다.

수용 조건:

- Kordoc row가 0건이어도 HWP/HWPX draft가 Studio에서 열린다.
- field-less 문서에서 일반 document agent가 활성화된다.
- `connectedFields`가 존재하는 과거 draft는 기존 exact field apply/Undo가 회귀하지 않는다.

### Phase 4 — 작성 가이드 grounding 연결

- field suggestion, document agent, schedule suggestion이 공통
  `loadVerifiedAuthoringGuide()` seam을 사용한다.
- 공고 원문·프로필 로드는 기존 병렬 로딩을 유지한다.
- 클라이언트에는 실제 사용하는 guide 필드만 직렬화한다.
- 안내 문구는 hard eligibility와 advisory writing guidance를 구분한다.

수용 조건:

- 세 agent의 prompt binding hash에 guide hash가 포함된다.
- stale guide는 모델 입력에서 제외되고 provenance에 사유가 남는다.
- 근거 없는 회사 실적·수치·고유명사 생성 금지 규칙이 유지된다.

### Phase 5 — 활성 Kordoc 표면 정리

- 관리자 화면에서 신규 Kordoc queue·비용·빠른 작성 readiness를 제거한다.
- 일반 운영 가이드를 RHWP/authoring guide 기준으로 갱신한다.
- 사용자 선택형 `--with-kordoc` 옵션은 제거하되 formal launch manifest는 필드 분석을 항상 결속한다.
- 역사 release verifier와 immutable artifact reader는 호환용으로 보존한다.
- 활성 import와 소비자가 0임을 확인한 뒤 `kordoc` 패키지를 제거한다.

수용 조건:

- `rg` 기준 production import, 사용자 route, worker script가 0건이다.
- 남은 `Kordoc` 문자열은 역사 문서·legacy verifier·migration 이름뿐이다.
- 기존 역사 artifact fixture가 계속 검증된다.

### Phase 6 — 기존 분석의 RHWP 작성 가이드 채택

- 현재 지원 가능 모집단과 명시적 `publishable` 역사 런을 다시 결속한다.
- 과거 런 파일은 수정하지 않고 run/input/attachment/current source revision SHA를 새 불변
  `authoring-guide-adoption-manifest-v1`에 봉인한다.
- 분류는 다음 네 상태로 종결한다.
  - `projection_ready`: 현재 원문과 일치하고 검증된 criteria/source span이 있어 guide preview를
    결정적으로 만들 수 있다.
  - `review_required`: 원문은 일치하지만 criteria 근거가 비어 있거나 투영 검수가 필요하다.
  - `source_recovery_required`: 원문 해시는 일치하지만 현행 운영 입력 봉인이 불완전하다.
  - `rerun_required`: input 또는 attachment manifest가 바뀌었거나 program intent가 없다.
- manifest의 guide는 `advisoryPreviewOnly=true`이며 기존 독립 검수와 release admission을
  대체하지 않는다. manifest 생성은 모델 호출·DB 쓰기·promotion 권한을 모두 0으로 고정한다.

수용 조건:

- 구형 `error=null` 호환 런을 명시적 publishable 런으로 승격하지 않는다.
- source recovery 대상은 복구 전에 모델 재분석을 시작하지 않는다.
- rerun 대상은 exact 새 launch manifest와 사용자 승인 전 모델을 호출하지 않는다.
- 기존 run/receipt/release artifact는 수정·삭제하지 않는다.

## 5. DB 변경 원칙

- `grants.authoring_guide`는 nullable JSONB로 추가한다.
- guide 내부 `schemaVersion`과 provenance를 필수로 하며, 공고 목록 query용 index는 만들지 않는다.
- 발행·rollback은 기존 per-grant advisory lock과 짧은 transaction 안에서 수행한다.
- 기존 `grant_application_precompute_*` 테이블은 이번 전환에서 drop하지 않는다.
- migration은 `pnpm db:generate`로 생성하고 SQL에 authoring guide column 외 unrelated DDL이
  섞이면 중단한다. `db:push`를 사용하지 않는다.

## 6. 검증 계획

최소 자동 검증:

```bash
pnpm test:document-agent
pnpm test:apply-workspace
pnpm verify:deep-analysis-contract
pnpm lab:release:test
pnpm typecheck
pnpm build:web
pnpm --filter @cunote/admin build
git diff --check
```

추가 회귀:

- Kordoc enqueue 0회 테스트
- Kordoc 상태 없는 HWP/HWPX workspace가 ladder B와 Studio transport를 얻는 테스트
- guide 생성·hash·promotion·rollback 테스트
- field/document/schedule agent prompt에 fresh guide가 들어가고 stale guide가 제외되는 테스트
- 역사 `connectedFields` field-aware apply/Undo 테스트

## 7. 브라우저·운영 STOP 조건

자동 검증 이후에도 아래는 별도 상태다.

- 실행 중인 사용자 소유 서버가 없으면 브라우저 검증은 `BLOCKED`로 남긴다.
- 실제 HWP와 HWPX 각각 열기·제안·승인·저장·다운로드·재개방·Undo가 PASS여야 UI GO다.
- 운영 migration, Vercel 배포, Cloud Run 배포, `observe_only` 해제는 이 구현 승인에 포함하지 않는다.
- 배포 전 exact commit, migration 적용 상태, feature flag, production alias와 live smoke를 별도로 확인한다.

## 8. 완료 정의

코드 전환 완료는 다음을 모두 만족할 때만 선언한다.

1. 운영 신규 공고 딥분석은 Kordoc job을 만들지 않고, 승인된 로컬 formal launch만 필드 분석을 함께 수행한다.
2. Kordoc 결과 없이 RHWP workspace가 열린다.
3. 검증된 authoring guide가 실제 세 agent grounding에 사용된다.
4. 과거 Kordoc 산출물은 수정·삭제 없이 호환된다.
5. 관련 자동 gate가 같은 SHA에서 통과한다.
6. 브라우저·migration·배포 상태는 실제 수행 여부에 맞게 `PASS|NOT RUN|BLOCKED`로 구분된다.

## 9. 구현 진행 상태 (2026-08-25)

- [x] `GrantAuthoringGuideV1` 계약과 결정적 생성기
- [x] promotion plan·snapshot·hash·저장·rollback 연결
- [x] nullable JSONB migration `0077` 생성 및 단일 DDL 확인
- [x] production deep processor와 worker의 신규 Kordoc enqueue/claim 제거
- [x] 사용자 선택형 launch/release Kordoc option·bundle 생성 차단
- [x] 2026-08-28 formal launch에 구독 기반 필드 분석과 준비도 receipt 결속
- [x] workspace Kordoc status/recovery API 제거와 RHWP ladder B 전환
- [x] document/field/schedule agent의 verified guide grounding 연결
- [x] 관리자 Kordoc queue·비용·readiness 활성 표면 제거
- [x] 전체 자동 gate와 web/admin production build 검증
- [x] 기존 publishable 분석의 read-only RHWP guide 채택 분류기와 immutable manifest
- [x] 2026-08-25 현행 86건 분류: 투영 가능 46, 검수 1, source 복구 30, 재분석 9
- [x] 2026-08-26 현행 재봉인: 지원 가능 538, publishable 82, 투영 46, 검수 1, source 복구 28, 재분석 7
- [x] adoption 전용 source-recovery prepare 모듈과 exact 매니페스트 생성
- [ ] 역사 receipt·관리자 데이터 호환 read model과 Kordoc 구현 파일의 물리 삭제 — 보존 기간·데이터 폐기 승인 뒤 별도 수행
- [ ] 8월 26일 source 봉인 차단 29건(복구 전용 28 + 재분석과 중첩 1) exact write 승인·복구·재검증
- [ ] 8월 26일 드리프트 7건 exact launch manifest 준비·승인·live 재분석
- [ ] 투영 결과의 기존 독립 검수·release gate 처리와 `lab:promote --write` 별도 승인
- [ ] 운영 DB migration 적용 — 별도 승인 필요
- [ ] 실제 HWP/HWPX 브라우저 UAT — 실행 중인 사용자 서버 필요
- [ ] 배포·Cloud Run 상태 확인 — 별도 승인 필요

## 10. 사용자 작업공간 통합 보정 (2026-08-28)

### 발견된 문제

- `document-editor-ai-agent`와 RHWP 가이드 전환 커밋은 `main`에 포함돼 있었지만 사용자 화면의
  단일 구조는 `ladder=a && persistent`에만 연결돼 있었다.
- 신규 Kordoc 생성을 중단한 뒤 연결 필드가 없는 정상 RHWP 문서는 `ladder=b`가 되므로,
  `빠른 작성 | 문서 직접 편집` 구형 이중 모드로 다시 내려갔다.
- `adminPreview=1`은 의도적으로 `local_preview` transport와 AI 비활성 상태를 사용하므로 같은
  조건에서 우측 작성 가이드가 렌더되지 않았다.
- 따라서 브랜치 통합 여부와 사용자 진입 구조가 서로 다른 상태였다. 조상 커밋 확인만으로는
  목표 UI 통합을 증명할 수 없었다.

### 통합 결과

- HWP/HWPX transport가 있으면 필드 결속 유무와 관계없이 RHWP를 즉시 열며, 구형 작성 방식
  토글이나 페이지 이미지 기반 입력 화면을 거치지 않는다.
- 역사 `connectedFields`가 있는 persistent draft는 RHWP와 field-aware `AI 작성 가이드` 레일을
  함께 사용한다.
- 연결 필드가 없는 persistent draft는 RHWP와 문단·셀 기반 document `AI 작성 가이드` 레일을
  함께 사용한다.
- 관리자·가상기업 미리보기도 같은 RHWP+우측 레일 골격을 사용한다. 다만 LLM 호출과 서버 저장은
  열지 않고, 탭 로컬 반영과 편집본 다운로드만 제공한다.
- RHWP transport 자체가 없는 비지원 문서만 채팅 fallback을 사용한다. a/b 데이터인데 transport가
  없으면 별도 입력 UI로 강등하지 않고 연결 오류를 명시한다.
- `WorkspaceView`는 더 이상 `FieldPanel`, `PreviewCanvas`, quick/studio 모드 토글을 import하거나
  렌더링하지 않는다.

### 자동 수용 조건

- ladder a persistent: RHWP + field-aware 작성 가이드 동시 렌더
- ladder b persistent: RHWP + document 작성 가이드 동시 렌더
- admin/virtual preview: 동일 레이아웃 + LLM 비실행 고지 + 빠른 작성 카피 0건
- RHWP transport 누락: 페이지 이미지 입력 화면으로 회귀하지 않음
- 모바일: 동일 작성 가이드를 Sheet로 제공

## 11. 대량분석 필드 준비도 보정 (2026-08-28)

### 실행 계약

- formal `analysis-launch-manifest-v1`은 `withApplicationRoundtrip=true`,
  `roundtripModel=claude-opus-5`, 현재 `applicationFieldAnalysisVersion`을 반드시 봉인한다.
- 해당 세 값 중 하나라도 없거나 현재 코드 계약과 다르면 실행 전 fail-closed한다.
- 기존 현행 딥분석이 publishable이어도 필드 준비도 집계가 없으면 formal launch의 `skip_existing`
  대상으로 보지 않고 다시 실행한다. 필드 준비도까지 통과한 현행 결과만 스킵한다.
- 필드 분석은 primary와 같은 `claude-cli` 구독 실행 capability 안에서 target-local sidecar로
  실행한다. 개별 필드 분석 실패는 다음 target을 막지 않고 그 target만 `held`로 종결한다.
- HWP/HWPX 지원 양식이 실제로 없는 공고는 `not_applicable`로 정상 종결할 수 있다.
- 지원 양식이 발견됐는데 안전하게 확정한 필드가 0개이면 primary가 publishable이어도 launch
  target은 publishable로 승격하지 않는다.

### RHWP 소비 계약

- 필드 산출물이 있으면 persistent draft뿐 아니라 `admin_preview|virtual_preview`도 RHWP native
  selection event로 현재 셀·필드를 우측 레일에 연결한다.
- preview에서 필드 인식은 동작하지만 LLM 호출과 서버 저장은 계속 비활성이다. 저장 동작은
  `이 탭에 반영`으로 표시하고 새로고침 시 초기화한다.
- 필드 산출물이 없는 과거 분석은 임의 좌표를 추정하지 않고 ladder B로 남긴다. 해당 공고를
  field-aware로 만들려면 현재 계약으로 새 exact manifest를 준비·승인해 재분석해야 한다.
- 단, 관리자 로컬 preview에서는 같은 공고의 역사 필드 산출물이 있고 현재 보관 원본 SHA-256과
  정확히 일치하면 모델 재호출 없이 해당 불변 산출물을 호환 read model로 사용할 수 있다.
- 서비스 DB의 `grant_document_fields` 영속화는 기존 release/promotion write 승인 경계 밖에서
  자동 수행하지 않는다. 로컬 immutable field artifact와 운영 materialization을 구분한다.

### 필드 완결성 보정 (v8)

- `kordoc-application-roundtrip-v8`은 KorDoc label-value 추출이 놓치는 병합 표의 오른쪽 끝 라벨과
  `/` 같은 값 placeholder를 RHWP 구조 후보로 보강한다. 선택지·서명문·조례 본문은 후보에서 제외한다.
- `kordoc-application-roundtrip-v9`은 표 밖에서도 한 문단에 입력값이 하나뿐인 명시적 양식만
  `paragraph_text`로 추가한다. Kordoc의 prefix/value/suffix·occurrence를 봉인하고 같은 원본을
  RHWP core로 다시 열어 들여쓰기·시각 자간을 허용한 native 좌표가 하나인지 확인한다.
- native 위치가 없거나 중복되고, 제어 개체 또는 혼합 글자서식과 겹치는 후보는 대량분석에서
  `recommendedInput=false`로 안전 제외한다. 주소+전화번호·업종+생산품명처럼 한 문단의 복수
  입력값과 텍스트형 선택지는 이번 범위에 포함하지 않는다.
- LLM이 다듬은 `displayLabel`은 UI에만 쓰고, 원문 검색은 별도 `anchorLabel`과
  `blockIndex/row/col/occurrence/normalizedLabel`을 사용한다.
- `recommendedInputFieldCount`와 `anchorReadyInputCount`가 다르거나 `anchorUnreadyInputCount`가 0이
  아니면 target은 `review_required/held`다. 일부 필드만 보이는 상태를 formal 완료로 승격하지 않는다.
- v7 불변 산출물은 현재 원본 SHA가 같은 관리자 로컬 preview에서만 호환 투영한다. v8 재사용·release
  근거로 승격하지 않는다. 이 preview는 모델 호출 없이 현행 parser의 고신호 구조 후보만 겹쳐 읽어
  값 셀 안내문 앵커를 원문 라벨로 교체하지만, 역사 artifact 자체는 수정하지 않는다.
- `helperText`는 전체 분석 근거를 클라이언트에 넘기지 않고 짧은 `guidance`로 직렬화해, LLM이 꺼진
  관리자 미리보기에서도 선택 필드의 `작성 기준`을 보여준다.
