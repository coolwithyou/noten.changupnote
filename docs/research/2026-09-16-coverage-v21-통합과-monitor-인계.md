# coverage v21 공유 변경 통합과 monitor 사건 인계

## 소유와 사건 범위

사용자 인계에 따라 이 세션이 공유 변경의 단독 소유를 인수했다. 기존 변경 7파일과 `field-coverage.test.ts`를 함께 검토했고, 필요한 실제 문서 분석·RHWP 편집기 연결 및 역사 receipt 호환성을 통합했다. 별도 세션의 9월15일 미추적 문서11개와 monitor 도구2개는 보존한다.

처리 fingerprint는 `b6e830ff6091f8c5257e03e01f03fc81c3bbe0414c8cd49962b44a8f2a000125`다. exact14 manifest `984e8db4b0c95a5f08a0fd72310f8dfaa3ea462386d93ed5882b2a750272bacb`, grant `d9ddd12a8b06a39f3ea811bd78c02264ce225c46279c907ea9470d8e8507d2c1`, receipt `462c655789a269a8c17312216c9331dbf2d4cdcf17ec15fb21efc9cae6a8705e`의 14 held/0 failed는 그대로다. primary는 전부 publishable이고 matching ready/conditional, application은 review_required다.

이번 작업은 해당 사건의 원인 수정·코드 통합·오프라인 검증이다. 모델 재실행, primary 반복 실행, 분석 결과 승격, 배포, Cloudflare 변경은 수행하지 않는다.

## 통합한 변경

- planner와 coverage가 같은 미확정 빈칸 판정을 사용한다. claude-cli의 기존 점수 구간 밖이어도 coverage 미확정이면 검토 대상에 포함한다. 구조상 확정 제외된 후보는 계속 차단하며 모델 입력·거절 확정 임계 0.75를 완화하지 않는다.
- `analyzeRoundtripDocument`가 coverage에 실제 파싱 블록을 전달한다. 짧은 라벨은 LLM input/0.75 이상, label·값 셀·동명 occurrence·원문 행/열이 일치할 때만 통과한다. 병합 covered 셀, 값 변경, occurrence 변경, NaN confidence, 기호 제거에 따른 동명 충돌은 보류한다.
- RHWP도 짧은 라벨의 일반 부분 문자열 검색을 사용하지 않는다. 전체 페이지의 whole-cell hit를 구조 순서로 정렬한 뒤 source-bound occurrence와 행·열을 함께 확인하고, 독립된 바로 오른쪽 셀만 연결한다. 따라서 coverage만 통과하고 편집기는 한 글자를 무조건 제외하던 불일치를 해소한다.
- 모델 판정 후 contextual 입력으로 대체된 후보는 대체 신호만으로 종결하지 않는다. 현재 추천되는 대체 후보가 동일 block과 인접 row, 연결된 label로 존재해야 한다. 이전 추출 단계의 RHWP 대체 신호로 현재 uncertain 판정을 덮지 않는다.
- material 계약은 `kordoc-application-roundtrip-v21`이다. v20의 완료된 exact18 기록은 원 ancestry를 확인하는 오프라인 reader에서만 허용한다. v20 manifest는 현행 live normalizer에서 계속 거부한다.

## 오프라인 재생과 검증

실제 완료18 artifact의 해시를 고정해 선택 predicate를 재생했다. 추가 후보는 전체 문서에서 **235개**, 신청서 역할 문서에서 **228개**, 참고문서에서 **7개**다. 참고문서는 실제 신청서 planner 호출 대상이 아니므로 235개를 새 모델 요청 수로 해석하지 않는다. 구조상 제외 후보의 재활성화는 **0개**다.

이는 검토 누락 경로를 고친 증거이며, 해당 후보의 입력 여부를 새 모델로 확정한 결과가 아니다. readiness를 변경하지 않았다. 기존 원 artifact62개 SHA를 재검증했고, product reader의 receipt3개/target18개/run18개 ancestry·grant/input/attachment 결속도 통과했다.

`lab:roundtrip:test`, `lab:launch:test`, `lab:release:test`, `pnpm test`가 동일 소스에서 모두 통과했다. 전체 gate는 typecheck와 RHWP/document-agent 검증을 포함한다.

최종 gate와 ack 결과는 [검증 증거](../evidence/deep-analysis/2026-09-16-coverage-v21-integration.json)에 기록한다. 새 코드의 실제 모델 품질, 로그인 작성·다운로드, 수정된 짧은 라벨의 실제 HWP 저장·한컴 시각 확인은 미실행이다. 짧은 라벨 연결은 source IR 회귀와 native anchor fixture로 검증한다.

runtime 재조회(2026-09-16 14:16:33 UTC)는 `paused`, generation427, owner/expiry null, active deep/application lease 각각0이다. 실행 제어행은 수정하지 않았다.

## 다음 실행 경계

새 material v21에 대한 exact application-only manifest와 사용자 승인 전에는 live 모델을 실행하지 않는다. 기존 primary와 그 원문/input/attachment 및 실행 계약이 검증된 receipt를 재사용해야 한다. 현재 primary+application launch를 편의상 다시 돌리는 것은 허용하지 않는다.

이번 통합은 application-only batch 실행 경로를 새로 구현하거나 새 manifest를 발급한 작업이 아니다. 후속 준비자는 해당 실행 경로가 primary 모델을 호출하지 않는다는 계약·검증과 exact 원천 결속을 먼저 확보해야 한다. 실패한 primary를 성공 결과처럼 재사용하거나, exact14 밖의 대상을 묵시적으로 편입하지 않는다. 준비를 완료해도 새로운 live 승인으로 간주하지 않는다.

## pending 처리

최종 검증 후 위 fingerprint만 ack했고 `acknowledged`, exit3, pending 없음으로 확인했다. ack는 사건 수신·원인 분석·공유 수정 통합·오프라인 검증의 완료를 의미한다. 14건의 application 품질 보류가 해결됐거나 서비스 오픈이 끝났다는 뜻은 아니다.
