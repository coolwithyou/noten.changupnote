import { appData, appError, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { getAppPreferencesStore, type DeviceRegistrationInput } from "@/lib/server/appApi/preferencesStore";
import { requireAppSession } from "@/lib/server/auth/appSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const [session, body] = await Promise.all([requireAppSession(request), readBody(request)]);
    const parsed = parseDeviceRegistration(body);
    if (!parsed.ok) return appError("invalid_device_request", parsed.message, 400, parsed.field);
    const device = await getAppPreferencesStore().registerDevice(session.user.id, parsed.data);
    return appData(device, { status: 201 });
  } catch (error) {
    return appErrorFromUnknown(error, "기기를 등록하지 못했습니다.");
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json() as Record<string, unknown>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseDeviceRegistration(body: Record<string, unknown>):
  | { ok: true; data: DeviceRegistrationInput }
  | { ok: false; message: string; field: string } {
  if (typeof body.deviceId !== "string" || !body.deviceId.trim()) {
    return { ok: false, message: "deviceId가 필요합니다.", field: "deviceId" };
  }
  if (body.platform !== "ios" && body.platform !== "android") {
    return { ok: false, message: "platform은 ios 또는 android여야 합니다.", field: "platform" };
  }
  if (typeof body.pushToken !== "string" || !body.pushToken.trim()) {
    return { ok: false, message: "pushToken이 필요합니다.", field: "pushToken" };
  }
  return {
    ok: true,
    data: {
      deviceId: body.deviceId.trim(),
      platform: body.platform,
      pushToken: body.pushToken.trim(),
    },
  };
}
