# application-only v21 준비와 실원본 검증

## 결과

coverage v21 수정의 실제 HWP 저장 경로를 검증했고, 완료 primary를 다시 호출하지 않는
application-only launch 계약과 exact 14건 manifest를 준비했다. 새 live 모델 실행은 하지 않았다.

- 코드: `18ac0da`(coverage v21), `cf77b1e`(application-only exact reuse)
- 새 manifest: `76105bfdca2598889c5c50d8b703dc4c301abd82e88cb66f13d76a5f93a1fd8a`
- 상태: prepared, grant/status/receipt 없음
- 실행 계약: CLI Max, `claude-opus-5`, concurrency 1, primary 재사용, 신청서 v21만 신규 실행
- 다음 권한: 위 manifest에 대한 사용자 exact 승인 전에는 grant와 live launch를 만들지 않는다.

구조화 증거는 [application-only v21 준비 증거](../evidence/deep-analysis/2026-09-16-application-only-v21-preparation.json)에 있다.

## 구현한 경계

manifest의 모든 target에 `analysis-launch-primary-reuse-v1`을 넣었다. source terminal receipt와
run path/SHA/runId/source sequence를 결속하고, 승인 검증과 실행 직전에 다음을 다시 확인한다.

- source receipt target과 path/SHA/sequence가 동일함
- 실제 run bytes SHA가 receipt와 동일함
- grant/input/attachment가 새 target과 동일함
- model/transport/prompt가 새 manifest와 동일함
- primary가 publishable이고 matching이 ready 또는 conditional임
- primary repair provenance와 verified matching projection이 존재함

application-only capability는 이 결속이 target마다 없으면 열리지 않는다. 반대로 일반 launch에
primary reuse를 넣어도 거부한다. 결속을 통과하면 primary 함수는 live binding과
`runValidatedLabPrimary` 전에 기존 결과로 종결한다. 새 LabRun은 source primary의 본문·criteria·
assessment를 보존하고, 새 application 결과와 exact reuse provenance만 붙인다.

## 실원본 HWP 검증

seq0 신청서 원본 SHA `e7bd958a…e4c8`, 538,112 bytes를 R2에서 읽기 전용으로 회수했다.
후보 `4f59569e78f58593435ca08c`는 원문 한 글자 라벨 `계`의 occurrence 1이며, native 구조에서
section 0 / parent paragraph 609 / label cell 21 / value cell 22로 유일하게 결속됐다.

사본 값 `7`을 쓴 뒤 HWP export와 재열기를 수행했다. 65쪽이 유지됐고 같은 value cell에서 `7`을
다시 읽었다. export SHA는 `bc6553a2…f4df`다. 한컴오피스 한글 Viewer의 41쪽에서도
`나. 세부사업 질적 성과 목표` 표의 합계 행, `1단계(yy~yy)` 셀에 `7`이 표시됐다. 인접 고정값
`가중치 100`과 표 레이아웃도 유지됐다. 이 검증은 사본 로컬 파일만 만들었고 R2/DB/서비스 쓰기는 없다.

## exact 범위

새 manifest는 원 inventory `622b69bc…`의 원 sequence
`4,6,7,8,12,14,16,18,22,24,25,26,27,28`만 포함한다. source는 manifest `984e8db4…`,
grant `d9ddd12a…`, terminal receipt `462c6557…`이며, 14개 source primary artifact를 모두 다시
검증했다. 대상 추가·대체는 없다.

첫 prepare는 원 sequence 목록을 생략해 full v1 ancestry로 해석되는 단계에서 fail-closed했다.
모델 호출이나 grant 기록 전 중단됐고, 위 14개 v2 exact 목록으로 다시 준비했다.

## 처리량·품질·신청서 상태

- 처리량: 신규 모델 target 0, 신규 terminal 0, primary 재실행 0.
- 본문 품질: 재사용 source primary 14개는 모두 publishable이며 matching ready/conditional이다.
  새 본문 모델 결과가 아니라 검증된 원 결과의 재사용이다.
- 신청서 readiness: source v20 결과는 14건 모두 held/review_required다. v21 live 결과는 아직 없다.
- 오류 근거: v21은 저점수 coverage 미확정 후보 누락, contextual 대체 종결, 짧은 라벨 source/native
  anchor 불일치를 고쳤다. 임계 하향이나 반복 모델 호출은 사용하지 않았다.

exact19의 기존 집계 18통과/1보류는 그대로다. 새 manifest는 follow-up exact14 신청서 범위이며,
v21 terminal 검증 전 readiness를 승격하지 않는다.

## 검증과 현재 상태

web typecheck, launch test, document-agent test, prepared execution test, package runtime freshness,
diff check가 통과했다. manifest verifier는 target14/primaryReuse14와 matching grant 0을 확인했다.

2026-09-16 14:38:59 UTC DB read-only snapshot은 `paused`, generation427, owner/expiry null,
active deep lease 0, active application lease 0이다. precheck의 처리한 두 fingerprint만 ack했고
최종 상태는 unchanged/pending 없음이다.

## 남은 승인 경계

manifest `76105bfd…1fd8a`를 live로 실행하려면 사용자의 명시적 exact 승인이 필요하다. 승인이 오면
grant 한 번을 기록하고 동일 manifest의 14개 신청서 lane만 concurrency 1로 실행한다. terminal 뒤에는
receipt/run SHA, primary 불변, 신청서 상태별 집계, 개별 오류, runtime lease 반환을 검증한다.
서비스 승격, 유료 API 전환, 대상 추가는 이 범위에 포함되지 않는다.
