# Gate 0: HWP 렌더링 스파이크 계획

작성일: 2026-07-02
상위 설계: `docs/public-support-application-guide-master-architecture.md` 17장 Gate 0

> **🟢 1차 실행 결과 (2026-07-02)**
>
> - 환경: Ubuntu + LibreOffice 26.2.4 headless + H2Orestart 0.7.13 (unopkg 사용자 설치)
> - 샘플: 기업마당 작성형 양식 30건 (HWP v5 22 + HWPX 8, 846 후보에서 선별 — 공고당 1건, sha256/유사 파일명 중복 제거)
> - **렌더링 성공률 30/30 = 100%** (통과 기준 90%). 총 변환 시간 약 8초 (배치 호출, 문서당 평균 0.3초)
> - 육안 표본 검사: 복잡한 중첩 표(자동차부품 사이버보안 신청서), 병합 셀·체크박스·동의란(대구 융자신청서), 서명란 "(인)/(직인)" 모두 시각 보존 확인
> - 산출물: `spike-out/report.html`(30건 썸네일 비교), `scores.csv`(육안 채점표), `summary.json`, 샘플 매핑 `spike-samples/manifest.csv`
> - 남은 일: (1) scores.csv 기준 2인 육안 채점으로 table/layout 점수 확정 → Gate 0 최종 판정, (2) 한컴 SDK 견적 병행 문의는 채점 결과가 1.5 미만일 때만 진행
> - 잠정 결론: 렌더러 체인 2순위(상용 SDK) 없이 **H2Orestart 경로로 Gate 0 통과 가능성 높음**. 마스터 설계 8.3 렌더러 체인의 1차 엔진으로 승격 후보

## 목적

HWP를 서버에서 원본과 유사한 PDF로 렌더링할 수 있는지 검증한다. 이 관문이 실패하면 시각 overlay 가이드를 후순위로 내리고 텍스트 기반 가이드로 MVP를 재정의한다 (마스터 설계 17장).

통과 기준: 기업마당 HWP/HWPX 샘플 30개 기준 PDF/image 렌더링 성공률 90% 이상 + 표 구조 보존 확인.

## 렌더러 후보 (2026-07 조사 기준)

| 순위 | 후보 | 성격 | 근거 | 리스크 |
|---|---|---|---|---|
| 1 | LibreOffice headless + H2Orestart 확장 | 오픈소스 (Debian/Ubuntu 패키지 존재) | HWP/HWPX -> ODT 임포트 후 PDF 변환. dangerzone(프리덤오브프레스)이 채택할 만큼 서버 환경 검증됨 | 복잡한 표/서식에서 레이아웃 붕괴 가능 — 이번 스파이크의 측정 대상 |
| 2 | 한컴 한글 SDK (상용) | 상용 문서필터 (HWP/HWPX -> PDF/HTML) | 원본 충실도 기준 사실상 상한선. 품질 비교의 기준점 | 라이선스 비용/서버 배포 조건 확인 필요 — 영업 문의 병행 |
| 3 | rhwp 계열 (Rust+WASM 엔진, HOP 데스크탑 앱 기반) | 신생 오픈소스 | 파싱+렌더링 엔진 자체 보유, PDF export 기능 존재(HOP). 장기적으로 filled export까지 가능성 | 프로젝트가 어림 (2026년 초 공개). 서버 headless 사용은 직접 검증 필요 |
| 4 | pyhwp `hwp5html` (현재 운영 중) | 오픈소스, 코드베이스 보유 | `packages/core/src/bizinfo/hwp-markdown.ts`에서 이미 사용. 텍스트/구조 추출 baseline | 시각 렌더링 불가 — fallback 전용 |
| 5 | kordoc | 오픈소스 파서 (HWP3/5/HWPX -> Markdown) | 텍스트 경로 보강 + 양식 채우기 기능 보유. text parser pass 후보 | 렌더링 아님 — 참고용 |

스파이크는 1번을 주 대상으로 하고, 2번은 트라이얼/견적 문의를 병행하며, 3번은 30개 중 실패 샘플에 한해 2차 시도한다.

## 실행 절차

