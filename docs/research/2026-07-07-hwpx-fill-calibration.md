# HWPX 채움 저장 트랙 착수 전 외부 대조 (2026-07-07)

> 대상 설계: `docs/plans/2026-07-07-hwpx-fill-export.md`. 관문급이 아닌 기능 트랙이라
> 템플릿의 2-에이전트 의례 대신 축소 대조(로컬 증거 + 표적 웹 대조)로 수행 — 감독자 결정.
> 제품·규제 축은 범위 무관(문서 생성이 아닌 사용자 데이터의 양식 삽입)으로 생략.

## 전제별 대조표

| 전제 | 판정 | 근거 |
|---|---|---|
| 스플라이스 편집에 manifest/메타 갱신 불필요 | **유지** | 로컬 실측: `content.hpf`(OPF manifest)는 href/media-type만 기재, 크기·해시 없음. `META-INF/manifest.xml`은 빈 ODF manifest, `container.xml`은 rootfile 경로만. 엔트리 내용과 결합된 메타 부재 |
| XML 재직렬화 금지, 바이트 보존 스플라이스 | **유지·강화** | python-hwpx(airmang)가 동일 설계를 이미 검증: "바이트 보존 구조 편집 — 셀 채우기…를 문서 재조립 없이 수행해 양식 서식을 그대로 보존", 미수정 영역은 "section XML 바이트를 splice해 손대지 않음" |
| mimetype Stored·첫 엔트리 재압축 | **유지(렌더 검증 대기)** | 원본 관찰(EPUB/ODF 관례 일치). 기존 구현들의 명시 문서는 못 찾음 — 렌더 검증 + 한컴 수동 확인으로 최종 해소 |
| hwp→hwpx 후속 트랙은 hwp2hwpx 경유 | **유지(단서 추가)** | neolord0/hwp2hwpx 2026-06-25 최신 커밋(활발), API 3줄(HWPReader→Hwp2Hwpx.toHWPX→HWPXWriter). 단 공식 릴리스 없음 → 소스 빌드 필요. 알려진 엣지: 서로게이트 쌍 U+FFFD 깨짐(수정됨), 대체글꼴 매핑, 표 선종류 — **렌더 diff 게이트 필수 재확인** |

## 개선 후보 (측정 전 채택 금지 — 후보 등재만)

- **python-hwpx** (`github.com/airmang/python-hwpx`, 순수 Python): (a) 우리 Node 스플라이스 모듈의
  **교차 검증 오라클** — 같은 문서를 양쪽으로 채워 결과 비교, (b) 엣지 케이스에서 폴백 구현 후보.
  변환 서버 이미지에 python3 이미 있어 도입 비용 낮음. 단 셀 채우기 API의 빈 셀 판정 규칙이
  우리 정책(빈 셀만, 덮어쓰기 금지)과 일치하는지 실측 필요
- **hwpxlib** (Java, Apache-2.0): 완전 파싱 기반 읽기/쓰기. 우리 용도(치환)에는 과하지만
  hwp2hwpx 트랙 도입 시 자연히 함께 들어옴

## 불확실성 (정직 고지)

- 한글(한컴오피스)이 재압축본을 수용하는지는 **아직 실측 전** — Phase 0 렌더 검증(LibreOffice)
  + 사용자 한컴 수동 확인으로 해소 예정. 렌더 검증은 LibreOffice 기준이라 한컴 완전 호환의
  충분조건은 아님
- hwp2hwpx 변환 충실도는 문서 유형별 실측 전 (DB의 hwp 1,238건이 측정 모집단)

## 출처

- https://github.com/airmang/python-hwpx (README, 2026-07-07 열람)
- https://github.com/neolord0/hwp2hwpx / hwpxlib / hwplib (2026-07-07 열람)
- 로컬 실측: `spike-samples/files/07_...기업_신청서.hwpx` 컨테이너 해부
