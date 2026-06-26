export const DEFAULT_MOCK_USER_ID = "00000000-0000-4000-8000-000000000001";
export const DEFAULT_MOCK_USER_EMAIL = "demo@changupnote.com";
export const DEFAULT_MOCK_USER_NAME = "Demo User";

export function mockUserId(): string {
  return process.env.CUNOTE_MOCK_USER_ID ?? DEFAULT_MOCK_USER_ID;
}

export function mockUserEmail(): string {
  return process.env.CUNOTE_MOCK_USER_EMAIL ?? DEFAULT_MOCK_USER_EMAIL;
}

export function mockUserName(): string {
  return process.env.CUNOTE_MOCK_USER_NAME ?? DEFAULT_MOCK_USER_NAME;
}
