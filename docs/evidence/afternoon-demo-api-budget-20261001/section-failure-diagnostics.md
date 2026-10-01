# 섹션 초안 실패 진단 보강

2026-10-01. 실제 요청 `7f3a2e87-b68a-4632-9922-a1acb0f4ce04`는 담당자가 failed 상태와 reported usage를 관측했다. 당시 공통 `section_generation_failed`로만 저장되어 어떤 검증 조건이 실패했는지는 원문 없이 소급 확정할 수 없다. 이 변경은 이후 요청의 구분을 개선한다.

- 기존 검증 조건은 그대로 두고 형식, 인용 존재, 필수 출처, 회사 출처 종류, 계획 실적화, 계획 출처, 수치·단위, 제어문자, 분량을 각각 안전한 typed error code로 구분했다.
- provider timeout/API 오류/structured output 오류도 분리했다. 메시지는 고정 한국어 문구만 사용해 provider message, raw 응답, 회사 내용, 키를 전파하거나 로그에 남기지 않는다.
- 기존 run의 errorCode 저장 계약을 사용하고, loadWritingSections가 코드에 따른 안내를 proposal.message로 전달한다. unknown/legacy code는 일반 안전 안내로 처리한다.
- 프롬프트에 회사 사실과 계획의 허용 source.kind, 그대로 복사한 quote, quote에 있는 숫자·단위만 유지, 계산·합산·추정 금지를 명시했다. 모델/schema/검증기/maxRetries=0/출력 6000/timeout 45초는 유지했다.
- structured output 실패의 SDK NoObjectGeneratedError에 usage가 있으면 reported로 보존한다. 기존 reported 이벤트를 unavailable로 덮어쓰지 않는 최종화 계약도 유지한다.

공식 SDK 오류 형태를 확인했다: [NoObjectGeneratedError](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-no-object-generated-error), [APICallError](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error). 오류의 raw text/requestBodyValues/responseBody를 사용하지 않는다.

검증: sectionComposer와 writingGuidanceSources 테스트 PASS, 웹 typecheck PASS, 전체 test:writing-context PASS. typed 코드 및 민감한 메시지 미노출, 잘못된 인용·수치·출처의 기존 차단, 프롬프트 제약을 확인했다. 이 변경 검증에서 모델 호출·운영 DB 쓰기·배포·브라우저 변경은 0회다. 실제 API 재요청 결과는 실행 담당자가 별도 비용 원장에서 검증한다.
