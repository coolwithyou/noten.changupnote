// 팝빌 잔여포인트/단가/과금형태 진단 스크립트 (무과금 조회만 수행)
// 실행: node --env-file=.env scripts/popbill-balance-diagnose.cjs
const popbill = require("popbill");

const linkId = (process.env.POPBILL_LINK_ID || "").trim();
const secretKey = (process.env.POPBILL_SECRET_KEY || process.env.POPBILL_API_KEY || "").trim();
const corpNum = (process.env.POPBILL_CORP_NUM || "").replace(/\D/g, "");
const isTest = /^(1|true|yes|y|on)$/i.test((process.env.POPBILL_IS_TEST || "true").trim());
const ipRestrict = /^(1|true|yes|y|on)$/i.test((process.env.POPBILL_IP_RESTRICT_ON_OFF || "true").trim());
const useStaticIp = /^(1|true|yes|y|on)$/i.test((process.env.POPBILL_USE_STATIC_IP || "false").trim());
const useLocalTime = /^(1|true|yes|y|on)$/i.test((process.env.POPBILL_USE_LOCAL_TIME_YN || "true").trim());

console.log("=== 설정 ===");
console.log("LinkID        :", linkId);
console.log("SecretKey     :", secretKey ? secretKey.slice(0, 6) + "…(" + secretKey.length + "자)" : "(없음)");
console.log("CorpNum       :", corpNum);
console.log("IsTest        :", isTest, isTest ? "→ popbill-test.linkhub.co.kr (테스트베드)" : "→ popbill.linkhub.co.kr (운영)");
console.log("IPRestrict    :", ipRestrict);
console.log("UseStaticIP   :", useStaticIp);
console.log("UseLocalTimeYN:", useLocalTime);
console.log("");

popbill.config({
  LinkID: linkId,
  SecretKey: secretKey,
  IsTest: isTest,
  IPRestrictOnOff: ipRestrict,
  UseStaticIP: useStaticIp,
  UseLocalTimeYN: useLocalTime,
});

const biz = popbill.BizInfoCheckService();
const p = (label, fn) =>
  new Promise((resolve) => {
    fn(
      (r) => resolve({ label, ok: true, r }),
      (e) => resolve({ label, ok: false, e }),
    );
  });

(async () => {
  const results = await Promise.all([
    p("연동회원 잔여포인트 getBalance", (s, e) => biz.getBalance(corpNum, s, e)),
    p("파트너 잔여포인트 getPartnerBalance", (s, e) => biz.getPartnerBalance(corpNum, s, e)),
    p("BizInfoCheck 단가 getUnitCost", (s, e) => biz.getUnitCost(corpNum, s, e)),
    p("BizInfoCheck 과금정보 getChargeInfo", (s, e) => biz.getChargeInfo(corpNum, s, e)),
  ]);

  console.log("=== 조회 결과 ===");
  for (const { label, ok, r, e } of results) {
    if (ok) {
      console.log(`✅ ${label}:`, typeof r === "object" ? JSON.stringify(r) : r);
    } else {
      const msg = e && (e.message || e.Message);
      const code = e && (e.code || e.Code);
      console.log(`❌ ${label}: code=${code} message=${msg}`, e && !msg ? JSON.stringify(e) : "");
    }
  }
})().catch((err) => {
  console.error("스크립트 오류:", err);
  process.exit(1);
});
