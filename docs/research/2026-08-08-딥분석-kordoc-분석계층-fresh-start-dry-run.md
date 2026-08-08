# 딥분석·Kordoc 분석 계층 fresh-start dry-run

> 실행 시각: 2026-08-08 17:31 KST<br>
> 실행 모드: `fresh_start`<br>
> DB write: 실행하지 않음<br>
> 성격: dirty tree에서 만든 조사용 snapshot. 실제 초기화 승인값으로 사용 불가.

## 결론

현재 DB에서 운영 deep-analysis v25/v16 기준으로 보존할 run은 0건이다. Kordoc DB 결과는
21개 job과 619개 materialized field가 있으나, fresh-start 결정에 따라 모두 초기화
대상이다. 공고·첨부·application surface·문서 preview는 보존할 수 있으며 leased deep 및
Kordoc 작업은 모두 0건이었다.

실제 삭제는 수행하지 않았다. 구현을 커밋한 clean tree에서 dry-run을 다시 만들고,
custom-format DB dump와 새 `stateSha256`를 검토한 뒤 별도 승인해야 한다.

## dry-run 식별자

- schema: `deep-analysis-layer-rebuild-plan-v2`
- git commit: `e44ee49af90896b4152c9cc68db24a7ab5ab948a`
- git dirty: `true`
- implementation SHA-256: `114b5adfd022250a2c43e78ee1c702b5d5e058e693c64238e5595561a97725a4`
- 조사용 state SHA-256: `80c3d371084593981a13fb82e1231c24539c02982b208937422cdd6e71e1160e`
- local plan artifact: `spike-out/deep-analysis/layer-rebuild/20260808T083129Z-80c3d3710845.plan.json`

`gitDirty=true`가 state hash에 포함되어 있다. write는 clean tree만 허용하므로 이 해시로는
실행할 수 없다.

## 보존 대상

| 항목 | 건수 |
|---|---:|
| 공고 | 31,972 |
| 첨부 archive | 5,507 |
| application surface | 3,771 |
| field candidate 이외 document artifact | 13,004 |
| page image artifact | 9,773 |

## 초기화 대상

### 딥분석·매칭 projection

| 항목 | 건수 |
|---|---:|
| deep job | 1,097 |
| deep worker heartbeat | 3,405 |
| deep run | 16 |
| stage receipt | 10,739 |
| 22축 결과 | 352 |
| AI audit | 16 |
| promotion release / item | 13 / 14 |
| criteria | 1,558 |
| 확인 질문 / 답변 | 5 / 2 |
| match state | 844 |
| 랜딩 관측 | 34 |

### Kordoc·빠른 작성 projection

| 항목 | 건수 |
|---|---:|
| precompute job / attempt | 21 / 21 |
| worker heartbeat | 37 |
| field candidate artifact | 21 |
| materialized document field | 619 |
| `fields_ready` surface reset | 15 |

15개 `fields_ready` surface는 모두 page image를 보유하고 있어 실제 write 시
`preview_ready`로 돌아갈 수 있다. 원본과 preview는 삭제하지 않는다.

## 안전 조건 결과

| 조건 | 결과 |
|---|---|
| 보존 run 0건을 명시한 `fresh_start` | PASS |
| leased deep job 0 | PASS |
| leased Kordoc job 0 | PASS |
| leased Kordoc attempt 0 | PASS |
| 기본 `preserve_current` 모드의 0-run 차단 | PASS |
| dirty tree write 차단 | PASS |
| 실제 DB write | 미실행 |
| 복구 dump | 미생성 |

## 다음 승인 체크포인트

1. 이 구현 범위만 커밋해 clean source revision을 만든다.
2. Cloud Run deep worker `observe_only`와 Kordoc/local batch 정지를 다시 확인한다.
3. observe-only heartbeat도 멈추도록 main scheduler를 pause한다.
4. clean tree에서 `--fresh-start` dry-run을 다시 생성한다.
5. runbook에 적힌 전체 테이블을 custom-format으로 dump하고 `pg_restore --list`를 확인한다.
6. 새 state hash, backup SHA-256, 삭제 수를 사람이 승인한다.
7. 그 승인 뒤에만 `--fresh-start --write`를 실행하고 scheduler를 이전 상태로 복구한다.

## 근거

- 실행 절차: [`docs/runbooks/deep-analysis-layer-rebuild.md`](../runbooks/deep-analysis-layer-rebuild.md)
- plan 계약: `apps/web/src/lib/server/deep-analysis/analysisLayerRebuild.ts`
- dry-run/write 구현: `apps/web/src/lib/server/deep-analysis/rebuild-analysis-layer-cli.ts`
