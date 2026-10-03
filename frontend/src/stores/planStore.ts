/**
 * 调网方案状态（Pinia）
 * 按换热站发起可中止的调网方案：发起即冻结该站全部阀门的基线（委托 adjustStore
 * 建单/补挂），逐张执行回填，保存失败时草稿落 localStorage，重开从最后确认的
 * 一张继续；已确认项不再重算。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  clearPlanDraft,
  clearPlanDrafts,
  readPlanDrafts,
  savePlanDraft,
  type AdjustPlanRow
} from '@/utils/db'
import {
  derivePlanItemState,
  isAdjustConfirmed,
  isPlanItemDone,
  type AdjustPlan,
  type PlanItem,
  type PlanExecutionDraft,
  type PlanState
} from '@/types/adjust'
import { useAdjustStore, type ConfirmExecutionInput, type ConfirmExecutionResult } from '@/stores/adjustStore'
import { useValveStore } from '@/stores/valveStore'
import { useStationStore } from '@/stores/stationStore'
import { baselineFromRank } from '@/utils/baseline'
import { basisText } from '@/utils/balance'
import { clampOpening } from '@/types/valve'

export interface CreatePlanOptions {
  /** 下一次确认时强制写库失败（演示保存失败 → 草稿恢复） */
  simulateSaveFailure?: boolean
}

