# 매칭·RHWP·LLM 품질 개선 실행 기록

2026-09-10. 상태: 매칭·RHWP·실제 LLM 제안 적용/저장/재열기/Undo의 표본 흐름 통과.
필드 분석이 연결되지 않은 양식의 자동 입력·항목별 작성은 별도 보완이 남는다.
아래 기록은 단계별 증거이며, 추가 배치·서비스 게시 완료 기록이 아니다.

## 범위와 개발 순서

사용자 승인: [품질·처리 효율 개선 계획](../../plans/2026-09-10-대량분석-품질과-처리효율-개선계획.md)을
실제 사용자 흐름 중심으로 구현한다. 구현은 `gpt-5.6-sol` / `xhigh`, 주 에이전트는 범위 조정과
통합 검증을 담당한다. 새로운 범용 엔진보다 재현된 결함을 기존 공용 구현에서 수정한다.

1. 매칭: seq 35 정규화 모순, seq 11 OR 결속, seq 27 역할 오탐을 수정하고 정상 조건을 보존한다.
   점수표·대안 자격은 원문 판정 후 기존 계약으로 안전하게 표현 가능한 범위만 수정한다.
2. 신청서: 합본 양식·입력 오탐/누락·단일 선택을 공용 `application-analysis`에서 수정한다.
   명확하지 않은 위치에 쓰거나 완료 기준을 완화하지 않는다.
3. LLM: 현재 항목·회사 정보·사용자 보강 답변이 제안과 적용에 이어지는 기존 경로를 확인한다.
   실패를 재현한 부분만 고치고 현재 필드 연결·문서 revision·저장·되돌리기를 재사용한다.
4. 각 변경의 관련 회귀를 실행한 뒤 같은 최종 소스에서 필요한 집계 gate를 실행한다.
5. 실제 로그인 사용자 흐름을 검증한 결과와 자동 검증 결과를 구분한다.

HML 신규 지원, 범용 점수 계산, 필드 단위 재실행 그래프, 문서 동시성 확대는 이번 첫 구현
묶음에 자동 포함하지 않는다. 실제 공급 대상의 차단 원인과 절감 효과를 확인한 뒤 우선순위를 정한다.

## 인수할 사용자 흐름

| 흐름 | 필요한 확인 | 현재 증거 |
| --- | --- | --- |
| 사업자 매칭 | 통과·탈락·확인 필요와 원문 근거 일치, 정보/확인질문 변경 후 결과 갱신 | 미실행 |
| 정상 HWP/HWPX | 열기 → 항목 선택 → 편집 → 저장 → 다운로드 → 다시 열기 | 현재 Lab fill 새 저장·재파싱 각 1건 통과; Studio 전체 흐름 미실행 |
| 합본·부속 양식 | 주 신청서와 필수 부속 서식 발견, 안내문 입력 오탐 제거 | 합본 역할·주양식 우선 회귀 통과; seq 11 부속 필드 일부 미해결 |
| 선택형 항목 | 정확한 질문과 보기, 택1 제약, 실제 다중선택 보존 | Lab 회귀 통과; RHWP 실제 화면 미검증 |
| LLM 도움 | 현재 항목에 맞는 문안, 부족한 사실 질문, 답변 반영, 사용자 선택 후 적용 | profile 인용·추가 질문 렌더 회귀 통과; 실제 모델 미실행 |
| 문서 보존 | 수동 작성 내용·다른 위치·서식 보존, 저장 상태와 재열기 일치 | 이번 변경 기준 미실행 |

개발 시작 시 `127.0.0.1:4010` 및 `4011` listener가 없었다. 저장소 `AGENTS.md`에 따라 사용자에게
`pnpm dev:web` 실행을 요청했고 구현·자동 검증을 계속한다. 역사 UI 전용 시나리오의 제한을
이번에 승인된 일반 구현 범위로 확대하지 않는다.

## 현재 계약 대조

- Lab `application-roundtrip/field-planner.ts`는 제품 공용 `application-analysis/field-planner`를
  재노출한다. 별도 Lab 구현을 추가하지 않는다.
- 현재 release CLI는 `--require-kordoc`을 폐기된 옵션으로 거부한다. 역사 명령을 실행하지 않으며
  정식 launch의 현행 필드 분석·release admission 요구는 유지한다.
