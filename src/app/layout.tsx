import type { Metadata } from "next";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider, THEME_STORAGE_KEY } from "@/contexts/ThemeContext";
import { AuthGate } from "@/components/AuthGate";
import "./globals.css";

export const metadata: Metadata = {
  title: "CAST MANAGER",
  description: "キャスト管理システム",
};

/**
 * Reactのハイドレーション前に保存済みテーマを <html> へ反映する同期スクリプト。
 * これが無いと、ライトモード選択時に一瞬ダーク（既定値）が表示されてから
 * 切り替わるちらつき（FOUC）が発生する。既定はダークのまま変更しない。
 */
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY
)});if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>
            <AuthGate>{children}</AuthGate>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
