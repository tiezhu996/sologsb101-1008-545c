/**
 * 调网方案状态（Pinia）
 * 在失衡度计算页按换热站发起一次可中止的调网作业：
 * - 选站时冻结各阀门台账开度、最新实测、目标开度与调节单基线
 * - 逐张执行回填实际开度与新实测；保存失败可恢复，从最后确认的一张继续，已确认项不重算
 * - 执行瞬间检测阀门台账是否被同时编辑：冲突时保留台账/调节两方开度待人工确认
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, createId, ROW_REVISION, type GridPlanRow, type MeasureRow } from '@/utils/db'
import { clampOpening } from '@/types/valve'
import {
  todayString,
  type GridConflictDecision,
  type GridExecuteDraft,
  type GridPlan,
  type GridPlanItem,
  type GridPlanState
} from '@/types/grid'
import type { ImbalanceRow } from '@/hooks/useImbalanceRank'
import type { AdjustRow } from '@/utils/db'
import { freezeBaseline } from '@/utils/baseline'

export interface StartPlanInput {
  stationId: string
  stationName: string
  executor: string
  rows: ImbalanceRow[]
}

export const useGridPlanStore = defineStore('gridPlan', () => {
  const planTable = useIdbTable<GridPlanRow>((database) => database.gridplans, { sortByUpdatedAt: false })

  /** 保存失败等提示信息，供页面顶部恢复条展示 */
  const notice = ref<string | null>(null)

  const plans = computed<GridPlanRow[]>(() =>
    [...planTable.rows.value].sort((a, b) => b.updatedAt - a.updatedAt)
  )

  /** 当前可继续的方案（执行中），同时只允许存在一个 */
  const activePlan = computed<GridPlanRow | null>(
    () => plans.value.find((plan) => plan.state === '执行中') ?? null
  )

  const hasActivePlan = computed(() => activePlan.value !== null)

  function planOfStation(stationId: string): GridPlanRow | null {
    return plans.value.find((plan) => plan.stationId === stationId && plan.state === '执行中') ?? null
  }

  function setNotice(text: string | null): void {
    notice.value = text
  }

  /**
   * 发起调网方案：冻结该站全部失衡排行阀门（含平衡时也可纳入？按需求选站发起，
   * 这里纳入有最新实测的全部阀门，目标开度取建议值）。
   * 同步为每个阀门准备一张待下发调节单（已有则复用），并冻结基线。
   */
  async function startPlan(input: StartPlanInput): Promise<GridPlanRow> {
    if (activePlan.value) {
      throw new Error('已有进行中的调网方案，请先完成或中止')
    }
    const now = Date.now()
    const stationRows = input.rows.filter((row) => row.valve.stationId === input.stationId && row.latest !== null)
    if (stationRows.length === 0) throw new Error('该换热站暂无可纳入方案的实测阀门')

    const existingAdjusts = await db.adjusts.where('valveId').anyOf(stationRows.map((row) => row.valve.id)).toArray()
    const adjustByValve = new Map(existingAdjusts.map((adjust) => [adjust.valveId, adjust]))

    const items: GridPlanItem[] = []
    const createdAdjusts: AdjustRow[] = []
    const updatedAdjusts: AdjustRow[] = []

    stationRows.forEach((row, index) => {
      const baseline = freezeBaseline(row, now)
      let adjust = adjustByValve.get(row.valve.id)
      if (!adjust) {
        adjust = {
          id: createId('aj'),
          valveId: row.valve.id,
          targetOpening: row.suggestOpening,
          basis: buildBasis(row),
          executor: input.executor.trim() || '待指派',
          state: '待下发',
          reviewNote: '',
          baseline,
          revision: ROW_REVISION,
          createdAt: now,
          updatedAt: now
        }
        createdAdjusts.push(adjust)
      } else if (!adjust.baseline) {
        const patched: AdjustRow = { ...adjust, baseline, updatedAt: now }
        updatedAdjusts.push(patched)
        adjust = patched
      }

      items.push({
        adjustId: adjust.id,
        valveId: row.valve.id,
        valveCode: row.valve.code,
        buildingName: row.building ? row.building.name : '未知楼栋',
        frozenOpening: row.valve.currentOpening,
        targetOpening: row.suggestOpening,
        frozenFlowM3h: row.measured,
        frozenMeasureDate: row.latest ? row.latest.date : '',
        frozenRoomTempC: row.latest ? row.latest.roomTempC : 20,
        frozenRatio: row.ratio,
        frozenImbalance: row.imbalanceValue,
        frozenLevel: row.level,
        state: '待执行',
        actualOpening: null,
        newFlowM3h: null,
        newSupplyTempC: null,
        newReturnTempC: null,
        newRoomTempC: null,
        newMeasureDate: '',
        executor: input.executor.trim(),
        ledgerOpening: null,
        conflict: null,
        measureWritten: false,
        confirmedAt: null,
        updatedAt: now + index
      })
    })

    const plan: GridPlanRow = {
      id: createId('gp'),
      stationId: input.stationId,
      stationName: input.stationName,
      state: '执行中',
      executor: input.executor.trim(),
      items,
      lastError: null,
      failNextSave: false,
      createdAt: now,
      updatedAt: now,
      revision: ROW_REVISION
    }

    await db.transaction('rw', db.adjusts, db.gridplans, async () => {
      if (createdAdjusts.length > 0) await db.adjusts.bulkPut(createdAdjusts)
      if (updatedAdjusts.length > 0) await db.adjusts.bulkPut(updatedAdjusts)
      await db.gridplans.put(plan)
    })
    notice.value = null
    return plan
  }

  function buildBasis(row: ImbalanceRow): string {
    const buildingName = row.building ? row.building.name : '未知楼栋'
    return (
      `${buildingName} ${row.valve.code} 调网冻结：台账开度 ${row.valve.currentOpening}%、` +
      `最新实测 ${row.measured.toFixed(1)} m³/h（${row.latest ? row.latest.date : ''}）、` +
      `流量比 ${row.ratio.toFixed(2)}、失衡度 ${row.imbalanceValue.toFixed(1)}%（${row.level}），目标开度 ${row.suggestOpening}%`
    )
  }

  /** 中止方案：已确认项保留，未执行项不再继续，方案转终态 */
  async function abortPlan(planId: string, reason = '班组中止'): Promise<void> {
    const plan = plans.value.find((item) => item.id === planId)
    if (!plan || plan.state !== '执行中') return
    const now = Date.now()
    await persistPlan({
      ...plan,
      state: '已中止' as GridPlanState,
      lastError: null,
      items: plan.items.map((item) =>
        item.state === '待执行' || item.state === '待确认'
          ? { ...item, state: '已跳过', updatedAt: now }
          : item
      ),
      updatedAt: now
    })
    notice.value = `方案已中止（${reason}），已确认 ${plan.items.filter((item) => item.state === '已确认').length} 项保留`
  }

  /**
   * 执行单项：回填实际开度与新实测。
   * 先检测台账开度相对冻结值是否被同时编辑：
   * - 一致 → 直接按调节值回写并确认
   * - 不一致且未记录过冲突 → 不落任何一边，转「待确认」并保留两方来源
   */
  async function executeItem(planId: string, adjustId: string, draft: GridExecuteDraft): Promise<void> {
    const plan = plans.value.find((item) => item.id === planId)
    if (!plan || plan.state !== '执行中') throw new Error('方案不可执行')
    const item = plan.items.find((entry) => entry.adjustId === adjustId)
    if (!item) throw new Error('调节单不在方案内')
    if (item.state === '已确认') throw new Error('该项已确认，不再重算')
    if (item.state === '待确认') throw new Error('该单存在开度冲突，请先确认采用台账还是调节来源')

    const actual = clampOpening(draft.actualOpening)
    const valve = await db.valves.get(item.valveId)
    const ledgerNow = valve ? valve.currentOpening : item.frozenOpening
    const now = Date.now()

    const next: GridPlanItem = {
      ...item,
      actualOpening: actual,
      newFlowM3h: round1(draft.newFlowM3h),
      newSupplyTempC: round1(draft.newSupplyTempC),
      newReturnTempC: round1(draft.newReturnTempC),
      newRoomTempC: round1(draft.newRoomTempC),
      newMeasureDate: draft.newMeasureDate || todayString(),
      executor: draft.executor.trim() || plan.executor || '待指派',
      updatedAt: now
    }

    const ledgerDrifted = valve ? ledgerNow !== item.frozenOpening : false
    // 台账被阀位登记页同时编辑，且与现场回填值不一致：两方开度都保留，互不相盖
    if (ledgerDrifted && ledgerNow !== actual) {
      next.ledgerOpening = ledgerNow
      next.state = '待确认'
      next.conflict = item.conflict
        ? { ...item.conflict, ledger: ledgerNow, adjust: actual }
        : { ledger: ledgerNow, adjust: actual, pending: 'ledger' }
      await saveWithRecovery(plan, next, now)
      return
    }

    // 无冲突（或台账改后恰与现场值一致）：按调节值回写台账、追加新实测、推进调节单并确认
    await commitConfirmed(plan, next, actual, now)
  }

  /**
   * 冲突确认：选择台账来源或调节来源（也可人工给第三值）。
   * 确认后按采用值回写台账、追加新实测，置「已确认」，不再重算。
   */
  async function resolveConflict(
    planId: string,
    adjustId: string,
    decision: GridConflictDecision
  ): Promise<void> {
    const plan = plans.value.find((item) => item.id === planId)
    if (!plan) throw new Error('方案不存在')
    if (plan.state !== '执行中') throw new Error('方案已结束，不能再确认冲突')
    const item = plan.items.find((entry) => entry.adjustId === adjustId)
    if (!item || !item.conflict) throw new Error('该单没有待确认冲突')

    const manual = decision.opening !== undefined ? clampOpening(decision.opening) : null
    const adopted = manual ?? (decision.source === 'ledger' ? item.conflict.ledger : item.conflict.adjust)
    const now = Date.now()
    const next: GridPlanItem = {
      ...item,
      actualOpening: item.actualOpening ?? adopted,
      ledgerOpening: item.conflict.ledger,
      conflict: { ...item.conflict, pending: decision.source },
      updatedAt: now
    }
    await commitConfirmed(plan, next, adopted, now, manual !== null ? `人工裁定 ${manual}%` : undefined)
  }

  /** 已确认落库：台账开度回写、追加新实测、调节单推进为已调节 */
  async function commitConfirmed(
    plan: GridPlan,
    item: GridPlanItem,
    adoptedOpening: number,
    now: number,
    note?: string
  ): Promise<void> {
    try {
      if (plan.failNextSave) {
        // 演示保存失败：不触碰任何业务表，仅记录错误，等待重新打开后恢复
        throw new Error('本地写入失败（模拟）：浏览器存储空间不可用')
      }
      await db.transaction('rw', db.valves, db.measures, db.adjusts, db.gridplans, async () => {
        const valve = await db.valves.get(item.valveId)
        if (valve) {
          await db.valves.put({ ...valve, currentOpening: clampOpening(adoptedOpening), updatedAt: now })
        }
        if (!item.measureWritten && item.newFlowM3h !== null) {
          const measure: MeasureRow = {
            id: createId('ms'),
            valveId: item.valveId,
            date: item.newMeasureDate || todayString(),
            flowM3h: round1(item.newFlowM3h),
            supplyTempC: item.newSupplyTempC ?? 0,
            returnTempC: item.newReturnTempC ?? 0,
            roomTempC: item.newRoomTempC ?? 20,
            operator: item.executor || '调网方案',
            createdAt: now,
            updatedAt: now,
            revision: ROW_REVISION
          }
          await db.measures.put(measure)
        }
        const adjust = await db.adjusts.get(item.adjustId)
        if (adjust && adjust.state === '待下发') {
          await db.adjusts.put({
            ...adjust,
            state: '已调节',
            executor: item.executor || adjust.executor,
            reviewNote: note
              ? `${adjust.reviewNote ? adjust.reviewNote + '；' : ''}台账冲突已确认：${note}`
              : adjust.reviewNote,
            gridPlanId: plan.id,
            updatedAt: now
          })
        } else if (adjust) {
          await db.adjusts.put({ ...adjust, gridPlanId: plan.id, updatedAt: now })
        }

        const confirmed: GridPlanItem = {
          ...item,
          state: '已确认',
          conflict: item.conflict ? { ...item.conflict } : null,
          measureWritten: true,
          confirmedAt: now,
          updatedAt: now
        }
        const items = plan.items.map((entry) => (entry.adjustId === item.adjustId ? confirmed : entry))
        const allDone = items.every((entry) => entry.state === '已确认' || entry.state === '已跳过')
        const nextPlan: GridPlanRow = {
          ...plan,
          items,
          state: allDone ? '已完成' : '执行中',
          lastError: null,
          updatedAt: now
        }
        await db.gridplans.put(withRevision(nextPlan))
      })
      notice.value = null
    } catch (error) {
      // 保存失败：方案原样保留（不落半条），记录错误，重新打开可从最后确认的一张继续
      await saveFailedPlan(plan, item, error)
      throw error
    }
  }

  /** 冲突未确认时的轻量保存（仅写方案表，业务表不动） */
  async function saveWithRecovery(plan: GridPlan, item: GridPlanItem, now: number): Promise<void> {
    try {
      if (plan.failNextSave) throw new Error('本地写入失败（模拟）：浏览器存储空间不可用')
      const nextPlan: GridPlanRow = withRevision({
        ...plan,
        items: plan.items.map((entry) => (entry.adjustId === item.adjustId ? item : entry)),
        lastError: null,
        updatedAt: now
      })
      await db.gridplans.put(nextPlan)
      notice.value = null
    } catch (error) {
      await saveFailedPlan(plan, item, error)
      throw error
    }
  }

  /** 失败落库：尝试把方案状态持久化为 lastError；若连这步也失败则靠内存提示 */
  async function saveFailedPlan(plan: GridPlan, pendingItem: GridPlanItem, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : '保存失败'
    try {
      const nextPlan: GridPlanRow = withRevision({
        ...plan,
        failNextSave: false,
        items: plan.items.map((entry) => (entry.adjustId === pendingItem.adjustId ? pendingItem : entry)),
        lastError: message,
        updatedAt: Date.now()
      })
      await db.gridplans.put(nextPlan)
    } catch {
      /* 库不可写：保留页面内存态，重新打开页面后从上一已确认项恢复 */
    }
    notice.value = `保存失败：${message}。数据未半写，可重新打开后从最后确认的一张单继续`
  }

  /** 重新打开后恢复：清理失败标记；已确认项不重算，返回应继续的第一项（待执行/待确认） */
  async function recoverPlan(planId: string): Promise<GridPlanItem | null> {
    const plan = plans.value.find((item) => item.id === planId)
    if (!plan) return null
    if (plan.lastError || plan.failNextSave) {
      const nextPlan: GridPlanRow = withRevision({
        ...plan,
        failNextSave: false,
        lastError: null,
        updatedAt: Date.now()
      })
      await db.gridplans.put(nextPlan)
      notice.value = '已从上次中断处恢复，已确认项不重算'
    }
    return plan.items.find((item) => item.state === '待执行' || item.state === '待确认') ?? null
  }

  async function persistPlan(plan: GridPlanRow): Promise<void> {
    await db.gridplans.put(withRevision({ ...plan, updatedAt: Date.now() }))
  }

  /** 演示/测试用：让下一次保存强制失败，验证保存失败后的恢复链路 */
  async function armFailNextSave(planId: string): Promise<void> {
    const plan = plans.value.find((item) => item.id === planId)
    if (!plan) return
    await persistPlan({ ...plan, failNextSave: true })
  }

  async function removePlan(planId: string): Promise<void> {
    await db.gridplans.delete(planId)
    notice.value = null
  }

  const progress = computed(() => {
    const plan = activePlan.value
    if (!plan) return { total: 0, confirmed: 0, pending: 0, conflict: 0, percent: 0 }
    const confirmed = plan.items.filter((item) => item.state === '已确认').length
    const conflict = plan.items.filter((item) => item.state === '待确认').length
    const pending = plan.items.filter((item) => item.state === '待执行').length
    return {
      total: plan.items.length,
      confirmed,
      pending,
      conflict,
      percent: plan.items.length === 0 ? 0 : Math.round((confirmed / plan.items.length) * 100)
    }
  })

  return {
    planTable,
    plans,
    activePlan,
    hasActivePlan,
    progress,
    notice,
    setNotice,
    planOfStation,
    startPlan,
    abortPlan,
    executeItem,
    resolveConflict,
    recoverPlan,
    armFailNextSave,
    removePlan
  }
})

function withRevision(plan: GridPlan): GridPlanRow {
  return { ...plan, revision: ROW_REVISION }
}

function round1(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 10) / 10
}
