# deep-v23 30건 런칭 batch 신규 세션 핸드오프

- 작성일: 2026-08-18
- 실행 위치: `/Users/ffgg/noten.works/cunote` 현재 worktree. `spike-out`의 gitignored history가
  이 worktree에 있으므로 새 worktree를 만들지 않는다.
- 다음 목표: 과거 실험용 10+10 gate 없이 신규 `deep-v23` 30건 exact allowlist를 한 번 승인받아
  deep-primary와 Kordoc을 연속 실행하고, target별 immutable 결과와 launch receipt를 남긴다.
- 이 문서를 만든 세션에서는 모델 호출, launch manifest/grant 생성, DB runtime lease, release 승인,
  promotion write, 배포, Cloudflare 변경, 운영 worker mode 변경을 수행하지 않았다.
- 보호 대상: 사용자 소유 미추적
  `docs/research/2026-08-10-루프와-그래프-엔지니어링-접근.md`
  (`sha256=7a7fae388defe0d0e1f54eed0a3094bd6f7c60a17a1e4abf952bcc1ba2d5c4cd`).
  시작·종료에 SHA를 확인하고 수정·stage·commit하지 않는다.

## 1. 완료된 역사 범위

`deep-v22` seq 0~9 deep/Kordoc 실행은 종결됐다. Kordoc 적격 9건의 read-only release는
`deep-deep-v22-kordoc-eligible-9-r1-6f145f85`로 준비됐고, 현재 artifact는 다음 상태다.

- aggregate: `GO`, notice 9
- shadow: `PASS`
- dry-run: `PASS`
- manifest/aggregate/shadow/dry-run raw SHA:
  `3aa8c0bc...`, `d2190dbd...`, `a3d16367...`, `32d839a5...`
- `approval.json` 없음. `lab:promote --write` 미실행. 서비스 DB와 배포 상태 변경 없음.

이 release는 그대로 보존한다. 신규 30건 분석을 시작하기 위해 release approve나 서비스
materialization을 선행하지 않는다. 두 권한은 별도다.

### deep-v23 신규 모집단 층화 결정

2026-08-18 준비 시 모집 중 후보 566건을 전체 과거 이력 221개와 대조했고, 현재 겹치는 156개를
제외하면 410건이 남지만,
`bizinfo/thick` 26건과 `kstartup/thick` 7건은 모두 과거 이력에 포함되어 비중복 재고가 0건이었다.
과거 target을 다시 편입하지 않는다는 원칙을 유지하기 위해 사용자 승인 아래
`deep-repair-strata-v3`를 도입했다.

- 첫 15건 필수 층: `bizinfo/medium`, `bizinfo/thin`, `kstartup/medium`, `kstartup/thin`
- optional 층: 새 비중복 재고가 생긴 경우의 `bizinfo/thick`, `kstartup/thick`
- 역사 보존: v1의 6층, v2의 5층 필수 커버리지 의미는 변경하지 않는다.

## 2. 반복 지연을 제거한 현재 계약

신규 런칭 실행은 다음 네 단계다.

1. `deep-v23`의 신규 30건 inventory를 모델 무호출로 만든다.
2. 현재 input/attachment SHA와 실행 contract를 `analysis-launch-manifest-v1`으로 다시 봉인한다.
3. 사용자가 exact manifest 범위를 한 번 승인하면 `analysis-launch-grant-v1` 하나를 기록한다.
4. 같은 grant로 30건을 하나의 DB runtime lease 아래 실행하고
   `analysis-launch-receipt-v1`으로 종결한다.

제거한 반복 gate:

- sequence별 사용자 재승인과 15분 approval TTL
- 직전 receipt `CONTINUE`가 다음 target의 권한이 되는 순차 parent chain
- 10건 뒤 다시 멈추는 10+10 checkpoint
- unrelated git commit마다 cohort 재봉인
- target의 `held`, non-publishable, input/attachment drift, Kordoc partial/held, 개별 timeout·응답
  오류 때문에 전체 cohort를 중단하는 규칙
- precision·structured ratio·명목 비용을 다음 target admission으로 쓰는 규칙
- 추가 분석 전에 release approve/materialization을 요구하는 규칙
- 변경 없는 실행에서 target마다 gcloud 인증·Cloud Run generation을 반복 확인하는 규칙

유지한 공통 안전 kernel:

- 첫 target 전 `claude.ai/firstParty/max` 공통 preflight와 자식 API credential/provider 제거
- 시작 시 DB runtime `paused`, owner/expiry 없음, active deep/application lease 0 확인
- cohort 전체 exact-generation DB lease와 갱신 실패 abort
- exact manifest/grant content hash, target input/attachment SHA, model/prompt/validator/package runtime 결속
- generic `lab:batch` non-dry와 legacy live entrypoint 차단
- 서비스 DB write, release approve, `lab:promote --write`, 배포, 운영 worker 활성화의 별도 승인

