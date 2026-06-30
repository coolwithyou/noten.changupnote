import type {
  NotificationFeedResult,
  NotificationItem,
  NotificationReceiptAction,
  NotificationReceiptStatus,
  NotificationSettingsDto,
} from "@cunote/contracts";

export type { NotificationReceiptAction, NotificationReceiptStatus };

export interface NotificationCenterItem extends NotificationItem {
  href: string;
  status: NotificationReceiptStatus;
  readAt: string | null;
  dismissedAt: string | null;
}

export interface NotificationCenterResult extends Omit<NotificationFeedResult, "notifications"> {
  notifications: NotificationCenterItem[];
  unreadCount: number;
  dismissedCount: number;
  settings: NotificationSettingsDto;
}