- `publishable`, Lab 저장, RHWP 화면 인수, 실제 LLM 품질, 서비스 게시를 서로 대체 증거로 쓰지 않는다.
- 변경된 실행 계약의 신규 모델 실행은 exact manifest 준비·승인 경계를 따른다.
  이번 코드 구현만으로 기존 immutable 분석 receipt나 서비스 DB를 수정하지 않는다.

## 검증 기록

담당 구현 에이전트의 관련 검증:

| 범위 | 실행 결과 |
| --- | --- |
| 분석 의미 | analyzer / validator / repair, contracts / qualityPreflight, audit / auditAdjudication 통과 |
| 매칭·실험 회귀 | `pnpm test:matching-unit`, `pnpm lab:experiment:test` 통과 |
| 신청서 | `pnpm lab:roundtrip:test`, productSeams / launch-status / launch-batch 통과 |
| 선택 해제 | 기존 선택을 빈 배열로 해제하는 회귀 보강 후 editable-regions 단일 테스트 재실행 통과 |
| LLM·제품 연결 | `pnpm test:document-agent`, `pnpm test:apply-workspace` 통과 |
| 통합 gate | 첫 `pnpm test`는 타입 import 누락과 테스트의 잘못된 seal 속성 참조로 실패. 두 곳 수정 후 재실행 exit 0 |
| 최종 소스 보완 | gate 실행 중 변경된 파일은 `fill.ts`의 선택 개수 비교 한 줄뿐. 공개 fill 함수의 빈 선택/두 선택 검증과 최종 `pnpm --filter @cunote/web typecheck` exit 0으로 보완 |
| 변경 보존 | `git diff --check` 통과. 최종 제품·테스트 소스 23개 해시 일치 및 기존 dirty 3파일 해시 보존 확인 |

통합 gate의 세부 검증 92개 pnpm script 블록에는 package build/typecheck, 제품 여정,
RHWP/document agent/apply workspace, 공급 계약, 라우트·권한 등 프로젝트 집계 검사가 포함된다.
테스트 수 92개라는 뜻은 아니다. 이 변경에는 DB schema·lease·게시 쓰기 계약 변경이 없어
별도 `test:product-postgres`는 실행하지 않았다.

로컬 상세 로그:
`/var/folders/90/3_v527vj59d6wv2ql7_k6rzm0000gn/T/cunote-quality-review-bmum9q4q/`의
`pnpm-test.log`(첫 실패), `pnpm-test-final.log`(통합 통과), `web-typecheck-final.log`(마지막 보완),
`verification-final-source.json`(최종 소스 해시). raw 로그와 원문은 Git에 추가하지 않는다.

과거 seq 9 HWPX / seq 21 HWP 저장본의 SHA를 관측값과 대조했고, 현재 파서로 재파싱해
가상값 일치·warning 0을 확인했다. 이는 기존 저장본 재확인이며 새 코드의 저장·Studio 인수를
대신하지 않는다.

이어서 현재 `fillApplicationRoundtrip` 경로로 원본을 읽어 새 저장본을 만들었다. 모델/DB 호출 없이
R2 원본은 읽기만 했으며 기존 원문·fill artifact를 덮어쓰지 않았다.

| 사례 | 새 fill ID | 저장·재파싱 결과 |
| --- | --- | --- |
| seq 9 HWPX | `fill-2026-09-10T064017.749Z-c9a594` | 가상값 1/1, allVerified, patchApplied 1, skipped 0, warning 0 |
| seq 21 HWP | `fill-2026-09-10T064018.561Z-c1c4d5` | 가상값 1/1, allVerified, patchApplied 1, skipped 0, warning 0; 87문단 전후 무결성 issue 0 |

이는 현재 Lab fill 경로의 저장 증거다. 새로운 모든 필드 분류의 정답이나 Studio 브라우저 저장
완료를 뜻하지 않는다. 선택 해제의 실제 호출 경로 점검에서 발견한 Lab fill 입구의 단일 선택
개수 검사도 공용 편집 계획과 일치하도록 보정했다. 공개 함수의 검증 단계에서 빈 선택은
`single_field_choice_required` 없이 `no_changed_values`까지 진행하며 두 선택은 계속 거부되는
것을 모델·DB·R2 호출 없이 확인했다.