export const usePlanStore = defineStore('adjustPlan', () => {
  const planTable = useIdbTable<AdjustPlanRow>((database) => database.adjustPlans, { sortByUpdatedAt: false })
  const adjustStore = useAdjustStore()
  const valveStore = useValveStore()
  const stationStore = useStationStore()

  /** 注入：由失衡度计算页提供排行行（planStore 不直接依赖 hook，保持 store 可测） */
  const rankRows = ref<Array<{
    valveId: string
    valveCode: string
    buildingName: string
    basis: string
    // 直接携带冻结所需的排行行
    rank: import('@/hooks/useImbalanceRank').ImbalanceRow
  }>>([])

  function bindRankRows(
    rows: Array<{ rank: import('@/hooks/useImbalanceRank').ImbalanceRow }>
  ): void {
    rankRows.value = rows.map((item) => ({
      valveId: item.rank.valve.id,
      valveCode: item.rank.valve.code,
      buildingName: item.rank.building ? item.rank.building.name : '未知楼栋',
      basis: basisText({
        valve: item.rank.valve,
        building: item.rank.building,
        ratio: item.rank.ratio,
        flowDeviation: item.rank.flowDeviation,
        roomDeviation: item.rank.roomDeviation,
        imbalanceValue: item.rank.imbalanceValue,
        level: item.rank.level
      }),
      rank: item.rank
    }))
  }

  const plans = computed<AdjustPlanRow[]>(() =>
    [...planTable.rows.value].sort((a, b) => b.updatedAt - a.updatedAt)
  )

  function planById(id: string): AdjustPlanRow | undefined {
    return plans.value.find((plan) => plan.id === id)
  }

  function planOfStation(stationId: string): AdjustPlanRow | undefined {
    return plans.value.find((plan) => plan.stationId === stationId && plan.state !== '已完成')
  }

  /** 方案下的调节单（按冻结时目标开度/创建顺序稳定排列） */
  function adjustsOfPlan(planId: string) {
    return adjustStore.adjusts
      .filter((adjust) => adjust.planId === planId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  /** 方案单项视图 */
  function itemsOfPlan(planId: string): PlanItem[] {
    const valves = valveStore.valves
    return adjustsOfPlan(planId).map((adjust) => {
      const valve = valves.find((item) => item.id === adjust.valveId)
      const building = valve ? stationStore.buildingById.get(valve.buildingId) : undefined
      return {
        adjustId: adjust.id,
        valveId: adjust.valveId,
        valveCode: valve ? valve.code : '阀门已删除',
        buildingName: building ? building.name : '—',
        targetOpening: adjust.targetOpening,
        baseline: adjust.baseline ?? null,
        execution: adjust.execution ?? null,
        openingConflict: adjust.openingConflict ?? null,
        state: adjust.state,
        itemState: derivePlanItemState(adjust)
      }
    })
  }

  /** 方案进度：办结 = 已复核，或已回填且无未解决冲突；未解决冲突计入待继续 */
  function confirmedCountOfPlan(planId: string): number {
    return adjustsOfPlan(planId).filter((adjust) => isPlanItemDone(adjust)).length
  }

  function progressOfPlan(planId: string): { total: number; confirmed: number; pending: number } {
    const list = adjustsOfPlan(planId)
    const confirmed = list.filter((adjust) => isPlanItemDone(adjust)).length
    return { total: list.length, confirmed, pending: list.length - confirmed }
  }

  /**
   * 发起调网方案：冻结该站全部阀门基线，并把待下发旧单纳入方案/为无单阀门建单。
   * 旧调节单（待下发）首次纳入即补基线；已调节/已复核的历史单不动。
   */
  async function createPlan(stationId: string): Promise<AdjustPlanRow> {
    const station = stationStore.stationById.get(stationId)
    if (!station) throw new Error('换热站不存在')
    if (planOfStation(stationId)) throw new Error('该换热站已有进行中的调网方案，请直接继续')

    const now = Date.now()
    const id = `pl_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const frozenAt = now

    const stationValves = valveStore.valves.filter((valve) => valve.stationId === stationId)
    const entries = stationValves.map((valve) => {
      const rankItem = rankRows.value.find((item) => item.valveId === valve.id)
      const baseline = rankItem ? baselineFromRank(rankItem.rank, frozenAt) : {
          currentOpening: clampOpening(valve.currentOpening),
          measuredFlowM3h: null,
          roomTempC: null,
          measureDate: null,
          designFlowM3h: valve.designFlowM3h,
          ratio: 0,
          imbalanceValue: 0,
          level: '平衡',
          targetOpening: clampOpening(valve.currentOpening),
          frozenAt,
          backfilled: false
        }
      return {
        valve,
        basis: rankItem?.basis ?? `${station.name} 调网方案：冻结开度 ${valve.currentOpening}%（无最新实测）`,
        baseline
      }
    })

    await adjustStore.attachPlanWithBaselines(id, entries)

    const plan: AdjustPlanRow = {
      id,
      stationId,
      stationName: station.name,
      state: '进行中',
      frozenAt,
      resumeAdjustId: null,
      abortedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      revision: 3
    }
    await planTable.upsert(plan)
    return plan
  }

  /** 旧调节单首次打开方案时补出基线（已确认/已冻结的单跳过，绝不重算） */
  async function backfillMissingBaselines(planId: string): Promise<number> {
    const patch: Array<{ adjustId: string; baseline: import('@/types/adjust').AdjustBaseline | null }> = []
    adjustsOfPlan(planId).forEach((adjust) => {
      if (adjust.baseline) return
      if (isAdjustConfirmed(adjust)) return
      const rankItem = rankRows.value.find((item) => item.valveId === adjust.valveId)
      if (!rankItem) return
      patch.push({ adjustId: adjust.id, baseline: baselineFromRank(rankItem.rank, Date.now(), true) })
    })
    if (patch.length === 0) return 0
    return adjustStore.ensureBaselines(patch)
  }

  /** 未恢复的保存失败草稿 */
  function draftsOfPlan(planId: string): PlanExecutionDraft[] {
    return readPlanDrafts(planId).sort((a, b) => a.savedAt - b.savedAt)
  }

  /**
   * 确认一张单：成功后清掉该单草稿、推进「继续」游标到下一张；
   * 失败（含模拟失败）时草稿落 localStorage，供重新打开时从最后确认的一张继续。
   */
  async function confirmItem(
    planId: string,
    adjustId: string,
    input: ConfirmExecutionInput,
    options: CreatePlanOptions = {}
  ): Promise<ConfirmExecutionResult> {
    const draft: PlanExecutionDraft = {
      planId,
      adjustId,
      actualOpening: clampOpening(input.actualOpening),
      flowM3h: input.flowM3h,
      roomTempC: input.roomTempC,
      measureDate: input.measureDate ?? new Date().toISOString().slice(0, 10),
      executor: input.executor,
      createMeasure: input.createMeasure,
      savedAt: Date.now()
    }

    try {
      const result = await adjustStore.confirmExecution(adjustId, input, { forceFail: options.simulateSaveFailure })
      clearPlanDraft(planId, adjustId)
      await advanceResumeCursor(planId, adjustId)
      return result
    } catch (error) {
      savePlanDraft(draft)
      throw error
    }
  }

  /** 用草稿重新确认一张单（从最后确认的一张继续时调用） */
  async function retryDraftItem(
    planId: string,
    draft: PlanExecutionDraft,
    patch?: Partial<ConfirmExecutionInput>
  ): Promise<ConfirmExecutionResult> {
    const input: ConfirmExecutionInput = {
      actualOpening: draft.actualOpening,
      flowM3h: draft.flowM3h,
      roomTempC: draft.roomTempC,
      measureDate: draft.measureDate,
      executor: draft.executor,
      createMeasure: draft.createMeasure,
      ...patch
    }
    const result = await adjustStore.confirmExecution(draft.adjustId, input)
    clearPlanDraft(planId, draft.adjustId)
    await advanceResumeCursor(planId, draft.adjustId)
    return result
  }

  function discardDraft(planId: string, adjustId: string): void {
    clearPlanDraft(planId, adjustId)
  }

  /** 已办结项之后的第一张待继续项（含未解决冲突），作为「继续」落点；已确认（冻结）项不重算 */
  function nextPendingAdjustId(planId: string, afterAdjustId?: string | null): string | null {
    const list = adjustsOfPlan(planId)
    let start = 0
    if (afterAdjustId) {
      const idx = list.findIndex((adjust) => adjust.id === afterAdjustId)
      if (idx >= 0) start = idx + 1
    }
    for (let i = start; i < list.length; i += 1) {
      if (!isPlanItemDone(list[i])) return list[i].id
    }
    // 游标之后没有时，从头找第一张待继续（兼容中止后重开）
    for (let i = 0; i < start; i += 1) {
      if (!isPlanItemDone(list[i])) return list[i].id
    }
    return null
  }

  async function advanceResumeCursor(planId: string, confirmedAdjustId: string): Promise<void> {
    const plan = planById(planId)
    if (!plan) return
    const nextId = nextPendingAdjustId(planId, confirmedAdjustId)
    await planTable.update(planId, { resumeAdjustId: nextId })
  }

  /** 中止方案：保留全部已确认项与草稿，可随时继续 */
  async function abortPlan(planId: string): Promise<void> {
    const plan = planById(planId)
    if (!plan || plan.state === '已完成') return
    await planTable.update(planId, { state: '已中止' satisfies PlanState, abortedAt: Date.now() })
  }

  /** 由中止重新打开继续 */
  async function reopenPlan(planId: string): Promise<string | null> {
    const plan = planById(planId)
    if (!plan) return null
    const updates: Partial<AdjustPlan> = { updatedAt: Date.now() }
    if (plan.state === '已中止') {
      updates.state = '进行中'
      updates.abortedAt = null
    }
    // 从最后确认的一张继续：优先方案游标，其次扫描第一张待继续
    const resumeId = plan.resumeAdjustId && adjustsOfPlan(planId).some((a) => a.id === plan.resumeAdjustId && !isPlanItemDone(a))
      ? plan.resumeAdjustId
      : nextPendingAdjustId(planId, plan.resumeAdjustId)
    updates.resumeAdjustId = resumeId
    await planTable.update(planId, updates)
    return resumeId
  }

  /** 完成方案：仍有未确认项时拒绝；完成后只读 */
  async function completePlan(planId: string): Promise<void> {
    const progress = progressOfPlan(planId)
    if (progress.pending > 0) throw new Error(`还有 ${progress.pending} 张单未确认，无法完成方案`)
    await planTable.update(planId, { state: '已完成' satisfies PlanState, completedAt: Date.now(), resumeAdjustId: null })
    clearPlanDrafts(planId)
  }

  /** 冲突确认后若方案已无未决项，调用方可提示完成；这里仅回传是否全部确认 */
  function isAllConfirmed(planId: string): boolean {
    return progressOfPlan(planId).pending === 0
  }

  return {
    planTable,
    plans,
    rankRows,
    bindRankRows,
    planById,
    planOfStation,
    adjustsOfPlan,
    itemsOfPlan,
    confirmedCountOfPlan,
    progressOfPlan,
    createPlan,
    backfillMissingBaselines,
    draftsOfPlan,
    confirmItem,
    retryDraftItem,
    discardDraft,
    nextPendingAdjustId,
    abortPlan,
    reopenPlan,
    completePlan,
    isAllConfirmed
  }
})
