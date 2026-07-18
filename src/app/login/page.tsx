"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { authErrorMessage, loginUser } from "@/services/userService";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await loginUser(email.trim(), password);
      // 遷移は AuthGate が phase に応じて行う
    } catch (err) {
      setError(authErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="fullscreen-center">
      <div className="auth-card">
        <div className="brand">CAST MANAGER</div>
        <h1>ログイン</h1>
        <p className="sub">登録済みのメールアドレスでログインしてください</p>

        {error && <div className="error-box">{error}</div>}

        <form onSubmit={onSubmit}>
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
            <label htmlFor="password">パスワード</label>
            <input
              id="password"
              className="form-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? "ログイン中…" : "ログイン"}
          </button>
        </form>

        <p style={{ marginTop: 20, fontSize: 12, color: "var(--text3)" }}>
          アカウントをお持ちでない方は{" "}
          <Link href="/register">利用申請はこちら</Link>
        </p>
      </div>
    </div>
  );
}
