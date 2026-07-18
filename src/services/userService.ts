import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { getDb, getFirebaseAuth } from "@/lib/firebase";

/**
 * 新規利用申請。
 * Firebase Auth アカウントを作成し、users/{uid} を
 * role: 'viewer' / status: 'pending' で作成する。
 * role や status を外から指定することはできない（Firestore Rulesでも強制）。
 */
export async function registerUser(
  email: string,
  password: string,
  displayName: string
): Promise<void> {
  const auth = getFirebaseAuth();
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;

  await setDoc(doc(getDb(), "users", uid), {
    email,
    displayName: displayName.trim() || email,
    role: "viewer",
    status: "pending",
    accessibleStoreIds: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    approvedAt: null,
    approvedBy: null,
    disabledAt: null,
  });
}

export async function loginUser(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
}

/** Firebase Auth のエラーコードを日本語メッセージへ変換 */
export function authErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "auth/invalid-email":
      return "メールアドレスの形式が正しくありません";
    case "auth/email-already-in-use":
      return "このメールアドレスは既に登録されています";
    case "auth/weak-password":
      return "パスワードは6文字以上にしてください";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "メールアドレスまたはパスワードが正しくありません";
    case "auth/too-many-requests":
      return "試行回数が多すぎます。しばらく待ってから再度お試しください";
    default:
      return (err as Error)?.message || "エラーが発生しました";
  }
}
