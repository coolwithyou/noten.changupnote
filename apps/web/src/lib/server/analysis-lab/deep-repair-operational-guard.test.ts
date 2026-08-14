import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import {
  createDeepRepairOperationalEvidenceCaptureUnsafeForTest,
  createDeepRepairOperationalGuardUnsafeForTest,
  type DeepRepairOperationalGuardExecFile,
} from "./deep-repair-operational-guard";
import type { DeepRepairOperationalEvidence } from "./deep-repair-live-experiment";

const PRINCIPAL = "cunote-codex-dev@changupnote-com.iam.gserviceaccount.com";
// Cloud Run v2는 uid를 opaque string으로 계약한다. UUID 버전을 추측해 거부하지 않는다.
const JOB_UID = "cloud-run-job-uid-opaque";
const JOB_ETAG = "BwY8xj88K1Q";
const JOB_UPDATE_TIME = "2026-08-14T02:54:31.123456Z";
const GIT_SHA = "e00cee9a346ff88ae879f3739c8802949976a03e";
const PRE_CLAIM_SCOPE_GIT_SHA = "befbf3b5d56c5879e6ebb73e47486a721ead591e";
const IMAGE_DIGEST = `sha256:${"2".repeat(64)}`;
const IMAGE = `asia-northeast3-docker.pkg.dev/changupnote-com/deep-analysis/worker@${IMAGE_DIGEST}`;

const evidence: DeepRepairOperationalEvidence = {
  schema: "deep-repair-operational-evidence-v1",
  project: "changupnote-com",
  region: "asia-northeast3",
  job: "cunote-deep-analysis",
  workerMode: "observe_only",
  claimScope: "unconfigured",
  jobUid: JOB_UID,
  jobGeneration: "1842",
  jobEtag: JOB_ETAG,
  jobUpdateTime: JOB_UPDATE_TIME,
  imageDigest: IMAGE_DIGEST,
  gitCommitSha: GIT_SHA,
  observedAt: "2026-08-14T02:55:00.000Z",
  validUntil: "2026-08-14T03:15:00.000Z",
};

function cloudRunV1(
  overrides: Record<string, unknown> = {},
  gitCommitSha = GIT_SHA,
): Record<string, unknown> {
  return {
    apiVersion: "run.googleapis.com/v1",
    kind: "Job",
    metadata: {
      name: "cunote-deep-analysis",
      namespace: "changupnote-com",
      uid: JOB_UID,
      generation: "1842",
    },
    spec: {
      template: {
        spec: {
          template: {
            spec: {
              containers: [{
                image: IMAGE,
                env: [
                  { name: "GIT_COMMIT_SHA", value: gitCommitSha },
                  { name: "DEEP_ANALYSIS_WORKER_MODE", value: "observe_only" },
                  { name: "DEEP_ANALYSIS_CLAIM_SCOPE", value: "unconfigured" },
                ],
              }],
            },
          },
        },
      },
    },
    status: { observedGeneration: "1842" },
    ...overrides,
  };
}

function cloudRunV2(
  overrides: Record<string, unknown> = {},
  gitCommitSha = GIT_SHA,
): Record<string, unknown> {
  return {
    name: "projects/changupnote-com/locations/asia-northeast3/jobs/cunote-deep-analysis",
    uid: JOB_UID,
    generation: "1842",
    updateTime: JOB_UPDATE_TIME,
    etag: JOB_ETAG,
    observedGeneration: "1842",
    reconciling: false,
    template: {
      template: {
        containers: [{
          image: IMAGE,
          env: [
            { name: "GIT_COMMIT_SHA", value: gitCommitSha },
            { name: "DEEP_ANALYSIS_WORKER_MODE", value: "observe_only" },
            { name: "DEEP_ANALYSIS_CLAIM_SCOPE", value: "unconfigured" },
          ],
        }],
      },
    },
    ...overrides,
  };
}

