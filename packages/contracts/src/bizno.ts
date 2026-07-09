/**
 * 사업자등록번호 체크섬 검증(국세청 검증숫자 알고리즘).
 *
 * 랜딩(HomeExperience, 클라이언트)과 서버 라우트(teaser / company-preview)가
 * 동일한 구현을 공유해야 하므로 @cunote/contracts 에 둔다. @cunote/core index 는
 * 팝빌 SDK 가 딸려와 클라이언트 번들에 부적합하지만, @cunote/contracts 는 순수 타입/유틸이라
 * apps/web 의 transpilePackages 로 클라이언트에서도 안전하게 런타임 import 된다.
 *
 * 알고리즘:
 *   - 앞 9자리(d0..d8)에 가중치 [1,3,7,1,3,7,1,3,5]를 곱해 합산
 *   - floor(d8 * 5 / 10) 을 더함
 *   - 검증숫자 = (10 - (합 % 10)) % 10
 *   - 검증숫자가 d9 와 같으면 유효
 */

const CHECKSUM_WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5];

export function isValidBizNoChecksum(bizNo: string): boolean {
  const digits = String(bizNo ?? "").replace(/\D/g, "");
  if (digits.length !== 10) return false;

  const nums = digits.split("").map((char) => Number(char));
  if (nums.some((value) => Number.isNaN(value))) return false;

  let sum = 0;
  for (let index = 0; index < CHECKSUM_WEIGHTS.length; index += 1) {
    sum += (nums[index] ?? 0) * (CHECKSUM_WEIGHTS[index] ?? 0);
  }
  sum += Math.floor(((nums[8] ?? 0) * 5) / 10);

  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === (nums[9] ?? 0);
}
