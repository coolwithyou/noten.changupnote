# 가상 기업 매칭 매트릭스 구현 계획

작성일: 2026-08-02  
범위: 랜딩 사업자번호 입력 → 회사 미리보기 → 딥분석 승격 공고 조회 → 22축 matcher → 사용자 결과 버킷

## 1. 목적

외부 사업자 조회의 성공 여부와 무관하게, 딥분석·자동검수·승격이 끝난 공고가 실제 랜딩 매칭에서 올바르게 추천되는지를 반복 검증한다.

가상 기업은 **기업정보 획득 단계만 대체**한다. 다음 단계는 프로덕션 경로를 그대로 사용한다.

1. `loadServiceGrantUniverse()`의 활성·승격 공고 조회
2. `buildProductTeaserSnapshot()`과 `buildTeaser()`
3. 22축 criterion 평가와 `ruleTrace`
4. recommendation tier와 사용자 화면 버킷

가짜 공고, 강제 점수, 강제 추천 등급, matcher 내부의 가상기업 분기는 허용하지 않는다.

지원서 작성 검증은 V5부터 별도 안전 경계를 사용한다. 매칭·상세는 프로덕션 read path를 그대로
쓰되, 가상 기업 workspace는 실제 회사·초안·비용 데이터를 만들지 않는 비영속 미리보기로 시작한다.

## 2. 확인된 현재 상태

2026-08-02 읽기 전용 점검에서 활성·승격 공고 7건이 조회됐다. 첫 기준 공고 후보는 다음이다.

- 공고: `[충남] 2026년 장애인기업 마케팅(홍보물 제작) 지원 공고`
- grant id: `a66f875d-e873-4166-ace6-27348e4c4b10`
- source/source id: `bizinfo/PBLN_000000000124754`
- 마감일: 2026-08-21
- 주요 필수조건: 충남, 장애인기업, 장애인기업 확인서

충남·장애인기업·확인서 프로필로 현재 matcher를 실행하면 필수조건은 통과하지만 최종 tier는 `needs_core_review`가 됐다. 원인은 검수 완료 신호의 누락이 아니라, 신청 자격과 무관한 `preferred text_only` 평가항목까지 `text_only_criterion_present` 전역 경고로 묶여 전체 공고를 차단한 것이었다.

교정 범위는 `preferred text_only`만 남은 검수 완료 공고가 신청 자격 판정을 차단하지 않게 하는 것으로 한정한다. `required`·`exclusion`의 `text_only`는 사용자 확인 전까지 기존처럼 차단한다.

첫 매트릭스 실행에서는 두 경계도 함께 확인됐다. 검수된 구조화 인증의 회사 보유값 누락은 공고 원문 문제가 아니므로 `needs_profile_input`으로 보내고, 필수조건에서 이미 탈락한 공고에는 우대평가용 미확인 값을 질문하지 않는다.

이 문제는 가상 기업 프로필이나 기대값을 느슨하게 만들어 숨기지 않는다. 매트릭스는 이를 제품 회귀로 실패시킨다.

## 3. 설계 원칙

### 3.1 정확히 등록된 번호만 예외로 허용

체크섬을 통과하지 않는 번호 대역 전체를 허용하지 않는다. 카탈로그에 등록된 정확한 번호만 개발환경에서 허용한다.

- 서버: `CUNOTE_VIRTUAL_COMPANY_ENABLED=true`
- 브라우저: `NEXT_PUBLIC_CUNOTE_VIRTUAL_COMPANY_ENABLED=true`
- 기본값: 비활성
- 프로덕션: 별도 승인 없이는 비활성

카탈로그는 다음 불변식을 시작 시 검증한다.

- 숫자 10자리
- 기존 사업자번호 체크섬 실패
- 번호와 시나리오 ID 중복 없음
- 목표 공고 최소 1건
- 기대 tier가 명시됨

### 3.2 작은 interface 뒤에 카탈로그 복잡성을 숨김

공유 interface:

```ts
isVirtualCompanyBizNo(bizNo: string): boolean
isAcceptedLandingBizNo(bizNo: string, options: { allowVirtual: boolean }): boolean
```

서버 interface:

```ts
resolveVirtualCompanyScenario(bizNo: string): VirtualCompanyScenario | null
listVirtualCompanyScenarios(): readonly VirtualCompanyScenario[]
```

랜딩·미리보기·티저는 이 interface만 알고, 시나리오별 조건은 알지 못한다.

### 3.3 matcher에는 `CompanyProfile`만 전달

가상 기업 어댑터는 표준 `CompanyProfile`과 `MatchingProfileView`를 만든다. matcher에는 시나리오 ID, 가상 번호, 기대 tier를 전달하지 않는다.

