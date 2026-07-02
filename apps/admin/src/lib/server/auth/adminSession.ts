import { getServerSession } from "next-auth";
import { adminAuthOptions } from "./adminOptions";
import { findAdminUserById, type AdminRole } from "./adminUsers";

export interface AdminSession {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: AdminRole;
  };
  provider: "admin-nextauth";
}

export class AdminRequiredError extends Error {
  readonly status = 401;
  readonly code = "admin_auth_required";

  constructor(message = "어드민 로그인이 필요합니다.") {
    super(message);
    this.name = "AdminRequiredError";
  }
}

export async function getOptionalAdminSession(): Promise<AdminSession | null> {
  const session = await getServerSession(adminAuthOptions);
  if (!session?.user) return null;
  const user = session.user as typeof session.user & { id?: string; role?: AdminRole };
  if (!user?.id || !user.role) return null;

  const current = await findAdminUserById(user.id);
  if (!current || current.status !== "active") return null;

  return {
    user: {
      id: current.id,
      email: current.email,
      name: current.name,
      role: current.role,
    },
    provider: "admin-nextauth",
  };
}

export async function requireAdminSession(): Promise<AdminSession> {
  const session = await getOptionalAdminSession();
  if (session) return session;
  throw new AdminRequiredError();
}
