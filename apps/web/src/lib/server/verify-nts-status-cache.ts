/**
 * 국세청(NTS) 상태조회 통합 단위 검증 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/verify-nts-status-cache.ts
 *
 * 커버:
 *  - nextKstMidnight: Asia/Seoul 달력일 기준 다음 자정 계산(하루 1회 캐시 만료).
 *  - ntsClosedLabel: 상태코드 → 라벨 매핑(02 휴업 / 03 폐업 / 그 외 null).
 *  - applyNtsStatusToProfile: 휴·폐업 시 business_status 갱신(active:false, confidence 0.9, 원본 불변).
 *  - checkNtsBusinessStatus: 요청 URL/본문 구성 + data[0] 파싱 + 실패 시 throw (fetch mock).
 */
import assert from "node:assert/strict";
import type { CompanyProfile } from "@cunote/contracts";
import { checkNtsBusinessStatus, buildStatusUrl, type NtsBusinessStatusData } from "@cunote/core";
import { applyNtsStatusToProfile, ntsClosedLabel, nextKstMidnight } from "./serviceData";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> | void {
  const done = () => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  };
  const result = fn();
  return result instanceof Promise ? result.then(done) : done();
}

function closedStatus(overrides: Partial<NtsBusinessStatusData> = {}): NtsBusinessStatusData {
  return {
    b_no: "1234567890",
    b_stt: "폐업자",
    b_stt_cd: "03",
    tax_type: "부가가치세 일반과세자",
    tax_type_cd: "01",
    end_dt: "20250101",
    ...overrides,
  };
}

