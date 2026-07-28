import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import { normalizeName } from "@/lib/nameNormalize";
import {
  monthlyResultId,
  nameMatchingRuleId,
  type CastDoc,
  type CastWithId,
  type MonthlyResultDoc,
  type NameMatchingRuleWithId,
} from "@/types";

/**
 * 売上不一致調査（ランキング金額の不一致報告）用の診断サービス。
 *
 * 「ランキングに表示されている値」「Excel再インポートで実際に書き込まれる先」
 * 「Firestoreに保存されている生の値」を1画面で突き合わせられるようにする。
 * すべて読み取り専用（Firestoreへの書き込みは一切行わない）。
 *
 * 同一店舗内に同じ源氏名のキャストが複数（アーカイブ済み含む）存在する場合、
 * Excelインポートの照合ルール（nameMatchingRules）は保存された1つのcastIdへ
 * 無条件に紐付け続けるため、ランキングに表示されているキャスト（別castId）とは
 * 異なるレコードが更新され続ける、という不具合が起こり得る。これを事実として
 * 特定するため、名前が一致する**すべての**キャストのmonthlyResultsを個別に取得する。
 */

export interface CastSalesDiagnosticRow {
  cast: CastWithId;
  /** このキャスト・対象月のmonthlyResultsドキュメントID（決定論的） */
  monthlyResultId: string;
  /** Firestoreに実際に保存されている値（ドキュメントが無ければnull） */
  monthlyResult: (MonthlyResultDoc & { id: string }) | null;
}

export interface CastSalesDiagnosticResult {
  storeId: string;
  month: string;
  queryName: string;
  normalizedName: string;
  /** 対象店舗内で源氏名が正規化後に一致した全キャスト（アーカイブ済み含む） */
  matchedCasts: CastSalesDiagnosticRow[];
  /** 保存済み照合ルール（次回インポートがどのcastIdへ書き込むかを決める）。無ければnull */
  rule: NameMatchingRuleWithId | null;
}

/**
 * 指定店舗・対象月について、源氏名が一致する全キャスト（アーカイブ済み含む）と
 * それぞれのmonthlyResults実データ、および保存済み照合ルールを取得する。
 * 読み取り専用。同名キャストの重複・誤紐付けの有無を事実として確認するために使う。
 */
export async function fetchCastSalesDiagnostics(
  storeId: string,
  castName: string,
  month: string
): Promise<CastSalesDiagnosticResult> {
  const db = getDb();
  const normalized = normalizeName(castName);

  const castsSnap = await getDocs(query(collection(db, "casts"), where("storeId", "==", storeId)));
  const allCasts: CastWithId[] = castsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as CastDoc) }));
  const matched = allCasts.filter((c) => normalizeName(c.stageName) === normalized);

  const matchedCasts: CastSalesDiagnosticRow[] = await Promise.all(
    matched.map(async (cast) => {
      const mrId = monthlyResultId(storeId, cast.id, month);
      const mrSnap = await getDoc(doc(db, "monthlyResults", mrId));
      return {
        cast,
        monthlyResultId: mrId,
        monthlyResult: mrSnap.exists() ? { id: mrSnap.id, ...(mrSnap.data() as MonthlyResultDoc) } : null,
      };
    })
  );

  const ruleId = nameMatchingRuleId(storeId, normalized);
  const ruleSnap = await getDoc(doc(db, "nameMatchingRules", ruleId));
  const rule = ruleSnap.exists()
    ? ({ id: ruleSnap.id, ...ruleSnap.data() } as NameMatchingRuleWithId)
    : null;

  return {
    storeId,
    month,
    queryName: castName,
    normalizedName: normalized,
    matchedCasts,
    rule,
  };
}
