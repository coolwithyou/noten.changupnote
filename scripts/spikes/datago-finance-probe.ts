/**
 * data.go.kr 신규 커넥터 응답 구조 발굴 프로브 (throwaway, scripts/spikes/.gitignore 대상).
 * kcomwel(15059256) · FSC 개인사업자재무(15108171) · FSC 기업재무(15043459) 원시 응답을 덤프한다.
 * 실행: pnpm exec tsx scripts/spikes/datago-finance-probe.ts [사업자번호] [법인등록번호]
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

const bizNo = (process.argv[2] ?? "1248100998").replace(/\D/g, ""); // 기본: 삼성전자
const corpRegNo = (process.argv[3] ?? "1301110006246").replace(/\D/g, ""); // 기본: 삼성전자 법인등록번호

function enc(key: string): string {
  return /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
}

async function dump(label: string, url: string, init?: RequestInit) {
  console.log(`\n===== ${label} =====`);
  console.log("URL:", url.replace(/serviceKey=[^&]+/, "serviceKey=***"));
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    console.log("HTTP", res.status, "ct:", res.headers.get("content-type"));
    console.log(text.slice(0, 2500));
  } catch (e) {
    console.log("ERR", e instanceof Error ? e.message : String(e));
  }
}

const kcomwelKey = process.env.CUNOTE_KCOMWEL_SERVICE_KEY ?? process.env.CUNOTE_DATA_GO_KR_SERVICE_KEY ?? "";
const fscKey = process.env.CUNOTE_FSC_FINANCE_SERVICE_KEY ?? process.env.CUNOTE_DATA_GO_KR_SERVICE_KEY ?? "";

// 1) kcomwel 고용·산재 사업장 (사업자번호 키). opaBoheomFg 1=산재 2=고용
await dump(
  "kcomwel 15059256 getGySjBoheomBsshItem (고용=2)",
  `http://apis.data.go.kr/B490001/gySjbPstateInfoService/getGySjBoheomBsshItem?serviceKey=${enc(kcomwelKey)}&v_saeopjaDrno=${bizNo}&opaBoheomFg=2&numOfRows=10&pageNo=1`,
);
await dump(
  "kcomwel 15059256 getGySjBoheomBsshItem (산재=1)",
  `http://apis.data.go.kr/B490001/gySjbPstateInfoService/getGySjBoheomBsshItem?serviceKey=${enc(kcomwelKey)}&v_saeopjaDrno=${bizNo}&opaBoheomFg=1&numOfRows=10&pageNo=1`,
);

// 2) FSC 개인사업자재무 (사업자번호 키). 파라미터명 후보: bzno / pageNo / numOfRows / resultType
await dump(
  "FSC 15108171 getFnafInfo (bzno=사업자번호, json)",
  `http://apis.data.go.kr/1160100/service/GetSBFinanceInfoService/getFnafInfo?serviceKey=${enc(fscKey)}&bzno=${bizNo}&numOfRows=10&pageNo=1&resultType=json`,
);

// 3) FSC 기업재무 V2 (법인등록번호 crno 키). getSummFinaStat_V2
await dump(
  "FSC 15043459 getSummFinaStat_V2 (crno=법인등록번호, json)",
  `http://apis.data.go.kr/1160100/service/GetFinaStatInfoService_V2/getSummFinaStat_V2?serviceKey=${enc(fscKey)}&crno=${corpRegNo}&numOfRows=10&pageNo=1&resultType=json`,
);

console.log("\n[probe] done.");
