"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * ライト/ダークモード切替（PR6）。
 * - 既定はダーク（従来のUIをそのまま維持するため）
 * - 選択は localStorage に保存し、次回訪問時も引き継ぐ
 * - <html data-theme="..."> を切り替えることで globals.css のCSS変数
 *   （:root と :root[data-theme="light"]）が自動的に反映される
 * - layout.tsx に置いた同期スクリプトが、Reactのハイドレーション前に
 *   保存済みテーマを反映するため、切替時のちらつき（FOUC）を防いでいる
 */

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "cast-manager-theme";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isTheme(v: unknown): v is Theme {
  return v === "light" || v === "dark";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");

  // 初回マウント時にlocalStorage（または既にlayoutのスクリプトが
  // 設定済みのdata-theme属性）から現在のテーマを読み取る
  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) {
      setThemeState(stored);
    } else {
      const attr = document.documentElement.getAttribute("data-theme");
      if (isTheme(attr)) setThemeState(attr);
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {
      // localStorageが使えない環境（プライベートモード等）でも表示自体は継続する
    }
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme は ThemeProvider の内側で使用してください");
  return ctx;
}
