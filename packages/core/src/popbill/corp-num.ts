export function sanitizeCorpNum(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!/^\d{10}$/.test(digits)) {
    throw new Error("사업자번호는 숫자 10자리여야 합니다.");
  }
  return digits;
}

export function maskCorpNum(value: string): string {
  const digits = sanitizeCorpNum(value);
  return `${digits.slice(0, 3)}-**-${digits.slice(5, 7)}***`;
}
