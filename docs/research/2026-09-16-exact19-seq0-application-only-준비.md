# exact19 seq0 application-only 준비

## 결론

원 exact19에서 남은 보류는 seq0 `PBLN_000000000126450` 한 건이다. 별도 current-inventory
exact14 manifest `76105bfd…1fd8a`는 이 범위에 포함하지 않는다.

terminal-repair 완료 launch에서 검증된 primary를 재사용하는 application-only 계약 seam을
수정하고 exact1 manifest `86fec5bbe7de00bc584f9246dcf59b6bc68e0631c6b2afa59b95aefcdeaa5dd7`을
봉인했다. 새 grant, 모델 호출, launch, runtime 쓰기는 없으며 사용자 exact 승인 전 상태다.

구조화 증거는 [exact19 seq0 application-only 준비 증거](../evidence/deep-analysis/2026-09-16-exact19-seq0-application-only-preparation.json)에 있다.

## 범위와 ancestry

- 최신 exact19 집계: 18통과 / 1보류 / 0실패.
- repair inventory: `40b253e1…5b00`.
- repair4 manifest/grant/receipt: `d06199dd…e0b37e` / `bae25afd…8fdf39` /
  `dbcdb3ff…b18514`.
- 선택 대상: repair sequence 0, 원 exact19 sequence 0, grant
  `6176af74-cbb0-44d9-b577-ce1e5345914d`.
- terminal-repair 원 ancestry: manifest `8f3374df…4924`, grant `ebbe295e…f28`,
  receipt `1d51dc26…fabd7`, original sequences `0,1,2,16`.

새 manifest는 이 ancestry를 그대로 보존하며 `analysisMode=application_only`,
Kordoc `v21`, CLI Max/opus-5/concurrency1이다.

## 수정한 seam

commit `8afeb1b3845dbeca87a2ae8146414654f0d7ff70`은 application-only normalizer의
`terminalRepair` blanket 거부만 제거했다. 기존 interface가 계속 아래를 강제한다.

- `current_inventory`와 completed launch 필수.
- terminal-repair completed source는 v2만 허용.
- v2 선택 sequence 수와 target 수 일치.
- 모든 target에 exact primary reuse 결속.
- 일반 launch의 primary reuse, review repair, Kordoc reuse 혼합 거부.
- grant/실행 직전 inventory, receipt, run bytes, input/attachment, primary 품질 재검증.

focused current-inventory suite 26건, `pnpm lab:launch:test`의 주요 26+8+18건 및 부속 gate,
web typecheck, package runtime freshness가 모두 통과했다.

## 본문·신청서 상태 분리

재사용 본문 run `run-2026-09-16T031737.486Z-3f4ef7`은 artifact SHA
`55f904ba…c957`가 일치하고 primary publishable, matching conditional, repair provenance
accepted, matching projection verified다. 본문 모델은 다시 호출하지 않는다.

기존 신청서 결과는 `review_required`, field-ready 문서 0개다. v21 live 결과는 아직 없으므로
신청서 readiness를 승격하지 않는다.

## 실행 경계

14:52:43 UTC 읽기 전용 runtime snapshot은 paused/generation427, owner·expiry 없음,
active deep/application lease 각각0이다. manifest를 가리키는 grant/status/receipt도 각각0이다.

다음 단계는 manifest `86fec5bb…5dd7`의 exact 범위를 사용자가 승인한 뒤 grant를 한 번 기록하고
application-only 단건을 실행하는 것이다. terminal receipt/run, 본문 재사용 불변, 신청서 상태와
오류 근거, lease 반환을 검증하기 전 운영 완료를 선언하지 않는다.
