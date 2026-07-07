# hwp2hwpx 변환 트랙 — .hwp 바이너리를 채움 경로에 합류 (2026-07-08)

> **⬜ Phase 0 진행 중 (2026-07-08 착수)** — 외부 대조 완료(`docs/research/2026-07-08-hwp2hwpx-calibration.md`),
> 설계 확정(이 문서), 스파이크 위임.

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
