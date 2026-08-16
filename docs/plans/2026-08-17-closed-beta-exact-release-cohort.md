# 클로즈드 베타 exact release cohort

- 기준 시각: 2026-08-17 KST
- series: `deep-v21`
- proposal SHA: `4c4bdf0cf4633d0839a2464089f3f137fa5196e24b56d07f5dedc68ff2192557`
- plan SHA: `44d2e15b56905ebb716ddb0ccc9f52b7fc5ac00fa8ac2ecc7a4e9b9ba4a5e56f`
- execution manifest SHA: `3a16970b5d5de5b58dd1e18dcb7d184a1e19feac0094318b2e2979e4f86f0c83`
- 제안 cohort 이름: `deep-v21-closed-beta-seq-0-8`
- 상태: revision 1 준비 후 legacy aggregate 불일치로 승인 전 중단. revision 2 생성과 모든
  실쓰기는 별도 승인 대기

## 1. 가장 빠른 exact cohort

sequence 0~8의 9건을 하나의 최초 클로즈드 베타 cohort로 제안한다. 9건 모두 현재 공개·접수
가능 상태이고, 준비 당시 input/attachment와 현재 값이 일치하며, 기존 deep-analysis run,
promotion item, confirmed dedup member 중복이 없다. 실제 matcher 변환도 9건 모두
`conversion.error=null`, `dropped=0`이다.

| seq | grantId | runId | run SHA | readiness | 현재 source revision | receipt SHA | matcher 조건 |
|---:|---|---|---|---|---|---|---:|
| 0 | `3d76caed-3df9-4a97-8554-51b38e954b26` | `run-2026-08-16T110956.775Z-6561c7` | `4c1034bca3e42b71acd11b8e5a916eacf8632e599fca71be7dea588cc1180d54` | ready | `5399898b032259bf916b24f525c667a2e59fbf3b1f60b97c1b038130960fab4d` | `31f3bd525fc5435b48f3d815cea80181ff3f5c0ccfe1fbba80ba7fc5de16e5ef` | 31 |
| 1 | `b4b0f634-b068-4f30-b83f-e2863a22dbc9` | `run-2026-08-16T111951.820Z-c558b9` | `7b4603ee9941d9466b7b23578b4f37cfe3be05e8ffdeb348590f612070cfe233` | conditional | `a3672862d6c488f1d1d5178f0222c87d83c0ae7918fd42053d16c3a6621c392b` | `58f11149500fac50a120d8e1d9e531c89d2306b56a4eac92a49f2282636ebb3f` | 5 |
| 2 | `87d36b6f-23f3-4484-8f08-fe8394ba5e10` | `run-2026-08-16T112508.431Z-aadeee` | `fef17148cb2ce735b4ad5e33a67c30beb95e17e37fe05a3124c976dedf543e4a` | conditional | `1c054364a5d478a36672df5ea7dfa024ecb76331951544f2872c62cc1cc50595` | `b79a59b46beeadc824241251e9f52bc66277b978a2077e110b3de58a77b24e24` | 3 |
| 3 | `95b40166-cdc5-452f-82fc-ffd35f1b53d7` | `run-2026-08-16T112847.189Z-fa64a7` | `7a46a8ff241c07a2aebe65e6dc81c1eeb2ecaa4f7a1e0475fa963f4bd2000926` | ready | `bb447fbd4a87787d15c551d4a3fa297e46dca7287a25055ebbbafd5cf60a3419` | `341dd6aa8242b2ce8ec017774cd0a6e9e0f1d2af80e7a6d6b502d5e0af437296` | 12 |
| 4 | `d80caca6-e654-4705-881c-2bdb42be8b32` | `run-2026-08-16T113248.782Z-c096c0` | `bfb52f8b6178ba9135fa9bec35bbfd030f5de4278fa71176398648a9209cf4dc` | conditional | `0f196bf38264ca63b5d623695ab4912b8024502b7a2b14a93a10c576bee1fa66` | `5e8649cb04c305c0ef806d462317a6e208b4648f4466510c3e94ca5c362eddaa` | 3 |
| 5 | `68a8ae09-ccbd-4610-aa26-77cd9944894e` | `run-2026-08-16T113948.040Z-cd6092` | `17de7020d40a3470775f3aa4f9e31959c1f98f4669e237cb37078580e21f92cd` | conditional | `060d639c0d92057c3630a00469f494f6e0559aeecbed408accd9beaab35fbfbd` | `d430803ddbbbb0bae8dec2aa4134e64cb21131e616edfeecf88491f376652659` | 22 |
| 6 | `f165d498-810c-4a69-a3be-190efd319175` | `run-2026-08-16T114659.268Z-f7a269` | `adbd01a87ba974717a4a6ccf05838cf53282af9a621c7152350a16506691025a` | conditional | `95712cbd89b558d684ea7e55411bbbd85815e1088eb4b83d323b96c667c7a9a5` | `0dcab622571812aa804e507faf87837c050e4f76d67f51e64ed0fb8a81872a6d` | 12 |
| 7 | `bf4a7f10-b98f-467b-b6b9-27f92e35dd58` | `run-2026-08-16T115426.057Z-7c375c` | `86fd9c875f6390bf60d24e8a40c780d554da71db59b23ebfd79c1c406bed9efd` | conditional | `8129177e768fd0d4567a6b07d0736d469012fddce6412353fdd29da0ba9b7bd5` | `6f2adaa73e0cee6b3019c5700efe8176ddb168f377abd6b6b8936045ca068ca5` | 4 |
| 8 | `89d45df7-4520-41fc-8301-c82333f05376` | `run-2026-08-16T115814.678Z-809f0b` | `46eccacdfca5295e2bf90a8fea3fe65fb17fc1e8746e1de4bfc6be5c56e1adb7` | conditional | `41969f192ed57c879fc8e39eb8376eba1ea26d2dc9743f624028b6abf5a71991` | `adf13c04fcd5c4b226628f23adff0cebe23b62bb86ccf5150e8491d73c632e94` | 13 |

