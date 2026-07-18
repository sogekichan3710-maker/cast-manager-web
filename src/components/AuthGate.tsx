"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth, type AuthPhase } from "@/contexts/AuthContext";

/** 未ログインでもアクセスできるパス */
const PUBLIC_PATHS = ["/login", "/register"];

/** phase ごとの強制遷移先。null は「そのまま表示してよい」 */
function requiredPathFor(phase: AuthPhase, pathname: string): string | null {
  switch (phase) {
    case "signedOut":
      return PUBLIC_PATHS.includes(pathname) ? null : "/login";
    case "pending":
      return pathname === "/pending" ? null : "/pending";
    case "disabled":
      return pathname === "/disabled" ? null : "/disabled";
    case "noUserDoc":
    case "error":
      return pathname === "/account-error" ? null : "/account-error";
    case "approved":
      // 承認済みユーザーが認証系画面にいる場合はダッシュボードへ
      if (
        PUBLIC_PATHS.includes(pathname) ||
        ["/pending", "/disabled", "/account-error"].includes(pathname) ||
        pathname === "/"
      ) {
        return "/dashboard";
      }
      return null;
    default:
      return null; // initializing / loadingUserDoc はローディング表示
  }
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { phase } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const redirectTo = requiredPathFor(phase, pathname);

  useEffect(() => {
    if (redirectTo) router.replace(redirectTo);
  }, [redirectTo, router]);

  // Auth初期化中・ユーザードキュメント取得中は画面を一切出さない
  if (phase === "initializing" || phase === "loadingUserDoc") {
    return <FullScreenLoading label="認証情報を確認しています…" />;
  }

  // リダイレクト待ちの間も対象画面を出さない
  if (redirectTo) {
    return <FullScreenLoading label="画面を移動しています…" />;
  }

  return <>{children}</>;
}

function FullScreenLoading({ label }: { label: string }) {
  return (
    <div className="fullscreen-center">
      <div className="loading-block">
        <div className="spinner" aria-hidden />
        <p>{label}</p>
      </div>
    </div>
  );
}
