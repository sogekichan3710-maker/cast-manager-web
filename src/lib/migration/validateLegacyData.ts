import type { LegacyData } from "./legacyTypes";
import {
  convertLegacyData,
  type ConversionIssue,
  type ConversionResult,
} from "./convertLegacyData";

/**
 * 移行プレビュー。実行前に画面へ表示する件数と詳細。
 * 件数は「変換後に移行対象となる件数」を示し、除外されたデータは
 * invalid / orphans / unknownStore / badMonth / duplicates に詳細を持つ。
 */
export interface MigrationPreview {
  sourceFormat: string;
  counts: {
    casts: number;
    monthlyResults: number;
    interviews: number;
    goals: number;
    motivations: number;
    wageHistory: number;
    stores: number;
    nameMatchingRules: number;
    duplicates: number;
    invalid: number;
    orphans: number;
    unknownStore: number;
    badMonth: number;
  };
  /** 旧ファイル内の生件数（参考表示用） */
  rawCounts: Record<string, number>;
  issues: {
    invalid: ConversionIssue[];
    orphans: ConversionIssue[];
    unknownStore: ConversionIssue[];
    badMonth: ConversionIssue[];
    duplicates: ConversionIssue[];
    warnings: ConversionIssue[];
  };
  conversion: ConversionResult;
}

/**
 * 旧データを検証し、移行プレビューを作る。
 * 変換ロジックは convertLegacyData に一元化し、ここでは集計のみ行う
 * （検証と変換の判定がズレて「プレビューと実行結果が違う」事故を防ぐ）。
 */
export function validateLegacyData(
  legacy: LegacyData,
  existingStoreIds: string[]
): MigrationPreview {
  const conversion = convertLegacyData(legacy, existingStoreIds);
  return {
    sourceFormat: conversion.sourceFormat,
    counts: {
      casts: conversion.casts.length,
      monthlyResults: conversion.monthlyResults.length,
      interviews: conversion.interviews.length,
      goals: conversion.goals.length,
      motivations: conversion.motivations.length,
      wageHistory: conversion.wageHistory.length,
      stores: conversion.stores.length,
      nameMatchingRules: conversion.nameMatchingRules.length,
      duplicates: conversion.duplicates.length,
      invalid: conversion.invalid.length,
      orphans: conversion.orphans.length,
      unknownStore: conversion.unknownStore.length,
      badMonth: conversion.badMonth.length,
    },
    rawCounts: {
      casts: legacy.casts.length,
      monthlyResults: legacy.monthlyResults.length,
      interviews: legacy.interviews.length,
      castRecords: legacy.castRecords.length,
      goals: legacy.goals.length,
      motivationLogs: legacy.motivationLogs.length,
      wageHistory: legacy.wageHistory.length,
      importBatches: legacy.importBatches.length,
      stores: legacy.stores.length,
      nameMatchingRules: legacy.nameMatchingRules.length,
    },
    issues: {
      invalid: conversion.invalid,
      orphans: conversion.orphans,
      unknownStore: conversion.unknownStore,
      badMonth: conversion.badMonth,
      duplicates: conversion.duplicates,
      warnings: conversion.warnings,
    },
    conversion,
  };
}
