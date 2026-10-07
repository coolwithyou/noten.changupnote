# 섹션 초안 실패 진단 보강

2026-10-01. 실제 요청 `7f3a2e87-b68a-4632-9922-a1acb0f4ce04`는 담당자가 failed 상태와 reported usage를 관측했다. 당시 공통 `section_generation_failed`로만 저장되어 어떤 검증 조건이 실패했는지는 원문 없이 소급 확정할 수 없다. 이 변경은 이후 요청의 구분을 개선한다.

- 기존 검증 조건은 그대로 두고 형식, 인용 존재, 필수 출처, 회사 출처 종류, 계획 실적화, 계획 출처, 수치·단위, 제어문자, 분량을 각각 안전한 typed error code로 구분했다.
- provider timeout/API 오류/structured output 오류도 분리했다. 메시지는 고정 한국어 문구만 사용해 provider message, raw 응답, 회사 내용, 키를 전파하거나 로그에 남기지 않는다.
- 기존 run의 errorCode 저장 계약을 사용하고, loadWritingSections가 코드에 따른 안내를 proposal.message로 전달한다. unknown/legacy code는 일반 안전 안내로 처리한다.
- 프롬프트에 회사 사실과 계획의 허용 source.kind, 그대로 복사한 quote, quote에 있는 숫자·단위만 유지, 계산·합산·추정 금지를 명시했다. 모델/schema/검증기/maxRetries=0/출력 6000/timeout 45초는 유지했다.
- structured output 실패의 SDK NoObjectGeneratedError에 usage가 있으면 reported로 보존한다. 기존 reported 이벤트를 unavailable로 덮어쓰지 않는 최종화 계약도 유지한다.

공식 SDK 오류 형태를 확인했다: [NoObjectGeneratedError](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-no-object-generated-error), [APICallError](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error). 오류의 raw text/requestBodyValues/responseBody를 사용하지 않는다.

검증: sectionComposer와 writingGuidanceSources 테스트 PASS, 웹 typecheck PASS, 전체 test:writing-context PASS. typed 코드 및 민감한 메시지 미노출, 잘못된 인용·수치·출처의 기존 차단, 프롬프트 제약을 확인했다. 이 변경 검증에서 모델 호출·운영 DB 쓰기·배포·브라우저 변경은 0회다. 실제 API 재요청 결과는 실행 담당자가 별도 비용 원장에서 검증한다.

## 줄바꿈 원문 인용의 호출 계약 수정

후속 요청 `97c5fc64-6ee9-4beb-851b-8e20bdc64b31`은 담당자가 `section_evidence_invalid`를 관측했다. 응답 원문이 저장되지 않아 그 요청의 정확한 실패 인용은 소급 확정하지 않는다.

소스에서 재현 가능한 결함을 확인했다. `quoteExists(quote, normalizedFull)`은 quote의 공백만 정규화하고 이미 정규화된 corpus를 받는 계약이다. 기존 sectionComposer는 raw `source.content`를 전달했다. 그러므로 원문에서 그대로 복사한 줄바꿈·탭·연속 공백 인용도 정규화한 quote와 raw corpus가 달라 거부됐다. 다른 documentAgentPrompt/fieldSuggest 호출은 corpus를 `normalizeWs`로 정규화하고 있었다.

sectionComposer도 동일한 corpus 정규화 계약을 사용하도록 수정했다. prompt와 검증에 쓰는 sourceId/content는 같은 sources 배열이며 회사 자료는 원문 SHA 검증을 통과한 내용이다. prompt 단계 별도 절단·ID 재작성은 없다. 원문 내용·SHA·sourceId는 수정하지 않고 부분문자열 비교 시에만 공백을 정규화한다. 잘못된 sourceId, 없는 인용, 개작 인용의 차단과 모든 출처·수치 검증을 유지한다.

회귀 검증은 company_material/application_plan/current_document 각각의 CRLF·탭·연속 공백·빈 줄을 포함한 정확한 인용 승인과 개작·오인용·다른 sourceId 거부를 확인했다. `pnpm test:writing-context` 전체와 `pnpm --filter @cunote/web typecheck` PASS. 모델·운영 DB 쓰기·배포·브라우저 변경 0회. 운영 재요청의 결과는 별도 검증 대상이다.

## 서버 원문 후보 선택으로 인용 생성 제거

운영 후속 `546224b2-d4a0-41a5-b574-7a1e84c67d52`도 담당자가 evidence_invalid를 관측했다. raw 응답이 없어 sourceId 오타/인용 개작 중 어느 원인인지는 소급 확정하지 않는다.

모델은 이제 긴 출처 ID와 인용문을 생성하지 않고 서버 후보 evidenceId만 선택한다. 서버는 원문 줄과 한국어 문장을 분할하고 500 UTF-16자 이하 exact substring 후보를 만든다. 긴 문장은 공백 경계를 우선해 분할하고 surrogate pair를 보존한다. ID는 sourceId/SHA/offset/quote에서 결정하는 짧은 해시다. 모델 schema의 enum은 이번 요청 후보만 허용한다. 전체 source.content와 해당 kind/title/candidate quotes는 prompt에 유지한다.