function commandHarness(input: {
  readonly tokenInfoEmail?: string;
  readonly v1?: Record<string, unknown>;
  readonly v2?: Record<string, unknown>;
  readonly workerContractSafe?: boolean;
  readonly gitCommitSha?: string;
}) {
  const calls: Array<{
    file: string;
    args: readonly string[];
    signal: AbortSignal;
    input: string | undefined;
  }> = [];
  const execFile: DeepRepairOperationalGuardExecFile = async (file, args, options) => {
    calls.push({ file, args, signal: options.signal, input: options.input });
    if (file === "gcloud" && args[0] === "auth") return { stdout: "secret-access-token\n" };
    if (file === "gcloud" && args[0] === "run") {
      return { stdout: JSON.stringify(input.v1 ?? cloudRunV1({}, input.gitCommitSha)) };
    }
    if (file === "curl" && args.at(-1) === "https://oauth2.googleapis.com/tokeninfo") {
      return { stdout: JSON.stringify({ email: input.tokenInfoEmail ?? PRINCIPAL }) };
    }
    if (file === "curl") {
      return { stdout: JSON.stringify(input.v2 ?? cloudRunV2({}, input.gitCommitSha)) };
    }
    if (file === "git") {
      if (input.workerContractSafe === false) throw new Error("not an ancestor");
      return { stdout: "" };
    }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  };
  return { execFile, calls };
}

{
  const harness = commandHarness({});
  const signal = new AbortController().signal;
  const captured = await createDeepRepairOperationalEvidenceCaptureUnsafeForTest({
    execFile: harness.execFile,
    now: () => new Date("2026-08-14T02:55:00.000Z"),
  })(signal);

  assert.deepEqual(captured, {
    ...evidence,
    validUntil: "2026-08-14T03:10:00.000Z",
  });
  assert.equal(harness.calls.length, 5);
}

{
  const harness = commandHarness({});
  const signal = new AbortController().signal;
  await createDeepRepairOperationalGuardUnsafeForTest({ execFile: harness.execFile })(
    evidence,
    signal,
  );

  assert.equal(harness.calls.length, 5);
  assert.deepEqual(harness.calls[0]!.args, [
    "auth",
    "print-access-token",
    `--configuration=cunote-codex-dev`,
    `--impersonate-service-account=${PRINCIPAL}`,
  ]);
  assert.deepEqual(harness.calls[2]!.args, [
    "run",
    "jobs",
    "describe",
    "cunote-deep-analysis",
    "--configuration=cunote-codex-dev",
    `--impersonate-service-account=${PRINCIPAL}`,
    "--project=changupnote-com",
    "--region=asia-northeast3",
    "--format=json",
  ]);
  assert.ok(harness.calls.every((call) => call.signal === signal));
  assert.equal(harness.calls[1]!.input, "secret-access-token");
  assert.match(harness.calls[3]!.input ?? "", /^Authorization: Bearer secret-access-token\n/u);
  assert.deepEqual(harness.calls[4]!.args.slice(2), [
    "merge-base",
    "--is-ancestor",
    "ec8cec75566e9ba5d07aead3837ce48501b1b6a9",
    GIT_SHA,
  ]);
  assert.equal(harness.calls[4]!.args[0], "-C");
  assert.match(harness.calls[4]!.args[1] ?? "", /\/cunote$/u);
  assert.equal(
    harness.calls.some((call) => call.args.some((arg) => arg.includes("secret-access-token"))),
    false,
    "access token must not be exposed in child-process arguments",
  );
}

{
  const harness = commandHarness({
    gitCommitSha: PRE_CLAIM_SCOPE_GIT_SHA,
    workerContractSafe: false,
  });
  await assert.rejects(
    createDeepRepairOperationalEvidenceCaptureUnsafeForTest({ execFile: harness.execFile })(
      new AbortController().signal,
    ),
    /worker contract.*safe baseline|safe baseline.*worker contract/i,
    "observe_only/unconfigured env를 실제 집행하지 않는 과거 worker image는 거부해야 한다",
  );
  assert.equal(harness.calls.at(-1)?.file, "git");
}

{
  const harness = commandHarness({ tokenInfoEmail: "sw@noten.im" });
  await assert.rejects(
    createDeepRepairOperationalGuardUnsafeForTest({ execFile: harness.execFile })(
      evidence,
      new AbortController().signal,
    ),
    /impersonated principal/i,
  );
  assert.equal(harness.calls.length, 2, "principal mismatch must fail before Cloud Run reads");
}

