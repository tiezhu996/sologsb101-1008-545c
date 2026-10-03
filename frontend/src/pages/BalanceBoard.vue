<script setup lang="ts">
/**
 * /balance 失衡度计算与排序
 * 按流量比、室温偏差合成失衡度并降序排列，可一键生成调节单；
 * 支持按换热站发起「可中止的调网方案」：冻结依据 → 逐张执行回填 → 冲突双源待确认 → 失败可恢复。
 * 消费 Valve、Measure、Adjust、GridPlan；复用 <BalanceTag>、<StatBadge>、<EmptyPanel>。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { DialogPlugin, MessagePlugin } from 'tdesign-vue-next'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import BalanceTag from '@/components/common/BalanceTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import GridPlanDialog from '@/components/grid/GridPlanDialog.vue'
import { useImbalanceRank, type ImbalanceRow } from '@/hooks/useImbalanceRank'
import { useValveStore } from '@/stores/valveStore'
import { useStationStore } from '@/stores/stationStore'
import { useAdjustStore } from '@/stores/adjustStore'
import { useGridPlanStore } from '@/stores/gridPlanStore'
import { IMBALANCE_BALANCED, IMBALANCE_WARN, basisText, formatFlow, formatOpening } from '@/utils/balance'
import { freezeBaseline } from '@/utils/baseline'
import { ADJUST_STATES, EMPTY_ADJUST_DRAFT, type AdjustBaseline, type AdjustDraft } from '@/types/adjust'
import { exportBalanceCsv } from '@/utils/export'
import { HEAT_MODES, type HeatMode } from '@/types/building'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const router = useRouter()
const rank = useImbalanceRank()
const valveStore = useValveStore()
const stationStore = useStationStore()
const adjustStore = useAdjustStore()
const gridStore = useGridPlanStore()

/** 旧调节单首次打开时补出依据基线（原依据保留不动），数据订阅就绪后执行一次 */
let baselineBackfilled = false
function runBaselineBackfill(): void {
  if (baselineBackfilled || !rank.measureTable.ready.value) return
  baselineBackfilled = true
  void adjustStore
    .backfillBaselines(
      valveStore.valves.map((valve) => ({
        id: valve.id,
        currentOpening: valve.currentOpening,
        designFlowM3h: valve.designFlowM3h
      })),
      rank.measureTable.rows.value.map((measure) => ({
        valveId: measure.valveId,
        date: measure.date,
        flowM3h: measure.flowM3h,
        roomTempC: measure.roomTempC
      }))
    )
    .then((count) => {
      if (count > 0) MessagePlugin.info(`已为 ${count} 张旧调节单补出依据基线，原依据仍可查看`)
    })
}

onMounted(runBaselineBackfill)
watch(() => rank.measureTable.ready.value, runBaselineBackfill)

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
    freezeBaseline(row)
  )
  MessagePlugin.success(`已为 ${row.valve.code} 生成调节单，目标开度 ${row.suggestOpening}%（依据已冻结）`)
}

/* --------------------------- 调节单维护 --------------------------- */

const adjustDialogVisible = ref(false)
const adjustForm = reactive<AdjustDraft>({ ...EMPTY_ADJUST_DRAFT })
/** 维护弹窗中展示的冻结基线（旧单首次打开时若为补录会显式标记） */
const editingBaseline = ref<AdjustBaseline | null>(null)

function openAdjustEdit(row: ImbalanceRow): void {
  const adjust = adjustStore.adjusts.find((item) => item.valveId === row.valve.id)
  if (!adjust) {
    void generateOne(row)
    return
  }
  Object.assign(adjustForm, {
    valveId: adjust.valveId,
    targetOpening: adjust.targetOpening,
    basis: adjust.basis,
    executor: adjust.executor,
    state: adjust.state,
    reviewNote: adjust.reviewNote
  })
  editingBaseline.value = adjust.baseline ?? freezeBaseline(row)
  adjustDialogVisible.value = true
}

async function submitAdjust(): Promise<void> {
  const adjust = adjustStore.adjusts.find((item) => item.valveId === adjustForm.valveId)
  if (!adjust) return
  // 基线冻结后不随读数/编辑重算；原依据 basis 仍可手工编辑查看
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
      baseline: freezeBaseline(row)
    }))
  const count = await adjustStore.generateFromRank(payload)
  if (count === 0) {
    MessagePlugin.info('没有新的失衡阀门需要生成调节单')
    return
  }
  MessagePlugin.success(`已批量生成 ${count} 张调节单（依据已冻结）`)
}

/* ----------------------------- 调网方案 ----------------------------- */

const gridDialogVisible = ref(false)

function openGridPlan(): void {
  gridDialogVisible.value = true
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
        <t-button variant="outline" @click="generateAll">一键生成调节单</t-button>
        <t-button theme="warning" @click="openGridPlan">
          {{ gridStore.hasActivePlan ? `继续调网方案（${gridStore.progress.confirmed}/${gridStore.progress.total}）` : '调网方案（可中止）' }}
        </t-button>
        <t-button theme="primary" @click="goAdjust">前往调节单（{{ adjustStore.stateCounts['待下发'] }}）</t-button>
      </div>
    </div>

    <div v-if="gridStore.activePlan" class="active-plan-bar" @click="openGridPlan">
      <t-tag size="small" theme="primary">{{ gridStore.activePlan.state }}</t-tag>
      <span>
        {{ gridStore.activePlan.stationName }} 调网方案：已确认 {{ gridStore.progress.confirmed }} /
        {{ gridStore.progress.total }}
        <template v-if="gridStore.progress.conflict > 0">
          ，<strong>{{ gridStore.progress.conflict }} 张开度冲突待确认</strong>
        </template>
        <template v-if="gridStore.activePlan.lastError">
          ，<strong>上次保存失败，点击重新打开恢复</strong>
        </template>
      </span>
      <span class="muted">点击继续，从最后确认的一张单接着执行</span>
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
      <div v-if="editingBaseline" class="baseline-box">
        <div class="baseline-box__head">
          <strong>依据基线（冻结）</strong>
          <t-tag v-if="editingBaseline.backfilled" size="small" theme="warning">旧单首次打开补录</t-tag>
        </div>
        <div class="muted">
          台账开度 {{ formatOpening(editingBaseline.opening) }} → 目标 {{ formatOpening(editingBaseline.targetOpening) }}
          ；最新实测
          {{ editingBaseline.measuredFlowM3h !== null ? `${editingBaseline.measuredFlowM3h.toFixed(1)} m³/h（${editingBaseline.measureDate}）` : '无' }}
          ；失衡度
          {{ editingBaseline.imbalanceValue !== null ? `${editingBaseline.imbalanceValue.toFixed(1)}%` : '—' }}
        </div>
      </div>
      <t-form :data="adjustForm" label-width="128px" style="margin-top: 12px">
        <t-form-item label="目标开度(%)">
          <t-input-number v-model="adjustForm.targetOpening" :min="0" :max="100" :step="5" style="width: 100%" />
        </t-form-item>
        <t-form-item label="调节依据（原依据）">
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

    <GridPlanDialog v-model:visible="gridDialogVisible" :rank-rows="rank.rows.value" />
  </div>
</template>

<style scoped>
.active-plan-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  padding: 10px 14px;
  border: 1px solid #9bbde0;
  border-radius: 10px;
  background: #e8f1fb;
  color: #234a75;
  font-size: 13px;
  cursor: pointer;
}

.baseline-box {
  padding: 10px 12px;
  border-radius: 10px;
  background: #e8f1fb;
  border: 1px solid #9bbde0;
}

.baseline-box__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: #234a75;
}
</style>
