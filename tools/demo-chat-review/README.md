# 일반 RHWP AI 상담 브라우저 검증

`node tools/demo-chat-review/run.mjs`

실제 `WorkspaceView`, `ChatPanel`, 공용 CSS를 번들링한 유한 실행 fixture다. 임시 localhost 서버와 격리된 agent-browser 세션은 `finally`에서 종료한다. 운영 API, 인증, 모델, DB에는 접근하지 않는다.

검증 대상:
- 정상 persistent RHWP ladder b / 필드 분석 없음에서도 AI 상담 진입
- 실제 Dialog 및 ChatPanel 입력·전송과 합성 AI SDK v1 SSE 응답 표시
- 요청이 grant context만 포함하고 draftId/fieldContext를 포함하지 않음
- 닫기·재열기 후 대화와 미전송 입력 유지
- 모바일 390px에서 대화창 너비 확인 (resize animation 안정 이후)
- 읽기 전용 관리자 미리보기에는 상담 버튼·Dialog가 없고 추가 상담 요청도 없음

증거는 `docs/evidence/demo-chat-20261001/<실행 UTC시각>/`에 별도로 저장하며 덮어쓰지 않는다. `report.json`의 `ok`가 실행 판정이다. 초기 두 실행은 resize animation이 끝나기 전 rect를 검사하여 실패했고, 안정 후 실행은 통과했다.

원본 HWPX API는 의도적으로 unavailable 응답을 반환한다. 원본 편집·실제 파일 저장, 운영 상담 응답, 모델 품질의 증거가 아니다. 일반 UI와 합성 transport에 대한 회귀 검증이다.
