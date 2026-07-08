# hwp2hwpx 변환 트랙 — .hwp 바이너리를 채움 경로에 합류 (2026-07-08)

> **🟢 Phase 2 완료 (2026-07-08, 커밋 `8d9c61f`)** — web 배선: `CONVERSION_REQUESTED_ARTIFACTS`에
> "hwpx" 추가, `hwpxTemplateAvailable`이 sibling artifact(kind=hwpx, surface.title=파일명 조인)도
> 인식(배치 2회+순수 판정), 다운로드가 hwp 원본에서 sibling 변환본으로 합류(부재 시 409 정직
> 안내, 매직 바이트 가드 합류점 유지). 단위 9건+회귀 14건+typecheck 통과.
> **운영 전제**: 프로덕션 hwpx sibling 생성은 Cloud Run 재배포(`4c6f44e` 이미지) 이후.
> 기존 캐시 히트분에는 sibling 없음 — 재변환/신규 아카이브부터 채워짐.
>
> **잔여(Phase 3)**: Cloud Run 재배포 → 실공고 hwp 문서로 E2E(변환→플래그→다운로드→한컴) →
> 커버리지 지표(채움 가능 공고 비율) 재측정.
>
> **🟢 Phase 1 완료 (2026-07-08, 커밋 `4c6f44e`)** — 변환 서버 통합: Dockerfile 멀티스테이지
> (maven, 핀 커밋 50ae71b) jar 빌드, `requestedArtifacts`에 "hwpx" + hwp 바이너리(매직 바이트)
> 게이팅, core `writeHwpx` STORE 재포장 정규화, R2 업로드(kind=hwpx). 비치명 계약(outcome 분류,
> jobStatus 무강등). 웹앱은 아직 "hwpx" 미요청이라 기존 동작 불변 — Phase 2에서 배선.
> 검증: typecheck·build, hwpx-convert-test 15/15, quality-test 10/10, docker in-container 실측.
>
> **🟢 Phase 0 통과 (2026-07-08)** — 자동 3관문(변환·구조·채움) + **한컴 눈검수 사용자 확인 완료**:
> 변환·채움본에서 기업명·성명·이메일이 정확한 셀에 안착.
>
> 핀 커밋 `50ae71b`(2026-06-25) uber jar(재현: `bash scripts/spike/hwp2hwpx/build-jar.sh`),
> spike-samples 22건 전수. 산출: `spike-out/hwp2hwpx/`(report.json + converted/filled/render).
>
> - ✅ **변환 22/22** — 미분류 실패 0, 전건 HWP v5(암호화·배포용 0건 — 이 표본에선 경계 미출현)
> - ✅ **구조 단정** — 표/셀/cellAddr 전건, 빈 셀 보존 21/22(나머지 1건은 원문에 빈 셀 0 —
>   kordoc 교차 확인). 누름틀(fieldBegin) 포함 7건(후속 확장점 실재 확인)
> - ✅ **채움 왕복** — 21/22 채움 성공(1건=빈 셀 없음), 미채움 정직 보고 22/22, 네이티브와 동등
> - ⚠️ **렌더 관문 판정보류(오라클 부적합 실증)** — 원본 .hwp 렌더 22/22이나, 변환본은 STORE
>   정규화 후에도 H2O importer가 19/22에서 SIGABRT(결정적·재현). 렌더 가능 3건은 페이지 수
>   원본 일치 3/3. 외부 대조 4번 경고("H2O 양쪽 렌더는 한컴 동일성 충분조건 아님")가 crash
>   형태로 실증됨. **XML은 전건 well-formed + 구조·채움 정상이므로 한컴 비호환의 증거 아님**
> - 벤더 결함 실측: hwp2hwpx가 mimetype을 DEFLATE 저장(표준은 STORE 필수) — core `writeHwpx`
>   재포장이 정규화하므로 프로덕션 경로(채움 후 저장)에서는 무해. **변환 직후 재포장 정규화를
>   Phase 1 필수 단계로 승격**
> - **kordoc 판정(측정 종결)**: parse 22/22이나 **원본 레이아웃 보존 hwpx를 산출하지 못함**
>   (fillForm 출력은 markdown, "hwpx"는 IR 재생성본, hwpx-preserve는 .hwp 입력 거부) →
>   이 트랙의 목적(원본 양식 보존 채움)에는 Java 트랙만 유효. 대체 후보 제외.
>   단 kordoc SVG 렌더러는 변환본 검증 오라클 대안 후보로만 기록
>
> **감독자 판정**: 자동 3관문 통과. 렌더 diff는 충실도 오라클로 상실 → Phase 1 충실도 보증은
> **구조 단정(자동) + 채움 왕복(자동) + 한컴 표본 눈검수(수동)** 로 재구성. 변환본은 채움/
> 다운로드 전용이라 미리보기 경로(원본 .hwp 렌더, 22/22 정상)는 영향 없음.
> **Phase 1 착수 가부는 한컴 눈검수(⏳ 사용자)에 걸려 있음** — crash 19건이 한컴에서 정상
> 오픈되는지가 유일한 결정 관문. 표본: `spike-out/hwp2hwpx/{converted,filled}/`의
> 13·17(crash군, 원본 대조 PNG 준비됨) + 10·26(렌더 가능군, 3-way PNG 준비됨).

