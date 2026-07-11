/**
 * CODEF 코어 순수 함수 단위 테스트 (node:assert, tsx 실행, 오프라인 fixture만).
 * 실행: pnpm exec tsx packages/core/src/codef/codef.test.ts
 *
 * 주의: 실제 개인정보·실제 CODEF 응답 금지. 모든 fixture는 필드명만 맞춘 합성 더미다
 * (홍길동/합성 주소/개업일, 생년월일 "19800101", 식별번호 "800101-*******").
 * 로드베어링 검증: 양방향 URL 인코딩 왕복(이 한 줄이 틀리면 전 응답 파싱 실패).
 */

import assert from "node:assert/strict";
import {
  constants,
  createPrivateKey,
  generateKeyPairSync,
  privateDecrypt,
} from "node:crypto";

import {
  CODEF_SUCCESS_CODE,
  CODEF_TWO_WAY_CODE,
  CodefError,
  classifyCodefResult,
  decodeCodefResponse,
  encodeCodefBody,
} from "./client.js";
import { CodefEnvError, readCodefEnvConfig } from "./env.js";
import { buildCompanyProfileFromCodef } from "./normalize.js";
import { buildCorporateRegistrationRequest, normalizeCorporateRegistration } from "./products/corporate-registration.js";
import { normalizeVatBase } from "./products/vat-base-certificate.js";
import { CODEF_SIMPLE_AUTH_APPS, buildSimpleAuthBody } from "./request-params.js";
import { encryptWithCodefPublicKey } from "./rsa.js";
import { isCodefTokenExpired, parseTokenResponse } from "./token.js";
import {
  assertTwoWayTransition,
  buildTwoWayRequestBody,
  canTransitionTwoWay,
  extractTwoWayInfo,
} from "./two-way.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── 합성 fixture(개인정보 아님) ────────────────────────────────────────────
const CORP_REG_DATA = {
  resUserNm: "홍길동상사",
  resUserAddr: "경기도 성남시 분당구 판교로 000",
  resOpenDate: "20180301",
  resBusinessTypes: "제조업/도매업",
  resBusinessItems: "전자부품, 컴퓨터",
  resBusinessmanType: "법인사업자",
  resUserIdentiyNo: "1234561234567", // 합성 더미(마스킹 대상)
  resJointRepresentativeNm: "김공동",
};

const CORP_REG_ENVELOPE = {
  result: { code: CODEF_SUCCESS_CODE, message: "성공", transactionId: "tx-synthetic-001" },
  data: CORP_REG_DATA,
};

const TWO_WAY_ENVELOPE = {
  result: { code: CODEF_TWO_WAY_CODE, message: "추가인증 필요", transactionId: "tx-synthetic-002" },
  data: {
    continue2Way: true,
    method: "simpleAuth",
    jobIndex: 0,
    threadIndex: 0,
    jti: "synthetic-jti-abc",
    twoWayTimestamp: 1_700_000_000,
  },
};

const VAT_BASE_ENVELOPE_DATA = {
  resTaxStandardList: [
    { resStandardYear: "2022", resTaxStandard: "120,000,000" },
    { resStandardYear: "2023", resTaxStandard: "150,000,000" },
  ],
};

