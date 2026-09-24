import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseNaturalConfirmationArgs,
  runMigratedQuestionAcceptance,
  validateNaturalConfirmationConnection,
} from "./natural-confirmations-browser.mjs";

try {
  const { connectionPath } = parseNaturalConfirmationArgs(process.argv.slice(2));
  const connection = validateNaturalConfirmationConnection(connectionPath);
  const receipt = await runMigratedQuestionAcceptance(connection);
  const receiptPath = join(connection.runtimeRoot, "migrated-question-browser-receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    ok: true,
    suite: "migrated-question-browser",
    status: receipt.status,
    receiptPath,
    relatedGrantCount: receipt.roundTrip.relatedGrantCount,
    deleteStatus: receipt.roundTrip.deleteStatus,
    modelCalls: 0,
    externalWrites: 0,
  }));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    suite: "migrated-question-browser",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
}