```text
가상 번호 → 카탈로그 프로필 ┐
                              ├→ 동일한 공고 유니버스 → 동일한 matcher
일반 번호 → cache/Popbill ───┘
```

### 3.4 관측 데이터와 외부 비용을 오염시키지 않음

가상 기업 요청은 다음을 만족해야 한다.

- Popbill/NTS/SMPP/CODEF 호출 0회
- `company_enrichment_cache`에 가짜 응답을 저장하지 않음
- 실제 랜딩 품질 관측 집계에서 제외
- 원본 가상 번호를 로그에 기록하지 않음

## 4. 카탈로그 계약

```ts
interface VirtualCompanyScenario {
  id: string;
  bizNo: string;
  name: string;
  purpose: string;
  profile: CompanyProfile;
  targets: VirtualCompanyTarget[];
}

interface VirtualCompanyTarget {
  source: "bizinfo" | "kstartup";
  sourceId: string;
  expectedExtractorVersion: string;
  expectedRevision: string;
  expected: "recommendable" | "not_recommended" | "needs_profile_input";
  expectedCriterionResults?: Partial<
    Record<CriterionDimension, "pass" | "fail" | "unknown" | "text_only">
  >;
}
```

초기 시나리오는 한 공고에 대한 세 가지 제품 상태를 고정한다.

1. `virtual-chungnam-disabled-perfect`
   - 충남, 장애인기업, 장애인기업 확인서
   - 기대: `recommendable`
2. `virtual-chungnam-disabled-region-fail`
   - 서울, 장애인기업, 장애인기업 확인서
   - 기대: `not_recommended`
   - 추가 불변식: 사용자 질문 0건
3. `virtual-chungnam-disabled-cert-missing`
   - 충남, 장애인기업, 인증 정보 미확인
   - 기대: `needs_profile_input`

개발환경 입력 번호는 다음과 같다. 세 번호 모두 정상 사업자번호 체크섬을 통과하지 않는다.

| 번호 | 시나리오 | 기대 결과 |
|---|---|---|
| `000-00-00001` | 충남·장애인기업·확인서 보유 | 추천 가능 |
| `000-00-00002` | 서울·장애인기업·확인서 보유 | 지역 필수조건 탈락 |
| `000-00-00003` | 충남·장애인기업·확인서 미확인 | 인증 추가입력 필요 |

이후 기수혜, 결격, 업력·매출·인원 경계, 법인/개인사업자, 업종 코드, `text_only` 혼합 공고를 카탈로그 항목으로 추가한다. 새 시나리오 추가는 카탈로그와 기대값 변경만으로 끝나야 한다.

## 5. 구현 체크포인트

### 체크포인트 V1 — 문서와 카탈로그 계약

- 이 문서를 기준 계약으로 커밋
- 공유 번호 판별 모듈
- 서버 카탈로그와 불변식 검증
- 세 가지 초기 시나리오
- 일반 무효 번호 회귀 테스트

완료 조건:

- 세 번호가 기존 체크섬을 통과하지 않음
- 등록되지 않은 무효 번호는 거부
- 중복/정상 체크섬 번호를 카탈로그에 넣으면 테스트 실패

### 체크포인트 V2 — 기업정보 획득 어댑터

- 랜딩 클라이언트 검증에서 개발환경 가상 번호 허용
- 회사 미리보기에서 카탈로그 이름·지역·영업상태 반환
- 익명 티저 프로필 해소에서 가상 프로필 반환
- 일반 번호 경로는 기존 resolver/cache/Popbill 동작 유지
- 가상 요청의 랜딩 관측 저장 제외

완료 조건:

- 기능 비활성 시 400 `invalid_biz_no`
- 기능 활성 시 preview/teaser 성공
- provider acquisition dependency 호출 0회
- 일반 사업자번호 테스트 전부 통과

### 체크포인트 V3 — 실제 승격 공고 매트릭스

- `pnpm verify:virtual-company-matrix` 추가
- DB의 실제 활성·승격 공고만 사용
- source/source id로 목표 공고 식별
- 실제 `ruleTrace`, tier, 질문, 평가 공고 수를 검사
- JSON 결과 출력

결과 상태:

- `pass`: 기대와 일치
- `product_regression`: 실제 매칭 결과가 기대와 다름
- `scenario_stale`: 공고가 마감·삭제됨
- `needs_rebaseline`: 승격 분석 revision이 변경됨
- `infrastructure_error`: DB·서버 접근 실패

승격된 공고가 `preferred text_only`만으로 `needs_core_review`에 남으면 matcher의 manifest 정규화 seam 하나만 교정한다. 신청 자격에 관여하는 `required`·`exclusion`의 `text_only` 안전장치는 완화하지 않는다.

