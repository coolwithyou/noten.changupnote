# deep-v20 순차 대량 분석 핸드오프

- 작성일: 2026-08-15
- 목적: 신규 세션이 추가 구조 구현 없이 `deep-v20`의 exact-next 순차 실행을 이어간다.
- 현재 판정: 기반 검증 완료, **sequence 1 이후는 새 exact 범위 승인 전 NO-GO**
- 실행 위치: 이 checkout의 동일 worktree. `spike-out`의 gitignored artifact가 필요하므로 새 Git worktree로 옮기지 않는다.

## 1. 지금까지 확정된 사실

API 자격증명 상속을 제거하고 `claude auth status --json`의
`claude.ai/firstParty/max`를 첫 모델 요청 전에 강제하는 코드가 다음 커밋에 들어 있다.

- `199795f` 구독 실행 전 Max 인증을 검증하다
- `e5c5b64` 대량 재개용 deep-v20 실험을 열다
- `c6230fe` 소진된 표본층이 대량 준비를 막지 않게 하다

모델 없이 exact 30건을 준비한 artifact는 다음과 같다.

| 항목 | 값 |
|---|---|
| proposal | `1730eb0a9c3b8cb8c3133cf41ff1a0e454cf1808ed0f84ca458ad06cedde5689` |
| plan semantic SHA | `58bb96e8316c592dd4435f7880ea4c6d0451b867fb644c2479435557e291b60d` |
| plan raw SHA | `8f60ebbfda47421988bc5d76a66a22daf808b11a02c9c7194481231ac6c99727` |
| manifest | `696c5db36a93d1a3677fef9cea1bd3ef90a444b14420b264b1a5eb5daabfd2e8` |
| policy | `deep-repair-strata-v2`, `repair-sprt-v1`, Nmax 30 |
| lane | deep-primary only; Kordoc/review/audit/promotion 미포함 |

sequence 0은 사용자 exact 승인으로 실제 실행했다.

| 항목 | 값 |
|---|---|
| grantId | `2ea9e35e-0b11-48e5-a907-5bb808bdb66a` |
| approval | `c2ccef1cd1589a9414ed84c335d319a84113a8897428dfa88f9a482144657d6b` |
| authority | `40552f1788c2b08ab4235bed52cc86041bbe1194a99cc6b50cf5986acc72972a` |
| terminal receipt | `10bad473cf270964b26915f1512b69e4469b8985b33c334434c1615a13fa8cc0` |
| run artifact SHA | `e9c0ad11c0fee97147e8fce0861c04071d460bb271a4b8c57f76409cb7282e33` |
| 결과 | `publishable`, `matchingReadiness=conditional`, repair 1회, repair 후 신규 issue 0 |
| gate | `CONTINUE`, `observedCount=1`, `nextAction=awaiting_user_authority` |
| 실행 시간 | 2026-08-15 19:32:08~19:42:48 KST |

실행 종료 뒤 Anthropic Console을 19:43 KST에 확인했다. 최신 API 요청은 여전히 2시간 전이어서
이번 canary의 신규 API 요청은 0건이다. LabRun의 `costUsd=1.6555905`는 API 가격 환산 telemetry이며
실제 API 청구 증거가 아니다. 종료 뒤 runtime은 `paused`, generation 123, local owner/expiry null,
active deep/application lease 모두 0이었다.

## 2. 신규 세션의 첫 행동

코드를 더 작성하거나 proposal을 다시 준비하지 않는다. 다음 순서만 수행한다.

1. `AGENTS.md`와 이 문서를 읽는다.
2. `git status --short`에서 사용자 소유 미추적 문서
   `docs/research/2026-08-10-루프와-그래프-엔지니어링-접근.md`를 건드리지 않는다.
3. 위 proposal, plan, sequence-0 receipt 파일이 실제로 존재하고 SHA가 일치하는지 읽기 전용 확인한다.
4. 사용자에게 아래 exact 범위 승인 문구를 제시하고 명시적 답변을 기다린다.

