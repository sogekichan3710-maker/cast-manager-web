"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  MrConflictError,
  MrExistsError,
  emptyMonthlyResultInput,
  saveMonthlyResult,
  type MonthlyResultInput,
} from "@/services/monthlyResultService";
import {
  fmtDiff,
  lowerSalesByWage,
  monthToJa,
  payDiff,
  realHourlyWage,
  targetSalesByWage,
  wageDiff,
  type CastWithId,
  type MonthlyResultWithId,
} from "@/types";
import { avgHonmeiPerDay, avgSalesPerDay } from "@/lib/dashboard";

interface Props {
  cast: CastWithId;
  /** null = 新規 / 既存 = 編集 */
  result: MonthlyResultWithId | null;
  defaultMonth: string; // YYYY-MM
  onClose: () => void;
  onSaved: () => void;
}

/** 数値入力欄の定義（既存ローカル版 monthlyModal と同一項目・同一順） */
const NUM_FIELDS: Array<{ key: keyof MonthlyResultInput; label: string; step?: number }> = [
  { key: "totalSales", label: "総売上（円）", step: 10000 },
  { key: "payment", label: "支給額（円）", step: 10000 },
  { key: "honshimeiCount", label: "本指名本数" },
  { key: "honshimeiGroupCount", label: "本指名組数" },
  { key: "customerCount", label: "顧客数" },
  { key: "jounaiCount", label: "場内指名" },
  { key: "douhan", label: "同伴" },
  { key: "workDays", label: "出勤日数" },
  { key: "workHours", label: "出勤時間（h）", step: 0.5 },
  { key: "absent", label: "欠勤" },
];

