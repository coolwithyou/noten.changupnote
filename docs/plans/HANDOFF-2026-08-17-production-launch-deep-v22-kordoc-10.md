# 정식 출시 전 deep-v22 + Kordoc 10건 핸드오프

> 역사 문서: seq 0~9 실행과 Kordoc/release dry-run은 종결됐다. 신규 대량 실행에는 이 문서의
> exact-next·직전 `CONTINUE`·target별 authority 절차를 재사용하지 않는다. 현재 정본은
> `HANDOFF-2026-08-18-launch-batch-deep-v23-30.md`와 `AGENTS.md`의 2026-08-18 런칭 정책이다.

- 작성일: 2026-08-17
- 실행 위치: `/Users/ffgg/noten.works/cunote`의 현재 worktree. `spike-out` artifact가 이
  worktree에만 있으므로 새 worktree를 만들지 않는다.
- 목적: 정식 출시 전 최초 변환 코호트 10건을 새 표본으로 봉인하고, **다음 세션에서만**
  deep-primary와 그 결과에 결속된 Kordoc 분석을 순차 실행한다.
- 이번 세션의 경계: 모델 호출, live authority 발급, Kordoc canary, DB write, release/promotion,
  배포, Cloudflare 변경, 운영 `observe_only` 해제를 수행하지 않는다.
- 보호 대상: 사용자 소유 미추적
  `docs/research/2026-08-10-루프와-그래프-엔지니어링-접근.md`
  (`sha256=7a7fae388defe0d0e1f54eed0a3094bd6f7c60a17a1e4abf952bcc1ba2d5c4cd`).
  시작과 종료에 SHA-256을 확인하고 절대 수정·stage·commit하지 않는다.

## 1. 이번에 정리한 출시 전 장애물

출시 코호트 준비를 막던 과거 실험 계약은 다음 범위에서 제거했다.

- 현재 formal series를 `deep-v22`로 분리했다.
- formal 표본만이 아니라 `spike-out/analysis-lab`의 기존 deep/Kordoc/cohort/experiment 이력
  전체 191개 grantId를 신규 표본에서 제외했다.
- 한 seed의 30건에 갇히지 않도록 고정 seed `20260817`, `20260818`의 결정적 후보를 합쳐
  57건 pool을 만들고, 그중 Kordoc 원문이 실제로 준비된 후보를 우선했다.
- 첫 10건은 현재 공개·접수 중이고 최소 7일의 접수 여유가 있으며, R2 원문 SHA가 일치하고,
  신청서/사업계획서로 판정된 HWP/HWPX의 LLM 후보 필드 합계가 240 이하인 공고로 제한했다.
- 결과보고서·정산보고서·실적보고서 및 독립 개인정보 동의서/증빙서류를 신청 양식으로
  오인하던 classifier를 수정했다.
- target별 authority는 receipt와 실행 대상을 결속하는 기술적 fencing으로 유지하되, 승인된
  exact cohort 안에서 sequence마다 같은 사용자 승인을 다시 묻는 과거 Gate R 문구를 제거했다.
- evaluator 호환을 위한 formal plan은 30건을 유지한다. **live 실행 범위는 seq 0~9의 첫
  10건뿐이며 seq 10~29는 자동 권한이 아니다.**

선정 결과 첫 15건은 필수 5개 층
`bizinfo/medium`, `kstartup/medium`, `bizinfo/thin`, `bizinfo/thick`, `kstartup/thin`을 모두
포함한다. 통합공고 soft quota는 `0/4`지만 rich-criteria quota는 `6/6`이다. 통합공고 수를
맞추기 위해 Kordoc 준비도나 표본 중복 방지를 포기하지 않는다.

## 2. 다음 세션에서 실행할 exact 10건

아래 순서는 변경하거나 대체하지 않는다. 하나가 drift·마감·원문 불일치이면 해당 target에서
멈추거나 제외 판정을 기록하고, 임의의 후보로 바꾸지 않는다.