const driftCases: Array<{
  label: string;
  v2?: Record<string, unknown>;
  v1?: Record<string, unknown>;
}> = [
  { label: "UID", v2: cloudRunV2({ uid: "a0fb5d10-4764-47b1-9624-438f0fcc85fb" }) },
  { label: "generation", v2: cloudRunV2({ generation: "1843", observedGeneration: "1843" }) },
  { label: "etag", v2: cloudRunV2({ etag: "BwChanged" }) },
  { label: "updateTime", v2: cloudRunV2({ updateTime: "2026-08-14T02:55:31.123456Z" }) },
  {
    label: "image digest",
    v2: cloudRunV2({
      template: {
        template: {
          containers: [{
            image: `asia-northeast3-docker.pkg.dev/changupnote-com/deep-analysis/worker@sha256:${"3".repeat(64)}`,
            env: [
              { name: "GIT_COMMIT_SHA", value: GIT_SHA },
              { name: "DEEP_ANALYSIS_WORKER_MODE", value: "observe_only" },
              { name: "DEEP_ANALYSIS_CLAIM_SCOPE", value: "unconfigured" },
            ],
          }],
        },
      },
    }),
  },
  {
    label: "GIT_COMMIT_SHA",
    v1: cloudRunV1({
      spec: {
        template: {
          spec: {
            template: {
              spec: {
                containers: [{
                  image: IMAGE,
                  env: [
                    { name: "GIT_COMMIT_SHA", value: "4".repeat(40) },
                    { name: "DEEP_ANALYSIS_WORKER_MODE", value: "observe_only" },
                    { name: "DEEP_ANALYSIS_CLAIM_SCOPE", value: "unconfigured" },
                  ],
                }],
              },
            },
          },
        },
      },
    }),
  },
  {
    label: "worker mode",
    v2: cloudRunV2({
      template: {
        template: {
          containers: [{
            image: IMAGE,
            env: [
              { name: "GIT_COMMIT_SHA", value: GIT_SHA },
              { name: "DEEP_ANALYSIS_WORKER_MODE", value: "active" },
              { name: "DEEP_ANALYSIS_CLAIM_SCOPE", value: "unconfigured" },
            ],
          }],
        },
      },
    }),
  },
  {
    label: "claim scope",
    v1: cloudRunV1({
      spec: {
        template: {
          spec: {
            template: {
              spec: {
                containers: [{
                  image: IMAGE,
                  env: [
                    { name: "GIT_COMMIT_SHA", value: GIT_SHA },
                    { name: "DEEP_ANALYSIS_WORKER_MODE", value: "observe_only" },
                    { name: "DEEP_ANALYSIS_CLAIM_SCOPE", value: "bounded" },
                  ],
                }],
              },
            },
          },
        },
      },
    }),
  },
];

for (const drift of driftCases) {
  const harness = commandHarness({
    ...(drift.v1 ? { v1: drift.v1 } : {}),
    ...(drift.v2 ? { v2: drift.v2 } : {}),
  });
  await assert.rejects(
    createDeepRepairOperationalGuardUnsafeForTest({ execFile: harness.execFile })(
      evidence,
      new AbortController().signal,
    ),
    new RegExp(drift.label, "i"),
    `${drift.label} drift must fail closed`,
  );
}

{
  const harness = commandHarness({
    v2: cloudRunV2({ generation: "1842", observedGeneration: "1841" }),
  });
  await assert.rejects(
    createDeepRepairOperationalGuardUnsafeForTest({ execFile: harness.execFile })(
      evidence,
      new AbortController().signal,
    ),
    /observedGeneration/i,
  );
}

{
  const sourceRoot = new URL("../../../", import.meta.url);
  const unsafeFactories = [
    "createDeepRepairOperationalGuardUnsafeForTest",
    "createDeepRepairOperationalEvidenceCaptureUnsafeForTest",
  ] as const;
  for (const unsafeFactory of unsafeFactories) {
    for (const path of await listProductionTypeScript(sourceRoot)) {
      if (path.pathname.endsWith("/deep-repair-operational-guard.ts")) continue;
      const source = await readFile(path, "utf8");
      assert.equal(
        source.includes(unsafeFactory),
        false,
        `${unsafeFactory} must not be imported or called by production source: ${path.pathname}`,
      );
    }
  }
}

async function listProductionTypeScript(root: URL): Promise<URL[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<URL[]> => {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), root);
    if (entry.isDirectory()) return listProductionTypeScript(path);
    const isTypeScript = path.pathname.endsWith(".ts") || path.pathname.endsWith(".tsx");
    const isTest = path.pathname.endsWith(".test.ts") || path.pathname.endsWith(".test.tsx");
    return entry.isFile() && isTypeScript && !isTest
      ? [path]
      : [];
  }));
  return nested.flat();
}

console.log("deep-repair-operational-guard tests: ok");
