# 사업자 정보 기반 디자인 검증

검수·개선 방향은 [계획](../../plans/2026-10-01-company-aware-design.md), 수행 기록은
[진행 파일](../../../PROGRESS-company-aware-design-20261001.md)을 따른다.

## 재현

저장소 루트에서 `node tools/design-company-review/run.mjs`를 실행한다. 필요한 로컬
의존성은 기존 pnpm 설치본, tsx/esbuild, postcss/Tailwind, `agent-browser`이다. 실제 제품
컴포넌트와 실제 전역 CSS를 번들하고 회사·공고·문안 응답만 합성 데이터로 바꾼다.
외부 DB·R2·AI 호출 없이 임시 포트에서 실행하며 finally에서 서버/브라우저/번들을 정리한다.

[report.json](report.json)의 sourceSha와 sourceDiffSha256이 검증한 제품 소스를 식별한다.
source diff는 비어 있으며, 문서와 harness의 후속 커밋은 제품 소스를 바꾸지 않는다.

## 화면 증거

- [탐색 모바일](explore-390.png), [탐색 데스크톱](explore-1440.png)
- [상세 모바일](detail-390.png), [상세 데스크톱](detail-1440.png), [불일치와 저장본 복귀](detail-failed-saved-390.png)
- [문항 작성 모바일](writing-390.png), [통합 작성 데스크톱](workspace-1440.png)
- [통합 작성 모바일](workspace-390.png), [신청 관리 모바일](applications-390.png)

360/390/1440px 레이아웃, 회사 A/B 값 교체, partial/disputed/unknown/discovery,
문안 PUT 저장, 저장 문안 비교/반영 callback, 409 입력 보존·비교·재저장, 읽기 권한,
마감 저장본 복귀, 회사 문맥을 유지한 상세 링크, 늦은 이전 회사 GET 격리,
통합 작성 탭 왕복 후 dirty 입력 유지와 브라우저 runtime 오류를 확인한다.

## 검증 한계

합성 API 저장·반영 callback은 운영 DB/R2 저장의 증거가 아니다. 원본 HWPX API는 의도적으로
source unavailable을 반환한다. 실제 RhwpStudioSurface의 오류 상태와 저장/다운로드 제한을
확인했으며 성공 원본 편집·내보내기 인수는 포함하지 않는다. 필드 반영의 실제 transaction
안전성은 관련 회귀 테스트로 검증했다. 실제 회사 인증·운영 저장·모델 실행·배포는 별도다.

최종 결과: 31 checks / 21 captures PASS. 자격 불일치·서울 값·부산 조건과 회사 문맥을 보존한 저장본 복귀가 함께 표시됨을 검증했다.
