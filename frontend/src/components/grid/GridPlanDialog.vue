<script setup lang="ts">
/**
 * 可中止的调网方案对话框（失衡度计算页消费）
 * - 未发起：选择换热站后冻结该站阀门开度、最新实测、目标开度
 * - 执行中：逐张回填实际开度与新实测；台账被同时编辑形成冲突时保留两方来源待确认
 * - 保存失败：重新打开恢复，从最后确认的一张单继续，已确认项不重算
 */
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import { useGridPlanStore } from '@/stores/gridPlanStore'
import { useStationStore } from '@/stores/stationStore'
import type { ImbalanceRow } from '@/hooks/useImbalanceRank'
import { formatOpening } from '@/utils/balance'
import { todayString, type GridConflictSource, type GridExecuteDraft, type GridPlanItem } from '@/types/grid'

const props = defineProps<{
  visible: boolean
  rankRows: ImbalanceRow[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
}>()

const gridStore = useGridPlanStore()
const stationStore = useStationStore()

const dialogVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value)
})

/* ------------------------------ 方案选择 ------------------------------ */

const startStationId = ref<string>('')
const startExecutor = ref('')

const stationOptions = computed(() =>
  stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
)

/** 当前查看的方案 id：默认进行中的方案；中止后仍停留可查看，也可切到历史方案 */
const selectedPlanId = ref<string>('')

const plan = computed(
  () => gridStore.plans.find((item) => item.id === selectedPlanId.value) ?? gridStore.activePlan ?? null
)

/** 「发起新方案」表单是否展示：无查看中的方案，或显式切到发起态 */
const showStartForm = ref(false)

const planOptions = computed(() =>
  gridStore.plans.map((item) => ({
    label: `${item.stationName} · ${item.state}（${item.items.filter((entry) => entry.state === '已确认').length}/${item.items.length}）`,
    value: item.id
  }))
)

function choosePlan(id: string): void {
  selectedPlanId.value = id
  showStartForm.value = false
  void reopenRecovery()
}

function newPlanForm(): void {
  if (gridStore.hasActivePlan) {
    MessagePlugin.warning('已有进行中的调网方案，请先完成或中止')
    return
  }
  selectedPlanId.value = ''
  showStartForm.value = true
}

const candidateCount = computed(() => {
  if (!startStationId.value) return 0
  return props.rankRows.filter((row) => row.valve.stationId === startStationId.value && row.latest !== null).length
})

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    if (!startStationId.value) {
      startStationId.value = stationStore.currentStationId ?? stationStore.stations[0]?.id ?? ''
    }
    // 默认定位进行中方案；无则若从未发起过，直接展示发起表单
    if (gridStore.activePlan) {
      selectedPlanId.value = gridStore.activePlan.id
      showStartForm.value = false
      void reopenRecovery()
    } else {
      showStartForm.value = gridStore.plans.length === 0
      if (gridStore.plans.length > 0 && !selectedPlanId.value) {
        selectedPlanId.value = gridStore.plans[0].id
      }
    }
  }
)

async function reopenRecovery(): Promise<void> {
  if (!plan.value) return
  if (!plan.value.lastError) return
  const next = await gridStore.recoverPlan(plan.value.id)
  MessagePlugin.warning('检测到上次保存失败，已恢复：已确认项不重算，请从未完成的单继续')
  if (next && next.state === '待确认') {
    await openConflict(next)
  } else if (next && next.state === '待执行') {
    openExecute(next)
  }
}

async function start(): Promise<void> {
  if (!startStationId.value) {
    MessagePlugin.warning('请先选择换热站')
    return
  }
  const station = stationStore.stations.find((item) => item.id === startStationId.value)
  if (!station) return
  try {
    const created = await gridStore.startPlan({
      stationId: station.id,
      stationName: station.name,
      executor: startExecutor.value,
      rows: props.rankRows
    })
    selectedPlanId.value = created.id
    showStartForm.value = false
    MessagePlugin.success(`已冻结 ${created.items.length} 只阀门的台账开度、最新实测与目标开度`)
    const first = created.items.find((item) => item.state === '待执行')
    if (first) openExecute(first)
  } catch (error) {
    MessagePlugin.error(error instanceof Error ? error.message : '发起失败')
  }
}