현재 개발 DB의 활성·승격 공고를 대상으로 한 HTTP 경계 검증은 `pnpm verify:virtual-company-flow`로 실행한다. 회사 미리보기와 세 번호의 티저 API를 실제 route handler까지 통과시키며, 외부 사업자 조회 대신 `cacheStatus=virtual`인지 확인한다.

### 체크포인트 V4 — 랜딩 전체 흐름

개발환경에서 다음을 브라우저로 검증한다.

```text
랜딩 번호 입력
→ 가상 기업 미리보기
→ 회사 확인
→ /matches?biz=<virtual>
→ 실제 딥분석 승격 공고 평가
→ 기대 결과 버킷
```

검증 후에만 프로덕션 빌드, 커밋, `main` 병합·push를 수행한다. 정기 스케줄과 OPS UI는 매트릭스가 안정적으로 통과한 뒤 별도 단계로 둔다. 이번 범위에서는 기계 판독 가능한 JSON 출력까지만 보장한다.

## 6. 회귀·수명주기 규칙

- 공고가 마감됐다고 다른 공고를 자동 선택하지 않는다.
- 승격 분석 revision이 바뀌면 기대값을 자동 덮어쓰지 않는다.
- `scenario_stale` 또는 `needs_rebaseline`로 실패시켜 사람이 검토한다.
- 완전 매칭 시나리오 하나만 성공해도 전체 성공으로 간주하지 않는다.
- 탈락 시나리오에서 불필요한 질문이 생기면 실패한다.
- 정보 부족 시나리오가 내부 `needs_core_review`로 내려가면 실패한다.

## 7. 제외 범위

- 가짜 공고 생성·DB 삽입
- matcher의 가상기업 전용 분기
- 점수·tier 강제 덮어쓰기
- 가상 Popbill 캐시 행
- 동적 가상기업 자동 생성기
- OPS 관리 UI
- 정기 Cloud Run/Scheduler 작업
- 프로덕션 기본 활성화

이 범위는 랜딩 딥분석 매칭의 재현 가능한 제품 기준선을 만드는 데 필요한 최소 구현으로 제한한다.

## 8. 구현 결과 (2026-08-02)

- V1 완료: 등록된 무효 체크섬 번호 3건과 다중 시나리오 카탈로그
- V2 완료: 랜딩 검증·회사 미리보기·익명 티저의 개발환경 전용 어댑터, 외부 provider 호출 우회
- V3 완료: 활성·승격 공고 7건을 실제 평가하는 revision 고정 매트릭스
- V4 자동 경계 완료: 회사 미리보기 route와 티저 route에서 `추천 / 숨김 / 추가입력` 3상태 확인
- matcher 안전선: `preferred text_only`는 자격을 차단하지 않고, `required/exclusion text_only`는 계속 차단
- 질문 안전선: 필수조건 탈락 뒤 우대평가용 질문을 만들지 않음

검증 명령은 다음과 같다.

```bash
pnpm verify:virtual-company-matrix
pnpm verify:virtual-company-flow
```

사용자가 실행한 개발 서버에서 `000-00-00001`의 랜딩→매칭→상세 브라우저 흐름을 확인했다.
나머지 두 번호는 route handler와 DB 공고 유니버스를 통과하는 자동 검증으로 경계를 유지한다.

## 9. 체크포인트 V5 — 비영속 지원서 workspace 연결 (2026-08-02)

### 9.1 달성 범위

`000-00-00001` 시나리오를 다음 실제 제품 경로까지 연결했다.

```text
랜딩 입력
→ 가상 기업 확인
→ 실제 승격 공고 7건 매칭
→ 목표 공고 상세
→ 실제 신청 문서 2건·페이지 이미지·연결 필드 조회
→ 가상 기업 비영속 workspace
→ 브라우저 메모리에서 항목 입력·확인 진행
```

일반 기업과 가상 기업은 `loadWorkspaceDocumentContext()`의 문서 선택·surface·필드·페이지 read seam을
공유한다. 이후 실행 경계만 다음처럼 갈린다.

| 실행 모드 | draft ensure | DB 시드·revision | AI/변환 poll | 사용자 입력 |
|---|---:|---:|---:|---|
| `persistent` | 사용 | 사용 | 기존 정책 | 서버 저장 |
| `virtual_preview` | 미사용 | 미사용 | 미사용 | 현재 탭 메모리만 |

가상 기업 페이지 이미지는 서버 플래그가 켜져 있고, 정확히 등록된 가상 번호이며, 해당 시나리오의
목표 source/sourceId 공고일 때만 세션 없이 읽을 수 있다. 임의 무효 번호나 다른 공고로 권한이 넓어지지 않는다.

### 9.2 검증 결과

