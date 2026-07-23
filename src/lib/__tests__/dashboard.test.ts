import { describe, expect, it } from "vitest";
import { calcOverdueInterviews } from "@/lib/dashboard";
import type { CastWithId, InterviewWithId } from "@/types";

function cast(id: string): CastWithId {
  return {
    id,
    storeId: "virgo",
    stageName: `キャスト${id}`,
    realName: "",
    kana: "",
    hourlyWage: 3000,
    rank: "",
    status: "在籍",
    joinDate: "",
    leftDate: "",
    birthday: "",
    phone: "",
    line: "",
    manager: "",
    scoutedBy: "",
    targetSales: 0,
    targetHonmei: 0,
    targetDouhan: 0,
    guarantee: "",
    personality: "",
    memo: "",
    customerNotes: "",
    archived: false,
    createdAt: null as never,
    createdBy: "",
    updatedAt: null as never,
    updatedBy: "",
  };
}

function interview(id: string, castId: string, date: string): InterviewWithId {
  return {
    id,
    castId,
    storeId: "virgo",
    date,
    type: "face-to-face",
    importance: "通常",
    follow: "",
    interviewer: "",
    content: "",
    worries: "",
    decisions: "",
    nextTask: "",
    nextDate: "",
    createdAt: null as never,
    createdBy: "",
    updatedAt: null as never,
    updatedBy: "",
  };
}

describe("calcOverdueInterviews: interview参照（PR10: 一覧画面での削除操作に使う）", () => {
  it("面談記録があるキャストはその最新面談の実体をinterviewに保持する", () => {
    const now = new Date(2026, 6, 23); // 2026-07-23
    const list = calcOverdueInterviews({
      casts: [cast("c1")],
      interviews: [
        interview("iv-old", "c1", "2026-05-01"),
        interview("iv-latest", "c1", "2026-06-01"), // より新しい方が最新
      ],
      motivations: [],
      now,
    });
    expect(list).toHaveLength(1);
    expect(list[0].noRecord).toBe(false);
    expect(list[0].interview?.id).toBe("iv-latest");
  });

  it("未面談キャストはinterviewがnullになる", () => {
    const now = new Date(2026, 6, 23);
    const list = calcOverdueInterviews({
      casts: [cast("c2")],
      interviews: [],
      motivations: [],
      now,
    });
    expect(list).toHaveLength(1);
    expect(list[0].noRecord).toBe(true);
    expect(list[0].interview).toBeNull();
  });
});
