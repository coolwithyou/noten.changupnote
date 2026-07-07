# hwp2hwpx 후속 트랙 착수 전 외부 대조 (2026-07-08)

> 대상 설계: `docs/plans/2026-07-07-hwpx-fill-export.md` "비범위" 절의 hwp2hwpx 경로 확정 내용.
> 직전 대조(`docs/research/2026-07-07-hwpx-fill-calibration.md`)에서 이 경로를 "유지(단서 추가)"로
> 이미 한 차례 짚었으므로, 이번은 **감독자 확정 6개 전제의 개별 판정**과 **jar 획득 경로 확답**에
> 초점을 둔 표적 대조(축소 의례 — 로컬 GitHub API 실측 + 웹 대조)로 수행. 제품·규제 축은 범위 무관
> (사용자 데이터의 양식 삽입)으로 생략하되, 경쟁 지형에서 직결 제품 1건(kordoc)이 관측되어 병기.
>
> **원칙**: "측정 전 채택 금지" — 신규 도구는 실측 후보로만 등재. 벤더/저자 주장과 실측을 구분 표기.

---

## 1. 전제별 대조표

| # | 전제 | 판정 | 근거 (출처) |
|---|---|---|---|
| 1 | hwp→hwpx 변환은 **hwp2hwpx(hwplib→hwpxlib)가 최선 경로**다 | **유지(단, 대안 1건 측정 등재)** | `.hwp5` 바이너리 → 표준 OWPML `.hwpx`를 직접 산출하는 **유일한 활성 OSS**. Apache-2.0(상용 가능). API 3줄(`HWPReader.fromFile`→`Hwp2Hwpx.toHWPX`→`HWPXWriter.toFilepath`). `src/main`에 `table/picture/equation/ole/field/여러섹션` 등 객체별 변환기(`ForCell`·`ForPara`·`ForFieldBegin` …) 존재, `test/`에 동일 항목 픽스처. 대안은 모두 hwpx를 **출력하지 못함**: pyhwp=HWP5→XML/ODT/HTML(hwpx 없음)·`hwp5odt` 레이아웃 깨짐 이슈, LibreOffice+H2Orestart=import 전용(전제 2), rhwp/unhwp/hwp2md/hwp2yaml=Markdown/YAML/렌더 지향. **단서**: kordoc(Node·MIT)는 `.hwp`를 네이티브로 읽고 `fillHwpx()`로 바로 채움 → hwp2hwpx의 Java 변환 단계 자체를 우회하는 **다른 아키텍처**라 전제 1의 범위(=hwp→hwpx 변환기 선택)는 반증하지 않으나, 트랙 전체를 대체할 후보로 4절에 등재 |
| 2 | LibreOffice+H2Orestart는 **import 전용, `--convert-to hwpx` 불가** | **유지(재검증 완료)** | H2Orestart 문서: "저장은 ODT 형식으로만" / hwpx는 ODT·PDF로만 변환. hwpx/hwp를 **쓰기(export) 대상으로 하는 필터 없음**. 최신 v0.7.13(2026-06-27)에도 hwpx export 언급 없음. → 변환은 반드시 별도 도구(Java hwp2hwpx 등) 필요 (출처: H2Orestart README / LibreOffice Extensions) |
| 3 | 변환 시점은 다운로드 요청이 아닌 **아카이브/변환 잡 배치**가 적절 | **유지** | 반증 없음. 오히려 강화 근거: (a) `java -jar` 프로세스 콜드스타트+파싱 지연이 요청 경로엔 부담(다운로드 SLA 오염), (b) 산출 `.hwpx`는 결정적·멱등 → R2 sibling artifact로 1회 생성 후 재사용, 실패 시 재시도 격리, (c) cunote에 이미 `grant_attachment_archives` 아카이브/변환 잡 파이프라인 존재. 기존 hwpx 채움은 요청 경로 동기 처리로 충분하나(순수 XML 스플라이스), **hwp→hwpx 변환만 배치로 앞당기는** 이 분리가 정합적 |
| 4 | 충실도 검증은 **원본 hwp 렌더 vs 변환 hwpx 렌더의 페이지 수·시각 diff**(기존 파이프라인)로 충분 | **보강** | 렌더 diff 재사용은 타당(Gate 0 파이프라인 실증). **그러나 두 가지 사각지대**: ① hwp2hwpx의 알려진 결함이 **미세 시각차**라 페이지 수 diff로 못 잡고 픽셀 diff 임계도 통과할 수 있음 — 이슈 #11 표/단 구분선 점선↔파선 뒤바뀜, #10 대체글꼴(substFont) 매핑, #3 셀 배경색, #9 보충문자(surrogate) 깨짐(모두 2025~2026 수정 이력이나 유형별 재발 가능). ② 원본 hwp와 변환 hwpx **둘 다 H2Orestart 같은 import 필터로 렌더**하면 "H2O가 둘을 같게 그리는가"만 검증 — **한컴 실제 렌더 동일성의 충분조건 아님**(직전 대조에서도 동일 한계 고지). → **구조 단정 + 채움 왕복 + 한컴 눈검수 표본**을 게이트에 추가 권고(5절) |
| 5 | hwp2hwpx 산출물이 **기존 라벨 셀 타게팅 채움에 그대로 합류**(hp:tbl/hp:tc/hp:cellAddr·빈 셀 보존) | **보강(측정 전 확정 금지)** | hwpxlib는 표준 OWPML을 씀 → `hp:tbl`/`hp:tc`/`hp:cellAddr` 구조 자체는 산출됨(`ForCell.java` 존재, `test/table`·`test/table_line`). 빈 hwp 셀 → 빈 hwpx 셀은 **기대**되나 **직접 실측 근거 없음**. cunote 매처는 라벨 텍스트 정규화 + **인접 빈 셀 판정**에 의존하므로, "변환 산출물에서 빈 셀·cellAddr가 네이티브 hwpx와 동일하게 남는가"를 **변환 출력 자체로** 측정해야 함(Phase 1이 검증한 네이티브 hwpx 샘플로는 불충분). **추가 리스크**: hwp2hwpx는 `fieldBegin`(누름틀)을 변환(`ForFieldBegin.java`) → 원본 hwp에 누름틀이 있으면 변환 hwpx가 **누름틀을 포함**, cunote 현 채움(셀 타게팅 우선)과 경로가 갈릴 수 있음(설계 4번의 "누름틀 우선" 확장점과 연결) |
| 6 | 변환 서버 Docker에 **jar 추가만으로 구동**(JRE 기설치) | **보강** | JRE(`default-jre-headless`)·`JAVA_HOME` 기설치는 사실 → 런타임 추가 불필요, Java 7 타깃이라 호환. **그러나 "jar 추가"는 부정확**: hwp2hwpx는 ⓐ **GitHub 릴리스/기성 jar 없음**, ⓑ **Maven Central 미등록**(`kr.dogfoot:hwp2hwpx` metadata HTTP 404), ⓒ **CLI/`main` 없음**(순수 라이브러리), ⓓ pom에 **shade/assembly 미설정**. → 소스 빌드 + 얇은 Main 래퍼 + uber jar 구성이 필요(확답은 3절). **좋은 소식**: 의존 `hwplib 1.1.10`·`hwpxlib 1.0.9`는 Maven Central에서 실제 해결됨(둘 다 HTTP 200 확인) → 빌드 시 네트워크로 자동 수신 |

