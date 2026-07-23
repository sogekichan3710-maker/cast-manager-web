"use client";

import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { deleteInterview } from "@/services/recordService";
import { isAdminOrAbove } from "@/types";

/**
 * 面談履歴の削除ボタン（Owner/Admin専用）。
 * キャスト詳細・ダッシュボードの各面談アラート一覧など、面談履歴を
 * 表示するすべての画面で同一の削除処理（recordService.deleteInterview）
 * を使うための共通コンポーネント。
 */
export function DeleteInterviewButton({
  interviewId,
  onError,
  className = "btn btn-danger btn-sm",
}: {
  interviewId: string;
  onError?: (message: string) => void;
  className?: string;
}) {
  const { firebaseUser, userDoc } = useAuth();
  const canEdit = isAdminOrAbove(userDoc);
  const [deleting, setDeleting] = useState(false);

  if (!canEdit) return null;

  async function onClick() {
    if (!firebaseUser || deleting) return;
    if (!window.confirm("この面談履歴を削除しますか？\nこの操作は元に戻せません。")) return;
    setDeleting(true);
    try {
      await deleteInterview(firebaseUser.uid, userDoc?.displayName ?? "", interviewId);
    } catch (err) {
      onError?.((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <button className={className} disabled={deleting} onClick={() => void onClick()}>
      {deleting ? "削除中…" : "削除"}
    </button>
  );
}
