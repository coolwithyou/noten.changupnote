# Primary 조건 의미 보존 검증 (2026-10-01)

## 수정 계약

기존 대안 경로·기술 보유·재무 조건 프롬프트 원칙을 유지하고, 추출과 검수 양쪽에 같은 일반 의미 보존 규칙을 추가했다. 특정 공고나 review finding을 프롬프트에 삽입하지 않았다. 실행 계약은 `lab-deep-v30` / `deep-analysis-validator-v24`다.

- 중소기업 OR 스타트업의 대안이나 괄호 범위가 불명확하면 size/업력을 전역 비교값으로 강제하지 않는다. 두 경로 모두 적용되는 업력이 명시되면 구조화를 유지한다. 공통 업력 명시는 공통 중소기업 요건의 근거가 되지 않는다.
- 기술·제품 보유를 업종 태그로 대체하지 않는다.
- 회생 신청 단계와 개인회생만을 대상으로 한 조건을 통합 진행 플래그로 대체하지 않는다. `packages/core/src/disqualification/canonical.ts`의 기존 `rehabilitation_in_progress`는 회생·개인회생 진행을 함께 표현하므로 두 진행 상태를 포함하는 원문은 그대로 허용한다.
- `FinancialHealthCriterionValue`에는 회계연도 비교 필드가 없으므로 직전년도·특정연도 결산 조건을 현재 무연도 값으로 대체하지 않는다.

표현할 수 없는 조건은 검증된 원문 전체를 `text_only`로 보존한다. 구조화 값의 note만으로 누락된 범위를 복구했다고 간주하지 않는다. matcher 계약이나 독립 검수 aggregate, launch admission은 변경하지 않았다.

## 회귀 범위와 결과

검증된 source span을 봉인한 후보에서 OR 순서 양방향, 공통 업력과 size 혼동, 기술 보유, 회생 신청·개인 한정, 결산 연도 손실을 validator가 거부하고 repair로 보내는 것을 검증했다. 같은 원문을 보존한 text_only는 통과한다. 명시 공통 업력, 단순 SME·ICT 업종, 회생·개인회생 진행, 현재 자본잠식의 기존 구조화는 통과한다.

- `pnpm verify:deep-analysis-contract`: PASS (공유 계약, analyzer, validator, repair, 검수, promotion, 매칭 projection, serving 포함).
- `pnpm lab:launch:test`: PASS (current inventory/terminal repair, launch artifacts, primary reuse 및 review repair 회귀).
- completed-analysis-launch-reader suite: 5/5 PASS. normalizer-provenance 및 `pnpm lab:confirmation:test`: PASS.
- `pnpm --filter @cunote/web typecheck`: PASS.

## 과거 완료 영수증과 새 실행 경계

완료 영수증 소비 전용 historical allowlist에 정확한 v29/v23/application-v22 계약을 추가했다. 기존 v28 matching-only 소비를 유지하고, 알 수 없는 prompt·validator·application 버전 및 혼합 계약은 거부한다. 과거 계약을 새 live 실행이나 primary 재사용의 current provenance로 인정하지 않는다.

실제 완료 source manifest `c321820cea65b5df909921498e8e3a199681b03198072127aa7d06098a53bab5`, receipt `c634172a8731ece151dc44544974ad4590bb0d8eab110749359d01fe4be40f19`, 기존 terminal inventory `06e5ffd8bcaf702117a91c9279bc1d3caf2db1b57e83db622d3240fc4f0b2771`을 읽어 메모리 안에서 새 v30/v24 full two-lane manifest를 조립했다. `readTerminalRepairSource` → `buildCurrentInventoryLaunchManifest` → `verifyCurrentInventoryLaunchBinding`에서 sequence 0, 기존 receipt 및 exact material 결속 PASS. 파일을 봉인하거나 모델을 호출하지 않았다.

이 검증은 완료 ancestry와 offline builder 계약 증거다. 현재 DB/input drift와 clean commit의 새 runtime provenance는 실제 정상 terminal prepare에서 재검증해야 한다. 이전 준비본 `5cb5740398850dbe3fd563ee34a0f3c728abc137a62113c36363aec5abaeee20`은 새 계약 실행 권한으로 사용하지 않는다.