## 배경

HWPX 채움 트랙(`docs/plans/2026-07-07-hwpx-fill-export.md`, Phase 0~3 완료)은 `.hwpx`만
다룬다 — 최근 3개월 공고 한글 첨부의 **22%**. 나머지 78%(.hwp 바이너리)를 커버하기 위해
.hwp를 직접 쓰지 않고 **hwp2hwpx(Java, hwplib→hwpxlib)로 .hwpx 변환 후 기존 채움 경로
(`fillHwpxTemplate`, 라벨 셀 타게팅)에 합류**시킨다.

## 외부 대조 반영 (2026-07-08, 관문 의례)

판정: 유지 3건 · 보강 3건. 설계에 반영된 보강 사항:

1. **"jar만 추가" 가정 폐기** — hwp2hwpx는 릴리스·Maven Central·CLI·shade 구성이 전부 없음.
   소스 clone(커밋 핀) + 얇은 CLI Main 래퍼 + maven-shade uber jar 빌드가 필요.
   의존 hwplib 1.1.10·hwpxlib 1.0.9는 Central에서 해결됨(실측).
2. **렌더 diff 사각지대 보강** — 페이지 수·픽셀 diff만으로는 알려진 결함(선종류·대체글꼴·
   셀 배경·보충문자)을 못 잡고, 원본·변환본을 같은 H2O 필터로 렌더하면 "한컴 동일성"의
   충분조건이 아님. → 게이트에 **구조 단정 + 채움 왕복 + 한컴 눈검수 표본** 추가.
3. **빈 셀·cellAddr 보존은 측정 전 확정 금지** — 코드 구조상 기대되나 실측 근거 없음.
   변환 산출물 자체로 검증(네이티브 hwpx 샘플로 대체 금지).

## 설계 결정 (감독자 확정)

1. **변환기**: `neolord0/hwp2hwpx`(Apache-2.0) 소스 빌드, **커밋 핀**. 얇은 CLI Main 래퍼
   (`HWPReader.fromFile` → `Hwp2Hwpx.toHWPX` → `HWPXWriter.toFilepath`) + maven-shade uber jar.
2. **jar 빌드 위치**: 프로덕션은 **Docker 멀티스테이지 빌드**(maven 스테이지에서 clone·핀·빌드,
   런타임 스테이지에 jar만 COPY) — 바이너리 리포 커밋 회피, 커밋 핀으로 재현성 확보.
   스파이크는 로컬 Docker maven 컨테이너로 동일 절차 검증. 주의: pom이 Java 7 타깃이라
   최신 JDK에서 컴파일 거부 가능 → 빌드 시 source/target 8 이상으로 승격(래퍼 pom에서 지정).
3. **변환 시점**: 다운로드 요청이 아닌 **아카이브/변환 잡 시점 배치**. 산출 .hwpx는 R2
   sibling artifact로 저장(멱등·재시도 격리). 상세 배선은 Phase 1에서 확정.
