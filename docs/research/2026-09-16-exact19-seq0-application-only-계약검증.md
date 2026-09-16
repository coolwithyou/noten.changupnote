# exact19 seq0 application-only 계약 검증

## 결론

원 exact19의 남은 범위는 seq0 `PBLN_000000000126450` 한 건이다. 별도 current-inventory
exact14 manifest `76105bfd…1fd8a`는 exact19 집계에 포함하지 않는다.

repair4의 완료 primary를 재사용하는 exact1 준비를 기존 인터페이스로 시도했으나, manifest가
저장되기 전에 계약 seam에서 fail-closed했다. grant, 모델 호출, launch, runtime 쓰기는 없었다.

구조화 증거는 [exact19 seq0 application-only 계약 증거](../evidence/deep-analysis/2026-09-16-exact19-seq0-application-only-contract.json)에 있다.

## exact19 정본 결속

- 원 terminal receipt: `1d51dc26…fabd7`, 15 publishable / 2 held / 2 failed.
- repair4 manifest: `d06199dd22c9c81be0b40c3e740fcb003e5456d3b39add5633f55cf015e0b37e`.
- repair4 grant: `bae25afd6ca18bf6d6df66d246c79fb66886537cae7cd79e3db1ebf0808fdf39`.
- repair4 terminal receipt: `dbcdb3ff2897898bd75afe406481c42c248cbce01ad5110ddb77cd9639b18514`,
  3 publishable / 1 held / 0 failed.
- repair4가 원 seq `0,1,2,16`을 대체하므로 최신 exact19 집계는 18통과/1보류/0실패다.

유일한 보류는 repair sequence 0이자 원 exact19 sequence 0인
`PBLN_000000000126450`이다. terminal 상태는 `held`, 신청서 상태는 `review_required`,
field-ready 문서는 0개다.

## 재사용 가능한 primary 증거

receipt가 결속한 run `run-2026-09-16T031737.486Z-3f4ef7`의 artifact SHA는
`55f904ba…c957`로 실제 파일과 일치한다. grant/input/attachment도 repair4 target과 일치한다.

- primary: `publishable`
- matching: `conditional`
- primary repair provenance: 존재, 종료 사유 `accepted`
- primary matching projection: `verified`
- transport/model/prompt: `claude-cli` / `claude-opus-5` / `lab-deep-v28`

따라서 primary 데이터 자체는 application-only 재사용 조건을 충족한다. 남은 보류는 신청서
field analysis이며, primary 모델을 반복할 근거가 아니다.

## 막힌 계약 seam

prepare 인터페이스에 repair inventory `40b253e1…5b00`, repair4 manifest/grant/receipt,
`--selected-sequences=0 --application-only --concurrency=1`을 전달했다. package runtime freshness는
통과했고 입력·첨부와 completed receipt 결속도 통과했다.

이후 `launch-batch-production.ts`의 builder는 완료 run의 primary reuse를 만들면서 repair4의
`terminalRepair` ancestry를 새 manifest에도 보존한다. 그러나 `launch-batch-artifacts.ts`의
normalizer는 `analysisMode=application_only`일 때 `terminalRepair !== undefined`를 명시적으로
거부한다. 결과는 `application-only primary 재사용 결속이 잘못됐습니다.` exit 1이다.

즉 exact1 선택이나 primary receipt가 불충분한 것이 아니라,
`terminal-repair completed launch → application-only child manifest` 조합을 현재 manifest
인터페이스가 표현하지 못한다. 이 seam을 수정하지 않고 우회 manifest를 만들지 않았다.

## 보존·금지 확인

- 새 exact1 manifest: 없음
- 새 grant/status/receipt: 없음
- 모델 호출/launch/runtime write: 0
- 기존 성공 receipt와 manifest 변경: 없음
- 별도 exact14 `76105bfd…1fd8a`: content SHA 일치, grant/status/receipt 0으로 보존
