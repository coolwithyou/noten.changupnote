// data.go.kr(공공데이터포털) 인증키 해석 — 계정당 1키를 여러 오퍼레이션이 공용한다.
// 공용 변수 `CUNOTE_DATA_GO_KR_SERVICE_KEY` 우선 → 소스별 변수(NTS·SMPP·kcomwel·FSC 등) 폴백.
// 키 하나만 관리하면 되도록 통일하되, 기존 소스별 변수도 계속 인식한다(하위 호환).

/**
 * data.go.kr 인증키를 해석한다. 공용 키가 있으면 그것을, 없으면 소스별 폴백 키를 반환.
 * 둘 다 비어 있으면 null.
 * @param specificEnv 소스별 폴백 환경변수명(예: "CUNOTE_NTS_SERVICE_KEY").
 */
export function resolveDataGoKrServiceKey(specificEnv: string): string | null {
  const generic = process.env.CUNOTE_DATA_GO_KR_SERVICE_KEY?.trim();
  if (generic) return generic;
  const specific = process.env[specificEnv]?.trim();
  return specific && specific.length > 0 ? specific : null;
}
