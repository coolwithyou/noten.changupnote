#!/usr/bin/env node
// POST /v1/hwp-markdown 동기 변환 엔드포인트 단위 검증.
// dist/server.js(정본 빌드 산출물)를 fake hwpToMarkdown·fake fetchSource 로 기동해
// 인증·검증·다운로드·sha256·변환 실패의 상태코드 계약을 확인한다. R2·pyhwp 불필요.
//
// 실행: pnpm --filter @cunote/conversion build && node apps/conversion/scripts/hwp-markdown-endpoint-test.mjs
//
// 커버:
//   200 성공(markdown+converter) / 400 본문 검증(비 hwp 확장자·필드 누락·JSON 파손)
//   401 인증 실패 / 409 sha256 불일치 / 413 원본 과대 / 422 변환 실패
//   502 원본 다운로드 실패 / 503 변환기 미주입

import { createHash } from "node:crypto";
import { createConversionServer } from "../dist/server.js";
import { ConversionQueue } from "../dist/queue.js";

const SECRET = "test-secret";

// 큐는 이 테스트에서 job 을 돌리지 않는다 — storage 는 미사용 스텁.
const stubStorage = {
  putObject: async () => { throw new Error("unused"); },
  getObjectText: async () => { throw new Error("unused"); },
};

const SMALL = Buffer.from("hwp-bytes-small");
const BIG = Buffer.alloc(64, 1); // maxSourceBytes=32 로 낮춰 413 유도

const fakeFetchSource = async (url) => {
  if (url.endsWith("/ok")) return SMALL;
  if (url.endsWith("/big")) return BIG;
  throw new Error("source download failed: HTTP 403 Forbidden");
};

const fakeHwpToMarkdown = ({ filename, body }) => {
  if (filename.startsWith("broken")) throw new Error("hwp5html failed: corrupt file");
  return { markdown: `# ${filename}\n(${body.length} bytes)`, converter: "fake-hwp5html-v1" };
};

function startServer(config) {
  const server = createConversionServer({
    queue: new ConversionQueue({ storage: stubStorage, concurrency: 1 }),
    sharedSecret: SECRET,
    fetchSource: fakeFetchSource,
    hwpMarkdownMaxSourceBytes: 32,
    ...config,
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

async function post(port, body, { secret = SECRET, rawBody } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/hwp-markdown`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-shared-secret": secret } : {}),
    },
    body: rawBody ?? JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

const { server, port } = await startServer({ hwpToMarkdown: fakeHwpToMarkdown });
try {
  // 200 성공 (sha256 동봉 포함)
  let r = await post(port, { filename: "공고문.hwp", sourceObjectUrl: "http://src/ok", sha256: sha(SMALL) });
  check("200 성공", r.status === 200 && r.json.markdown.includes("공고문.hwp") && r.json.converter === "fake-hwp5html-v1", r);

  // 200 성공 (sha256 생략, hwpx)
  r = await post(port, { filename: "양식.hwpx", sourceObjectUrl: "http://src/ok" });
  check("200 성공(sha256 생략·hwpx)", r.status === 200, r);

  // 400 계열
  r = await post(port, { filename: "문서.pdf", sourceObjectUrl: "http://src/ok" });
  check("400 비 hwp 확장자", r.status === 400, r);
  r = await post(port, { filename: "공고문.hwp" });
  check("400 sourceObjectUrl 누락", r.status === 400, r);
  r = await post(port, null, { rawBody: "not-json{" });
  check("400 JSON 파손", r.status === 400, r);

  // 401
  r = await post(port, { filename: "공고문.hwp", sourceObjectUrl: "http://src/ok" }, { secret: "wrong" });
  check("401 인증 실패", r.status === 401, r);

  // 409 sha256 불일치
  r = await post(port, { filename: "공고문.hwp", sourceObjectUrl: "http://src/ok", sha256: "0".repeat(64) });
  check("409 sha256 불일치", r.status === 409 && r.json.code === "sha256_mismatch", r);

  // 413 원본 과대
  r = await post(port, { filename: "공고문.hwp", sourceObjectUrl: "http://src/big" });
  check("413 원본 과대", r.status === 413 && r.json.code === "source_too_large", r);

  // 422 변환 실패
  r = await post(port, { filename: "broken.hwp", sourceObjectUrl: "http://src/ok" });
  check("422 변환 실패", r.status === 422 && r.json.code === "conversion_failed", r);

  // 502 다운로드 실패
  r = await post(port, { filename: "공고문.hwp", sourceObjectUrl: "http://src/denied" });
  check("502 다운로드 실패", r.status === 502 && r.json.code === "source_fetch_failed", r);
} finally {
  server.close();
}

// 503 변환기 미주입
{
  const { server: bare, port: barePort } = await startServer({});
  try {
    const r = await post(barePort, { filename: "공고문.hwp", sourceObjectUrl: "http://src/ok" });
    check("503 변환기 미주입", r.status === 503 && r.json.code === "converter_unavailable", r);
  } finally {
    bare.close();
  }
}

if (failures > 0) {
  console.error(`\n${failures} 건 실패`);
  process.exit(1);
}
console.log("\nhwp-markdown endpoint: 전 항목 통과");