async function main() {
  // ── nextKstMidnight ────────────────────────────────────────────────
  check("nextKstMidnight: 15:30Z(KST 익일 00:30)의 다음 KST 자정은 익일 15:00Z", () => {
    const now = new Date("2026-07-05T15:30:00.000Z"); // KST 2026-07-06 00:30
    assert.equal(nextKstMidnight(now).toISOString(), "2026-07-06T15:00:00.000Z"); // KST 2026-07-07 00:00
  });

  check("nextKstMidnight: 같은 KST 달력일의 두 시각은 동일 만료(하루 1회 캐시)", () => {
    // 둘 다 KST 2026-07-05 (UTC 07-04 15:00 ~ 07-05 15:00)
    const early = new Date("2026-07-04T15:00:00.000Z"); // KST 07-05 00:00
    const late = new Date("2026-07-05T14:59:59.000Z"); // KST 07-05 23:59:59
    const expected = "2026-07-05T15:00:00.000Z"; // KST 07-06 00:00
    assert.equal(nextKstMidnight(early).toISOString(), expected);
    assert.equal(nextKstMidnight(late).toISOString(), expected);
    // 만료 시각은 항상 now 이후여야 한다.
    assert.ok(nextKstMidnight(early).getTime() > early.getTime());
    assert.ok(nextKstMidnight(late).getTime() > late.getTime());
  });

  check("nextKstMidnight: 다음 KST 달력일 시각은 더 늦은 만료", () => {
    const day1 = new Date("2026-07-05T10:00:00.000Z"); // KST 07-05
    const day2 = new Date("2026-07-05T16:00:00.000Z"); // KST 07-06
    assert.ok(nextKstMidnight(day2).getTime() > nextKstMidnight(day1).getTime());
  });

  // ── ntsClosedLabel ─────────────────────────────────────────────────
  check("ntsClosedLabel: 01/미등록/빈값은 null, 02 휴업, 03 폐업", () => {
    assert.equal(ntsClosedLabel("01"), null);
    assert.equal(ntsClosedLabel("02"), "휴업");
    assert.equal(ntsClosedLabel("03"), "폐업");
    assert.equal(ntsClosedLabel(""), null);
    assert.equal(ntsClosedLabel(undefined), null);
  });

  // ── applyNtsStatusToProfile ───────────────────────────────────────
  check("applyNtsStatusToProfile: 폐업 시 business_status 갱신 + confidence 0.9, 원본 불변", () => {
    const base: CompanyProfile = {
      name: "회사",
      business_status: { active: true, label: "정상" },
      confidence: { region: 0.8 },
    };
    const updated = applyNtsStatusToProfile(
      base,
      closedStatus({ b_stt_cd: "03" }),
      "2026-07-12T00:00:00.000Z",
    );
    assert.equal(updated.business_status?.active, false);
    assert.equal(updated.business_status?.label, "폐업");
    assert.equal(updated.business_status?.close_down_state, "03");
    assert.equal(updated.confidence?.business_status, 0.9);
    assert.equal(updated.confidence?.region, 0.8); // 기존 confidence 보존
    assert.deepEqual(updated.profile_evidence?.business_status, {
      sourceKind: "authoritative_api",
      provider: "nts",
      asOf: "2026-07-12T00:00:00.000Z",
      axisCompleteness: "complete",
      confidence: 0.9,
    });
    // 원본은 변경되지 않아야 한다(순수 함수).
    assert.equal(base.business_status?.active, true);
    assert.equal(base.confidence?.business_status, undefined);
  });

  check("applyNtsStatusToProfile: 휴업(02) 라벨 매핑", () => {
    const updated = applyNtsStatusToProfile({ name: "회사" }, closedStatus({ b_stt: "휴업자", b_stt_cd: "02" }));
    assert.equal(updated.business_status?.label, "휴업");
    assert.equal(updated.business_status?.active, false);
  });

  // ── checkNtsBusinessStatus (fetch mock) ───────────────────────────
  await check("checkNtsBusinessStatus: URL/본문 구성 + data[0] 파싱", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({ status_code: "OK", data: [closedStatus()] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const data = await checkNtsBusinessStatus({
      serviceKey: "raw+key/with=chars",
      bizNo: "123-45-67890", // 하이픈 포함 → 숫자만 추출되어야 함
      fetchImpl: mockFetch,
    });
    assert.equal(data.b_stt_cd, "03");
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    // serviceKey는 원문(%없음)이라 encodeURIComponent 되어야 함(이중 인코딩 아님).
    assert.ok(call.url.includes("serviceKey=raw%2Bkey%2Fwith%3Dchars"), call.url);
    assert.ok(call.url.includes("returnType=JSON"), call.url);
    assert.equal(call.init.method, "POST");
    const body = JSON.parse(String(call.init.body)) as { b_no: string[] };
    assert.deepEqual(body.b_no, ["1234567890"]);
  });

  check("buildStatusUrl: 이미 인코딩된 키(%XX)는 이중 인코딩하지 않는다", () => {
    const url = buildStatusUrl("already%2Bencoded");
    assert.ok(url.includes("serviceKey=already%2Bencoded"), url);
  });

  await check("checkNtsBusinessStatus: HTTP 오류 시 throw", async () => {
    const mockFetch = (async () =>
      new Response("err", { status: 500 })) as typeof fetch;
    await assert.rejects(
      () => checkNtsBusinessStatus({ serviceKey: "k", bizNo: "1234567890", fetchImpl: mockFetch }),
      /HTTP 500/,
    );
  });

  await check("checkNtsBusinessStatus: data[]가 비면 throw", async () => {
    const mockFetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
    await assert.rejects(
      () => checkNtsBusinessStatus({ serviceKey: "k", bizNo: "1234567890", fetchImpl: mockFetch }),
      /data\[0\]/,
    );
  });

  await check("checkNtsBusinessStatus: 네트워크/타임아웃 실패는 throw(호출부 fail-open용)", async () => {
    const mockFetch = (async () => {
      throw new Error("aborted");
    }) as typeof fetch;
    await assert.rejects(
      () => checkNtsBusinessStatus({ serviceKey: "k", bizNo: "1234567890", fetchImpl: mockFetch }),
      /request failed/,
    );
  });

  console.log(`\nverify-nts-status-cache.ts: ${passed} checks passed.`);
}

void main();
