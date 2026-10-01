# 실제 Studio 등록정보 엔진의 유한 검증

```bash
node tools/native-autofill-probe/run.mjs <local-source.hwpx> <immutable-analysis.json>
pnpm --filter @cunote/web exec tsc -p ../../tools/native-autofill-probe/tsconfig.json --noEmit
```

현재 lockfile로 설치된 `tsx`, esbuild, `kordoc`, `@rhwp/core`, vendored `@rhwp/editor`와 `agent-browser`를 사용한다. 개발 서버를 시작하거나 기존 서버를 바꾸지 않는다. 임시 localhost 서버·브라우저 세션·번들은 `finally`에서 종료/제거한다. 결과 JSON은 `docs/evidence/native-autofill-20261001/<UTC 실행시각>/`에 매번 새로 기록한다.

- 실제 `buildReconciledApplicationFields`로 accepted 후보를 pure projection한다. 저장된 문서 admission은 수정하지 않고 결과에 보존한다.
- 후보 ID를 로컬 식별자로 사용한다. 운영 DB의 field UUID, 초안, 저장 상태를 꾸미지 않는다.
- 실제 Studio iframe SDK와 host protocol, `resolveStudioFieldBindings`, profile plan, `createStudioProfileAutofillTransaction`을 사용한다. protocol mock/native insert 우회는 없다.
- 진입 자동 시드는 실제 `seedProfileFieldAnswers`와 `buildAutomaticProfileAutofillEntries`로 별도 보고한다. dialog ready plan으로 적용한 결과를 진입 자동입력 성공으로 표시하지 않는다.
- 등록정보 profile은 명시적으로 합성이다. 대표자 이름과 테스트 번호가 있더라도 정상 plan이 제외한 필드를 강제 입력하지 않는다.
- 실제 export 결과를 재열고, 값/unique binding과 전체 표의 비대상 셀 보존을 검증한다.

자가호스팅 Studio의 정적 런타임을 로드한다. 사용자 대면 Workspace/API, 모델, DB, release/promotion은 호출하지 않는다. UI 인수 완료나 원본 분석 완료의 증거가 아니다. 원문·결과 파일은 증거 JSON에 포함하거나 커밋하지 않는다.
