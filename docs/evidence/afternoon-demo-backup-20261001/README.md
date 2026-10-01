# 오후 시연 대체 후보 — 광명 온라인 마케팅

2026-10-01 읽기 조사. 기존 싱가포르 공고의 primary/application 구조 수정이 우선이며 이 후보를
병렬로 live 실행하지 않는다. 이 기록은 정상 단건 준비에 사용할 대체 후보이지 완성 분석 결과가 아니다.

## 현재 대상과 원문 조건

- grantId: `9c257682-6b48-4e5f-9c11-f6ac0529eb80`
- source: `bizinfo`, sourceId: `PBLN_000000000126770`
- 제목: `[경기] 광명시 2026년 사회연대경제기업 맞춤형 온라인 마케팅 지원사업 참여기업 모집 공고(사회연대경제 유통 및 판로사업)`
- DB 신청기간: 2026-09-21 ~ 2026-10-08. 첨부 공고 원문의 접수 마감은 **2026-10-08 18:00 KST**.
- 공고일 기준 광명시를 본점으로 하는 사회연대경제기업 대상이다. (예비)사회적기업,
  마을기업, (사회적)협동조합, 자활기업에 해당해야 한다.
- 사업기간 중 콘텐츠 제작·광고 운영·성과측정에 적극적으로 참여할 수 있어야 한다.
- 2025년 광명시 사회적경제기업 온라인 홍보지원사업 참여기업은 제외한다. 당해연도 동일 내용의
  정부·지자체·공공기관 지원을 받은 경우에도 신청자격을 제한한다.
- 지정 신청서·개인정보 동의서, 최근 1개월 이내 발급 사업자등록증·국세/지방세 완납증명서를 요구한다.

이 조건은 DB/R2 보관 공고 원문에서 확인했다. 단순한 소프트웨어 업종 정보만으로 적격이라고
주장하지 않는다. 현재 시연 회사가 광명 본점·사회연대경제 자격을 갖추지 않았다면 해당 공고는
조건 불일치 사례로 사용하거나, 명시적으로 표시한 별도 시연 회사를 사용해야 한다.

## 물리 원문과 입력 결속

현재 `open/visible`·신청기간·중복 대표성 조건을 통과한 466건에서 표준 `scope=all` 역사
1009개 grantId(신규 싱가포르 준비 포함)를 제외했다. 남은 132건 중 이 후보가 포함된다.
임의 역사 필터나 판정 우회를 적용하지 않았다.

| 원문 HWPX | bytes | 실제 R2 bytes SHA-256 |
|---|---:|---|
| `[서식1]참여기업신청서.hwpx` | 44194 | `164eb2aeb5821971f4ca0340feac193ddeef99c7acc502e4f6de6f6bf75c5719` |
| `공고문_맞춤형 온라인 마케팅.hwpx` | 80231 | `e4ec60c910c1fbea40ef94b68537a64349a31a74882fd45dc2e328ff9c393db1` |
| `【서식2】개인정보수집동의서.hwpx` | 64629 | `3852d17cfb30b5bb62d9b80bf4cb1752df4f104a811fa88391e984c33115f444` |

세 파일 모두 실제 R2 원본 다운로드 bytes의 SHA가 DB archive 값과 일치했다.
`prepareLabAnalysis`가 모델 호출 없이 현행 입력을 조립했으며 총 12173자다.

- input SHA: `91a55bea220ba09d49ca911dfa24590216fe54755d3bbc040cfba25732818f8d`
- attachment manifest SHA: `a5191ad7291b93f8230a61909c957fa20037d0cbe9bd13aa6b2648f49fe906ce`

## 실제 공용 문서 분석기 오프라인 probe

`analyzeRoundtripDocument`에 실제 원본 bytes를 전달했다. `apiKey=null`, `transport=api`,
`fetchImpl`은 호출되면 즉시 예외를 내도록 지정했다. 이 경로는 결정적 parsing/후보/위치 검증만
수행했으며 구독/API 모델 요청·DB/R2 쓰기는 0회다.

- 신청서: `application_form`, 24개 필드, LLM 경계 후보 2개, accepted input 15개,
  unresolved 1개(`주요사업`), structural warning 0개, anchor unready 0개.
- 개인정보 동의서: `evidence`, accepted input 4개, unresolved/structural warning 0개,
  결정적 coverage `complete`.
- 공고문: `announcement`. 문서 내 일정 표에서 후보·구조 경고가 있으므로 공고문을 신청서 입력
  대상으로 오인하면 안 된다. 상세 값은 [기계 판독 증거](./gwangmyeong-readonly.json)에 보존했다.

싱가포르 원본보다 신청서 구조가 단순하고 미해결 경계가 적어 대체 후보로 유망하다.
그러나 신청서 coverage는 현재 `partial`이다. **LLM 2개 경계 판정과 남은 1개 입력의 해소를
실행하지 않았으므로 v22 application 완료·release/promotion 가능을 증명하지 않는다.**
조사 중 원래 작업 브랜치 HEAD는 `ded8072`였고 다른 담당자가 공용 field coverage를 개선 중이므로
해당 개선이 커밋되면 원본에 대한 probe를 다시 확인하고 표준 준비에서 현행 provenance를 봉인한다.

## 정상 단건 준비와 인수 명령

공용 수정의 검증·커밋과 package freshness 완료 후 동일 체크아웃에서 다음 표준 명령을 사용한다.
이 명령은 DB/R2 읽기와 로컬 불변 manifest 준비만 수행하며 live 모델 실행 권한을 발급하지 않는다.

```sh
pnpm lab:launch:prepare-current -- \
  --grant-ids=9c257682-6b48-4e5f-9c11-f6ac0529eb80 \
  --concurrency=1 \
  --analysis-mode=primary_and_application
```

인수 조건은 exact target 1개, 정상 `open-visible-current-period-unseen-v1`, 현행 package/prompt/validator
runtime, 현재 원문·첨부 SHA 결속, `modelCalls=0`, `serviceWrites=0`,
`liveExecutionAuthorized=false`다. 위 SHA는 관측 증거이며 새 prepare 출력과 다르면 이전 관측값으로
덮어쓰거나 임의 승인하지 않는다.

이 문서 작성 중 표준 prepare 명령은 실행하지 않았다. 해당 명령을 실제 실행해 봉인한 manifest
전체의 사용 승인 범위를 확인한 뒤 root가 기존 Gate R 경로의 grant/launch를 수행한다. 이 조사
기록 자체는 grant·lease·실행·release·운영 승격 권한이 아니다.

## 검증 영수증

- 현재 모집단/전체 역사: `readCurrentEligibleMatchingCandidates` +
  `readDeepRepairHistoricalGrantIds({scope:'all'})` 실제 실행.
- 입력 조립: `prepareLabAnalysis` 실제 실행.
- 원문 SHA: `createR2ObjectStorageFromEnv().getObjectBytes` + SHA-256 실제 대조.
- 구조 probe: 공용 `analyzeRoundtripDocument` 실제 실행, 모델 경로 차단.
- 로컬 조사 출력: `spike-out/afternoon-backup-{candidates,inputs,probe}.json`.
- 문서·JSON 검증: JSON 파싱, 상대 링크 존재 및 `git diff --check` 확인.
