import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  encodeCanonical,
  normalizeCompletedAnalysisLaunchManifestForOfflineConsumption,
  normalizeAnalysisLaunchGrant, normalizeAnalysisLaunchReceipt, readAnalysisLaunchArtifact,
  type AnalysisLaunchManifest, type AnalysisLaunchReceipt, type AnalysisLaunchReceiptTarget,
  type AnalysisLaunchTerminalRepairBinding,
} from "./launch-batch-artifacts";

const MAX_TERMINAL_REPAIR_ANCESTRY_DEPTH = 16;

type TerminalRepairSelectedTarget = ReturnType<typeof selectTerminalRepairTargets>[number];
interface TerminalRepairSource {
  readonly manifest: AnalysisLaunchManifest;
  readonly binding: AnalysisLaunchTerminalRepairBinding;
  readonly selected: readonly TerminalRepairSelectedTarget[];
}

/** 후속 skipped는 이전 terminal 결과를 보존한다. 겹친 실행과 미완료 cohort는 준비하지 않는다. */
export function selectTerminalRepairTargets(
  manifest: AnalysisLaunchManifest,
  receipts: readonly { sha256: string; receipt: AnalysisLaunchReceipt }[],
): { sequence: number; grantId: string; status: "held" | "failed"; receiptSha256: string; target: AnalysisLaunchReceiptTarget }[] {
  if (!receipts.length) throw new Error("terminal repair receipt가 없습니다.");
  const latest = receipts.at(-1)!.receipt;
  if (latest.stopReason !== "completed" || latest.systemicFailure !== null) throw new Error("마지막 launch가 정상 종료되지 않았습니다.");
  const outcomes = new Map<number, { target: AnalysisLaunchReceiptTarget; receiptSha256: string }>();
  let previousFinish = -Infinity;
  for (const { sha256, receipt } of receipts) {
    if (Date.parse(receipt.startedAt) < previousFinish || Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)
      || receipt.targets.length !== manifest.targets.length) throw new Error("receipt 실행 시간 또는 target 범위가 충돌합니다.");
    previousFinish = Date.parse(receipt.finishedAt);
    for (const [index, expected] of manifest.targets.entries()) {
      const actual = receipt.targets[index];
      if (!actual || actual.sequence !== expected.sequence || actual.grantId !== expected.grantId) {
        throw new Error("terminal repair receipt target이 원 manifest와 다릅니다.");
      }
      if (actual.status !== "skipped") outcomes.set(expected.sequence, { target: actual, receiptSha256: sha256 });
    }
  }
  if (outcomes.size !== manifest.targets.length) throw new Error("미착수 target이 남아 있습니다.");
  return manifest.targets.flatMap(({ sequence, grantId }) => {
    const { target, receiptSha256 } = outcomes.get(sequence)!;
    return target.status === "held" || target.status === "failed"
      ? [{ sequence, grantId, status: target.status, receiptSha256, target }] : [];
  });
}

/** 원 grant에 속한 모든 로컬 receipt를 발견해 누락된 후속 성공을 이전 실패로 되돌리지 않는다. */
export async function readTerminalRepairSource(
  root: string,
  sourceManifestSha256: string,
  sourceGrantSha256: string,
): Promise<TerminalRepairSource> {
  return readTerminalRepairSourceAncestry(root, sourceManifestSha256, sourceGrantSha256, new Set(), 0);
}

