import assert from "node:assert/strict";
import {
  buildApplicationCalendarSubscription,
  verifyApplicationCalendarSubscriptionToken,
} from "./applicationCalendarSubscription";

process.env.CUNOTE_CALENDAR_FEED_SECRET = "verify-calendar-feed-secret";

const access = {
  companyId: "00000000-0000-4000-8000-000000000101",
  userId: "00000000-0000-4000-8000-000000000001",
  role: "owner" as const,
  mode: "session" as const,
};
const issuedAt = new Date("2026-06-30T00:00:00.000Z");
const subscription = buildApplicationCalendarSubscription({
  access,
  origin: "https://changupnote.com",
  issuedAt,
  ttlDays: 30,
});

assert(subscription.token.startsWith("v1."));
assert(subscription.httpsUrl.startsWith("https://changupnote.com/api/web/applications/calendar-feed/"));
assert(subscription.webcalUrl.startsWith("webcal://changupnote.com/api/web/applications/calendar-feed/"));
assert.equal(subscription.expiresAt, "2026-07-30T00:00:00.000Z");
assert.equal(subscription.filename, "창업노트-신청캘린더-구독-2026-06-30.md");
assert.equal(subscription.fallbackFilename, "cunote-application-calendar-subscription-2026-06-30.md");
assert(subscription.markdown.includes("# 창업노트 신청 캘린더 구독 URL"));
assert(subscription.markdown.includes("## 구독 링크"));
assert(subscription.markdown.includes(subscription.webcalUrl));
assert(subscription.markdown.includes("팀 내부에서만 공유"));

const verified = verifyApplicationCalendarSubscriptionToken({
  token: subscription.token,
  now: new Date("2026-07-01T00:00:00.000Z"),
});
assert.deepEqual(verified, {
  companyId: access.companyId,
  userId: access.userId,
  role: "owner",
  mode: "token",
});

assert.throws(
  () => verifyApplicationCalendarSubscriptionToken({
    token: `${subscription.token.slice(0, -4)}dead`,
    now: new Date("2026-07-01T00:00:00.000Z"),
  }),
  /올바르지 않습니다/,
);
assert.throws(
  () => verifyApplicationCalendarSubscriptionToken({
    token: subscription.token,
    now: new Date("2026-07-31T00:00:00.000Z"),
  }),
  /만료되었습니다/,
);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "calendar_subscription_token",
    "calendar_subscription_urls",
    "calendar_subscription_markdown",
    "calendar_subscription_verify_access",
    "calendar_subscription_invalid_signature",
    "calendar_subscription_expiry",
  ],
}, null, 2));