```text
proposal 1730eb0a9c3b8cb8c3133cf41ff1a0e454cf1808ed0f84ca458ad06cedde5689와
plan 58bb96e8316c592dd4435f7880ea4c6d0451b867fb644c2479435557e291b60d로,
receipt 10bad473cf270964b26915f1512b69e4469b8985b33c334434c1615a13fa8cc0을
첫 parent로 하여 deep-v20 sequence 1~9 최대 9건의 deep-primary 순차 실행을 승인합니다.
각 실행은 직전 terminal receipt를 parent로 사용하고 claude-opus-5/claude-cli Max만 사용합니다.
Max preflight 실패, API fallback, window exhaustion, non-CONTINUE, 상태 불명 또는 runtime 복구 필요 시
즉시 중단하며 Kordoc·검수·감사·promotion은 실행하지 않습니다.
```

이 문구와 동등한 exact 승인이 없으면 `lab:experiment:issue`를 호출하지 않는다.

## 3. 승인 뒤 실행 계약

한 번에 여러 모델 프로세스를 시작하지 않는다. sequence마다 아래 vertical slice를 끝낸 뒤 다음으로 간다.

1. proposal에서 현재 sequence의 `grantId`, `waveId`, input/attachment SHA를 읽는다.
2. 사용자 승인 범위와 직전 terminal receipt에 결속한
   `deep-repair-user-approval-v1` artifact를 15분 이하 TTL로 작성한다.
3. raw bytes SHA와 파일명을 대조한다.
4. `pnpm lab:experiment:issue -- --approval=<approval-sha256>`로 authority 하나를 발급한다.
5. `pnpm lab:experiment -- --authority=<authority-sha256>`로 exact target 한 건만 실행한다.
6. `kind=recorded`, `lifecycle=finished`, receipt parent/plan/target 결속을 확인한다.
7. `gateVerdict=CONTINUE`일 때만 다음 sequence의 새 approval/authority로 넘어간다.

다음 중 하나면 그 자리에서 멈추고 artifact와 runtime만 조사한다.

- Max 인증 preflight 실패
- API fallback 또는 Anthropic Console 신규 API 요청
- `[CLAUDE_CLI_WINDOW_EXHAUSTED]`
- `GO`, `NO_GO`, `INCONCLUSIVE`, `INVALID`
- start-only/ambiguous, terminal 누락, receipt binding 불일치
- runtime release 실패 또는 recovery 필요

동일 authority를 재실행하거나 legacy `lab:batch`, `lab:agent --execute`, smoke, repair를 우회로 사용하지
않는다. Kordoc은 publishable 후보를 확정한 뒤 별도 proposal/source 승인으로 실행한다.

## 4. 체크포인트와 완료 기준

- 이번 세션의 상한은 sequence 1~9다. sequence 10은 새 승인 전 NO-GO다.
- sequence 9까지 정상 종결해도 observedCount는 10이므로 formal GO가 아니다.
- `repair-sprt-v1`의 첫 formal 판정은 Nmin 15다. 10건 결과를 사용자에게 먼저 보고한 뒤
  sequence 10~14 승인 여부를 결정한다.
- 체크포인트에서 publishable/held, ready/conditional, repair count, issue code, 건별 시간과 Max window
  상태를 요약한다.
- 마지막으로 runtime이 `paused`, owner/expiry null, active deep/application lease 0인지 확인한다.
- API Console은 sequence 1~9 종료 또는 조기 중단 직후 한 번 확인해 신규 API 요청 0건을 다시 고정한다.

## 5. 과구현 방지

이 단계의 목적은 시스템을 실제로 돌려 10건 누적 증거를 얻는 것이다. 다음은 하지 않는다.

- 범용 batch orchestrator, DAG, scheduler, approval UI 추가
- 병렬 실행 또는 전역 Claude CLI 상한 조정
- 새 timeout/quota/비용 cap 추가
- 실패 전 선제적 recovery·예외 상태 확장
- Kordoc/application lane 혼입
- 코드 리팩터링이나 테스트 케이스 확대

실행을 막는 재현 가능한 결함이 생길 때만 해당 exact seam을 최소 수정하고, 그렇지 않으면 현재 receipt
chain을 끝까지 진행한다.