## 구현 결과와 제한

- seq 35: 대상 분류와 개인/법인 구분을 혼동한 목록 설명을 정규화한다. 별도 자격·예외가 섞인
  설명은 삭제하지 않고 validator 검토에 남긴다. raw 원모델 응답의 open/closed 값은 보존돼 있지
  않아 두 raw 값 변형 회귀는 합성이다. 정규화 멱등성·정상 열린 목록·법적 형태 제한을 대조했다.
- seq 11 OR: `other/text_only` 한 criterion에 관련 축을 명시 결속한다. 같은 축이라는 이유만으로
  별도 공통 자격을 막는 신규 guard는 검토 후 제외했다.
- seq 27 / 19: 제조기업을 별도 역할로 오인하는 검사를 고쳤으며 실제 트랙 한정 조건의 전역화
  차단은 보존했다.
- seq 2 / 3 점수표: 현행 계약이 점수·배타 구간을 표현하지 못하는 경우 독립 숫자 preferred로
  통과시키지 않고 원문 점수표를 preferred/text_only로 보존하도록 했다. 점수 계산기는 추가하지 않았다.
- seq 5 / 17 / 23 / 31: 원문의 명시적 붙임·별지 서식 제목과 입력 구조를 함께 보고 합본을 판정한다.
  seq 4는 명시된 주 신청서 우선순위를 보강하며 안내문 안의 보충 양식을 일괄 제외하지 않는다.
- seq 1 / 10 필드: 공고 흐름·일정·배점 설명의 구조 입력 오탐을 줄이고 전화·빈 날짜·작성 안내
  placeholder 사례를 복구했다. 암묵 값 셀 복구의 양식 근거는 표당 한 번 계산한다.
- seq 2 / 3 / 6 / 13 선택: 실제 질문 라벨과 동의/택1 의미를 보존하고 둘 이상 선택하는 편집을
  거부한다. 원문 필수성을 새로 추정하지 않으며 빈 선택 해제와 seq 17의 실제 복수 선택을 보존한다.
- LLM: profile 근거에도 실제 인용을 요구하고, RHWP 우측 레일에 기존 응답의 추가 질문을 표시한다.
  문장 키워드로 의미를 추정·차단하는 새 엔진은 넣지 않았다. 인용 존재가 문안 전체의 사실성을
  보장하지 않으므로 실제 출력 검수가 남는다.
- prompt v27 / validator v16 / repair v7 / application roundtrip v10으로 기존 material fingerprint에
  변경이 결속된다. 과거 receipt나 서비스 필드를 새 버전 결과로 다시 표시하지 않는다.

남은 범위:

- seq 1의 비영리/조합 대안 자격 scope: 안전한 구분 근거가 부족해 신규 guard를 제외했다.
  해당 분석은 독립 의미 검수 전 공급 후보로 확정하지 않는다.
- seq 11의 분리된 셀 yes/no와 한 셀 서명: 현재 단일 위치 계약으로 안전한 결속이 안 되어 미복구.
  다른 held 위치와 고정 보유기간 등 알려진 나머지 사례도 이번 회귀만으로 해결 완료를 주장하지 않는다.
- 제품 LLM의 여러 보기 동시 적용은 미지원이며 신규 기능으로 확장하지 않았다. RHWP 수동 편집은
  유지한다. 추가 질문의 새로고침 후 복원도 DB 변경을 늘리지 않기 위해 제외했다.
- 일반 무변경 repair 반복 중단과 ZIP 중복 고지는 아래 2차 구현에서 처리했다. 정규화 변경 사유
  계측, 원인별 재시도 선택, primary/문서 단계 재사용, HML 보강과 처리시간 개선 실측은 남아 있다.
- 실제 로그인 매칭·확인질문 갱신, Studio의 RHWP 저장·재열기, 실제 LLM 제안·적용 인수,
  변경 계약의 새 manifest 실행 및 서비스 공급은 아직 완료하지 않았다.

## 보존 범위

