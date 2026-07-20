/** Blobをファイルとしてダウンロードさせる（iPhone Safari対応: aタグ+click） */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Safariで即時revokeするとダウンロードが失敗することがあるため遅延させる
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function downloadJson(data: unknown, fileName: string): void {
  downloadBlob(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    fileName
  );
}

export function timestampedFileName(base: string, ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${base}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}
