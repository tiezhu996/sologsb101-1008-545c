/** 调节单：由失衡度排序生成，执行与复核分两步回写状态 */
export type AdjustState = '待下发' | '已调节' | '已复核'

/**
 * 调节依据基线：生成/纳入调网方案时冻结的台账开度、最新实测与目标开度。
 * 读数再变，建议依据始终可追溯到冻结的这一组数据。
 * 旧调节单首次打开时若缺失则按当时数据补出，并以 baselineBackfilled 标记「补录」。
 */
export interface AdjustBaseline {
  /** 冻结时的阀门台账开度（%） */
  opening: number
  /** 冻结时的目标开度建议（%） */
  targetOpening: number
  /** 冻结时的最新实测流量（m³/h），无实测为 null */
  measuredFlowM3h: number | null
  measureDate: string
  roomTempC: number | null
  ratio: number | null
  imbalanceValue: number | null
  frozenAt: number
  /** true = 旧单首次打开时补算的基线，并非生成当时冻结 */
  backfilled?: boolean
}

export interface Adjust {
  id: string
  valveId: string
  /** 目标开度（%） */
  targetOpening: number
  /** 调节依据（原文始终保留，可查看） */
  basis: string
  executor: string
  state: AdjustState
  /** 复核意见 */
  reviewNote: string
  /** 冻结的依据基线；旧单首次打开时补录 */
  baseline?: AdjustBaseline
  /** 若由调网方案执行，记录方案 id 便于双向追溯 */
  gridPlanId?: string
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