- 자동 경계: 회사 preview `cacheStatus=virtual`, 3개 시나리오의 추천·숨김·추가입력 상태 일치
- 상세: 목표 공고 필수조건 3개 충족, 필수 확인 필요 0개
- workspace: 실제 작성 문서 2개, 연결 필드 6개, 페이지 4개, `draftId=null`
- 브라우저: 랜딩부터 workspace까지 query scope 보존
- 브라우저 입력: 첫 항목 입력 후 `0/6 → 1/6` 진행
- 네트워크: `/api/web/document-drafts/*` 요청 0회
- 새로고침: 입력값 소멸, 진행률 `0/6` 복귀
- 페이지 이미지: 가상 번호가 붙은 target-scoped URL로 정상 로드(`naturalWidth=1819`)

현재 6개 연결 필드는 제작 추진 일정·홍보/활용 계획·기대 효과 등 서술형이다. 따라서
`mappedCompanyField=null`, 자동 기업정보 시드 0건은 실패가 아니라 문서 의미에 맞는 결과다. 화면도
“기업정보로 채웠다”가 아니라 “자동 연결 가능한 정보만 제안한다”로 정직하게 안내한다.

## 10. 다음 개선 계획

### V6 — 가상 RHWP 로컬 편집

목표는 DB draft 없이 실제 HWP/HWPX 바이트를 RHWP Studio에 열고, 편집 결과를 브라우저에서만
유지·다운로드하는 것이다.

1. 시나리오 목표 공고에만 허용되는 원본 문서 read endpoint를 추가한다.
2. `RhwpStudioSurface`의 `draftId` 고정 계약을 `persistent`와 `local_preview` transport로 분리한다.
3. `local_preview`는 서버 snapshot/save API를 호출하지 않고 브라우저 Blob만 갱신한다.
4. 다운로드는 서버 materialize가 아니라 현재 로컬 바이트를 사용한다.

완료 게이트:

- 실제 HWP/HWPX 페이지 수와 선택 문서가 일치
- 편집 전후 로컬 SHA-256 변경 확인
- `/document-drafts/*`, `/chat`, AI 제안, credit 요청 0회
- 일반 기업의 autosave·manual save·revision 테스트 전부 유지

구현 상태(2026-08-02):

- 등록된 가상 기업 번호와 정확한 목표 공고, 서버가 다시 해석한 `documentKey`가 모두 일치할 때만
  원본을 읽는 target-scoped endpoint를 추가했다. 페이지 이미지도 같은 접근 경계를 공유한다.
- RHWP 전송 계약을 `persistent`와 `local_preview`로 분리하고, `local_preview`에서는 persist 콜백
  자체를 호출하지 않는 어댑터를 단위 테스트로 고정했다. 편집본 반영과 다운로드는 현재 탭의 검증된
  바이트만 사용한다.
- 읽기 경로 실측에서 대상 문서 `application_form::신청서::::0`의 원본은 HWP 162,304 bytes,
  3쪽, SHA-256 `a0ddaf420a59b17b0293e01f2309d0fb597294000153b073d8ae222181e22b77`로 다시 열렸다.
- RHWP 전송·working document·Studio/Workspace 렌더·route policy·web typecheck와 프로덕션 빌드는
  통과했다. 기존 NFT 전체 추적 경고 1건은 유지된다.
- 실행 중이던 `127.0.0.1:4010` 개발 서버가 모든 요청을 무응답으로 유지해 브라우저 완료 게이트 중
  편집 전후 SHA 변경과 네트워크 write 0건 실측은 아직 보류한다. 개발 서버 재시작 후 이 두 증거를
  확보하기 전에는 V6를 완료로 표시하지 않는다.

### V7 — 재현 가능한 시나리오 회귀

1. 시나리오별 `grant source/sourceId + analysis revision + document source SHA-256`를 고정한다.
2. 매칭 기대값과 작성 기대값(문서 수, 필드 수, 자동 시드 수, 수동 질문 수)을 함께 검증한다.
3. 공고 revision 또는 원본 SHA가 바뀌면 자동 보정하지 않고 `needs_rebaseline`로 중단한다.
4. 최소 3상태(추천 가능·필수 탈락·프로필 추가입력)를 랜딩부터 작성 진입까지 반복 검증한다.

### 보류 범위

- 가상 기업 DB company/draft 생성
- 서버 메모리 기반 임시 draft
- 가상 요청의 유료 AI 제안·채팅
- OPS 시나리오 편집 UI와 정기 스케줄

V6·V7은 각각 별도 체크포인트와 커밋으로 진행한다. V5에서 확인한 “실제 경로를 쓰되 쓰기만
격리한다”는 경계를 완화하지 않는다.
