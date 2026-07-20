import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type Unsubscribe,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import {
  INITIAL_STORES,
  type StoreDoc,
  type StoreWithId,
  type WagePolicy,
} from "@/types";

const STORES = "stores";

/** 店舗一覧を購読する（order昇順で返す） */
export function subscribeStores(
  onChange: (stores: StoreWithId[]) => void,
  onError: (message: string) => void
): Unsubscribe {
  return onSnapshot(
    collection(getDb(), STORES),
    (snap) => {
      const stores = snap.docs.map((d) => ({ id: d.id, ...(d.data() as StoreDoc) }));
      stores.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      onChange(stores);
    },
    (err) => onError(err.message)
  );
}

export interface StoreInput {
  name: string;
  code: string;
  color: string;
  active: boolean;
  order: number;
  /** 給与運用ルール（PR5・設定のみ。現在の計算・動作には影響しない） */
  wagePolicy: WagePolicy;
}

export function validateStoreInput(input: StoreInput): string | null {
  if (!input.name.trim()) return "店舗名を入力してください";
  if (!input.code.trim()) return "店舗コードを入力してください";
  if (!/^[a-z0-9_-]+$/.test(input.code)) {
    return "店舗コードは半角英小文字・数字・ハイフンのみ使用できます";
  }
  if (!Number.isFinite(input.order)) return "表示順は数値で入力してください";
  return null;
}

/** 店舗を新規作成する（owner専用・Rulesでも制限） */
export async function createStore(
  actorUid: string,
  storeId: string,
  input: StoreInput
): Promise<void> {
  const err = validateStoreInput(input);
  if (err) throw new Error(err);
  await setDoc(doc(getDb(), STORES, storeId), {
    name: input.name.trim(),
    code: input.code.trim(),
    color: input.color,
    active: input.active,
    order: input.order,
    wagePolicy: input.wagePolicy,
    createdAt: serverTimestamp(),
    createdBy: actorUid,
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  });
}

/** 店舗を更新する（owner専用） */
export async function updateStore(
  actorUid: string,
  storeId: string,
  input: Partial<StoreInput>
): Promise<void> {
  await updateDoc(doc(getDb(), STORES, storeId), {
    ...input,
    ...(input.name != null ? { name: input.name.trim() } : {}),
    ...(input.code != null ? { code: input.code.trim() } : {}),
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  });
}

/** 有効/無効を切り替える（owner専用） */
export async function setStoreActive(
  actorUid: string,
  storeId: string,
  active: boolean
): Promise<void> {
  await updateDoc(doc(getDb(), STORES, storeId), {
    active,
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  });
}

/**
 * 初期店舗（VIRGO / REGINA）を一括作成する（owner専用）。
 * 既存の店舗がある場合は上書きせずスキップする想定で、
 * 呼び出し側で stores が空のときのみ表示・実行すること。
 */
export async function seedInitialStores(actorUid: string): Promise<void> {
  const db = getDb();
  const batch = writeBatch(db);
  for (const s of INITIAL_STORES) {
    batch.set(doc(db, STORES, s.id), {
      name: s.name,
      code: s.code,
      color: s.color,
      active: true,
      order: s.order,
      wagePolicy: s.wagePolicy,
      createdAt: serverTimestamp(),
      createdBy: actorUid,
      updatedAt: serverTimestamp(),
      updatedBy: actorUid,
    });
  }
  await batch.commit();
}
