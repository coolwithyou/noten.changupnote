# 시연 준비: artifact-loss 역사 inventory 소비 검증

검증일: 2026-10-01. 변경 범위는 `deep-repair-preparation-history.ts`와 전용 회귀 테스트다. 현재 실행 admission, 모델 호출, 운영 DB, manifest/grant, 배포를 변경하지 않았다.

## 정책 근거와 exact 대상

추적 가능한 producer commit `e74de4102ebb5626ab8d50f3fe6c70bf3cc934de`의 `current-inventory-launch.ts`와 `current-inventory-launch-production.ts`가 `open-visible-current-period-artifact-loss-reanalysis-v1`을 발행하고 attestation/material 계약을 검증한다. 해당 producer는 matching-only 실행 경계를 포함하지만 이번 변경은 **역사 제외 집합 읽기만** 지원한다.

실제 inventory SHA: `d2a56ae14e61c658a5d9a7f25902a286d7a4e4da16a744bc9b57de000daa4421`. 파일 bytes SHA와 이름의 일치를 읽기 전용으로 확인했다. series는 `current-artifact-loss-20260925`이며 대상 3건은 다음과 같다.

| grantId | 현재 sequence | 과거 sequence |
| --- | ---: | ---: |
| `76069674-e762-456e-9c69-9c94e76eba1f` | 0 | 18 |
| `13892d8b-a06b-4717-aeda-da44772a786c` | 1 | 42 |
| `0189ee53-a0b4-48c2-a753-cdb2860dec3b` | 2 | 46 |

## 소비 계약

- 기존 정책은 기존 validator로 계속 검증한다. 알려지지 않은 policy는 거부한다.
- 알려진 artifact-loss 정책도 schema/series/date/model/전체 target sequence/중복/stratum/모든 SHA를 검증한다.
- 전체 target의 matching-material binding과 transcript-only attestation 4SHA, prior run/sequence, prior/current input·attachment·source 동일성을 확인한다.
- inventory 파일의 기존 content-address 검증과 전체 역사 제외 정책을 유지한다. 특정 파일이나 target을 생략하는 우회는 없다.
- 동일 fixture를 현재 `validateCurrentLaunchInventory`에 주면 여전히 거부됨을 테스트한다. 역사 기록의 소비가 신규 실행 권한이 되지 않는다.

## 검증 결과

다음 명령은 authoring-first에서 실행했다.

```sh
pnpm exec tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/analysis-lab/deep-repair-history-artifact-loss.test.ts
pnpm exec tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/analysis-lab/deep-repair-preparation.test.ts
pnpm --filter @cunote/web typecheck
git diff --check
```

전용 테스트 PASS: policy/series 변조, input·attachment·source drift, sequence·중복 grant/prior sequence, missing/invalid material, attestation 누락/불일치, 잘못된 prior run, 파일 bytes 변조를 거부한다. 기존 preparation suite PASS. web typecheck PASS.

실제 전체 history read-only scan은 main과 authoring-first의 `spike-out/analysis-lab` 양쪽에서 동일 결과다: `allHistoryCount=1008`, `recoveryTargets=3`, `allRecoveryTargetsExcluded=true`. formal-baseline 의미 보존은 전용 테스트로 확인했다.

확장 검사 `current-inventory-launch.test.ts`는 30개 중 28개 PASS, 아래 2개 FAIL이다. 변경한 history 파일만 HEAD 원본으로 잠시 바꿔 같은 명령을 실행했을 때도 동일한 28 PASS / 2 FAIL과 동일 오류가 재현됐다. `finally`에서 수정본 bytes를 복원하고 동일성을 확인했다. 따라서 이번 history 변경으로 새로 발생한 실패는 아니다. 실행 계약 관련 기존 실패는 별도 해결 범위로 남는다.

- `terminal-repair-source.test.ts:248`: matching20 terminal repair, `launch source/existing run 정책 결속이 잘못됐습니다.`
- `current-inventory-launch.test.ts:480`: application-only primary reuse, `application-only primary 재사용 run 계약이 다릅니다.`

이 기록은 history consumer 호환성의 검증이며 standard prepare, exact manifest 승인 또는 모델 실행 완료 증거가 아니다.
