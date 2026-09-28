import { parentPort, workerData } from "node:worker_threads";
import { convertDocument } from "./convert-document.js";
import { hwpToMarkdown } from "./hwp-markdown-adapter.js";
import { hwpxConvert } from "./hwpx-convert.js";
import type { ConvertDocumentInput } from "./types.js";
import type { ConversionWorkerReply } from "./convert-in-worker.js";

if (!parentPort) throw new Error("Conversion entrypoint requires a worker thread");
const input = workerData as ConvertDocumentInput;
let reply: ConversionWorkerReply;
try {
  // Structured cloning transports Buffer as Uint8Array; native adapters require Buffer.
  const result = convertDocument({ ...input, body: Buffer.from(input.body) }, { hwpToMarkdown, hwpxConvert });
  reply = { ok: true, result };
} catch (error) {
  reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
}
parentPort.postMessage(reply);
parentPort.close();
