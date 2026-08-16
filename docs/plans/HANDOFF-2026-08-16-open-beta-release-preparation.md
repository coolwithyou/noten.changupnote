# 클로즈드 베타 출시 준비 핸드오프

> 후속 정정(2026-08-17): 이 문서의 §6은 당시 읽기 전용 인벤토리 세션에 주어진 권한만
> 기록합니다. 이후 사용자가 seq 0~8 exact cohort의 `release approve까지`를 승인했으며,
> 동일 grantId/run/source revision의 failed release 상위 revision은 그 처리 범위를 이어갑니다.
> Gate R target별 승인은 live 모델 실행 전용이고 release 처리에 반복 적용하지 않습니다.
> 현재 권한 정본은 `AGENTS.md`의 "딥분석 권한 종류 분리"와
> `docs/runbooks/deep-analysis-promotion.md`입니다.

- 작성일: 2026-08-16
- 목적: `deep-v21` 실제 순차 실행 결과를 보존하고, 새 세션이 모델 실행이나 추가 가드 구현이 아니라 출시 가능한 공고의 읽기 전용 인벤토리부터 시작한다.
- 실행 위치: `/Users/ffgg/noten.works/cunote`의 현재 worktree. `spike-out`의 gitignored artifact가 이 worktree에만 있으므로 새 worktree를 만들지 않는다.
- 실행 코드 봉인 commit: `ab6ea9f4c69cb01921e33ef13f8f038027017bc9`
- 현재 작업트리 보호 대상: 사용자 소유 미추적
  `docs/research/2026-08-10-루프와-그래프-엔지니어링-접근.md`
  (`sha256=7a7fae388defe0d0e1f54eed0a3094bd6f7c60a17a1e4abf952bcc1ba2d5c4cd`).
  절대 수정·stage·commit하지 않는다.

## 1. 의사결정과 출시 방향

사용자는 런칭을 더 늦추는 범용 방어 코드 확장을 중단하고, 현재 지원 가능한 공고를 실제 매칭 가능한 형태로 제공해 클로즈드 베타를 여는 방향을 확정했다.

적용할 원칙은 다음과 같다.

- 22축 전부가 확정될 필요는 없다.
- 순수 `ambiguous`/`input_missing`만 남고 확인된 축이 2개 이상이면 `publishable/conditional`로 두고 확인된 조건만 matcher에 사용한다.
- 미확보 축을 불일치나 탈락으로 간주하지 않는다.
- 확인된 축이 1개 이하이거나 unresolved 축에 criterion mismatch가 남으면 `held/deferred`다.
- 원문 미확보나 제한된 불명확성은 관리자에게 명확히 알리되, 그 자체로 모든 공고를 차단하지 않는다.
- 구조화 필드와 상세 원문이 실제로 충돌하면 원문 미확보와 구분해 관리자 확인 대상으로 둔다.

이 단계의 우선순위는 `분석 확대 → 출시 후보 확정 → 승인된 release 처리 → 별도 승인 실승격 → 실제 매칭 확인`이다. 다만 이번 새 세션의 첫 행동은 쓰기 없는 출시 후보 인벤토리다.

## 2. 구현된 최소 변경과 검증

commit `ab6ea9f`에서 다음만 변경했다.

- repair 전 잘못된 criterion을 제거하고 같은 축이 최종 `input_missing`이 된 경우를 source-incomplete transition으로 분리했다.
- 기존 raw `newIssueAfterRepairCount`는 보존하고, `blockingNewIssueAfterRepairCount`와 `sourceIncompleteIssueAfterRepairCount`를 추가했다.
- 기존 `repair-sprt-v1` 해석과 hash는 바꾸지 않고 새 `repair-sprt-v2`로 deep-v21을 열었다.
- 관리자 공고 목록에 최종 `input_missing` 축 수와 `원문 미확보 N축` 경고를 노출했다.

당시 검증 증거:

- `pnpm lab:experiment:test` 통과
- `pnpm typecheck` 통과
- `pnpm verify:deep-analysis-contract` 통과
- `pnpm verify:admin-grant-simulation` 통과
- `pnpm build:web` 성공
- `git diff --check` 통과

재현 가능한 출시 blocker가 없으면 이 seam을 다시 리팩터링하거나 테스트를 확대하지 않는다.

## 3. deep-v21 봉인 artifact

| 항목 | 값 |
|---|---|
| proposal raw SHA | `4c4bdf0cf4633d0839a2464089f3f137fa5196e24b56d07f5dedc68ff2192557` |
| plan semantic SHA | `44d2e15b56905ebb716ddb0ccc9f52b7fc5ac00fa8ac2ecc7a4e9b9ba4a5e56f` |
| plan raw SHA | `06016909b45b92602e04a67cdb243fe8c2de28a9306b7edd093f731b4a85e92f` |
| manifest SHA | `3a16970b5d5de5b58dd1e18dcb7d184a1e19feac0094318b2e2979e4f86f0c83` |
| provenance | git `ab6ea9f...`, package runtime `010e8ba1...`, validator `deep-analysis-validator-v10` |
| lane | `claude-opus-5` / `claude-cli`, deep-primary only |
| gate | `repair-sprt-v2` |
| prepared targets | 30 |

