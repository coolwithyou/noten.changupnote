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

## 2026-09-28 운영 설정 재확인

- 사용자 재인증 뒤 `cunote-codex-dev` configuration의 access token을 Google tokeninfo로 확인했다. 실제 호출 주체는 `cunote-codex-dev@changupnote-com.iam.gserviceaccount.com`이며 Cloud Build 목록과 Cloud Run 서비스·리비전 조회가 통과했다. 토큰 값은 출력하지 않았다.
- 현재 운영 `cunote-conversion` generation 8, 100% ready revision `cunote-conversion-00008-8pb`, image digest `sha256:a79e98b7923b230f1469063aa307ed90a39e60f08b091d9d88375df404a3aa85`다. 템플릿에 `run.googleapis.com/cpu-throttling`이 없고 minScale도 없으며 maxScale=1, 2 CPU/2Gi, timeout=300s다. [Cloud Run billing 설정 문서](https://docs.cloud.google.com/run/docs/configuring/billing-settings)는 cpu-throttling 설정 누락을 request-based billing으로 판정한다. 이 방식은 요청 밖 CPU를 할당하지 않으므로 POST `202` 뒤 실행하는 현재 인메모리 큐와 충돌한다.
- 운영 배포 범위에는 이 브랜치의 작업 디렉터리 정리 코드를 정확한 image digest로 빌드·반영하면서 `--no-cpu-throttling`을 함께 적용하는 단계가 필요하다. 기존 서비스 계정, secret refs, 일반 env, 2 CPU/2Gi, maxScale=1, timeout=300s, ingress와 invoker 설정을 유지하고 새 revision/설정/인증 스모크를 비교한다. instance-based billing은 인스턴스 전체 생애에 비용이 붙으며 인스턴스가 중단될 수 있으므로, 이는 대기열의 내구성 보증이 아니다. 첫 소량 변환에서 실제 완료와 artifact/DB 결속을 관측해야 한다.
- `cloudbuild.yaml`은 native amd64 Docker 빌드·Artifact Registry push만 수행한다. 운영 Cloud Run 배포와 CPU/과금 설정 변경은 프로젝트 규칙의 별도 쓰기 단계다. exact 배포 범위 승인 전에는 실행하지 않는다.
