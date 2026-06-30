export type OutboundEmailProvider = "none" | "webhook";
export type OutboundEmailDeliveryStatus = "skipped" | "delivered" | "failed";

export interface OutboundEmailAddress {
  email: string;
  name?: string;
}

export interface OutboundEmailMessage {
  to: OutboundEmailAddress;
  from: OutboundEmailAddress;
  replyTo?: OutboundEmailAddress;
  subject: string;
  text: string;
  tags?: string[];
}

export interface OutboundEmailProviderStatus {
  provider: OutboundEmailProvider;
  configured: boolean;
}

export interface OutboundEmailDeliveryResult extends OutboundEmailProviderStatus {
  status: OutboundEmailDeliveryStatus;
  statusCode?: number;
}

export class OutboundEmailError extends Error {
  constructor(
    message: string,
    readonly result: OutboundEmailDeliveryResult,
  ) {
    super(message);
    this.name = "OutboundEmailError";
  }
}

export function getOutboundEmailProviderStatus(env: NodeJS.ProcessEnv = process.env): OutboundEmailProviderStatus {
  const configured = Boolean(env.CUNOTE_EMAIL_WEBHOOK_URL?.trim());
  return {
    provider: configured ? "webhook" : "none",
    configured,
  };
}

export async function sendOutboundEmail(input: {
  message: OutboundEmailMessage;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<OutboundEmailDeliveryResult> {
  const env = input.env ?? process.env;
  const provider = getOutboundEmailProviderStatus(env);
  if (!provider.configured) {
    return { ...provider, status: "skipped" };
  }

  const endpoint = env.CUNOTE_EMAIL_WEBHOOK_URL?.trim();
  if (!endpoint) return { ...provider, status: "skipped" };

  const response = await (input.fetchImpl ?? fetch)(endpoint, {
    method: "POST",
    headers: deliveryHeaders(env),
    body: JSON.stringify({
      schema: "cunote.outbound_email.v1",
      message: input.message,
    }),
  });

  const result: OutboundEmailDeliveryResult = {
    ...provider,
    status: response.ok ? "delivered" : "failed",
    statusCode: response.status,
  };
  if (!response.ok) {
    throw new OutboundEmailError(`Outbound email webhook failed with ${response.status}`, result);
  }
  return result;
}

function deliveryHeaders(env: NodeJS.ProcessEnv): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-cunote-message-kind": "outbound-email",
  };
  const secret = env.CUNOTE_EMAIL_WEBHOOK_SECRET?.trim();
  if (secret) headers.authorization = `Bearer ${secret}`;
  return headers;
}
