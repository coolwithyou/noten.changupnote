# 변환 워커 임시 파일 정리

## 목표와 완료 조건

- 변환 서버가 문서별 임시 작업 디렉터리를 업로드 완료 후 성공·실패 모두에서 지운다.
- 변환 실패와 R2 업로드 실패에도 작업 디렉터리를 남기지 않고, 성공한 artifact 응답은 유지한다.
- 변환 서버 빌드와 해당 회귀 검사를 통과한다.
- 운영 적용 시 현재 Cloud Run revision의 CPU 할당 정책을 확인하고, 대기열 완료율을 실제 관측한다.

## 2026-09-28 작업·검증

- `origin/main@83981b3`에서 별도 브랜치를 만들어 PR #19의 웹/DB 승인 범위와 분리했다.
- `ConversionQueue.runJob`은 작업 시작 전 `cunote-job.*` 디렉터리를 만들지만 종료 시 제거하지 않았다. 변환 산출물 업로드가 끝난 후 `finally`에서 해당 디렉터리를 삭제하도록 수정했다. 임시 디렉터리 생성 오류도 job 실패 기록으로 귀결된다. 삭제 오류는 기록하되 이미 업로드된 성공 artifact를 실패로 바꾸지 않는다.
- 격리 TMPDIR에서 정상 PDF 업로드, 포맷 실패, 업로드 실패 세 경로의 디렉터리 정리를 검사했다. 정상 업로드에서는 업로드 함수 실행 중 작업 파일이 살아 있고 완료 뒤 제거됨을 확인했다.
- `pnpm install --frozen-lockfile --offline`, `pnpm build:packages`, `pnpm --filter @cunote/conversion build`, `pnpm --filter @cunote/conversion test:queue-cleanup`, `git diff --check` PASS.

## 운영 경계와 남은 검증

- Cloud Run 공식 [일반 개발 지침](https://docs.cloud.google.com/run/docs/tips/general)은 요청 응답 뒤 백그라운드 작업에 instance-based billing을 요구한다. 현재 큐는 POST `202` 응답 후 인메모리 작업을 계속하므로 request-based 설정이라면 완료가 지연·중단될 수 있다. 현재 `cunote-codex-dev` gcloud 토큰은 대화형 재인증 필요로 설정 조회가 실패했다. 이 코드 수정은 CPU 정책을 해결하거나 운영 변환 성공을 증명하지 않는다.
- 운영 Cloud Run 배포는 프로젝트 규칙의 별도 쓰기 단계다. 전용 계정 재인증·현행 설정과 image digest 결속·사용자에게 승인된 배포 범위 확인 뒤 수행한다. 변환 서비스 배포 전에는 신규 코드로 운영 backlog를 처리했다고 보고하지 않는다.
