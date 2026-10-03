<script setup lang="ts">
/**
 * <PlanWizardDialog> 可中止的调网方案向导
 * - 发起时冻结该站全部阀门的开度 / 最新实测 / 目标开度基线；
 * - 逐张执行回填实际开度与新实测，执行时若阀门台账同开度被另一处编辑，
 *   两方来源都保留、互不覆盖，弹窗内确认采用哪一方；
 * - 保存失败时执行草稿落本地，重新打开从最后确认的一张继续，已确认项不重算；
 * - 旧调节单首次打开补出基线（标记补录），原依据仍可查看。
 */
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import { usePlanStore } from '@/stores/planStore'
import { useAdjustStore } from '@/stores/adjustStore'
import { useValveStore } from '@/stores/valveStore'
import { formatFlow, formatOpening, formatTemp } from '@/utils/balance'
import { clampOpening } from '@/types/valve'
import type { AdjustPlanRow } from '@/utils/db'
import type { ConfirmExecutionInput } from '@/stores/adjustStore'
import { isPlanItemDone, type PlanExecutionDraft, type PlanItem } from '@/types/adjust'

const props = defineProps<{ visible: boolean; plan: AdjustPlanRow | null }>()
const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void
  (event: 'changed'): void
}>()

const planStore = usePlanStore()
const adjustStore = useAdjustStore()
const valveStore = useValveStore()

const items = ref<PlanItem[]>([])
const drafts = ref<PlanExecutionDraft[]>([])
const activeAdjustId = ref<string>('')
const backfillNotice = ref(0)
const simulateSaveFailure = ref(false)

interface ExecForm {
  actualOpening: number
  flowM3h: number | null
  roomTempC: number | null
  measureDate: string
  executor: string
  createMeasure: boolean
}

function emptyForm(): ExecForm {
  return {
    actualOpening: 50,
    flowM3h: null,
    roomTempC: 20,
    measureDate: new Date().toISOString().slice(0, 10),
    executor: '',
    createMeasure: true
  }
}

const form = reactive<ExecForm>(emptyForm())

const dialogVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value)
})

const plan = computed(() => props.plan)

const progress = computed(() => (plan.value ? planStore.progressOfPlan(plan.value.id) : { total: 0, confirmed: 0, pending: 0 }))

function refreshViews(): void {
  if (!plan.value) return
  items.value = planStore.itemsOfPlan(plan.value.id)
  drafts.value = planStore.draftsOfPlan(plan.value.id)
}

const activeItem = computed<PlanItem | null>(
  () => items.value.find((item) => item.adjustId === activeAdjustId.value) ?? null
)

const activeAdjust = computed(() =>
  plan.value ? adjustStore.adjusts.find((item) => item.id === activeAdjustId.value) ?? null : null
)

/** 台账实时开度（与冻结基线/方案实际开度比较，用于冲突提示） */
const liveLedgerOpening = computed<number | null>(() => {
  if (!activeItem.value) return null
  const valve = valveStore.valves.find((item) => item.id === activeItem.value!.valveId)
  return valve ? valve.currentOpening : null
})

const activeDraft = computed<PlanExecutionDraft | null>(
  () => drafts.value.find((draft) => draft.adjustId === activeAdjustId.value) ?? null
)

/** 该单是否已办结：已复核，或已回填且无未解决冲突。未解决冲突仍需处理，不算办结 */
function isDone(item: PlanItem): boolean {
  const raw = adjustStore.adjusts.find((adjust) => adjust.id === item.adjustId)
  return raw ? isPlanItemDone(raw) : item.itemState === '已复核' || item.itemState === '已回填'
}

/** 存在未解决开度冲突：先确认两方开度，不能再次回填覆盖 */
function hasUnresolvedConflict(item: PlanItem): boolean {
  return !!item.openingConflict && !item.openingConflict.resolved
}

/** 回填表单是否只读：已办结，或存在未解决冲突（冲突解决/暂存重试除外） */
function formReadonly(item: PlanItem): boolean {
  return isDone(item) || hasUnresolvedConflict(item)
}

