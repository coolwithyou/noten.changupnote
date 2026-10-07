# 디자인 통합 및 배포 되돌리기

## 목표와 승인
- 사용자 지시: "다시 되돌려줘". 직전 main 통합/배포를 취소하고 이전 운영 source `0a9a141`의 제품 상태로 복구한다.
- 기존 dirty main/다른 세션과 DB는 보존한다. 이력 삭제나 force push 없이 revert commit을 사용한다.

## 검증 및 실행
- [x] 현재 원격 main `5636b38`, 운영 `dpl_EY1aGUa1jdM3vo34ksiWivUxyoUT` 확인.
- [x] `5636b38` 보완 커밋과 `ef6f7a2` merge(first parent 기준)를 역적용.
- [x] 진행 문서 작성 전 index 전체가 이전 운영 `0a9a141` tree와 동일: `git diff --cached --exit-code 0a9a141 -- .`.
- [x] `git diff --cached --check`.
- [ ] 복구 커밋 작성 및 이전 배포 `dpl_3xVTd9NkX1Mt8tp4AsFpLUmJaf68` 즉시 복원.
- [ ] 원격 main에 복구 커밋 push, 동일 제품 소스의 새 배포 READY 확인.
- [ ] 새 복구 배포 promote로 생산 도메인 자동 연결을 정상화하고 도메인/화면 확인.
- [ ] 태그·증거 기록과 기존 dirty 작업 보존 확인.

## 결정 및 검증 경계
- 코드 전체 tree가 이미 빌드/운영됐던 `0a9a141`과 동일하므로 별도의 제품 코드 수정을 추가하지 않는다. 새 Vercel 빌드와 운영 HTTP/화면 스모크로 복구를 확인한다.
- Vercel rollback은 자동 도메인 할당을 잠시 중지하므로, 복구 main 배포 완료 후 그 배포를 promote하여 정상화한다.
- 디자인 원본 브랜치와 직전 배포/검증 이력은 남긴다.

## 막힘
- 없음.
