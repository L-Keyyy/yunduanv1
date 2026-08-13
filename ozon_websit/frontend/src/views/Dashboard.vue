<template>
  <div class="dashboard-container">
    <div class="page-header">
      <div>
        <h2 class="page-title">仪表盘</h2>
        <p class="page-desc">集中查看店铺、上传、订单和库存风险。</p>
      </div>
      <div class="header-actions">
        <el-select v-model="selectedStoreId" class="store-select" @change="loadDashboard">
          <el-option :label="'全部店铺'" :value="ALL_STORES_VALUE" />
          <el-option
            v-for="store in allStores"
            :key="store.id"
            :label="store.store_name"
            :value="store.id"
          />
        </el-select>
        <el-radio-group v-model="selectedPeriod" class="period-group" size="small" @change="loadDashboard">
          <el-radio-button
            v-for="option in dashboardPeriodOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </el-radio-button>
        </el-radio-group>
        <el-button type="primary" @click="handleRefresh" :loading="loading">刷新</el-button>
      </div>
    </div>

    <el-row :gutter="16" class="summary-grid">
      <el-col :xs="24" :sm="12" :lg="6" v-for="card in summaryCards" :key="card.key">
        <el-card shadow="never" class="metric-card">
          <div class="metric-title">{{ card.label }}</div>
          <div class="metric-value">{{ card.value }}</div>
          <div class="metric-note">{{ card.note }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" class="chart-grid">
      <el-col :xs="24" :lg="24">
        <el-card shadow="never" class="chart-card">
          <div class="card-title">成功上传 SKU 与销量趋势</div>
          <div ref="uploadChartRef" class="chart-box"></div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="chart-card pie-section">
      <div class="card-title">本地类目分布</div>
      <div class="card-subtitle">沿用数据分析模块的本地口径，展示销售额、订单数和在售 SKU 的类目占比。</div>
      <el-row :gutter="16" class="pie-grid">
        <el-col :xs="24" :lg="8">
          <div class="pie-shell">
            <div ref="salesPieChartRef" class="pie-chart-box"></div>
          </div>
        </el-col>
        <el-col :xs="24" :lg="8">
          <div class="pie-shell">
            <div ref="ordersPieChartRef" class="pie-chart-box"></div>
          </div>
        </el-col>
        <el-col :xs="24" :lg="8">
          <div class="pie-shell">
            <div ref="skusPieChartRef" class="pie-chart-box"></div>
          </div>
        </el-col>
      </el-row>
    </el-card>

    <el-row :gutter="16">
      <el-col :xs="24" :lg="12">
        <el-card shadow="never" class="info-card">
          <div class="card-title">店铺概览</div>
          <el-table :data="visibleStores" size="small" stripe>
            <el-table-column prop="store_name" label="店铺" min-width="140" />
            <el-table-column prop="key_status" label="密钥状态" width="110" />
            <el-table-column prop="daily_limit" label="每日额度" width="120" />
            <el-table-column prop="watermark" label="水印" width="100" />
          </el-table>
        </el-card>
      </el-col>
      <el-col :xs="24" :lg="12">
        <el-card shadow="never" class="info-card">
          <div class="card-title">当前关注</div>
          <div class="focus-list">
            <div class="focus-item">
              <span class="focus-label">待处理 FBS 订单</span>
              <span class="focus-value">{{ summary.pending_fbs_orders }}</span>
            </div>
            <div class="focus-item">
              <span class="focus-label">低库存提醒</span>
              <span class="focus-value">{{ summary.low_stock_alerts }}</span>
            </div>
            <div class="focus-item">
              <span class="focus-label">失败上传任务</span>
              <span class="focus-value">{{ summary.failed_jobs }}</span>
            </div>
            <div class="focus-item">
              <span class="focus-label">活跃店铺</span>
              <span class="focus-value">{{ summary.active_stores }}</span>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import * as echarts from 'echarts'
import { fetchCategoryAnalytics, type AnalyticsChartItem } from '../api/analytics'
import {
  fetchDashboardSummary,
  fetchDashboardTrends,
  type DashboardSummary,
  type DashboardTrends,
} from '../api/dashboard'
import { fetchStores } from '../api/store'

type StoreItem = {
  id: number
  store_name: string
  key_status?: string
  daily_limit?: string
  watermark?: string
}

const ALL_STORES_VALUE = 'ALL'

const createEmptySummary = (): DashboardSummary => ({
  today_orders: 0,
  pending_fbs_orders: 0,
  total_products: 0,
  low_stock_alerts: 0,
  active_stores: 0,
  submitted_jobs: 0,
  completed_jobs: 0,
  failed_jobs: 0,
  successful_uploaded_skus: 0,
})

const createEmptyTrends = (): DashboardTrends => ({
  labels: [],
  uploads: [],
  completed: [],
  successful_uploaded_skus: [],
  orders: [],
  revenue: [],
  sales_units: [],
})

const loading = ref(false)
const dashboardPeriodOptions = [
  { value: '7_days', label: '7天', days: 7 },
  { value: '28_days', label: '28天', days: 28 },
  { value: 'quarter', label: '季度', days: 90 },
  { value: 'year', label: '年份', days: 365 },
] as const
type DashboardPeriodValue = (typeof dashboardPeriodOptions)[number]['value']
const dashboardPeriodToDays = Object.fromEntries(
  dashboardPeriodOptions.map((option) => [option.value, option.days]),
) as Record<DashboardPeriodValue, number>
const selectedPeriod = ref<DashboardPeriodValue>('7_days')
const selectedDays = computed(() => dashboardPeriodToDays[selectedPeriod.value] || 7)
const selectedStoreId = ref<number | typeof ALL_STORES_VALUE>(ALL_STORES_VALUE)
const allStores = ref<StoreItem[]>([])
const summary = ref<DashboardSummary>(createEmptySummary())
const trends = ref<DashboardTrends>(createEmptyTrends())
const categoryCharts = ref({
  sales: [] as AnalyticsChartItem[],
  orders: [] as AnalyticsChartItem[],
  skus: [] as AnalyticsChartItem[],
})

const uploadChartRef = ref<HTMLElement | null>(null)
const salesPieChartRef = ref<HTMLElement | null>(null)
const ordersPieChartRef = ref<HTMLElement | null>(null)
const skusPieChartRef = ref<HTMLElement | null>(null)
let uploadChart: echarts.ECharts | null = null
let salesPieChart: echarts.ECharts | null = null
let ordersPieChart: echarts.ECharts | null = null
let skusPieChart: echarts.ECharts | null = null

const resolvedStoreId = computed(() =>
  selectedStoreId.value === ALL_STORES_VALUE ? undefined : Number(selectedStoreId.value),
)

const selectedStoreName = computed(() => {
  if (resolvedStoreId.value == null) return '全部店铺'
  return allStores.value.find((store) => store.id === resolvedStoreId.value)?.store_name || '当前店铺'
})

const visibleStores = computed(() => {
  if (resolvedStoreId.value == null) return allStores.value
  return allStores.value.filter((store) => store.id === resolvedStoreId.value)
})

const summaryCards = computed(() => [
  {
    key: 'stores',
    label: '活跃店铺',
    value: summary.value.active_stores,
    note:
      resolvedStoreId.value == null
        ? `已接入 ${allStores.value.length} 个店铺`
        : `当前筛选：${selectedStoreName.value}`,
  },
  {
    key: 'jobs',
    label: '成功上传 SKU',
    value: summary.value.successful_uploaded_skus,
    note: `累计提交 ${summary.value.submitted_jobs} 个任务 / 失败 ${summary.value.failed_jobs} 个`,
  },
  {
    key: 'products',
    label: '商品总数',
    value: summary.value.total_products,
    note: `低库存 ${summary.value.low_stock_alerts} 个`,
  },
  {
    key: 'orders',
    label: '今日订单',
    value: summary.value.today_orders,
    note: `待处理 FBS ${summary.value.pending_fbs_orders} 单`,
  },
])

const initCharts = () => {
  if (uploadChartRef.value && !uploadChart) {
    uploadChart = echarts.init(uploadChartRef.value)
  }
  if (salesPieChartRef.value && !salesPieChart) {
    salesPieChart = echarts.init(salesPieChartRef.value)
  }
  if (ordersPieChartRef.value && !ordersPieChart) {
    ordersPieChart = echarts.init(ordersPieChartRef.value)
  }
  if (skusPieChartRef.value && !skusPieChart) {
    skusPieChart = echarts.init(skusPieChartRef.value)
  }
}

const buildPieOption = (
  title: string,
  data: AnalyticsChartItem[],
  valueFormatter: (value: number) => string,
) => {
  const hasData = data.length > 0
  const manyItems = data.length > 6
  const valueMap = new Map(data.map((item) => [item.name, item.value]))

  return {
    title: {
      text: title,
      top: 8,
      left: 'center',
      textStyle: {
        fontSize: 14,
        fontWeight: 600,
        color: '#1f2937',
      },
    },
    tooltip: {
      trigger: 'item',
      formatter: (params: { name: string; value: number; percent: number }) =>
        `${params.name}<br/>${valueFormatter(params.value)} (${params.percent}%)`,
    },
    legend: {
      show: hasData,
      type: manyItems ? 'scroll' : 'plain',
      orient: manyItems ? 'vertical' : 'horizontal',
      top: manyItems ? 44 : undefined,
      right: manyItems ? 8 : undefined,
      bottom: manyItems ? 20 : 0,
      left: manyItems ? undefined : 'center',
      icon: 'circle',
      itemWidth: 10,
      itemHeight: 10,
      pageIconColor: '#2563eb',
      pageTextStyle: {
        color: '#6b7280',
      },
      formatter: (name: string) => `${name}  ${valueFormatter(valueMap.get(name) ?? 0)}`,
      textStyle: {
        color: '#6b7280',
        fontSize: 12,
      },
    },
    graphic: hasData
      ? []
      : [
          {
            type: 'text',
            left: 'center',
            top: '45%',
            style: {
              text: '暂无数据',
              fill: '#9ca3af',
              fontSize: 14,
            },
          },
        ],
    series: [
      {
        type: 'pie',
        radius: ['45%', '70%'],
        center: manyItems ? ['32%', '48%'] : ['50%', '44%'],
        avoidLabelOverlap: true,
        label: {
          show: hasData && !manyItems,
          formatter: (params: { name: string; percent: number }) => `${params.name}\n${params.percent}%`,
          fontSize: 11,
        },
        labelLine: {
          show: hasData && !manyItems,
        },
        data: hasData
          ? data
          : [
              {
                name: '暂无数据',
                value: 1,
                itemStyle: {
                  color: '#e5e7eb',
                },
              },
            ],
      },
    ],
  }
}

const renderCharts = () => {
  if (!uploadChart || !salesPieChart || !ordersPieChart || !skusPieChart) return

  uploadChart.setOption({
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'line',
      },
    },
    legend: { data: ['成功上传 SKU', '销量'] },
    grid: { left: 48, right: 56, top: 44, bottom: 28 },
    xAxis: {
      type: 'category',
      data: trends.value.labels,
      boundaryGap: false,
    },
    yAxis: [
      {
        type: 'value',
        name: '上传 SKU',
      },
      {
        type: 'value',
        name: '销量',
      },
    ],
    series: [
      {
        name: '成功上传 SKU',
        type: 'line',
        smooth: true,
        data: trends.value.successful_uploaded_skus,
        lineStyle: {
          width: 3,
        },
        areaStyle: { opacity: 0.12 },
        symbolSize: 7,
      },
      {
        name: '销量',
        type: 'line',
        smooth: true,
        yAxisIndex: 1,
        data: trends.value.sales_units,
        lineStyle: {
          width: 3,
        },
        symbolSize: 7,
      },
    ],
  })

  salesPieChart.setOption(buildPieOption('销售额分布', categoryCharts.value.sales, (value) => `¥${value.toLocaleString('zh-CN')}`))
  ordersPieChart.setOption(buildPieOption('订单分布', categoryCharts.value.orders, (value) => value.toLocaleString('zh-CN')))
  skusPieChart.setOption(buildPieOption('在售 SKU 分布', categoryCharts.value.skus, (value) => value.toLocaleString('zh-CN')))
}

