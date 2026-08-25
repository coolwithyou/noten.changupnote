# 공고 딥분석과 RHWP 작성 가이드 운영 가이드

> 기준일: 2026-08-25  
> 대상: 제품·운영·개발 담당자  
> 전환 정본: [`2026-08-25-kordoc-rhwp-목표구조-전환.md`](../plans/2026-08-25-kordoc-rhwp-목표구조-전환.md)

## 1. 현재 제품 구조

공고 분석과 신청서 편집은 서로 독립된 두 흐름이다.

| 흐름 | 입력 | 출력 | 모델 실행 시점 |
|---|---|---|---|
| 공고 딥분석 | 공고 본문, 첨부 텍스트, source revision | 22축 조건, 감사 결과, `authoring-guide-v1` | 승인된 딥분석 batch |
| RHWP 작성 | 보관 HWP/HWPX, draft revision, 회사 확인 정보 | 사용자가 승인할 문단·셀 제안과 새 revision | 사용자가 제안을 요청할 때 |

공고 딥분석은 지원서의 좌표나 입력 필드를 찾지 않는다. promotion은 검증된
`programIntent`와 criteria를 결정적으로 변환해 `grants.authoring_guide`에 저장한다. 이 변환에는
추가 모델 호출이 없다.

RHWP는 Kordoc 분석 상태를 기다리지 않는다. 편집 가능한 HWP/HWPX 원본이 있으면 원본을 열고,
현재 문단·셀·누름틀과 검증된 작성 가이드를 근거로 사용자 요청 시에만 LLM 제안을 만든다.
과거 `grant_document_fields`가 있으면 field-aware 보조로 사용하지만 Studio 진입 조건은 아니다.

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

## 4. 신규 Kordoc 실행 경계

2026-08-25 이후 신규 일반 경로는 다음 작업을 하지 않는다.

- deep processor의 application-precompute enqueue
- Cloud Run main worker의 application-precompute claim cycle
- workspace 진입 시 `field-analysis` 복구 요청
- 신규 launch의 `--with-kordoc` 또는 `--roundtrip-model`
- 신규 release의 `--require-kordoc`과 Kordoc materialization bundle 생성
- 관리자 화면의 Kordoc 큐·비용·readiness 판정

과거 DB 행, immutable receipt, release manifest와 parser는 감사·rollback 호환을 위해 보존한다.
과거 release에 이미 Kordoc evidence가 있으면 기존 verifier가 계속 읽을 수 있지만 새 release는 만들지 않는다.

## 5. 시간과 비용 해석

공고 한 건의 딥분석에서는 Kordoc 모델 호출·재판정·artifact materialization이 빠졌으므로 해당
부분의 대기 시간과 모델 비용은 구조적으로 0이 된다. `authoring-guide-v1`은 기존 딥분석 결과의
결정적 projection이어서 추가 토큰 비용이 없다.

과거 고정 30건 산출물의 Kordoc 호출량은 묶음 최적화 이후에도 보수적으로 151회로 계산됐다. 같은
분포라면 공고당 평균 약 5회의 모델 호출 fan-out이 분석 시점에서 사라지는 셈이다. 이는 호출 수
감소 근거이지 현재 모델 단가와 실제 wall-clock 절감률을 확정하는 벤치마크는 아니다.

다만 전체 체감 비용은 두 시점으로 분리해 측정한다.

- 분석 시점: 22축 primary, 감사, 필요 시 adjudication 비용
- 작성 시점: 사용자가 field/document/schedule 제안을 요청한 호출 비용

따라서 “공고 분석 한 건당 비용 감소”는 맞지만, “사용자 작성 세션까지 포함한 총비용이 항상 감소”는
실측 전에는 확정하지 않는다. 운영 지표는 deep run의 duration/cost와 사용자 요청형 생성 usage를
별도 시계열로 집계한다.

## 6. 운영 확인 항목

- 운영 Cloud Run main worker는 별도 승인 전 `DEEP_ANALYSIS_WORKER_MODE=observe_only`를 유지한다.
- 신규 launch prepare manifest의 `withApplicationRoundtrip`은 `false`여야 한다.
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
