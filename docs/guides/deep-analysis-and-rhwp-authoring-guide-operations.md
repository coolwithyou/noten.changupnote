# 공고 딥분석과 RHWP 작성 가이드 운영 가이드

> 기준일: 2026-08-26
> 대상: 제품·운영·개발 담당자  
> 전환 정본: [`2026-08-25-kordoc-rhwp-목표구조-전환.md`](../plans/2026-08-25-kordoc-rhwp-목표구조-전환.md)

## 1. 현재 제품 구조

공고 분석과 신청서 편집은 서로 독립된 두 흐름이다.

| 흐름 | 입력 | 출력 | 모델 실행 시점 |
|---|---|---|---|
| 공고 대량분석 | 공고 본문, 첨부 텍스트/HWP·HWPX, source revision | 22축 조건, `authoring-guide-v1`, 신청서 필드 map | 승인된 구독 launch batch |
| RHWP 작성 | 보관 HWP/HWPX, draft revision, 회사 확인 정보 | 사용자가 승인할 문단·셀 제안과 새 revision | 사용자가 제안을 요청할 때 |

운영 Cloud Run의 일반 딥분석은 지원서의 좌표나 입력 필드를 찾지 않는다. 반면 2026-08-28 이후
승인된 로컬 formal launch는 같은 exact target에서 신청서 필드 분석을 함께 실행한다. promotion은 검증된
`programIntent`와 criteria를 결정적으로 변환해 `grants.authoring_guide`에 저장한다. 이 변환에는
추가 모델 호출이 없다.

RHWP는 Kordoc 분석 상태를 기다리지 않는다. 편집 가능한 HWP/HWPX 원본이 있으면 원본을 열고,
현재 문단·셀·누름틀과 검증된 작성 가이드를 근거로 사용자 요청 시에만 LLM 제안을 만든다.
과거 `grant_document_fields`가 있으면 field-aware 보조로 사용하지만 Studio 진입 조건은 아니다.

사용자 작업공간은 RHWP와 우측 `AI 작성 가이드`를 하나의 화면으로 사용한다. 역사 필드 결속이
있으면 정확한 입력 칸 단위 제안을, 없으면 현재 쪽의 안전한 문단·셀 단위 제안을 제공한다.
관리자·가상기업 미리보기는 같은 화면 골격을 사용하지만 LLM 호출과 서버 저장은 수행하지 않는다.
구형 `빠른 작성 | 문서 직접 편집` 모드 전환은 사용자 작업공간 진입 경로에서 사용하지 않는다.

## 2. 전체 흐름

```text
공고 수집 -> 첨부 보관·텍스트화 -> 입력 봉인
  -> 22축 primary -> deterministic 검증 -> 독립 감사
  -> promotion plan -> criteria + authoring-guide-v1
  -> 매칭·공고 상세·작성 grounding

보관 HWP/HWPX -> draft/revision -> RHWP Studio
  -> 현재 선택/구조 target -> 사용자 제안 요청
  -> 공고 원문 + verified authoring guide + 회사 정보 + 현재 문맥
  -> 사용자 승인 -> exact apply -> 새 revision/Undo
```

## 3. 작성 가이드 발행과 검증

`authoring-guide-v1`은 사업 목적, 목표 지원자상, 평가 포인트, 혜택, 주의사항과 criteria 근거
체크리스트를 담는다. source run ID, input SHA, source revision SHA, attachment manifest SHA가 함께
저장된다.

서비스가 guide를 모델 입력으로 쓰기 전 다음을 다시 검증한다.

1. 최신 active/canary promotion item이 하나로 결정되는가.
2. release manifest, plan SHA, run ID가 item과 일치하는가.
3. 현재 source revision과 promotion snapshot hash가 발행 시점과 같은가.
4. guide의 run/input/source/attachment 결속이 release artifact와 일치하는가.

하나라도 다르면 guide만 제외하고 provenance에 이유를 남긴다. 공고 원문과 수동 RHWP 편집을
막지는 않는다. guide는 작성 방향을 위한 advisory이며 회사 실적·수치·고유명사의 사실 근거가 아니다.

## 4. 필드 분석 실행 경계

다음 일반 운영·사용자 진입 경로는 필드 분석 작업을 만들지 않는다.

- deep processor의 application-precompute enqueue
- Cloud Run main worker의 application-precompute claim cycle
- workspace 진입 시 `field-analysis` 복구 요청
- 사용자가 임의로 고르는 `--with-kordoc` 또는 `--roundtrip-model`
- 신규 release의 `--require-kordoc`과 Kordoc materialization bundle 생성
- 관리자 화면의 Kordoc 큐·비용·readiness 판정

