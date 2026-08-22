/**
 * 店舗カラー（stores/{storeId}.color）を文字色として使うためのユーティリティ。
 *
 * 色そのものは店舗ドキュメントにのみ保存されており（重複保存はしない）、
 * ここでは「その色をテーマ背景の上で読める明度に補正する」計算だけを行う。
 * ダークテーマでは白へ、ライトテーマでは黒へ少しずつ寄せて、
 * WCAG のコントラスト比 4.5:1 を満たす最初の色を返す。
 */

export type ThemeName = "light" | "dark";

/**
 * コントラスト計算の基準となる背景色。
 * globals.css の --bg2（カード・テーブルの背景）と同値。
 * キャスト名は常にこの上に描画されるため、これを基準にすれば十分。
 */
const SURFACE: Record<ThemeName, string> = {
  dark: "#1a1726",
  light: "#ffffff",
};

/** 本文相当の最低コントラスト比（WCAG AA） */
const MIN_CONTRAST = 4.5;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** '#rgb' / '#rrggbb'（#省略可）を解析する。解析できない場合は null */
export function parseHexColor(hex: string): Rgb | null {
  const v = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(v)) {
    return {
      r: parseInt(v[0] + v[0], 16),
      g: parseInt(v[1] + v[1], 16),
      b: parseInt(v[2] + v[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(v)) {
    return {
      r: parseInt(v.slice(0, 2), 16),
      g: parseInt(v.slice(2, 4), 16),
      b: parseInt(v.slice(4, 6), 16),
    };
  }
  return null;
}

function toHex({ r, g, b }: Rgb): string {
  const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** WCAG の相対輝度 */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const ch = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG のコントラスト比（1〜21） */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: Rgb, b: Rgb, ratio: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * ratio,
    g: a.g + (b.g - a.g) * ratio,
    b: a.b + (b.b - a.b) * ratio,
  };
}

/**
 * 各チャンネルを整数へ丸める。
 * 補正の判定は必ずこの丸め後の値（= 実際に返すHEXと同じ色）で行う。
 * 丸める前の小数RGBで判定すると、返した色を再計算したときに
 * わずかにコントラスト比が閾値を下回ることがあるため。
 */
function roundRgb({ r, g, b }: Rgb): Rgb {
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}

/**
 * 店舗カラーを、テーマ背景の上で読める文字色に補正して返す。
 * - color が未設定・解析不能なら null（呼び出し側は色指定なし＝現在の文字色のまま）
 * - 既に十分なコントラストがあれば元の色をそのまま返す
 */
export function readableStoreColor(
  color: string | null | undefined,
  theme: ThemeName
): string | null {
  if (!color) return null;
  const rgb = parseHexColor(color);
  if (!rgb) return null;

  const bg = parseHexColor(SURFACE[theme]) as Rgb;
  if (contrastRatio(rgb, bg) >= MIN_CONTRAST) return toHex(rgb);

  // ダークテーマは白へ、ライトテーマは黒へ寄せて明度差をつける
  const target: Rgb = theme === "dark" ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  for (let step = 1; step <= 20; step++) {
    const candidate = roundRgb(mix(rgb, target, step / 20));
    if (contrastRatio(candidate, bg) >= MIN_CONTRAST) return toHex(candidate);
  }
  return toHex(target);
}
