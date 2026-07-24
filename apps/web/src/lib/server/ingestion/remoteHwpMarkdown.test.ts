// 원격 HWP→markdown 클라이언트와 인제스트 폴백 단위 테스트.
// 실 DB/R2/변환 서버 없이 fake fetch·storage·remote client로 계약을 검증한다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";
import {
  archiveGrantAttachments,
  setCachedLocalHwpConverterAvailableForTest,
} from "./grantAttachmentArchive";
import {
  createRemoteHwpMarkdown,
  createRemoteHwpMarkdownFromEnv,
  type RemoteHwpMarkdownClient,
} from "./remoteHwpMarkdown";

let passed = 0;

async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function main(): Promise<void> {
  await check("env 두 값이 모두 있을 때만 클라이언트를 생성한다", () => {
    assert.equal(createRemoteHwpMarkdownFromEnv({ NODE_ENV: "test" }), null);
    assert.equal(createRemoteHwpMarkdownFromEnv({
      NODE_ENV: "test",
      CONVERSION_SERVER_URL: "https://convert.example",
    }), null);
    assert.ok(createRemoteHwpMarkdownFromEnv({
      NODE_ENV: "test",
      CONVERSION_SERVER_URL: "https://convert.example/",
      CONVERSION_SHARED_SECRET: "secret",
    }));
  });

  await check("200 응답은 요청 계약과 markdown 결과를 보존한다", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const client = createRemoteHwpMarkdown({
      baseUrl: "https://convert.example/",
      sharedSecret: "secret",
      fetchImpl: (async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json({ markdown: "# 변환 결과", converter: "fake-hwp5html-v1" });
      }) as typeof fetch,
    });

    const result = await client.convert({
      filename: "참가신청서.hwp",
      sourceObjectUrl: "https://r2.example/source?signature=redacted",
      sha256: "a".repeat(64),
    });

    assert.deepEqual(result, { markdown: "# 변환 결과", converter: "fake-hwp5html-v1" });
    assert.equal(capturedUrl, "https://convert.example/v1/hwp-markdown");
    assert.equal(capturedInit?.method, "POST");
    assert.equal(new Headers(capturedInit?.headers).get("x-shared-secret"), "secret");
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      filename: "참가신청서.hwp",
      sourceObjectUrl: "https://r2.example/source?signature=redacted",
      sha256: "a".repeat(64),
    });
  });

  await check("401 응답은 상태와 서버 오류를 포함해 실패한다", async () => {
    const client = createRemoteHwpMarkdown({
      baseUrl: "https://convert.example",
      sharedSecret: "wrong",
      fetchImpl: (async () => Response.json(
        { error: "unauthorized" },
        { status: 401 },
      )) as typeof fetch,
    });
    await assert.rejects(
      client.convert({ filename: "신청서.hwp", sourceObjectUrl: "https://r2.example/source" }),
      /HTTP 401 unauthorized/,
    );
  });

  await check("422 응답은 변환 실패 코드를 포함해 실패한다", async () => {
    const client = createRemoteHwpMarkdown({
      baseUrl: "https://convert.example",
      sharedSecret: "secret",
      fetchImpl: (async () => Response.json(
        { code: "conversion_failed" },
        { status: 422 },
      )) as typeof fetch,
    });
    await assert.rejects(
      client.convert({ filename: "깨진파일.hwp", sourceObjectUrl: "https://r2.example/source" }),
      /HTTP 422 conversion_failed/,
    );
  });

  await check("응답이 제한 시간을 넘으면 AbortSignal로 중단한다", async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init?.signal?.aborted) rejectAbort();
        else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
      })) as typeof fetch;
    const client = createRemoteHwpMarkdown({
      baseUrl: "https://convert.example",
      sharedSecret: "secret",
      timeoutMs: 5,
      fetchImpl,
    });
    await assert.rejects(
      client.convert({ filename: "응답없음.hwp", sourceObjectUrl: "https://r2.example/source" }),
      /타임아웃 \(5ms\)/,
    );
  });

  await check("로컬 변환기 불가 시 presigned R2 URL로 원격 변환하고 converted로 보관한다", async () => {
    setCachedLocalHwpConverterAvailableForTest(false);
    const sourceBody = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const uploads: Array<{ key: string; body: Buffer | string; contentType: string }> = [];
    const presignedKeys: string[] = [];
    const storage = {
      async putObject(input: { key: string; body: Buffer | string; contentType: string }) {
        uploads.push(input);
        return { key: input.key, url: `https://r2.example/${input.key}` };
      },
      async presignGetUrl(key: string) {
        presignedKeys.push(key);
        return `https://signed-r2.example/${key}?signature=redacted`;
      },
    } as R2ObjectStorage;
    const remoteCalls: Parameters<RemoteHwpMarkdownClient["convert"]>[0][] = [];
    const remote: RemoteHwpMarkdownClient = {
      async convert(request) {
        remoteCalls.push(request);
        return { markdown: "지원 대상: 해양수산 분야 예비창업자", converter: "remote-hwp5html-v1" };
      },
    };

    const result = await archiveGrantAttachments([{
      filename: "참가신청서.hwp",
      url: "https://origin.example/application.hwp",
    }], {
      source: "kstartup",
      sourceId: "178352",
      collectedAt: new Date("2026-07-24T00:00:00.000Z"),
      enabled: true,
      convertHwp: true,
      autoInstallPyhwp: false,
      allowFailures: false,
      storage,
      fetchImpl: (async () => new Response(new Uint8Array(sourceBody), {
        status: 200,
        headers: { "content-type": "application/x-hwp" },
      })) as typeof fetch,
      remoteHwpMarkdown: remote,
    });

    assert.equal(result.convertedCount, 1);
    assert.equal(result.failureCount, 0);
    assert.equal(result.attachments[0]?.conversion?.status, "converted");
    assert.equal(result.attachments[0]?.conversion?.converter, "remote-hwp5html-v1");
    assert.equal(uploads.length, 2);
    assert.deepEqual(presignedKeys, [uploads[0]?.key]);
    assert.equal(remoteCalls.length, 1);
    assert.equal(remoteCalls[0]?.filename, "참가신청서.hwp");
    assert.equal(remoteCalls[0]?.sourceObjectUrl, `https://signed-r2.example/${uploads[0]?.key}?signature=redacted`);
    assert.equal(remoteCalls[0]?.sha256, createHash("sha256").update(sourceBody).digest("hex"));
  });

  await check("로컬 변환기와 원격 클라이언트가 모두 없으면 기존 failed 경로를 유지한다", async () => {
    setCachedLocalHwpConverterAvailableForTest(false);
    const uploads: string[] = [];
    let presignCount = 0;
    const storage = {
      async putObject(input: { key: string }) {
        uploads.push(input.key);
        return { key: input.key, url: `https://r2.example/${input.key}` };
      },
      async presignGetUrl(key: string) {
        presignCount += 1;
        return `https://signed-r2.example/${key}`;
      },
    } as R2ObjectStorage;

    const result = await archiveGrantAttachments([{
      filename: "참가신청서.hwp",
      url: "https://origin.example/application.hwp",
    }], {
      source: "kstartup",
      sourceId: "178352",
      collectedAt: new Date("2026-07-24T00:00:00.000Z"),
      enabled: true,
      convertHwp: true,
      autoInstallPyhwp: false,
      allowFailures: true,
      storage,
      fetchImpl: (async () => new Response(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), {
        status: 200,
      })) as typeof fetch,
      remoteHwpMarkdown: null,
    });

    assert.equal(result.convertedCount, 0);
    assert.equal(result.failureCount, 1);
    assert.equal(result.attachments[0]?.conversion?.status, "failed");
    assert.match(result.attachments[0]?.conversion?.error ?? "", /hwp5html not found/);
    assert.equal(uploads.length, 1);
    assert.equal(presignCount, 0);
  });
}

try {
  await main();
  console.log(`\nremote hwp markdown: ${passed}개 시나리오 통과`);
} finally {
  setCachedLocalHwpConverterAvailableForTest(null);
}
