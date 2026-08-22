import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  parseHexColor,
  readableStoreColor,
  relativeLuminance,
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
