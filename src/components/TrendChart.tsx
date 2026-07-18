"use client";

import { useMemo, useState } from "react";
import {
  fmtDiff,
  lowerSalesByWage,
  monthShortLabel,
  payDiff,
  targetSalesByWage,
  wageDiff,
  type CastWithId,
  type MonthlyResultWithId,
} from "@/types";

/**
 * キャスト詳細のグラフ（既存ローカル版 buildChartCache / switchChart / buildChart の移植）。
 *
 * 既存仕様を維持:
 * - 8種のグラフ（順序・色・値のフォーマットは buildChartCache と同一）
 * - 直近12ヶ月、古い月 → 新しい月の順に表示
 * - 売上推移のみ 目標ライン（時給×225）・下限ライン（時給×90）を破線表示
 * - データ0件は「成績データがありません」
 * - X軸ラベルは「9月」形式（年を除去）
 * 補足: 既存版の switchChart のラベル配列には「顧客数推移」が含まれるが、
 * 対応するデータ定義が buildChartCache に存在しない（ラベル9個/データ8個の齟齬）。
 * 本移植ではデータ定義（8種）を正として維持している。
 */

interface ChartDef {
  label: string;
  color: string;
  fmt: (v: number) => string;
  value: (r: MonthlyResultWithId) => number;
  withRefLines?: boolean;
}

const fmtMoney = (v: number) => "¥" + Math.round(v).toLocaleString();
const fmtInt = (unit: string) => (v: number) => {
  const n = Math.round(Math.abs(v) < 1e-9 ? 0 : v);
  return n + unit;
};

function chartDefs(cast: CastWithId): ChartDef[] {
  // 既存ローカル版 buildChartCache と同一の順序・色・書式
  return [
    {
      label: "売上推移",
      color: "#e040fb",
      fmt: fmtMoney,
      value: (r) => r.totalSales || 0,
      withRefLines: true,
    },
    {
      label: "本指名本数推移",
      color: "#ce93d8",
      fmt: fmtInt("本"),
      value: (r) => Math.round(r.honshimeiCount || 0),
    },
    {
      label: "本指名組数推移",
      color: "#b39ddb",
      fmt: fmtInt("組"),
      value: (r) => Math.round(r.honshimeiGroupCount || 0),
    },
    {
      label: "場内指名推移",
      color: "#40c4ff",
      fmt: fmtInt("本"),
      value: (r) => Math.round(r.jounaiCount || 0),
    },
    {
      label: "同伴推移",
      color: "#00e676",
      fmt: fmtInt("件"),
      value: (r) => Math.round(r.douhan || 0),
    },
    {
      label: "出勤日数推移",
      color: "#ffea00",
      fmt: fmtInt("日"),
      value: (r) => Math.round(r.workDays || 0),
    },
    {
      label: "給与差額推移",
      color: "#ff9100",
      fmt: (v) => fmtDiff(v),
      value: (r) => payDiff(r.totalSales, r.payment) || 0,
    },
    {
      label: "時給差額推移",
      color: "#ff5252",
      fmt: (v) => fmtDiff(v),
      value: (r) => wageDiff(r.totalSales, cast.hourlyWage, r.workHours, r.workDays) || 0,
    },
  ];
}

interface RefLine {
  v: number;
  color: string;
  label: string;
  dash: string;
}

export function TrendChart({
  cast,
  results,
}: {
  cast: CastWithId;
  /** 月の昇順（古い月→新しい月）で渡すこと */
  results: MonthlyResultWithId[];
}) {
  const [idx, setIdx] = useState(0);
  const defs = useMemo(() => chartDefs(cast), [cast]);
  // 既存版と同じく直近12ヶ月（slice(-12)、古→新の順のまま）
  const d12 = useMemo(() => results.slice(-12), [results]);

  if (results.length === 0) {
    return (
      <div style={{ color: "var(--text3)", textAlign: "center", padding: 30, fontSize: 12 }}>
        成績データがありません
      </div>
    );
  }

  const def = defs[idx];
  const data = d12.map((r) => ({ l: monthShortLabel(r.month), v: def.value(r) }));

  // 売上推移のみ目標・下限ライン（既存版 switchChart と同一）
  let refLines: RefLine[] | null = null;
  if (def.withRefLines && cast.hourlyWage) {
    const target = targetSalesByWage(cast.hourlyWage);
    const lower = lowerSalesByWage(cast.hourlyWage);
    if (target != null && lower != null) {
      refLines = [
        {
          v: target,
          color: "#00e676",
          label: `目標 ¥${Math.round(target / 1000)}k`,
          dash: "8,4",
        },
        {
          v: lower,
          color: "#ff9100",
          label: `下限 ¥${Math.round(lower / 1000)}k`,
          dash: "4,4",
        },
      ];
    }
  }

  return (
    <div>
      <div className="chart-tabs" role="tablist">
        {defs.map((d, i) => (
          <button
            key={d.label}
            role="tab"
            aria-selected={i === idx}
            className={i === idx ? "chart-tab active" : "chart-tab"}
            onClick={() => setIdx(i)}
          >
            {d.label.replace("推移", "")}
          </button>
        ))}
      </div>

      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: "var(--text2)",
          margin: "10px 0 6px",
          letterSpacing: 0.5,
        }}
      >
        {def.label}
      </div>

      {refLines && (
        <div
          style={{ display: "flex", gap: 12, marginBottom: 6, fontSize: 10, flexWrap: "wrap" }}
        >
          <LegendItem color="#e040fb" label="実売上" />
          <LegendItem color="#00e676" label="目標ライン (時給×225)" dashed />
          <LegendItem color="#ff9100" label="下限ライン (時給×90)" dashed />
        </div>
      )}

      <SvgLineChart data={data} color={def.color} fmt={def.fmt} refLines={refLines} />
    </div>
  );
}