async function readTerminalRepairSourceAncestry(
  root: string,
  sourceManifestSha256: string,
  sourceGrantSha256: string,
  ancestors: ReadonlySet<string>,
  depth: number,
): Promise<TerminalRepairSource> {
  if (depth >= MAX_TERMINAL_REPAIR_ANCESTRY_DEPTH) {
    throw new Error("terminal repair ancestry 깊이가 허용 범위를 넘었습니다.");
  }
  if (ancestors.has(sourceManifestSha256)) {
    throw new Error("terminal repair ancestry에 순환이 있습니다.");
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(sourceManifestSha256);
  const manifest = normalizeCompletedAnalysisLaunchManifestForOfflineConsumption(
    await readAnalysisLaunchArtifact("manifests", sourceManifestSha256, root));
  if (manifest.source.kind !== "current_inventory" || manifest.source.completedLaunch) {
    throw new Error("terminal repair 원본은 completedLaunch가 아닌 current inventory launch여야 합니다.");
  }
  const { readCurrentLaunchInventory, assertCurrentInventoryManifestBinding, TERMINAL_REPAIR_POLICY } = await import("./current-inventory-launch");
  const inventory = await readCurrentLaunchInventory(root, manifest.source.planArtifactSha256);
  assertCurrentInventoryManifestBinding(manifest, inventory);
  if ((inventory.policy === TERMINAL_REPAIR_POLICY) !== Boolean(manifest.source.terminalRepair)) {
    throw new Error("terminal repair 원본 inventory 정책이 ancestry와 다릅니다.");
  }
  if (manifest.source.terminalRepair) {
    const parentBinding = manifest.source.terminalRepair;
    const parent = await readTerminalRepairSourceAncestry(
      root,
      parentBinding.sourceManifestSha256,
      parentBinding.sourceGrantSha256,
      nextAncestors,
      depth + 1,
    );
    if (!encodeCanonical(parentBinding).equals(encodeCanonical(parent.binding))) {
      throw new Error("terminal repair 조상 receipt 집합 또는 최종 대상이 변경됐습니다.");
    }
    if (!encodeCanonical(manifest.targets.map(target => target.grantId))
      .equals(encodeCanonical(parent.selected.map(target => target.grantId)))) {
      throw new Error("terminal repair 조상 최종 실패·보류 대상과 source target이 다릅니다.");
    }
  }
  const grant = normalizeAnalysisLaunchGrant(await readAnalysisLaunchArtifact("grants", sourceGrantSha256, root));
  if (grant.manifestSha256 !== sourceManifestSha256 || grant.targetCount !== manifest.targets.length) {
    throw new Error("terminal repair 원 grant 결속이 다릅니다.");
  }
  const receipts = [];
  for (const filename of await readdir(join(root, "spike-out/analysis-lab/launch/receipts"))) {
    if (!filename.endsWith(".json")) continue;
    const bytes = await readFile(join(root, "spike-out/analysis-lab/launch/receipts", filename));
    const raw = JSON.parse(bytes.toString("utf8"));
    if (raw.grantSha256 !== sourceGrantSha256) continue;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (filename !== `${sha256}.json`) throw new Error("terminal repair receipt content address가 다릅니다.");
    const receipt = normalizeAnalysisLaunchReceipt(raw);
    if (receipt.manifestSha256 !== sourceManifestSha256) throw new Error("terminal repair receipt manifest 결속이 다릅니다.");
    receipts.push({ sha256, receipt });
  }
  receipts.sort((a, b) => a.receipt.startedAt.localeCompare(b.receipt.startedAt) || a.sha256.localeCompare(b.sha256));
  const selected = selectTerminalRepairTargets(manifest, receipts);
  if (!selected.length) throw new Error("실패·보류 terminal repair 대상이 없습니다.");
  for (const { target } of selected) {
    if (!target.runArtifactPath || !target.runArtifactSha256) throw new Error("terminal repair 원 run 증거가 없습니다.");
    const path = await realpath(resolve(root, target.runArtifactPath));
    const base = await realpath(join(root, "spike-out/analysis-lab"));
    const rel = relative(base, path);
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || resolve(base, rel) !== path) throw new Error("원 run 경로가 lab 밖입니다.");
    const bytes = await readFile(path);
    if (createHash("sha256").update(bytes).digest("hex") !== target.runArtifactSha256) throw new Error("원 run SHA가 다릅니다.");
    const run = JSON.parse(bytes.toString("utf8"));
    const expected = manifest.targets.find(t => t.grantId === target.grantId)!;
    if (run.grantId !== target.grantId || run.inputSha256 !== expected.inputSha256
      || run.attachmentManifestSha256 !== expected.attachmentManifestSha256) throw new Error("원 run input/attachment 결속이 다릅니다.");
  }
  const binding: AnalysisLaunchTerminalRepairBinding = {
    schema: "analysis-launch-terminal-repair-v1", sourceManifestSha256, sourceGrantSha256,
    receiptSha256s: receipts.map(r => r.sha256), originalSequences: selected.map(target => target.sequence),
  };
  return { manifest, binding, selected };
}