function selectItem(item: PlanItem): void {
  activeAdjustId.value = item.adjustId
  hydrateForm(item)
}

function hydrateForm(item: PlanItem): void {
  const draft = drafts.value.find((entry) => entry.adjustId === item.adjustId)
  if (draft) {
    Object.assign(form, {
      actualOpening: draft.actualOpening,
      flowM3h: draft.flowM3h,
      roomTempC: draft.roomTempC,
      measureDate: draft.measureDate,
      executor: draft.executor,
      createMeasure: draft.createMeasure
    })
    return
  }
  if (item.execution) {
    Object.assign(form, {
      actualOpening: item.execution.actualOpening,
      flowM3h: item.execution.flowM3h,
      roomTempC: item.execution.roomTempC,
      measureDate: item.execution.measureDate ?? new Date().toISOString().slice(0, 10),
      executor: item.execution.executor,
      createMeasure: item.execution.flowM3h !== null
    })
    return
  }
  Object.assign(form, {
    ...emptyForm(),
    actualOpening: item.targetOpening,
    executor: item.state === '待下发' ? '' : ''
  })
}

/* ------------------------------ 打开 / 恢复 ------------------------------ */

async function loadPlan(useResumeCursor: boolean): Promise<void> {
  if (!plan.value) return
  let reopened = false
  // 旧单首次打开：补出缺失基线（仅补空，不重算已冻结/已确认项）
  backfillNotice.value = await planStore.backfillMissingBaselines(plan.value.id)
  refreshViews()
  let targetId: string | null = null
  if (useResumeCursor) {
    // 中止后重新打开：恢复为进行中，并取回「最后确认的一张」之后的游标
    const resumedId = await planStore.reopenPlan(plan.value.id)
    reopened = true
    // 保存失败后重新打开：优先定位到有暂存草稿的那张
    const pendingDraft = drafts.value[0]
    targetId = pendingDraft?.adjustId ?? resumedId
  }
  if (reopened) emit('changed')
  if (!targetId) {
    targetId = items.value.find((item) => !isDone(item))?.adjustId ?? items.value[0]?.adjustId ?? null
  }
  activeAdjustId.value = targetId ?? ''
  const first = items.value.find((item) => item.adjustId === activeAdjustId.value)
  if (first) hydrateForm(first)
  if (backfillNotice.value > 0) {
    MessagePlugin.info(`已为 ${backfillNotice.value} 张旧调节单补出基线，原依据保留可查`)
  }
}

watch(
  () => props.visible,
  (visible) => {
    if (visible && plan.value) {
      void loadPlan(true)
    }
  }
)

watch(
  () => adjustStore.adjusts,
  () => {
    if (props.visible) refreshViews()
  },
  { deep: true }
)

/* ------------------------------ 执行确认 ------------------------------ */

function buildInput(): ConfirmExecutionInput {
  return {
    actualOpening: clampOpening(form.actualOpening),
    flowM3h: form.flowM3h,
    roomTempC: form.roomTempC,
    measureDate: form.measureDate || null,
    executor: form.executor.trim(),
    createMeasure: form.createMeasure
  }
}

