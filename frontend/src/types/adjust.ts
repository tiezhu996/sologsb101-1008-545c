/**
 * 调节单与调网方案
 *
 * 调节单：由失衡度排序生成，执行与复核分两步回写状态。
 * 调网方案：在失衡度计算页按换热站发起，发起时冻结每张单的基线（阀门开度、
 * 最新实测、目标开度），执行时回填实际开度与新实测；执行与阀门台账同时改动
 * 同一开度时两方来源都保留、互不覆盖，待调度确认。
 */

/** 调节单：由失衡度排序生成，执行与复核分两步回写状态 */
export type AdjustState = '待下发' | '已调节' | '已复核'

/** 基线快照：发起方案（或旧单首次打开补录）时冻结，作为后续建议依据，不再随读数重算 */
export interface AdjustBaseline {
  /** 冻结时阀门当前开度（%） */
  currentOpening: number
  /** 冻结时最新实测流量（m³/h），无实测为 null */
  measuredFlowM3h: number | null
  /** 冻结时最新实测室温（℃） */
  roomTempC: number | null
  /** 冻结时最新实测日期 YYYY-MM-DD */
  measureDate: string | null
  /** 冻结时的设计流量（m³/h） */
  designFlowM3h: number
  /** 冻结时的流量比 */
  ratio: number
  /** 冻结时的合成失衡度（%） */
  imbalanceValue: number
  /** 冻结时的判级 */
  level: string
  /** 冻结时给出的目标开度（%） */
  targetOpening: number
  /** 冻结时间戳 */
  frozenAt: number
  /** true 表示旧调节单首次打开时补录的基线（原依据 basis 仍保留可查） */
  backfilled: boolean
}

/** 执行回填：现场执行后回填的实际开度与新实测 */
export interface AdjustExecution {
  /** 实际开度（%） */
  actualOpening: number
  /** 执行后新实测流量（m³/h） */
  flowM3h: number | null
  /** 执行后新实测室温（℃） */
  roomTempC: number | null
  /** 执行后新实测日期 YYYY-MM-DD */
  measureDate: string | null
  /** 执行/回填人 */
  executor: string
  /** 回填时间戳 */
  recordedAt: number
}

/**
 * 开度冲突：方案执行回填与阀门台账同时编辑同一开度且取值不一致时，
 * 两方来源都保留，任一边都不覆盖另一边，待人工确认。
 */
export interface OpeningConflict {
  /** 方案执行回填的实际开度（%） */
  executionOpening: number
  /** 阀门台账当时的开度（%） */
  ledgerOpening: number
  /** 台账侧改动时间戳 */
  ledgerUpdatedAt: number
  /** 冲突登记时间戳 */
  detectedAt: number
  /** 是否已确认 */
  resolved: boolean
  /** 最终采用：execution 方案侧 / ledger 台账侧 */
  resolution?: 'execution' | 'ledger'
  /** 确认说明 */
  resolutionNote?: string
  resolvedAt?: number
}

export interface Adjust {
  id: string
  valveId: string
  /** 目标开度（%）；方案发起后以冻结基线为准，不随新读数重算 */
  targetOpening: number
  /** 调节依据（旧单原始依据始终保留） */
  basis: string
  executor: string
  state: AdjustState
  /** 复核意见 */
  reviewNote: string
  /** 冻结基线快照，旧单首次打开时惰性补录 */
  baseline?: AdjustBaseline | null
  /** 执行回填 */
  execution?: AdjustExecution | null
  /** 执行与台账开度冲突；未解决时任何一边都不得覆盖 */
  openingConflict?: OpeningConflict | null
  /** 所属调网方案 id */
  planId?: string | null
  createdAt: number
  updatedAt: number
}

export const ADJUST_STATES: AdjustState[] = ['待下发', '已调节', '已复核']

/** 调节单状态机：待下发 → 已调节 → 已复核 */
export const ADJUST_STATE_FLOW: Record<AdjustState, AdjustState | null> = {
  待下发: '已调节',
  已调节: '已复核',
  已复核: null
}

export interface AdjustDraft {
  valveId: string
  targetOpening: number
  basis: string
  executor: string
  state: AdjustState
  reviewNote: string
}

export const EMPTY_ADJUST_DRAFT: AdjustDraft = {
  valveId: '',
  targetOpening: 50,
  basis: '',
  executor: '',
  state: '待下发',
  reviewNote: ''
}

/* ============================== 调网方案 ============================== */

/** 方案状态：进行中可中止 → 已中止（可继续）/ 已完成 */
export type PlanState = '进行中' | '已中止' | '已完成'

export const PLAN_STATES: PlanState[] = ['进行中', '已中止', '已完成']

/** 方案内单项的执行状态（由调节单字段派生） */
export type PlanItemState = '待执行' | '已回填' | '开度冲突' | '已复核'

/** 调网方案：按换热站发起，发起即冻结该站全部阀门的基线 */
export interface AdjustPlan {
  id: string
  stationId: string
  stationName: string
  state: PlanState
  /** 发起时冻结时间戳 */
  frozenAt: number
  /** 最近一次从第几张单继续（最后确认项之后一张的调节单 id） */
  resumeAdjustId?: string | null
  abortedAt?: number | null
  completedAt?: number | null
  createdAt: number
  updatedAt: number
}

/** 方案单项视图：调节单 + 阀门/楼栋信息 + 派生状态 */
export interface PlanItem {
  adjustId: string
  valveId: string
  valveCode: string
  buildingName: string
  targetOpening: number
  baseline: AdjustBaseline | null
  execution: AdjustExecution | null
  openingConflict: OpeningConflict | null
  state: AdjustState
  itemState: PlanItemState
}

/** 保存失败时暂存到 localStorage 的执行草稿（一张单一份） */
export interface PlanExecutionDraft {
  planId: string
  adjustId: string
  actualOpening: number
  flowM3h: number | null
  roomTempC: number | null
  measureDate: string
  executor: string
  /** 同时登记一条新实测 */
  createMeasure: boolean
  savedAt: number
}

/** 方案是否已关闭（中止或完成）；已关闭的方案仍可打开继续/查看 */
export function isPlanClosed(plan: AdjustPlan): boolean {
  return plan.state === '已中止' || plan.state === '已完成'
}

/** 调节单是否已在方案中确认过（已回填/冲突/复核），确认后基线不再重算 */
export function isAdjustConfirmed(adjust: Pick<Adjust, 'execution' | 'openingConflict' | 'state'>): boolean {
  return adjust.execution !== null && adjust.execution !== undefined
    || adjust.openingConflict !== null && adjust.openingConflict !== undefined
    || adjust.state === '已复核'
}

/**
 * 方案单项是否已真正办结：已复核，或已回填且无未解决冲突。
 * 未解决的开度冲突仍属「待继续」，不能跳过、不能据此完成方案。
 */
export function isPlanItemDone(adjust: Pick<Adjust, 'execution' | 'openingConflict' | 'state'>): boolean {
  const hasUnresolvedConflict = adjust.openingConflict !== null
    && adjust.openingConflict !== undefined
    && !adjust.openingConflict.resolved
  return adjust.state === '已复核' || (adjust.execution !== null && adjust.execution !== undefined && !hasUnresolvedConflict)
}

/** 方案单项派生状态 */
export function derivePlanItemState(
  adjust: Pick<Adjust, 'execution' | 'openingConflict' | 'state'>
): PlanItemState {
  if (adjust.openingConflict && !adjust.openingConflict.resolved) return '开度冲突'
  if (adjust.state === '已复核') return '已复核'
  if (adjust.execution) return '已回填'
  return '待执行'
}
