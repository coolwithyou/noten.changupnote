import assert from "node:assert/strict";
import test from "node:test";
import {
  StudioInitializationTimeoutError,
  studioInitializationTimeoutMs,
  studioUrlForInitializationAttempt,
  withStudioInitializationTimeout,
} from "./studioInitialization";

test("Studio 초기화 시간은 문서 크기에 비례하고 상한을 넘지 않는다", () => {
  assert.equal(studioInitializationTimeoutMs(0), 35_000);
  assert.equal(studioInitializationTimeoutMs(1), 37_000);
  assert.equal(studioInitializationTimeoutMs(30 * 1024 * 1024), 95_000);
  assert.equal(studioInitializationTimeoutMs(100 * 1024 * 1024), 120_000);
});

test("두 번째 Studio 연결은 캐시와 iframe 연결을 새로 만들 수 있는 URL을 사용한다", () => {
  const base = "https://studio.example/?renderer=canvas2d";
  assert.equal(studioUrlForInitializationAttempt(base, 0, "fixed"), base);
  assert.equal(
    studioUrlForInitializationAttempt(base, 1, "fixed"),
    "https://studio.example/?renderer=canvas2d&host-reconnect=1-fixed",
  );
});

test("Studio 초기화 감시 타이머는 멈춘 요청을 bounded error로 바꾼다", async () => {
  await assert.rejects(
    withStudioInitializationTimeout(new Promise(() => undefined), 5),
    (error: unknown) => error instanceof StudioInitializationTimeoutError && error.timeoutMs === 5,
  );
});