async function abort(): Promise<void> {
  if (!plan.value) return
  const id = plan.value.id
  await gridStore.abortPlan(id)
  selectedPlanId.value = id
  MessagePlugin.info('调网方案已中止，已确认项保留；未执行项标记为已跳过')
}

/* ------------------------------ 执行回填 ------------------------------ */

const executeVisible = ref(false)
const executeTarget = ref<GridPlanItem | null>(null)
const executeForm = reactive<GridExecuteDraft>({
  actualOpening: 50,
  newFlowM3h: 0,
  newSupplyTempC: 50,
  newReturnTempC: 40,
  newRoomTempC: 20,
  newMeasureDate: todayString(),
  executor: ''
})

function openExecute(item: GridPlanItem): void {
  executeTarget.value = item
  executeForm.actualOpening = item.targetOpening
  executeForm.newFlowM3h = item.newFlowM3h ?? item.frozenFlowM3h
  executeForm.newSupplyTempC = item.newSupplyTempC ?? 50
  executeForm.newReturnTempC = item.newReturnTempC ?? 40
  executeForm.newRoomTempC = item.newRoomTempC ?? item.frozenRoomTempC
  executeForm.newMeasureDate = item.newMeasureDate || todayString()
  executeForm.executor = item.executor || plan.value?.executor || ''
  executeVisible.value = true
}

async function submitExecute(): Promise<void> {
  if (!plan.value || !executeTarget.value) return
  if (!Number.isFinite(executeForm.newFlowM3h) || executeForm.newFlowM3h <= 0) {
    MessagePlugin.warning('请填写执行后的新实测流量')
    return
  }
  try {
    await gridStore.executeItem(plan.value.id, executeTarget.value.adjustId, { ...executeForm })
    const updated = plan.value.items.find((item) => item.adjustId === executeTarget.value?.adjustId)
    if (updated?.state === '待确认') {
      MessagePlugin.warning('台账开度已被阀位登记页改动，两方来源均保留，请确认采用哪一边')
    } else {
      MessagePlugin.success('已回填实际开度与新实测，该单已确认')
    }
    executeVisible.value = false
    await continueFromLast()
  } catch (error) {
    MessagePlugin.error(error instanceof Error ? error.message : '保存失败')
  }
}

/** 从最后确认的一张单继续：自动定位下一张未完成单（待确认单只滚动到冲突面板） */
async function continueFromLast(): Promise<void> {
  if (!plan.value) return
  const next = await gridStore.recoverPlan(plan.value.id)
  if (!next) return
  if (next.state === '待确认') await openConflict(next)
  else if (next.state === '待执行') openExecute(next)
}

/* ------------------------------ 冲突确认 ------------------------------ */

/** 各冲突单各自的选择（adjustId → 来源 / 人工值），互不干扰 */
const conflictChoiceMap = ref<Record<string, GridConflictSource>>({})
const conflictManualMap = ref<Record<string, number | null>>({})

function stateTagTheme(state: GridPlanItem['state']): 'default' | 'warning' | 'success' | 'primary' | 'danger' {
  if (state === '已确认') return 'success'
  if (state === '待确认') return 'danger'
  if (state === '已跳过') return 'default'
  return 'warning'
}

async function confirmConflict(item: GridPlanItem): Promise<void> {
  if (!plan.value || !item.conflict) return
  try {
    await gridStore.resolveConflict(plan.value.id, item.adjustId, {
      source: conflictChoiceMap.value[item.adjustId] ?? 'ledger',
      ...(conflictManualMap.value[item.adjustId] !== null &&
      conflictManualMap.value[item.adjustId] !== undefined
        ? { opening: conflictManualMap.value[item.adjustId] as number }
        : {})
    })
    MessagePlugin.success('冲突已确认，台账与调节单按采用值对齐，该单已确认')
    delete conflictManualMap.value[item.adjustId]
    await continueFromLast()
  } catch (error) {
    MessagePlugin.error(error instanceof Error ? error.message : '确认失败')
  }
}

