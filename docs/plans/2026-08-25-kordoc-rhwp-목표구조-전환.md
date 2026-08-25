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
5. 과거 Kordoc 산출물과 immutable receipt는 감사·복구를 위해 보존하되 신규 공고 분석,
   신규 workspace admission, 신규 release에는 사용하지 않는다.

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

### Phase 2 — 신규 Kordoc 실행 차단

- production deep processor에서 Kordoc enqueue를 제거한다.
- Cloud Run main worker에서 application-precompute cycle을 제거한다.
- 사용자 `field-analysis` 복구 호출을 제거한다.
- application-precompute worker/backfill CLI를 신규 운영 명령에서 제거한다.
- 과거 artifact 검증 코드는 `legacy` 경로로만 남긴다.

수용 조건:

- 신규 공고 딥분석 한 건이 application-precompute job을 생성하지 않는다.
- 딥분석 성공/실패 receipt에 신규 Kordoc outcome이 없다.
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
- 신규 release prepare 기본값과 launch manifest에서 Kordoc 결속을 제거한다.
- 역사 release verifier와 immutable artifact reader는 호환용으로 보존한다.
- 활성 import와 소비자가 0임을 확인한 뒤 `kordoc` 패키지를 제거한다.

수용 조건:

- `rg` 기준 production import, 사용자 route, worker script가 0건이다.
- 남은 `Kordoc` 문자열은 역사 문서·legacy verifier·migration 이름뿐이다.
- 기존 역사 artifact fixture가 계속 검증된다.

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

1. 신규 공고 딥분석이 Kordoc job을 만들지 않는다.
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
- [x] 신규 launch/release Kordoc option·bundle 생성 차단
- [x] workspace Kordoc status/recovery API 제거와 RHWP ladder B 전환
- [x] document/field/schedule agent의 verified guide grounding 연결
- [x] 관리자 Kordoc queue·비용·readiness 활성 표면 제거
- [x] 전체 자동 gate와 web/admin production build 검증
- [ ] 역사 receipt·관리자 데이터 호환 read model과 Kordoc 구현 파일의 물리 삭제 — 보존 기간·데이터 폐기 승인 뒤 별도 수행
- [ ] 운영 DB migration 적용 — 별도 승인 필요
- [ ] 실제 HWP/HWPX 브라우저 UAT — 실행 중인 사용자 서버 필요
- [ ] 배포·Cloud Run 상태 확인 — 별도 승인 필요
