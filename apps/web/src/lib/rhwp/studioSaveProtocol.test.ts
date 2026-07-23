import assert from "node:assert/strict";
import type { RhwpEditor } from "@rhwp/editor";
import { resolveRhwpStudioSaveProtocol, type RhwpDocumentChange } from "./studioSaveProtocol";

const legacy = resolveRhwpStudioSaveProtocol({} as RhwpEditor);
assert.equal(legacy.supportsChangeEvents, false);
assert.equal(legacy.supportsSnapshotExport, false);
assert.equal(await legacy.getDirtyState(), null);
assert.equal(await legacy.exportSnapshot(), null);
assert.equal(legacy.subscribeDocumentChanged(() => undefined), null);

const change: RhwpDocumentChange = {
  documentEpoch: 3,
  changeSeq: 17,
  dirty: true,
  reason: "text-input",
};
let subscribedEvent: string | null = null;
let subscribedListener: ((payload: RhwpDocumentChange) => void) | null = null;
let unsubscribed = false;
const experimental = {
  getDirtyState: async () => change,
  exportSnapshot: async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    format: "hwpx" as const,
    pageCount: 2,
    documentEpoch: 3,
    changeSeq: 17,
    verification: null,
  }),
  subscribe: (
    event: string,
    listener: (payload: RhwpDocumentChange) => void,
  ) => {
    subscribedEvent = event;
    subscribedListener = listener;
    return () => {
      unsubscribed = true;
    };
  },
} as unknown as RhwpEditor;

const protocol = resolveRhwpStudioSaveProtocol(experimental);
assert.equal(protocol.supportsChangeEvents, true);
assert.equal(protocol.supportsSnapshotExport, true);
assert.deepEqual(await protocol.getDirtyState(), change);
assert.deepEqual(await protocol.exportSnapshot(), {
  bytes: new Uint8Array([1, 2, 3]),
  format: "hwpx",
  pageCount: 2,
  documentEpoch: 3,
  changeSeq: 17,
  verification: null,
});

let received: RhwpDocumentChange | null = null;
const unsubscribe = protocol.subscribeDocumentChanged((payload) => {
  received = payload;
});
assert.equal(subscribedEvent, "documentChanged");
assert.ok(subscribedListener);
(subscribedListener as (payload: RhwpDocumentChange) => void)(change);
assert.deepEqual(received, change);
unsubscribe?.();
assert.equal(unsubscribed, true);

console.log("studioSaveProtocol: ok");