### 1. 샘플 수집 (30개 HWP/HWPX + 10 PDF + 10 DOCX)

이미 아카이브된 첨부에서 추출한다. R2에 원본이 있으므로 DB에서 목록을 뽑아 내려받는다.

```sql
-- 작성양식류 HWP 첨부 후보 (다양한 기관/양식이 섞이도록 소스별로 뽑는다)
select source, source_id, filename, archive_url, bytes
from grant_attachment_archives
where filename ~* '\.(hwp|hwpx)$'
  and (filename ~* '양식|신청서|사업계획|계획서|지원서'
       or conversion_status = 'succeeded')
order by fetched_at desc
limit 60;
```

60개를 뽑아 육안으로 "작성형 양식" 30개를 고른다 (공고문 전문 HWP 제외). 선택 기준: 빈칸/표/체크박스/서명란이 실제로 존재하는 문서.

```bash
mkdir -p spike-samples && cd spike-samples
# archive_url 목록을 urls.txt로 저장한 뒤
while read -r url; do curl -sSLO "$url"; done < urls.txt
```

### 2. 렌더러 준비 (Linux 서버 또는 로컬 docker)

```bash
# LibreOffice + H2Orestart
sudo apt-get install libreoffice libreoffice-h2orestart poppler-utils
# 또는 최신 확장 직접 설치:
# https://extensions.libreoffice.org/en/extensions/show/27504 에서 .oxt 다운로드 후
# unopkg add H2Orestart.oxt --shared

# 검증
soffice --headless --convert-to pdf 샘플.hwp --outdir /tmp/test
```

### 3. 스파이크 실행

```bash
node scripts/spike/hwp-render-spike.mjs ./spike-samples --out ./spike-out
open ./spike-out/report.html
```

스크립트는 엔진별 PDF 변환 + 페이지 썸네일 + 비교 리포트(report.html) + 채점표(scores.csv)를 생성한다.

### 4. 육안 채점 (2인)

scores.csv 기준으로 문서 x 엔진별 채점:

| 항목 | 배점 | 기준 |
|---|---|---|
| render_ok | 0/1 | PDF 생성 성공 여부 |
| table_score | 0~2 | 0 표 붕괴 / 1 셀 어긋남 있으나 판독 가능 / 2 원본 동등 |
| layout_score | 0~2 | 0 배치 붕괴 / 1 쪽나눔·여백 차이 / 2 원본 동등 |
| blank_visible | 0/1 | 빈칸/밑줄/체크박스가 시각적으로 보존되는가 (overlay 전제조건) |

### 5. 판정

- 성공률 = render_ok 비율. 90% 이상 + table_score 평균 1.5 이상이면 Gate 0 통과
- 70~90%: 통과하되 실패 유형을 분류해 렌더러 체인 fallback 규칙(마스터 8.3)에 반영
- 70% 미만: 한컴 SDK 견적과 비교 후 의사결정. SDK도 불가하면 텍스트 기반 가이드로 MVP 재정의

### 6. 산출물

- `spike-out/report.html`: 육안 비교 리포트
- `spike-out/scores.csv`: 채점 결과
- `spike-out/summary.json`: 기계 판독용 결과
- 결정 기록: 이 문서 하단에 결과와 채택 렌더러를 추가하고 마스터 설계 8.3 렌더러 체인을 갱신

## 병행 작업

- 한컴 한글 SDK 트라이얼/견적 문의 (서버 배포 라이선스 조건 포함)
- 실패 샘플에 대한 rhwp 2차 시도
- 스파이크 통과 시 이 스크립트를 GCP 변환 서버 worker의 시드 코드로 승계

## 참고 링크

- H2Orestart: https://github.com/ebandal/H2Orestart (LibreOffice 확장, Debian 패키지 `libreoffice-h2orestart`)
- 한글 SDK: https://www.hancom.com/product/sdk/hwpSdk
- rhwp: https://github.com/edwardkim/rhwp / HOP: https://github.com/golbin/hop
- kordoc: https://github.com/chrisryugj/kordoc
- pyhwp: https://pyhwp.readthedocs.io/
