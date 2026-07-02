const opsOrigin = (process.env.CUNOTE_OPS_ADMIN_ORIGIN ?? "https://ops.changupnote.com").replace(/\/$/, "");
const webOrigin = (process.env.CUNOTE_WEB_ORIGIN ?? "https://changupnote.com").replace(/\/$/, "");
const errors: string[] = [];

const csrf = await fetchJson<{ csrfToken: string }>("/api/auth/csrf");
const csrfCookie = setCookieHeader(csrf.headers);
const csrfSetCookies = setCookieValues(csrf.headers);
expect(csrf.status === 200, "ops csrf endpoint must return 200");
expect(Boolean(csrf.body.csrfToken), "ops csrf endpoint must return csrfToken");
expect(
  csrfSetCookies.some((value) => value.startsWith("__Host-cunote-admin.csrf-token=")),
  "ops csrf endpoint must set the host-only admin csrf cookie",
);
expect(
  csrfSetCookies.every((value) => !/;\s*Domain=/i.test(value)),
  "ops auth cookies must not set a cross-subdomain Domain attribute",
);

const providers = await fetchJson<Record<string, { id: string; type: string; callbackUrl: string }>>("/api/auth/providers");
expect(providers.status === 200, "ops providers endpoint must return 200");
expect(providers.body.password?.type === "credentials", "ops providers must expose password credentials");
expect(providers.body.google?.type === "oauth", "ops providers must expose Google OAuth");
expect(
  providers.body.google?.callbackUrl === `${opsOrigin}/api/auth/callback/google`,
  "ops Google callbackUrl must be the ops domain callback",
);

const googleSignin = await fetchText("/api/auth/signin/google", {
  method: "POST",
  redirect: "manual",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    cookie: csrfCookie,
  },
  body: new URLSearchParams({
    csrfToken: csrf.body.csrfToken,
    callbackUrl: `${opsOrigin}/`,
  }),
});
const googleLocation = googleSignin.headers.get("location") ?? "";
const googleUrl = googleLocation ? new URL(googleLocation) : null;
expect(googleSignin.status === 302, "ops Google signin must redirect");
expect(googleUrl?.host === "accounts.google.com", "ops Google signin must redirect to Google");
expect(
  googleUrl?.searchParams.get("redirect_uri") === `${opsOrigin}/api/auth/callback/google`,
  "ops Google OAuth redirect_uri must use the ops callback",
);
expect(googleUrl?.searchParams.get("hd") === "noten.im", "ops Google OAuth must include noten.im hd hint");
expect(googleUrl?.searchParams.get("scope")?.includes("openid") === true, "ops Google OAuth must request openid scope");
expect(Boolean(googleUrl?.searchParams.get("state")), "ops Google OAuth must include state");
if (googleLocation) {
  const googleResponse = await fetch(googleLocation, {
    redirect: "manual",
    headers: {
      "user-agent": "Mozilla/5.0",
    },
  });
  const nextLocation = googleResponse.headers.get("location") ?? "";
  const googleBody = await googleResponse.text();
  expect(
    !nextLocation.includes("/signin/oauth/error"),
    "ops Google OAuth must not immediately redirect to Google OAuth error",
  );
  expect(
    !/redirect_uri_mismatch/i.test(nextLocation) && !/redirect_uri_mismatch/i.test(googleBody),
    "ops Google OAuth callback must be registered in Google Cloud",
  );
}

const opsHome = await fetchText("/", { redirect: "manual" });
expect(opsHome.status === 307 || opsHome.status === 308, "ops home must redirect when logged out");
expect(opsHome.headers.get("location")?.startsWith("/login") === true, "ops home logged-out redirect must target login");

const opsLogin = await fetchText("/login");
expect(opsLogin.status === 200, "ops login page must return 200");
expect(opsLogin.body.includes("운영 콘솔 로그인"), "ops login page must render the admin login heading");
expect(opsLogin.body.includes("Google로 계속"), "ops login page must render Google login");
expect(opsLogin.body.includes("이메일 로그인"), "ops login page must render email login");

const opsStatus = await fetchJson<{ error?: { code?: string } }>("/api/admin/status");
expect(opsStatus.status === 401, "ops admin status must require admin auth");
expect(opsStatus.body.error?.code === "admin_auth_required", "ops admin status must return admin_auth_required");

const opsStatusWithWebCookie = await fetchJson<{ error?: { code?: string } }>("/api/admin/status", {
  headers: {
    cookie: "__Secure-next-auth.session-token=fake-web-session; next-auth.session-token=fake-web-session",
  },
});
expect(opsStatusWithWebCookie.status === 401, "ops admin status must reject web NextAuth session cookies");
expect(
  opsStatusWithWebCookie.body.error?.code === "admin_auth_required",
  "ops admin status with web cookies must return admin_auth_required",
);

const liveMatch = await fetchJson<{ error?: { code?: string } }>("/api/matches/live", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
});
expect(liveMatch.status === 401, "ops live match API must require admin auth");
expect(liveMatch.body.error?.code === "admin_auth_required", "ops live match API must return admin_auth_required");

for (const path of ["/admin", "/internal/live-match", "/api/admin/status", "/api/matches/live"]) {
  const result = await fetch(`${webOrigin}${path}`, {
    method: path === "/api/matches/live" ? "POST" : "GET",
    redirect: "manual",
    headers: {
      cookie: "__Secure-cunote-admin.session-token=fake-admin-session",
    },
  });
  expect(result.status !== 200, `web legacy admin route must not open even with admin cookie name: ${path}`);
}

if (errors.length > 0) {
  console.error("Ops admin live verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Ops admin live verification passed.");

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ status: number; headers: Headers; body: T }> {
  const response = await fetch(`${opsOrigin}${path}`, init);
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json() as T,
  };
}

async function fetchText(path: string, init?: RequestInit): Promise<{ status: number; headers: Headers; body: string }> {
  const response = await fetch(`${opsOrigin}${path}`, init);
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
}

function setCookieHeader(headers: Headers): string {
  return setCookieValues(headers).map((item) => item.split(";")[0]).join("; ");
}

function setCookieValues(headers: Headers): string[] {
  return headers.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie") as string] : []);
}

function expect(condition: boolean, message: string) {
  if (!condition) errors.push(message);
}
