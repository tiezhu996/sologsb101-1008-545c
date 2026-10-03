/**
 * 调网方案：在失衡度计算页按换热站发起的一次可中止调网作业。
 * - 选站后冻结该站各阀门的台账开度、最新实测与目标开度（方案依据不再随后续读数变化）
 * - 逐张执行并回填实际开度与新实测；已确认项不再重算
 * - 执行时阀门台账开度被同时编辑形成冲突时，保留台账/调节两方来源待人工确认
 * - 保存中断后可重新打开，从最后确认的一张单继续
 */
import type { BalanceLevel } from '@/utils/balance'

/** 单项执行状态 */
export type GridItemState = '待执行' | '待确认' | '已确认' | '已跳过'

/** 冲突来源：台账（阀位登记页同时编辑）/ 调节（现场回填的实际开度） */
export type GridConflictSource = 'ledger' | 'adjust'

/** 方案整体状态：执行中可中止；中止/完成均为终态 */
export type GridPlanState = '执行中' | '已中止' | '已完成'

/** 调网方案中单个阀门的冻结基线与执行回填 */
export interface GridPlanItem {
  /** 关联调节单 id（建方案时即冻结到调节单上） */
  adjustId: string
  valveId: string
  valveCode: string
  buildingName: string
  /* ------------------------- 冻结快照（选站时） ------------------------- */
  /** 冻结的阀门台账开度（%） */
  frozenOpening: number
  /** 冻结的目标开度（%） */
  targetOpening: number
  /** 冻结的最新实测流量（m³/h） */
  frozenFlowM3h: number
  frozenMeasureDate: string
  frozenRoomTempC: number
  frozenRatio: number
  frozenImbalance: number
  frozenLevel: BalanceLevel
  /* ---------------------------- 执行回填 ---------------------------- */
  state: GridItemState
  /** 现场回填的实际开度（%） */
  actualOpening: number | null
  /** 执行后新实测流量（m³/h） */
  newFlowM3h: number | null
  newSupplyTempC: number | null
  newReturnTempC: number | null
  newRoomTempC: number | null
  newMeasureDate: string
  executor: string
  /** 台账来源开度：执行瞬间检测到台账已偏离冻结值时记录 */
  ledgerOpening: number | null
  /** 冲突待确认时两方开度；无冲突为 null */
  conflict:
    | {
        ledger: number
        adjust: number
        /** 待确认来源；确认后写回实际采用值 */
        pending: GridConflictSource
      }
    | null
  /** 新实测已写入 measures 表（保证中断重开不重复写） */
  measureWritten: boolean
  confirmedAt: number | null
  updatedAt: number
}

export interface GridPlan {
  id: string
  stationId: string
  stationName: string
  state: GridPlanState
  /** 执行人（方案级，执行单项时默认带出） */
  executor: string
  items: GridPlanItem[]
  /** 最近一次保存失败原因（null 表示已与本地库一致） */
  lastError: string | null
  /** 演示用：置位后下一次执行保存强制失败，用于验证恢复链路 */
  failNextSave: boolean
  createdAt: number
  updatedAt: number
}

export const GRID_ITEM_STATES: GridItemState[] = ['待执行', '待确认', '已确认', '已跳过']

export const GRID_PLAN_STATES: GridPlanState[] = ['执行中', '已中止', '已完成']

/** 执行回填表单 */
export interface GridExecuteDraft {
  actualOpening: number
  newFlowM3h: number
  newSupplyTempC: number
  newReturnTempC: number
  newRoomTempC: number
  newMeasureDate: string
  executor: string
}

/** 冲突确认选择 */
export interface GridConflictDecision {
  source: GridConflictSource
  /** 允许人工直接给出第三值（可选，优先于来源选择） */
  opening?: number
}

export function todayString(): string {
  return new Date().toISOString().slice(0, 10)
}