ready 2건은 확인된 조건으로 바로 매칭하고, conditional 7건은 확인된 조건만 사용하면서
`ambiguous`/`input_missing` 상태를 관리자에게 표시한다. 미확보 축을 불일치로 판정하지 않는다.

## 2. 관리자 확인 대상

sequence 9의 `b8e1d002-dae1-402d-bc04-b14e9e9ef4f1`은 현재 source/input/attachment가
일치하지만 repair 뒤 실제 source conflict가 남았다. terminal receipt는
`3adc8b4b5a016253e3b0b0cbffa2255bb6f94bc5ff9f385a7281f693e99eb3e3`이다. 이 공고는
초기 exact cohort에 넣지 않고 관리자 판단 전까지 `admin_review`로 유지한다.

## 3. 현재 serving provenance

현재 `active`/`canary_passed` release의 applied item은 3행이다. 과거 두 release
`deep-2026-08-09-audited-canary-r3-20260808T161753Z-ead96b72`,
`deep-2026-08-09-ai-kordoc-canary-r4-322e2286`은 serving resolver 결과가 `null`이라 제품
후보에서 제외된다. `deep-quality-loop-gbio-20260809-r2-20260809T100130Z-057065bf`의 1건만
`verified_local_lab` provenance로 서빙 가능하다. 위 exact 9건과 grantId가 겹치지 않는다.

## 4. revision 1 중단 증거와 다음 승인 경계

준비된 revision 1은
`deep-deep-v21-closed-beta-seq-0-8-r1-20260816T154307Z-042f05a7`이다. manifest SHA는
`0357fe9e5053b69f25419dfd64155ba666f53e5964c5c3ae0583f08c6274e128`, release plan SHA는
`6ef86e32ce13dcb3aca3e031e96adcbd8fcb0832a16fca4ef1aa8334bfc042cf`이다.

revision 1의 aggregate v1은 receipt 기반 105개 발행 criterion에 존재하지 않는 legacy review
verdict를 요구해 `correct=0`, `ITERATE`로 봉인됐다. 같은 실행에서 sequence 6 verifier의
일시적 실패도 실제 drift와 구분되지 않은 채 기록됐지만 직후 exact source 재검증은 9/9
일치했다. 불변 aggregate를 덮어쓰지 않으며 revision 1은 `prepared`, 미승인 상태로 남긴다.

공통 aggregate v2 계약과 typed source verification을 검증·커밋한 뒤에도 revision 2 release는
자동 생성하지 않는다. 새 commit/build digest와 동일 exact 9건의 current revision 결속을 다시
제시하고 별도 승인을 받은 경우에만 revision 2를 준비한다. 이후 aggregate v2, shadow,
dry-run, 분리 승인을 거치고 `lab:promote --write`는 다시 별도 승인을 기다린다.

모델 호출, Kordoc, 검수·감사·confirmations, sequence 10 재개, DB write, 배포,
Cloudflare 변경, 운영 `observe_only` 해제는 이 cohort 문서의 권한 범위가 아니다.
