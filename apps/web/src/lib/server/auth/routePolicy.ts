export const PUBLIC_WEB_ROUTES = [
  "GET /api/web/stats",
  "POST /api/web/teaser",
] as const;

export const SESSION_WEB_ROUTES = [
  "GET /dashboard",
  "GET /grants/[grantId]",
  "GET /api/web/dashboard",
  "GET /api/web/companies",
  "POST /api/web/companies/switch",
  "GET /api/web/consents",
  "PUT /api/web/consents",
  "DELETE /api/web/consents/[scope]",
  "GET /api/web/matches",
  "GET /api/web/action-queue",
  "GET /api/web/next-question",
  "GET /api/web/grants/[grantId]",
  "POST /api/web/profile/field",
  "GET /api/web/notifications",
  "PUT /api/web/notifications",
] as const;

export const PUBLIC_APP_ROUTES = [
  "POST /api/app/v1/auth/login",
  "POST /api/app/v1/auth/[provider]",
  "POST /api/app/v1/auth/refresh",
  "POST /api/app/v1/auth/logout",
  "GET /api/app/v1/openapi.json",
  "GET /api/app/v1/stats",
  "POST /api/app/v1/teaser",
] as const;

export const SESSION_APP_ROUTES = [
  "GET /api/app/v1/companies",
  "POST /api/app/v1/companies",
  "GET /api/app/v1/companies/[companyId]/consents",
  "PUT /api/app/v1/companies/[companyId]/consents",
  "DELETE /api/app/v1/companies/[companyId]/consents/[scope]",
  "GET /api/app/v1/companies/[companyId]/profile",
  "POST /api/app/v1/companies/[companyId]/profile/field",
  "GET /api/app/v1/companies/[companyId]/matches",
  "GET /api/app/v1/companies/[companyId]/next-question",
  "GET /api/app/v1/companies/[companyId]/roadmap",
  "GET /api/app/v1/grants/[grantId]",
  "POST /api/app/v1/matches/[companyId]/[grantId]/feedback",
  "POST /api/app/v1/matches/[companyId]/[grantId]/events",
  "GET /api/app/v1/notifications/settings",
  "PUT /api/app/v1/notifications/settings",
  "POST /api/app/v1/devices",
  "DELETE /api/app/v1/devices/[deviceId]",
] as const;