과거 DB 행, immutable receipt, release manifest와 parser는 감사·rollback 호환을 위해 보존한다.
검증된 parser는 승인된 로컬 `lab:launch` 안에서 내부 신청서 필드 분석 adapter로만 사용한다.
formal manifest는 이 단계를 끌 수 없으며 모델·parser 버전을 함께 봉인한다. UI의 구형 빠른 작성
모드, workspace 복구 API, 운영 application queue는 되살리지 않는다.

## 5. 시간과 비용 해석

`authoring-guide-v1` 자체는 기존 딥분석 결과의 결정적 projection이어서 추가 토큰 비용이 없다.
다만 formal launch에 신청서 필드 분석이 다시 포함됐으므로, 2026-08-25의 “공고당 분석 시간·비용이
구조적으로 감소한다”는 평가는 더 이상 현재 목표 구조의 보장이 아니다.

과거 고정 30건 산출물의 Kordoc 호출량은 묶음 최적화 이후에도 보수적으로 151회로 계산됐다. 같은
분포라면 공고당 평균 약 5회의 모델 호출 fan-out이 분석 시점에서 사라지는 셈이다. 이는 호출 수
감소 근거이지 현재 모델 단가와 실제 wall-clock 절감률을 확정하는 벤치마크는 아니다.

다만 전체 체감 비용은 두 시점으로 분리해 측정한다.

- 분석 시점: 22축 primary, 감사, 필요 시 adjudication 비용
- 작성 시점: 사용자가 field/document/schedule 제안을 요청한 호출 비용

따라서 비용·시간은 22축 primary와 필드 sidecar가 겹쳐 실행되는 실제 launch receipt로 다시
측정해야 한다. 구독 모델이라 API 종량 비용은 피하지만 Max 사용량과 wall-clock은 증가할 수 있다.
운영 지표는 deep run duration, 필드 분석 duration/인식 필드 수, 사용자 요청형 생성 usage를
별도 시계열로 집계한다.

## 6. 운영 확인 항목

- 운영 Cloud Run main worker는 별도 승인 전 `DEEP_ANALYSIS_WORKER_MODE=observe_only`를 유지한다.
- 신규 formal launch prepare manifest의 `withApplicationRoundtrip`은 `true`이고,
  `roundtripModel=claude-opus-5` 및 현재 필드 분석 버전이 결속돼야 한다.
- 지원 양식이 있는데 `recognizedFieldCount=0`이면 해당 target은 `held`여야 한다.
- 현행 publishable 딥분석이라도 필드 준비도 없는 결과는 필드 포함 formal launch에서 자동 스킵하지 않는다.
- `kordoc-application-roundtrip-v9`은 표 셀·누름틀 외에 `라벨 : 빈칸`, 날짜 자리표시자,
  금액·인원 단위가 붙은 표 밖 단일 문단을 분석한다. 같은 원본을 RHWP core로 다시 열어 native
  문단 좌표가 하나이고 제어 개체·혼합 글자서식이 없는 경우만 작성 필드로 유지한다.
- 주소+전화번호, 업종+생산품명처럼 한 문단에 입력값이 둘 이상이거나 텍스트형 선택지, 임의 여백만
  있는 문단은 자동 필드로 승격하지 않는다. 이 범위는 별도 세부 좌표 계약 전까지 안전 제외한다.
- 신규 deep run 뒤 application-precompute job 수가 증가하지 않아야 한다.
- promotion 뒤 `grants.authoring_guide`가 release plan과 동일한 source binding을 가져야 한다.
- Kordoc 행이 없는 HWP/HWPX 공고도 workspace ladder B와 RHWP transport를 얻어야 한다.
- 실제 HWP/HWPX 브라우저 검증은 사용자 소유 개발 서버에서 별도 수행한다.

## 7. 배포 전 경계

현재 코드 변경만으로 운영 전환이 끝난 것은 아니다. 다음은 별도 승인과 증거가 필요하다.

1. `0077` migration 적용
2. exact commit push
3. web/admin 배포와 production alias 확인
4. Cloud Run 세 job 배포 시 runtime env·secret·`observe_only` 보존 확인
5. 실제 HWP/HWPX 열기·제안·승인·저장·다운로드·재개방·Undo UAT

이 중 실행하지 않은 항목은 `NOT RUN`으로 남긴다.

## 8. 주요 코드 위치