## 3. 중단과 격리 기준

target 수준으로 기록하고 계속:

- `publishable`이 아닌 품질 결과와 `held`
- 현재 input/attachment SHA drift 또는 source unavailable
- Kordoc `partial`, `held`, `not_applicable`, 문서별 실패
- 개별 timeout, HTTP 오류, invalid response, 런 저장 전 target 오류

잔여 target 신규 착수를 중단:

- manifest/grant artifact 손상 또는 contract 불일치
- batch 시작 전 Max 인증 공통 preflight 실패
- DB runtime lease 충돌·상실 또는 프로세스 abort
- Max 사용량 window 소진

target drift가 발생해도 다른 후보로 자동 대체하지 않는다. 동일 material grant의 실패 target만 재시도할
때는 새 사용자 승인을 묻지 않는다. manifest target, model, Kordoc 포함 여부, 쓰기 상한이 바뀌면 새
manifest 범위다.

## 4. 신규 세션 실행 순서

1. `AGENTS.md`와 이 문서를 끝까지 읽고 보호 파일 SHA와 `git status --short`를 확인한다.
2. 현재 branch/HEAD에서 다음을 통과시킨다.

   ```bash
   pnpm verify:package-runtime-freshness
   pnpm lab:launch:test
   pnpm lab:batch-runner:test
   pnpm --filter @cunote/web typecheck
   ```

3. 모델 무호출 inventory와 launch manifest를 만든다.

   ```bash
   pnpm lab:experiment:prepare -- --series=deep-v23
   APPLICATION_ROUNDTRIP_EFFORT=medium \
     pnpm lab:launch:prepare -- \
       --series=deep-v23 --sequences=0-29 --concurrency=2 --with-kordoc
   ```

4. 출력된 `manifestSha256`, target 30건, `changedSinceInventory`, model/prompt/validator/package runtime,
   Kordoc 포함 여부와 concurrency를 보고한다. 이 exact manifest의 live 실행 승인이 없으면 여기서 멈춘다.
5. 사용자가 exact manifest 전체를 승인하면 승인 기록 actor로 cohort grant를 한 번 기록한다.

   ```bash
   pnpm lab:launch:grant -- \
     --manifest=<manifest-sha256> --approved-by=<actor>
   ```

6. 같은 cohort 안에서 target별 승인을 다시 묻지 말고 실행한다.

   ```bash
   APPLICATION_ROUNDTRIP_EFFORT=medium \
     pnpm lab:launch -- --grant=<grant-sha256>
   ```

7. target 오류는 위 격리 기준대로 계속 처리한다. 공통 중단 조건에서만 중단하고 receipt SHA, 종결/미착수
   target, lease 해제 상태를 보고한다.
8. 같은 grant의 실패 target을 재시도할 필요가 있으면 material binding을 먼저 확인한 뒤 다음만 쓴다.

   ```bash
   APPLICATION_ROUNDTRIP_EFFORT=medium \
     pnpm lab:launch -- --grant=<grant-sha256> --retry-errors
   ```

## 5. 신규 세션에서도 금지되는 범위

- 승인 전 `lab:launch` 실행 또는 임의 grant 생성
- manifest 밖 target 자동 편입·대체와 실행 중 concurrency/model/Kordoc lane 변경
- generic `lab:batch` non-dry, `lab:smoke`, `lab:agent --execute`
- 과거 deep-v22 receipt/attempt/release artifact 수정·삭제
- launch 결과를 이유로 자동 release approve 또는 `lab:promote --write`
- Vercel/GCP 배포, Cloudflare 변경, 운영 `observe_only` 해제
- 보호 파일 접근·수정·stage·commit

## 6. 구현·검증 정본

- 런칭 artifact/grant 계약: `launch-batch-artifacts.ts`
- cohort capability: `launch-batch-context.ts`
- runtime/target 격리 coordinator: `launch-batch-production.ts`
- CLI: `launch-batch-cli.ts`
- admission: `analysis-execution-admission.ts`
- 정책 정본: `AGENTS.md`, `docs/explainers/구독모델로-딥분석-돌리는-법.md`

이번 변경의 완료 검증은 `pnpm lab:launch:test`, `pnpm lab:batch-runner:test`,
`pnpm lab:experiment:test`, web typecheck/build, `git diff --check`, 보호 파일 SHA 재확인으로 한다.
