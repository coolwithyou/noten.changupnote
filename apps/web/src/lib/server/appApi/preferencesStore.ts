import { and, eq } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

export interface NotificationSettingsDto {
  deadlineReminder: boolean;
  newMatch: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}

export interface DeviceRegistrationInput {
  deviceId: string;
  platform: "ios" | "android";
  pushToken: string;
}

export interface DeviceRegistrationResult {
  deviceId: string;
  platform: "ios" | "android";
  registered: boolean;
}

export interface AppPreferencesStore {
  getNotificationSettings(userId: string): Promise<NotificationSettingsDto>;
  updateNotificationSettings(
    userId: string,
    input: Partial<NotificationSettingsDto>,
  ): Promise<NotificationSettingsDto>;
  registerDevice(userId: string, input: DeviceRegistrationInput): Promise<DeviceRegistrationResult>;
  deleteDevice(userId: string, deviceId: string): Promise<boolean>;
}

const DEFAULT_SETTINGS: NotificationSettingsDto = {
  deadlineReminder: true,
  newMatch: true,
  quietHoursStart: null,
  quietHoursEnd: null,
};

const memorySettings = new Map<string, NotificationSettingsDto>();
const memoryDevices = new Map<string, DeviceRegistrationResult>();

export function getAppPreferencesStore(): AppPreferencesStore {
  if (process.env.CUNOTE_REPOSITORY_ADAPTER === "drizzle") return new DrizzleAppPreferencesStore();
  return new MemoryAppPreferencesStore();
}

class MemoryAppPreferencesStore implements AppPreferencesStore {
  async getNotificationSettings(userId: string): Promise<NotificationSettingsDto> {
    return memorySettings.get(userId) ?? DEFAULT_SETTINGS;
  }

  async updateNotificationSettings(
    userId: string,
    input: Partial<NotificationSettingsDto>,
  ): Promise<NotificationSettingsDto> {
    const next = {
      ...(memorySettings.get(userId) ?? DEFAULT_SETTINGS),
      ...normalizeSettingsPatch(input),
    };
    memorySettings.set(userId, next);
    return next;
  }

  async registerDevice(
    userId: string,
    input: DeviceRegistrationInput,
  ): Promise<DeviceRegistrationResult> {
    const result: DeviceRegistrationResult = {
      deviceId: input.deviceId,
      platform: input.platform,
      registered: true,
    };
    memoryDevices.set(deviceKey(userId, input.deviceId), result);
    return result;
  }

  async deleteDevice(userId: string, deviceId: string): Promise<boolean> {
    return memoryDevices.delete(deviceKey(userId, deviceId));
  }
}

class DrizzleAppPreferencesStore implements AppPreferencesStore {
  async getNotificationSettings(userId: string): Promise<NotificationSettingsDto> {
    const [row] = await getCunoteDb()
      .select()
      .from(schema.notificationSettings)
      .where(eq(schema.notificationSettings.userId, userId))
      .limit(1);
    return row ? toNotificationSettings(row) : DEFAULT_SETTINGS;
  }

  async updateNotificationSettings(
    userId: string,
    input: Partial<NotificationSettingsDto>,
  ): Promise<NotificationSettingsDto> {
    const next = {
      ...(await this.getNotificationSettings(userId)),
      ...normalizeSettingsPatch(input),
    };
    const [row] = await getCunoteDb()
      .insert(schema.notificationSettings)
      .values({
        userId,
        deadlineReminder: next.deadlineReminder,
        newMatch: next.newMatch,
        quietHoursStart: next.quietHoursStart,
        quietHoursEnd: next.quietHoursEnd,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.notificationSettings.userId,
        set: {
          deadlineReminder: next.deadlineReminder,
          newMatch: next.newMatch,
          quietHoursStart: next.quietHoursStart,
          quietHoursEnd: next.quietHoursEnd,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error("알림 설정 저장 결과가 없습니다.");
    return toNotificationSettings(row);
  }

  async registerDevice(
    userId: string,
    input: DeviceRegistrationInput,
  ): Promise<DeviceRegistrationResult> {
    const now = new Date();
    const [row] = await getCunoteDb()
      .insert(schema.appDevices)
      .values({
        userId,
        deviceId: input.deviceId,
        platform: input.platform,
        pushToken: input.pushToken,
        enabled: true,
        lastSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.appDevices.userId, schema.appDevices.deviceId],
        set: {
          platform: input.platform,
          pushToken: input.pushToken,
          enabled: true,
          lastSeenAt: now,
          updatedAt: now,
        },
      })
      .returning();
    if (!row) throw new Error("기기 등록 결과가 없습니다.");
    return {
      deviceId: row.deviceId,
      platform: row.platform,
      registered: row.enabled,
    };
  }

  async deleteDevice(userId: string, deviceId: string): Promise<boolean> {
    const rows = await getCunoteDb()
      .update(schema.appDevices)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(eq(schema.appDevices.userId, userId), eq(schema.appDevices.deviceId, deviceId)))
      .returning({ id: schema.appDevices.id });
    return rows.length > 0;
  }
}

function normalizeSettingsPatch(input: Partial<NotificationSettingsDto>): Partial<NotificationSettingsDto> {
  const result: Partial<NotificationSettingsDto> = {};
  if (typeof input.deadlineReminder === "boolean") result.deadlineReminder = input.deadlineReminder;
  if (typeof input.newMatch === "boolean") result.newMatch = input.newMatch;
  if (typeof input.quietHoursStart === "string" || input.quietHoursStart === null) {
    result.quietHoursStart = input.quietHoursStart;
  }
  if (typeof input.quietHoursEnd === "string" || input.quietHoursEnd === null) {
    result.quietHoursEnd = input.quietHoursEnd;
  }
  return result;
}

function toNotificationSettings(
  row: typeof schema.notificationSettings.$inferSelect,
): NotificationSettingsDto {
  return {
    deadlineReminder: row.deadlineReminder,
    newMatch: row.newMatch,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
  };
}

function deviceKey(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}
