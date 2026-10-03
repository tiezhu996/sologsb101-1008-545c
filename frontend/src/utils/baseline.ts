/**
 * 调节依据基线：从失衡度排行行冻结「台账开度 + 最新实测 + 目标开度」快照，
 * 使读数变化后调节单仍能说明建议依据哪组数据；旧调节单首次打开时按此补录。
 */
import { db, type AdjustRow } from '@/utils/db'
import type { AdjustBaseline } from '@/types/adjust'
import type { ImbalanceRow } from '@/hooks/useImbalanceRank'
import { imbalance, flowRatio } from '@/utils/balance'

/** 由排行行冻结一份依据基线 */
export function freezeBaseline(row: ImbalanceRow, frozenAt = Date.now()): AdjustBaseline {
  return {
    opening: row.valve.currentOpening,
    targetOpening: row.suggestOpening,
    measuredFlowM3h: row.latest ? row.measured : null,
    measureDate: row.latest ? row.latest.date : '',
    roomTempC: row.latest ? row.latest.roomTempC : null,
    ratio: row.latest ? row.ratio : null,
    imbalanceValue: row.latest ? row.imbalanceValue : null,
    frozenAt
  }
}

/** 依据给定阀门与实测列表重算一份基线（仅用于旧单补录） */
export function buildBaselineFrom(
  valve: { currentOpening: number; designFlowM3h: number },
  latest: { date: string; flowM3h: number; roomTempC: number } | null,
  targetOpening: number,
  frozenAt = Date.now()
): AdjustBaseline {
  if (!latest) {
    return {
      opening: valve.currentOpening,
      targetOpening,
      measuredFlowM3h: null,
      measureDate: '',
      roomTempC: null,
      ratio: null,
      imbalanceValue: null,
      frozenAt,
      backfilled: true
    }
  }
  return {
    opening: valve.currentOpening,
    targetOpening,
    measuredFlowM3h: latest.flowM3h,
    measureDate: latest.date,
    roomTempC: latest.roomTempC,
    ratio: flowRatio(latest.flowM3h, valve.designFlowM3h),
    imbalanceValue: imbalance(latest.flowM3h, valve.designFlowM3h, latest.roomTempC),
    frozenAt,
    backfilled: true
  }
}

/**
 * 旧调节单首次打开时补出基线：缺基线的调节单按当前阀门与最新实测补算，
 * 标记 backfilled；原 basis 依据原文不动。返回补录条数。
 */
export async function ensureAdjustBaselines(
  valves: Array<{ id: string; currentOpening: number; designFlowM3h: number }>,
  measures: Array<{ valveId: string; date: string; flowM3h: number; roomTempC: number }>
): Promise<number> {
  const missing = await db.adjusts.filter((adjust) => !adjust.baseline).toArray()
  if (missing.length === 0) return 0

  const valveById = new Map(valves.map((valve) => [valve.id, valve]))
  const latestByValve = new Map<string, (typeof measures)[number]>()
  const sortedMeasures = [...measures].sort((a, b) => a.date.localeCompare(b.date))
  sortedMeasures.forEach((measure) => latestByValve.set(measure.valveId, measure))

  const now = Date.now()
  const patched: AdjustRow[] = missing.map((adjust) => {
    const valve = valveById.get(adjust.valveId)
    const latest = latestByValve.get(adjust.valveId) ?? null
    const baseline = valve
      ? buildBaselineFrom(valve, latest, adjust.targetOpening, now)
      : {
          opening: 0,
          targetOpening: adjust.targetOpening,
          measuredFlowM3h: null,
          measureDate: '',
          roomTempC: null,
          ratio: null,
          imbalanceValue: null,
          frozenAt: now,
          backfilled: true
        }
    return { ...adjust, baseline }
  })
  await db.adjusts.bulkPut(patched)
  return patched.length
}