---

## 2. 도구별 통합 사실표

| 도구 | 스택/라이선스 | 최신(2026-07-08 기준) | hwpx **출력** | jar/배포 | CLI | 알려진 한계·비고 |
|---|---|---|---|---|---|---|
| **neolord0/hwp2hwpx** | Java 7 / Apache-2.0 | 커밋 2026-06-25, repo 갱신 06-30, ★57·fork28 | **O (핵심)** | 릴리스·Central 모두 없음 → **소스 빌드** | **없음**(라이브러리 API만) | 이슈 #9 보충문자·#10 대체글꼴·#11 표/단 선종류·#3 셀 배경색(수정 이력). 암호화/구버전은 하부 hwplib 한계 상속 |
| **neolord0/hwplib** | Java 7 / Apache-2.0 | 창고 2026.2.4, Central **1.1.10**, ★584 | (hwp 읽기) | **Maven Central O** | 예제만 | **암호화 HWP 읽기·쓰기 미지원(명시)**, 배포용(DRM) 문서는 예외 처리, **HWP v5(5.0.x)만 — HWP 3.x 불가** |
| **neolord0/hwpxlib** | Java / Apache-2.0 | 창고 1.0.8(2025-11), Central **1.0.9**, ★178 | O(hwpx 읽기/쓰기) | **Maven Central O** | 예제만 | 표/이미지/수식/OLE 능력 매트릭스 문서 미공개(무명시). hwp2hwpx의 쓰기 백엔드 |
| **LibreOffice + H2Orestart** | Java UNO 확장 / (H2O) | v0.7.13(2026-06-27) | **X (import 전용)** | .oxt(설치본) | soffice 헤드리스 | hwp/hwpx **읽기만**, 저장은 ODT/PDF만 → **전제 2 근거** (변환 서버에 이미 설치됨) |
| **pyhwp / hwp5proc** | Python / (자체·GPL계) | Docker에 기설치 | **X** (XML/ODT/HTML) | pip | O | `hwp5odt` 레이아웃 깨짐 이슈(#184). hwpx 산출 불가. 텍스트 추출 보조용 |
| **chrisryugj/kordoc** | Node/TS / **MIT** | **v3.17.0(2026-07-06)**, 18릴리스·활발 | O (`fillHwpx()`) | **npm** | O + MCP | `.hwp5` 네이티브 읽기(OLE2/CFB), **배포용 복호화·손상 CFB 복구**(rhwp 내장), **양식 자동 채움 `fill_form`** — cunote 도메인과 **직결**. HWP3/HWP/HWPX/HWPML/PDF/Office 지원 |
| edwardkim/rhwp | Rust+WASM / MIT | 활발 | X(렌더/파싱) | crates/npm | — | HWP5 렌더러 + **배포용 복호화·lenient CFB**. kordoc이 채택 |
| iyulab/unhwp · hwpforge · hwp2md · hwp2yaml | Rust/기타 / MIT계 | 2025~2026 신규 | X (MD/YAML/JSON) | crates/npm | O | AI/추출 지향. **hwp2yaml·kordoc은 HWP 3.x 커버**(hwplib 계열이 못 하는 영역) |
| CloudConvert / FreeConvert 등 SaaS | 상용 API | — | 일부 O | API | — | **정부 공고 데이터 국외 반출 우려** → 부적합(측정 제외) |

> 주: hwplib/hwpxlib **창고(GitHub) 최신 버전이 Maven Central 최신보다 앞섬**(창고 hwplib 2026.2.4 vs Central 1.1.10). hwp2hwpx pom이 핀한 1.1.10/1.0.9는 Central에 실재하므로 빌드에는 문제없음.

---

## 3. jar 획득 경로 — 확답

**"기성 jar를 넣으면 된다"는 성립하지 않는다.** hwp2hwpx는 릴리스·Maven Central 배포·CLI·shade 구성이 모두 없다. 확정 경로는 아래 4단계다.

1. **소스 확보**: `git clone neolord0/hwp2hwpx`(Apache-2.0, ★57). 커밋 핀 권장(재현성).
2. **얇은 CLI Main 래퍼 추가**(신규 파일 1개): `main(args)`에서 in/out 경로를 받아
   `HWPReader.fromFile(in)` → `Hwp2Hwpx.toHWPX(...)` → `HWPXWriter.toFilepath(..., out)` 호출.
   (`Parameter.java`로 변환 옵션 조정 여지 확인 후 배선)
3. **uber jar 빌드**: pom에 `maven-shade-plugin`(또는 assembly) + `mainClass` 매니페스트 추가 →
   `mvn package`. 의존 `hwplib 1.1.10`·`hwpxlib 1.0.9`는 **Maven Central에서 자동 해결**(실측 HTTP 200).
   (대안: `dependency:copy-dependencies` + `-cp` 클래스패스 구동)
4. **Docker 반영**: uber jar를 이미지에 `COPY`, `java -jar hwp2hwpx-cli.jar in.hwp out.hwpx`로 구동.
   JRE(`default-jre-headless`)·`JAVA_HOME` 기설치라 런타임 추가 없음. Java 7 타깃이라 현 JRE 호환.

> Dockerfile 변경 형태: 현 단일 스테이지에 Maven 빌드를 얹거나(빌드 스테이지 추가), **jar를 사전 빌드해 리포에 커밋**할지 결정 필요. 전자는 이미지 빌드 시 Maven·인터넷 필요, 후자는 산출물 바이너리 커밋(재현성 메모 필수). 감독자 결정 사항.

---

## 4. 개선 후보 (측정 전 채택 금지 — 후보 등재만)

- **kordoc** (`github.com/chrisryugj/kordoc`, Node/TS·MIT, v3.17.0·2026-07-06) — **최우선 측정 후보이자 최대 변수**.
  - (a) **아키텍처 축약 가능성**: `.hwp5`를 네이티브로 읽고(OLE2/CFB + rhwp 배포용 복호화·손상 복구) `fillHwpx()`로 원본 서식 100% 보존 채움 + `.hwpx` 출력. **Node 스택이라 cunote와 동일** → Java hwp2hwpx 변환 단계 + core 자체 hwpx-fill 모듈을 **하나의 npm 의존으로 대체**할 여지. 도입 시 변환 서버 Java 경로·jar 빌드 부담 소거.
  - (b) **경쟁 지형 신호**: 정부 양식 자동 채움 + 신구대조 + MCP를 이미 제공(제작자=구청 7년 HWP 실무자). cunote 핵심 가치와 직접 겹침 → 포지셔닝·차별화 재점검 필요(필드테스트 전 대조로 이월 권고).
  - **측정 항목**: ① 변환/채움 충실도(cunote 골든 hwpx 대비), ② 빈 셀·라벨 매칭이 cunote 정책(빈 셀만·덮어쓰기 금지)과 합치하는지, ③ 배포용/손상 hwp 실제 커버율, ④ 라이선스·데이터 처리 위치(로컬 실행이면 국외 반출 무관), ⑤ MCP/API 안정성·유지보수 지속성.
- **kordoc/rhwp의 배포용 복호화** — hwplib이 못 하는 배포용(DRM) hwp 커버의 **폴백 후보**. cunote 코퍼스에서 배포용 첨부 빈도부터 실측(대개 "채우라고 배포하는 양식"은 DRM 미적용이나, 읽기전용 배포 기관 존재).
- **python-hwpx**(직전 대조 등재분) — 변환이 아닌 **채움 교차 검증 오라클**로 유효성 유지(변환 트랙에는 직접 관여 안 함).

---

## 5. 권고 — 스파이크(Phase 0급) 리스크 목록

착수 시 아래를 게이트 기준·측정 항목으로 명시할 것.

1. **[전제 6] 빌드 산출물 정의 확정** — uber jar 빌드 위치(이미지 빌드 스테이지 vs 사전 커밋), Main 래퍼 소유, hwp2hwpx 커밋 핀. "jar만 넣으면 됨" 가정 폐기.
2. **[전제 5] 변환 출력의 구조 단정** — 변환 hwpx에서 `hp:tbl`/`hp:tc`/`hp:cellAddr`·**빈 셀** 보존, 라벨 텍스트가 cunote 매처가 찾는 `hp:t` 위치에 안착하는지 **변환 산출물 자체로** 검증(네이티브 hwpx 샘플로 대체 금지).
3. **[전제 5] 채움 왕복 실측** — 변환 hwpx를 실제로 `fillHwpxTemplate`에 통과 → 채움 성공 + 미채움 정직 보고가 네이티브 hwpx와 동등한지. **누름틀 포함 변환본** 별도 케이스(설계 4번 확장점).
4. **[전제 4] 렌더 diff 사각지대 보강** — 페이지 수 + 픽셀 diff에 더해 (a) 표/셀/문단 카운트 구조 단정, (b) 알려진 결함 유형(선종류·대체글꼴·셀 배경·보충문자) 표적 점검, (c) **한컴오피스 수동 눈검수 표본 ≥1**. H2O로 양쪽 렌더는 "한컴 동일성"의 충분조건 아님을 명시.
5. **[전제 1·하부] 포맷 커버리지 경계** — hwplib은 **HWP v5 전용**: HWP 3.x·암호화·배포용(DRM) hwp는 변환 실패 → 매직바이트/파서 예외를 **정직 스킵**으로 처리하고 UI 고지. 코퍼스 내 3.x·배포용 빈도 사전 실측.
6. **[전략] kordoc 병행 측정** — Phase 0 스파이크에 kordoc `fillHwpx` 경로를 **동일 골든셋 대조 대상**으로 병렬 측정. Java 변환 트랙과 Node 단일 의존 트랙 중 실측 우위로 결정(측정 전 어느 쪽도 확정 금지).

---

## 6. 불확실성 (정직 고지)

- **변환 충실도는 문서 유형별 실측 전** — hwp2hwpx 테스트 픽스처 존재 ≠ cunote 코퍼스 무손실. DB의 hwp 다수(직전 대조 시 1,238건 규모)가 측정 모집단.
- **빈 셀·cellAddr 보존은 코드 구조 추론이며 실측 미검증** — 반드시 변환 출력으로 확인.
- **hwplib 배포용(DRM) 처리 상태 모호** — README에 "배포용 문서 읽기" 항목과 "배포용은 미지원 예외 처리"(이슈 #188)가 공존. 실제 지원 범위는 실측 필요.
- **한컴 실제 오픈/렌더 호환은 LibreOffice 렌더로 대체 불가** — 사용자 한컴 수동 확인이 여전히 최종 관문(직전 트랙과 동일 원칙).

---

## 출처 (2026-07-08 열람)

- https://github.com/neolord0/hwp2hwpx — README(API 3줄)·pom.xml(version 1.0.0, deps hwplib 1.1.10·hwpxlib 1.0.9, junit)·`src/main/java/kr/dogfoot/hwp2hwpx/*`(Converter·Hwp2Hwpx·Parameter·ForCell·ForFieldBegin …)·`test/*`(table·picture·equation·ole·field·여러섹션)·커밋(2026-06-25 이슈 #9/#10/#11)·릴리스 없음·★57/fork28
- https://github.com/neolord0/hwplib — 창고 2026.2.4, 암호화·배포용·HWP v5 한계 명시, ★584
- https://github.com/neolord0/hwpxlib — 창고 1.0.8(2025-11), Apache-2.0, ★178
- Maven Central 실측: `hwplib 1.1.10`(HTTP 200)·`hwpxlib 1.0.9`(HTTP 200)·`hwp2hwpx` metadata(HTTP 404, 미등록)
- https://github.com/ebandal/H2Orestart — import 전용, 저장 ODT만, v0.7.13(2026-06-27) (LibreOffice Extensions #27504 교차)
- https://github.com/chrisryugj/kordoc — v3.17.0(2026-07-06), MIT, `fillHwpx()`·`fill_form`·배포용 복호화(rhwp)·MCP
- https://github.com/edwardkim/rhwp · https://github.com/iyulab/unhwp · https://github.com/mete0r/pyhwp(issue #184) · https://github.com/seunghyuoffice-design/hwp2yaml — 대안 도구 대조
