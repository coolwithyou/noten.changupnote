# HWPX 원본 양식 채움 저장(fill & export) 설계 — 2026-07-07

> **🟢 Phase 2 완료 (2026-07-07)** — web 배선 구현·검증 통과(contracts·core 빌드 + web typecheck
> + `next build`).
>
> **Phase 3 브라우저 실측 (2026-07-08, dev 4010 · 경기 글로벌 오픈이노베이션 공고 실데이터):**
> - ✅ 버튼 노출 양방향: 신청서(.hwpx 첨부) 초안에 "HWPX (원본 양식에 채움)" 노출,
>   사업계획서(.hwp 첨부) 초안에는 비노출
> - ✅ 다운로드 왕복: POST 성공, 채움 2건(기업명·소재지) + **미채움 8건 정직 안내**
>   (X-Cunote-Hwpx-Unfilled 헤더 왕복: "8개 항목은 자동으로 채우지 못했습니다: 매출, … —
>   다운로드한 파일에서 직접 입력하세요"), 초안 상태 "내보냄" 전이
> - ✅ 다운로드 파일 한컴 오픈·셀 안착 확인(사용자 실측, 2026-07-08): 기업명 칸 "샘플 기업",
>   소재지 칸 "경기" 정상 삽입 — **Phase 3 통과, 트랙 전 구간(설계→core→web→실측) 완료**
> - ⬜ 소잔여: answers 동봉 경로 실측 — 이 공고 신청서는 "추가 입력 없음"이라 answerText 경로
>   미실측. 추가 입력 문항이 있는 공고에서 확인(기능 차단 요소 아님, 병합 로직은 단위 검증됨)
>
> **후속 진행 (2026-07-08):**
> - ✅ 설계 6번 잔여 완료(`fda7452`) — `detectConvertibleSurfaceFormat` 매직 바이트 보강.
>   아카이브 시점에 `detectHwpFormat`으로 확장자 위장 교정, 검출 결과를 attachments JSON에
>   라이딩해 변환 후크에서 확장자보다 우선(삼상 규약: 생략=폴백/null=비대상/문자열=확정).
>   단위 14건 + typecheck 통과
> - 🔄 hwp2hwpx 후속 트랙 착수 — 외부 대조(`docs/research/2026-07-08-hwp2hwpx-calibration.md`)
>   → 설계 확정(`docs/plans/2026-07-08-hwp2hwpx-track.md`) 완료, Phase 0 스파이크 진행 중
>
> Phase 2 요지: download route POST(`format=hwpx`, answers 동봉·병합), `draftHwpxExport.ts`
> (R2 원본 조회→매직바이트 가드→채움, 실패 모드별 한국어 에러), `DraftableDocument.hwpxTemplateAvailable`
> 플래그(`loadServiceApplySheet`에서 보관본 배치 조회로 덮어쓰기, core는 순수 유지), 워크스페이스
> HWPX 버튼 + 미채움 안내(X-Cunote-Hwpx-Unfilled 헤더). export 이력은 채움 성공 시에만 기록(정직화).
>
> **🟢 Phase 1 완료 (2026-07-07)** — core 채움 모듈 구현·검수 통과.
>
> **Phase 1 증거** (모듈: `packages/core/src/documents/hwpx-fill.ts` + 테스트):
> - 단위 테스트 15/15 통과 + `@cunote/core` typecheck 통과 (합성 픽스처, 실샘플 비의존)
> - 실샘플 통합(`scripts/spike/hwpx-fill-integration.ts`): 11/11 실행 성공, 위장 파일 3건
>   매직 바이트 자동 차단, 라벨 매칭 채움 7/11 문서(0건 문서는 자유서식류 — no_label_cell 정직 보고)
> - Docker 렌더 게이트: **11/11 렌더 성공 + 페이지 수 11/11 전건 동일** (라벨 타게팅은 리플로우 없음)
> - 눈검수(07번 신청서): 기업명·성명·이메일이 정확한 입력 셀에 안착, 셀의 입력용 문자 스타일
>   (파란색) 상속, 그 외 픽셀 동일. "기업명(필수 입력)" 표기의 괄호 정규화 매칭 검증
> - 구현 이탈 5건 모두 승인: matchLabelCells reason 반환, 괄호 내용 제거 정규화(실측 근거),
>   planCellFill 비공개 공유, 우측 존재-점유 시 스킵 해석, reason 우선순위 병합
>
> Phase 0 통과 기록(2026-07-07): 자동 검증 + 한컴오피스 수동 오픈 확인(사용자 실측) 완료.
>
> **Phase 0 증거** (스크립트: `scripts/spike/hwpx-fill-roundtrip.mjs`, 산출: `spike-out/hwpx-fill*/`):
> - 라운드트립 구조 검증 11/11 PASS (역치환 무손실 + XML well-formed + 비수정 엔트리 바이트 동일)
> - Docker 변환 서버(LibreOffice+H2Orestart) 렌더 11/11 성공 — 재압축본 전건 수용
> - 최소 채움(1셀 "1") 페이지 수 10/11 동일. 유일 예외 05번은 눈검수로 리플로우 확인(스페이서
>   문단에 삽입되어 각주 1줄이 다음 페이지로 밀림 — 부패 아님)
> - 이스케이프 검증: `& < >` 포함 값이 문자 그대로 렌더 (07번 눈검수)
> - 부수 발견 ①: `.hwpx` 확장자 위장 HWP 바이너리 3/14건 → 매직 바이트 판별 필수(설계 6번 반영)
> - 부수 발견 ②: 맹목적 "첫 N개 빈 노드" 채움은 스페이서/헤더 문단을 오염 → 라벨 매칭 셀
>   타게팅(설계 4번)이 필수임을 시각적으로 확인
> - 외부 대조: `docs/research/2026-07-07-hwpx-fill-calibration.md` — 전제 4건 유지(스플라이스
>   방식은 python-hwpx 선례로 강화)

> **배경**: 정부 표준 양식의 개방형 포맷(HWPX/OWPML, KS X 6101) 전환. 현재 초안 export는
> markdown/html/docx/pdf **신규 생성**뿐이라 원본 양식 서식이 보존되지 않는다.
> 사용자가 작성 워크스페이스의 답변을 원본 공고 양식(.hwpx)에 채운 파일로 내려받게 한다.
> **비고**: DB 전수 확인(2026-07-07) — 최근 3개월(apply_start ≥ 2026-04-07) 공고의 한글 첨부
> 637건 중 hwpx 138건(**22%**), hwp 499건(78%). 월별 hwpx 비율은 4월 7.7% → 7월 32%로 증가 추세지만
> 여전히 hwp가 다수. 확장자는 변환기 교차 검증(pyhwp/hwpx-unzip 완전 분리)으로 신뢰 가능.
> → .hwp 바이너리는 이번 범위 밖이지만(후속 절 참조), **후속 우선순위가 높다** — hwpx만으로는
> 최근 공고 한글 양식의 1/5만 커버.

## 오늘 검증한 사실 (수동 스파이크, 2026-07-07)

대상: `spike-samples/files/07_...시니어_인턴십__기업_신청서.hwpx`

- **컨테이너 구조**: `mimetype`(`application/hwp+zip`, **Stored·첫 엔트리** — EPUB/ODF 관례 동일) +
  `version.xml` + `Contents/header.xml`·`section0.xml`·`content.hpf` + `Preview/*` + `META-INF/*`.
  원본 zip에 디렉토리 엔트리 없음, 텍스트 엔트리는 Deflate, UTF-8 플래그(0x0800).
- **본문 구조**: 텍스트는 `<hp:t>` 노드. 표 24개, 빈 텍스트 노드 `<hp:t/>` 26개.
  **누름틀(fieldBegin/CLICK_HERE) 없음** → 정부 양식은 대부분 "라벨 셀 + 빈 입력 셀" 표 방식.
  채움의 핵심은 필드 API가 아니라 **셀 타게팅**이다.
- **라운드트립 성공**: 빈 노드 1개에 한글 텍스트 치환 → 재압축(mimetype stored 우선) →
  zip 무결성 통과, section0/header XML well-formed 통과, 치환 반영 확인.
- **미검증 잔여 리스크**: 한글(한컴오피스)·LibreOffice+H2Orestart가 재압축본을 정상 오픈/렌더하는지.
  로컬에 soffice 부재 → Phase 0에서 변환 서버 파이프라인으로 검증한다.

## 설계 결정

1. **모듈 위치**: `packages/core/src/documents/hwpx-fill.ts`. zero-dep(`node:zlib`) —
   수제 zip writer(`draftDocxExport.ts`의 `buildZip`)·PNG 파서 등 기존 무의존 관례를 따른다.
2. **zip 읽기/쓰기**: 읽기는 central directory 파서 + `inflateRawSync`(~60줄).
   쓰기는 `buildZip` 패턴 확장 — `deflateRawSync` 압축 추가, **mimetype은 Stored·첫 엔트리**,
   디렉토리 엔트리 생성 금지, UTF-8 플래그 유지.
3. **XML 처리 — 재직렬화 금지**: DOM 파싱 후 serialize는 attribute 순서·self-closing 형태를
   바꿔 한글 호환성 리스크만 키운다. 원본 바이트를 보존하고 **삽입 지점만 문자열 스플라이스**한다.
   수정 대상은 `Contents/section*.xml`뿐, 나머지 엔트리는 바이트 그대로 재수록.
4. **셀 타게팅**: `<hp:tbl>`→`<hp:tc>` 스트링 스캔, `hp:cellAddr`의 colAddr/rowAddr로 좌표 파악 →
   라벨 셀 매칭(정규화 텍스트, **Gate 1 표준 key 사전 재사용**) → 우측(colAddr+1) / 하단(rowAddr+1)
   인접 **빈 셀**에 값 삽입. 누름틀이 존재하는 문서를 만나면 누름틀을 우선 사용(후속 확장점).
5. **채움 정책(1차)**: 빈 셀만 채움 — 기존 텍스트 덮어쓰기 금지. 값은 XML 이스케이프(& < > " ')
   + 제어문자 제거. 단일 라인 텍스트만(다단락·줄바꿈은 2차 — `<hp:p>` 복제 필요).
6. **데이터 흐름**: download route `format=hwpx` → draft의 documentKey로 원본 첨부(R2 보관본,
   `grantAttachmentArchive`) 조회 → hwpx면 label→값 맵(초안 filledFields + 워크스페이스 추가 입력,
   label 전역 키잉 — 브리지 플랜 B1)으로 채움 → 스트림 반환. 순수 CPU 작업(수백 KB XML)이라
   요청 경로 내 동기 처리로 충분. 원본이 .hwp면 UI에서 버튼 비노출.
   **형식 판별은 확장자가 아니라 매직 바이트로**(PK=zip/hwpx vs D0CF11E0=CFBF/hwp) —
   Phase 0 스파이크에서 `.hwpx` 확장자를 단 HWP 바이너리 위장 파일이 14건 중 3건 발견됨(2026-07-07).
   기존 `detectConvertibleSurfaceFormat`(확장자 기반)도 동일 보강 필요.
7. **Preview 엔트리**: `Preview/PrvText.txt`·`PrvImage.png`는 1차에서 원본 유지(스테일 허용 —
   한글이 재저장 시 재생성). 문서 하단 고지에 명시.
8. **부분 채움 정직화**: 라벨 미매칭 필드는 조용히 넘기지 않고 응답 메타에 미채움 목록을 실어
   UI에서 "N개 항목은 직접 입력이 필요합니다"로 안내.

## 워크스트림

### Phase 0 — 스파이크 승격·렌더 검증 (통과 전 구현 금지)
- 오늘 수동 스파이크를 `scripts/spike/hwpx-fill-roundtrip.mjs`로 스크립트화
- 변환 서버(Docker, LibreOffice+H2Orestart)에서 **hwpx 샘플 14종 전수**: 채움 → `renderPdf` →
  원본 렌더와 페이지 수·렌더 성공 여부 비교
- **통과 기준**: 14/14 렌더 성공 + 페이지 수 동일 + 표본 수동 눈검수(채운 셀 외 시각 변화 없음)
  + **한컴오피스에서 채움본 오픈 수동 확인 최소 1회**(사용자)
- 착수 전 외부 대조(프로젝트 의례): hwpxlib(Java)·python-hwpx 등 기존 구현이 manifest/버전 메타를
  어떻게 다루는지 대조 — `docs/research/CALIBRATION-TEMPLATE.md` 절차

### Phase 1 — core 모듈 (`packages/core/src/documents/hwpx-fill.ts`)
- `readHwpxEntries(buf)` / `scanTableCells(sectionXml)` / `matchLabelCells(cells, fieldMap)` /
  `fillCells(sectionXml, fills)` / `writeHwpx(entries)`
- 단위 테스트: 라운드트립 바이트 diff 최소성(삽입 지점 외 동일), 이스케이프, 빈 셀 판정,
  라벨 정규화 매칭, mimetype 순서·압축 방식

### Phase 2 — web 배선 (배선 지도 실측 완료, 2026-07-07)
- **원본 조회 경로(확정)**: draft.**sourceAttachment**(파일명, 스키마에 이미 존재) + grant의
  (source, sourceId) → `grant_attachment_archives` 행 → `storageKey` →
  `createR2ObjectStorageFromEnv().getObjectBytes(key)` → Buffer (page-image 라우트 선례 있음)
- **label→값(확정)**: draft.**filledFields**(`Record<string,string>`, label 키잉) — 워크스페이스
  추가 입력은 초안 (재)생성 시 `POST /drafts`의 answers로 서버에 반영됨.
  **주의**: 답변 입력 후 재생성 없이 바로 다운로드하면 미반영 — UI에서 재생성 유도 또는
  다운로드 요청에 answers 동봉 결정 필요
- `document-drafts/[draftId]/download/route.ts`에 `format=hwpx` 추가 — 응답 전
  `detectHwpFormat`으로 매직 바이트 가드(위장 파일 방어)
- `DocumentDraftWorkspace.tsx`: "HWPX (원본 양식에 채움)" 버튼 — 서버 계산 플래그
  (sourceAttachment 존재 + 보관본이 진짜 hwpx)로 노출 제어
- 미채움 필드 목록 안내 UI (`fillHwpxTemplate`의 unfilled reason 활용)

### Phase 3 — QA·정직화 마감
- 채움 실패 모드 점검(라벨 0매칭, 손상 hwpx, 다중 section)
- export 이력 기록(`recordGrantDocumentDraftExport`에 hwpx 형식 추가)

## 비범위 (의도적)

- **.hwp 바이너리 지원** — 후속 트랙 경로 확정(2026-07-07 검토): .hwp를 직접 쓰지 않고
  **hwp2hwpx(Java, hwplib→hwpxlib)로 .hwpx 변환 후 본 설계의 채움 경로로 합류**시킨다.
  LibreOffice+H2Orestart는 import 전용이라 `--convert-to hwpx` 불가. 변환 서버 Dockerfile에
  `default-jre-headless`+`JAVA_HOME`이 이미 있어(H2Orestart가 Java UNO 확장) jar 추가만으로 됨.
  변환 시점은 다운로드 요청이 아니라 **아카이브/변환 잡 시점 배치** — .hwpx를 R2 sibling
  artifact로 저장하고, 원본 hwp 렌더 vs 변환 hwpx 렌더 diff(Gate 0 파이프라인)로 충실도 검증.
  이 트랙이 붙으면 채움 커버리지가 한글 첨부의 22% → 사실상 전체로 확대된다
- 다단락 텍스트·표 행 추가·서식 변경
- 신규 HWPX 문서 생성(빈 문서부터) — 템플릿 채움만 지원

## 검증 (메인 세션)

1. Phase 0 통과 기준 충족 증거 (렌더 로그 + 눈검수 기록)
2. `pnpm --filter @cunote/core test` + `pnpm --filter @cunote/web typecheck` + `next build`
3. 브라우저 실측: 워크스페이스에서 hwpx 다운로드 → 한컴오피스 오픈 → 채운 값 확인
