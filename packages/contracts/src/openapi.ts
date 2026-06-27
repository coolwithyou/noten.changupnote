const json = (schema: unknown) => ({
  "application/json": { schema },
});

const ref = (name: string) => ({
  $ref: `#/components/schemas/${name}`,
});

const arrayOf = (items: unknown) => ({
  type: "array",
  items,
});

const nullable = (schema: unknown) => ({
  anyOf: [schema, { type: "null" }],
});

const envelope = (data: unknown) => ({
  type: "object",
  required: ["data"],
  properties: {
    data,
    meta: ref("ApiMeta"),
    error: ref("ApiError"),
  },
  additionalProperties: false,
});

const pathParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string" },
});

const queryParam = (name: string, description: string) => ({
  name,
  in: "query",
  required: false,
  description,
  schema: { type: "string" },
});

const bearerSecurity = [{ appBearerAuth: [] }];

export const appV1OpenApiRoutePaths = [
  "/api/app/v1/auth/{provider}",
  "/api/app/v1/auth/login",
  "/api/app/v1/auth/logout",
  "/api/app/v1/auth/refresh",
  "/api/app/v1/companies",
  "/api/app/v1/companies/{companyId}/action-queue",
  "/api/app/v1/companies/{companyId}/consents",
  "/api/app/v1/companies/{companyId}/consents/{scope}",
  "/api/app/v1/companies/{companyId}/enrich",
  "/api/app/v1/companies/{companyId}/matches",
  "/api/app/v1/companies/{companyId}/next-question",
  "/api/app/v1/companies/{companyId}/profile",
  "/api/app/v1/companies/{companyId}/profile/field",
  "/api/app/v1/companies/{companyId}/profile/fields",
  "/api/app/v1/companies/{companyId}/roadmap",
  "/api/app/v1/companies/{companyId}/verify",
  "/api/app/v1/devices",
  "/api/app/v1/devices/{deviceId}",
  "/api/app/v1/grants/{grantId}",
  "/api/app/v1/matches/{companyId}/{grantId}/events",
  "/api/app/v1/matches/{companyId}/{grantId}/feedback",
  "/api/app/v1/notifications/settings",
  "/api/app/v1/openapi.json",
  "/api/app/v1/stats",
  "/api/app/v1/teaser",
] as const;