- guide 생성: `apps/web/src/lib/server/analysis-lab/authoring-guide.ts`
- promotion 저장·rollback: `promote.ts`, `promote-cli.ts`, `promotion-snapshot.ts`, `promotion-rollback.ts`
- verified grounding: `apps/web/src/lib/server/documents/documentAgentGrounding.ts`
- field/schedule 제안: `fieldSuggest.ts`, `scheduleSuggest.ts`
- workspace admission: `apps/web/src/lib/server/documents/workspaceData.ts`
- RHWP UI: `apps/web/src/features/apply-workspace/RhwpStudioSurface.tsx`
- 역사 운영 문서: `deep-analysis-and-application-precompute-operations.md`

## 9. 기존 분석 채택 절차

기존 분석을 폐기하거나 과거 런 파일에 source revision을 덧써서는 안 된다. 다음 명령은 현재
DB·R2와 로컬 런을 읽기만 하고, 모델 호출이나 DB 쓰기 없이 채택 가능성을 다시 계산한다.

```bash
# 출력만 확인
pnpm lab:authoring-guide:adopt -- --as-of=2026-08-25 --concurrency=4

# content-addressed local artifact로 봉인
pnpm lab:authoring-guide:adopt -- --as-of=2026-08-25 --concurrency=4 --prepare
```

2026-08-25 KST 봉인 결과:

- 현재 지원 가능 공고: 559건
- 명시적 publishable 역사 런: 86건
- `projection_ready`: 46건
- `review_required`: 1건
- `source_recovery_required`: 30건
- `rerun_required`: 9건
- source 봉인 차단: 32건(복구 전용 30건, 재분석 대상과 중첩 2건; blocker 55개)
- manifest SHA-256: `990dbdb84d84eb40ada4393eb3ced7d6fe017d6fc1e979e9c4f44d0af2d9aeb8`
- 로컬 경로: `spike-out/analysis-lab/authoring-guide-adoption/manifests/<sha256>.json`

86건 중 input/attachment가 현재와 같은 77건은 `46 + 1 + 30`으로 보존된다. 이 중 30건은
현행 운영 입력 봉인을 먼저 복구해야 하며, 복구 뒤 SHA가 유지되면 재분석 없이 다시 투영할 수
있다. source blocker는 `blocked_fetch` 38개와 `blocked_conversion` 17개다. 실제 드리프트 9건만
새 live 분석 후보이며, 이 중 source 차단과 겹친 2건도 복구가 먼저다. exact launch manifest
승인 전에는 모델을 실행하지 않는다.

manifest의 `authoringGuidePreview`는 전환 가능성을 검증하는 advisory preview다. 실제
`grants.authoring_guide` 저장은 기존 독립 검수, release gate, 별도 `lab:promote --write` 승인을
모두 통과해야 한다.

### 9.1 2026-08-26 재봉인

날짜가 바뀌면 지원 가능 모집단과 채택 대상은 반드시 새 SHA로 다시 봉인한다. 2026-08-26 KST
결과는 다음과 같다.

- 현재 지원 가능 공고: 538건
- 명시적 publishable 역사 런: 82건
- `projection_ready`: 46건
- `review_required`: 1건
- `source_recovery_required`: 28건
- `rerun_required`: 7건
- source 봉인 차단: 29건(복구 전용 28건, 재분석 대상과 중첩 1건; blocker 46개)
- blocker: `blocked_fetch` 29개, `blocked_conversion` 17개
- adoption manifest SHA-256: `d3022d30bb333a4e5978660b93d6edeb80f800f145b74f7c06fcd129ba118ecc`

### 9.2 adoption 전용 source recovery 준비

과거 frozen quality cohort 복구 명령은 해당 public/secret manifest와 receipt에 결속되어 있으므로
adoption 대상에 재사용하지 않는다. 다음 prepare 명령은 exact adoption SHA에서 자동 복구 가능한
`blocked_fetch|blocked_conversion`만 고르고 모델·DB·R2 쓰기 없이 새 매니페스트를 만든다.

```bash
pnpm lab:authoring-guide:recovery:prepare -- \
  --adoption-manifest=d3022d30bb333a4e5978660b93d6edeb80f800f145b74f7c06fcd129ba118ecc
```

봉인 결과:

- recovery manifest SHA-256: `1bdd5d2fb66dccd11c276efb8b4e67ea2f6ca8429dcd9281d68de9813a672aed`
- 대상: 29건(`bizinfo` 19, `kstartup` 10)
- 복구 후 재분류: 28건
- 복구 후 rerun manifest 준비: 1건
- R2·conversion server·shared secret 준비도: 모두 true
- 최대 3라운드, source별 라운드당 20건
- 외부 LLM 호출·분석 enqueue·DB 쓰기·R2 쓰기·live 실행 권한: 모두 false