4. **커버리지 경계 — 정직 스킵**: hwplib은 HWP v5 전용. HWP 3.x·암호화·배포용(DRM)은
   변환 실패 사유를 기록하고 스킵(채움 버튼 비노출 유지, UI 고지). 코퍼스 내 빈도는
   Phase 0에서 실측.
5. **형식 판별 정합**: 변환 대상 선별은 매직 바이트(`detectHwpFormat`=="hwp-binary") 기준 —
   확장자 위장 대응(설계 6번 보강과 동일 원칙, 같은 날 별도 워크스트림으로 구현 중).
6. **충실도 게이트(누적)**: ① 변환 성공/실패 모드 전건 분류 ② 구조 단정(hp:tbl/hp:tc/
   hp:cellAddr·빈 셀 보존) ③ 채움 왕복(fillHwpxTemplate 통과, 네이티브 hwpx와 동등한
   채움+정직 보고) ④ 렌더 게이트(페이지 수+렌더 성공+표적 결함 점검) ⑤ 한컴 눈검수 ≥1(사용자).
7. **kordoc 병행 측정**: 동일 샘플로 kordoc(`fillHwpx()`, Node·MIT) 변환·채움을 대조 측정.
   **측정만 — 채택 금지.** Java 트랙 vs Node 단일 의존 트랙은 실측 우위로 감독자가 결정.
   루트 package.json/pnpm-lock 오염 금지(격리 서브디렉토리에서 설치).
   경쟁 제품 신호(포지셔닝)는 필드테스트 전 대조로 이월.

## 워크스트림

### Phase 0 — 변환 스파이크 (통과 전 구현 금지)

- **파일 소유**: `scripts/spike/hwp2hwpx/`(Java 래퍼·pom·빌드 스크립트·드라이버)
  + `spike-out/hwp2hwpx*/`(산출). 루트 package.json·pnpm-lock.yaml·apps/**·packages/** 수정 금지.
- **모집단**: `spike-samples/files/*.hwp` 22건(+확장자 위장 hwp 3건은 hwpx 세트에 있음 —
  매직 바이트 선별 검증에 사용).
- **절차**: uber jar 빌드(Docker maven) → 전수 변환 → 구조 단정 → 채움 왕복
  (`@cunote/core` `fillHwpxTemplate`, dist 사용) → 렌더 게이트(로컬 `cunote-conversion:spike`
  이미지, `apps/conversion/README.md` 관례) → kordoc 병행 측정 → 보고서.
- **통과 기준**:
  - 변환: HWP v5 표본 전건에서 성공 또는 **분류된** 실패(미분류 실패 0)
  - 구조: 변환 성공분에서 표·셀·cellAddr 파싱 가능 + 빈 셀 존재(라벨 매칭 가능 구조)
  - 채움: 라벨 매칭 가능 문서에서 채움 성공 + 미채움 정직 보고 동작
  - 렌더: 변환 성공분 전건 렌더 성공 + 원본 hwp 렌더와 페이지 수 동일(리플로우 예외는
    눈검수 소명) + 표적 결함(선종류·대체글꼴·셀 배경·보충문자) 표본 점검
  - 한컴 눈검수 ≥1 (사용자 — 스파이크 보고 후 별도 확인)

### Phase 1 — 변환 서버 통합
- Dockerfile 멀티스테이지(maven) + 변환 잡에 hwpx sibling artifact 생성 경로 추가
- 착수 전 Phase 0 통과 판정 필수

### Phase 2 — web 배선
- 아카이브/변환 잡 → R2 sibling .hwpx 저장 → `hwpxTemplateAvailable` 플래그가
  sibling hwpx도 인식 → 다운로드 경로 합류(기존 `draftHwpxExport` 재사용)

### Phase 3 — QA·실측
- 브라우저 왕복 + 한컴 확인(사용자), 커버리지 지표(채움 가능 공고 비율) 재측정

## 비범위 (의도적)

- .hwp 직접 채움(변환 경유만) · 신규 HWP/HWPX 생성 · HWP 3.x/암호화/배포용 변환(정직 스킵)
- kordoc 채택 여부 결정(Phase 0 측정 결과로 별도 판단)