| seq | grantId | source/sourceId | 접수 마감 | 공고명 |
|---:|---|---|---|---|
| 0 | `a512f025-3b74-4c2a-b3cf-5d0e139954e0` | `bizinfo/PBLN_000000000119234` | 2026-09-30 | 2026년 안전관리 우수연구실 인증제 시행 공고 |
| 1 | `50c2a5a7-b57c-4511-9be9-37558fa3d31b` | `kstartup/178289` | 2026-12-31 | (주)미래서비스 1인 창조기업 지원센터 입주기업 모집공고 |
| 2 | `4c0e9f1f-52f3-43be-be25-a33ba963d0b4` | `bizinfo/PBLN_000000000125487` | 2026-08-26 | [전남광주] 2026년 바이오플러스 인터펙스코리아 참가기업 모집 공고 |
| 3 | `c04dca5d-9ef1-4e70-82f1-2d3ca2301ba1` | `kstartup/177837` | 2026-12-31 | 「한동대학교 제네시스랩」 스타트업 모집 공고 |
| 4 | `b500d9a8-23ab-4144-9c8b-ecea85a4793d` | `bizinfo/PBLN_000000000125479` | 2026-08-31 | 2026년 KOMICS Thailand 참가기업 모집 공고 |
| 5 | `ca49d3db-6c29-49db-8b6a-c2b1ca9ae346` | `bizinfo/PBLN_000000000118906` | 2026-10-30 | [전남] 2026년 건설공사 하도급대금 지급 보증수수료 지원사업 공고 |
| 6 | `df2d49f3-79e4-400b-a5e1-ec78295ac2e8` | `bizinfo/PBLN_000000000123743` | 2026-12-01 | [경기] 포천시 2026년 2차 중소기업 전시(박람)회 출전 지원사업 모집 공고 |
| 7 | `678dfb85-f622-4399-b28e-66013b729bc8` | `kstartup/177357` | 2026-12-31 | 남서울대학교 창업보육센터 입주기업 모집(천안소재) |
| 8 | `5d302193-e823-448e-abc8-8e3503fb751b` | `bizinfo/PBLN_000000000118028` | 2026-11-27 | [전남] 2026년 개별바이어 초청 수출상담회 지원사업 신청 공고 |
| 9 | `d9a12cf0-da85-49f2-a0b6-21c67c3945f9` | `bizinfo/PBLN_000000000125132` | 2026-11-28 | [충남] 2026년 디지털품질역량강화사업 크라우드 테스팅 희망기업 모집 공고 |

10건 모두 준비 시점에 `open/visible`, 기존 DB deep run 0건, promotion 0건, precompute 0건이며,
과거 로컬 deep/Kordoc 이력과도 겹치지 않았다. 이 값은 시점 의존적이므로 다음 세션 시작 때
반드시 다시 읽는다.

## 3. revision·입력·첨부 결속

