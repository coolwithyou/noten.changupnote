/**
 * 공공구매종합정보망(SMPP) 확인서 보강 단위 검증 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/verify-smpp-certs.ts
 *
 * 커버:
 *  - parseSmppCertXml: resultCode 00(보유·item 파싱) / 90(미보유) / 그 외(throw).
 *  - checkSmppCertificates: 두 오퍼레이션 병렬 호출 URL 구성 + 이중 인코딩 방지 + XML 파싱.
 *  - applySmppCertificatesToProfile: positive-only 병합, certs/traits union 중복 방지,
 *    confidence.founder_trait = max(기존, 0.9), confidence.certification 미설정 보증,
 *    미보유(90)면 프로필 불변.
 */
import assert from "node:assert/strict";
import type { CompanyProfile } from "@cunote/contracts";
import { checkSmppCertificates, parseSmppCertXml, buildSmppUrl } from "@cunote/core";
import { applySmppCertificatesToProfile } from "./serviceData";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> | void {
  const done = () => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  };
  const result = fn();
  return result instanceof Promise ? result.then(done) : done();
}

const HELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>
<body><items><item>
<certSeCode>03</certSeCode>
<issuInstt>서울지방중소벤처기업청</issuInstt>
<validPdBeginDe>20240715</validPdBeginDe>
<validPdEndDe>20270714</validPdEndDe>
<certfcDe>20240715</certfcDe>
</item></items></body></response>`;

const NOT_HELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<response><header><resultCode>90</resultCode><resultMsg>매칭데이터가 존재하지 않습니다.</resultMsg></header></response>`;