async function openConflict(item: GridPlanItem): Promise<void> {
  if (item.conflict) conflictChoiceMap.value = { ...conflictChoiceMap.value, [item.adjustId]: item.conflict.pending }
  conflictManualMap.value = { ...conflictManualMap.value, [item.adjustId]: null }
  await nextTick()
  document.getElementById(`conflict-${item.adjustId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

async function armFailure(): Promise<void> {
  if (!plan.value) return
  await gridStore.armFailNextSave(plan.value.id)
  MessagePlugin.info('已制造一次保存失败：执行下一张单后可关闭重开，验证恢复链路')
}

function close(): void {
  dialogVisible.value = false
}

const itemColumns = [
  { colKey: 'code', title: '阀门', width: 130 },
  { colKey: 'frozen', title: '冻结开度 / 实测', width: 190 },
  { colKey: 'target', title: '目标开度', width: 100 },
  { colKey: 'actual', title: '实际 / 新实测', width: 190 },
  { colKey: 'state', title: '状态', width: 100 },
  { colKey: 'op', title: '操作', minWidth: 220 }
]
</script>

<template>
  <t-dialog
    v-model:visible="dialogVisible"
    :header="plan && !showStartForm ? `调网方案 · ${plan.stationName}` : '发起调网方案'"
    width="1080px"
    :footer="false"
    destroy-on-close
  >
    <!-- 方案切换条 -->
    <div v-if="gridStore.plans.length > 0" class="plan-switch">
      <t-select
        :value="plan && !showStartForm ? plan.id : ''"
        :options="planOptions"
        size="small"
        style="width: 360px"
        @change="(value: string) => choosePlan(value)"
      />
      <t-button size="small" variant="outline" :disabled="gridStore.hasActivePlan" @click="newPlanForm">
        发起新方案
      </t-button>
      <span v-if="gridStore.hasActivePlan" class="muted">进行中的方案完成或中止后，才能发起新方案</span>
    </div>

    <!-- 未发起：选站冻结 -->
    <div v-if="showStartForm || !plan">
      <t-alert theme="info" :message="`选站后冻结该站阀门的台账开度、最新实测与目标开度；执行时逐张回填实际开度与新实测。方案可中止，已确认项不再重算。`" style="margin-bottom: 14px" />
      <t-form label-width="110px">
        <t-form-item label="换热站">
          <t-select v-model="startStationId" :options="stationOptions" placeholder="选择换热站" style="width: 320px" />
        </t-form-item>
        <t-form-item label="执行人">
          <t-input v-model="startExecutor" placeholder="如 王海" style="width: 320px" />
        </t-form-item>
        <t-form-item label="纳入阀门">
          <span class="muted">该站有最新实测的 {{ candidateCount }} 只阀门将被冻结纳入方案</span>
        </t-form-item>
      </t-form>
      <div class="toolbar" style="justify-content: flex-end">
        <t-button variant="outline" @click="close">取消</t-button>
        <t-button theme="primary" :disabled="candidateCount === 0" @click="start">冻结并开始调网</t-button>
      </div>
    </div>

    <!-- 执行中 / 终态方案 -->
    <div v-else>
      <div v-if="plan.lastError" class="recovery-bar">
        <strong>保存失败：</strong>{{ plan.lastError }}
        <t-button size="small" theme="danger" variant="outline" style="margin-left: 8px" @click="continueFromLast">
          重新打开并恢复（从最后确认的一张继续）
        </t-button>
      </div>
      <div v-else-if="gridStore.notice" class="recovery-bar" style="background: #fdf3e3; border-color: #e6b566">
        {{ gridStore.notice }}
      </div>

      <div class="plan-summary">
        <t-tag :theme="plan.state === '执行中' ? 'primary' : 'default'">{{ plan.state }}</t-tag>
        <span>执行人：{{ plan.executor || '待指派' }}</span>
        <span>
          进度：{{ gridStore.progress.confirmed }} / {{ gridStore.progress.total }}
          （待确认 {{ gridStore.progress.conflict }} · 待执行 {{ gridStore.progress.pending }}）
        </span>
        <t-progress :percentage="gridStore.progress.percent" style="width: 220px" size="small" />
      </div>

      <t-table :data="plan.items" :columns="itemColumns" row-key="adjustId" bordered stripe size="small" style="margin-top: 12px">
        <template #code="{ row }">
          <strong>{{ row.valveCode }}</strong>
          <div class="muted">{{ row.buildingName }}</div>
        </template>
        <template #frozen="{ row }">
          {{ formatOpening(row.frozenOpening) }} · {{ row.frozenFlowM3h.toFixed(1) }} m³/h
          <div class="muted">{{ row.frozenMeasureDate }} 读数（已冻结）</div>
        </template>
        <template #target="{ row }">
          <strong>{{ formatOpening(row.targetOpening) }}</strong>
        </template>
        <template #actual="{ row }">
          <template v-if="row.actualOpening !== null">
            {{ formatOpening(row.actualOpening) }}
            <span v-if="row.newFlowM3h !== null"> · {{ row.newFlowM3h.toFixed(1) }} m³/h</span>
          </template>
          <span v-else class="muted">待回填</span>
          <div v-if="row.state === '待确认' && row.conflict" class="conflict-box">
            <div>台账来源：<strong>{{ formatOpening(row.conflict.ledger) }}</strong>（阀位登记页已改）</div>
            <div>调节来源：<strong>{{ formatOpening(row.conflict.adjust) }}</strong>（现场回填）</div>
          </div>
        </template>
        <template #state="{ row }">
          <t-tag size="small" :theme="stateTagTheme(row.state)">{{ row.state }}</t-tag>
        </template>
        <template #op="{ row }">
          <div class="toolbar">
            <template v-if="row.state === '待执行'">
              <t-button size="small" theme="primary" @click="openExecute(row)">执行回填</t-button>
            </template>
            <template v-else-if="row.state === '待确认'">
              <t-button size="small" theme="danger" @click="openConflict(row)">两方待确认</t-button>
            </template>
            <template v-else>
              <span class="muted">{{ row.state === '已确认' ? '已锁定，不重算' : '已跳过' }}</span>
            </template>
          </div>
        </template>
      </t-table>

      <!-- 冲突确认区 -->
      <div
        v-for="row in plan.items.filter((item) => item.state === '待确认')"
        :id="`conflict-${row.adjustId}`"
        :key="row.adjustId"
        class="conflict-panel"
      >
        <div class="conflict-panel__head">
          <strong>{{ row.valveCode }} 开度冲突</strong>
          <span class="muted">任一边均不覆盖另一边，请选择采用值</span>
        </div>
        <div class="toolbar">
          <t-radio-group
            :model-value="conflictChoiceMap[row.adjustId] ?? 'ledger'"
            variant="default-filled"
            size="small"
            @change="(value: GridConflictSource) => (conflictChoiceMap = { ...conflictChoiceMap, [row.adjustId]: value })"
          >
            <t-radio-button value="ledger">采用台账 {{ formatOpening(row.conflict?.ledger ?? 0) }}</t-radio-button>
            <t-radio-button value="adjust">采用调节 {{ formatOpening(row.conflict?.adjust ?? 0) }}</t-radio-button>
          </t-radio-group>
          <t-input-number
            :model-value="conflictManualMap[row.adjustId] ?? null"
            :min="0"
            :max="100"
            :step="5"
            placeholder="或人工裁定"
            style="width: 150px"
            size="small"
            @change="(value: number) => (conflictManualMap = { ...conflictManualMap, [row.adjustId]: value })"
          />
          <t-button size="small" theme="danger" @click="confirmConflict(row)">确认采用值</t-button>
        </div>
      </div>

      <div class="toolbar" style="justify-content: space-between; margin-top: 14px">
        <div class="toolbar">
          <t-button
            v-if="plan.state === '执行中'"
            variant="outline"
            theme="warning"
            title="演示按钮：制造一次保存失败，用于验证保存失败后重新打开的恢复链路"
            @click="armFailure"
          >
            模拟下次保存失败
          </t-button>
          <span class="muted">关闭后可随时重新打开，方案保留在本地</span>
        </div>
        <div class="toolbar">
          <t-button v-if="plan.state === '执行中'" theme="danger" variant="outline" @click="abort">中止调网</t-button>
          <t-button theme="primary" @click="close">关闭</t-button>
        </div>
      </div>
    </div>

    <!-- 执行回填弹层 -->
    <t-dialog
      v-model:visible="executeVisible"
      :header="executeTarget ? `执行回填 · ${executeTarget.valveCode}` : ''"
      width="560px"
      :confirm-btn="'保存回填'"
      :cancel-btn="'取消'"
      @confirm="submitExecute"
      append-to-body
    >
      <div v-if="executeTarget" class="frozen-note">
        冻结基线：台账开度 {{ formatOpening(executeTarget.frozenOpening) }}，最新实测
        {{ executeTarget.frozenFlowM3h.toFixed(1) }} m³/h（{{ executeTarget.frozenMeasureDate }}），目标开度
        {{ formatOpening(executeTarget.targetOpening) }}
      </div>
      <t-form :data="executeForm" label-width="120px" style="margin-top: 10px">
        <t-form-item label="实际开度(%)">
          <t-input-number v-model="executeForm.actualOpening" :min="0" :max="100" :step="5" style="width: 100%" />
        </t-form-item>
        <t-form-item label="新实测流量(m³/h)">
          <t-input-number v-model="executeForm.newFlowM3h" :min="0" :step="0.1" style="width: 100%" />
        </t-form-item>
        <t-form-item label="新供温(℃)">
          <t-input-number v-model="executeForm.newSupplyTempC" :step="0.5" style="width: 100%" />
        </t-form-item>
        <t-form-item label="新回温(℃)">
          <t-input-number v-model="executeForm.newReturnTempC" :step="0.5" style="width: 100%" />
        </t-form-item>
        <t-form-item label="新室温(℃)">
          <t-input-number v-model="executeForm.newRoomTempC" :step="0.1" style="width: 100%" />
        </t-form-item>
        <t-form-item label="实测日期">
          <t-input v-model="executeForm.newMeasureDate" placeholder="YYYY-MM-DD" />
        </t-form-item>
        <t-form-item label="执行人">
          <t-input v-model="executeForm.executor" placeholder="如 王海" />
        </t-form-item>
      </t-form>
    </t-dialog>
  </t-dialog>
</template>

<style scoped>
.plan-switch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.plan-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  border: 1px solid var(--hg-line);
  border-radius: 10px;
  background: #faf7f3;
  font-size: 13px;
}

.recovery-bar {
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid #e09b93;
  border-radius: 10px;
  background: #fdecea;
  color: #8c2f23;
  font-size: 13px;
}

.conflict-box {
  margin-top: 4px;
  padding: 6px 8px;
  border: 1px dashed #e09b93;
  border-radius: 8px;
  background: #fdecea;
  color: #8c2f23;
  font-size: 12px;
  line-height: 1.7;
}

.conflict-panel {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid #e09b93;
  border-radius: 10px;
  background: #fdecea;
}

.conflict-panel__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
  color: #8c2f23;
}

.frozen-note {
  padding: 10px 12px;
  border-radius: 10px;
  background: #e8f1fb;
  border: 1px solid #9bbde0;
  color: #234a75;
  font-size: 13px;
  line-height: 1.7;
}
</style>
