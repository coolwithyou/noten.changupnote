/**
 * 2026-09-11 세 대상 성능 실행에서 오프라인 회귀에 필요한 최소 근거만 옮긴 fixture.
 * 원 실행은 정규화 전 raw model JSON을 보존하지 않았으므로 model row 재현은 모두 synthetic이다.
 * 서비스 DB/R2를 읽거나 쓰지 않는다.
 */
export const NEW_ANALYSIS_20260911_FIXTURE = {
  launchManifestSha256: "0a5f647e6f76b37a30834996299fbaf28d714340977292ecfd46b74fc9386a8a",
  terminalReceiptSha256: "2d85b38644baaf6a12c0bd82703cda5679e08122ae782b58c1ee90c8aee24001",
  sourceArtifact: "spike-out/new-analysis-20260911/target-performance.json",
  cases: {
    jeongseon: {
      grantId: "35039849-bc10-410e-be20-d8a0a41378ff",
      inputSha256: "93331241e5c36a885491970dc4fe29a214c6875d5a5aef56e126376de18541f5",
      labRunPath:
        "spike-out/analysis-lab/bizinfo__PBLN_000000000126388/run-2026-09-11T053902.996Z-cba582.json",
      extractionPath: "$[0].passes[0].issues[0].criterion",
      sourceSpan: "자체 홍보할 제품·서비스가 있거나 명확 한 사회적 가치 모델을 보유한 기업",
      valueNote:
        "자체 홍보할 제품·서비스가 있거나(OR) 명확한 사회적 가치 모델을 보유한 기업이어야 한다. 둘 중 하나만 충족해도 되는 대안(OR) 요건이며 22축 단일 축으로 무손실 표현이 어렵다.",
      syntheticRaw: true,
    },
    irClinic: {
      grantId: "cdef2199-028d-4147-bf96-ea9b543a8574",
      inputSha256: "eedbe25a8dc172052fd39200b2b2f862816aa9f9a251d73a932095284ca5169a",
      labRunPath:
        "spike-out/analysis-lab/bizinfo__PBLN_000000000126337/run-2026-09-11T054111.826Z-a56213.json",
      extractionPath: "$.criteria[dimension=biz_age]",
      sourceSpan: "☞ 업력 7년 미만의 제조창업기업",
      syntheticRaw: true,
    },
    changwon: {
      grantId: "5e166cd0-fe63-4657-a748-25491cecc69e",
      inputSha256: "0295a14f75fcd6e5308c8ffd12098025007c0e8bba0920dc3e321c2db20c944a",
      labRunPath:
        "spike-out/analysis-lab/bizinfo__PBLN_000000000126332/run-2026-09-11T054209.561Z-415d48.json",
      extractionPath: "$[2].passes[*].issues[0].criterion",
      sourceSpan: "☞ 창원시 농ㆍ축ㆍ수산물 및 가공품, 특산품 생산 업체(농가)",
      targets: ["업체", "농가"],
      syntheticRaw: true,
    },
  },
} as const;