사용자는 sequence 0~9 최대 10건을 exact 범위로 승인했다. 각 sequence는 직전 terminal receipt를 parent로 한 건씩만 실행했고, sequence 9의 full evaluator가 `INVALID`를 반환한 즉시 멈췄다. sequence 10 authority는 발급하지 않았다.

## 4. 10건 누적 결과

| seq | grantId | 결과 | repair | 최종 주의 축 | gate |
|---:|---|---|---:|---|---|
| 0 | `3d76caed-3df9-4a97-8554-51b38e954b26` | publishable / ready | 0 | 없음 | CONTINUE |
| 1 | `b4b0f634-b068-4f30-b83f-e2863a22dbc9` | publishable / conditional | 0 | `prior_award=input_missing` | CONTINUE |
| 2 | `87d36b6f-23f3-4484-8f08-fe8394ba5e10` | publishable / conditional | 0 | `other=input_missing`, `size=ambiguous` | CONTINUE |
| 3 | `95b40166-cdc5-452f-82fc-ffd35f1b53d7` | publishable / ready | 0 | 없음 | CONTINUE |
| 4 | `d80caca6-e654-4705-881c-2bdb42be8b32` | publishable / conditional | 1 | `other=input_missing`, `region/target_type=ambiguous` | CONTINUE |
| 5 | `68a8ae09-ccbd-4610-aa26-77cd9944894e` | publishable / conditional | 0 | `tax_compliance/sanction=input_missing`, `size=ambiguous` | CONTINUE |
| 6 | `f165d498-810c-4a69-a3be-190efd319175` | publishable / conditional | 1 | `size=ambiguous` | CONTINUE |
| 7 | `bf4a7f10-b98f-467b-b6b9-27f92e35dd58` | publishable / conditional | 0 | 원문 미확보 18축 | CONTINUE |
| 8 | `89d45df7-4520-41fc-8301-c82333f05376` | publishable / conditional | 1 | `target_type=ambiguous` | CONTINUE |
| 9 | `b8e1d002-dae1-402d-bc04-b14e9e9ef4f1` | publishable / conditional | 1 | `target_type=ambiguous`, 구조화 필드와 상세 원문 충돌 | INVALID |

집계:

- run-level `publishable`: 10/10, `held`: 0
- matching readiness: ready 2, conditional 8
- repaired notice: 4, repair attempt: 4, 모두 model repair
- 최종 `input_missing`: 5개 공고, 23축
- evaluator: statistical `CONTINUE`, full verdict `INVALID`
- INVALID 이유: `blocking_new_issue_after_repair_present` 1건

sequence 9의 primary 최초 출력은 `target_type/text_only` criterion을 만들면서 `value.targets`를 넣어 canonical contract를 위반했다. repair는 해당 criterion을 제거했다. 최종 run은 확인된 `region`, `biz_age` criterion으로 `publishable/conditional`이지만, 포털 구조화 신청대상과 상세 원문의 신청대상 범위가 충돌해 `target_type=ambiguous`가 새로 생겼다. 이는 원문 미확보가 아니라 실제 source conflict이므로 초기 베타 자동 승격 코호트에서는 제외하고 관리자 확인 대상으로 둔다.

terminal receipt chain:

```text
31f3bd525fc5435b48f3d815cea80181ff3f5c0ccfe1fbba80ba7fc5de16e5ef
58f11149500fac50a120d8e1d9e531c89d2306b56a4eac92a49f2282636ebb3f
b79a59b46beeadc824241251e9f52bc66277b978a2077e110b3de58a77b24e24
341dd6aa8242b2ce8ec017774cd0a6e9e0f1d2af80e7a6d6b502d5e0af437296
5e8649cb04c305c0ef806d462317a6e208b4648f4466510c3e94ca5c362eddaa
d430803ddbbbb0bae8dec2aa4134e64cb21131e616edfeecf88491f376652659
0dcab622571812aa804e507faf87837c050e4f76d67f51e64ed0fb8a81872a6d
6f2adaa73e0cee6b3019c5700efe8176ddb168f377abd6b6b8936045ca068ca5
adf13c04fcd5c4b226628f23adff0cebe23b62bb86ccf5150e8491d73c632e94
3adc8b4b5a016253e3b0b0cbffa2255bb6f94bc5ff9f385a7281f693e99eb3e3
```

최종 evaluator receipt는
`c35563328e886478c15e630bcd0bf8cee9a2076cb7e6b9190bd962edfb488e38`다.

