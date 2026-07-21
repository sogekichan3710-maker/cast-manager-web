"use client";

import { AppHeader } from "@/components/AppHeader";
import { useTheme, type Theme } from "@/contexts/ThemeContext";

/**
 * 設定画面（PR6で新規追加）。
 * 現時点ではライト/ダークモードの切替のみを扱う。
 * 承認済みユーザーであれば誰でもアクセス可能（個人設定のため役割制限なし）。
 */
export default function SettingsPage() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <h1 className="page-title">設定</h1>
        <p className="page-sub">表示に関する個人設定です（この端末に保存されます）</p>

        <section className="detail-card">
          <h2 className="detail-heading">表示テーマ</h2>
          <div className="theme-option-group" role="radiogroup" aria-label="表示テーマ">
            <ThemeOption
              value="dark"
              current={theme}
              label="ダークモード"
              desc="従来どおりの濃紺×紫のテーマ（既定）"
              onSelect={setTheme}
            />
            <ThemeOption
              value="light"
              current={theme}
              label="ライトモード"
              desc="白背景の明るいテーマ"
              onSelect={setTheme}
            />
          </div>
        </section>
      </main>
    </div>
  );
}

function ThemeOption({
  value,
  current,
  label,
  desc,
  onSelect,
}: {
  value: Theme;
  current: Theme;
  label: string;
  desc: string;
  onSelect: (t: Theme) => void;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={`theme-option${active ? " active" : ""}`}
      onClick={() => onSelect(value)}
    >
      <span className="theme-option-swatch" data-swatch={value} aria-hidden />
      <span>
        <span className="theme-option-label">
          {label}
          {active && <span className="badge badge-purple" style={{ marginLeft: 8 }}>選択中</span>}
        </span>
        <span className="theme-option-desc">{desc}</span>
      </span>
    </button>
  );
}
