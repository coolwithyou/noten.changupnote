import designTokens from "../../../../../../design-tokens.json";

interface TokenValue<T = string> {
  value: T;
}

interface DocumentDesignTokens {
  brand: {
    primary: TokenValue;
  };
  color: {
    light: {
      bg: {
        canvas: string;
        surface: string;
      };
      text: {
        strong: string;
        primary: string;
        tertiary: string;
      };
      border: {
        default: string;
      };
      fill: {
        neutralWeak: string;
      };
    };
  };
  radius: {
    sm: TokenValue;
    textField: TokenValue;
  };
  type: {
    fontFamily: TokenValue;
    body: {
      line: number;
    };
    caption: {
      size: string;
    };
  };
}

const tokens = designTokens as unknown as DocumentDesignTokens;

export const documentExportTokens = {
  fontFamily: tokens.type.fontFamily.value,
  lineHeight: tokens.type.body.line,
  captionSize: tokens.type.caption.size,
  canvas: tokens.color.light.bg.canvas,
  surface: tokens.color.light.bg.surface,
  textStrong: tokens.color.light.text.strong,
  textPrimary: tokens.color.light.text.primary,
  textTertiary: tokens.color.light.text.tertiary,
  brandPrimary: tokens.brand.primary.value,
  borderDefault: tokens.color.light.border.default,
  fillNeutralWeak: tokens.color.light.fill.neutralWeak,
  radiusSm: tokens.radius.sm.value,
  radiusTextField: tokens.radius.textField.value,
} as const;

export const documentExportWordTokens = {
  brandPrimary: wordColor(documentExportTokens.brandPrimary),
  textPrimary: wordColor(documentExportTokens.textPrimary),
  textTertiary: wordColor(documentExportTokens.textTertiary),
  borderDefault: wordColor(documentExportTokens.borderDefault),
  fontFamily: firstFontFamily(documentExportTokens.fontFamily),
} as const;

function wordColor(value: string): string {
  return toOpaqueHex(value).replace("#", "").toUpperCase();
}

function toOpaqueHex(value: string): string {
  const hex = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  if (/^#[0-9a-f]{8}$/i.test(hex)) {
    const red = Number.parseInt(hex.slice(1, 3), 16);
    const green = Number.parseInt(hex.slice(3, 5), 16);
    const blue = Number.parseInt(hex.slice(5, 7), 16);
    const alpha = Number.parseInt(hex.slice(7, 9), 16) / 255;
    return `#${[red, green, blue]
      .map((channel) => Math.round(channel * alpha + 255 * (1 - alpha)))
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")}`;
  }
  return "#191f28";
}

function firstFontFamily(value: string): string {
  const [first] = value.split(",");
  return first?.trim().replace(/^"|"$/g, "") || "Pretendard";
}