const loadStores = async (refreshStatus = false) => {
  const storeData = await fetchStores(refreshStatus)
  allStores.value = Array.isArray(storeData) ? storeData : []
  if (
    selectedStoreId.value !== ALL_STORES_VALUE &&
    !allStores.value.some((store) => store.id === selectedStoreId.value)
  ) {
    selectedStoreId.value = ALL_STORES_VALUE
  }
}

const loadDashboard = async () => {
  loading.value = true
  try {
    const [summaryData, trendData, analyticsData] = await Promise.all([
      fetchDashboardSummary(resolvedStoreId.value),
      fetchDashboardTrends(selectedDays.value, resolvedStoreId.value),
      fetchCategoryAnalytics(selectedDays.value, '', resolvedStoreId.value),
    ])
    summary.value = summaryData
    trends.value = trendData
    categoryCharts.value = analyticsData.charts
    await nextTick()
    initCharts()
    renderCharts()
  } finally {
    loading.value = false
  }
}

const handleRefresh = async () => {
  await Promise.all([loadStores(), loadDashboard()])
}

const handleResize = () => {
  uploadChart?.resize()
  salesPieChart?.resize()
  ordersPieChart?.resize()
  skusPieChart?.resize()
}

onMounted(async () => {
  window.addEventListener('resize', handleResize)
  await handleRefresh()
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  uploadChart?.dispose()
  salesPieChart?.dispose()
  ordersPieChart?.dispose()
  skusPieChart?.dispose()
})
</script>

