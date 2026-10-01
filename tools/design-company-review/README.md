# 사업자 맥락 디자인 브라우저 fixture

`node tools/design-company-review/run.mjs`는 현재 제품 React 컴포넌트와 실제 `globals.css`를 번들하여
유한한 로컬 HTTP fixture 서버에서 검증하고 종료 시 서버·브라우저·임시 번들을 정리합니다.
`agent-browser` 및 저장소에 설치된 esbuild/postcss를 사용하며 개발 서버를 시작하지 않습니다.

출력: `docs/evidence/company-aware-design-20261001/report.json` 및 1440/390/360px PNG.
회사·공고·API 응답은 명시적으로 표시한 합성 데이터이며 운영 DB·모델·외부 API에 접근하지 않습니다.
브라우저 라우팅 context만 stub하고 core 함수는 production 구현을 그대로 재수출합니다.

통합 WorkspaceView와 RhwpStudioSurface도 실제 컴포넌트입니다. 원본 HWPX는 fixture에 연결하지 않아
source-file API가 명시적인 404를 반환합니다. 원본 읽기 실패 UI·상단 파일 저장 상태·병렬 문항 패널·
모바일 탭 입력 보존을 검증하지만 원본 편집·다운로드 인수 완료를 주장하지 않습니다.
단독 문항 패널의 검증된 입력 위치 반영은 synthetic callback까지 검증합니다.