| seq | raw revision SHA | input SHA | attachment SHA |
|---:|---|---|---|
| 0 | `adb5a815116f7de4647f4cf95b0dbc492e547d08fa605ede800a296be2181f01` | `080379ed398a41e0185659cccf1d165d89ce570712d11b2ec20a5789d5785006` | `daea7389a50d39bbf31f44fd564c45d8ce597bb88485dfcebe431d5150c7f5ca` |
| 1 | `6ecb37379fb213497608ea3762d9c71ab3a3ba66d2a6937bcc84b95167c6fb29` | `1ed0ffa45123d598ba81f1df5c5bf502c857c77135d5ebf9e9ad62244a8c8260` | `1eb73eba47930addb26ab72e870f53a2b75110704383f54d6c3cae29e74fc134` |
| 2 | `443b7c82551c14ad6d4fe8e83008866054ef44ff78e856021706c6592bbc5466` | `e3a515ddff7a23ff39735b92f50cb88dc57b4a9e5a1578b9b37bdbf0e041e3c1` | `a4f7a45989d38b090b9915ca91bbec0b8ccf4bacadbc173104127944e16a2748` |
| 3 | `90c3d922cd5d5499d2f7024515bfb50bb7eaeab5877984532e823bd355c94821` | `abc16f6617b89937765bd719cf200d83cc91f43e1165070f24dba8552c8bca68` | `281c0479c773cfe61b55bed8f3ccf9a1b7b5dbd80ca5fda95c28ef5d960b9239` |
| 4 | `f298a982d020ea5553afb9301999a8d19c366f01edeafc0196cafeac0df92348` | `732cb0cd8f5e72c531cadedfc365fa2f50d8b760009163da228493ea8a5f1639` | `e75afdb81cfcc5f023ba9bf7df0a08d1b6022f0db98e4a271ba8e291524dc375` |
| 5 | `5511fb1cce3c9cd1f383c253b9b5eb41c69a7c436878bb4f9ae55839ba39f7b6` | `53fdff2209fb30b05c14e59a5a19e966073852cb30ac77395c9e601f054719d4` | `c991098b36036608db9a5bd77e9c43b34b9675c3e491113df90d63fa41b86da3` |
| 6 | `27863ccfa5f61faf0d68ac063f13654433553d2e8f6a26da2e083901b57472f3` | `fcea6d371c43dc006f46db1a551937b152ae8c899f15690897c7e15c452a2f17` | `34a03b7a1a3a6e3c795113ca6fdef414d506ba9f2fbf4f9d325ec2b6b12725db` |
| 7 | `e2f8c14952cdef24a2e938dd26bf5245b475a5a9a72d42c434ddbc406631af54` | `fd2644a4595f8a21745aced366c9965a286ac0ad5e3e833584a2019395537e60` | `acd81e009f8c1cbb6b2b6d8a975faaaed809a31b815f5e5e6cd986bdaf4e8cae` |
| 8 | `db78d56762b549f7790158323b7e1c3abb7a9c46da67f4b66fb595d5ec2cb633` | `d97fceca949b755c0e8905f9bda816b6a9adbf0da2b801b0544976de4bc9b168` | `ba1d8a587896c42d98df23f84875a05a9f1f056a1f78a363746e3a6592fb8d99` |
| 9 | `f06311609d4bf7e115c7ccca14adbf24d06a5889669d1851f5d87e22a8bda9b8` | `32114a524bb96262b47bf82a5bb9e3148d3c81c01470e128979e68fec969a8b0` | `4385446bfe9b9405f5508cf8d81463bdd2a5a48c57bce69cfe53f9f7f0a914df` |

## 4. Kordoc exact source 결속

| seq | 신청 양식 | source SHA | fields / LLM 후보 |
|---:|---|---|---:|
| 0 | `(첨부양식)2026년도 안전관리 우수연구실 인증제 신청서 등 서류.hwpx` | `8963d549c1074ac146a606eae12d42c25837c95df2f2290a65d3a2842520f081` | 64 / 29 |
| 1 | `[붙임] 입주신청서 등 서류.hwp` | `eebbbf310d04d72d90b622de670cdcea45b96c3f88ac0ae7e3335a926047959d` | 62 / 22 |
| 2 | `(붙임 2) 신청서식.hwp` | `b4cfe26be4f9f679c54349bb3050a954bb1ad2ce9b41cd000d89c4dbde9c5b12` | 45 / 16 |
| 3 | `한동대학교 제네시스랩 입주신청서 (양식) (2).hwp` | `08a3f79c9fd4b5e4c41ee027fd0693e8fa24edbbb208633db3764015f94abf79` | 170 / 80 |
| 4 | `2. 제출서류 양식 및 매뉴얼__02__① 추가신청서(2026 KOMICS Thailand).hwp` | `d634ed2a0bb99cc3155fb440cc6e0649e0aeebd06bb9cd984e60cb3851cd7a25` | 71 / 39 |
| 5 | `건설공사 하도급대금 지급 보증수수료 지원사업.hwp` | `6f7ff303eb00757c60a192e55a06c8d2e663efca5584a7a366c47a4fc351789e` | 39 / 24 |
| 6 | `2026년_포천시_중소기업_전시(박람)회_출전_지원사업(2차)_신청서_양식.hwp` | `1640b254f01ccb4833fcf8ec713829068a6726b17b2fa49988cd2f9bb84dd782` | 116 / 61 |
| 7 | `첨부1 입주신청서(기창업자용).hwp` | `cc4f4b8201ccf661271382b564b080f90c5f6f3f8a062d473d00bdaaa44a422d` | 163 / 69 |
| 7 | `첨부2 입주신청서(예비창업자용).hwp` | `0d5cb88eb7fd62ea3cab012d86bec96c68cf9c606825bb29791142379ff46eb0` | 93 / 45 |
| 8 | `개별바이어 초청 수출상담회 지원사업 신청 공고.hwp` | `bd15c6dc8aea522e227e13a7f6d96d1b1aea0fca41db56366dddaf473db4f7ae` | 163 / 78 |
| 9 | `붙임. SW제품 기능테스트 기업 참가신청서.hwp` | `52d1cd9bef3f4a4b15f4f4a28681f472d8781f4baaa57ce809f72ed3fac3d208` | 28 / 7 |

