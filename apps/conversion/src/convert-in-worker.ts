import { Worker } from "node:worker_threads";
import type { ConvertDocumentInput, ConvertDocumentResult } from "./types.js";

export type ConversionWorkerReply =
  | { ok: true; result: ConvertDocumentResult }
  | { ok: false; error: string };

/** The queue bounds concurrency and owns workDir until this worker exits and uploads finish. */
export function convertDocumentInWorker(
  input: ConvertDocumentInput,
  workerUrl: URL = new URL("./conversion-worker.js", import.meta.url),
): Promise<ConvertDocumentResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: input });
    let reply: ConversionWorkerReply | undefined;
    let failure: Error | undefined;
    worker.once("message", (message: ConversionWorkerReply) => { reply = message; });
    worker.once("messageerror", (error: Error) => { failure = error; });
    worker.once("error", (error: Error) => { failure = error; });
    // Waiting for exit also prevents cleanup from racing the worker's file writes.
    worker.once("exit", (code) => {
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Conversion worker exited with code ${code}`));
      else if (!reply) reject(new Error("Conversion worker exited without a result"));
      else if (!reply.ok) reject(new Error(reply.error));
      else resolve(reply.result);
    });
  });
}