작업 시작 시 기존 dirty 파일인 `apps/web/next-env.d.ts`, 상위 클로즈드 베타 출시 계획과
untracked 품질·처리 효율 개선 계획의 내용을 보존한다. 기존 원문·분석 receipt를 덮어쓰거나
원문 전체·개인정보를 새로 Git에 복제하지 않는다. commit·push·배포·서비스 승격은 수행하지 않았다.

## 2차 구현: 반복 낭비와 실제 반영 오류

사용자의 다음 단계 진행 요청에 따라 기존 sol/xhigh 담당자가 구현하고, root가 범위·diff·통합
검증을 검토했다. 새 상태 체계나 재처리 프레임워크를 추가하지 않고 아래 세 경로를 수정했다.

- `validated-primary.ts`: 교정 뒤 정규화 결과와 validator 오류가 모두 같으면 추가 모델 요청을
  중단한다. usage·비용·raw 응답 차이는 진행으로 세지 않는다. 같은 오류라도 축 설명 등 결과가
  달라지면 기존 교정 상한 안에서 계속한다. 오류 결과를 성공으로 바꾸지 않고 실제 pass와 교정
  횟수를 보존한다. 합성 회귀에서 기존 최초+교정 2회 대신 최초+교정 1회, 총 2회로 종결된다.
  배치 처리시간 실측이나 일반적인 모델 호출 절감률은 아니다. repair 계약은 **v8**로 전진했다.
- Lab `analyze.ts → input.ts`: ZIP 부모 실제 바이트, 각 멤버의 SHA·크기, child 보관행,
  검증된 markdown 전문과 cap 적용 뒤 입력 포함 여부를 공용 waiver 경로로 연결했다. 모든
  child가 잘림 없이 포함된 부모만 중복 경고를 제거한다. 변환 artifact fallback도 동일하게
  반영한다. 누락·SHA/load 실패·잘림·cap 초과·중첩 ZIP에서는 경고가 유지된다.
- `ai-review.ts`: 기존 `preserveRunInputShape` 경로에서 당시 ZIP 미투입 고지를 보존한다.
  테스트에서 byte 검사가 없던 이전 입력 조립 조건과 input/attachment manifest 해시가 모두
  일치했다. 과거 receipt를 새 결과로 덮어쓰지 않는다.
- `applicationPrecomputeMaterialization.ts`: 같은 parser/분석 버전만 보고 다른 필드 계획을
  재사용하던 경로를 고쳤다. 저장된 필드 내용·위치·채움 메타와 surface 상태가 같을 때만
  재사용하며, 같은 key의 수정은 기존 ID를 유지해 upsert한다. 새 계획에서 기존 자동 필드의
  key가 사라지거나 교체되면 기존 additive 검사로 보류한다. 사람 검수 map은 계속 보존한다.
  필드 삭제·이력 재매핑이나 migration은 추가하지 않았다.

### 실제 ZIP 확인

문제가 관측된 seq25에 현재 `prepareLabAnalysis`를 호출한 결과:

| 항목 | 결과 |
| --- | --- |
| child 첨부 전문 | 5개 포함 |
| 포함된 첨부의 잘림 | 0개 |
| 부모 ZIP 중복 미투입 경고 | 0개 |
| 새 input SHA | `e9712d9e848877d74fa7da2355da286063aa5213f51b0e1154413cb20c170859` |
| 새 attachment manifest SHA | `ffc88252ccdefbed94b910de3179f90a8801f0242714bc522a02ffed2c3a26ee` |

담당자 tool chunk `3d6c8d`의 실행 결과를 root가 원문 없는
`seq25-readonly-observation.json`으로 기록했다. DB는 해당 준비 함수의 SELECT만, R2는 get만
사용한 별도 프로세스이며 종료 후 남는 DB 설정은 없다. transaction read-only 모드를 별도로
설정한 실행은 아니었다. 모델 호출·DB 쓰기·기존 receipt 덮어쓰기는 0회다. 새 분석의 prior_award
정답이나 새 모델 결과의 publishable 여부를 검증한 것은 아니다.

### 2차 검증과 남은 인수

- 관련 검증: validated-primary/repair/qualityPreflight, `lab:experiment:test`, input 14개 시나리오,
  input manifest, archive inspection, independent-review packet, web typecheck 통과.
