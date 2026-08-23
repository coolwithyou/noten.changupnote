# RHWP Studio 임베드 실화면 검증 시나리오

> 상태: 실행 대기
>
> 작성일: 2026-08-22
>
> 판정 범위: `밝은 테마 + 플랫 스킨 + 임베드 메뉴 + 제품 정보 접근성` UI 계약만
>
> 실행 환경: Codex Desktop에서 이 저장소를 로컬 프로젝트로 연 세션

## Codex Desktop에 전달할 실행 지시문

아래 문구와 이 문서 경로를 Codex Desktop 채팅에 전달한다.

```text
이 저장소의 AGENTS.md와
docs/plans/2026-08-22-rhwp-studio-embed-실화면-검증-시나리오.md를 먼저 전부 읽어.
문서에 정의된 실화면 검증만 순서대로 수행해.
코드·문서·DB·Git 상태를 수정하지 말고, 개발 서버를 직접 시작하거나 재시작하지 마.
HWP와 HWPX의 필수 항목을 각각 화면 캡처로 증명하고,
하나라도 실패하거나 확인하지 못하면 GO라고 하지 말고 STOP으로 보고해.
```

Codex Desktop의 현재 프로젝트·파일·브라우저 작업 흐름은 [OpenAI 공식 Desktop 앱 문서](https://learn.chatgpt.com/docs/app)를 준거로 한다.

## 1. 목적과 비범위

이 검증은 창업노트가 RHWP Studio를 임베드했을 때 다음 네 가지가 실제 화면에서 동작하는지 확인한다.

1. Studio가 항상 밝은 테마와 플랫 스킨으로 열린다.
2. 호스트가 소유하는 새 문서·열기·저장·다른 이름으로 저장·출력 메뉴는 Studio 내부에서 노출되지 않는다.
3. 편집에 필요한 메뉴·도구 모음·상태 표시는 남는다.
4. `제품 정보`와 오픈소스 고지는 파일 메뉴에서 계속 접근할 수 있다.

이 문서로는 다음을 판정하지 않는다.

- RHWP 또는 의존성의 최종 법률 준수 여부
- Document Agent Phase 0 전체 GO
- 서버 저장·배포·운영 준비 상태
- 모바일·태블릿 반응형 품질

## 2. 핵심 실행 경계

검증 세션은 읽기 전용으로 운영한다.

### 허용

- `AGENTS.md`, 관련 코드, Git 상태 읽기
- 사용자가 이미 실행한 `127.0.0.1:4010` 서버 사용
- 개발용 브라우저 게이트에 로컬 HWP/HWPX를 읽기 전용으로 선택
- `local_preview` 화면에서 메뉴 열기·닫기와 화면 캡처

### 금지

- 코드·문서·설정 수정, commit, push, 배포
- `pnpm dev:web`, `next dev` 등 서버 시작·재시작·종료
- HWP/HWPX 원본을 저장소 fixture로 복사하거나 덮어쓰기
- `이 탭에 반영`, `편집본 다운로드`, `반영하고 빠른 작성으로` 버튼 실행
- 서비스 DB, 운영 스토리지, 외부 시스템에 쓰기
- 검증 중 문제를 발견했을 때 그 세션에서 바로 코드를 고치기

파일 선택기를 Codex Desktop이 제어할 수 없다면 사용자에게 해당 형식의 문서만 선택해 달라고 요청한다. 이는 실패가 아니라 사람 입력 대기다.

## 3. 준비물

- 민감하지 않은 실제 HWP 문서 1개
- 민감하지 않은 실제 HWPX 문서 1개
- 사용자가 실행한 웹 개발 서버
- 주요 메뉴가 잘리지 않는 데스크톱 뷰포트. 권장은 가로 1280px 이상이다.

화면 캡처는 문서 본문보다 Studio chrome과 메뉴를 중심으로 잘라서 사용한다. 원문 내용이 노출되는 캡처는 저장소에 추가하거나 외부로 공유하지 않는다.

## 4. 사전 점검

Codex Desktop은 저장소 루트에서 다음을 읽기 전용으로 실행한다.

```bash
pwd
git status --short --branch
git rev-parse HEAD
rg -n 'searchParams\.set\("chrome", "embed"\)|view:theme-light|view:skin-flat|applyEmbeddedRhwpStudioPresentation' \
  apps/web/src/lib/rhwp/editorClient.ts \
  apps/web/src/features/apply-workspace/RhwpStudioSurface.tsx
lsof -nP -iTCP:4010 -sTCP:LISTEN
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4010/dev/document-agent-phase0
```

사전 점검 통과 조건은 다음과 같다.

- 현재 경로가 `/Users/ffgg/noten.works/cunote`다.
- `git status`의 기존 dirty/untracked 파일을 기록했고 건드리지 않는다. clean worktree는 요구 사항이 아니다.
- 소스에 `chrome=embed`, `view:theme-light`, `view:skin-flat`, `RhwpStudioSurface` 표시 설정 호출이 모두 존재한다.
- 사용자 소유 프로세스가 `127.0.0.1:4010`에서 LISTEN 중이다.
- 게이트 URL이 HTTP 200을 반환한다.

서버가 없으면 직접 시작하지 말고 다음만 보고한 뒤 STOP한다.

```text
BLOCKED: 127.0.0.1:4010에 사용자 소유 개발 서버가 없습니다.
저장소 루트에서 pnpm dev:web을 실행한 뒤 알려주세요.
```

## 5. 형식별 실행 순서

아래 순서를 HWP와 HWPX에 각각 독립적으로 실행한다. 두 번째 형식은 게이트 URL을 새로 열어 시작한다.

### 5.1 실제 `RhwpStudioSurface`까지 진입

1. `http://127.0.0.1:4010/dev/document-agent-phase0`을 연다.
2. `Phase 0 실문서` 파일 선택에서 해당 형식의 문서를 선택한다.
3. 상태가 `ready`이고 안내가 `public command capability와 후보 준비 완료`로 바뀐 때까지 기다린다.
4. `native apply/export/revert 실행`을 누른다.
5. 상태 `agent_pass`와 `Studio native apply/revert와 receipt/export/focus/event 게이트가 통과했습니다.`를 확인한다.
6. `실제 RhwpStudioSurface 회귀 열기`를 누른다.
7. 호스트 헤더의 `문서 직접 편집` 배지와 Studio 안의 `N쪽 열림` 표시가 나올 때까지 기다린다.

> 주의: 2~5단계의 direct Studio는 실문서를 안전하게 apply/revert하기 위한 사전 하네스다. **테마·스킨 UI 판정은 6단계 이후의 실제 `RhwpStudioSurface`에서만 한다.**

`ready` 또는 `agent_pass`에 도달하지 못하면 오류 문구와 화면을 캡처하고 `P-01 BLOCKED`로 판정한다. 이 경우 UI 판정 대상에 진입하지 못했으므로 시각 기능 FAIL로 표현하지 않는다. 검증자가 하네스를 수정해 우회하면 안 된다.

### 5.2 V-01 — 전체 chrome과 호스트 제어

화면 전체를 확인한다.

- Studio 메뉴바·도구 모음·문서 캔버스·상태 표시가 서로 겹치거나 잘리지 않는다.
- 편집기 배경은 밝은 흰색/회색 계열이고, 문자와 아이콘은 충분히 짙어 읽힌다.
- 선택·활성 상태는 푸른색 계열로 구분된다.
- 광택·강한 그라데이션·지나친 입체 그림자가 없는 플랫 스킨이다.
- Studio 밖 호스트 영역에 `이 탭에 반영`, `편집본 다운로드`, `반영하고 빠른 작성으로` 버튼이 남아 있다. 누르지는 않는다.

필수 증거: Studio 전체와 호스트 헤더가 함께 보이는 화면 캡처 1장.

### 5.3 V-02 — 밝은 테마와 플랫 스킨 선택 상태

1. Studio의 `보기` 메뉴를 연다.
2. 테마 항목에서 `밝게` 또는 동일 의미의 light 선택지가 활성 상태인지 확인한다.
3. 스킨 항목에서 `플랫`이 활성 상태인지 확인한다.
4. 메뉴를 열어도 툴바와 문서 캔버스가 다크 테마로 바뀌지 않는다.

필수 증거: 활성 상태가 보이도록 `보기` 메뉴를 연 화면 캡처 1장.

메뉴에 선택 표시가 없거나 다른 테마/스킨이 활성이면, 문서 로드가 정상이어도 UI 계약은 FAIL이다.

### 5.4 V-03 — 파일 메뉴의 임베드 프로필

Studio의 `파일` 메뉴를 열고 다음을 확인한다.

없어야 하는 호스트 소유 명령:

- 새 문서
- 열기·최근 문서·최근 목록 지우기
- 저장·다른 이름으로 저장·HWP/HWPX 형식별 저장
- HTML/DOC 내보내기
- 인쇄·PDF 출력

남아야 하는 명령:

- 쪽 설정 또는 페이지 설정
- 제품 정보

필수 증거: `파일` 메뉴 전체가 보이는 화면 캡처 1장.

문구가 약간 다르더라도 같은 문서 수명주기 기능이면 숨겨져야 한다. 없어야 하는 명령이 하나라도 노출되면 FAIL이다.

### 5.5 V-04 — 편집 메뉴 무회귀

Studio의 `편집` 메뉴를 연다.

- 실행 취소·다시 실행·복사·붙여넣기 등 일반 편집 명령은 남아 있다.
- 호스트 수명주기와 충돌하는 `문서 비교`는 노출되지 않는다.

필수 증거: `편집` 메뉴 전체가 보이는 화면 캡처 1장.

### 5.6 V-05 — 제품 정보와 라이선스 고지 접근성

1. `파일 > 제품 정보`를 연다.
2. 대화상자 제목이 `제품 정보`인지 확인한다.
3. `HWP/HWPX Compatible Module for Rust`, 현재 버전, `Rust + WebAssembly + TypeScript`가 표시되는지 확인한다.
4. 한글 문서 파일 공개 문서를 참고했다는 출처 고지가 표시되는지 확인한다.
5. 오픈소스 라이선스 목록과 전체 목록 안내가 표시되는지 확인한다.
6. `닫기`로 대화상자를 닫은 뒤 Studio 편집 화면으로 돌아가는지 확인한다.

필수 증거: 문서 본문 노출을 최소화하게 잘라낸 `제품 정보` 대화상자 화면 캡처 1장.

버전·저작권 연도·의존성 목록은 배포본에 따라 바뀔 수 있으므로 특정 값과 다르다는 이유만으로 FAIL하지 않는다. 실제 표시값을 보고서에 기록한다.

### 5.7 형식 세션 종료

1. `제품 정보` 대화상자가 닫혔는지 확인한다.
2. 호스트 저장·다운로드·빠른 작성 버튼을 누르지 않고 탭을 닫거나 게이트 URL을 새로 연다.
3. 다음 형식으로 5.1~5.6을 반복한다.

## 6. 필수 판정표

`PASS`, `FAIL`, `BLOCKED`, `NOT RUN`만 사용한다. 확인하지 않은 칸을 추정으로 PASS 처리하지 않는다.

| ID | 필수 판정 | HWP | HWPX | 증거 |
|---|---|---|---|---|
| P-01 | `ready` → `agent_pass` 사전 하네스 통과 |  |  | 상태/오류 문구 |
| V-01 | 밝은 플랫 chrome, 툴바·문서·호스트 제어 정상 |  |  | 전체 화면 |
| V-02 | `보기`에서 light + flat 활성 |  |  | 보기 메뉴 |
| V-03 | 파일 수명주기 명령 숨김, 쪽 설정·제품 정보 유지 |  |  | 파일 메뉴 |
| V-04 | 일반 편집 명령 유지, 문서 비교 숨김 |  |  | 편집 메뉴 |
| V-05 | 제품 정보·출처·오픈소스 고지 접근 가능 |  |  | 제품 정보 모달 |

## 7. GO, FAIL, BLOCKED, STOP

### UI GO

다음을 모두 만족할 때만 `RHWP embed visual GO`라고 보고한다.

- 필수 판정표 12칸(HWP 6 + HWPX 6)이 모두 PASS다.
- 각 PASS에 화면 캡처 또는 식별 가능한 상태 증거가 있다.
- 검증 전후 `git status --short --branch`가 동일하다.
- 검증자가 원본 문서, 저장소, DB, 외부 시스템을 수정하지 않았다.

### FAIL

다음 중 하나라도 있으면 해당 형식을 FAIL로 판정한다.

- 실제 `RhwpStudioSurface`가 다크 테마 또는 비플랫 스킨으로 열림
- `보기` 메뉴의 light/flat 선택 상태 불일치
- 새 문서·열기·저장·내보내기·인쇄 중 하나라도 Studio 파일 메뉴에 노출
- `제품 정보`가 없거나 대화상자가 열리지 않음
- 툴바·문서 캔버스·호스트 제어가 겹치거나 읽을 수 없음
- `실제 RhwpStudioSurface 회귀 열기` 후 편집 화면 로드에 실패

표시 설정 command 실패는 문서 로드를 차단하지 않도록 구현되어 있다. 따라서 문서가 열려도 테마·스킨이 다르면 기능 로드 PASS와 UI FAIL을 분리해 기록한다.

### BLOCKED

다음은 제품 FAIL이 아닌 환경·사람 입력 차단이다.

- 사용자 소유 개발 서버 부재
- Codex Desktop 또는 macOS의 파일 선택 권한 부재
- 민감하지 않은 HWP/HWPX 검증본 부재
- RHWP Studio 배포 URL 또는 필수 네트워크 접속 불가
- `ready` 또는 `agent_pass`에 도달하지 못해 실제 UI 판정 대상에 진입하지 못함

BLOCKED면 원인과 사용자가 해결할 한 가지 조치를 적고 STOP한다. 임의로 서버를 시작하거나 다른 문서로 대체하지 않는다.

### 최종 STOP 규칙

- 필수 판정표에 FAIL, BLOCKED, NOT RUN이 하나라도 있으면 STOP이다.
- STOP 상태에서 나머지 형식을 안전하게 계속 확인할 수 있으면 증거를 더 수집해도 되지만, 최종 판정을 GO로 바꾸지 않는다.
- `RHWP embed visual GO`는 법률 검토, Document Agent Phase 0 GO, commit, push, 배포를 승인하지 않는다.

## 8. Codex Desktop 최종 보고서 템플릿

```markdown
# RHWP Studio 임베드 실화면 검증 결과

- 판정: RHWP embed visual GO | STOP
- 실행 일시/KST:
- 저장소: /Users/ffgg/noten.works/cunote
- branch:
- HEAD:
- 실행 URL: http://127.0.0.1:4010/dev/document-agent-phase0
- 뷰포트:
- HWP 검증본: 파일명만 기록 | 사용자 선택
- HWPX 검증본: 파일명만 기록 | 사용자 선택
- 관찰한 RHWP 버전:

| ID | HWP | HWPX | 증거 |
|---|---|---|---|
| P-01 |  |  |  |
| V-01 |  |  |  |
| V-02 |  |  |  |
| V-03 |  |  |  |
| V-04 |  |  |  |
| V-05 |  |  |  |

## 실패·차단 상세

- 형식/ID:
- 실제 화면:
- 기대 화면:
- 오류 문구:
- 재현 순서:
- 사용자에게 필요한 다음 조치:

## 변경 없음 확인

- 검증 전후 git status 동일: YES | NO
- 원본 HWP/HWPX 변경 없음: YES | NO
- 저장소·DB·외부 시스템 쓰기 없음: YES | NO

## 잔여 위험

- 이 결과는 UI 계약만 판정한다.
- 법률 검토, Phase 0 전체 GO, commit, push, 배포는 별도다.
```

## 9. 근거 코드 위치

- [`apps/web/src/lib/rhwp/editorClient.ts`](../../apps/web/src/lib/rhwp/editorClient.ts) — `chrome=embed`, light/flat command
- [`apps/web/src/features/apply-workspace/RhwpStudioSurface.tsx`](../../apps/web/src/features/apply-workspace/RhwpStudioSurface.tsx) — 실제 Studio 초기화·표시 설정·호스트 제어
- [`apps/web/src/app/dev/document-agent-phase0/page.tsx`](../../apps/web/src/app/dev/document-agent-phase0/page.tsx) — HWP/HWPX 인메모리 브라우저 게이트
- [`apps/web/src/lib/rhwp/editorClient.test.ts`](../../apps/web/src/lib/rhwp/editorClient.test.ts) — URL·command·초기 로드 계약 자동 테스트
- [`docs/plans/2026-08-18-document-editor-ai-agent.md`](./2026-08-18-document-editor-ai-agent.md) — Phase 0 브라우저 GO/STOP의 상위 계약
