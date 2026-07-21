import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import {
  connectFirestoreEmulator,
  getFirestore,
  type Firestore,
} from "firebase/firestore";
import {
  connectFunctionsEmulator,
  getFunctions,
  type Functions,
} from "firebase/functions";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

function assertConfig(): void {
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    throw new Error(
      "Firebase設定が読み込めません。.env.local に NEXT_PUBLIC_FIREBASE_* を設定してください。"
    );
  }
}

let app: FirebaseApp;
let authInstance: Auth;
let dbInstance: Firestore;
let functionsInstance: Functions;
// 各サービスごとに接続済みかを個別に管理する（PR6で修正）。
// 以前は3サービス共通の1つのフラグで管理しており、authInstanceだけが
// 先に生成された時点で一度 connectAuthEmulator を呼んでしまうと、
// 後からdbInstanceが生成された際の再呼び出しで connectAuthEmulator が
// （既に接続済みのため）例外を投げ、その後続にある
// connectFirestoreEmulator の呼び出しまで一緒にスキップされてしまう
// 不具合があった（Firestoreだけエミュレータへ接続されず本番へ流れる）。
let authEmulatorConnected = false;
let dbEmulatorConnected = false;
let functionsEmulatorConnected = false;

export function getFirebaseApp(): FirebaseApp {
  if (!app) {
    assertConfig();
    app = getApps()[0] ?? initializeApp(firebaseConfig);
  }
  return app;
}

export function getFirebaseAuth(): Auth {
  if (!authInstance) {
    authInstance = getAuth(getFirebaseApp());
    maybeConnectEmulators();
  }
  return authInstance;
}

export function getDb(): Firestore {
  if (!dbInstance) {
    dbInstance = getFirestore(getFirebaseApp());
    maybeConnectEmulators();
  }
  return dbInstance;
}

/**
 * Cloud Functions（PR5: ユーザー承認・権限変更・無効化・
 * accessibleStoreIds設定）呼び出し用。リージョンはFirestore/Authと
 * 同じデフォルトプロジェクト設定に従う。
 */
export function getFunctionsInstance(): Functions {
  if (!functionsInstance) {
    functionsInstance = getFunctions(getFirebaseApp());
    maybeConnectEmulators();
  }
  return functionsInstance;
}

/**
 * 生成済みの各インスタンスをエミュレータへ接続する。
 * サービスごとに独立して一度だけ試行するため、いずれかの接続呼び出しが
 * 失敗（例外）しても他のサービスの接続には影響しない。
 */
function maybeConnectEmulators(): void {
  if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== "true") return;
  if (typeof window === "undefined") return;

  if (authInstance && !authEmulatorConnected) {
    authEmulatorConnected = true;
    try {
      connectAuthEmulator(authInstance, "http://127.0.0.1:9099", { disableWarnings: true });
    } catch {
      // 既に接続済みの場合は無視
    }
  }
  if (dbInstance && !dbEmulatorConnected) {
    dbEmulatorConnected = true;
    try {
      connectFirestoreEmulator(dbInstance, "127.0.0.1", 8080);
    } catch {
      // 既に接続済みの場合は無視
    }
  }
  if (functionsInstance && !functionsEmulatorConnected) {
    functionsEmulatorConnected = true;
    try {
      connectFunctionsEmulator(functionsInstance, "127.0.0.1", 5001);
    } catch {
      // 既に接続済みの場合は無視
    }
  }
}