const ERROR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<response><header><resultCode>30</resultCode><resultMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</resultMsg></header></response>`;

async function main() {
  // ── parseSmppCertXml ───────────────────────────────────────────────
  check("parseSmppCertXml: 00 보유 → held:true + item 필드 파싱", () => {
    const result = parseSmppCertXml(HELD_XML, "getFnrssList");
    assert.equal(result.held, true);
    assert.equal(result.validPdBeginDe, "20240715");
    assert.equal(result.validPdEndDe, "20270714");
    assert.equal(result.certfcDe, "20240715");
    assert.equal(result.issuInstt, "서울지방중소벤처기업청");
  });

  check("parseSmppCertXml: 90 미보유 → held:false (오류 아님)", () => {
    const result = parseSmppCertXml(NOT_HELD_XML, "getDspsnList");
    assert.equal(result.held, false);
    assert.equal(result.validPdBeginDe, undefined);
  });

  check("parseSmppCertXml: 그 외 코드는 throw", () => {
    assert.throws(() => parseSmppCertXml(ERROR_XML, "getFnrssList"), /resultCode=30/);
  });

  // ── checkSmppCertificates (fetch mock) ─────────────────────────────
  await check("checkSmppCertificates: 여성 보유/장애인 미보유 병렬 조회 + URL 구성", async () => {
    const calls: string[] = [];
    const mockFetch = (async (url: RequestInfo | URL) => {
      const href = String(url);
      calls.push(href);
      const xml = href.includes("getFnrssList") ? HELD_XML : NOT_HELD_XML;
      return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
    }) as typeof fetch;

    const certs = await checkSmppCertificates({
      serviceKey: "raw+key/with=chars",
      bizNo: "893-81-00911", // 하이픈 → 숫자만 추출
      stdrDate: "20260706",
      fetchImpl: mockFetch,
    });
    assert.equal(certs.women?.held, true);
    assert.equal(certs.disabled?.held, false);
    assert.equal(calls.length, 2);
    const womenUrl = calls.find((c) => c.includes("getFnrssList"));
    assert.ok(womenUrl, "여성 오퍼레이션 호출됨");
    assert.ok(womenUrl!.includes("bsnmNo=8938100911"), womenUrl);
    assert.ok(womenUrl!.includes("stdrDate=20260706"), womenUrl);
    // serviceKey 원문(%없음)은 encodeURIComponent 되어야 함(이중 인코딩 아님).
    assert.ok(womenUrl!.includes("serviceKey=raw%2Bkey%2Fwith%3Dchars"), womenUrl);
    assert.ok(calls.some((c) => c.includes("getDspsnList")), "장애인 오퍼레이션 호출됨");
  });

  check("buildSmppUrl: 이미 인코딩된 키(%XX)는 이중 인코딩하지 않는다", () => {
    const url = buildSmppUrl("getFnrssList", "already%2Bencoded", "8938100911", "20260706");
    assert.ok(url.includes("serviceKey=already%2Bencoded"), url);
  });

  await check("checkSmppCertificates: 오류 코드(30) 응답이면 전체 throw(fail-open용)", async () => {
    const mockFetch = (async () =>
      new Response(ERROR_XML, { status: 200 })) as typeof fetch;
    await assert.rejects(
      () =>
        checkSmppCertificates({
          serviceKey: "k",
          bizNo: "8938100911",
          stdrDate: "20260706",
          fetchImpl: mockFetch,
        }),
      /resultCode=30/,
    );
  });

  await check("checkSmppCertificates: HTTP 오류 시 throw", async () => {
    const mockFetch = (async () => new Response("err", { status: 500 })) as typeof fetch;
    await assert.rejects(
      () =>
        checkSmppCertificates({
          serviceKey: "k",
          bizNo: "8938100911",
          stdrDate: "20260706",
          fetchImpl: mockFetch,
        }),
      /HTTP 500/,
    );
  });

  // ── applySmppCertificatesToProfile (positive-only 병합) ─────────────
  check("applySmpp: 여성 보유 → certs/traits 추가, founder_trait 0.9, certification 미설정, 원본 불변", () => {
    const base: CompanyProfile = {
      name: "회사",
      certs: ["중소기업확인서"],
      traits: ["청년창업"],
      confidence: { region: 0.8, founder_trait: 0.5 },
    };
    const { profile, addedLabels } = applySmppCertificatesToProfile(base, {
      women: { held: true, validPdBeginDe: "20240715" },
      disabled: { held: false },
    });
    assert.deepEqual(addedLabels, ["여성기업확인서"]);
    assert.deepEqual(profile.certs, ["중소기업확인서", "여성기업확인서"]);
    assert.deepEqual(profile.traits, ["청년창업", "여성기업"]);
    assert.equal(profile.confidence?.founder_trait, 0.9); // max(0.5, 0.9)
    assert.equal(profile.confidence?.region, 0.8); // 기존 보존
    // certification 축은 절대 known 처리하지 않는다(오탈락 방지).
    assert.equal(profile.confidence?.certification, undefined);
    // 원본 불변(순수 함수).
    assert.deepEqual(base.certs, ["중소기업확인서"]);
    assert.equal(base.confidence?.founder_trait, 0.5);
  });

  check("applySmpp: 여성+장애인 동시 보유 → 둘 다 union 추가", () => {
    const { profile, addedLabels } = applySmppCertificatesToProfile(
      { name: "회사" },
      { women: { held: true }, disabled: { held: true } },
    );
    assert.deepEqual(addedLabels, ["여성기업확인서", "장애인기업확인서"]);
    assert.deepEqual(profile.certs, ["여성기업확인서", "장애인기업확인서"]);
    assert.deepEqual(profile.traits, ["여성기업", "장애인기업"]);
    assert.equal(profile.confidence?.founder_trait, 0.9);
    assert.equal(profile.confidence?.certification, undefined);
  });

  check("applySmpp: 이미 있는 확인서는 중복 추가하지 않는다(union)", () => {
    const { profile } = applySmppCertificatesToProfile(
      { name: "회사", certs: ["여성기업확인서"], traits: ["여성기업"] },
      { women: { held: true }, disabled: { held: false } },
    );
    assert.deepEqual(profile.certs, ["여성기업확인서"]);
    assert.deepEqual(profile.traits, ["여성기업"]);
  });

  check("applySmpp: 둘 다 미보유(90) → 프로필 불변, addedLabels 빈 배열, 아무 축도 known 아님", () => {
    const base: CompanyProfile = { name: "회사", confidence: { region: 0.8 } };
    const { profile, addedLabels } = applySmppCertificatesToProfile(base, {
      women: { held: false },
      disabled: { held: false },
    });
    assert.deepEqual(addedLabels, []);
    assert.equal(profile, base); // 동일 참조(불변)
    assert.equal(profile.certs, undefined);
    assert.equal(profile.confidence?.founder_trait, undefined);
    assert.equal(profile.confidence?.certification, undefined);
  });

  console.log(`\nverify-smpp-certs.ts: ${passed} checks passed.`);

  // ── 라이브 검증(옵션, 무과금 SMPP API) ──────────────────────────────
  // SMPP_LIVE=1 이고 CUNOTE_SMPP_SERVICE_KEY가 있으면 실제 API로 8938100911(여성 보유·장애인 미보유)을
  // 조회해 applySmppCertificatesToProfile까지 통과시켜 profile.certs에 "여성기업확인서"가 들어오는지 실측한다.
  if (process.env.SMPP_LIVE === "1") {
    const { loadMonorepoEnv } = await import("./loadMonorepoEnv");
    loadMonorepoEnv();
    const serviceKey = process.env.CUNOTE_SMPP_SERVICE_KEY?.trim();
    if (!serviceKey) {
      console.log("\n[live] CUNOTE_SMPP_SERVICE_KEY 미설정 — 라이브 검증 건너뜀");
      return;
    }
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const stdrDate = `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, "0")}${String(kst.getUTCDate()).padStart(2, "0")}`;
    // 라이브 관측 목적이라 타임아웃을 넉넉히 둔다(프로덕션 경로는 2s fail-open 유지).
    const certs = await checkSmppCertificates({ serviceKey, bizNo: "8938100911", stdrDate, timeoutMs: 15_000 });
    const { profile, addedLabels } = applySmppCertificatesToProfile({ name: "라이브테스트" }, certs);
    console.log("\n[live] SMPP 8938100911 원응답:", JSON.stringify(certs));
    console.log("[live] addedLabels:", JSON.stringify(addedLabels));
    console.log("[live] profile.certs:", JSON.stringify(profile.certs));
    console.log(
      "[live] traits:",
      JSON.stringify(profile.traits),
      "| confidence.founder_trait:",
      profile.confidence?.founder_trait,
      "| confidence.certification:",
      String(profile.confidence?.certification),
    );
    assert.equal(certs.women?.held, true, "8938100911 여성기업확인서 보유(실측)");
    assert.equal(certs.disabled?.held, false, "8938100911 장애인기업 미보유(실측)");
    assert.ok(profile.certs?.includes("여성기업확인서"), "profile.certs에 여성기업확인서 반영");
    assert.equal(profile.confidence?.certification, undefined, "certification 축 미설정 보증(라이브)");
    console.log("[live] ✓ 라이브 실측 통과");
  }
}

void main();
