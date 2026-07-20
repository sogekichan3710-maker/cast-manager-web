"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { AppHeader } from "@/components/AppHeader";
import { useStores } from "@/hooks/useStores";
import { fetchExportData } from "@/services/exportService";
import { exportBackupJson } from "@/services/backupService";
import { buildExportWorkbook, workbookToArrayBuffer } from "@/lib/excel/exportExcel";
import { downloadBlob, downloadJson, timestampedFileName } from "@/lib/download";
import { ALL_STORES_FILTER, currentMonth, isAdminOrAbove, isOwner } from "@/types";

/**
 * データエクスポート。
 * - Excelエクスポート: owner / 許可されたadmin（viewerは不可・画面自体に入れない）
 * - JSONバックアップ: owner専用
 * 「全店舗」を選んだ場合も閲覧可能店舗のみが対象になる。
 */
export default function ExportPage() {
  const { firebaseUser, userDoc } = useAuth();
  const canExport = isAdminOrAbove(userDoc);
  const owner = isOwner(userDoc);
  const router = useRouter();
  const { accessibleStores } = useStores();

  const [storeSel, setStoreSel] = useState<string>(ALL_STORES_FILTER);
  const [fromMonth, setFromMonth] = useState("");
  const [toMonth, setToMonth] = useState(currentMonth());
  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  useEffect(() => {
    if (userDoc && !canExport) router.replace("/dashboard");
  }, [userDoc, canExport, router]);

  const targetStoreIds = useMemo(
    () =>
      storeSel === ALL_STORES_FILTER
        ? accessibleStores.map((s) => s.id) // 全店舗=閲覧可能店舗のみ
        : [storeSel],
    [storeSel, accessibleStores]
  );

  if (!canExport) return null;

  async function onExportExcel() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDoneMsg(null);
    try {
      if (fromMonth && toMonth && fromMonth > toMonth) {
        throw new Error("期間の開始月が終了月より後になっています");
      }
      const data = await fetchExportData(targetStoreIds, fromMonth, toMonth, setProgressLabel);
      setProgressLabel("Excelを作成中…");
      const wb = buildExportWorkbook({ stores: accessibleStores, ...data });
      const buf = workbookToArrayBuffer(wb);
      downloadBlob(
        new Blob([buf], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        timestampedFileName("cast-manager_export", "xlsx")
      );
      setDoneMsg(
        `エクスポートしました（キャスト ${data.casts.length} / 月別成績 ${data.monthlyResults.length} / 面談 ${data.interviews.length} / 目標 ${data.goals.length} / モチベーション ${data.motivations.length} / 時給履歴 ${data.wageHistory.length}）`
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgressLabel(null);
      setBusy(false);
    }
  }

  async function onBackupJson() {
    if (backupBusy || !firebaseUser) return;
    setBackupBusy(true);
    setBackupError(null);
    setBackupMsg(null);
    try {
      const backup = await exportBackupJson(firebaseUser.uid, userDoc?.displayName ?? "", (name) =>
        setBackupMsg(`${name} を取得中…`)
      );
      downloadJson(backup, timestampedFileName("cast-manager_backup", "json"));
      const counts = Object.entries(backup.counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(" / ");
      setBackupMsg(`バックアップを保存しました（${counts}）`);
    } catch (err) {
      setBackupError((err as Error).message);
      setBackupMsg(null);
    } finally {
      setBackupBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <div className="page-head">
          <div>
            <h1 className="page-title">データエクスポート</h1>
            <p className="page-sub">Excel出力（会社提出用）とJSONバックアップ</p>
          </div>
        </div>

        <section className="section-card" style={{ marginBottom: 16 }}>
          <h2 style={{ marginBottom: 10 }}>Excelエクスポート</h2>
          <p className="page-sub" style={{ marginBottom: 10 }}>
            シート: キャスト一覧 / 月別成績 / 面談履歴 / 目標 / モチベーション / 時給履歴
          </p>
          <div className="filter-bar">
            <select
              className="form-input"
              value={storeSel}
              onChange={(e) => setStoreSel(e.target.value)}
              disabled={busy}
            >
              <option value={ALL_STORES_FILTER}>全店舗（閲覧可能な店舗のみ）</option>
              {accessibleStores.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <input
              className="form-input"
              type="month"
              value={fromMonth}
              onChange={(e) => setFromMonth(e.target.value)}
              disabled={busy}
              placeholder="開始月"
            />
            <span style={{ alignSelf: "center" }}>〜</span>
            <input
              className="form-input"
              type="month"
              value={toMonth}
              onChange={(e) => setToMonth(e.target.value)}
              disabled={busy}
              placeholder="終了月"
            />
          </div>
          <p className="page-sub" style={{ marginBottom: 10 }}>
            期間はキャスト一覧以外のシートに適用されます（開始月を空にすると全期間）
          </p>
          <button className="btn btn-primary" onClick={() => void onExportExcel()} disabled={busy}>
            {busy ? "エクスポート中…" : "Excelをダウンロード"}
          </button>
          {progressLabel && <p className="progress-note">{progressLabel}</p>}
          {error && <div className="error-box" style={{ marginTop: 10 }}>{error}</div>}
          {doneMsg && <div className="info-box" style={{ marginTop: 10 }}>{doneMsg}</div>}
        </section>

        {owner && (
          <section className="section-card">
            <h2 style={{ marginBottom: 10 }}>JSONバックアップ（オーナー専用）</h2>
            <p className="page-sub" style={{ marginBottom: 10 }}>
              stores / casts / monthlyResults / interviews / goals / motivations /
              wageHistory / nameMatchingRules / importBatches を1つのJSONに出力します。
              ユーザー情報・認証情報は含まれません。
            </p>
            <button className="btn btn-ghost" onClick={() => void onBackupJson()} disabled={backupBusy}>
              {backupBusy ? "バックアップ中…" : "JSONバックアップをダウンロード"}
            </button>
            {backupMsg && <p className="progress-note">{backupMsg}</p>}
            {backupError && <div className="error-box" style={{ marginTop: 10 }}>{backupError}</div>}
          </section>
        )}
      </main>
    </div>
  );
}
