"use client";

import { useAuth } from "@/contexts/AuthContext";

export default function DisabledPage() {
  const { userDoc, signOutUser } = useAuth();

  return (
    <div className="fullscreen-center">
      <div className="auth-card">
        <div className="brand">CAST MANAGER</div>
        <h1>アカウントが無効です</h1>
        <p className="sub">{userDoc?.email}</p>

        <div className="info-box">
          このアカウントは現在無効化されています。
          <br />
          利用を再開するには、オーナーにお問い合わせください。
        </div>

        <button
          className="btn btn-ghost btn-block"
          style={{ marginTop: 20 }}
          onClick={() => void signOutUser()}
        >
          ログアウト
        </button>
      </div>
    </div>
  );
}
