"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { ROLE_LABELS, isAdminOrAbove, isOwner } from "@/types";

export function AppHeader() {
  const { userDoc, signOutUser } = useAuth();
  const pathname = usePathname();
  const owner = isOwner(userDoc);
  const adminOrAbove = isAdminOrAbove(userDoc);

  // 権限に応じた表示制御（Rules側でも同じ制限を強制する二重防御）
  const nav = [
    { href: "/dashboard", label: "ダッシュボード" },
    { href: "/casts", label: "キャスト" },
    { href: "/monthly", label: "月別成績" },
    { href: "/ranking", label: "ランキング" },
    ...(adminOrAbove ? [{ href: "/import", label: "Excelインポート" }] : []),
    ...(adminOrAbove ? [{ href: "/import/history", label: "インポート履歴" }] : []),
    ...(adminOrAbove ? [{ href: "/export", label: "データエクスポート" }] : []),
    ...(owner ? [{ href: "/admin/migration", label: "データ移行" }] : []),
    ...(owner ? [{ href: "/stores", label: "店舗管理" }] : []),
    ...(owner ? [{ href: "/admin/users", label: "ユーザー管理" }] : []),
    ...(owner ? [{ href: "/admin/audit", label: "監査ログ" }] : []),
  ];

  return (
    <header className="app-header">
      <div style={{ display: "flex", alignItems: "center", gap: 18, minWidth: 0 }}>
        <span className="title">CAST MANAGER</span>
        <nav className="header-nav">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={pathname.startsWith(n.href) ? "nav-link active" : "nav-link"}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <span className="me">
          {userDoc?.displayName}
          <span style={{ opacity: 0.7 }}>
            （{userDoc ? ROLE_LABELS[userDoc.role] : ""}）
          </span>
        </span>
        <button className="btn btn-ghost btn-sm" onClick={() => void signOutUser()}>
          ログアウト
        </button>
      </div>
    </header>
  );
}
