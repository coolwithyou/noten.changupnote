/**
 * CODEF 간편인증(홈택스) CLI 스파이크 하네스 — UI 없이 3대 가정 go/no-go를 돌리는 최소 무대.
 *
 * 흐름(in-process, DB 없음): 토큰 발급 → 사업자등록증명 1차 POST → CF-03002면
 *   "앱에서 승인 후 Enter" 프롬프트 → is2Way 재요청 → 성공 시 같은 id로 부가세과세표준
 *   연속 호출(세션 SSO 실측) → 정규화·프로필 병합 → 3대 가정 결과 출력.
 *
 * 실행(민감정보는 인자로 전달 — 로그엔 마스킹만 남는다):
 *   pnpm verify:codef -- --name 홍길동 --birth 19800101 --phone 01012345678 \
 *     --app kakaotalk --bizno 1234567890 [--telecom SKT] [--gender M]
 *   (= pnpm exec tsx --tsconfig apps/web/tsconfig.json scripts/verify-codef.ts --name ...)
 *
 * --app: kakaotalk|payco|samsungPass|kbMobile|pass|naver|shinhan|toss (또는 1~8 코드).
 * --telecom: pass(통신사 PASS) 선택 시에만 필요. SKT|KT|LGU 또는 CODEF 코드.
 *
 * env: 루트 .env 의 CODEF_CLIENT_ID/SECRET/PUBLIC_KEY/ENVIRONMENT 를 loadMonorepoEnv 가 로드.
 * 데모 키는 일 100건 쿼터 — 남용 금지, 사용자 트리거 수동 실행 전용.
 * 주의: 생년월일·전화·이름·주민번호·토큰은 절대 평문 출력하지 않는다(마스킹만).
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadMonorepoEnv } from "../apps/web/src/lib/server/loadMonorepoEnv";
// @cunote/core 배럴은 이 환경에서 node_modules 심링크가 다른 세션 경로를 가리켜 dangling —
// tsx 가 .js→.ts 로 해석하는 상대 소스 경로로 codef 개별 모듈만 직접 참조한다(기존 verify 스크립트 관례).
import { readCodefEnvConfig } from "../packages/core/src/codef/env.js";
import { requestCodefToken } from "../packages/core/src/codef/token.js";
import { requestCodefProduct, CodefError } from "../packages/core/src/codef/client.js";
import type { CodefClassification } from "../packages/core/src/codef/client.js";
import { extractTwoWayInfo, buildTwoWayRequestBody } from "../packages/core/src/codef/two-way.js";
import type { TwoWayInfo } from "../packages/core/src/codef/two-way.js";
import { buildCodefSessionId, CODEF_SIMPLE_AUTH_APPS } from "../packages/core/src/codef/request-params.js";
import type { SimpleAuthLoginInput } from "../packages/core/src/codef/request-params.js";
import {
  buildCorporateRegistrationRequest,
  normalizeCorporateRegistration,
  CORPORATE_REGISTRATION_PATH,
} from "../packages/core/src/codef/products/corporate-registration.js";
import {
  buildVatBaseRequest,
  normalizeVatBase,
  defaultVatBaseDateRange,
  VAT_BASE_CERTIFICATE_PATH,
} from "../packages/core/src/codef/products/vat-base-certificate.js";
import type { VatBaseRequestInput } from "../packages/core/src/codef/products/vat-base-certificate.js";
import { buildCompanyProfileFromCodef } from "../packages/core/src/codef/normalize.js";

loadMonorepoEnv();

// ── 인자 파싱 ───────────────────────────────────────────────────────────────
interface Args {
  name: string;
  birth: string;
  phone: string;
  app: string;
  bizno: string;
  telecom?: string;
  gender?: "M" | "F";
  start?: string;
  end?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") continue; // pnpm 이 forward 하는 인자 구분자 무시
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token && token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1] ?? "";
      map.set(key, value);
      i += 1;
    }
  }
  const name = map.get("name") ?? "";
  const birth = (map.get("birth") ?? "").replace(/\D/g, "");
  const phone = (map.get("phone") ?? "").replace(/\D/g, "");
  const app = map.get("app") ?? "";
  const bizno = (map.get("bizno") ?? "").replace(/\D/g, "");
  const telecom = map.get("telecom");
  const genderRaw = (map.get("gender") ?? "").toUpperCase();
  const gender = genderRaw === "M" || genderRaw === "F" ? (genderRaw as "M" | "F") : undefined;
  const start = map.get("start");
  const end = map.get("end");

  const missing: string[] = [];
  if (!name) missing.push("--name");
  if (!/^\d{8}$/.test(birth)) missing.push("--birth(yyyyMMdd 8자리)");
  if (!phone) missing.push("--phone");
  if (!app) missing.push("--app");
  if (!/^\d{10}$/.test(bizno)) missing.push("--bizno(10자리)");
  if (missing.length > 0) {
    console.error(`필수 인자 누락/형식 오류: ${missing.join(", ")}`);
    console.error(
      "사용법: pnpm verify:codef -- --name 홍길동 --birth 19800101 --phone 01012345678 " +
        "--app kakaotalk --bizno 1234567890 [--telecom SKT] [--gender M]",
    );
    process.exit(2);
  }
  return {
    name,
    birth,
    phone,
    app,
    bizno,
    dryRun,
    ...(telecom !== undefined ? { telecom } : {}),
    ...(gender !== undefined ? { gender } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
  };
}

/** 요청 body에서 민감 필드(userName/phoneNo/loginIdentity=생년월일)를 마스킹한 사본을 만든다. */
function maskBody(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  if (typeof out["userName"] === "string") out["userName"] = maskName(out["userName"]);
  if (typeof out["phoneNo"] === "string") out["phoneNo"] = maskPhone(out["phoneNo"]);
  if (typeof out["loginIdentity"] === "string") out["loginIdentity"] = maskBirth(out["loginIdentity"]);
  return out; // identity(사업자번호)는 마스킹 대상 아님
}