<style scoped>
.dashboard-container {
  padding: 0;
}

.page-desc {
  color: var(--c-text-2);
  margin: 6px 0 0;
}

.card-subtitle {
  margin-top: -4px;
  margin-bottom: 12px;
  color: var(--c-text-3);
  font-size: var(--font-size-sm);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.header-actions {
  justify-content: flex-end;
}

.period-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-width: 100%;
}

.period-group :deep(.el-radio-button) {
  margin: 0;
}

.period-group :deep(.el-radio-button__inner) {
  border-left: 1px solid var(--el-border-color) !important;
  border-radius: var(--el-border-radius-base) !important;
}

.period-group :deep(.el-radio-button.is-active .el-radio-button__inner) {
  border-left-color: var(--el-color-primary) !important;
}

.store-select {
  width: 220px;
}

.summary-grid,
.chart-grid {
  margin-bottom: 16px;
}

.summary-grid :deep(.el-col) {
  display: flex;
}

.pie-section {
  margin-bottom: 16px;
}

.metric-card,
.chart-card,
.info-card {
  border-radius: var(--radius-sm);
  border: 1px solid var(--c-border-1);
}

.metric-card {
  width: 100%;
  min-height: 148px;
  display: flex;
  flex-direction: column;
}

.metric-title {
  color: var(--c-text-2);
  font-size: var(--font-size-sm);
  min-height: 20px;
}

.metric-value {
  font-size: 32px;
  font-weight: 700;
  margin: 12px 0 6px;
  line-height: 1;
  min-height: 32px;
  display: flex;
  align-items: flex-end;
}

.metric-note {
  color: var(--c-text-3);
  font-size: var(--font-size-sm);
  min-height: 40px;
  display: flex;
  align-items: flex-end;
  margin-top: auto;
}

.card-title {
  font-size: var(--font-size-md);
  font-weight: 650;
  margin-bottom: 12px;
}

.chart-box {
  width: 100%;
  height: 320px;
}

.pie-chart-box {
  width: 100%;
  height: 320px;
}

.pie-shell {
  border: 1px solid var(--c-border-1);
  border-radius: var(--radius-sm);
  background: linear-gradient(180deg, var(--c-surface-1), color-mix(in oklch, var(--c-surface-2) 92%, white));
}

.focus-list {
  display: grid;
  gap: 12px;
}

.focus-item {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--c-border-1);
}

.focus-item:last-child {
  border-bottom: none;
}

.focus-label {
  color: var(--c-text-2);
}

.focus-value {
  font-weight: 700;
}

@media (max-width: 768px) {
  .store-select {
    width: 100%;
  }

  .focus-item {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