// ── env ─────────────────────────────────────────────────────────────────
check("readCodefEnvConfig: 필수 변수 누락 → 어떤 변수인지 명시 throw", () => {
  assert.throws(
    () => readCodefEnvConfig({ CODEF_CLIENT_ID: "id" } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof CodefEnvError &&
      error.message.includes("CODEF_CLIENT_SECRET") &&
      error.message.includes("CODEF_PUBLIC_KEY"),
  );
});

check("readCodefEnvConfig: 환경 미지정/오타 → demo 폴백, production → api base", () => {
  const base = {
    CODEF_CLIENT_ID: "id",
    CODEF_CLIENT_SECRET: "secret",
    CODEF_PUBLIC_KEY: "pk",
  };
  const demo = readCodefEnvConfig({ ...base, CODEF_ENVIRONMENT: "oops" } as NodeJS.ProcessEnv);
  assert.equal(demo.environment, "demo");
  assert.equal(demo.apiBaseUrl, "https://development.codef.io");
  assert.equal(demo.tokenUrl, "https://oauth.codef.io/oauth/token");
  const prod = readCodefEnvConfig({ ...base, CODEF_ENVIRONMENT: "production" } as NodeJS.ProcessEnv);
  assert.equal(prod.environment, "production");
  assert.equal(prod.apiBaseUrl, "https://api.codef.io");
});

// ── 양방향 URL 인코딩 (로드베어링) ─────────────────────────────────────────
check("양방향 URL 인코딩 왕복: decodeCodefResponse(encodeCodefBody(obj)) === obj", () => {
  const obj = { organization: "0001", userName: "홍길동", nested: { a: 1, b: ["x", "y"] } };
  const encoded = encodeCodefBody(obj);
  // 인코딩 결과는 raw JSON이 아니라 URL 인코딩된 텍스트여야 한다(공백·한글 % 이스케이프).
  assert.ok(!encoded.startsWith("{"));
  assert.ok(encoded.includes("%"));
  assert.deepEqual(decodeCodefResponse(encoded), obj);
});

check("decodeCodefResponse: URL-encoded 응답 fixture 정상 파싱", () => {
  const rawEncoded = encodeURIComponent(JSON.stringify(CORP_REG_ENVELOPE));
  const parsed = decodeCodefResponse(rawEncoded);
  const classified = classifyCodefResult(parsed);
  assert.equal(classified.status, "success");
  assert.equal(classified.result.transactionId, "tx-synthetic-001");
});

check("decodeCodefResponse: 평문 JSON 폴백(URL 인코딩 안 된 게이트웨이)", () => {
  const plain = JSON.stringify(CORP_REG_ENVELOPE);
  assert.deepEqual(decodeCodefResponse(plain), CORP_REG_ENVELOPE);
});

// ── classifyCodefResult 3분기 ─────────────────────────────────────────────
check("classifyCodefResult: CF-00000 → success", () => {
  const c = classifyCodefResult(CORP_REG_ENVELOPE);
  assert.equal(c.status, "success");
  assert.equal(c.data?.["resUserNm"], "홍길동상사");
});

check("classifyCodefResult: CF-03002 → two_way_required", () => {
  const c = classifyCodefResult(TWO_WAY_ENVELOPE);
  assert.equal(c.status, "two_way_required");
  assert.equal(c.data?.["continue2Way"], true);
});

check("classifyCodefResult: 그 외 코드 → CodefError(code 보존)", () => {
  assert.throws(
    () =>
      classifyCodefResult({
        result: { code: "CF-12872", message: "미승인 한도 초과", transactionId: "tx-err" },
        data: {},
      }),
    (error: unknown) =>
      error instanceof CodefError && error.code === "CF-12872" && error.transactionId === "tx-err",
  );
});

// ── 2-way 전이 ────────────────────────────────────────────────────────────
check("extractTwoWayInfo + buildTwoWayRequestBody: is2Way·simpleAuth·twoWayInfo 4필드 병합", () => {
  const info = extractTwoWayInfo(TWO_WAY_ENVELOPE.data);
  assert.ok(info);
  assert.deepEqual(info, {
    jobIndex: 0,
    threadIndex: 0,
    jti: "synthetic-jti-abc",
    twoWayTimestamp: 1_700_000_000,
  });

  const first = buildCorporateRegistrationRequest({
    loginTypeLevel: CODEF_SIMPLE_AUTH_APPS.kakaotalk,
    userName: "홍길동",
    phoneNo: "010-1234-5678",
    identity: "19800101",
    id: "cunote-session-1",
  });
  const second = buildTwoWayRequestBody(first, info!);
  assert.equal(second["is2Way"], true);
  assert.equal(second["simpleAuth"], "1");
  assert.deepEqual(second["twoWayInfo"], {
    jobIndex: 0,
    threadIndex: 0,
    jti: "synthetic-jti-abc",
    twoWayTimestamp: 1_700_000_000,
  });
  // 1차 파라미터가 그대로 보존돼야 한다.
  assert.equal(second["userName"], "홍길동");
  assert.equal(second["id"], "cunote-session-1");
  assert.equal(second["loginType"], "5");
});

check("extractTwoWayInfo: 필드 누락 → null", () => {
  assert.equal(extractTwoWayInfo({ jobIndex: 0, jti: "x" }), null);
  assert.equal(extractTwoWayInfo(null), null);
});

check("2-way 상태 전이 가드", () => {
  assert.equal(canTransitionTwoWay("pending_approval", "completing"), true);
  assert.equal(canTransitionTwoWay("done", "completing"), false);
  assert.equal(assertTwoWayTransition("completing", "done"), "done");
  assert.throws(() => assertTwoWayTransition("done", "pending_approval"));
});

// ── buildSimpleAuthBody: telecom 조건부 ───────────────────────────────────
check("buildSimpleAuthBody: telecom은 PASS(5)일 때만, 그 외 생략", () => {
  const pass = buildSimpleAuthBody({
    loginTypeLevel: CODEF_SIMPLE_AUTH_APPS.pass,
    userName: "홍길동",
    phoneNo: "01012345678",
    identity: "19800101",
    telecom: "1",
    id: "s1",
  });
  assert.equal(pass["telecom"], "1");
  assert.equal(pass["isIdentityViewYN"], "0");
  assert.equal(pass["usePurposes"], "99");

  const kakao = buildSimpleAuthBody({
    loginTypeLevel: CODEF_SIMPLE_AUTH_APPS.kakaotalk,
    userName: "홍길동",
    phoneNo: "010-1234-5678",
    identity: "19800101",
    telecom: "1", // 카카오면 무시돼야 함
    id: "s1",
  });
  assert.equal("telecom" in kakao, false);
  assert.equal(kakao["phoneNo"], "01012345678"); // 숫자만 정규화
});

// ── 정규화 (합성 fixture) ─────────────────────────────────────────────────
check("normalizeCorporateRegistration: 원문 보존 + 식별번호 마스킹", () => {
  const facts = normalizeCorporateRegistration(CORP_REG_DATA);
  assert.ok(facts);
  assert.equal(facts!.resUserNm, "홍길동상사");
  assert.equal(facts!.resOpenDate, "20180301");
  assert.equal(facts!.resBusinessTypes, "제조업/도매업");
  assert.equal(facts!.resBusinessmanType, "법인사업자");
  assert.equal(facts!.resJointRepresentativeNm, "김공동");
  // 앞 6자리만 남고 이후 숫자 마스킹.
  assert.equal(facts!.resUserIdentiyNo, "123456*******");
});

check("normalizeVatBase: 연도별 합산 + 최신연도 · 빈 응답 null", () => {
  const facts = normalizeVatBase(VAT_BASE_ENVELOPE_DATA);
  assert.ok(facts);
  assert.equal(facts!.taxBaseWon, 270_000_000); // 120,000,000 + 150,000,000
  assert.equal(facts!.year, "2023");
  assert.equal(facts!.hasFiling, true);

  // 간이/면세 개인: 신고 이력 없는 빈 응답 → taxBaseWon null.
  const empty = normalizeVatBase({});
  assert.ok(empty);
  assert.equal(empty!.taxBaseWon, null);
  assert.equal(empty!.hasFiling, false);
});

// ── buildCompanyProfileFromCodef ──────────────────────────────────────────
check("buildCompanyProfileFromCodef: 차원 채움 + 신뢰도", () => {
  const asOf = new Date(Date.UTC(2025, 0, 1)); // 2025-01-01
  const { profile, facts } = buildCompanyProfileFromCodef({
    corporateRegistration: normalizeCorporateRegistration(CORP_REG_DATA),
    vatBase: normalizeVatBase(VAT_BASE_ENVELOPE_DATA),
    birthDate8: "19800101",
    gender: "M",
    asOf,
  });

  // region: 판교 주소 → 경기(41).
  assert.equal(profile.region?.code, "41");
  // biz_age: 2018-03-01 → 2025-01-01 ≈ 82개월.
  assert.equal(profile.biz_age_months, 82);
  // industry: 업태/종목 텍스트 라벨.
  assert.ok(profile.industries?.includes("제조업"));
  assert.ok(profile.industries?.includes("전자부품"));
  // target_type: 법인사업자 → 법인.
  assert.deepEqual(profile.target_types, ["법인"]);
  // revenue: 과세표준 합계.
  assert.equal(profile.revenue_krw, 270_000_000);
  // founder_age: 1980-01-01 기준 만 45세.
  assert.equal(profile.founder_age, 45);

  assert.equal(profile.confidence?.region, 0.95);
  assert.equal(profile.confidence?.biz_age, 0.95);
  assert.equal(profile.confidence?.industry, 0.95);
  assert.equal(profile.confidence?.target_type, 0.95);
  assert.equal(profile.confidence?.revenue, 0.95);
  assert.equal(profile.confidence?.founder_age, 0.9);

  assert.equal(facts.has_region, true);
  assert.equal(facts.has_revenue, true);
  assert.equal(facts.masked_identity_no, "123456*******");
  assert.equal(facts.joint_representative, "김공동");
  assert.equal(facts.gender, "M");
});

check("buildCompanyProfileFromCodef: corp 없음 → 빈 프로필(생년월일만 있으면 founder_age)", () => {
  const asOf = new Date(Date.UTC(2025, 5, 1));
  const { profile } = buildCompanyProfileFromCodef({ birthDate8: "19900615", asOf });
  assert.equal(profile.founder_age, 34); // 1990-06-15, 2025-06-01 → 아직 생일 전 → 34
  assert.equal(profile.region, undefined);
  assert.equal(profile.confidence?.founder_age, 0.9);
  assert.equal(profile.confidence?.region, undefined);
});

// ── 토큰 만료 판정 ─────────────────────────────────────────────────────────
check("parseTokenResponse + isCodefTokenExpired: 만료 경계", () => {
  const token = parseTokenResponse(
    { access_token: "at-synthetic", token_type: "bearer", expires_in: 604799 },
    1_000_000,
  );
  assert.equal(token.accessToken, "at-synthetic");
  assert.equal(token.expiresInSec, 604799);
  assert.equal(token.obtainedAtMs, 1_000_000);

  // expiryMs = 1_000_000 + 604799_000 = 605_799_000; threshold = -3600_000 = 602_199_000.
  assert.equal(isCodefTokenExpired(token, 602_198_999, 3600), false);
  assert.equal(isCodefTokenExpired(token, 602_199_000, 3600), true);
});

check("parseTokenResponse: access_token 누락 → throw", () => {
  assert.throws(() => parseTokenResponse({ token_type: "bearer", expires_in: 100 }));
});

// ── RSA 왕복 ──────────────────────────────────────────────────────────────
check("encryptWithCodefPublicKey: 로컬 RSA 키쌍 왕복(공개키 DER base64 → 암호화 → 개인키 복호화)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const publicKeyBase64 = Buffer.from(publicKey).toString("base64");
  const plaintext = "certificate-password-123!";
  const encryptedBase64 = encryptWithCodefPublicKey(plaintext, publicKeyBase64);

  const decrypted = privateDecrypt(
    {
      key: createPrivateKey({ key: Buffer.from(privateKey), format: "der", type: "pkcs8" }),
      padding: constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(encryptedBase64, "base64"),
  );
  assert.equal(decrypted.toString("utf8"), plaintext);
});

console.log(`\nCODEF core: ${passed} cases passed.`);
