// 팝빌로 실제 나가는 HTTP 요청(토큰 발급 + 사업자등록정보 조회)을 그대로 캡처한다.
// 우리 코드(check-biz-info.ts)와 동일한 config 매핑으로 checkBizInfo를 호출한다.
// 실행: NODE_PATH="$(pwd)/packages/core/node_modules" node --env-file=.env scripts/popbill-request-trace.cjs
const https = require("https");
const zlib = require("zlib");

// ── 1. 전역 https.request 후킹 ───────────────────────────────────────────────
const SENSITIVE = /linkhub|popbill/i;
const mask = (v) => (typeof v === "string" && v.length > 24 ? v.slice(0, 18) + "…(" + v.length + "자)" : v);

function logRequest(opts, body) {
  const host = opts.host || opts.hostname || (opts.href ? new URL(opts.href).host : "?");
  const path = opts.path || (opts.href ? new URL(opts.href).pathname + new URL(opts.href).search : "");
  if (!SENSITIVE.test(String(host))) return; // 팝빌/링크허브 트래픽만
  console.log("\n──────────────────────────────────────────────");
  console.log(`▶ ${opts.method || "GET"} https://${host}${path}`);
  const headers = { ...(opts.headers || {}) };
  if (headers.Authorization) headers.Authorization = mask(headers.Authorization);
  console.log("  headers:", JSON.stringify(headers, null, 2).replace(/\n/g, "\n  "));
  const text = Buffer.concat(body).toString("utf8");
  console.log("  body:", text ? text : "(없음 — GET)");
}

const origRequest = https.request;
https.request = function (...args) {
  // 시그니처 정규화: request(options[,cb]) | request(url[,options][,cb])
  let opts;
  if (typeof args[0] === "string" || args[0] instanceof URL) {
    opts = typeof args[1] === "object" ? { href: String(args[0]), ...args[1] } : { href: String(args[0]) };
  } else {
    opts = args[0] || {};
  }
  const req = origRequest.apply(this, args);
  const chunks = [];
  const origWrite = req.write.bind(req);
  req.write = (c, ...rest) => {
    if (c) chunks.push(Buffer.from(c));
    return origWrite(c, ...rest);
  };
  const origEnd = req.end.bind(req);
  req.end = (c, ...rest) => {
    if (c && typeof c !== "function") chunks.push(Buffer.from(c));
    logRequest(opts, chunks);
    // 응답도 캡처
    req.on("response", (res) => {
      const buf = [];
      res.on("data", (d) => buf.push(Buffer.from(d)));
      res.on("end", () => {
        let raw = Buffer.concat(buf);
        const enc = res.headers["content-encoding"];
        try {
          if (enc === "gzip") raw = zlib.gunzipSync(raw);
          else if (enc === "deflate") raw = zlib.inflateSync(raw);
        } catch {}
        const host = opts.host || opts.hostname || "?";
        if (SENSITIVE.test(String(host))) {
          console.log(`  ◀ 응답 ${res.statusCode}:`, raw.toString("utf8").slice(0, 600));
        }
      });
    });
    return origEnd(c, ...rest);
  };
  return req;
};

// ── 2. 우리 코드(check-biz-info.ts)와 동일한 config 매핑 ──────────────────────
const popbill = require("popbill");

const readBool = (name, fallback) => {
  const v = (process.env[name] || "").trim().toLowerCase();
  if (!v) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(v);
};
const sanitize = (v) => (v || "").replace(/\D/g, "");

const credentials = {
  linkId: (process.env.POPBILL_LINK_ID || "").trim(),
  secretKey: (process.env.POPBILL_SECRET_KEY || process.env.POPBILL_API_KEY || "").trim(),
  corpNum: sanitize(process.env.POPBILL_CORP_NUM),
  userId: (process.env.POPBILL_USER_ID || "").trim(),
  isTest: readBool("POPBILL_IS_TEST", true),
  ipRestrictOnOff: readBool("POPBILL_IP_RESTRICT_ON_OFF", true),
  useStaticIp: readBool("POPBILL_USE_STATIC_IP", false),
  useLocalTimeYn: readBool("POPBILL_USE_LOCAL_TIME_YN", true),
};
const checkCorpNum = sanitize(process.env.POPBILL_CHECK_CORP_NUM || process.env.POPBILL_DEMO_CHECK_CORP_NUM);

console.log("=== checkBizInfo 호출 파라미터 (우리 코드가 SDK에 넘기는 값) ===");
console.log({
  "config.LinkID": credentials.linkId,
  "config.SecretKey": mask(credentials.secretKey),
  "config.IsTest": credentials.isTest,
  "config.IPRestrictOnOff": credentials.ipRestrictOnOff,
  "config.UseStaticIP": credentials.useStaticIp,
  "config.UseLocalTimeYN": credentials.useLocalTimeYn,
  "arg.CorpNum (요청 주체)": credentials.corpNum,
  "arg.CheckCorpNum (조회 대상)": checkCorpNum,
  "arg.UserID": credentials.userId || "(빈 문자열)",
});

popbill.config({
  LinkID: credentials.linkId,
  SecretKey: credentials.secretKey,
  IsTest: credentials.isTest,
  IPRestrictOnOff: credentials.ipRestrictOnOff,
  UseStaticIP: credentials.useStaticIp,
  UseLocalTimeYN: credentials.useLocalTimeYn,
});

const service = popbill.BizInfoCheckService();

new Promise((resolve, reject) => {
  service.checkBizInfo(credentials.corpNum, checkCorpNum, credentials.userId || "", resolve, reject);
})
  .then((result) => {
    console.log("\n=== ✅ checkBizInfo 성공 ===");
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.log("\n=== ❌ checkBizInfo 실패 (팝빌 원문 응답) ===");
    console.log(JSON.stringify(error, null, 2));
  });
