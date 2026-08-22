import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  parseHexColor,
  readableStoreColor,
  relativeLuminance,
  type ThemeName,
} from "@/lib/storeColor";

const DARK_BG = { r: 0x1a, g: 0x17, b: 0x26 };
const LIGHT_BG = { r: 255, g: 255, b: 255 };

describe("parseHexColor", () => {
  it("6桁・3桁の16進カラーを解析する", () => {
    expect(parseHexColor("#9c27b0")).toEqual({ r: 0x9c, g: 0x27, b: 0xb0 });
    expect(parseHexColor("9c27b0")).toEqual({ r: 0x9c, g: 0x27, b: 0xb0 });
    expect(parseHexColor("#abc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
  });

  it("解析できない値は null", () => {
    expect(parseHexColor("")).toBeNull();
    expect(parseHexColor("red")).toBeNull();
    expect(parseHexColor("#12345")).toBeNull();
  });
});

describe("relativeLuminance / contrastRatio", () => {
  it("白と黒のコントラスト比は21", () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 })).toBeCloseTo(21, 5);
  });
});

describe("readableStoreColor", () => {
  it("未設定・不正値は null（＝色を指定せず既存の文字色を使う）", () => {
    expect(readableStoreColor("", "dark")).toBeNull();
    expect(readableStoreColor(null, "dark")).toBeNull();
    expect(readableStoreColor(undefined, "light")).toBeNull();
    expect(readableStoreColor("not-a-color", "dark")).toBeNull();
  });

  it("初期店舗の色をダークテーマで読める明度へ補正する", () => {
    for (const color of ["#9c27b0", "#e91e63"]) {
      const out = readableStoreColor(color, "dark");
      expect(out).not.toBeNull();
      expect(contrastRatio(parseHexColor(out as string)!, DARK_BG)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("明るすぎる色はライトテーマで暗く補正する", () => {
    const out = readableStoreColor("#ffee58", "light");
    expect(out).not.toBeNull();
    expect(contrastRatio(parseHexColor(out as string)!, LIGHT_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it("すでに十分なコントラストがある色はそのまま返す", () => {
    expect(readableStoreColor("#ffffff", "dark")).toBe("#ffffff");
    expect(readableStoreColor("#000000", "light")).toBe("#000000");
  });

  it("同じ色でもテーマによって補正方向が変わる", () => {
    const dark = readableStoreColor("#9c27b0", "dark") as string;
    const light = readableStoreColor("#9c27b0", "light") as string;
    expect(relativeLuminance(parseHexColor(dark)!)).toBeGreaterThan(
      relativeLuminance(parseHexColor(light)!)
    );
  });
});

/**
 * 補正の判定を丸める前の小数RGBで行うと、返却HEXを再度パースして
 * 計算し直したときに 4.5:1 をわずかに下回ることがあった（丸め誤差）。
 * ここでは「実際に返ってきたHEX」を基準にコントラスト比を検証する。
 */
describe("readableStoreColor の返却HEXが必ず 4.5:1 を満たす", () => {
  const BG: Record<ThemeName, typeof DARK_BG> = { dark: DARK_BG, light: LIGHT_BG };

  /** 返却HEXを再パースして、テーマ背景に対する実際のコントラスト比を返す */
  function contrastOfResult(input: string, theme: ThemeName): number {
    const out = readableStoreColor(input, theme);
    expect(out).not.toBeNull();
    const parsed = parseHexColor(out as string);
    expect(parsed).not.toBeNull();
    return contrastRatio(parsed!, BG[theme]);
  }

  it("丸め誤差の既知の再現色でも 4.5:1 以上になる", () => {
    // 修正前: dark #0582c3 -> #1288c6 で約4.490 / light #0087e6 -> #007acf で約4.483
    expect(contrastOfResult("#0582c3", "dark")).toBeGreaterThanOrEqual(4.5);
    expect(contrastOfResult("#0087e6", "light")).toBeGreaterThanOrEqual(4.5);
  });

  it("RGB空間を一定間隔でサンプリングしても 4.5:1 を下回らない", () => {
    // 17刻み（各チャンネル16段階 = 4,096色）をダーク・ライト両テーマで検証する
    const STEP = 17;
    let checked = 0;
    let worstDark = Infinity;
    let worstLight = Infinity;
    for (let r = 0; r <= 255; r += STEP) {
      for (let g = 0; g <= 255; g += STEP) {
        for (let b = 0; b <= 255; b += STEP) {
          const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
          for (const theme of ["dark", "light"] as const) {
            const out = readableStoreColor(hex, theme);
            expect(out).not.toBeNull();
            const parsed = parseHexColor(out as string);
            expect(parsed).not.toBeNull();
            const ratio = contrastRatio(parsed!, BG[theme]);
            if (ratio < 4.5) {
              throw new Error(`${hex} (${theme}) -> ${out} のコントラスト比が ${ratio}`);
            }
            if (theme === "dark") worstDark = Math.min(worstDark, ratio);
            else worstLight = Math.min(worstLight, ratio);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(16 * 16 * 16 * 2);
    expect(worstDark).toBeGreaterThanOrEqual(4.5);
    expect(worstLight).toBeGreaterThanOrEqual(4.5);
  });
});
