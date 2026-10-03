/**
 * 调节单基线构建：从失衡度排行行冻结基线快照。
 * - 发起调网方案时对该站全部阀门冻结；
 * - 旧调节单（无基线）首次打开时按当时读数补录，标记 backfilled 且不改写原依据。
 */
import type { AdjustBaseline } from '@/types/adjust'
import type { ImbalanceRow } from '@/hooks/useImbalanceRank'
import { clampOpening } from '@/types/valve'

/** 从一条失衡度排行行冻结基线 */
export function baselineFromRank(row: ImbalanceRow, frozenAt = Date.now(), backfilled = false): AdjustBaseline {
  return {
    currentOpening: clampOpening(row.valve.currentOpening),
    measuredFlowM3h: row.latest ? row.measured : null,
    roomTempC: row.latest ? row.latest.roomTempC : null,
    measureDate: row.latest ? row.latest.date : null,
    designFlowM3h: row.valve.designFlowM3h,
    ratio: row.latest ? row.ratio : 0,
    imbalanceValue: row.latest ? row.imbalanceValue : 0,
    level: row.latest ? row.level : '平衡',
    targetOpening: clampOpening(row.suggestOpening),
    frozenAt,
    backfilled
  }
}

/** 旧单补录基线：无最新实测时以阀门当前开度兜底，避免基线缺失 */
export function backfillBaselineFromRank(row: ImbalanceRow, frozenAt = Date.now()): AdjustBaseline {
  return baselineFromRank(row, frozenAt, true)
}

/** 基线摘要文案（用于调节依据/展示） */
export function baselineSummary(baseline: AdjustBaseline): string {
  if (baseline.measuredFlowM3h === null) {
    return `基线（${new Date(baseline.frozenAt).toLocaleDateString('zh-CN')} 冻结）：开度 ${baseline.currentOpening}%，无实测，目标开度 ${baseline.targetOpening}%`
  }
  return `基线（${new Date(baseline.frozenAt).toLocaleDateString('zh-CN')} 冻结）：开度 ${baseline.currentOpening}%、实测 ${baseline.measuredFlowM3h.toFixed(1)} m³/h（${baseline.measureDate ?? '—'}）、室温 ${baseline.roomTempC ?? '—'}℃、流量比 ${baseline.ratio.toFixed(2)}、失衡度 ${baseline.imbalanceValue.toFixed(1)}%（${baseline.level}）、目标开度 ${baseline.targetOpening}%`
}
