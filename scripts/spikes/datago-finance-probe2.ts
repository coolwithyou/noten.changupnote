/**
 * 2차 프로브: (a) kcomwel 502 재시도·엔드포인트 검증, (b) 개인사업자재무 bzno 필터 무시 확인.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
function loadEnv() {
  for (const f of [".env.local", ".env"]) {
    const p = resolve(process.cwd(), f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const [k, ...rest] = t.split("=");
      const key = k!.trim();
      if (process.env[key] !== undefined) continue;
      let v = rest.join("=").trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[key] = v;
    }
  }
}
loadEnv();
const enc = (k: string) => (/%[0-9A-Fa-f]{2}/.test(k) ? k : encodeURIComponent(k));
const kcomwelKey = process.env.CUNOTE_KCOMWEL_SERVICE_KEY ?? "";
const fscKey = process.env.CUNOTE_FSC_FINANCE_SERVICE_KEY ?? "";

async function tryOnce(url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url);
  return { status: res.status, text: await res.text() };
}

// (a) kcomwel 재시도 최대 5회
console.log("===== (a) kcomwel 재시도 =====");
const kUrl = `http://apis.data.go.kr/B490001/gySjbPstateInfoService/getGySjBoheomBsshItem?serviceKey=${enc(kcomwelKey)}&v_saeopjaDrno=1248100998&opaBoheomFg=2&numOfRows=10&pageNo=1`;
for (let i = 1; i <= 5; i++) {
  try {
    const r = await tryOnce(kUrl);
    console.log(`시도 ${i}: HTTP ${r.status}`);
    if (r.status === 200) {
      console.log(r.text.slice(0, 2000));
      break;
    } else {
      console.log("  body:", r.text.slice(0, 150));
    }
  } catch (e) {
    console.log(`시도 ${i}: ERR`, e instanceof Error ? e.message : String(e));
  }
  await new Promise((res) => setTimeout(res, 1500));
}

// (a2) kcomwel XML(returnType 미지정 기본) + 다른 사업자번호(중소기업 예: 배달의민족 우아한형제들 1058693228)
console.log("\n===== (a2) kcomwel 다른 사업자번호(우아한형제들 1058693228) =====");
try {
  const r = await tryOnce(
    `http://apis.data.go.kr/B490001/gySjbPstateInfoService/getGySjBoheomBsshItem?serviceKey=${enc(kcomwelKey)}&v_saeopjaDrno=1058693228&opaBoheomFg=2&numOfRows=10&pageNo=1`,
  );
  console.log(`HTTP ${r.status}`);
  console.log(r.text.slice(0, 2000));
} catch (e) {
  console.log("ERR", e instanceof Error ? e.message : String(e));
}

// (b) 개인사업자재무 bzno 필터 무시 확인: 서로 다른 bzno 2개의 totalCount 비교
console.log("\n===== (b) 개인사업자재무 bzno 필터 검증 =====");
for (const bz of ["1248100998", "9999999999", "1058693228"]) {
  try {
    const r = await tryOnce(
      `http://apis.data.go.kr/1160100/service/GetSBFinanceInfoService/getFnafInfo?serviceKey=${enc(fscKey)}&bzno=${bz}&numOfRows=1&pageNo=1&resultType=json`,
    );
    const m = /"totalCount":(\d+)/.exec(r.text);
    const hasBzno = /"bzno"/.test(r.text);
    console.log(`bzno=${bz}: HTTP ${r.status} totalCount=${m?.[1] ?? "?"} 응답에bzno필드=${hasBzno}`);
  } catch (e) {
    console.log(`bzno=${bz}: ERR`, e instanceof Error ? e.message : String(e));
  }
}
console.log("\n[probe2] done.");
