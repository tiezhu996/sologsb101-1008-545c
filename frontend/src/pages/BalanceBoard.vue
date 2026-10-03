<script setup lang="ts">
/**
 * /balance 失衡度计算与排序
 * 按流量比、室温偏差合成失衡度并降序排列，可一键生成调节单，
 * 也可按换热站发起「可中止的调网方案」：选站冻结基线，逐张执行回填，
 * 执行与阀门台账同开度冲突时两方来源保留待确认，保存失败可恢复。
 * 消费 Valve、Measure、AdjustPlan；复用 <BalanceTag>、<StatBadge>、<EmptyPanel>。
 */
import { computed, reactive, ref, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { DialogPlugin, MessagePlugin } from 'tdesign-vue-next'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import BalanceTag from '@/components/common/BalanceTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import PlanWizardDialog from '@/components/common/PlanWizardDialog.vue'
import { useImbalanceRank, type ImbalanceRow } from '@/hooks/useImbalanceRank'
import { useValveStore } from '@/stores/valveStore'
import { useStationStore } from '@/stores/stationStore'
import { useAdjustStore } from '@/stores/adjustStore'
import { usePlanStore } from '@/stores/planStore'
import { IMBALANCE_BALANCED, IMBALANCE_WARN, basisText, formatFlow, formatOpening } from '@/utils/balance'
import { baselineFromRank } from '@/utils/baseline'
import { ADJUST_STATES, EMPTY_ADJUST_DRAFT, type AdjustDraft } from '@/types/adjust'
import { exportBalanceCsv } from '@/utils/export'
import { HEAT_MODES, type HeatMode } from '@/types/building'
import type { AdjustPlanRow } from '@/utils/db'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const router = useRouter()
const rank = useImbalanceRank()
const valveStore = useValveStore()
const stationStore = useStationStore()
const adjustStore = useAdjustStore()
const planStore = usePlanStore()

// 把排行行灌入方案 store，发起方案/旧单补基线时据此冻结
watchEffect(() => {
  planStore.bindRankRows(rank.rows.value.map((row) => ({ rank: row })))
})

const filterModel = computed<FilterModel>(() => ({
  keyword: valveStore.filter.keyword,
  station: valveStore.filter.stationId,
  heatMode: valveStore.filter.heatModes
}))

const filterSelects = computed(() => [
  {
    key: 'station',
    label: '换热站',
    multiple: false,
    options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
  },
  { key: 'heatMode', label: '供热方式', options: HEAT_MODES.map((item) => ({ label: item, value: item })) }
])

function onFilterChange(model: FilterModel): void {
  valveStore.patchFilter({
    keyword: String(model.keyword ?? ''),
    stationId: typeof model.station === 'string' ? model.station : '',
    heatModes: (Array.isArray(model.heatMode) ? model.heatMode : []) as HeatMode[]
  })
}

const rows = computed<ImbalanceRow[]>(() =>
  rank.filteredRows.value.filter((row) => (valveStore.filter.onlyImbalanced ? row.level !== '平衡' : true))
)

const columns = [
  { colKey: 'rank', title: '排名', width: 70, cell: 'rankCell' },
  { colKey: 'where', title: '换热站 / 楼栋', width: 200, cell: 'whereCell' },
  { colKey: 'code', title: '阀门编号', width: 130, cell: 'codeCell' },
  { colKey: 'flow', title: '设计 / 实测流量', width: 180, cell: 'flowCell' },
  { colKey: 'ratio', title: '流量比', width: 100, cell: 'ratioCell' },
  { colKey: 'deviation', title: '流量/室温偏差', width: 170, cell: 'deviationCell' },
  { colKey: 'value', title: '失衡度', width: 110, cell: 'valueCell' },
  { colKey: 'level', title: '判级', width: 150, cell: 'levelCell' },
  { colKey: 'suggest', title: '建议开度', width: 110, cell: 'suggestCell' },
  { colKey: 'op', title: '操作', width: 170, cell: 'opCell' }
]

function rowKey(row: ImbalanceRow): string {
  return row.valve.id
}

function describe(row: ImbalanceRow): string {
  return basisText({
    valve: row.valve,
    building: row.building,
    ratio: row.ratio,
    flowDeviation: row.flowDeviation,
    roomDeviation: row.roomDeviation,
    imbalanceValue: row.imbalanceValue,
    level: row.level
  })
}

async function generateOne(row: ImbalanceRow): Promise<void> {
  if (row.level === '平衡') {
    MessagePlugin.info(`${row.valve.code} 处于平衡区间，无需下发调节单`)
    return
  }
  if (adjustStore.hasAdjust(row.valve.id)) {
    MessagePlugin.info(`${row.valve.code} 已存在调节单，请到调节单页处理`)
    return
  }
  await adjustStore.createAdjust(
    {
      valveId: row.valve.id,
      targetOpening: row.suggestOpening,
      basis: describe(row),
      executor: '待指派',
      state: '待下发',
      reviewNote: ''
    },
    { baseline: baselineFromRank(row), planId: null }
  )
  MessagePlugin.success(`已为 ${row.valve.code} 生成调节单，目标开度 ${row.suggestOpening}%`)
}

/* --------------------------- 调节单维护 --------------------------- */

const adjustDialogVisible = ref(false)
const adjustForm = reactive<AdjustDraft>({ ...EMPTY_ADJUST_DRAFT })

function openAdjustEdit(row: ImbalanceRow): void {
  const adjust = adjustStore.adjusts.find((item) => item.valveId === row.valve.id)
  if (!adjust) {
    void generateOne(row)
    return
  }
  // 已纳入未完成方案的单：目标开度已冻结，统一在方案向导中执行/处理冲突
  if (adjust.planId) {
    const plan = planStore.planById(adjust.planId)
    if (plan && plan.state !== '已完成') {
      MessagePlugin.info('该单已纳入调网方案，目标开度已冻结，请在方案向导中执行回填')
      openWizard(plan)
      return
    }
  }
  Object.assign(adjustForm, {
    valveId: adjust.valveId,
    targetOpening: adjust.targetOpening,
    basis: adjust.basis,
    executor: adjust.executor,
    state: adjust.state,
    reviewNote: adjust.reviewNote
  })
  adjustDialogVisible.value = true
}

async function submitAdjust(): Promise<void> {
  const adjust = adjustStore.adjusts.find((item) => item.valveId === adjustForm.valveId)
  if (!adjust) return
  await adjustStore.updateAdjust(adjust.id, { ...adjustForm })
  MessagePlugin.success('调节单已更新')
  adjustDialogVisible.value = false
}

function removeAdjust(row: ImbalanceRow): void {
  const adjust = adjustStore.adjusts.find((item) => item.valveId === row.valve.id)
  if (!adjust) return
  const dialog = DialogPlugin.confirm({
    header: '撤销确认',
    body: `确认撤销 ${row.valve.code} 的调节单？撤销后该阀门可重新派单。`,
    confirmBtn: '确认撤销',
    cancelBtn: '取消',
    onConfirm: async () => {
      await adjustStore.removeAdjust(adjust.id)
      MessagePlugin.success('调节单已撤销')
      dialog.destroy()
    }
  })
}

async function generateAll(): Promise<void> {
  const payload = rank.rows.value
    .filter((row) => row.latest !== null && row.level !== '平衡')
    .map((row) => ({
      valve: row.valve,
      measured: row.measured,
      roomTempC: row.latest ? row.latest.roomTempC : 20,
      imbalanceValue: row.imbalanceValue,
      level: row.level,
      suggestOpening: row.suggestOpening,
      basisText: describe(row),
      baseline: baselineFromRank(row)
    }))
  const count = await adjustStore.generateFromRank(payload)
  if (count === 0) {
    MessagePlugin.info('没有新的失衡阀门需要生成调节单')
    return
  }
  MessagePlugin.success(`已批量生成 ${count} 张调节单`)
}

function exportCsv(): void {
  const filename = exportBalanceCsv(
    rows.value.map((row) => ({
      station: row.station,
      building: row.building,
      valve: row.valve,
      measured: row.measured,
      ratio: row.ratio,
      flowDeviation: row.flowDeviation,
      roomDeviation: row.roomDeviation,
      imbalanceValue: row.imbalanceValue,
      level: row.level
    }))
  )
  MessagePlugin.success(`已导出 ${filename}`)
}

function onOnlyImbalancedChange(value: unknown): void {
  valveStore.patchFilter({ onlyImbalanced: value === true })
}

function goAdjust(): void {
  void router.push('/adjusts')
}

/* --------------------------- 调网方案（可中止） --------------------------- */

const planCreateVisible = ref(false)
const planStationId = ref('')
const wizardVisible = ref(false)
const activePlan = ref<AdjustPlanRow | null>(null)

/** 各换热站进行中/已中止的方案（用于「继续」入口） */
const activePlanByStation = computed(() => {
  const map = new Map<string, AdjustPlanRow>()
  planStore.plans
    .filter((plan) => plan.state === '进行中' || plan.state === '已中止')
    .forEach((plan) => map.set(plan.stationId, plan))
  return map
})

function stationPlanState(stationId: string): string {
  return activePlanByStation.value.get(stationId)?.state ?? ''
}

function openPlanCreate(): void {
  if (stationStore.stations.length === 0) {
    MessagePlugin.warning('请先在换热站台账登记换热站')
    return
  }
  const firstStation = stationStore.stations[0]
  planStationId.value = valveStore.filter.stationId || firstStation.id
  planCreateVisible.value = true
}

async function submitPlanCreate(): Promise<void> {
  if (!planStationId.value) {
    MessagePlugin.warning('请选择换热站')
    return
  }
  const existing = planStore.planOfStation(planStationId.value)
  if (existing) {
    openWizard(existing)
    planCreateVisible.value = false
    return
  }
  try {
    const plan = await planStore.createPlan(planStationId.value)
    planCreateVisible.value = false
    MessagePlugin.success(`已发起「${plan.stationName}」调网方案，基线已冻结`)
    openWizard(plan)
  } catch (error) {
    MessagePlugin.error(error instanceof Error ? error.message : '发起方案失败')
  }
}

function continueStationPlan(stationId: string): void {
  const plan = activePlanByStation.value.get(stationId)
  if (!plan) {
    MessagePlugin.info('该换热站暂无进行中的方案')
    return
  }
  openWizard(plan)
}

function openWizard(plan: AdjustPlanRow): void {
  activePlan.value = plan
  wizardVisible.value = true
}

function onPlanChanged(): void {
  // 方案内写库后刷新当前活动方案引用（状态/进度）
  if (activePlan.value) {
    activePlan.value = planStore.planById(activePlan.value.id) ?? activePlan.value
  }
}

const activePlanCount = computed(() => activePlanByStation.value.size)
const anyUnresolvedConflict = computed(() => adjustStore.conflictCount > 0)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">失衡度计算与排序</h2>
        <p class="page-head__desc">
          失衡度 = |流量偏差率| × 0.7 + |室温偏差| × 1.5；≤ {{ IMBALANCE_BALANCED }}% 记平衡，&gt;
          {{ IMBALANCE_WARN }}% 记严重失衡。
        </p>
      </div>
      <div class="page-head__actions">
        <t-button variant="outline" @click="exportCsv">导出失衡度 CSV</t-button>
        <t-button variant="outline" @click="openPlanCreate">发起调网方案</t-button>
        <t-button variant="outline" @click="generateAll">一键生成调节单</t-button>
        <t-button theme="primary" @click="goAdjust">前往调节单（{{ adjustStore.stateCounts['待下发'] }}）</t-button>
      </div>
    </div>

    <t-alert
      v-if="anyUnresolvedConflict"
      theme="error"
      :message="`有 ${adjustStore.conflictCount} 张单的开度与阀门台账冲突待确认（两方来源均保留，未互相覆盖）`"
      style="margin-bottom: 12px"
    />

    <div v-if="activePlanCount > 0" class="panel" style="margin-bottom: 16px">
      <div class="panel-head">
        <h3 class="panel-title" style="margin: 0">进行中的调网方案（{{ activePlanCount }}）</h3>
        <span class="muted">基线已冻结，读数变化不影响方案建议依据；保存失败后可从最后确认的一张继续</span>
      </div>
      <div v-for="plan in planStore.plans.filter((item) => item.state === '进行中' || item.state === '已中止')" :key="plan.id" class="plan-row">
        <div>
          <strong>{{ plan.stationName }}</strong>
          <t-tag size="small" :theme="plan.state === '进行中' ? 'primary' : 'warning'" variant="light" style="margin: 0 8px">
            {{ plan.state }}
          </t-tag>
          <span class="muted">
            已确认 {{ planStore.confirmedCountOfPlan(plan.id) }} /
            {{ planStore.progressOfPlan(plan.id).total }} 张
          </span>
        </div>
        <div class="toolbar">
          <t-button size="small" theme="primary" variant="outline" @click="continueStationPlan(plan.stationId)">
            {{ plan.state === '已中止' ? '继续方案' : '打开继续' }}
          </t-button>
        </div>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="阀门总数" :value="rank.summary.value.total" suffix="只" tone="primary" />
      <StatBadge label="平衡" :value="rank.summary.value.balanced" suffix="只" tone="success" />
      <StatBadge label="偏大/偏小" :value="rank.summary.value.minor" suffix="只" tone="warning" />
      <StatBadge
        label="严重失衡"
        :value="rank.summary.value.severe"
        :percent="rank.summary.value.severePercent"
        suffix="只"
        tone="danger"
      />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索阀门编号 / 楼栋 / 换热站"
      switch-label="仅看失衡"
      :switch-value="valveStore.filter.onlyImbalanced"
      has-switch
      @change="onFilterChange"
      @update:switch-value="onOnlyImbalancedChange"
    />

    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title" style="margin: 0">失衡度排行（{{ rows.length }}）</h3>
        <span class="muted">平均失衡度 {{ rank.summary.value.average.toFixed(1) }}%</span>
      </div>

      <EmptyPanel
        v-if="rows.length === 0"
        title="没有可计算的失衡数据"
        description="请先在实测录入页登记各阀门的流量与室温读数。"
        secondary-text="查看全部阀门"
        compact
        @secondary="valveStore.patchFilter({ onlyImbalanced: false })"
      />

      <t-table v-else :data="rows" :columns="columns" :row-key="rowKey" bordered stripe size="small">
        <template #rankCell="{ rowIndex }">{{ rowIndex + 1 }}</template>
        <template #whereCell="{ row }">
          {{ row.station ? row.station.name : '—' }} / {{ row.building ? row.building.name : '—' }}
        </template>
        <template #codeCell="{ row }"><strong>{{ row.valve.code }}</strong></template>
        <template #flowCell="{ row }">
          {{ row.valve.designFlowM3h.toFixed(1) }} / {{ row.latest ? formatFlow(row.measured) : '无实测' }}
        </template>
        <template #ratioCell="{ row }">{{ row.latest ? row.ratio.toFixed(2) : '—' }}</template>
        <template #deviationCell="{ row }">
          <span v-if="row.latest">
            {{ row.flowDeviation.toFixed(1) }}% / {{ row.roomDeviation.toFixed(1) }}℃
          </span>
          <span v-else class="muted">—</span>
        </template>
        <template #valueCell="{ row }">
          <span :style="{ color: row.level === '严重失衡' ? '#c0392b' : undefined }">
            {{ row.imbalanceValue.toFixed(1) }}%
          </span>
        </template>
        <template #levelCell="{ row }">
          <BalanceTag :level="row.level" :imbalance="row.imbalanceValue" size="small" />
        </template>
        <template #suggestCell="{ row }">
          {{ formatOpening(row.suggestOpening) }}
          <span class="muted">（现 {{ formatOpening(row.valve.currentOpening) }}）</span>
        </template>
        <template #opCell="{ row }">
          <div class="toolbar">
            <t-button
              size="small"
              variant="text"
              theme="primary"
              :disabled="row.level === '平衡' || adjustStore.hasAdjust(row.valve.id)"
              @click="generateOne(row)"
            >
              {{ adjustStore.hasAdjust(row.valve.id) ? '已派单' : '生成调节单' }}
            </t-button>
            <t-button
              size="small"
              variant="text"
              theme="primary"
              :disabled="!adjustStore.hasAdjust(row.valve.id)"
              @click="openAdjustEdit(row)"
            >
              维护
            </t-button>
            <t-button
              size="small"
              variant="text"
              theme="danger"
              :disabled="!adjustStore.hasAdjust(row.valve.id)"
              @click="removeAdjust(row)"
            >
              撤销
            </t-button>
          </div>
        </template>
      </t-table>
    </div>
    <t-dialog
      v-model:visible="adjustDialogVisible"
      header="维护调节单"
      width="620px"
      :confirm-btn="'保存'"
      :cancel-btn="'取消'"
      @confirm="submitAdjust"
    >
      <t-form :data="adjustForm" label-width="128px">
        <t-form-item label="目标开度(%)">
          <t-input-number v-model="adjustForm.targetOpening" :min="0" :max="100" :step="5" style="width: 100%" />
        </t-form-item>
        <t-form-item label="调节依据">
          <t-textarea v-model="adjustForm.basis" :autosize="{ minRows: 3, maxRows: 5 }" />
        </t-form-item>
        <t-form-item label="执行人">
          <t-input v-model="adjustForm.executor" placeholder="如 王海" />
        </t-form-item>
        <t-form-item label="状态">
          <t-select v-model="adjustForm.state" :options="ADJUST_STATES.map((item) => ({ label: item, value: item }))" />
        </t-form-item>
        <t-form-item label="复核意见">
          <t-input v-model="adjustForm.reviewNote" placeholder="复核合格可留空" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 发起调网方案：选站 -->
    <t-dialog
      v-model:visible="planCreateVisible"
      header="发起调网方案（可中止）"
      width="520px"
      :confirm-btn="'冻结基线并发起'"
      :cancel-btn="'取消'"
      @confirm="submitPlanCreate"
    >
      <t-form label-width="96px">
        <t-form-item label="换热站">
          <t-select v-model="planStationId" filterable placeholder="选择换热站" style="width: 100%">
            <t-option
              v-for="station in stationStore.stations"
              :key="station.id"
              :value="station.id"
              :label="`${station.name}（${stationPlanState(station.id) ? stationPlanState(station.id) + ' · 已有方案' : valveStore.valves.filter((v) => v.stationId === station.id).length + ' 只阀门'}）`"
            />
          </t-select>
        </t-form-item>
      </t-form>
      <t-alert
        theme="info"
        message="发起后冻结该站每只阀门的当前开度、最新实测与目标开度作为基线；执行时回填实际开度与新实测。方案可随时中止，保存失败后重新打开从最后确认的一张继续。"
      />
    </t-dialog>

    <!-- 方案执行向导 -->
    <PlanWizardDialog v-model:visible="wizardVisible" :plan="activePlan" @changed="onPlanChanged" />
  </div>
</template>

<style scoped>
.plan-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 4px;
  border-top: 1px dashed var(--hg-line);
}

.plan-row:first-of-type {
  border-top: none;
}
</style>
