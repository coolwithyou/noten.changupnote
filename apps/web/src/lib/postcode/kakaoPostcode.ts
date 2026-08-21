export const KAKAO_POSTCODE_SCRIPT_URL =
  "https://t1.kakaocdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";

export interface KakaoPostcodeResult {
  zonecode: string;
  address: string;
  userSelectedType: "R" | "J" | string;
  roadAddress: string;
  jibunAddress: string;
  autoRoadAddress?: string;
  autoJibunAddress?: string;
  bname: string;
  buildingName: string;
  apartment: "Y" | "N" | string;
}

export interface SelectedPostalAddress {
  postalCode: string;
  address: string;
}

interface KakaoPostcodeOptions {
  oncomplete: (data: KakaoPostcodeResult) => void;
}

interface KakaoPostcodeInstance {
  open: () => void;
}

type KakaoPostcodeConstructor = new (options: KakaoPostcodeOptions) => KakaoPostcodeInstance;

let loader: Promise<KakaoPostcodeConstructor> | null = null;

export function selectKakaoPostalAddress(
  data: KakaoPostcodeResult,
): SelectedPostalAddress | null {
  const postalCode = data.zonecode.trim();
  const roadSelected = data.userSelectedType === "R";
  const baseAddress = (
    roadSelected
      ? data.roadAddress || data.autoRoadAddress || data.address
      : data.jibunAddress || data.autoJibunAddress || data.address
  ).trim();

  if (!postalCode || !baseAddress) return null;

  const extraParts: string[] = [];
  if (roadSelected && data.bname && /[동로가]$/u.test(data.bname)) {
    extraParts.push(data.bname.trim());
  }
  if (roadSelected && data.apartment === "Y" && data.buildingName.trim()) {
    extraParts.push(data.buildingName.trim());
  }
  const extraAddress = extraParts.length > 0 ? ` (${extraParts.join(", ")})` : "";

  return {
    postalCode,
    address: `${baseAddress}${extraAddress}`,
  };
}

export function loadKakaoPostcode(): Promise<KakaoPostcodeConstructor> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("KAKAO_POSTCODE_BROWSER_REQUIRED"));
  }

  const available = postcodeConstructor();
  if (available) return Promise.resolve(available);
  if (loader) return loader;

  loader = new Promise<KakaoPostcodeConstructor>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${KAKAO_POSTCODE_SCRIPT_URL}"]`,
    );
    const script = existing ?? document.createElement("script");

    const cleanup = () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    };
    const handleLoad = () => {
      cleanup();
      const loaded = postcodeConstructor();
      if (loaded) {
        script.dataset.loaded = "true";
        resolve(loaded);
        return;
      }
      if (script.dataset.kakaoPostcode === "true") script.remove();
      reject(new Error("KAKAO_POSTCODE_CONSTRUCTOR_MISSING"));
    };
    const handleError = () => {
      cleanup();
      if (script.dataset.kakaoPostcode === "true") script.remove();
      reject(new Error("KAKAO_POSTCODE_SCRIPT_LOAD_FAILED"));
    };

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });

    if (existing) {
      if (script.dataset.loaded === "true") handleLoad();
      return;
    }

    script.src = KAKAO_POSTCODE_SCRIPT_URL;
    script.async = true;
    script.dataset.kakaoPostcode = "true";
    document.head.appendChild(script);
  }).catch((error) => {
    loader = null;
    throw error;
  });

  return loader;
}

export function openKakaoPostcode(input: {
  onComplete: (address: SelectedPostalAddress) => void;
  onError: (error: Error) => void;
}): void {
  const Postcode = postcodeConstructor();
  if (!Postcode) throw new Error("KAKAO_POSTCODE_NOT_READY");

  new Postcode({
    oncomplete: (data) => {
      const selected = selectKakaoPostalAddress(data);
      if (!selected) {
        input.onError(new Error("KAKAO_POSTCODE_INVALID_RESULT"));
        return;
      }
      input.onComplete(selected);
    },
  }).open();
}

function postcodeConstructor(): KakaoPostcodeConstructor | null {
  if (typeof window === "undefined") return null;
  const kakao = (window as Window & {
    kakao?: { Postcode?: KakaoPostcodeConstructor };
  }).kakao;
  return kakao?.Postcode ?? null;
}