서버는 선택 ID를 원래 sourceId+quote로 복원한 뒤 기존 verifyWritingComposition의 모든 출처·계획·수치·분량 검증을 그대로 실행한다. public WritingComposition, 저장/UI, usage 버전 writing-section-v1, 모델/6000/45초/maxRetries0 계약은 변경하지 않는다. 빈 후보는 empty evidenceIds만 허용하고 없는 후보를 받아들이지 않는다.

공식 [AI SDK structured data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)와 [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)를 확인했다. string enum은 지원되지만 enum 개수의 수치 상한은 공개되지 않았다. provider internal grammar complexity 제한은 존재한다. 이번 schema는 optional/union/strict tools 0개이며 서버 검증은 항상 수행한다. 실제 provider schema admission은 재요청으로 별도 확인한다.

테스트: deterministic exact offset/quote, 한국어·Unicode 긴 원문, unknown unit, 잘못된 kind, 계획 실적화, 조작 수치, 빈 후보를 검증했다. 전체 writing suite/typecheck/production build PASS (기존 NFT tracing warning 2개). 검증 중 모델 호출/운영 쓰기/배포/브라우저 변경 0회.

## 문단 종류별 생성 출처 제약

담당자가 후보 ID 선택 적용 후 실제 초안에서 `section_company_source_invalid`를 관측했다. 서버 복원 인용은 검증되었지만 회사 사실에 공고나 계획 후보를 선택한 경우가 여전히 거부될 수 있다. 이 정책을 생성 schema에도 반영했다.

- company_fact: company_profile/company_material/current_document 중 기존 미래 계획 표현 정규식에 걸리지 않는 후보만 enum에 넣고 1~5개 선택을 요구한다.
- plan: application_plan/current_document 후보 중 primaryEvidenceId 하나를 필수로 선택한다. 모든 후보 중 supportingEvidenceIds 0~4개를 추가할 수 있다.
- proposal: 모든 후보 중 evidenceIds 0~5개를 선택한다.
- 적격 근거가 없는 회사 사실·계획은 생성 schema에서 해당 kind 분기를 제외한다. 빈 후보도 proposal/질문 형식은 허용한다.

schema는 provider-supported anyOf를 사용하는 z.union이며 테스트에서 JSON Schema 변환을 확인했다. union parameter 1개, optional 0개로 공식 한도 안이다. prompt에도 후보의 allowedForCompanyFact/allowedForPlanPrimary와 문단별 필드 형식을 명시한다. 서버는 primary+supporting을 기존 public evidence 배열로 복원하고 원래 verifyWritingComposition의 모든 검증을 유지한다. 저장/API/UI public 계약과 모델·usage 버전·토큰·timeout은 그대로다.

회귀 테스트는 잘못된 kind, 필수 primary 누락, 빈 회사 근거, 적격 후보 없는 kind, unknown unit, 기존 plan-as-fact 및 수치 조작 차단을 확인했다. 전체 writing suite/typecheck/동일 최종 소스 production build PASS (기존 NFT tracing warning 2개). 이 검증은 모델 호출·운영 쓰기·브라우저 변경 없이 수행했다.

## 단건 응답으로 확인한 계획 항목 맥락 유실

담당자가 실행한 단건 진단 `68df727d-9a16-41bd-91fd-a2928dacb553`의 비공개 응답으로 원인을 확인했다. 세 번째 plan 문단에서 2026년이 누락된 근거를 선택해 quantity 검증이 거부했다. 선택한 일정 문장은 같은 185자 추진 일정 항목에서 분할되면서 앞 문장의 연도가 분리된 후보였다. 전체 출처에 연도는 존재했다. B2B 숫자는 선택한 인용에도 있어 이 실패의 원인이 아니었다.

application_plan 자료의 500자 이하 항목 줄은 원문 그대로 단일 근거 후보로 보존한다. 연도·기간·조건을 항목의 후속 문장과 함께 전달한다. 500자를 초과하면 기존 문장/청크 전략으로 돌아간다. 회사 자료·프로필·현재 문서의 문장 전략, source SHA/ID, 모든 검증기·스키마·모델·public 저장 계약은 유지한다.

기존 응답의 텍스트·kind 4문단은 그대로 두고, 옛 인용 후보를 동일 출처 offset을 포함하는 새 항목 후보로 오프라인 재결속해 전체 기존 검증 PASS를 확인했다. 원래 구성은 quantity_mismatch를 재현했다. 모든 원문 SHA가 유지되고 후보 수는 85→71이다. [안전한 증거 요약](section-plan-context-offline-proof.json)은 해시·개수·결과만 보존하며 원문 응답은 private 0600 파일에만 있다. 이 증거는 새 모델 응답이나 운영 저장 완료를 의미하지 않는다.

185자 일정 항목의 연도+후속 일정, 500/300/200 예산·조건, 없는 2028년 거부, 500자 초과 Unicode fallback, 회사 사실/미래 계획 혼합 차단을 회귀 검증했다. 전체 writing suite/typecheck 및 최종 production build PASS (기존 NFT tracing warning 3개). 이 수정·오프라인 검증에서 모델 호출·운영 쓰기·브라우저 변경은 0회다.
