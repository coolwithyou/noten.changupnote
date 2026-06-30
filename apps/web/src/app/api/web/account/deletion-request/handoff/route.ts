import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  accountDeletionEmailHandoffDownloadResponse,
  buildAccountDeletionEmailHandoff,
} from "@/lib/server/account/accountDeletionEmailHandoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [access, session] = await Promise.all([
      requireCompanyAccess(),
      getOptionalWebSession(),
    ]);
    const handoff = buildAccountDeletionEmailHandoff({ access, session });
    return accountDeletionEmailHandoffDownloadResponse(handoff);
  } catch (error) {
    return webActionError<null>(error, {
      code: "account_deletion_email_handoff_failed",
      message: "계정 삭제 요청 메일 파일을 만들지 못했습니다.",
    });
  }
}
