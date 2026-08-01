# 딥분석 계층 전체 재구축 실행 증거

> 실행일: 2026-07-31  
> 대상: `changupnote-com`, `asia-northeast3`  
> 정책: `deep-analysis-model-policy-v24`, `deep-analysis-v11`

## 판정

분석 파생 계층을 백업 후 초기화하고 현재 정책의 최신 통과 run만 보존했다. 보존본을
새 release로 다시 발행한 뒤 신규 공고 2건을 공고·PDF/HWP 전문 기반으로 분석, 독립 AI
검수, 승격, serving, production 랜딩까지 완주했다.

재구축 시점 활성 공고 664건은 모두 현재 정책 job을 보유한다. 이 값은 **분석 완료
664건**을 뜻하지 않는다. 현재 실제 서빙은 검증된 9건이며, 나머지는 유료 분석을
일괄 실행하지 않고 대기열에 둔 상태다. 영구 메인 worker는 계속 `observe_only`다.

## 백업과 초기화

- 백업:
  `/Users/ffgg/noten.works/cunote/spike-out/deep-analysis/layer-rebuild/backup-20260731T0302Z/before.dump`
- 크기: 38,094,692 bytes
- SHA-256: `7ffaa9e5a457723b66869eeb5c3ab748869a2eadec2020704c17f141e4c16a6e`
- reset state SHA-256:
  `7c0166441ff8364ab46c6a5558dc311cc7b77d1b3c7591e7d3dde0cf10c22f1a`
- reset receipt:
  `spike-out/deep-analysis/layer-rebuild/20260731T100454Z-7c0166441ff8.receipt.json`
- 실행 도구 기준 커밋: `bd3c6a6d59fa5ef9a23c0a49084d5b6e64d01daa`

보존:

- `grants` 31,806
- attachment archive 4,894
- 현재 정책 최신 통과 job/run 13/13
- stage receipt 1,469
- 22축 result 286 (`13 × 22`)
- 독립 AI audit 13

삭제:

- 과거 job 394, run 79, stage receipt 2,374, axis result 924
- 과거 audit 38, exception event 69, worker heartbeat 2,848
- promotion release/item 16/18
- criterion 89,605
- confirmation question 6, match state 163,016, landing observation 1

원본 공고·첨부와 append-only 사람 검수 이력은 삭제하지 않았다. 트랜잭션 밖에서
trigger를 비활성화하거나 `TRUNCATE CASCADE`를 사용하지 않았다.

## 재발행과 신규 2건

보존 run 중 current source와 일치하고 승격 계약을 통과한 7건을 새 release로 재발행했다.
이후 다음 두 공고를 bounded 실행했다.

| 공고 | 입력 | 결과 | AI 검수 | 비용 |
| --- | ---: | --- | --- | ---: |
| `[우리금융그룹] 2026 디노랩 Tech센터 1기 모집` | 12,874자, 3 chunk, 첨부 3 | 22축 PASS | Sonnet `concur` | `$0.535436` |
| `SMART-X LAB 14기 참여기업 모집` | 10,606자, 3 chunk, 첨부 2 | 22축 PASS | Sonnet `concur` | `$0.570935` |

- Cloud Run execution: `cunote-deep-analysis-cjn6z`
- claim: 공고 2건 bounded, 동시성 1, 최대 2건
- 비용 상한: 일일 `$4`, 공고당 `$2`
- 합계 비용: `$1.106371`
- release: `deep-rebuild-20260731-live2`
- manifest SHA-256:
  `6df32d10efab1c466285f3f3f1d0c86013029a1f2abd7c59d46593dcb958a60c`
- aggregate: `GO` (`4/4` blocking, `6/6` observed, source drift 0)
- shadow: `PASS` (`2공고 × 125회사`, issue 0)
- dry-run: `PASS` (baseline `2/2`, source drift 0)
- canary/full promotion 및 verification: 모두 PASS
- full serving verification: `2/2` PASS

최종 DB projection은 active release 8, applied item 9, criterion 94/공고 9다. 전체
Cloud serving monitor `cunote-deep-analysis-serving-monitor-lxzq9`는 release 8,
item 9, skipped 0으로 PASS했다.

## 랜딩 검증

production `POST https://changupnote.com/api/web/teaser`에 법인 profile 답변을 전달했다.

- 카나리: HTTP 200, 1.783초, 디노랩 공고가 첫 결과로 반환
- 전체 승격: HTTP 200, 1.352초, 평가 9건 중 두 신규 공고가 모두 반환
- 디노랩은 `target_type=법인`을 pass하고 업력·업종은 사용자 질문으로 보존
- SMART-X LAB은 제재·휴폐업·세금·업종·규모를 질문 또는 원문 확인으로 보존

따라서 새 딥분석 결과가 단순 원장 저장에 그치지 않고 `grant_criteria`와 확인 질문을
거쳐 production matcher에 실제 소비되는 것을 확인했다.

## 대기열과 입력 준비

초기 reset 뒤 활성 후보 656건과 실행 중 새로 갱신된 81건을 LLM 호출 없이 봉인·enqueue
했으며 실패는 0건이었다. 최종 활성 공고 664/664가 현재 정책 job을 보유하고 active
lease는 0이다.

입력 준비 기본 회전 배치 4건은 1건을 봉인하고 3건을 `blocked_fetch` 또는
`blocked_conversion`으로 남겼다. conversion poll 9건이 아직 pending이어서 약 590초가
걸렸지만 실행은 성공했다. 반면 20건/소스의 일회성 대형 override는 Cloud Run 900초
상한에 도달했으므로 반복하지 않는다. 기본 2건/소스 회전 배치를 유지한다.

DB timestamp의 마이크로초와 JavaScript `Date`의 밀리초 차이 때문에 이미 관측한
source가 다시 후보로 잡히는 문제를 확인했다. `e304c39`에서 source watermark를
밀리초로 정규화했고 focused test, web typecheck, 운영 DB 재계산으로 후보 `63 → 0`을
확인했다.

## 운영 경계

- 영구 메인 worker: `observe_only`
- 신규 2건 외 Anthropic 호출 없음
- 전체 664건 유료 분석은 실행하지 않음
- Vercel, Scheduler, IAM, secret, Cloudflare 설정 변경 없음
- 원본 dirty worktree의 사용자 변경은 수정하거나 커밋하지 않음

다음 유료 처리는 비용 예산을 정한 뒤 작은 bounded batch로 실행한다. 입력 blocker는
기본 input-preparation 회전 배치와 Ops 사람 검토 종착점에서 처리한다.