export function MonthlyResultFormModal({ cast, result, defaultMonth, onClose, onSaved }: Props) {
  const { firebaseUser, userDoc } = useAuth();
  const [input, setInput] = useState<MonthlyResultInput>(() =>
    result
      ? {
          castId: result.castId,
          storeId: result.storeId,
          month: result.month,
          totalSales: result.totalSales ?? 0,
          payment: result.payment ?? 0,
          honshimeiCount: result.honshimeiCount ?? 0,
          honshimeiGroupCount: result.honshimeiGroupCount ?? 0,
          customerCount: result.customerCount ?? 0,
          jounaiCount: result.jounaiCount ?? 0,
          douhan: result.douhan ?? 0,
          workDays: result.workDays ?? 0,
          workHours: result.workHours ?? 0,
          absent: result.absent ?? 0,
          notes: result.notes ?? "",
        }
      : emptyMonthlyResultInput(cast.id, cast.storeId, defaultMonth)
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function set<K extends keyof MonthlyResultInput>(key: K, value: MonthlyResultInput[K]) {
    setInput((p) => ({ ...p, [key]: value }));
  }

  async function doSave(overwrite: boolean) {
    if (!firebaseUser) return;
    setError(null);
    setSaving(true);
    try {
      await saveMonthlyResult(firebaseUser.uid, userDoc?.displayName ?? "", input, {
        overwrite,
        expectedUpdatedAt: result ? result.updatedAt : null,
      });
      onSaved();
    } catch (err: unknown) {
      if (err instanceof MrExistsError) {
        // 既存ローカル版の「既存データがあります。上書きしますか？」を維持
        const ok = window.confirm(
          `${cast.stageName}の${monthToJa(input.month)}は既存データがあります。上書きしますか？`
        );
        if (ok) {
          await doSave(true);
          return;
        }
        setSaving(false);
        return;
      }
      if (err instanceof MrConflictError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "保存に失敗しました");
      }
      setSaving(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return; // 二重クリック防止
    void doSave(false);
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <div className="modal-head">
          <h2>
            {result ? "月別成績を編集" : "月別成績を入力"} — {cast.stageName}
          </h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>
            ✕ 閉じる
          </button>
        </div>

        {error && <div className="error-box">{error}</div>}

        <form onSubmit={onSubmit}>
          <div className="form-group">
            <label>対象月 *</label>
            <input
              className="form-input"
              type="month"
              value={input.month}
              disabled={!!result /* 編集時は月変更不可（IDが月で一意のため） */}
              onChange={(e) => set("month", e.target.value)}
              required
            />
          </div>

          <div className="form-grid">
            {NUM_FIELDS.map((f) => (
              <div className="form-group" key={f.key}>
                <label>{f.label}</label>
                <input
                  className="form-input"
                  type="number"
                  min={0}
                  step={f.step ?? 1}
                  value={input[f.key] as number}
                  onChange={(e) => set(f.key, Number(e.target.value) as never)}
                />
              </div>
            ))}
          </div>

          {/* ── 自動計算表示（既存ローカル版 calcMrAuto の移植＋実質時給・目標/下限ライン）
               保存前の参考表示。保存データと同じ計算関数（payDiff/wageDiff/realHourlyWage）を使用 ── */}
          <AutoCalcPanel input={input} cast={cast} />

          <div className="form-group">
            <label>メモ</label>
            <textarea
              className="form-input"
              rows={2}
              value={input.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </div>

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              キャンセル
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "保存中…" : "成績を保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** 入力中のリアルタイム自動計算（既存の計算関数をそのまま使用・画面専用の式は持たない） */
function AutoCalcPanel({ input, cast }: { input: MonthlyResultInput; cast: CastWithId }) {
  const total = Number(input.totalSales) || 0;
  const payment = Number(input.payment) || 0;
  const hCount = Number(input.honshimeiCount) || 0;
  const workDays = Number(input.workDays) || 0;
  const workHours = Number(input.workHours) || 0;
  const wage = cast.hourlyWage || 0;

  const pd = payDiff(total, payment);
  const wd = wageDiff(total, wage, workHours, workDays);
  const rw = realHourlyWage(payment, workHours, workDays);
  const estHours =
    workHours > 0 ? null : workDays > 0 ? (workDays * 4.5).toFixed(1) + "h（推定）" : null;
  const target = targetSalesByWage(wage);
  const lower = lowerSalesByWage(wage);
  const avgS = avgSalesPerDay(total, workDays);
  const avgH = avgHonmeiPerDay(hCount, workDays);

  const Row = ({ label, value, color }: { label: string; value: string; color?: string }) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0" }}>
      <span style={{ color: "var(--text3)" }}>{label}</span>
      <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums", color }}>{value}</span>
    </div>
  );

  return (
    <div
      style={{
        background: "var(--bg3)",
        borderRadius: "var(--r-sm)",
        padding: "10px 14px",
        marginBottom: 14,
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: "var(--text3)",
          letterSpacing: 1,
          marginBottom: 4,
        }}
      >
        自動計算（保存前の参考表示）
      </div>
      <Row label="給与差額（総売上−支給額）" value={pd != null ? fmtDiff(pd) : "-"} color={pd != null && pd < 0 ? "var(--red)" : undefined} />
      <Row label="時給差額（総売上−時給×時間）" value={wd != null ? fmtDiff(wd) : "-"} color={wd != null && wd < 0 ? "var(--red)" : undefined} />
      <Row label="実質時給（支給額÷時間）" value={rw != null ? "¥" + rw.toLocaleString() : "-"} />
      {estHours && <Row label="出勤時間（未入力のため日数×4.5h）" value={estHours} />}
      <Row label="日割平均売上" value={avgS != null ? "¥" + avgS.toLocaleString() : "-"} />
      <Row label="日割平均本指名" value={avgH != null ? avgH + "本" : "-"} />
      <Row label="目標売上ライン（時給×225）" value={target != null ? "¥" + target.toLocaleString() : "-"} color="var(--green)" />
      <Row label="下限売上ライン（時給×90）" value={lower != null ? "¥" + lower.toLocaleString() : "-"} color="var(--yellow)" />
    </div>
  );
}