이 매니페스트는 쓰기 권한이 아니다. exact SHA, 29건, 최대 3라운드, DB·R2 입력 복구만을
승인받은 뒤 별도 grant/execute 경로를 열고, receipt와 새 adoption manifest를 다시 봉인해야 한다.

승인 뒤에는 다음 두 명령을 분리해 사용한다. grant는 exact manifest·29건·3라운드 상한과
`no LLM/no analysis enqueue/no promotion`을 불변 원장으로 남기고, run은 현재 KST 기준일과
29건의 source/input/attachment/blocker SHA가 그대로인지 확인한 다음 하나의 DB runtime lease에서
실행한다.

```bash
pnpm lab:authoring-guide:recovery:grant -- \
  --manifest=1bdd5d2fb66dccd11c276efb8b4e67ea2f6ca8429dcd9281d68de9813a672aed \
  --approved-by=owner

pnpm lab:authoring-guide:recovery:run -- --grant=<grant-sha256>
```

재료 drift, 지원 가능 기준일 변경, runtime active lease, 중복 execution claim은 쓰기 전에
fail-closed한다. 실행 함수는 `enqueuePreparedJobs: false`를 고정하며 외부 image OCR adapter를
주입하지 않는다. 종료 시에는 target별 봉인 여부, 라운드 지표, 외부 LLM 0회, 분석 job 0건,
새 adoption manifest SHA를 하나의 immutable receipt에 결속한다. `lab:promote --write`는 이 범위에
포함되지 않는다.

### 9.3 2026-08-26 승인 실행 결과

사용자가 recovery manifest `1bdd5d2f...72aed`의 exact 29건, 최대 3라운드, DB/R2 source
복구와 receipt·재분류까지 승인했다. 실행 코드는 commit `7e9c94069d164229af3a8f9ed81e4e947afc0f24`로
원격 `main`에 반영한 뒤 다음 원장으로 실행했다.

- grant SHA-256: `3596dfc1e8b1100c78eb80e6f6266b83e85a665072ffc9c6685a2963a829a023`
- receipt SHA-256: `cb7b4861537949bcaa0d6910c9f91980efc70696e2cde2df375f21f094ac5898`
- 결과: `PARTIAL`, 29건 중 13건 봉인 회복, 16건 미해결
- 라운드별 회복: 11건 → 1건 → 1건
- 외부 LLM 호출 0회, deep/application 분석 job 생성 0건, promotion 0건
- 실행 뒤 runtime: `paused`, owner 없음, active deep/application lease 각각 0
- 새 adoption manifest SHA-256:
  `3b28bc14c8a67d471bcf76d2893272875787ca6bd05863ccd6cf8dd10bb60ff4`

재분류는 `projection_ready` 46건, `review_required` 1건, `rerun_required` 30건,
`source_recovery_required` 5건이다. recovery target 중 봉인된 13건은 새 첨부 재료 때문에 모두
rerun으로 이동했고, 미봉인 16건 중 11건도 일부 재료가 바뀌어 rerun과 source 차단을 함께 가진다.
따라서 현재 모델 재실행을 준비할 수 있는 것은 `rerun_required + sourceSealed` 19건뿐이다.
나머지 11건의 미봉인 rerun과 5건의 source recovery target은 모델 실행 대상이 아니다.

미해결 blocker 19개는 `blocked_fetch` 11개와 `blocked_conversion` 8개다. 읽기 전용 DB 점검상
fetch 11개는 이미지 원본 미보관 또는 빈 HWP 다운로드이며, conversion 8개는 다음으로 나뉜다.

- page image/PDF artifact는 있으나 로컬 OCR이 3라운드 모두 실패한 PDF 3개
- 변환 surface가 `failed|pending`이고 artifact가 없는 PDF 2개
- child 변환은 존재하지만 parent ZIP waiver가 완결되지 않은 ZIP 2개
- UTF-8 decode 실패 상태인 TXT 1개

동일 경로 반복을 자동 실행하지 않는다. 남은 16건은 새 prepare-only manifest
`3c423f11d6ba9f3b62bbb9781869f9fa063c26dbc0038771a10dc384930d7e14`로 재봉인했지만,
이는 새 쓰기 권한이 아니며 기존 grant의 3라운드 상한도 연장하지 않는다. conversion retry/ZIP
waiver/TXT decode와 영구 fetch 실패의 정책을 보정하고 exact material을 다시 준비한 뒤 새 승인을
받는다. 19건의 모델 재분석도 별도 exact launch manifest와 사용자 승인 전에는 시작하지 않는다.
