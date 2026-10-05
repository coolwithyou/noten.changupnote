# 창업노트 6개월 회고

본사 팀 공유용 자료. 기간은 **2026-04-01~2026-10-01**, 기록 기준은 **2026-10-01 09:26 KST**다. 이 자료는 창업노트 저장소의 현재 접근 가능한 로컬 heads/remotes와 기획·검증 문서를 사용했다. 다른 프로젝트의 업무 기록은 조사 범위에 포함하지 않았다.

- [전체 기록 HTML](history.html): 초기 아이디어, 고민의 변화, 성과·미달성 목표·다음 방향, 개발기간 2026-06-19~10-01(105일)의 16주·92개 기록 일자를 표시한다. 작업 기록이 없는 날짜와 주는 표시하지 않으며, 주별 일지와 커밋 근거는 기본으로 모두 펼쳐져 있다. 검색·월 필터·전체 접기/펼치기를 제공한다.
- [발표용 HTML](slides.html): 브라우저에서 바로 열리는 22장. 방향키/Space/PageDown으로 이동, Home/End, N 발표자 노트, F 전체 화면, P 인쇄. 1~16장은 본 발표, 17~21장은 주별 리뷰, 22장은 출처·해석 기준이다.
- [편집 가능한 PowerPoint](review.pptx): 22장. 텍스트·도형으로 작성했고 모든 슬라이드의 발표자 노트에 근거와 검증 범위를 담았다.
- [슬라이드 PDF](slides.pdf): 발표용 HTML을 동일한 22페이지로 인쇄한 읽기 전용 사본.
- `team-share.zip`: 위 자료와 source JSON, 이 안내를 묶은 공유용 압축본. 압축을 풀고 `history.html` 또는 `slides.html`을 연다.
- Claude Design 덱: [창업노트 6개월 회고](https://claude.ai/design/p/2338212d-fb9d-4fc1-aa9a-a657f967a9eb?file=%EC%B0%BD%EC%97%85%EB%85%B8%ED%8A%B8+6%EA%B0%9C%EC%9B%94+%ED%9A%8C%EA%B3%A0.dc.html) (Toss Design System, 1920×1080, 28장). `source/deck.json`을 바탕으로 만들었지만, 개발자가 아닌 팀원도 읽을 수 있도록 화면 문구와 발표자 노트를 쉬운 한국어로 다시 썼다(예: '봉인한 커밋' → '코드를 저장한 횟수', 'main 포함/외' → '본 서비스에 합쳐진 것/따로 작업 중인 것', 'exact release cohort'·'베타 공급' → '비공개 베타 대상 소규모 반영'). 2026-10-05에는 [10월 1일 오후 시연](../../demos/2026-10-01-afternoon-demo/index.html)의 실제 서비스 캡처 9장을 넣었다. 12~17장 '직접 보기'(조건 확인 → 양식과 회사 정보 → AI 상담 → 초안 검토 → 저장·다시 열기)를 새로 만들었고, 5·9·11장에도 화면을 붙였다. 시연 화면은 회고 숫자의 기준 시각(10/1 09:26)보다 뒤의 기록이라 28장 노트에 그 구분을 적었다. 그래서 문구와 장 수는 `deck.json`·HTML 덱·PPTX와 다르고, 회고 숫자·출처 목록은 같다. 편집기에서 직접 고치거나 PPTX/PDF로 내보낼 수 있다. `claude-design-deck.dc.html`은 그 원본 사본이고 `uploads/`는 덱이 쓰는 캡처 원본이다(출처: `3d58a8c:docs/evidence/demo-live-20261001/`, `web-deployment-20261001/landing-1440.png`). Claude Design 런타임(`support.js`, `deck-stage.js`)이 있어야 렌더된다. 처음 만든 22장 프로젝트(`66ad9e8f…`)는 10/5 현재 연결된 Claude Design 계정에서 열리지 않아 새 프로젝트로 다시 올렸다. 이 덱은 `team-share.zip`에 포함하지 않았다.

HTML은 서버나 외부 폰트 없이 `file://`에서 동작한다. 커밋 원문은 HTML 안에 포함돼 있다. 커밋·브랜치 문서의 GitHub 링크는 저장소 접근 권한이 필요할 수 있다. 전체 문서 링크는 이 저장소 안의 상대 경로이고, 공유용 ZIP에서는 원본 저장소 문서를 대신하는 source 발췌를 볼 수 있다. TDS 공식 Colors·Typography 문서의 블루·회색 토큰과 타이포 위계를 참고했고, 로컬에서 이용 가능한 Apple SD Gothic Neo·시스템 대체 폰트를 사용했다.

## 기록과 해석

첫 Git 기록은 6/25, 초기 문서의 자체 날짜는 6/19와 6/24다. 4/1~6/18 활동은 이 저장소에서 확인할 수 없다. 기록 공백을 활동 부재로 해석하지 않는다. 봉인한 Git 1,445개는 main 포함 1,206개와 main 외 239개이며 SHA로 중복 제거했다. 병합·문서 커밋을 포함하므로 기능 수나 성과 수가 아니다. Git authorDate를 KST 일자로 환산했다.

초기 구상, 실제 변경, 역사 검증·배포 기록, 회고자의 해석과 미래 제안을 구분했다. 구현·테스트·화면 배포와 실제 사용자 인수를 동일한 성과로 표시하지 않는다. 현재 운영 전수 상태·선정률·고객 시간 절감을 이번 조사에서 새로 검증하지 않았다. 자동 제출은 초기부터 사용자 책임이었으므로 미달성 개발 목표로 넣지 않았다. 9월 초 문서의 ‘운영 승격 0회’ 주장은 8/17의 9/9 적용 기록으로 정정했다.

## 재현과 검증

- `source/git-history.json`: 봉인한 refs, SHA·날짜·커밋 원문과 main 포함 여부.
- `source/document-evidence.json`: 읽은 문서의 해시·상태·발췌. 작성 브랜치의 문서는 `ce67775`의 커밋 내용을 사용했다.
- `source/editorial.json`: 일자별 요약과 전체 주간 평. 사실을 요약하고 평가는 직접 작성한 해석이다.
- `source/deck.json`: HTML 덱과 PPTX가 함께 사용하는 발표 원고·노트·출처.
- `validation.json`: 데이터·링크·오프라인 브라우저·PPTX 구조/폰트/배치·22장 렌더 검토 결과와 산출물 SHA.

HTML 재생성: `python3 build_html.py`. 봉인된 데이터만 사용하며 현재 Git을 재조회하지 않는다.

PPTX 재생성은 설치된 Codex primary runtime의 `@oai/artifact-tool`과 Presentations 스킬을 사용한다. 해당 런타임의 `RUNTIME_NODE_MODULES`, `RUNTIME_PYTHON`, 스킬의 `SKILL_DIR`을 환경변수로 지정하고 `build_pptx.mjs`를 실행한다. 기존 출력은 덮어쓰지 않으므로 재생성 때 `PPTX_NAME=review-r2.pptx` 등 새로운 이름을 지정한다. `.build/`는 비공개 임시 검증 경로이며 커밋하지 않는다.

PowerPoint 앱에서 직접 인수한 자료는 아니다. Artifact Tool로 최종 PPTX를 다시 불러와 모든 슬라이드를 렌더링했고, HTML은 실제 Chromium에서 오프라인·데스크톱/390px 모바일·조작을 확인했다. 운영 코드·배포·DB·live 모델 실행은 이 회고 제작에서 변경하지 않았다.
