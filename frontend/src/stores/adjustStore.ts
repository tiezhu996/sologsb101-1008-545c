/**
 * 调节单状态（Pinia）
 * 维护调节单状态机、复核统计与筛选，以及调网方案的基线冻结、
 * 执行回填（与阀门台账的开度冲突双方保留）、冲突确认。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type AdjustRow, type MeasureRow, type ValveRow } from '@/utils/db'
import {
  ADJUST_STATE_FLOW,
  derivePlanItemState,
  type AdjustBaseline,
  type AdjustDraft,
  type AdjustExecution,
  type AdjustState,
  type OpeningConflict
} from '@/types/adjust'
import { useValveStore } from '@/stores/valveStore'
import { balanceLevel, imbalance, type BalanceLevel } from '@/utils/balance'
import { clampOpening, type Valve } from '@/types/valve'
import { createId } from '@/utils/db'

export interface AdjustEnriched {
  adjust: AdjustRow
  valve: Valve | null
  /** 生成调节单时的失衡度快照（按最新实测重算） */
  imbalanceValue: number
  level: BalanceLevel
  /** 方案单项派生状态（非方案单为待执行/已回填等） */
  itemState: ReturnType<typeof derivePlanItemState>
}

export interface ConfirmExecutionInput {
  actualOpening: number
  flowM3h: number | null
  roomTempC: number | null
  measureDate: string | null
  executor: string
  /** 同时登记一条新实测 */
  createMeasure: boolean
}

export interface ConfirmExecutionResult {
  /** 是否检测到与阀门台账的开度冲突（两方来源均保留） */
  conflict: boolean
  ledgerOpening: number
}