seq 2의 `(붙임3) 결과보고서.hwp`와 seq 4의 독립 개인정보 동의서는 신청 양식에서 제외했다.

## 5. 이번 세션의 검증 증거

- `pnpm verify:saas-release-checklist` 통과
- `pnpm verify:saas-readiness` configured mode `ready`, 100점, 13/13
- `pnpm verify:legal-readiness` configured mode `ready`, 100점, 8/8
- `pnpm verify:db-doctor` 통과
- `pnpm lab:experiment:test` 통과
- `pnpm lab:roundtrip:test` 통과
- `pnpm typecheck` 통과
- `pnpm build:web` 성공
- `git diff --check` 통과

읽기 전용 운영 증거:

- gcloud tokeninfo email:
  `cunote-codex-dev@changupnote-com.iam.gserviceaccount.com`
- `cunote-deep-analysis` generation 97, image digest
  `sha256:fa68e75aa3d8155b00dbc4cc709a1efe9ced758ff5ff936339f51492b089c058`
- 세 Job의 `GIT_COMMIT_SHA`:
  `0b94576c88b6103f2b9556dabfdbf7ff52ac1cab`
- main worker mode: `observe_only`
- nonterminal Cloud Run execution: 0
- DB runtime: `paused`, generation 147, owner/expiry null
- active deep/application lease: 각각 0

이 운영 evidence는 신규 로컬 실행의 현재성 검사에 쓰며, 로컬 proposal의 git SHA와 같아야 하는
값이 아니다. 다음 세션에서 시점 의존 항목을 다시 확인한다.

## 6. 봉인 proposal/plan 읽기

이 문서와 코드가 커밋된 뒤 모델 무호출 prepare를 실행해 `deep-v22` proposal을 만든다. 최종
artifact 결속은 gitignored marker를 정본으로 한다.

```text
spike-out/analysis-lab/experiments/series/deep-v22.json
```

다음 세션은 marker가 가리키는 proposal raw SHA, plan semantic/raw SHA, manifest SHA, git SHA,
package runtime SHA를 읽고 서로 일치하는지 확인한다. proposal의
`liveExecutionAuthorized=false`는 정상이다. proposal 준비가 live 권한을 만들지 않기 때문이다.
proposal/plan을 재생성하거나 자동으로 다른 표본을 고르지 않는다.

## 7. 다음 세션의 정확한 실행 순서

1. `AGENTS.md`와 이 문서를 끝까지 읽고 보호 파일 SHA-256을 확인한다.
2. marker와 proposal/plan/manifest를 읽어 exact 10건, source revision, git/package/validator
   결속을 검증한다. checkout HEAD는 proposal provenance git SHA와 같아야 하고 tracked runtime
   파일이 dirty이면 멈춘다.
3. 10건의 공개·접수 상태, raw revision/input/attachment SHA, R2 source SHA, 기존 deep run,
   promotion/precompute 중복을 다시 읽는다. drift·마감·중복 target은 실행하지 않으며 대체하지 않는다.