function LegendItem({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span
        style={{
          width: 16,
          height: 2,
          background: color,
          borderRadius: 1,
          display: "inline-block",
          borderTop: dashed ? `1px dashed ${color}` : undefined,
        }}
      />
      {label}
    </span>
  );
}

/**
 * SVG折れ線チャート（既存ローカル版 buildChart の移植）。
 * 座標系・パディング・グリッド数は既存版と同一（W=580 H=200）。
 * viewBox指定によりスマートフォンでも横切れせず縮小表示される。
 */
function SvgLineChart({
  data,
  color,
  fmt,
  refLines,
}: {
  data: { l: string; v: number }[];
  color: string;
  fmt: (v: number) => string;
  refLines: RefLine[] | null;
}) {
  const W = 580;
  const H = 200;
  const P = { t: 20, r: 16, b: 36, l: 66 };
  const cW = W - P.l - P.r;
  const cH = H - P.t - P.b;

  const vals = data.map((d) => d.v).filter((v) => v != null && Number.isFinite(v));
  if (vals.length === 0) {
    return (
      <div style={{ color: "var(--text3)", textAlign: "center", padding: 30, fontSize: 12 }}>
        データなし
      </div>
    );
  }

  const refVals = (refLines ?? []).map((r) => r.v).filter((v) => Number.isFinite(v));
  const allVals = [...vals, ...refVals];
  let vMin = Math.min(...allVals, 0);
  let vMax = Math.max(...allVals);
  if (vMin === vMax) vMax = vMin + 1;
  const pad = (vMax - vMin) * 0.08;
  vMin -= vMin < 0 ? pad : 0;
  vMax += pad;

  const x = (i: number) =>
    P.l + (data.length === 1 ? cW / 2 : (i / (data.length - 1)) * cW);
  const y = (v: number) => P.t + cH - ((v - vMin) / (vMax - vMin)) * cH;

  const points = data.map((d, i) => ({ px: x(i), py: y(d.v), ...d }));
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.px},${p.py}`).join(" ");

  // グリッド（4分割）
  const grids = [0, 1, 2, 3, 4].map((g) => {
    const gv = vMin + ((vMax - vMin) * g) / 4;
    return { gy: y(gv), gv };
  });

  const zeroY = vMin < 0 && vMax > 0 ? y(0) : null;

  return (
    <div className="chart-scroll">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
        aria-label="推移グラフ"
      >
        {grids.map((g, i) => (
          <g key={i}>
            <line
              x1={P.l}
              y1={g.gy}
              x2={W - P.r}
              y2={g.gy}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={P.l - 6}
              y={g.gy + 3}
              textAnchor="end"
              fontSize={9}
              fill="var(--text3)"
            >
              {fmt(g.gv)}
            </text>
          </g>
        ))}

        {zeroY != null && (
          <line
            x1={P.l}
            y1={zeroY}
            x2={W - P.r}
            y2={zeroY}
            stroke="var(--text3)"
            strokeWidth={1}
            strokeDasharray="2,3"
          />
        )}

        {(refLines ?? []).map((r) => (
          <g key={r.label}>
            <line
              x1={P.l}
              y1={y(r.v)}
              x2={W - P.r}
              y2={y(r.v)}
              stroke={r.color}
              strokeWidth={1.5}
              strokeDasharray={r.dash}
            />
            <text
              x={W - P.r}
              y={y(r.v) - 4}
              textAnchor="end"
              fontSize={9}
              fill={r.color}
              fontWeight={700}
            >
              {r.label}
            </text>
          </g>
        ))}

        <path d={linePath} fill="none" stroke={color} strokeWidth={2.5} />

        {points.map((p, i) => (
          <g key={i}>
            <circle cx={p.px} cy={p.py} r={3.5} fill={color} />
            <text
              x={p.px}
              y={p.py - 8}
              textAnchor="middle"
              fontSize={8.5}
              fill="var(--text2)"
            >
              {fmt(p.v)}
            </text>
            <text
              x={p.px}
              y={H - P.b + 16}
              textAnchor="middle"
              fontSize={9}
              fill="var(--text3)"
            >
              {p.l}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