2026-08-16 23:09 KST 읽기 전용 재검증에서 receipt 10개의 self-hash·sequence·parent·plan 결속과 run artifact raw SHA가 모두 일치했다. 마지막 authority read-only inspect 결과 attempt는 `terminal_recorded`, model execution은 `finished`, runtime은 `paused` generation 147이었다. 같은 DB statement에서 owner/expiry null, active deep lease 0, active application lease 0을 확인했다.

종료 시 `claude auth status --json`은 `claude.ai/firstParty/max`였다. artifact에는 모두 `claude-opus-5/claude-cli`로 기록되어 있고 API fallback 신호는 없었다. 다만 종료 후 Anthropic Console 확인을 시도했을 때 사용 가능한 Chrome 세션이 없어 신규 API 요청 0건을 독립적으로 확정하지는 못했다. Console 확인 완료로 보고하지 않는다.

## 5. 신규 세션의 첫 행동: 출시 후보 읽기 전용 인벤토리

새 세션은 먼저 `AGENTS.md`와 이 문서를 끝까지 읽고, 다음을 읽기 전용으로 수행한다. 모델 호출, authority 발급, release 생성, promotion write, 배포는 하지 않는다.

대상은 우선 sequence 0~9의 exact grantId 10개다.

1. 현재 DB/source 기준으로 각 공고가 아직 존재하는지, 공개 상태인지, 접수 중 또는 예정인지, 마감됐는지 확인한다.
2. 준비 당시 input/attachment SHA와 현재 revision이 같은지 확인해 stale analysis 여부를 분리한다.
3. 현재 서비스 DB에 이미 deep analysis나 promotion 적용 이력이 있는지, 중복 승격 위험이 있는지 확인한다.
4. 확인된 criterion 수와 unresolved 상태를 다시 집계하되, `input_missing`을 불일치로 계산하지 않는다.
5. seq 0~8은 `현행이며 revision 일치`할 때만 빠른 베타 후보로 분류한다. seq 9는 source conflict 관리자 확인 대상으로 유지한다.
6. 현재 active promotion release와 serving provenance를 읽어, 기존 사용자 노출과 충돌하지 않는 최소 release cohort를 제안한다.

보고서는 최소한 아래 세 묶음으로 나눈다.

- 즉시 베타 후보: 현행·revision 일치·run-level publishable이며 실제 충돌 없음
- 관리자 주의 포함 후보: 조건부 매칭 가능하지만 `input_missing`/`ambiguous` badge가 필요한 공고
- 보류: 마감·revision drift·중복·실제 source conflict·promotion prerequisite 부족

읽기 전용 조사에서 재현 가능한 blocker가 없으면 코드를 변경하지 않는다. 조사 결과와 exact grantId/revision/run SHA를 사용자에게 먼저 제시하고, 가장 빠른 release cohort와 예상 사용자 노출 범위를 제안한다.

## 6. 당시 쓰기 경계와 후속 승인

이 핸드오프 자체는 다음 권한을 주지 않았다. 다만 이후 seq 0~8 exact cohort의 release
approve까지는 별도 대화에서 승인됐고, 아래 금지 목록이 그 후속 승인을 취소하지 않는다.

- deep-v21 sequence 10 이후 재개
- `lab:experiment:issue` 또는 모델 호출
- Kordoc·AI 검수·블라인드 감사·confirmations
- `lab:promote --write`, 당시의 release approve·DB 변경
- Vercel/GCP 배포, Cloudflare 변경
- 운영 worker의 `observe_only` 해제
- legacy batch/smoke/agent execute

이 문서 작성 당시에는 exact cohort 확정 뒤 release 처리 범위를 사용자에게 제시해야 했다. 이후
그 범위가 `release approve까지`로 승인됐으므로 동일 grantId/run/source revision의 failed release
교체에는 재승인을 요구하지 않는다. 실제 `lab:promote --write`는 여전히 별도 명시 승인을 받은
뒤 수행하고, 승격 뒤 protected write 결과, active release/serving provenance, 실제 matcher 노출을
각각 확인한다.

## 7. 중단 및 해석 규칙

- deep-v21 실험 체인은 sequence 9 `INVALID`에서 끝났다. statistical `CONTINUE`를 근거로 이어가지 않는다.
- 기존 approval/authority/receipt는 신규 실행 권한이 아니다.
- seq 9를 출시 후보로 다루려면 source conflict에 대한 관리자 판단 또는 별도 정책 결정이 필요하다.
- 운영 상태, 공고 마감 상태, revision, active release는 시점에 따라 바뀌므로 새 세션에서 반드시 다시 읽는다.
- Kordoc 미실행은 deep-primary `publishable`을 무효화하지 않지만, Kordoc 완료로 표현해서도 안 된다.