- root 검증: `pnpm lab:application-materialization:test`, `pnpm lab:release:test` exit 0.
  공개 저장 함수의 라벨 수정·오탐 key 제거 보류·정확한 map 재사용을 DB mock으로 검증했다.
- `pnpm application-precompute:test`는 이번에 수정하지 않은 worker 테스트 521행에서
  실패했다. HEAD와 동일한 processor에 과거 `applicationPrecomputeObservationError` 식별자
  4개를 요구하는 source 검사다. 이 별도 gate 불일치를 통과로 처리하지 않는다.
- 최종 `pnpm test` **exit 0**. 실행 전후 제품·테스트 소스 해시가 모두 같았으며 기존 dirty
  3개 파일도 기준선 SHA와 일치했다. `git diff --check` 통과. 상세 결과는 `verification.json`,
  `pnpm-test.log`, `release-test.log`, `materialization.log`에 기록했다.
- 별도 `test:product-postgres`는 materializer를 직접 실행하지 않는 suite여서 반복하지 않았다.
  실제 DB transaction에 새 필드 계획을 적용하는 검증과 게시 후 대조는 미실행이다.
- 현재 DB 필드와 기존 artifact는 그대로다. 기존 v9 결과를 v10으로 표시하지 않으며 새 계약의
  실행·서비스 반영은 남아 있다. 삭제·교체가 필요한 기존 필드의 전환도 보류 상태다.
- 개발 서버 4010/4011 listener가 없어 로그인 매칭·RHWP Studio 편집/저장/재열기와 실제 LLM
  제안 인수는 여전히 미실행이다. 저장소 규칙에 따라 개발 서버를 임의로 시작하지 않았다.

2차 상세 로그·소스 해시:
`/var/folders/90/3_v527vj59d6wv2ql7_k6rzm0000gn/T/cunote-quality-next-sl0d0bwc/`.

## 리모트 반영과 실제 브라우저 검증

사용자가 기존 커밋 push와 직접 개발 서버 실행을 명시적으로 요청해 진행했다.
`7e8ca6110ef363abf1aca848565981f7c5fa49f1`에 위 개선 묶음을 커밋했고, 앞선 6개 커밋과
함께 `origin/main`으로 push한 뒤 remote SHA 일치를 확인했다.

`pnpm dev:web`를 4010에서 실행했다. 실제 로그인 검증은 인증 callback 주소와 일치하는
`https://dev.changupnote.com`에서 별도의 가상 QA 계정·회사로 수행했다. localhost에서 화면이
열린 것만으로 로그인 성공을 판정하지 않고 실제 세션을 확인했다. 문서·항목 작성 제안의
두 개발 feature flag를 켰으며 운영 배포나 worker 활성화는 하지 않았다.

### 실제 저장·재열기 확인

강북구 착한가격업소 신청서 HWPX를 실제 persistent workspace에서 열었다. 빈 업소명 셀에
`QA검증-20260910`을 한 번 입력하고 서버 저장 응답 201, 다운로드, 브라우저 재열기,
재다운로드를 확인했다. 1쪽 표 구조와 원래 신청서 제목을 보존했고 ZIP 무결성 검사도 통과했다.

- 편집본과 재열기 후 다운로드 SHA 모두
  `7c6bdae1f49b846f0d010575bf1c2e3086d5d7516883239300e0369a452ae7cd`.
- section XML 동일, 검증 문구 각 1회, 재열기 화면에서도 같은 셀에서 확인.
- 해당 양식의 연결 필드는 0개다. 이 결과는 수동 편집·저장 증거이며 회사 정보 자동 입력이나
  항목별 AI 작성의 성공 증거로 확대하지 않는다.

별도 `/dev/document-agent-phase0`에서 실제 HWP와 native HWPX를 사용한 문서 명령 gate도
확인했다. HWPX seq27은 적용 1,886.3ms, export·재열기, 비대상 문단·쪽 수 보존,
정확한 Undo와 편집 포커스 복구가 통과했다. 이는 모델 없는 실제 편집기 명령의 검증이며
서버 제안 생성이나 계정 저장의 증거는 위 persistent 검증과 구분한다.

### 브라우저에서 발견한 결함

