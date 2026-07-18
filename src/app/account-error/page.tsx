"use client";

import { useAuth } from "@/contexts/AuthContext";

export default function AccountErrorPage() {
  const { phase, firebaseUser, userDocError, signOutUser } = useAuth();

  return (
    <div className="fullscreen-center">
      <div className="auth-card">
        <div className="brand">CAST MANAGER</div>
        <h1>アカウント情報を確認できません</h1>
        <p className="sub">{firebaseUser?.email}</p>

        <div className="error-box">
          {phase === "noUserDoc"
            ? "ユーザー情報が見つかりません。登録が正しく完了していない可能性があります。オーナーにお問い合わせいただくか、再度利用申請を行ってください。"
            : `ユーザー情報の取得に失敗しました。通信環境を確認して再読み込みしてください。（${userDocError ?? "不明なエラー"}）`}
        </div>

        <button
          className="btn btn-ghost btn-block"
          style={{ marginTop: 8 }}
          onClick={() => window.location.reload()}
        >
          再読み込み
        </button>
        <button
          className="btn btn-ghost btn-block"
          style={{ marginTop: 8 }}
          onClick={() => void signOutUser()}
        >
          ログアウト
        </button>
      </div>
    </div>
  );
}
