import { describe, expect, it } from "vitest";
import { fmtYenJa } from "@/lib/formatYen";

describe("fmtYenJa", () => {
  it("1万未満はそのまま円表示にする", () => {
    expect(fmtYenJa(0)).toBe("0円");
    expect(fmtYenJa(5000)).toBe("5,000円");
    expect(fmtYenJa(9999)).toBe("9,999円");
  });

  it("万単位で割り切れる場合は「◯万円」", () => {
    expect(fmtYenJa(500000)).toBe("50万円");
    expect(fmtYenJa(10000)).toBe("1万円");
  });

  it("端数がある場合は「◯万◯,◯◯◯円」", () => {
    expect(fmtYenJa(2025000)).toBe("202万5,000円");
    expect(fmtYenJa(1506400)).toBe("150万6,400円");
  });

  it("負の値は先頭に「-」を付ける", () => {
    expect(fmtYenJa(-12000)).toBe("-1万2,000円");
    expect(fmtYenJa(-5000)).toBe("-5,000円");
    expect(fmtYenJa(-500000)).toBe("-50万円");
  });

  it("小数は四捨五入する", () => {
    expect(fmtYenJa(1999999.6)).toBe("200万円");
  });
});