4. 운영 `observe_only`, nonterminal execution 0, 로컬 runtime `paused`, deep/application lease 0을
   다시 확인한다.
5. 첫 모델 요청 전에 `claude auth status --json`이 `claude.ai/firstParty/max`인지 확인하고,
   child 환경에 API credential/provider override가 상속되지 않는 정적 preflight를 통과시킨다.
6. deep seq 0부터 9까지 exact plan 순서로 한 건씩 실행한다. 매 target authority는 직전 terminal
   receipt를 parent로 한다. 승인된 이 exact cohort 안에서는 sequence마다 사용자에게 같은 승인을
   다시 묻지 않는다.
7. 한 target의 full evaluator가 `GO`, `NO_GO`, `INCONCLUSIVE`, `INVALID` 중 하나이거나 전체 verdict가
   `CONTINUE`가 아니면 즉시 중단한다. seq 10 authority는 발급하지 않는다.
8. 각 deep 결과가 `publishable`이고 receipt가 종결된 공고만 같은 grantId/revision의 Kordoc 대상이
   된다. 10건 deep 종료 뒤 exact 누적 Kordoc preflight를 한 번 수행하고, `ready`인 공고만 위 source
   SHA에 결속해 Kordoc canary를 한 번씩 실행한다. `held`, `deferred`, `source_unavailable`, drift는
   Kordoc을 실행하지 않는다. Kordoc 실행 뒤에는 target 품질과 코호트 진행을 분리한다. 안전하게
   제외된 구조 경고는 `conditional/CONTINUE`, 미해결·문서별 실패는 `held/CONTINUE`로 해당
   target만 격리한다. source·proposal·model·transport drift, receipt/artifact 불일치, Max 인증·lease
   상실, timeout·HTTP·invalid response처럼 공유 실행 신뢰가 깨진 경우에만 `STOP`한다.
9. 종료 시 receipt chain, deep 결과, Kordoc artifact, unresolved 상태와 비용/transport 증거를 exact
   target별로 보고한다. 보호 파일 SHA를 다시 확인한다.

## 8. 계속 금지되는 범위

- deep-v22 seq 10~29 및 자동 대상 대체
- legacy `lab:batch`/`lab:smoke` non-dry, `lab:agent --execute`
- AI 검수, 블라인드 감사, confirmations
- release 생성·승인, `lab:promote --write`, 기타 DB write
- Vercel/GCP 배포, Cloudflare 변경, 운영 `observe_only` 해제
- 실패 artifact 삭제, 임의 recovery, 같은 대상의 자동 재실행

이 10건의 deep+Kordoc 결과가 정식 출시 대량 변환으로 넘어갈 수 있는지 판단하는 최초 bounded
cohort다. 실제 대량 범위, release, 승격, 배포는 결과를 보고 별도 결정한다.

## 9. 후속 release dry-run 범위 (2026-08-17 승인)

deep/Kordoc 실행 결과를 반영한 후속 범위는 seq 4를 제외한 9건이다.

- Kordoc `ready`: seq 0, 2, 3, 5, 6, 7, 8
- Kordoc `conditional`: seq 1, 9
- Kordoc `held`: seq 4 — release plan에 포함하지 않는다.
- release prepare에서는 `--require-kordoc`으로 9건 모두의 receipt admission을 강제한다.
- v3 canary는 직접 소비하고, seq 0·1의 legacy v2 canary는 immutable policy receipt를 parent로
  검증해 소비한다.
- deep seq 2의 재로그인 전 실패 receipt는 삭제하지 않는다. seq 3이 parent로 채택한 publishable
  seq 2 receipt를 포함해 seq 0→9로 이어지는 유일한 최장 terminal chain만 release source로 쓴다.
- 허용 상한은 `release prepare → aggregate → shadow → promote dry-run`이다. release 원장과 로컬
  immutable gate artifact는 생성할 수 있지만 `release approve`, `lab:promote --write`, 배포,
  Cloudflare 변경, 운영 worker mode 변경은 수행하지 않는다.
