import { getOptionalWebSession } from "./session";

export interface AdminAccess {
  userId: string;
  role: "admin";
  mode: "demo" | "session";
}

export class AdminAccessError extends Error {
  readonly status = 403;
  readonly code = "admin_forbidden";

  constructor(message = "어드민 접근 권한이 필요합니다.") {
    super(message);
    this.name = "AdminAccessError";
  }
}

export async function getOptionalAdminAccess(): Promise<AdminAccess | null> {
  if (process.env.CUNOTE_ADMIN_MODE === "demo") {
    return {
      userId: "demo-admin",
      role: "admin",
      mode: "demo",
    };
  }

  const session = await getOptionalWebSession();
  if (!session) return null;

  const allowedUsers = splitEnv(process.env.CUNOTE_ADMIN_USER_IDS);
  const allowedEmails = splitEnv(process.env.CUNOTE_ADMIN_EMAILS);
  const email = session.user.email ?? "";
  if (allowedUsers.includes(session.user.id) || allowedEmails.includes(email)) {
    return {
      userId: session.user.id,
      role: "admin",
      mode: "session",
    };
  }

  return null;
}

export async function requireAdminAccess(): Promise<AdminAccess> {
  const access = await getOptionalAdminAccess();
  if (access) return access;
  throw new AdminAccessError();
}

function splitEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
