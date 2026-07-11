/**
 * CODEF RSA 공개키 암호화 유틸.
 *
 * CODEF 키관리에서 발급하는 publicKey 는 Base64 인코딩된 DER(SPKI) 공개키다.
 * 인증서 비밀번호나 (선택) 주민번호 뒷자리 등 민감값을 이 공개키로 RSA(PKCS#1 v1.5)
 * 암호화해 전송한다. 간편인증(loginType="5") 경로엔 사실상 불필요하나, 인증서 기반
 * 상품(4대보험 등) 확장에 대비한 공용 유틸로 둔다.
 */

import { constants, createPublicKey, publicEncrypt } from "node:crypto";

/**
 * 평문을 CODEF 공개키(Base64 DER/SPKI)로 RSA(PKCS#1 v1.5) 암호화하고 Base64로 반환한다.
 * @param plaintext 암호화할 평문(UTF-8)
 * @param publicKeyBase64 CODEF publicKey — Base64 인코딩된 DER(SPKI)
 */
export function encryptWithCodefPublicKey(
  plaintext: string,
  publicKeyBase64: string,
): string {
  const key = createPublicKey({
    key: Buffer.from(publicKeyBase64, "base64"),
    format: "der",
    type: "spki",
  });
  const encrypted = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, "utf8"),
  );
  return encrypted.toString("base64");
}
