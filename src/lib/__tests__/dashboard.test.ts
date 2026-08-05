import { describe, expect, it } from "vitest";
import {
  calcCompletedInterviews,
  calcOverdueInterviews,
  nextMonthOf,
  normalizeInterviewDate,
} from "@/lib/dashboard";
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

describe("normalizeInterviewDate: 面談日の正規化", () => {
  it("YYYY-MM-DD文字列はそのまま正規化する", () => {
    expect(normalizeInterviewDate("2026-08-05")).toBe("2026-08-05");
  });

  it("区切り文字違い（YYYY/M/D）のレガシー形式も正規化する", () => {
    expect(normalizeInterviewDate("2026/8/5")).toBe("2026-08-05");
  });

  it("Firestore Timestamp相当（toDateを持つオブジェクト）も正規化する", () => {
    const fakeTimestamp = { toDate: () => new Date(2026, 7, 5) }; // 8月(0始まり7)
    expect(normalizeInterviewDate(fakeTimestamp)).toBe("2026-08-05");
  });

  it("Dateインスタンスも正規化する", () => {
    expect(normalizeInterviewDate(new Date(2026, 7, 5))).toBe("2026-08-05");
  });

  it("空・不正な値はnull", () => {
    expect(normalizeInterviewDate("")).toBeNull();
    expect(normalizeInterviewDate(null)).toBeNull();
    expect(normalizeInterviewDate("不明な日付")).toBeNull();
  });
});

describe("nextMonthOf: 次月算出", () => {
  it("年をまたがない月は+1する", () => {
    expect(nextMonthOf("2026-08")).toBe("2026-09");
  });
  it("12月の次は翌年1月", () => {
    expect(nextMonthOf("2026-12")).toBe("2027-01");
  });
});

describe("calcCompletedInterviews: 月別の面談済み一覧", () => {
  it("対象月・キャスト単位でまとめず面談日時が新しい順で返す", () => {
    const now = new Date(2026, 7, 20); // 2026-08-20
    const list = calcCompletedInterviews({
      month: "2026-08",
      casts: [cast("c1")],
      interviews: [
        interview("iv1", "c1", "2026-08-01"),
        interview("iv2", "c1", "2026-08-15"), // 同じキャストでも別エントリ
        interview("iv3", "c1", "2026-07-31"), // 対象月外
      ],
      now,
    });
    expect(list.map((x) => x.interview.id)).toEqual(["iv2", "iv1"]);
  });

  it("未来日（今日より後）の面談は面談済みに含めない", () => {
    const now = new Date(2026, 7, 5); // 2026-08-05
    const list = calcCompletedInterviews({
      month: "2026-08",
      casts: [cast("c1")],
      interviews: [
        interview("iv-past", "c1", "2026-08-01"),
        interview("iv-future", "c1", "2026-08-31"), // 未来日
      ],
      now,
    });
    expect(list.map((x) => x.interview.id)).toEqual(["iv-past"]);
  });

  it("面談記録が無いキャストは含まれない", () => {
    const now = new Date(2026, 7, 20);
    const list = calcCompletedInterviews({
      month: "2026-08",
      casts: [cast("c1"), cast("c2")],
      interviews: [interview("iv1", "c1", "2026-08-01")],
      now,
    });
    expect(list).toHaveLength(1);
    expect(list[0].cast.id).toBe("c1");
  });
});
