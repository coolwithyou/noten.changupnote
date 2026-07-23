import assert from "node:assert/strict";
import {
  initialStudioSaveState,
  reduceStudioSaveState,
  type StudioSaveState,
} from "./studioSaveState";

let state: StudioSaveState = reduceStudioSaveState(initialStudioSaveState, {
  type: "loaded",
  supportsChangeEvents: false,
  revisionId: null,
  savedAt: null,
});
assert.deepEqual(state, {
  kind: "legacy-manual",
  revisionId: null,
  lastSavedAt: null,
});

state = reduceStudioSaveState(state, {
  type: "save-started",
  changeSeq: 1,
});
assert.equal(state.kind, "saving");

state = reduceStudioSaveState(state, {
  type: "save-succeeded",
  revisionId: "revision-1",
  savedAt: "2026-07-23T01:00:00.000Z",
  savedSeq: 1,
  currentSeq: null,
  supportsChangeEvents: false,
});
assert.deepEqual(state, {
  kind: "legacy-manual",
  revisionId: "revision-1",
  lastSavedAt: "2026-07-23T01:00:00.000Z",
});

state = reduceStudioSaveState(state, {
  type: "loaded",
  supportsChangeEvents: true,
  revisionId: "revision-1",
  savedAt: "2026-07-23T01:00:00.000Z",
  changeSeq: 7,
});
assert.equal(state.kind, "clean");

state = reduceStudioSaveState(state, { type: "changed", changeSeq: 8 });
assert.deepEqual(state, {
  kind: "dirty",
  changeSeq: 8,
  lastSavedAt: "2026-07-23T01:00:00.000Z",
});

state = reduceStudioSaveState(state, {
  type: "save-started",
  changeSeq: 8,
});
state = reduceStudioSaveState(state, {
  type: "save-succeeded",
  revisionId: "revision-2",
  savedAt: "2026-07-23T01:01:00.000Z",
  savedSeq: 8,
  currentSeq: 9,
  supportsChangeEvents: true,
});
assert.deepEqual(state, {
  kind: "dirty",
  changeSeq: 9,
  lastSavedAt: "2026-07-23T01:01:00.000Z",
});

state = reduceStudioSaveState(state, {
  type: "save-failed",
  changeSeq: 9,
  message: "network failed",
  hasTabSnapshot: true,
});
assert.deepEqual(state, {
  kind: "error",
  changeSeq: 9,
  lastSavedAt: "2026-07-23T01:01:00.000Z",
  message: "network failed",
  hasTabSnapshot: true,
});

console.log("studioSaveState: ok");