/** --app 값(이름 또는 1~8 코드)을 loginTypeLevel 코드로 해석. */
function resolveLoginTypeLevel(app: string): string {
  const byName = (CODEF_SIMPLE_AUTH_APPS as Record<string, string>)[app];
  if (byName) return byName;
  if (/^[1-8]$/.test(app)) return app;
  const names = Object.keys(CODEF_SIMPLE_AUTH_APPS).join(", ");
  console.error(`알 수 없는 --app "${app}". 허용: ${names} 또는 1~8`);
  process.exit(2);
}

/** 통신사 이름 → CODEF 코드(모름/코드 직접 입력이면 그대로 통과). */
function resolveTelecom(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const map: Record<string, string> = { SKT: "0", KT: "1", LGU: "2", "LG": "2", "LGU+": "2" };
  return map[value.toUpperCase()] ?? value;
}

// ── 마스킹 ─────────────────────────────────────────────────────────────────
function maskName(name: string): string {
  if (name.length <= 1) return "*";
  return name[0] + "*".repeat(name.length - 1);
}
function maskPhone(phone: string): string {
  return phone.length <= 4 ? "****" : `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
}
function maskBirth(birth: string): string {
  return `${birth.slice(0, 4)}****`; // 연도만
}

// ── 2-way 실행 헬퍼 ──────────────────────────────────────────────────────────
const rl = createInterface({ input, output });

/**
 * 상품 1건을 호출한다. 첫 응답이 CF-03002(추가인증 필요)면 승인 프롬프트 후 is2Way 재요청.
 * 반환: { classification(최종 success), neededApproval(이 상품이 승인을 요구했나) }.
 */
async function callProductWithTwoWay(
  label: string,
  path: string,
  accessToken: string,
  apiBaseUrl: string,
  body: Record<string, unknown>,
): Promise<{ result: CodefClassification; neededApproval: boolean }> {
  console.log(`\n▶ ${label} 1차 요청…`);
  let first: CodefClassification;
  try {
    first = await requestCodefProduct({ apiBaseUrl, path, accessToken, body });
  } catch (error) {
    throw annotate(error, `${label} 1차 요청 실패`);
  }

  if (first.status === "success") {
    console.log(`  ✓ ${label}: 추가인증 없이 즉시 성공 (result=${first.result.code})`);
    return { result: first, neededApproval: false };
  }

  // two_way_required
  const info: TwoWayInfo | null = extractTwoWayInfo(first.data);
  if (!info) {
    throw new Error(`${label}: CF-03002 인데 twoWayInfo 4필드 추출 실패 — 응답 형식 확인 필요`);
  }
  console.log(
    `  · ${label}: 추가인증 필요(CF-03002). 인증앱에서 승인해 주세요 ` +
      `(jobIndex=${info.jobIndex}, threadIndex=${info.threadIndex}, 제한시간 4분30초).`,
  );

  const twoWayBody = buildTwoWayRequestBody(body, info);
  // 미승인 상태 재요청은 최대 3회(CF-12872 대비).
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await rl.question(`  [${label}] 앱 승인을 완료했다면 Enter (재시도 ${attempt}/3): `);
    let done: CodefClassification;
    try {
      done = await requestCodefProduct({ apiBaseUrl, path, accessToken, body: twoWayBody });
    } catch (error) {
      // CF-12872(미승인) 등은 재시도 여지 — 마지막 시도면 전파.
      if (error instanceof CodefError && attempt < 3) {
        console.log(`  · 아직 미완료로 보임(${error.code ?? "?"}: ${error.message}). 승인 후 다시 Enter.`);
        continue;
      }
      throw annotate(error, `${label} 2차(is2Way) 요청 실패`);
    }
    if (done.status === "success") {
      console.log(`  ✓ ${label}: 승인 완료 → 성공 (result=${done.result.code})`);
      return { result: done, neededApproval: true };
    }
    console.log(`  · ${label}: 아직 승인 대기(status=${done.status}). 승인 후 다시 Enter.`);
  }
  throw new Error(`${label}: 3회 재시도에도 완료되지 않음(미승인 또는 세션 만료).`);
}

function annotate(error: unknown, context: string): Error {
  if (error instanceof CodefError) {
    return new Error(`${context} — CodefError[${error.code ?? "?"}] ${error.message}`);
  }
  return error instanceof Error ? new Error(`${context} — ${error.message}`) : new Error(`${context} — ${String(error)}`);
}

// ── 메인 ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loginTypeLevel = resolveLoginTypeLevel(args.app);
  const telecom = resolveTelecom(args.telecom);

  console.log("=".repeat(72));
  console.log("CODEF 간편인증 CLI 스파이크");
  console.log(
    `  대상: name=${maskName(args.name)} birth=${maskBirth(args.birth)} ` +
      `phone=${maskPhone(args.phone)} bizNo=${args.bizno} app=${args.app}(${loginTypeLevel})` +
      (telecom ? ` telecom=${telecom}` : ""),
  );
  console.log("=".repeat(72));

  const config = readCodefEnvConfig();
  console.log(`env: environment=${config.environment}, apiBase=${config.apiBaseUrl}`);

  const id = buildCodefSessionId("cli-spike", args.bizno);
  const baseInput: SimpleAuthLoginInput = {
    loginTypeLevel,
    userName: args.name,
    phoneNo: args.phone,
    birthDate8: args.birth,
    bizNo: args.bizno,
    id,
    ...(telecom !== undefined ? { telecom } : {}),
  };
  const range = defaultVatBaseDateRange();
  const vatInput: VatBaseRequestInput = {
    ...baseInput,
    startDate: args.start ?? range.startDate,
    endDate: args.end ?? range.endDate,
  };

  if (args.dryRun) {
    console.log("\n[--dry-run] 네트워크 호출 없이 요청 body만 조립·검증합니다.");
    console.log(`  세션 SSO id=${id}`);
    console.log(`  부가세 조회기간 startDate=${vatInput.startDate} endDate=${vatInput.endDate}`);
    console.log("\n  사업자등록증명 요청 body(마스킹):");
    console.log("  " + JSON.stringify(maskBody(buildCorporateRegistrationRequest(baseInput)), null, 2).replace(/\n/g, "\n  "));
    console.log("\n  부가세과세표준 요청 body(마스킹):");
    console.log("  " + JSON.stringify(maskBody(buildVatBaseRequest(vatInput)), null, 2).replace(/\n/g, "\n  "));
    console.log("\n  ✓ dry-run 통과. 실호출은 --dry-run 없이 실행(데모 쿼터·휴대폰 승인 필요).");
    rl.close();
    return;
  }

  console.log("\n▶ 토큰 발급…");
  const token = await requestCodefToken(config);
  console.log(`  ✓ accessToken 발급(만료 ${Math.round(token.expiresInSec / 86400)}일). [토큰 값 비출력]`);
  console.log(`  세션 SSO id=${id}`);

  // 1) 사업자등록증명 (첫 인증)
  const corpBody = buildCorporateRegistrationRequest(baseInput);
  const corp = await callProductWithTwoWay(
    "사업자등록증명",
    CORPORATE_REGISTRATION_PATH,
    token.accessToken,
    config.apiBaseUrl,
    corpBody,
  );
  const corpFacts = normalizeCorporateRegistration(corp.result.data);

  // 2) 부가세과세표준 (같은 id — 세션 SSO 실측)
  console.log(`  부가세 조회기간 startDate=${vatInput.startDate} endDate=${vatInput.endDate}`);
  const vatBody = buildVatBaseRequest(vatInput);
  const vat = await callProductWithTwoWay(
    "부가세과세표준증명",
    VAT_BASE_CERTIFICATE_PATH,
    token.accessToken,
    config.apiBaseUrl,
    vatBody,
  );
  const vatFacts = normalizeVatBase(vat.result.data);

  // 3) 프로필 병합
  const { profile, facts } = buildCompanyProfileFromCodef({
    corporateRegistration: corpFacts,
    vatBase: vatFacts,
    birthDate8: args.birth,
    ...(args.gender !== undefined ? { gender: args.gender } : {}),
  });

  // ── 결과 리포트 ──────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(72));
  console.log("정규화된 매칭 차원 (원천=국세청/CODEF)");
  console.log("=".repeat(72));
  console.log(`  name            ${profile.name ?? "—"}`);
  console.log(`  region          ${profile.region ? `${profile.region.label}(${profile.region.code})` : "—"}`);
  console.log(`  biz_age_months  ${profile.biz_age_months ?? "—"}`);
  console.log(`  industries      ${(profile.industries ?? []).join(", ") || "—"}`);
  console.log(`  industry_codes  ${(profile.industry_codes ?? []).join(", ") || "—"}`);
  console.log(`  target_types    ${(profile.target_types ?? []).join(", ") || "—"}`);
  console.log(`  revenue_krw     ${profile.revenue_krw != null ? profile.revenue_krw.toLocaleString("ko-KR") + "원" : "—"}`);
  console.log(`  founder_age     ${profile.founder_age ?? "—"}`);
  console.log(`  식별번호(마스킹)  ${facts.masked_identity_no ?? "—"}`);
  console.log(`  공동대표         ${facts.joint_representative ?? "—"}`);
  console.log(`  vat.hasFiling   ${vatFacts?.hasFiling ?? "—"} (year=${vatFacts?.year ?? "—"})`);

  console.log("\n" + "=".repeat(72));
  console.log("3대 가정 go/no-go");
  console.log("=".repeat(72));

  // 가정 1: 세션 SSO — 부가세과세표준이 2번째 승인 없이 처리됐는가.
  const ssoWorked = !vat.neededApproval;
  console.log(
    `  ① 세션 SSO(1회 인증→2상품): ${ssoWorked ? "GO ✅ 2번째 상품이 추가 승인 없이 처리됨" : "NO ⚠️ 부가세과세표준이 별도 승인을 요구함(승인 2회 폴백 필요)"}`,
  );

  // 가정 3: 개인 매출 커버리지 — 부가세과세표준이 매출을 반환했는가.
  const revenueCovered = vatFacts?.hasFiling === true && vatFacts.taxBaseWon != null;
  console.log(
    `  ③ 개인 매출 커버리지: ${revenueCovered ? `GO ✅ 과세표준 ${vatFacts!.taxBaseWon!.toLocaleString("ko-KR")}원 반환` : "NO/미확인 ⚠️ 과세표준 빈 응답(간이/면세 신고이력 없음 또는 필드명 상이 — vat 원문 확인)"}`,
  );

  // 가정 2: 단가 — CLI로 확인 불가(사람 작업).
  console.log(`  ② 정식 단가: N/A(CODEF 상담·사람 작업) — 이번 호출로는 판정 불가`);

  console.log(
    `\n  GO 판정식: ①(세션 SSO) ∧ ③(개인 매출) 성립 ∧ ②(단가) 수용 가능 → GO.` +
      `\n  이번 실행: ①=${ssoWorked ? "GO" : "NO"}, ③=${revenueCovered ? "GO" : "NO/미확인"}, ②=상담대기`,
  );
  console.log(
    "\n  ※ 3종(법인·일반과세 개인·간이/면세 개인)을 각각 실행해 ③ 커버리지를 계층별로 기록하세요.",
  );

  rl.close();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n✗ 스파이크 실패: ${error instanceof Error ? error.message : String(error)}`);
    rl.close();
    process.exit(1);
  });