- 매칭: 사업자 유형 답변 저장 200 뒤 반환된 최신 revision으로 근로자 수를 연속 제출해도
  409가 발생했다. 공유 원천과 사용자 답변의 저장 후 재구성 결과와 응답 revision이 달랐다.
  저장 후 정본으로 응답하고 기존 사용자 병합값을 후속 저장에서도 보존하도록 고쳤다.
  실제 화면에서 사업자 유형 → 근로자 1~4명을 새로고침 없이 연속 제출해 모두 200을
  확인했다. `답하면 확정 1건`에서 `지금 신청 가능 1건`으로 전환됐고, 재열기에도 결과와
  `개인사업자, 소규모 사업장 사업주` 값이 유지됐다. 상세는 `matching-sequential-result.json`.
- 문서 LLM: 실제 HWP의 위치 선택·checkpoint 저장 201 뒤 제안 요청이 모델 호출 전에 500으로
  실패했다. 정상 초기 checkpoint의 `document_epoch=0`을 DB run 제약조건이 `>=1`로 거부했다.
  `0084_document_agent_epoch_zero.sql`은 이 하한만 `>=0`으로 맞추는 수정안이다.
- 예상하지 못한 DB 오류의 원문 SQL이 화면에 노출되던 동작을 route의 일반 오류 문구로
  바꿨다. 수정 후 실제 동일 요청에서 일반 문구만 표시됨을 확인했다.
- HWPX 문서 명령: Studio 내부 상태 SHA와 host export ZIP의 SHA가 각각 안정적이어도
  서로 다를 수 있었다. export 전후의 문서 상태가 동일한지 검사한 뒤 내부 SHA는 command
  receipt에, byte SHA는 요청·저장 파일에 각각 결속하도록 수정했다. 두 해시를 버리지 않으며
  export 중 편집과 요청 byte 불일치는 계속 거부한다.

공유 DB migration 적용과 실제 모델 제안·적용 검증은 별도 상태로 기록한다. 현행 DB에 필드
분석이 연결되지 않은 양식의 자동 입력·항목별 AI는 코드 수정만으로 복구됐다고 판정하지 않는다.

브라우저 증거 디렉터리:
`/var/folders/90/3_v527vj59d6wv2ql7_k6rzm0000gn/T/cunote-browser-20260910-fags1a1s/`.
`hwpx-persistent-result.json`과 `screenshots/hwpx-cell-edited.png`,
`screenshots/hwpx-reopened-large.png`, `screenshots/llm-error-sanitized.png`를 남겼다.
계정 자격정보·쿠키가 포함된 raw 요청·원문 SQL 로그는 Git에 추가하지 않는다.

### 최종 통합 확인

- `pnpm test` 최종 **exit 0**. 첫 실행에서 추가 공용 함수 호출을 반영하지 못한 tripwire
  inventory가 실패해, 동일 제품 경계 안의 저장 보존 호출임을 확인하고 count를 갱신했다.
  재실행 전후 수정 소스·테스트·package 15개 SHA가 동일했다.
- 격리 PostgreSQL의 `pnpm test:product-postgres` 통과: migration 85개 fresh 적용, epoch 0
  INSERT 허용·음수 UPDATE 거부, HWP/HWPX 문서 여정과 RLS 포함.
- 공유 Supabase에는 migration을 적용하지 않았다. 준비 시 latest ledger가 로컬 0083과
  일치하고 0084만 pending임을 read-only로 확인했다. 실제 적용 승인이 필요하다.
- 기존 개발 생성 파일과 병행 중인 workspace 안내·field-repair CLI 변경은 이번 추가 커밋에서
  제외했다. 이들의 화면 표시를 이번 커밋만의 변경이라고 보고하지 않는다.
- 실제 모델 응답 품질·적용과 연결 필드 기반 자동 입력 인수는 남아 있다. 일반 오류 안내와
  문서 명령 gate 통과만으로 그 기능을 완료 처리하지 않는다.

최종 로그는 `pnpm-test-rerun.log`, 소스 결속은 `verification-final.json`에 기록했다.

## 0084 적용과 실제 LLM 인수

