import { POST as postProfileField } from "../field/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  return postProfileField(request, context);
}