async function confirmActive(): Promise<void> {
  if (!plan.value || !activeItem.value) return
  if (hasUnresolvedConflict(activeItem.value) && !activeDraft.value) {
    MessagePlugin.warning('存在未确认的开度冲突，请先在上方确认采用方案还是台账的开度')
    return
  }
  if (isDone(activeItem.value) && !activeDraft.value) {
    MessagePlugin.info('该单已确认，基线与回填不再重算')
    return
  }
  try {
    const result = await planStore.confirmItem(
      plan.value.id,
      activeItem.value.adjustId,
      buildInput(),
      { simulateSaveFailure: simulateSaveFailure.value }
    )
    simulateSaveFailure.value = false
    emit('changed')
    refreshViews()
    if (result.conflict) {
      MessagePlugin.warning('台账开度与方案实际开度不一致：两方来源已保留，等待确认，任一边均未覆盖')
    } else {
      MessagePlugin.success('已回填实际开度与新实测')
    }
    gotoNext(activeItem.value.adjustId)
  } catch (error) {
    // 保存失败：草稿已落本地，重新打开可从该单继续
    refreshViews()
    MessagePlugin.error(`保存失败，执行内容已暂存：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

async function retryDraft(): Promise<void> {
  if (!plan.value || !activeDraft.value) return
  try {
    await planStore.retryDraftItem(plan.value.id, activeDraft.value, buildInput())
    emit('changed')
    refreshViews()
    MessagePlugin.success('暂存内容已重新保存成功')
    gotoNext(activeDraft.value.adjustId)
  } catch (error) {
    refreshViews()
    MessagePlugin.error(`仍保存失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

function discardActiveDraft(): void {
  if (!plan.value || !activeDraft.value) return
  planStore.discardDraft(plan.value.id, activeDraft.value.adjustId)
  refreshViews()
  if (activeItem.value) hydrateForm(activeItem.value)
  MessagePlugin.success('已丢弃该单暂存内容')
}

function gotoNext(afterAdjustId: string): void {
  if (!plan.value) return
  const nextId = planStore.nextPendingAdjustId(plan.value.id, afterAdjustId)
  if (nextId) {
    activeAdjustId.value = nextId
    const item = items.value.find((entry) => entry.adjustId === nextId)
    if (item) hydrateForm(item)
  } else {
    void nextTick(() => {
      const anyPending = items.value.find((entry) => !isDone(entry))
      if (anyPending) selectItem(anyPending)
    })
  }
}

/* ------------------------------ 冲突确认 ------------------------------ */

const resolveVisible = ref(false)
const resolveChoice = ref<'execution' | 'ledger'>('execution')
const resolveNote = ref('')

function openResolve(): void {
  resolveChoice.value = 'execution'
  resolveNote.value = ''
  resolveVisible.value = true
}

async function submitResolve(): Promise<void> {
  if (!plan.value || !activeItem.value) return
  await adjustStore.resolveOpeningConflict(activeItem.value.adjustId, resolveChoice.value, resolveNote.value)
  resolveVisible.value = false
  emit('changed')
  refreshViews()
  MessagePlugin.success(
    resolveChoice.value === 'execution' ? '已采用方案实际开度回写台账' : '保留台账开度，方案实际开度留存在执行记录中'
  )
}

/* ------------------------------ 中止 / 完成 ------------------------------ */

async function abortPlan(): Promise<void> {
  if (!plan.value) return
  await planStore.abortPlan(plan.value.id)
  emit('changed')
  MessagePlugin.success('方案已中止，已确认项与暂存内容保留，可随时继续')
  dialogVisible.value = false
}

async function completePlan(): Promise<void> {
  if (!plan.value) return
  try {
    await planStore.completePlan(plan.value.id)
    emit('changed')
    MessagePlugin.success('调网方案已完成')
    dialogVisible.value = false
  } catch (error) {
    MessagePlugin.warning(error instanceof Error ? error.message : '尚有未确认项')
  }
}

function closeOnly(): void {
  dialogVisible.value = false
}

function itemTagTheme(item: PlanItem): 'default' | 'warning' | 'success' | 'primary' | 'danger' {
  if (item.itemState === '开度冲突') return 'danger'
  if (item.itemState === '已复核') return 'success'
  if (item.itemState === '已回填') return 'primary'
  return 'default'
}
</script>

<template>
  <t-dialog
    v-model:visible="dialogVisible"
    :header="plan ? `调网方案 · ${plan.stationName}` : '调网方案'"
    width="1040px"
    :footer="false"
    :close-on-overlay-click="false"
  >
    <div v-if="plan" class="wizard">
      <div class="wizard__head">
        <div>
          <t-tag size="small" :theme="plan.state === '进行中' ? 'primary' : plan.state === '已中止' ? 'warning' : 'success'" variant="light">
            {{ plan.state }}
          </t-tag>
          <span class="muted" style="margin-left: 8px">
            基线冻结于 {{ new Date(plan.frozenAt).toLocaleString('zh-CN') }}
          </span>
        </div>
        <div class="muted">
          进度 {{ progress.confirmed }} / {{ progress.total }}，待确认 {{ progress.pending }}
        </div>
      </div>

      <t-progress
        :percentage="progress.total === 0 ? 0 : Math.round((progress.confirmed / progress.total) * 100)"
        style="margin: 10px 0 14px"
      />

      <div class="wizard__body">
        <!-- 左：单列表 -->
        <div class="wizard__list">
          <div
            v-for="item in items"
            :key="item.adjustId"
            class="wizard__item"
            :class="{ 'is-active': item.adjustId === activeAdjustId }"
            @click="selectItem(item)"
          >
            <div class="wizard__item-head">
              <strong>{{ item.valveCode }}</strong>
              <t-tag size="small" :theme="itemTagTheme(item)" variant="light">{{ item.itemState }}</t-tag>
            </div>
            <div class="muted">{{ item.buildingName }} · 目标 {{ formatOpening(item.targetOpening) }}</div>
            <div v-if="drafts.some((d) => d.adjustId === item.adjustId)" class="wizard__item-draft">
              有暂存待恢复
            </div>
          </div>
          <p v-if="items.length === 0" class="muted">该站暂无可调节阀门。</p>
        </div>

        <!-- 右：当前单 -->
        <div class="wizard__detail" v-if="activeItem">
          <div class="wizard__detail-head">
            <div>
              <strong style="font-size: 15px">{{ activeItem.valveCode }}</strong>
              <span class="muted" style="margin-left: 8px">{{ activeItem.buildingName }}</span>
            </div>
            <t-tag size="small" :theme="itemTagTheme(activeItem)" variant="light">{{ activeItem.itemState }}</t-tag>
          </div>

          <!-- 冻结基线（建议依据） -->
          <div class="wizard__block">
            <div class="wizard__block-title">
              冻结基线（建议依据）
              <t-tag v-if="activeItem.baseline?.backfilled" size="small" theme="warning" variant="light">旧单补录</t-tag>
            </div>
            <div v-if="activeItem.baseline" class="wizard__grid">
              <div><span class="muted">冻结阀门开度</span><strong>{{ formatOpening(activeItem.baseline.currentOpening) }}</strong></div>
              <div><span class="muted">目标开度</span><strong>{{ formatOpening(activeItem.baseline.targetOpening) }}</strong></div>
              <div>
                <span class="muted">最新实测</span>
                <strong v-if="activeItem.baseline.measuredFlowM3h !== null">
                  {{ formatFlow(activeItem.baseline.measuredFlowM3h) }}
                </strong>
                <strong v-else>无实测</strong>
              </div>
              <div>
                <span class="muted">室温</span>
                <strong>{{ activeItem.baseline.roomTempC !== null ? formatTemp(activeItem.baseline.roomTempC) : '—' }}</strong>
              </div>
              <div><span class="muted">流量比</span><strong>{{ activeItem.baseline.ratio.toFixed(2) }}</strong></div>
              <div>
                <span class="muted">失衡度</span>
                <strong>{{ activeItem.baseline.imbalanceValue.toFixed(1) }}%（{{ activeItem.baseline.level }}）</strong>
              </div>
            </div>
            <p v-else class="muted">基线补录中…</p>
            <details class="wizard__basis">
              <summary class="muted">查看原调节依据</summary>
              <p>{{ activeAdjust?.basis ?? '—' }}</p>
            </details>
          </div>

          <!-- 台账实时状态 -->
          <div class="wizard__block">
            <div class="wizard__block-title">阀门台账（实时）</div>
            <p class="muted" style="margin: 4px 0">
              当前台账开度：
              <strong>{{ liveLedgerOpening !== null ? formatOpening(liveLedgerOpening) : '—' }}</strong>
              <span v-if="activeItem.baseline && liveLedgerOpening !== null && liveLedgerOpening !== activeItem.baseline.currentOpening">
                （台账已被改动，与冻结基线 {{ formatOpening(activeItem.baseline.currentOpening) }} 不同）
              </span>
            </p>
          </div>

          <!-- 未解决冲突：两方来源保留 -->
          <div v-if="activeItem.openingConflict && !activeItem.openingConflict.resolved" class="wizard__conflict">
            <div class="wizard__conflict-title">开度冲突待确认（两方来源均保留，未互相覆盖）</div>
            <div class="wizard__conflict-grid">
              <div>
                <span class="muted">方案执行实际开度</span>
                <strong>{{ formatOpening(activeItem.openingConflict.executionOpening) }}</strong>
              </div>
              <div>
                <span class="muted">阀门台账开度</span>
                <strong>{{ formatOpening(activeItem.openingConflict.ledgerOpening) }}</strong>
              </div>
            </div>
            <t-button size="small" theme="danger" variant="outline" @click="openResolve">确认采用哪一方</t-button>
          </div>
          <div v-else-if="activeItem.openingConflict?.resolved" class="wizard__block">
            <div class="wizard__block-title">冲突已确认</div>
            <p class="muted" style="margin: 4px 0">
              采用{{ activeItem.openingConflict.resolution === 'execution' ? '方案实际开度' : '阀门台账开度' }}
              <template v-if="activeItem.openingConflict.resolutionNote">：{{ activeItem.openingConflict.resolutionNote }}</template>
            </p>
          </div>

          <!-- 执行回填 -->
          <div class="wizard__block">
            <div class="wizard__block-title">
              执行回填
              <t-tag v-if="activeDraft" size="small" theme="warning" variant="light">保存失败暂存</t-tag>
            </div>
            <t-alert
              v-if="activeDraft"
              theme="warning"
              message="上一次保存失败，内容已暂存。可直接重试，或调整后重试；已确认项不会重算。"
              style="margin-bottom: 10px"
            />
            <div class="wizard__form">
              <label>
                <span class="muted">实际开度(%)</span>
                <t-input-number v-model="form.actualOpening" :min="0" :max="100" :step="5" :disabled="formReadonly(activeItem)" style="width: 160px" />
              </label>
              <label>
                <span class="muted">新实测流量(m³/h)</span>
                <t-input-number v-model="form.flowM3h" :min="0" :step="0.5" :disabled="formReadonly(activeItem)" style="width: 170px" />
              </label>
              <label>
                <span class="muted">新实测室温(℃)</span>
                <t-input-number v-model="form.roomTempC" :min="0" :step="0.5" :disabled="formReadonly(activeItem)" style="width: 150px" />
              </label>
              <label>
                <span class="muted">实测日期</span>
                <t-input v-model="form.measureDate" placeholder="YYYY-MM-DD" :disabled="formReadonly(activeItem)" style="width: 160px" />
              </label>
              <label>
                <span class="muted">执行人</span>
                <t-input v-model="form.executor" placeholder="如 王海" :disabled="formReadonly(activeItem)" style="width: 150px" />
              </label>
              <label class="wizard__check">
                <t-checkbox v-model="form.createMeasure" :disabled="formReadonly(activeItem)">同时登记新实测</t-checkbox>
              </label>
            </div>

            <!-- 已回填只读展示 -->
            <div v-if="activeItem.execution && !activeDraft" class="muted" style="margin-top: 8px">
              已于 {{ new Date(activeItem.execution.recordedAt).toLocaleString('zh-CN') }} 由
              {{ activeItem.execution.executor }} 回填：实际开度 {{ formatOpening(activeItem.execution.actualOpening) }}
              <template v-if="activeItem.execution.flowM3h !== null">
                · 新实测 {{ formatFlow(activeItem.execution.flowM3h) }}
              </template>
            </div>

            <div class="toolbar" style="margin-top: 12px">
              <t-button
                v-if="activeDraft"
                theme="warning"
                :disabled="!!(activeItem.openingConflict && !activeItem.openingConflict.resolved)"
                @click="retryDraft"
              >
                重新保存暂存
              </t-button>
              <t-button v-if="activeDraft" variant="outline" @click="discardActiveDraft">丢弃暂存</t-button>
              <t-button
                v-else
                theme="primary"
                :disabled="formReadonly(activeItem)"
                @click="confirmActive"
              >
                确认本单并回填
              </t-button>
              <t-button variant="text" theme="primary" :disabled="!planStore.nextPendingAdjustId(plan.id, activeItem.adjustId)" @click="gotoNext(activeItem.adjustId)">
                跳到下一张未确认
              </t-button>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部：中止 / 完成 + 模拟保存失败 -->
      <div class="wizard__foot">
        <label class="wizard__simulate">
          <t-checkbox v-model="simulateSaveFailure">模拟下次保存失败（验证暂存与恢复）</t-checkbox>
        </label>
        <div class="toolbar">
          <t-button variant="outline" @click="closeOnly">关闭（继续保留）</t-button>
          <t-button theme="warning" variant="outline" @click="abortPlan">中止方案</t-button>
          <t-button theme="success" :disabled="progress.pending > 0" @click="completePlan">完成方案</t-button>
        </div>
      </div>
    </div>

    <!-- 冲突确认弹窗 -->
    <t-dialog
      v-model:visible="resolveVisible"
      header="确认开度冲突"
      width="520px"
      :confirm-btn="'确认采用'"
      :cancel-btn="'取消'"
      @confirm="submitResolve"
    >
      <t-radio-group v-model="resolveChoice" style="display: flex; flex-direction: column; gap: 10px">
        <t-radio value="execution">
          采用方案执行实际开度
          <strong v-if="activeItem?.openingConflict">{{ formatOpening(activeItem.openingConflict.executionOpening) }}</strong>
          ，回写阀门台账
        </t-radio>
        <t-radio value="ledger">
          采用阀门台账开度
          <strong v-if="activeItem?.openingConflict">{{ formatOpening(activeItem.openingConflict.ledgerOpening) }}</strong>
          ，方案实际开度留存执行记录
        </t-radio>
      </t-radio-group>
      <t-textarea v-model="resolveNote" :autosize="{ minRows: 2, maxRows: 4 }" placeholder="确认说明（可选）" style="margin-top: 12px" />
      <p class="muted">确认前两方来源都已保留，任何一边都未覆盖另一边。</p>
    </t-dialog>
  </t-dialog>
</template>

<style scoped>
.wizard__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.wizard__body {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 14px;
  align-items: start;
}

.wizard__list {
  max-height: 520px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 4px;
}

.wizard__item {
  padding: 10px 12px;
  border: 1px solid var(--hg-line);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.16s ease;
}

.wizard__item:hover {
  border-color: var(--hg-accent-soft);
}

.wizard__item.is-active {
  border-color: var(--hg-accent);
  box-shadow: 0 0 0 2px rgba(193, 68, 14, 0.12);
}

.wizard__item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.wizard__item-draft {
  margin-top: 6px;
  font-size: 12px;
  color: #b45309;
}

.wizard__detail {
  border: 1px solid var(--hg-line);
  border-radius: 10px;
  padding: 14px;
  max-height: 520px;
  overflow-y: auto;
}

.wizard__detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.wizard__block {
  border-top: 1px dashed var(--hg-line);
  padding: 10px 0;
}

.wizard__block-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 6px;
}

.wizard__grid,
.wizard__conflict-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px 14px;
}

.wizard__grid div,
.wizard__conflict-grid div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wizard__basis {
  margin-top: 6px;
}

.wizard__basis p {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--hg-ink-soft);
  line-height: 1.7;
}

.wizard__conflict {
  border: 1px solid #f3c19b;
  background: #fdf3e8;
  border-radius: 10px;
  padding: 10px 12px;
  margin: 10px 0;
}

.wizard__conflict-title {
  font-weight: 600;
  color: #b45309;
  margin-bottom: 8px;
}

.wizard__form {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  align-items: flex-end;
}

.wizard__form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.wizard__check {
  justify-content: center;
}

.wizard__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
  border-top: 1px solid var(--hg-line);
  padding-top: 12px;
}

.wizard__simulate {
  font-size: 12px;
  color: var(--hg-ink-soft);
}
</style>
