"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { AppHeader } from "@/components/AppHeader";
import { useStores } from "@/hooks/useStores";
import { isOwner, type MigrationRunWithId, type RunStatus } from "@/types";
import { parseLegacyData } from "@/lib/migration/parseLegacyData";
import { validateLegacyData, type MigrationPreview } from "@/lib/migration/validateLegacyData";
import type { ConversionIssue } from "@/lib/migration/convertLegacyData";
import {
  executeMigration,
  subscribeMigrationRuns,
  type MigrationProgress,
  type MigrationResultSummary,
} from "@/services/migrationService";
import { downloadBlob, timestampedFileName } from "@/lib/download";

/**
 * 旧ローカルデータ移行ウィザード（owner専用）。
 * 旧index.html の exportFullJSON（localStorage 'cm2_v4'）で出力したJSONを読み込み、
 * プレビュー（件数・不正データ・重複候補・孤立データ等）を確認したうえで
 * 明示的に実行した場合のみFirestoreへ書き込む。自動移行は一切行わない。
 */
export default function MigrationPage() {
  const { firebaseUser, userDoc } = useAuth();
  const owner = isOwner(userDoc);
  const router = useRouter();
  const { stores } = useStores();

  const [fileName, setFileName] = useState<string>("");
  const [rawText, setRawText] = useState<string>("");
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [backupDone, setBackupDone] = useState(false);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [result, setResult] = useState<MigrationResultSummary | null>(null);
  const cancelRef = useRef(false);

  const [runs, setRuns] = useState<MigrationRunWithId[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);

  useEffect(() => {
    if (userDoc && !owner) router.replace("/dashboard");
  }, [userDoc, owner, router]);

  useEffect(() => {
    if (!owner) return;
    return subscribeMigrationRuns(setRuns, setRunsError);
  }, [owner]);

  const existingStoreIds = useMemo(() => stores.map((s) => s.id), [stores]);

  if (!owner) return null;

  function onFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同じファイルの再選択を許可
    if (!file) return;
    setPreview(null);
    setParseError(null);
    setResult(null);
    setBackupDone(false);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setRawText(text);
      try {
        const legacy = parseLegacyData(text);
        setPreview(validateLegacyData(legacy, existingStoreIds));
      } catch (err) {
        setParseError((err as Error).message);
      }
    };
    reader.onerror = () => setParseError("ファイルの読み込みに失敗しました");
    reader.readAsText(file);
  }

  function onDownloadBackup() {
    // 読み込んだ元JSONをそのまま（変換前の原本として）保存する
    downloadBlob(
      new Blob([rawText], { type: "application/json" }),
      timestampedFileName(`backup_original_${fileName.replace(/\.json$/i, "")}`, "json")
    );
    setBackupDone(true);
  }

  async function onExecute() {
    if (!firebaseUser || !preview || running) return;
    const c = preview.counts;
    const total =
      c.stores + c.casts + c.monthlyResults + c.interviews + c.goals +
      c.motivations + c.wageHistory + c.nameMatchingRules;
    if (
      !window.confirm(
        `${total}件のデータをFirestoreへ移行します。\n` +
          "既にFirestoreに存在するデータは変更されずスキップされます。\n" +
          "実行しますか？"
      )
    ) {
      return;
    }
    cancelRef.current = false;
    setRunning(true);
    setResult(null);
    setProgress(null);
    try {
      const res = await executeMigration(
        firebaseUser.uid,
        userDoc?.displayName ?? "",
        fileName,
        preview.conversion,
        setProgress,
        () => cancelRef.current
      );
      setResult(res);
    } catch (err) {
      setResult({
        migrationId: "",
        status: "failed",
        created: 0,
        updated: 0,
        skipped: 0,
        errors: 1,
        errorMessages: [(err as Error).message],
        byCollection: {},
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <div className="page-head">
          <div>
            <h1 className="page-title">旧ローカルデータ移行</h1>
            <p className="page-sub">
              旧HTML版（exportFullJSON / cm2_v4）のJSONを読み込み、Firestoreへ移行します（オーナー専用）
            </p>
          </div>
        </div>

        <div className="info-box" style={{ marginBottom: 16 }}>
          移行はプレビューを確認し「移行を実行」を押した場合のみ行われます。
          既にFirestoreに存在するデータは変更せずスキップするため、同じファイルを
          複数回読み込んでも二重登録されません。実行前に元JSONのバックアップを
          ダウンロードしてください。
        </div>

        <section className="section-card" style={{ marginBottom: 16 }}>
          <h2 style={{ marginBottom: 10 }}>1. JSONファイルを選択</h2>
          <input
            type="file"
            accept=".json,application/json,text/plain"
            onChange={onFileSelected}
            disabled={running}
          />
          {fileName && <p className="page-sub" style={{ marginTop: 8 }}>選択中: {fileName}</p>}
          {parseError && <div className="error-box" style={{ marginTop: 10 }}>{parseError}</div>}
        </section>

        {preview && (
          <>
            <section className="section-card" style={{ marginBottom: 16 }}>
              <h2 style={{ marginBottom: 4 }}>2. 移行プレビュー</h2>
              <p className="page-sub" style={{ marginBottom: 10 }}>
                形式: {preview.sourceFormat} ／ 件数は変換後に移行対象となる数です
                （旧importBatches {preview.rawCounts.importBatches}件は移行対象外・参考）
              </p>
              <div className="table-wrap">
                <table className="data-table">
                  <tbody>
                    <CountRow label="キャスト" value={preview.counts.casts} raw={preview.rawCounts.casts} />
                    <CountRow label="月別成績" value={preview.counts.monthlyResults} raw={preview.rawCounts.monthlyResults} />
                    <CountRow
                      label="面談（旧interviews + 旧castRecords）"
                      value={preview.counts.interviews}
                      raw={preview.rawCounts.interviews + preview.rawCounts.castRecords}
                    />
                    <CountRow label="目標" value={preview.counts.goals} raw={preview.rawCounts.goals} />
                    <CountRow label="モチベーション" value={preview.counts.motivations} raw={preview.rawCounts.motivationLogs} />
                    <CountRow label="時給履歴" value={preview.counts.wageHistory} raw={preview.rawCounts.wageHistory} />
                    <CountRow label="店舗" value={preview.counts.stores} raw={preview.rawCounts.stores} />
                    <CountRow label="nameMatchingRules" value={preview.counts.nameMatchingRules} raw={preview.rawCounts.nameMatchingRules} />
                    <CountRow label="重複候補" value={preview.counts.duplicates} warn />
                    <CountRow label="不正データ（除外）" value={preview.counts.invalid} warn />
                    <CountRow label="孤立データ（参照先キャスト不在・除外）" value={preview.counts.orphans} warn />
                    <CountRow label="storeId不明（除外・別店舗へ統合しません）" value={preview.counts.unknownStore} warn />
                    <CountRow label="月形式を変換できない（除外）" value={preview.counts.badMonth} warn />
                  </tbody>
                </table>
              </div>

              <IssueDetails title="重複候補の詳細" issues={preview.issues.duplicates} />
              <IssueDetails title="不正データの詳細" issues={preview.issues.invalid} />
              <IssueDetails title="孤立データの詳細" issues={preview.issues.orphans} />
              <IssueDetails title="storeId不明の詳細" issues={preview.issues.unknownStore} />
              <IssueDetails title="月形式エラーの詳細" issues={preview.issues.badMonth} />
              <IssueDetails title="警告（移行はされます）" issues={preview.issues.warnings} />

              {preview.conversion.idMap.length > 0 && (
                <details style={{ marginTop: 10 }}>
                  <summary>旧ID→新IDの対応表（{preview.conversion.idMap.length}件）</summary>
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table className="data-table">
                      <thead>
                        <tr><th>コレクション</th><th>旧ID</th><th>新ID</th><th>理由</th></tr>
                      </thead>
                      <tbody>
                        {preview.conversion.idMap.map((m, i) => (
                          <tr key={i}>
                            <td>{m.collection}</td>
                            <td style={{ wordBreak: "break-all" }}>{m.legacyId}</td>
                            <td style={{ wordBreak: "break-all" }}>{m.newId}</td>
                            <td>{m.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </section>

            <section className="section-card" style={{ marginBottom: 16 }}>
              <h2 style={{ marginBottom: 10 }}>3. 元JSONのバックアップ</h2>
              <button className="btn btn-ghost" onClick={onDownloadBackup} disabled={!rawText || running}>
                読み込んだ元JSONをダウンロード
              </button>
              {backupDone && <span className="badge badge-green" style={{ marginLeft: 10 }}>保存済み</span>}
            </section>

            <section className="section-card" style={{ marginBottom: 16 }}>
              <h2 style={{ marginBottom: 10 }}>4. 移行を実行</h2>
              {!backupDone && (
                <p className="page-sub" style={{ marginBottom: 10 }}>
                  実行前に上のバックアップをダウンロードしてください。
                </p>
              )}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  className="btn btn-primary"
                  onClick={() => void onExecute()}
                  disabled={running || !backupDone}
                >
                  {running ? "移行中…" : "移行を実行"}
                </button>
                {running && (
                  <button className="btn btn-ghost" onClick={() => { cancelRef.current = true; }}>
                    キャンセル（次のバッチ前に安全に停止）
                  </button>
                )}
              </div>

              {progress && (
                <div style={{ marginTop: 12 }}>
                  <p>
                    {progress.phase} — {progress.done} / {progress.total} 件
                    （作成 {progress.created} / スキップ {progress.skipped} / エラー {progress.errors}）
                  </p>
                </div>
              )}

              {result && (
                <div
                  className={result.status === "completed" ? "info-box" : "error-box"}
                  style={{ marginTop: 12 }}
                >
                  <strong>
                    {result.status === "completed" && "移行が完了しました"}
                    {result.status === "cancelled" && "移行を中断しました（再実行すると続きから安全に移行できます）"}
                    {result.status === "failed" && "移行がエラーで停止しました（成功済み分は再実行時にスキップされます）"}
                  </strong>
                  <p style={{ marginTop: 6 }}>
                    作成 {result.created} / 更新 {result.updated} / スキップ {result.skipped} / エラー {result.errors}
                  </p>
                  {Object.entries(result.byCollection).map(([col, v]) => (
                    <p key={col} className="page-sub">
                      {col}: 作成 {v.created} / スキップ {v.skipped}
                    </p>
                  ))}
                  {result.errorMessages.map((m, i) => (
                    <p key={i} style={{ marginTop: 6 }}>{m}</p>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        <section className="section-card">
          <h2 style={{ marginBottom: 10 }}>移行実行履歴</h2>
          {runsError && <div className="error-box">{runsError}</div>}
          {runs.length === 0 ? (
            <p className="page-sub">まだ移行は実行されていません</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>開始</th>
                    <th>ファイル</th>
                    <th>形式</th>
                    <th>状態</th>
                    <th>結果</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>{r.startedAt ? r.startedAt.toDate().toLocaleString("ja-JP") : "-"}</td>
                      <td style={{ wordBreak: "break-all" }}>{r.fileName}</td>
                      <td>{r.sourceFormat}</td>
                      <td><RunStatusBadge status={r.status} /></td>
                      <td>{r.summary || "-"}{r.errorSummary ? ` / ${r.errorSummary.split("\n")[0]}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function CountRow({
  label,
  value,
  raw,
  warn,
}: {
  label: string;
  value: number;
  raw?: number;
  warn?: boolean;
}) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">
        {warn && value > 0 ? (
          <span className="badge badge-orange">{value}件</span>
        ) : (
          `${value}件`
        )}
        {raw !== undefined && raw !== value && (
          <span className="dim">（元データ {raw}件）</span>
        )}
      </td>
    </tr>
  );
}

function IssueDetails({ title, issues }: { title: string; issues: ConversionIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <details style={{ marginTop: 10 }}>
      <summary>
        {title}（{issues.length}件）
      </summary>
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table className="data-table">
          <thead>
            <tr><th>コレクション</th><th>対象</th><th>内容</th></tr>
          </thead>
          <tbody>
            {issues.map((it, i) => (
              <tr key={i}>
                <td>{it.collection}</td>
                <td style={{ wordBreak: "break-all" }}>{it.label}{it.legacyId ? ` (${it.legacyId})` : ""}</td>
                <td>{it.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function RunStatusBadge({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, { cls: string; label: string }> = {
    processing: { cls: "badge-yellow", label: "実行中" },
    completed: { cls: "badge-green", label: "完了" },
    failed: { cls: "badge-red", label: "失敗" },
    cancelled: { cls: "badge-gray", label: "中断" },
    "partial-cancelled": { cls: "badge-orange", label: "一部保存で中断" },
  };
  const m = map[status] ?? { cls: "badge-gray", label: status };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}
