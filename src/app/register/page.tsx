"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { authErrorMessage, registerUser } from "@/services/userService";

export default function RegisterPage() {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== password2) {
      setError("パスワードが一致しません");
      return;
    }
    setBusy(true);
    try {
      await registerUser(email.trim(), password, displayName);
      // 登録後は pending 状態になり、AuthGate が /pending へ遷移させる
    } catch (err) {
      setError(authErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="fullscreen-center">
      <div className="auth-card">
        <div className="brand">CAST MANAGER</div>
        <h1>利用申請</h1>
        <p className="sub">
          申請後、オーナーの承認が完了するとアプリを利用できます
        </p>

        {error && <div className="error-box">{error}</div>}

        <form onSubmit={onSubmit}>
          <div className="form-group">
            <label htmlFor="displayName">表示名</label>
            <input
              id="displayName"
              className="form-input"
              type="text"
              placeholder="例: 田中"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="email">メールアドレス</label>
            <input
              id="email"
              className="form-input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">パスワード（6文字以上）</label>
            <input
              id="password"
              className="form-input"
              type="password"
              autoComplete="new-password"
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="password2">パスワード（確認）</label>
            <input
              id="password2"
              className="form-input"
              type="password"
              autoComplete="new-password"
              minLength={6}
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              required
            />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? "申請中…" : "利用を申請する"}
          </button>
        </form>

        <p style={{ marginTop: 20, fontSize: 12, color: "var(--text3)" }}>
          既にアカウントをお持ちの方は <Link href="/login">ログイン</Link>
        </p>
      </div>
    </div>
  );
}
