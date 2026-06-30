import assert from "node:assert/strict";
import { getOutboundEmailProviderStatus, sendOutboundEmail, OutboundEmailError } from "./outboundEmail";

assert.deepEqual(getOutboundEmailProviderStatus({ NODE_ENV: "test" }), {
  provider: "none",
  configured: false,
});

const skipped = await sendOutboundEmail({
  env: { NODE_ENV: "test" },
  message: sampleMessage(),
});
assert.equal(skipped.provider, "none");
assert.equal(skipped.configured, false);
assert.equal(skipped.status, "skipped");

const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
const delivered = await sendOutboundEmail({
  env: {
    NODE_ENV: "test",
    CUNOTE_EMAIL_WEBHOOK_URL: "https://email-provider.example.test/cunote",
    CUNOTE_EMAIL_WEBHOOK_SECRET: "secret-token",
  },
  message: sampleMessage(),
  fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), { status: 202 });
  },
});
assert.equal(delivered.provider, "webhook");
assert.equal(delivered.configured, true);
assert.equal(delivered.status, "delivered");
assert.equal(delivered.statusCode, 202);
assert.equal(calls.length, 1);
assert.equal(calls[0]?.url, "https://email-provider.example.test/cunote");
assert.equal((calls[0]?.init?.headers as Record<string, string>)?.authorization, "Bearer secret-token");
const body = JSON.parse(String(calls[0]?.init?.body)) as {
  schema?: string;
  message?: { to?: { email?: string }; subject?: string; text?: string; tags?: string[] };
};
assert.equal(body.schema, "cunote.outbound_email.v1");
assert.equal(body.message?.to?.email, "founder@example.com");
assert.equal(body.message?.subject, "[창업노트] 비밀번호 재설정 안내");
assert.equal(body.message?.text?.includes("https://changupnote.com/reset-password?token=verify"), true);
assert.deepEqual(body.message?.tags, ["password_reset"]);

await assert.rejects(
  () => sendOutboundEmail({
    env: {
      NODE_ENV: "test",
      CUNOTE_EMAIL_WEBHOOK_URL: "https://email-provider.example.test/cunote",
    },
    message: sampleMessage(),
    fetchImpl: async () => new Response("bad gateway", { status: 502 }),
  }),
  (error) => {
    assert(error instanceof OutboundEmailError);
    assert.equal(error.result.provider, "webhook");
    assert.equal(error.result.status, "failed");
    assert.equal(error.result.statusCode, 502);
    return true;
  },
);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "outbound_email_unconfigured_skip",
    "outbound_email_webhook_payload",
    "outbound_email_webhook_auth_header",
    "outbound_email_webhook_failure_result",
  ],
}, null, 2));

function sampleMessage() {
  return {
    to: { email: "founder@example.com" },
    from: { email: "support@changupnote.com", name: "창업노트 계정" },
    replyTo: { email: "support@changupnote.com" },
    subject: "[창업노트] 비밀번호 재설정 안내",
    text: "https://changupnote.com/reset-password?token=verify",
    tags: ["password_reset"],
  };
}
