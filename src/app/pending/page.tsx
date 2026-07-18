"use client";

import { useAuth } from "@/contexts/AuthContext";

export default function PendingPage() {
  const { userDoc, signOutUser } = useAuth();

  return (
    <div className="fullscreen-center">
      <div className="auth-card">
        <div className="brand">CAST MANAGER</div>
        <h1>承認待ちです</h1>
        <p className="sub">{userDoc?.email}</p>

        <div className="info-box">
          利用申請を受け付けました。
          <br />
          オーナーが承認するとアプリを利用できるようになります。
          <br />
          承認されるまでお待ちください。
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