export const appV1OpenApi = {
  openapi: "3.1.0",
  info: {
    title: "Changup Note App API",
    version: "1.0.0",
    description:
      "Versioned mobile API contract owned by cunote-web. Flutter clients should generate code from this document.",
  },
  servers: [
    {
      url: "https://dev.changupnote.com",
      description: "Development tunnel",
    },
    {
      url: "http://127.0.0.1:4010",
      description: "Local development",
    },
  ],
  tags: [
    { name: "System" },
    { name: "Auth" },
    { name: "Discovery" },
    { name: "Companies" },
    { name: "Consents" },
    { name: "Grants" },
    { name: "Matches" },
    { name: "Devices" },
    { name: "Notifications" },
  ],
  paths: {
    "/api/app/v1/openapi.json": {
      get: {
        tags: ["System"],
        operationId: "getAppV1OpenApi",
        summary: "Fetch the app v1 OpenAPI contract.",
        responses: {
          "200": {
            description: "OpenAPI contract.",
            content: json({ type: "object", additionalProperties: true }),
          },
        },
      },
    },
    "/api/app/v1/stats": {
      get: {
        tags: ["Discovery"],
        operationId: "getAppStats",
        summary: "Fetch public grant aggregate statistics.",
        responses: {
          "200": {
            description: "Current public aggregate statistics.",
            content: json(ref("StatsEnvelope")),
          },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/teaser": {
      post: {
        tags: ["Discovery"],
        operationId: "createAppTeaser",
        summary: "Create an anonymous first-pass match teaser.",
        requestBody: {
          required: false,
          content: json(ref("TeaserRequest")),
        },
        responses: {
          "200": {
            description: "Anonymous teaser result.",
            content: json(ref("TeaserEnvelope")),
          },
          "400": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/auth/login": {
      post: {
        tags: ["Auth"],
        operationId: "loginAppUser",
        summary: "Exchange email credentials for app access and refresh tokens.",
        requestBody: {
          required: true,
          content: json(ref("LoginRequest")),
        },
        responses: {
          "200": {
            description: "Issued token pair.",
            content: json(ref("AppTokenEnvelope")),
          },
          "400": { $ref: "#/components/responses/AppError" },
          "501": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/auth/refresh": {
      post: {
        tags: ["Auth"],
        operationId: "refreshAppToken",
        summary: "Rotate a refresh token and issue a new app token pair.",
        requestBody: {
          required: true,
          content: json(ref("RefreshRequest")),
        },
        responses: {
          "200": {
            description: "Rotated token pair.",
            content: json(ref("AppTokenEnvelope")),
          },
          "400": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/auth/logout": {
      post: {
        tags: ["Auth"],
        operationId: "logoutAppUser",
        summary: "Revoke a refresh token or all tokens for the current device.",
        security: [{ appBearerAuth: [] }, {}],
        requestBody: {
          required: true,
          content: json(ref("LogoutRequest")),
        },
        responses: {
          "200": {
            description: "Revocation result.",
            content: json(ref("LogoutEnvelope")),
          },
          "400": { $ref: "#/components/responses/AppError" },
          "401": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/auth/{provider}": {
      post: {
        tags: ["Auth"],
        operationId: "exchangeAppOAuthCode",
        summary: "Exchange a native OAuth code for app tokens.",
        parameters: [pathParam("provider", "OAuth provider, for example google or kakao.")],
        requestBody: {
          required: true,
          content: json(ref("OAuthCodeExchangeRequest")),
        },
        responses: {
          "200": {
            description: "Issued token pair.",
            content: json(ref("AppTokenEnvelope")),
          },
          "400": { $ref: "#/components/responses/AppError" },
          "501": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/companies": {
      get: {
        tags: ["Companies"],
        operationId: "listAppCompanies",
        summary: "List companies available to the current app user.",
        security: bearerSecurity,
        responses: {
          "200": {
            description: "Company list.",
            content: json(ref("CompanyListEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
      post: {
        tags: ["Companies"],
        operationId: "createAppCompany",
        summary: "Create or save the current user's company profile.",
        security: bearerSecurity,
        requestBody: {
          required: false,
          content: json(ref("CreateCompanyRequest")),
        },
        responses: {
          "201": {
            description: "Created company.",
            content: json(ref("CompanyEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/companies/{companyId}/action-queue": {
      get: {
        tags: ["Matches"],
        operationId: "listAppCompanyActionQueue",
        summary: "Fetch ranked next actions for a company.",
        security: bearerSecurity,
        parameters: [pathParam("companyId", "Company id.")],
        responses: {
          "200": {
            description: "Ranked action queue.",
            content: json(ref("ActionQueueEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          "403": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/companies/{companyId}/profile": {
      get: {
        tags: ["Companies"],
        operationId: "getAppCompanyProfile",
        summary: "Fetch a company profile.",
        security: bearerSecurity,
        parameters: [pathParam("companyId", "Company id.")],
        responses: {
          "200": {
            description: "Company profile.",
            content: json(ref("CompanyProfileEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          "404": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/companies/{companyId}/enrich": {
      post: {
        tags: ["Companies"],
        operationId: "enrichAppCompany",
        summary: "Enrich a company profile from a business registration number.",
        security: bearerSecurity,
        parameters: [pathParam("companyId", "Company id.")],
        requestBody: {
          required: true,
          content: json(ref("CompanyEnrichmentRequest")),
        },
        responses: {
          "200": {
            description: "Enriched company profile and non-PII provider facts.",
            content: json(ref("CompanyEnrichmentEnvelope")),
          },
          "400": { $ref: "#/components/responses/AppError" },
          "401": { $ref: "#/components/responses/AppError" },
          "403": { $ref: "#/components/responses/AppError" },
          "404": { $ref: "#/components/responses/AppError" },
          "502": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/companies/{companyId}/verify": {
      post: {
        tags: ["Companies"],
        operationId: "verifyAppCompanyOwnership",
        summary: "Verify company ownership with business-registration facts.",
        security: bearerSecurity,
        parameters: [pathParam("companyId", "Company id.")],
        requestBody: {
          required: true,
          content: json(ref("CompanyVerificationRequest")),
        },
        responses: {
          "200": {
            description: "Verification result.",
            content: json(ref("CompanyVerificationEnvelope")),
          },
          "400": { $ref: "#/components/responses/AppError" },
          "401": { $ref: "#/components/responses/AppError" },
          "403": { $ref: "#/components/responses/AppError" },
          "501": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/companies/{companyId}/consents": {
      get: {
        tags: ["Consents"],
        operationId: "listAppCompanyConsents",
        summary: "List the current user's consent ledger entries for a company.",
        security: bearerSecurity,
        parameters: [pathParam("companyId", "Company id.")],
        responses: {
          "200": {
            description: "Consent list.",
            content: json(ref("ConsentListEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          "403": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
      put: {
        tags: ["Consents"],
        operationId: "grantAppCompanyConsent",
        summary: "Grant or refresh consent for a company data scope.",
        security: bearerSecurity,
        parameters: [pathParam("companyId", "Company id.")],
        requestBody: {
          required: true,
          content: json(ref("ConsentGrantRequest")),
        },
        responses: {
          "200": {
            description: "Stored consent.",
            content: json(ref("ConsentGrantEnvelope")),
          },
          "400": { $ref: "#/components/responses/AppError" },
          "401": { $ref: "#/components/responses/AppError" },
          "403": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/companies/{companyId}/consents/{scope}": {
      delete: {
        tags: ["Consents"],
        operationId: "revokeAppCompanyConsent",
        summary: "Revoke consent for a company data scope.",
        security: bearerSecurity,
        parameters: [
          pathParam("companyId", "Company id."),
          pathParam("scope", "Consent scope."),
        ],
        responses: {
          "200": {
            description: "Revocation result.",
            content: json(ref("ConsentRevokeEnvelope")),
          },
          "400": { $ref: "#/components/responses/AppError" },
          "401": { $ref: "#/components/responses/AppError" },
          "403": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/companies/{companyId}/profile/field": {
      post: {
        tags: ["Companies"],
        operationId: "updateAppCompanyProfileField",
        summary: "Persist a progressive profile-field answer.",
        security: bearerSecurity,
        parameters: [pathParam("companyId", "Company id.")],
        requestBody: {
          required: true,
          content: json(ref("ProfileFieldUpdateRequest")),
        },
        responses: {
          "200": {
            description: "Updated company profile.",
            content: json(ref("CompanyProfileEnvelope")),
          },
          "400": { $ref: "#/components/responses/AppError" },
          "401": { $ref: "#/components/responses/AppError" },
          "404": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/companies/{companyId}/profile/fields": {
      post: {
        tags: ["Companies"],
        operationId: "updateAppCompanyProfileFields",
        summary: "Persist a progressive profile-field answer.",
        description: "Plural path alias for mobile clients. The request currently updates one profile field per call.",
        security: bearerSecurity,
        parameters: [pathParam("companyId", "Company id.")],
        requestBody: {
          required: true,
          content: json(ref("ProfileFieldUpdateRequest")),
        },
        responses: {
          "200": {
            description: "Updated company profile.",
            content: json(ref("CompanyProfileEnvelope")),
          },
          "400": { $ref: "#/components/responses/AppError" },
          "401": { $ref: "#/components/responses/AppError" },
          "404": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/companies/{companyId}/matches": {
      get: {
        tags: ["Matches"],
        operationId: "listAppCompanyMatches",
        summary: "Fetch opportunity-map match cards for a company.",
        security: bearerSecurity,
        parameters: [
          pathParam("companyId", "Company id."),
          {
            name: "status",
            in: "query",
            required: false,
            description: "Optional eligibility or opportunity bucket filter.",
            schema: {
              type: "string",
              enum: ["all", "eligible", "conditional", "ineligible", "now", "soon", "preparable"],
            },
          },
          {
            name: "sort",
            in: "query",
            required: false,
            description: "Optional match sort order.",
            schema: {
              type: "string",
              enum: ["recommended", "fit", "deadline", "amount"],
            },
          },
          queryParam("cursor", "Opaque pagination cursor from the previous response meta."),
          {
            name: "limit",
            in: "query",
            required: false,
            description: "Page size, 1 through 40.",
            schema: { type: "integer", minimum: 1, maximum: 40 },
          },
        ],
        responses: {
          "200": {
            description: "Match cards and counts.",
            content: json(ref("CompanyMatchesEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/companies/{companyId}/next-question": {
      get: {
        tags: ["Matches"],
        operationId: "getAppCompanyNextQuestion",
        summary: "Fetch the highest-leverage progressive question.",
        security: bearerSecurity,
        parameters: [pathParam("companyId", "Company id.")],
        responses: {
          "200": {
            description: "Next question, or null when none is useful.",
            content: json(ref("NextQuestionEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/companies/{companyId}/roadmap": {
      get: {
        tags: ["Matches"],
        operationId: "listAppCompanyRoadmap",
        summary: "Fetch future opportunity roadmap nodes.",
        security: bearerSecurity,
        parameters: [pathParam("companyId", "Company id.")],
        responses: {
          "200": {
            description: "Roadmap nodes.",
            content: json(ref("RoadmapEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/grants/{grantId}": {
      get: {
        tags: ["Grants"],
        operationId: "getAppGrantApplySheet",
        summary: "Fetch an application-prep sheet for a grant.",
        security: bearerSecurity,
        parameters: [
          pathParam("grantId", "Grant id."),
          queryParam("companyId", "Optional company id. When omitted, the first accessible company is used."),
        ],
        responses: {
          "200": {
            description: "Application-prep sheet.",
            content: json(ref("ApplySheetEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          "404": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/matches/{companyId}/{grantId}/feedback": {
      post: {
        tags: ["Matches"],
        operationId: "submitAppMatchFeedback",
        summary: "Save user feedback for a grant match.",
        security: bearerSecurity,
        parameters: [
          pathParam("companyId", "Company id."),
          pathParam("grantId", "Grant id."),
        ],
        requestBody: {
          required: false,
          content: json(ref("MatchFeedbackRequest")),
        },
        responses: {
          "202": {
            description: "Feedback accepted.",
            content: json(ref("FeedbackEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/matches/{companyId}/{grantId}/events": {
      post: {
        tags: ["Matches"],
        operationId: "recordAppMatchEvent",
        summary: "Record an app interaction with a grant match.",
        security: bearerSecurity,
        parameters: [
          pathParam("companyId", "Company id."),
          pathParam("grantId", "Grant id."),
        ],
        requestBody: {
          required: false,
          content: json(ref("MatchEventRequest")),
        },
        responses: {
          "202": {
            description: "Event accepted.",
            content: json(ref("MatchEventEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/notifications/settings": {
      get: {
        tags: ["Notifications"],
        operationId: "getAppNotificationSettings",
        summary: "Fetch notification settings.",
        security: bearerSecurity,
        responses: {
          "200": {
            description: "Notification settings.",
            content: json(ref("NotificationSettingsEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
      put: {
        tags: ["Notifications"],
        operationId: "updateAppNotificationSettings",
        summary: "Update notification settings.",
        security: bearerSecurity,
        requestBody: {
          required: true,
          content: json(ref("NotificationSettings")),
        },
        responses: {
          "200": {
            description: "Notification settings.",
            content: json(ref("NotificationSettingsEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/devices": {
      post: {
        tags: ["Devices"],
        operationId: "registerAppDevice",
        summary: "Register the current mobile device for push delivery.",
        security: bearerSecurity,
        requestBody: {
          required: true,
          content: json(ref("DeviceRegistrationRequest")),
        },
        responses: {
          "201": {
            description: "Registered device.",
            content: json(ref("DeviceEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
    "/api/app/v1/devices/{deviceId}": {
      delete: {
        tags: ["Devices"],
        operationId: "deleteAppDevice",
        summary: "Delete a registered mobile device.",
        security: bearerSecurity,
        parameters: [pathParam("deviceId", "Device id.")],
        responses: {
          "200": {
            description: "Deleted device.",
            content: json(ref("DeleteDeviceEnvelope")),
          },
          "401": { $ref: "#/components/responses/AppError" },
          default: { $ref: "#/components/responses/AppError" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      appBearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
    responses: {
      AppError: {
        description: "App API error envelope.",
        content: json(envelope(nullable({ type: "object", additionalProperties: true }))),
      },
    },
    schemas: {
      ApiError: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          field: { type: "string" },
        },
        additionalProperties: false,
      },
      ApiMeta: {
        type: "object",
        properties: {
          cursor: nullable({ type: "string" }),
          hasMore: { type: "boolean" },
          rulesetVer: { type: "string" },
          scoringVer: { type: "string" },
        },
        additionalProperties: false,
      },
      StatsResult: {
        type: "object",
        required: ["openCount", "totalAmount", "deadlineSoonCount", "updatedAt"],
        properties: {
          openCount: { type: "integer", minimum: 0 },
          totalAmount: { type: "integer", minimum: 0 },
          deadlineSoonCount: { type: "integer", minimum: 0 },
          updatedAt: { type: "string", format: "date-time" },
        },
        additionalProperties: false,
      },
      StatsEnvelope: envelope(ref("StatsResult")),
      TeaserRequest: {
        type: "object",
        properties: {
          bizNo: { type: "string" },
          profile: ref("CompanyProfile"),
        },
        additionalProperties: false,
      },
      TeaserResult: {
        type: "object",
        required: [
          "attributes",
          "estimatedMaxAmount",
          "conditionalUpside",
          "counts",
          "matches",
          "privacyNote",
        ],
        properties: {
          attributes: ref("TeaserAttributes"),
          estimatedMaxAmount: { type: "integer", minimum: 0 },
          conditionalUpside: { type: "integer", minimum: 0 },
          counts: ref("EligibilityCounts"),
          matches: arrayOf(ref("MatchCard")),
          privacyNote: { type: "string" },
        },
        additionalProperties: false,
      },
      TeaserEnvelope: envelope(ref("TeaserResult")),
      TeaserAttributes: {
        type: "object",
        required: ["region", "size", "bizAgeMonths", "industry"],
        properties: {
          region: nullable({ type: "string" }),
          size: nullable({ type: "string" }),
          bizAgeMonths: nullable({ type: "integer", minimum: 0 }),
          industry: arrayOf({ type: "string" }),
        },
        additionalProperties: false,
      },
      EligibilityCounts: {
        type: "object",
        required: ["eligible", "conditional", "ineligible", "deadlineSoon"],
        properties: {
          eligible: { type: "integer", minimum: 0 },
          conditional: { type: "integer", minimum: 0 },
          ineligible: { type: "integer", minimum: 0 },
          deadlineSoon: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      SupportAmount: {
        type: "object",
        required: ["unit", "per"],
        properties: {
          min: nullable({ type: "integer", minimum: 0 }),
          max: nullable({ type: "integer", minimum: 0 }),
          unit: { type: "string", enum: ["KRW"] },
          per: { type: "string", enum: ["기업", "건"] },
          label: nullable({ type: "string" }),
        },
        additionalProperties: false,
      },
      MatchCard: {
        type: "object",
        required: [
          "grantId",
          "source",
          "sourceId",
          "title",
          "agency",
          "status",
          "eligibility",
          "bucket",
          "fitScore",
          "supportAmount",
          "applyEnd",
          "dDay",
          "ruleTrace",
          "matchConfidence",
          "rulesetVer",
          "scoringVer",
        ],
        properties: {
          grantId: { type: "string" },
          source: { type: "string", enum: ["kstartup", "bizinfo", "bizinfo_event"] },
          sourceId: { type: "string" },
          title: { type: "string" },
          agency: nullable({ type: "string" }),
          status: { type: "string", enum: ["upcoming", "open", "closed", "unknown"] },
          eligibility: { type: "string", enum: ["eligible", "conditional", "ineligible"] },
          bucket: { type: "string", enum: ["now", "soon", "preparable", "conditional"] },
          fitScore: { type: "number", minimum: 0, maximum: 100 },
          competitiveness: ref("EstimatedNumber"),
          value: { type: "integer", minimum: 0 },
          supportAmount: ref("SupportAmount"),
          applyEnd: nullable({ type: "string", format: "date" }),
          dDay: nullable({ type: "integer" }),
          ruleTrace: arrayOf(ref("RuleTraceChip")),
          matchConfidence: { type: "number", minimum: 0, maximum: 1 },
          rulesetVer: { type: "string" },
          scoringVer: { type: "string" },
          detailUrl: nullable({ type: "string" }),
        },
        additionalProperties: false,
      },
      EstimatedNumber: {
        type: "object",
        required: ["value", "estimated"],
        properties: {
          value: { type: "number" },
          estimated: { type: "boolean", const: true },
        },
        additionalProperties: false,
      },
      RuleTraceChip: {
        type: "object",
        required: ["dimension", "kind", "result", "label", "checklistSection"],
        properties: {
          dimension: {
            type: "string",
            enum: [
              "region",
              "biz_age",
              "industry",
              "size",
              "revenue",
              "employees",
              "founder_age",
              "founder_trait",
              "certification",
              "prior_award",
              "ip",
              "target_type",
              "business_status",
              "other",
            ],
          },
          kind: { type: "string", enum: ["required", "preferred", "exclusion"] },
          result: { type: "string", enum: ["pass", "fail", "unknown", "text_only"] },
          label: { type: "string" },
          companyValue: { type: "string" },
          sourceSpan: { type: "string" },
          checklistSection: {
            type: "string",
            enum: ["satisfied", "needs_check", "document", "preferred_miss"],
          },
          action: ref("RuleTraceAction"),
          unlock: ref("RuleTraceUnlock"),
        },
        additionalProperties: false,
      },
      RuleTraceAction: {
        type: "object",
        required: ["type", "target", "label"],
        properties: {
          type: {
            type: "string",
            enum: ["progressive", "external_link", "apply", "prepare", "verify"],
          },
          target: { type: "string" },
          label: { type: "string" },
        },
        additionalProperties: false,
      },
      RuleTraceUnlock: {
        type: "object",
        required: ["kind", "detail"],
        properties: {
          kind: { type: "string", enum: ["time", "attribute"] },
          detail: { type: "string" },
          etaDate: { type: "string", format: "date" },
        },
        additionalProperties: false,
      },
      RoadmapNode: {
        type: "object",
        required: ["bucket", "grantId", "title"],
        properties: {
          bucket: { type: "string", enum: ["now", "soon", "preparable", "conditional"] },
          grantId: { type: "string" },
          title: { type: "string" },
          unlock: ref("RoadmapUnlock"),
          deltaCount: { type: "integer" },
        },
        additionalProperties: false,
      },
      RoadmapUnlock: {
        type: "object",
        required: ["dimension", "kind", "detail"],
        properties: {
          dimension: { type: "string" },
          kind: { type: "string", enum: ["time", "attribute"] },
          detail: { type: "string" },
          etaDate: { type: "string", format: "date" },
        },
        additionalProperties: false,
      },
      NextQuestion: {
        type: "object",
        required: ["dimension", "prompt", "inputType", "framing", "affectedGrantCount"],
        properties: {
          dimension: { type: "string" },
          prompt: { type: "string" },
          inputType: { type: "string", enum: ["number", "select", "boolean", "text"] },
          options: arrayOf({ type: "string" }),
          framing: { type: "string" },
          affectedGrantCount: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      ActionQueueItem: {
        type: "object",
        required: [
          "id",
          "kind",
          "title",
          "reason",
          "ctaLabel",
          "target",
          "affectedGrantIds",
          "affectedGrantCount",
          "leverageAmount",
          "urgency",
          "effort",
          "score",
        ],
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["input", "acquire", "apply", "enrich", "review"] },
          title: { type: "string" },
          reason: { type: "string" },
          ctaLabel: { type: "string" },
          target: { type: "string" },
          affectedGrantIds: arrayOf({ type: "string" }),
          affectedGrantCount: { type: "integer", minimum: 0 },
          leverageAmount: { type: "integer", minimum: 0 },
          urgency: { type: "string", enum: ["low", "medium", "high"] },
          effort: { type: "string", enum: ["quick", "medium", "long"] },
          score: { type: "number" },
        },
        additionalProperties: false,
      },
      ActionQueueResult: {
        type: "object",
        required: ["actions"],
        properties: {
          actions: arrayOf(ref("ActionQueueItem")),
        },
        additionalProperties: false,
      },
      GrantDetail: {
        type: "object",
        required: ["id", "source", "sourceId", "title", "agency", "supportAmount", "status"],
        properties: {
          id: { type: "string" },
          source: { type: "string", enum: ["kstartup", "bizinfo", "bizinfo_event"] },
          sourceId: { type: "string" },
          title: { type: "string" },
          agency: nullable({ type: "string" }),
          supportAmount: ref("SupportAmount"),
          status: { type: "string", enum: ["upcoming", "open", "closed", "unknown"] },
        },
        additionalProperties: false,
      },
      RequiredDocument: {
        type: "object",
        required: ["name", "required", "source"],
        properties: {
          name: { type: "string" },
          required: { type: "boolean" },
          source: { type: "string", enum: ["self", "portal", "cert"] },
          alreadyHave: { type: "boolean" },
          fromTextOnly: { type: "boolean" },
          sourceSpan: { type: "string" },
          note: { type: "string" },
        },
        additionalProperties: false,
      },
      ProfileCopyField: {
        type: "object",
        required: ["label", "value", "source"],
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          source: { type: "string", enum: ["company_profile", "grant_context"] },
        },
        additionalProperties: false,
      },
      PlanDraftPrompt: {
        type: "object",
        required: ["title", "prompt", "evidence"],
        properties: {
          title: { type: "string" },
          prompt: { type: "string" },
          evidence: arrayOf({ type: "string" }),
        },
        additionalProperties: false,
      },
      ApplicationPrep: {
        type: "object",
        required: ["autoSubmitSupported", "profileCopyFields", "planDraftPrompts"],
        properties: {
          autoSubmitSupported: { type: "boolean", const: false },
          profileCopyFields: arrayOf(ref("ProfileCopyField")),
          planDraftPrompts: arrayOf(ref("PlanDraftPrompt")),
        },
        additionalProperties: false,
      },
      ApplySheet: {
        type: "object",
        required: [
          "grant",
          "satisfied",
          "needsCheck",
          "documents",
          "applicationPrep",
          "applyMethod",
          "deepLink",
          "schedule",
        ],
        properties: {
          grant: ref("GrantDetail"),
          satisfied: arrayOf(ref("RuleTraceChip")),
          needsCheck: arrayOf(ref("RuleTraceChip")),
          documents: arrayOf(ref("RequiredDocument")),
          applicationPrep: ref("ApplicationPrep"),
          applyMethod: nullable({ type: "string" }),
          deepLink: nullable({ type: "string" }),
          schedule: ref("ApplySchedule"),
        },
        additionalProperties: false,
      },
      ApplySchedule: {
        type: "object",
        required: ["applyStart", "applyEnd", "dDay"],
        properties: {
          applyStart: nullable({ type: "string", format: "date" }),
          applyEnd: nullable({ type: "string", format: "date" }),
          dDay: nullable({ type: "integer" }),
        },
        additionalProperties: false,
      },
      CompanyProfile: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          region: ref("CompanyRegion"),
          biz_age_months: nullable({ type: "integer", minimum: 0 }),
          founder_age: nullable({ type: "integer", minimum: 0 }),
          is_preliminary: { type: "boolean" },
          industries: arrayOf({ type: "string" }),
          size: nullable({ type: "string" }),
          revenue_krw: nullable({ type: "number", minimum: 0 }),
          employees_count: nullable({ type: "integer", minimum: 0 }),
          traits: arrayOf({ type: "string" }),
          certs: arrayOf({ type: "string" }),
          prior_awards: arrayOf({ type: "string" }),
          ip: arrayOf({ type: "string" }),
          target_types: arrayOf({ type: "string" }),
          other_conditions: nullable({ type: "object", additionalProperties: true }),
          business_status: { type: "object", additionalProperties: true },
          confidence: { type: "object", additionalProperties: { type: "number" } },
        },
        additionalProperties: true,
      },
      CompanyRegion: {
        type: "object",
        required: ["code"],
        properties: {
          code: { type: "string" },
          label: { type: "string" },
        },
        additionalProperties: false,
      },
      CompanyEnrichmentRequest: {
        type: "object",
        required: ["bizNo"],
        properties: {
          bizNo: { type: "string", minLength: 10 },
        },
        additionalProperties: false,
      },
      CompanyVerificationRequest: {
        type: "object",
        required: ["bizNo"],
        properties: {
          bizNo: { type: "string", minLength: 10 },
          ownerName: { type: "string" },
          openedOn: { type: "string", format: "date" },
        },
        additionalProperties: false,
      },
      CompanyVerificationResult: {
        type: "object",
        required: ["companyId", "bizNoMasked", "verified", "verifiedAt", "verifyMethod"],
        properties: {
          companyId: { type: "string" },
          bizNoMasked: { type: "string" },
          verified: { type: "boolean" },
          verifiedAt: { type: "string", format: "date-time" },
          verifyMethod: { type: "string" },
        },
        additionalProperties: false,
      },
      CompanyVerificationEnvelope: envelope(ref("CompanyVerificationResult")),
      CompanyEnrichmentFacts: {
        type: "object",
        required: [
          "maskedBizNo",
          "result",
          "resultMessage",
          "checkedAt",
          "hasCorpName",
          "hasRegion",
          "hasBizAge",
          "hasSize",
          "hasIndustry",
          "closeDownState",
          "closeDownTaxType",
        ],
        properties: {
          maskedBizNo: nullable({ type: "string" }),
          result: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
          resultMessage: nullable({ type: "string" }),
          checkedAt: nullable({ type: "string" }),
          hasCorpName: { type: "boolean" },
          hasRegion: { type: "boolean" },
          hasBizAge: { type: "boolean" },
          hasSize: { type: "boolean" },
          hasIndustry: { type: "boolean" },
          closeDownState: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
          closeDownTaxType: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
        },
        additionalProperties: false,
      },
      CompanyEnrichmentResult: {
        type: "object",
        required: ["profile", "facts"],
        properties: {
          profile: ref("CompanyProfile"),
          facts: ref("CompanyEnrichmentFacts"),
        },
        additionalProperties: false,
      },
      CompanyRecord: {
        type: "object",
        required: ["id", "name", "profile"],
        properties: {
          id: { type: "string" },
          name: nullable({ type: "string" }),
          profile: ref("CompanyProfile"),
          role: { type: "string", enum: ["owner", "admin", "member", "viewer"] },
          verified: { type: "boolean" },
          verifiedAt: nullable({ type: "string", format: "date-time" }),
          verifyMethod: nullable({ type: "string" }),
          bizNoMasked: nullable({ type: "string" }),
        },
        additionalProperties: false,
      },
      CreateCompanyRequest: {
        type: "object",
        required: ["profile"],
        properties: {
          profile: ref("CompanyProfile"),
        },
        additionalProperties: false,
      },
      ProfileFieldUpdateRequest: {
        type: "object",
        required: ["field", "value"],
        properties: {
          field: {
            type: "string",
            enum: [
              "region",
              "biz_age",
              "industry",
              "size",
              "revenue",
              "employees",
              "founder_age",
              "founder_trait",
              "certification",
              "prior_award",
              "ip",
              "target_type",
              "business_status",
              "other",
            ],
          },
          value: {
            description: "Field-specific JSON value.",
          },
          confidence: nullable({ type: "number", minimum: 0, maximum: 1 }),
        },
        additionalProperties: false,
      },
      CompanyListResult: {
        type: "object",
        required: ["companies"],
        properties: {
          companies: arrayOf(ref("CompanyRecord")),
        },
        additionalProperties: false,
      },
      CompanyResult: {
        type: "object",
        required: ["company"],
        properties: {
          company: ref("CompanyRecord"),
        },
        additionalProperties: false,
      },
      CompanyProfileResult: {
        type: "object",
        required: ["profile"],
        properties: {
          profile: ref("CompanyProfile"),
        },
        additionalProperties: false,
      },
      CompanyMatchesResult: {
        type: "object",
        required: ["counts", "matches"],
        properties: {
          counts: ref("EligibilityCounts"),
          matches: arrayOf(ref("MatchCard")),
        },
        additionalProperties: false,
      },
      RoadmapResult: {
        type: "object",
        required: ["roadmap"],
        properties: {
          roadmap: arrayOf(ref("RoadmapNode")),
        },
        additionalProperties: false,
      },
      LoginRequest: {
        type: "object",
        required: ["email"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", format: "password" },
          deviceId: { type: "string" },
        },
        additionalProperties: false,
      },
      OAuthCodeExchangeRequest: {
        type: "object",
        required: ["code"],
        properties: {
          code: { type: "string" },
          codeVerifier: { type: "string" },
          redirectUri: { type: "string" },
          deviceId: { type: "string" },
        },
        additionalProperties: false,
      },
      RefreshRequest: {
        type: "object",
        required: ["refreshToken"],
        properties: {
          refreshToken: { type: "string" },
        },
        additionalProperties: false,
      },
      LogoutRequest: {
        type: "object",
        properties: {
          refreshToken: { type: "string" },
          allForDevice: { type: "boolean" },
        },
        additionalProperties: false,
      },
      AppTokenResponse: {
        type: "object",
        required: [
          "tokenType",
          "accessToken",
          "refreshToken",
          "expiresIn",
          "refreshExpiresAt",
          "deviceId",
          "user",
        ],
        properties: {
          tokenType: { type: "string", enum: ["Bearer"] },
          accessToken: { type: "string" },
          refreshToken: { type: "string" },
          expiresIn: { type: "integer", minimum: 0 },
          refreshExpiresAt: { type: "string", format: "date-time" },
          deviceId: { type: "string" },
          user: ref("AppTokenUser"),
        },
        additionalProperties: false,
      },
      AppTokenUser: {
        type: "object",
        required: ["id", "email"],
        properties: {
          id: { type: "string" },
          email: nullable({ type: "string", format: "email" }),
        },
        additionalProperties: false,
      },
      LogoutResult: {
        type: "object",
        required: ["revoked"],
        properties: {
          revoked: { type: "boolean" },
        },
        additionalProperties: false,
      },
      MatchFeedbackRequest: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["saved", "dismissed", "wrong", "applied", "note"] },
          message: nullable({ type: "string" }),
        },
        additionalProperties: false,
      },
      FeedbackReceipt: {
        type: "object",
        required: ["id", "receivedAt"],
        properties: {
          id: { type: "string" },
          receivedAt: { type: "string", format: "date-time" },
        },
        additionalProperties: false,
      },
      FeedbackResult: {
        type: "object",
        required: ["receipt"],
        properties: {
          receipt: ref("FeedbackReceipt"),
        },
        additionalProperties: false,
      },
      MatchEventRequest: {
        type: "object",
        properties: {
          event: { type: "string", enum: ["surfaced", "clicked", "saved", "apply_click"] },
          type: {
            type: "string",
            enum: ["surfaced", "clicked", "saved", "apply_click"],
            deprecated: true,
          },
          rulesetVer: { type: "string" },
          payload: { type: "object", additionalProperties: true },
        },
        additionalProperties: false,
      },
      MatchEventResult: {
        type: "object",
        required: ["accepted", "companyId", "grantId", "event", "receipt"],
        properties: {
          accepted: { type: "boolean" },
          companyId: { type: "string" },
          grantId: { type: "string" },
          event: { type: "string", enum: ["surfaced", "clicked", "saved", "apply_click"] },
          receipt: ref("MatchEventReceipt"),
        },
        additionalProperties: false,
      },
      MatchEventReceipt: {
        type: "object",
        required: ["id", "acceptedAt"],
        properties: {
          id: { type: "string" },
          acceptedAt: { type: "string", format: "date-time" },
        },
        additionalProperties: false,
      },
      ConsentRecord: {
        type: "object",
        required: ["scope", "purpose", "grantedAt", "revokedAt"],
        properties: {
          scope: { type: "string", enum: ["basic_info", "hometax", "insurance"] },
          purpose: { type: "string" },
          grantedAt: { type: "string", format: "date-time" },
          revokedAt: nullable({ type: "string", format: "date-time" }),
        },
        additionalProperties: false,
      },
      ConsentListResult: {
        type: "object",
        required: ["companyId", "consents"],
        properties: {
          companyId: { type: "string" },
          consents: arrayOf(ref("ConsentRecord")),
        },
        additionalProperties: false,
      },
      ConsentGrantRequest: {
        type: "object",
        required: ["scope"],
        properties: {
          scope: { type: "string", enum: ["basic_info", "hometax", "insurance"] },
          purpose: { type: "string" },
        },
        additionalProperties: false,
      },
      ConsentGrantResult: {
        type: "object",
        required: ["consent"],
        properties: {
          consent: ref("ConsentRecord"),
        },
        additionalProperties: false,
      },
      ConsentRevokeResult: {
        type: "object",
        required: ["scope", "revoked"],
        properties: {
          scope: { type: "string", enum: ["basic_info", "hometax", "insurance"] },
          revoked: { type: "boolean" },
        },
        additionalProperties: false,
      },
      NotificationSettings: {
        type: "object",
        required: ["deadlineReminder", "newMatch", "quietHoursStart", "quietHoursEnd"],
        properties: {
          deadlineReminder: { type: "boolean" },
          newMatch: { type: "boolean" },
          quietHoursStart: nullable({ type: "string" }),
          quietHoursEnd: nullable({ type: "string" }),
        },
        additionalProperties: false,
      },
      DeviceRegistrationRequest: {
        type: "object",
        required: ["deviceId", "platform", "pushToken"],
        properties: {
          deviceId: { type: "string" },
          platform: { type: "string", enum: ["ios", "android"] },
          pushToken: { type: "string" },
        },
        additionalProperties: false,
      },
      DeviceResult: {
        type: "object",
        required: ["deviceId", "platform", "registered"],
        properties: {
          deviceId: { type: "string" },
          platform: { type: "string", enum: ["ios", "android"] },
          registered: { type: "boolean" },
        },
        additionalProperties: false,
      },
      DeleteDeviceResult: {
        type: "object",
        required: ["deleted"],
        properties: {
          deleted: { type: "boolean" },
        },
        additionalProperties: false,
      },
      AppTokenEnvelope: envelope(ref("AppTokenResponse")),
      LogoutEnvelope: envelope(ref("LogoutResult")),
      CompanyListEnvelope: envelope(ref("CompanyListResult")),
      CompanyEnvelope: envelope(ref("CompanyResult")),
      CompanyProfileEnvelope: envelope(ref("CompanyProfileResult")),
      CompanyEnrichmentEnvelope: envelope(ref("CompanyEnrichmentResult")),
      CompanyMatchesEnvelope: envelope(ref("CompanyMatchesResult")),
      ActionQueueEnvelope: envelope(ref("ActionQueueResult")),
      NextQuestionEnvelope: envelope(nullable(ref("NextQuestion"))),
      RoadmapEnvelope: envelope(ref("RoadmapResult")),
      ApplySheetEnvelope: envelope(ref("ApplySheet")),
      FeedbackEnvelope: envelope(ref("FeedbackResult")),
      MatchEventEnvelope: envelope(ref("MatchEventResult")),
      ConsentListEnvelope: envelope(ref("ConsentListResult")),
      ConsentGrantEnvelope: envelope(ref("ConsentGrantResult")),
      ConsentRevokeEnvelope: envelope(ref("ConsentRevokeResult")),
      NotificationSettingsEnvelope: envelope(ref("NotificationSettings")),
      DeviceEnvelope: envelope(ref("DeviceResult")),
      DeleteDeviceEnvelope: envelope(ref("DeleteDeviceResult")),
    },
  },
} as const;

export type AppV1OpenApi = typeof appV1OpenApi;
export type AppV1OpenApiRoutePath = (typeof appV1OpenApiRoutePaths)[number];
