"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { ROLE_LABELS, isOwner } from "@/types";

export function AppHeader() {
  const { userDoc, signOutUser } = useAuth();
  const pathname = usePathname();
  const owner = isOwner(userDoc);

  const nav = [
    { href: "/dashboard", label: "ダッシュボード" },
    { href: "/casts", label: "キャスト" },
    { href: "/monthly", label: "月別成績" },
    { href: "/ranking", label: "ランキング" },
    ...(owner ? [{ href: "/stores", label: "店舗管理" }] : []),
    ...(owner ? [{ href: "/admin/users", label: "ユーザー管理" }] : []),
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