export const useAdjustStore = defineStore('adjust', () => {
  const adjustTable = useIdbTable<AdjustRow>((database) => database.adjusts, { sortByUpdatedAt: false })
  const valveStore = useValveStore()

  const stateFilter = ref<AdjustState[]>([])
  const keyword = ref('')
  const latestMeasureByValve = ref<Record<string, { flowM3h: number; roomTempC: number; date: string }>>({})

  /** 由失衡度排行灌入最新实测快照，供失衡度重算与展示 */
  function syncLatestMeasures(
    rows: Array<{ valve: Valve; measured: number; latest: { roomTempC: number; date: string } | null }>
  ): void {
    const map: Record<string, { flowM3h: number; roomTempC: number; date: string }> = {}
    rows.forEach((row) => {
      if (row.latest) {
        map[row.valve.id] = { flowM3h: row.measured, roomTempC: row.latest.roomTempC, date: row.latest.date }
      }
    })
    latestMeasureByValve.value = map
  }

  const adjusts = computed<AdjustRow[]>(() =>
    [...adjustTable.rows.value].sort((a, b) => b.updatedAt - a.updatedAt)
  )

  const enriched = computed<AdjustEnriched[]>(() =>
    adjusts.value.map((adjust) => {
      const valve = valveStore.valves.find((item) => item.id === adjust.valveId) ?? null
      // 已确认（冻结基线/已执行）的单优先用基线展示失衡度，未确认的沿用实时快照
      const snapshot = latestMeasureByValve.value[adjust.valveId]
      const design = valve ? valve.designFlowM3h : 0
      const measured = adjust.baseline?.measuredFlowM3h ?? (snapshot ? snapshot.flowM3h : 0)
      const room = adjust.baseline?.roomTempC ?? (snapshot ? snapshot.roomTempC : 20)
      const value = adjust.baseline
        ? adjust.baseline.imbalanceValue
        : snapshot
          ? imbalance(measured, design, room)
          : 0
      const level = (adjust.baseline?.level as BalanceLevel | undefined)
        ?? (valve && snapshot ? balanceLevel(value, measured, design) : '平衡')
      return {
        adjust,
        valve,
        imbalanceValue: value,
        level,
        itemState: derivePlanItemState(adjust)
      }
    })
  )

  const filtered = computed<AdjustEnriched[]>(() =>
    enriched.value.filter((item) => {
      if (stateFilter.value.length > 0 && !stateFilter.value.includes(item.adjust.state)) return false
      const text = keyword.value.trim().toLowerCase()
      if (text.length === 0) return true
      return (
        (item.valve ? item.valve.code.toLowerCase().includes(text) : false) ||
        item.adjust.executor.toLowerCase().includes(text) ||
        item.adjust.basis.toLowerCase().includes(text)
      )
    })
  )

  const stateCounts = computed<Record<AdjustState, number>>(() => {
    const counts: Record<AdjustState, number> = { 待下发: 0, 已调节: 0, 已复核: 0 }
    adjusts.value.forEach((adjust) => {
      counts[adjust.state] += 1
    })
    return counts
  })

  /** 未解决的开度冲突数（台账与方案两边都等着确认） */
  const conflictCount = computed(
    () => adjusts.value.filter((adjust) => adjust.openingConflict && !adjust.openingConflict.resolved).length
  )

  const reviewedPercent = computed(() =>
    adjusts.value.length === 0 ? 0 : Math.round((stateCounts.value['已复核'] / adjusts.value.length) * 100)
  )

  function patchFilter(patch: { stateFilter?: AdjustState[]; keyword?: string }): void {
    if (patch.stateFilter) stateFilter.value = patch.stateFilter
    if (patch.keyword !== undefined) keyword.value = patch.keyword
  }

  function resetFilter(): void {
    stateFilter.value = []
    keyword.value = ''
  }

  const hasAdjust = (valveId: string): boolean => adjusts.value.some((adjust) => adjust.valveId === valveId)

  /** 该阀门当前可纳入方案的待下发调节单（已调节/已复核的历史单不再纳入新方案） */
  function pendingAdjustOfValve(valveId: string): AdjustRow | undefined {
    return adjusts.value.find((adjust) => adjust.valveId === valveId && adjust.state === '待下发')
  }

  async function createAdjust(draft: AdjustDraft, extra?: { baseline?: AdjustBaseline | null; planId?: string | null }): Promise<AdjustRow> {
    return (await adjustTable.create(
      {
        valveId: draft.valveId,
        targetOpening: Math.min(100, Math.max(0, Math.round(draft.targetOpening))),
        basis: draft.basis.trim(),
        executor: draft.executor.trim() || '待指派',
        state: draft.state,
        reviewNote: draft.reviewNote.trim(),
        baseline: extra?.baseline ?? null,
        execution: null,
        openingConflict: null,
        planId: extra?.planId ?? null
      },
      'aj'
    )) as AdjustRow
  }

  async function updateAdjust(id: string, patch: Partial<AdjustDraft>): Promise<void> {
    const next: Partial<AdjustRow> = { ...patch }
    if (patch.targetOpening !== undefined) next.targetOpening = Math.min(100, Math.max(0, Math.round(patch.targetOpening)))
    if (patch.basis !== undefined) next.basis = patch.basis.trim()
    if (patch.executor !== undefined) next.executor = patch.executor.trim()
    if (patch.reviewNote !== undefined) next.reviewNote = patch.reviewNote.trim()
    await adjustTable.update(id, next)
  }

  async function removeAdjust(id: string): Promise<void> {
    await adjustTable.remove(id)
  }

  /**
   * 批量补挂方案并冻结基线（发起调网方案时调用）。
   * - 已存在待下发单：纳入方案并冻结基线（不改动原依据）；
   * - 无单的阀门：直接在库中建单，基线一并写入。
   * 返回方案下全部调节单 id。
   */
  async function attachPlanWithBaselines(
    planId: string,
    entries: Array<{
      valve: ValveRow
      basis: string
      baseline: AdjustBaseline
    }>
  ): Promise<string[]> {
    const now = Date.now()
    const adjustIds: string[] = []
    await db.transaction('rw', db.adjusts, async () => {
      for (const [index, entry] of entries.entries()) {
        const existing = pendingAdjustOfValve(entry.valve.id)
        if (existing) {
          await db.adjusts.update(existing.id, {
            planId,
            baseline: existing.baseline ?? entry.baseline,
            targetOpening: existing.baseline ? existing.targetOpening : entry.baseline.targetOpening,
            updatedAt: now
          })
          adjustIds.push(existing.id)
        } else {
          const id = `aj_${now.toString(36)}${index}${Math.random().toString(36).slice(2, 5)}`
          await db.adjusts.put({
            id,
            valveId: entry.valve.id,
            targetOpening: entry.baseline.targetOpening,
            basis: entry.basis,
            executor: '待指派',
            state: '待下发',
            reviewNote: '',
            baseline: entry.baseline,
            execution: null,
            openingConflict: null,
            planId,
            createdAt: now,
            updatedAt: now,
            revision: 3
          })
          adjustIds.push(id)
        }
      }
    })
    return adjustIds
  }

  /**
   * 旧调节单首次打开时补出基线：仅补 baseline 为空的单，已冻结/已确认的绝不重算。
   * 原依据 basis 保持不动；补录基线标记 backfilled。
   */
  async function ensureBaselines(
    rows: Array<{ adjustId: string; baseline: AdjustBaseline | null }>
  ): Promise<number> {
    const now = Date.now()
    let count = 0
    await db.transaction('rw', db.adjusts, async () => {
      for (const item of rows) {
        if (!item.baseline) continue
        const current = await db.adjusts.get(item.adjustId)
        if (!current || current.baseline) continue
        await db.adjusts.update(item.adjustId, {
          baseline: { ...item.baseline, backfilled: true, frozenAt: item.baseline.frozenAt || now },
          updatedAt: current.updatedAt
        })
        count += 1
      }
    })
    return count
  }

  /**
   * 执行回填（确认一张单）：
   * - 台账开度 == 冻结基线开度：执行结果直接回写台账；
   * - 台账开度已被改且与实际开度不一致：登记两方来源的开度冲突，两边都不覆盖，待确认；
   * - 台账开度恰好等于实际开度：视为台账已同步，无冲突。
   * - 可选登记一条新实测。
   * 整个过程一个事务，forceFail 时于写库前抛出（用于演示保存失败后的草稿恢复）。
   */
  async function confirmExecution(
    adjustId: string,
    input: ConfirmExecutionInput,
    options: { forceFail?: boolean } = {}
  ): Promise<ConfirmExecutionResult> {
    const adjust = await db.adjusts.get(adjustId)
    if (!adjust) throw new Error('调节单不存在')
    const valve = await db.valves.get(adjust.valveId)
    if (!valve) throw new Error('阀门已删除，无法回填')

    const actualOpening = clampOpening(input.actualOpening)
    const baselineOpening = adjust.baseline?.currentOpening ?? valve.currentOpening
    const ledgerOpening = clampOpening(valve.currentOpening)
    const ledgerChanged = ledgerOpening !== baselineOpening
    const matchesLedger = ledgerOpening === actualOpening
    const conflict = ledgerChanged && !matchesLedger

    const execution: AdjustExecution = {
      actualOpening,
      flowM3h: input.flowM3h,
      roomTempC: input.roomTempC,
      measureDate: input.measureDate,
      executor: input.executor.trim() || adjust.executor || '待指派',
      recordedAt: Date.now()
    }

    if (options.forceFail) {
      throw new Error('保存失败（模拟）：本地库暂时不可写')
    }

    const now = Date.now()
    await db.transaction('rw', db.adjusts, db.valves, db.measures, async () => {
      const conflictPatch: OpeningConflict | null = conflict
        ? {
            executionOpening: actualOpening,
            ledgerOpening,
            ledgerUpdatedAt: valve.updatedAt ?? now,
            detectedAt: now,
            resolved: false
          }
        : null

      await db.adjusts.update(adjustId, {
        execution,
        openingConflict: conflictPatch,
        executor: execution.executor,
        // 有冲突时状态仍推进为已调节，但台账开度不回写，等冲突确认
        state: '已调节' as AdjustState,
        updatedAt: now
      })

      if (!conflict) {
        // 无冲突：实际开度回写阀门台账（相等时为幂等写入）
        await db.valves.update(valve.id, { currentOpening: actualOpening })
      }

      if (input.createMeasure && input.flowM3h !== null) {
        const measure: MeasureRow = {
          id: createId('ms'),
          valveId: valve.id,
          date: input.measureDate ?? new Date().toISOString().slice(0, 10),
          flowM3h: input.flowM3h,
          supplyTempC: 0,
          returnTempC: 0,
          roomTempC: input.roomTempC ?? 20,
          operator: execution.executor,
          createdAt: now,
          updatedAt: now,
          revision: 3
        }
        await db.measures.put(measure)
      }
    })

    return { conflict, ledgerOpening }
  }

  /**
   * 冲突确认：调度选择以哪一方开度为准。确认前台账与方案两边都未互相覆盖。
   * - execution：以方案实际开度回写台账；
   * - ledger：保留台账开度，方案实际开度仍留在执行记录里可查。
   */
  async function resolveOpeningConflict(
    adjustId: string,
    resolution: 'execution' | 'ledger',
    note: string
  ): Promise<void> {
    const now = Date.now()
    await db.transaction('rw', db.adjusts, db.valves, async () => {
      const adjust = await db.adjusts.get(adjustId)
      if (!adjust || !adjust.openingConflict) return
      await db.adjusts.update(adjustId, {
        openingConflict: {
          ...adjust.openingConflict,
          resolved: true,
          resolution,
          resolutionNote: note.trim(),
          resolvedAt: now
        },
        updatedAt: now
      })
      if (resolution === 'execution') {
        await db.valves.update(adjust.valveId, { currentOpening: adjust.openingConflict.executionOpening })
      }
    })
  }

  /** 状态流转：已调节时把目标开度回写到阀门（存在未解决冲突时禁止覆盖台账） */
  async function advance(id: string): Promise<AdjustState | null> {
    const adjust = adjusts.value.find((item) => item.id === id)
    if (!adjust) return null
    const next = ADJUST_STATE_FLOW[adjust.state]
    if (!next) return null
    if (adjust.openingConflict && !adjust.openingConflict.resolved) {
      throw new Error('该单存在未确认的开度冲突，请先在调网方案中确认两方开度')
    }
    await adjustTable.update(id, { state: next })
    if (next === '已调节') {
      // 已通过方案执行回填的单不再重复回写，避免覆盖冲突处理结果
      if (!adjust.execution) {
        await valveStore.applyOpening(adjust.valveId, adjust.targetOpening)
      }
    }
    return next
  }

  /** 复核：写复核意见并闭环 */
  async function review(id: string, note: string): Promise<void> {
    await adjustTable.update(id, { state: '已复核', reviewNote: note.trim() || '复核合格' })
  }

  /** 由失衡度排行批量生成调节单（非方案路径，同样冻结基线以便依据可追溯） */
  async function generateFromRank(
    rows: Array<{ valve: Valve; measured: number; roomTempC: number; imbalanceValue: number; level: BalanceLevel; suggestOpening: number; basisText: string; baseline?: AdjustBaseline | null }>
  ): Promise<number> {
    const now = Date.now()
    const payload: AdjustRow[] = rows
      .filter((row) => row.level === '严重失衡' || row.level === '偏大' || row.level === '偏小')
      .filter((row) => !hasAdjust(row.valve.id))
      .map((row, index) => ({
        id: `aj_${now.toString(36)}${index}${Math.random().toString(36).slice(2, 5)}`,
        valveId: row.valve.id,
        targetOpening: row.suggestOpening,
        basis: row.basisText,
        executor: '待指派',
        state: '待下发' as AdjustState,
        reviewNote: '',
        baseline: row.baseline ?? null,
        execution: null,
        openingConflict: null,
        planId: null,
        createdAt: now,
        updatedAt: now
      }))
    if (payload.length > 0) await db.adjusts.bulkPut(payload)
    return payload.length
  }

  return {
    adjustTable,
    adjusts,
    enriched,
    filtered,
    stateFilter,
    keyword,
    stateCounts,
    conflictCount,
    reviewedPercent,
    syncLatestMeasures,
    latestMeasureByValve,
    patchFilter,
    resetFilter,
    hasAdjust,
    pendingAdjustOfValve,
    createAdjust,
    updateAdjust,
    removeAdjust,
    attachPlanWithBaselines,
    ensureBaselines,
    confirmExecution,
    resolveOpeningConflict,
    advance,
    review,
    generateFromRank
  }
})