사용자가 최소 수정 범위의 계속 진행을 승인해, 0084만 pending인지 재확인한 뒤
`pnpm db:migrate`를 한 번 실행했다. 공유 Supabase ledger id 86의 hash가
`b6aaad96db1e343e00e58c2e53b7871a12cb61dc3b1ff7e203cfe647b334ccb2`와 일치했다.
`document_epoch >= 0`, validated=true 및 기존 상태·lease·token·hash 조건 18개 보존을
확인했다. 다른 migration·분석 게시·운영 worker 변경은 없다.

### 실제 요청에서 발견한 두 가지 보정

- 첫 모델 요청은 201로 성공했지만, 시험항목표의 고정 제목을 신청 의사와 요건 확인 완료
  진술로 바꿨다. 해당 제안은 건너뛰었다. 프롬프트 v2에 고정 안내/조건은 빈 제안으로
  처리하고 공고 요건을 신청자의 확인·보유 사실로 바꾸지 않도록 명시했다. 새 분류기나
  키워드 정규식은 추가하지 않았다. 동일 제목의 실제 v2 재요청은 `empty`, 제안 0개였다.
- 제안 검토 상태에서 새 요청 버튼이 활성화돼 reducer의 허용 상태와 충돌하며 화면이
  깨졌다. 기존 후보 선택·새 요청 버튼을 `target_selected`에서만 활성화하도록 맞췄다.
  실제 화면에서 검토 중 비활성화와 `작성 위치 찾기` 재스캔 후 재활성화를 확인했다.

### 사용자 초안의 실제 적용·보존

동일 공고의 사업계획서에 QA 사용자가 직접 입력한 독립 문단을 사용했다. 필드 map을
추정하거나 회사 정보를 만들어 자동 입력한 테스트가 아니다.

> 작성 초안: 성분 분석 결과를 보고 제품에서 보완할 점을 찾으려고 합니다. 시험인증 준비에 활용하고 싶습니다.

실제 API 모델 `claude-sonnet-4-6`, prompt v2는 의미를 유지한 대안 2개를 반환했다.
선택한 첫 문안은 다음과 같다.

> 성분 분석 결과를 바탕으로 제품의 보완점을 파악하고, 해당 결과를 시험인증 준비에 활용하고자 합니다.

- 승인 전 다운로드는 사용자 초안과 byte 단위 동일했다.
- 선택한 대안만 `applied`, 다른 대안은 `stale`이 됐고 새 revision으로 서버 저장됐다.
- 새 탭 재열기 후 다운로드는 적용 직후와 동일했다.
- UI 수정의 HMR로 첫 Studio 세션이 재초기화돼, 소스를 동결한 뒤 같은 사용자 초안으로
  apply → 제품의 `최근 AI 변경 되돌리기` → 서버 저장 → 재열기를 다시 확인했다.
  최종 `undone` 및 재열기 다운로드 모두 원래 사용자 초안과 byte 단위 동일했다.
- 원래 사용자 초안/승인 전/Undo/Undo 재열기 SHA:
  `ba0d8510d760d326a1c9b6a49078eb2517125ff77b345bbec2cf87033a52788a`.
- 첫 적용/재열기 SHA:
  `7c1810214f2c8a50748364ecc468110cb73261a10113172ab489d092ad1b2c2d`.

이번 추가 제품 변경은 프롬프트·패널·상태 helper·기존 상태 회귀의 4개 파일이다.
최종 소스에서 `pnpm test:document-agent`, `pnpm test:apply-workspace`, web typecheck와
diff 검사가 통과했다. 검사 전후 4개 SHA가 동일했다. 추가 공용 schema 변경 없이 국소
수정이므로 전체 `pnpm test` 반복 대신 관련 suite와 실제 인수 증거로 검증했다.

위 브라우저 증거 디렉터리의 `0084-document-agent-epoch-zero-migration-receipt.json`,
`llm-live-uat-runs.json`, `llm-live-uat-final.json`, `llm-final-*-test.log`에 상세를 남겼다.
이 결과는 시험한 안내 제목과 사용자 문단 흐름의 증거이며, 모든 양식의 모델 품질이나
연결 필드 없는 양식의 회사 정보 자동 입력·항목별 AI까지 완료했다는 뜻은 아니다.
