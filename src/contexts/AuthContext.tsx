"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc, onSnapshot, type FirestoreError } from "firebase/firestore";
import { getDb, getFirebaseAuth } from "@/lib/firebase";
import type { UserDoc } from "@/types";

/**
 * 認証状態。画面表示前に必ずいずれかへ確定させる。
 * - initializing:     Firebase Auth の初期化中（この間は画面を出さない）
 * - signedOut:        未ログイン
 * - loadingUserDoc:   ログイン済みだが users/{uid} 取得中（この間も画面を出さない）
 * - pending:          承認待ち
 * - approved:         承認済み（アプリ利用可）
 * - disabled:         無効化済み
 * - noUserDoc:        Authにはいるが users/{uid} が存在しない（承認扱いにしない）
 * - error:            users/{uid} の取得エラー（承認扱いにしない）
 */
export type AuthPhase =
  | "initializing"
  | "signedOut"
  | "loadingUserDoc"
  | "pending"
  | "approved"
  | "disabled"
  | "noUserDoc"
  | "error";

export interface AuthState {
  phase: AuthPhase;
  firebaseUser: User | null;
  userDoc: UserDoc | null;
  userDocError: string | null;
  signOutUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<AuthPhase>("initializing");
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [userDoc, setUserDoc] = useState<UserDoc | null>(null);
  const [userDocError, setUserDocError] = useState<string | null>(null);

  useEffect(() => {
    const auth = getFirebaseAuth();
    let unsubUserDoc: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, (user) => {
      // 前のユーザードキュメント購読を解除
      if (unsubUserDoc) {
        unsubUserDoc();
        unsubUserDoc = null;
      }

      if (!user) {
        setFirebaseUser(null);
        setUserDoc(null);
        setUserDocError(null);
        setPhase("signedOut");
        return;
      }

      setFirebaseUser(user);
      setUserDoc(null);
      setUserDocError(null);
      setPhase("loadingUserDoc");

      const ref = doc(getDb(), "users", user.uid);
      unsubUserDoc = onSnapshot(
        ref,
        (snap) => {
          if (!snap.exists()) {
            // ユーザードキュメント不在 → 承認扱いにしない
            setUserDoc(null);
            setPhase("noUserDoc");
            return;
          }
          const data = snap.data() as UserDoc;
          setUserDoc(data);
          if (data.status === "approved") setPhase("approved");
          else if (data.status === "disabled") setPhase("disabled");
          else setPhase("pending");
        },
        (err: FirestoreError) => {
          // 取得エラー → 承認扱いにしない
          setUserDoc(null);
          setUserDocError(err.message);
          setPhase("error");
        }
      );
    });

    return () => {
      unsubAuth();
      if (unsubUserDoc) unsubUserDoc();
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      phase,
      firebaseUser,
      userDoc,
      userDocError,
      signOutUser: async () => {
        await signOut(getFirebaseAuth());
      },
    }),
    [phase, firebaseUser, userDoc, userDocError]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth は AuthProvider の内側で使用してください");
  return ctx;
}
