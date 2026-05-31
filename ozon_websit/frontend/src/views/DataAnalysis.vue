<template>
  <div class="data-analysis-container">
    <div class="page-header analysis-header">
      <div>
        <h2 class="page-title">数据分析</h2>
        <p class="page-desc">按类目逐级查看最近订单、销售额、动销商品和库存压力。</p>
      </div>
      <div class="header-actions">
        <el-radio-group v-if="false" v-model="selectedLocalPeriod" size="small" @change="loadData">
          <el-radio-button :value="7">7天</el-radio-button>
          <el-radio-button :value="14">14天</el-radio-button>
          <el-radio-button :value="30">30天</el-radio-button>
        </el-radio-group>
        <!--
        <el-radio-group v-if="false" v-model="selectedPeriod" size="small" @change="loadData">
          <el-radio-button label="7天" value="7_days" />
          <el-radio-button label="28天" value="28_days" />
          <el-radio-button label="季度" value="quarter" />
          <el-radio-button label="年份" value="year" />
        </el-radio-group>
        -->
        <el-radio-group v-model="selectedLocalPeriod" class="period-group" size="small" @change="loadLocalData">
          <el-radio-button
            v-for="option in LOCAL_PERIOD_OPTIONS"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-radio-group>
        <el-button type="primary" :icon="RefreshRight" :loading="loading || marketLoading" @click="loadData">
          刷新
        </el-button>
      </div>
    </div>

    <div class="scope-bar">
      <div class="scope-left">
        <el-button v-if="categoryPath.length" text :icon="Back" @click="goBack">返回上级</el-button>
        <el-breadcrumb separator="/">
          <el-breadcrumb-item class="breadcrumb-item" @click="resetCategory">全部类目</el-breadcrumb-item>
          <el-breadcrumb-item
            v-for="(item, index) in categoryPath"
            :key="`${item}-${index}`"
            class="breadcrumb-item"
            @click="jumpToCategoryLevel(index)"
          >
            {{ item }}
          </el-breadcrumb-item>
        </el-breadcrumb>
      </div>
      <div class="scope-tags">
        <el-tag type="success">匹配率 {{ formatPercent(summary.matchedRate) }}</el-tag>
        <el-tag type="warning">低库存 {{ summary.lowStockSkus }} SKU</el-tag>
        <el-tag>在售 {{ summary.catalogSkus }} SKU</el-tag>
      </div>
    </div>

    <el-alert
      v-if="summary.unmatchedOrders > 0"
      type="warning"
      :closable="false"
      show-icon
      :title="`当前范围内有 ${summary.unmatchedOrders} 笔订单未匹配到商品类目，已归入未分类。`"
    />

    <el-row :gutter="16" class="summary-grid">
      <el-col v-for="card in summaryCards" :key="card.key" :xs="24" :sm="12" :xl="6">
        <el-card shadow="never" class="metric-card">
          <div class="metric-label">{{ card.label }}</div>
          <div class="metric-value">{{ card.value }}</div>
          <div class="metric-note">
            <span :class="deltaClass(card.delta)">{{ formatDelta(card.delta) }}</span>
            <span class="metric-note-text">vs 上一周期</span>
          </div>
          <div class="metric-extra">{{ card.extra }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" class="top-grid">
      <el-col :xs="24" :lg="16">
        <el-card shadow="never" class="panel-card">
          <div class="panel-head">
            <div>
              <div class="panel-title">销售趋势</div>
              <div class="panel-subtitle">{{ meta.currentStart }} 至 {{ meta.currentEnd }} · {{ summary.scopeLabel }}</div>
            </div>
          </div>
          <div ref="trendChartRef" class="chart-box trend-chart"></div>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="8">
        <el-card shadow="never" class="panel-card insights-card">
          <div class="panel-head">
            <div>
              <div class="panel-title">重点观察</div>
              <div class="panel-subtitle">系统根据当前范围自动汇总。</div>
            </div>
          </div>

          <div class="insight-list">
            <div v-for="(item, index) in insights" :key="`${item}-${index}`" class="insight-item">
              <span class="insight-index">{{ `${index + 1}`.padStart(2, '0') }}</span>
              <p>{{ item }}</p>
            </div>
          </div>

          <div class="meta-list">
            <div class="meta-item">
              <span>统计周期</span>
              <strong>{{ selectedPeriodLabel }}</strong>
            </div>
            <div class="meta-item">
              <span>店铺数</span>
              <strong>{{ summary.storeCount }}</strong>
            </div>
            <div class="meta-item">
              <span>叶子类目</span>
              <strong>{{ summary.leafCategoryCount }}</strong>
            </div>
            <div class="meta-item">
              <span>更新时间</span>
              <strong>{{ formatDateTime(meta.generatedAt) }}</strong>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="panel-card market-panel" v-loading="marketLoading">
      <div class="panel-head">
        <div>
          <div class="panel-title">Ozon 类目趋势</div>
          <div class="panel-subtitle">{{ marketSubtitle }}</div>
        </div>
        <el-radio-group v-model="selectedMarketPeriod" class="period-group" size="small" @change="loadMarketData">
          <el-radio-button
            v-for="option in MARKET_PERIOD_OPTIONS"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-radio-group>
      </div>

      <el-alert
        v-if="marketError"
        class="market-alert"
        type="warning"
        :closable="false"
        show-icon
        :title="marketError"
      />

      <el-row :gutter="16" class="pie-grid">
        <el-col :xs="24" :lg="8">
          <div class="market-chart-card">
            <div ref="salesChartRef" class="chart-box"></div>
            <div class="market-chart-meta">
              <span class="market-chart-meta-label">{{ marketChartStats.sales.footerLabel }}</span>
              <strong :class="marketChartStats.sales.footerClass">{{ marketChartStats.sales.footerDisplay }}</strong>
            </div>
          </div>
        </el-col>
        <el-col :xs="24" :lg="8">
          <div class="market-chart-card">
            <div ref="ordersChartRef" class="chart-box"></div>
            <div class="market-chart-meta">
              <span class="market-chart-meta-label">{{ marketChartStats.units.footerLabel }}</span>
              <strong :class="marketChartStats.units.footerClass">{{ marketChartStats.units.footerDisplay }}</strong>
            </div>
          </div>
        </el-col>
        <el-col :xs="24" :lg="8">
          <div class="market-chart-card">
            <div ref="skusChartRef" class="chart-box"></div>
            <div class="market-chart-meta">
              <span class="market-chart-meta-label">{{ marketChartStats.sellers.footerLabel }}</span>
              <strong :class="marketChartStats.sellers.footerClass">{{ marketChartStats.sellers.footerDisplay }}</strong>
            </div>
          </div>
        </el-col>
      </el-row>

      <div class="market-browser">
        <div class="market-browser-head">
          <div class="market-browser-title">
            <div class="panel-title">类目查看</div>
            <el-breadcrumb separator="/">
              <el-breadcrumb-item class="breadcrumb-item" @click="resetMarketCategory">{{ marketRootLabel }}</el-breadcrumb-item>
              <el-breadcrumb-item
                v-for="(item, index) in marketCategoryPath"
                :key="`${item.id}-${index}`"
                class="breadcrumb-item"
                @click="jumpToMarketCategory(index)"
              >
                {{ item.name }}
              </el-breadcrumb-item>
            </el-breadcrumb>
          </div>
          <div class="market-browser-actions">
            <el-button v-if="marketBasePathIds.length || marketCategoryPath.length" @click="goBackMarketCategory">
              返回上级
            </el-button>
            <el-button v-if="marketCategoryPath.length" @click="resetMarketCategory">
              回到一级
            </el-button>
          </div>
        </div>

        <div class="market-browser-controls">
          <el-select
            v-model="marketRootCategoryId"
            filterable
            placeholder="选择一级类目"
            class="market-category-select"
            @change="handleMarketRootSelect"
          >
            <el-option
              v-for="item in marketRootSelectOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
          <el-select
            v-model="marketSecondCategoryId"
            clearable
            filterable
            :disabled="!marketBasePathIds.length || !marketSecondLevelOptions.length"
            :placeholder="marketSecondLevelPlaceholder"
            class="market-category-select"
            @change="handleMarketSecondLevelSelect"
          >
            <el-option
              v-for="item in marketSecondLevelOptions"
              :key="item.id"
              :label="item.name"
              :value="String(item.id)"
            />
          </el-select>
        </div>

        <el-input
          v-model="marketSearchQuery"
          clearable
          class="market-search"
          placeholder="搜索类目"
        />
      </div>

      <el-empty
        v-if="!marketFilteredRows.length && !marketError"
        class="market-empty"
        :description="marketEmptyDescription"
      />

      <el-table
        v-else-if="marketFilteredRows.length"
        :data="marketFilteredRows"
        border
        size="small"
        max-height="360"
        class="market-table"
        :row-class-name="marketRowClassName"
        @row-click="handleMarketRowClick"
      >
        <el-table-column prop="name" label="类目" min-width="180">
          <template #default="{ row }">
            <div class="name-cell">
              <span>{{ row.name }}</span>
              <el-tag v-if="row.canDrillDown" size="small" effect="plain">下钻</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="销售额" width="140" align="right">
          <template #default="{ row }">{{ formatCurrency(row.salesAmount) }}</template>
        </el-table-column>
        <el-table-column label="销售额环比" width="120" align="center">
          <template #default="{ row }">
            <span :class="deltaClass(row.salesDelta)">{{ formatDelta(row.salesDelta) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="soldUnits" label="销量" width="100" align="center" />
        <el-table-column prop="sellerCount" label="卖家数" width="100" align="center" />
        <el-table-column label="平均价格" width="120" align="right">
          <template #default="{ row }">{{ formatCurrency(row.avgPrice) }}</template>
        </el-table-column>
        <el-table-column label="均价环比" width="120" align="center">
          <template #default="{ row }">
            <span :class="deltaClass(row.avgPriceDelta)">{{ formatDelta(row.avgPriceDelta) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="brandCount" label="品牌数" width="100" align="center" />
        <el-table-column label="头部卖家份额" width="130" align="center">
          <template #default="{ row }">{{ formatPercent(row.leaderShare) }}</template>
        </el-table-column>
        <el-table-column label="认购率" width="110" align="center">
          <template #default="{ row }">{{ formatPercent(row.buyoutRate) }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="false" shadow="never" class="panel-card table-card">
      <div class="table-toolbar">
        <div class="panel-title">分析明细</div>
        <div class="table-toolbar-actions">
          <el-input
            v-model="searchQuery"
            clearable
            placeholder="搜索当前层级名称"
            style="width: 260px"
          />
          <el-button v-if="categoryPath.length" @click="resetCategory">回到全部类目</el-button>
        </div>
      </div>

      <el-empty v-if="!filteredRows.length && !loading" description="当前范围暂无数据" />

      <el-table
        v-else
        :data="filteredRows"
        border
        style="width: 100%"
        v-loading="loading"
        header-cell-class-name="table-header"
        :row-class-name="rowClassName"
        @row-click="handleRowClick"
      >
        <el-table-column prop="name" label="名称" min-width="180">
          <template #default="{ row }">
            <div class="name-cell">
              <span>{{ row.name }}</span>
              <el-tag v-if="row.canDrillDown" size="small" effect="plain">下钻</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="销售额" width="130" align="right">
          <template #default="{ row }">{{ formatCurrency(row.salesAmount) }}</template>
        </el-table-column>
        <el-table-column label="销售额环比" width="120" align="center">
          <template #default="{ row }">
            <span :class="deltaClass(row.salesDelta)">{{ formatDelta(row.salesDelta) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="销售占比" width="110" align="center">
          <template #default="{ row }">{{ formatPercent(row.salesShare) }}</template>
        </el-table-column>
        <el-table-column prop="orderCount" label="订单数" width="100" align="center" />
        <el-table-column prop="soldUnits" label="销量" width="100" align="center" />
        <el-table-column prop="skuCount" label="在售SKU" width="110" align="center" />
        <el-table-column label="均价" width="110" align="right">
          <template #default="{ row }">{{ formatCurrency(row.avgPrice) }}</template>
        </el-table-column>
        <el-table-column label="客单价" width="110" align="right">
          <template #default="{ row }">{{ formatCurrency(row.avgOrderValue) }}</template>
        </el-table-column>
        <el-table-column prop="stockOnHand" label="库存" width="100" align="center" />
        <el-table-column label="低库存SKU" width="120" align="center">
          <template #default="{ row }">
            <span :class="{ danger: row.lowStockSkus > 0 }">{{ row.lowStockSkus }}</span>
          </template>
        </el-table-column>
        <el-table-column label="Top5集中度" width="120" align="center">
          <template #default="{ row }">{{ formatPercent(row.top5Share) }}</template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Back, RefreshRight } from '@element-plus/icons-vue'
import * as echarts from 'echarts'
import {
  createEmptyMarketCategoryTrends,
  fetchCategoryAnalytics,
  fetchMarketCategoryTrends,
  type AnalyticsChartItem,
  type AnalyticsTableRow,
  type CategoryAnalyticsResponse,
  type MarketCategoryTrendRow,
  type MarketCategoryTrendResponse,
} from '../api/analytics'

defineOptions({
  name: 'DataAnalysis',
})

const MARKET_ROOT_STORAGE_KEY = 'data-analysis-market-root-category-id'
const MARKET_ROOT_ALL_VALUE = '__ALL__'
const MARKET_ROOT_ALL_LABEL = 'ALL'
const MARKET_SCOPE_ALL_LABEL = '全部类目'

const LOCAL_PERIOD_OPTIONS = [
  { value: '7_days', label: '7\u5929', days: 7 },
  { value: '28_days', label: '28\u5929', days: 28 },
  { value: 'quarter', label: '\u5b63\u5ea6', days: 90 },
  { value: 'year', label: '\u5e74\u4efd', days: 365 },
] as const
const LOCAL_PERIOD_TO_DAYS = Object.fromEntries(
  LOCAL_PERIOD_OPTIONS.map((option) => [option.value, option.days]),
) as Record<(typeof LOCAL_PERIOD_OPTIONS)[number]['value'], number>
const LOCAL_PERIOD_TO_LABEL = Object.fromEntries(
  LOCAL_PERIOD_OPTIONS.map((option) => [option.value, option.label]),
) as Record<(typeof LOCAL_PERIOD_OPTIONS)[number]['value'], string>
/* const PERIOD_TO_LABEL = {
  '7_days': '7天',
  '28_days': '28天',
  quarter: '季度',
  year: '年份',
} as const */
const MARKET_PERIOD_OPTIONS = [
  { value: '7_days', label: '7\u5929' },
  { value: '28_days', label: '28\u5929' },
  { value: 'quarter', label: '\u5b63\u5ea6' },
  { value: 'year', label: '\u5e74\u4efd' },
] as const

type LocalPeriodValue = (typeof LOCAL_PERIOD_OPTIONS)[number]['value']
type MarketPeriodValue = (typeof MARKET_PERIOD_OPTIONS)[number]['value']

const selectedLocalPeriod = ref<LocalPeriodValue>('7_days')
const selectedMarketPeriod = ref<MarketPeriodValue>('28_days')
const searchQuery = ref('')
const marketSearchQuery = ref('')
const marketRootCategoryId = ref('')
const marketRootOptions = ref<Array<{ id: number; name: string }>>([])
const marketSecondCategoryId = ref('')
const marketSecondLevelOptions = ref<Array<{ id: number; name: string }>>([])
const categoryPath = ref<string[]>([])
const marketBasePathIds = ref<number[]>([])
const marketBasePathLabel = ref('')
const marketCategoryPath = ref<Array<{ id: number; name: string }>>([])
const loading = ref(false)
const marketLoading = ref(false)
const marketRootUserCleared = ref(false)

const createEmptyAnalytics = (): CategoryAnalyticsResponse => ({
  path: [],
  summary: {
    scopeLabel: '全部类目',
    totalSales: 0,
    salesDelta: 0,
    orderCount: 0,
    orderDelta: 0,
    soldUnits: 0,
    soldUnitsDelta: 0,
    activeSkus: 0,
    activeSkusDelta: 0,
    catalogSkus: 0,
    stockOnHand: 0,
    lowStockSkus: 0,
    avgOrderValue: 0,
    avgOrderValueDelta: 0,
    storeCount: 0,
    leafCategoryCount: 0,
    matchedOrders: 0,
    unmatchedOrders: 0,
    matchedRate: 0,
  },
  trend: {
    labels: [],
    sales: [],
    orders: [],
    units: [],
  },
  charts: {
    sales: [],
    orders: [],
    skus: [],
  },
  table: [],
  insights: [],
  meta: {
    days: 7,
    scopeLabel: '全部类目',
    generatedAt: '',
    currentStart: '',
    currentEnd: '',
    previousStart: '',
    previousEnd: '',
    hasData: false,
    canDrillDown: true,
  },
})

const analytics = ref<CategoryAnalyticsResponse>(createEmptyAnalytics())
const marketAnalytics = ref<MarketCategoryTrendResponse>(createEmptyMarketCategoryTrends())
const marketError = ref('')

const summary = computed(() => analytics.value.summary)
const trend = computed(() => analytics.value.trend)
const rows = computed(() => analytics.value.table)
const insights = computed(() => analytics.value.insights)
const meta = computed(() => analytics.value.meta)
const selectedLocalDays = computed(() => LOCAL_PERIOD_TO_DAYS[selectedLocalPeriod.value] || 7)
/*
const selectedPeriodLabel = computed(() => PERIOD_TO_LABEL[selectedPeriod.value] || '7天')
*/
const selectedPeriodLabel = computed(() => LOCAL_PERIOD_TO_LABEL[selectedLocalPeriod.value] || '7\u5929')
const marketRows = computed(() => marketAnalytics.value.table)
const marketFilteredRows = computed(() => {
  const keyword = marketSearchQuery.value.trim().toLowerCase()
  if (!keyword) {
    return marketRows.value
  }
  return marketRows.value.filter((row) => row.name.toLowerCase().includes(keyword))
})
const marketAllSelected = computed(() => marketRootCategoryId.value === MARKET_ROOT_ALL_VALUE)
const marketRootSelectOptions = computed(() => [
  { value: MARKET_ROOT_ALL_VALUE, label: MARKET_ROOT_ALL_LABEL },
  ...marketRootOptions.value.map((item) => ({
    value: String(item.id),
    label: item.name,
  })),
])
const marketLevel = computed(() => marketAnalytics.value.level || Math.min(marketCategoryPath.value.length + 1, 3))
const marketLevelLabel = computed(() => ['一级类目', '二级类目', '三级类目'][marketLevel.value - 1] || '类目')
const marketRootLabel = computed(() =>
  marketAllSelected.value ? MARKET_SCOPE_ALL_LABEL : (marketBasePathLabel.value || '一级类目'),
)
const marketScopeLabel = computed(() =>
  marketCategoryPath.value.length
    ? marketCategoryPath.value[marketCategoryPath.value.length - 1].name
    : (marketAllSelected.value
        ? MARKET_SCOPE_ALL_LABEL
        : (marketBasePathLabel.value || (marketRootOptions.value.length ? '请选择一级类目' : '全部类目'))),
)
const marketSecondLevelPlaceholder = computed(() => {
  if (marketAllSelected.value || !marketBasePathIds.value.length) {
    return '先选择一级类目'
  }
  if (!marketSecondLevelOptions.value.length) {
    return '当前一级类目暂无二级类目'
  }
  return '选择二级类目'
})
const marketEmptyDescription = computed(() =>
  marketAllSelected.value
    ? '当前筛选下暂无 Seller 一级类目数据'
    : !marketBasePathIds.value.length && marketRootOptions.value.length
      ? '请选择一级类目或 ALL 后再查看饼图和下钻数据'
    : '当前筛选下暂无 Seller 类目数据',
)
const marketSubtitle = computed(() => {
  const periodLabel = marketAnalytics.value.periodLabel || '当前周期'
  return `${marketLevelLabel.value} · ${marketScopeLabel.value} · ${periodLabel}`
})

const salesChartRef = ref<HTMLElement | null>(null)
const ordersChartRef = ref<HTMLElement | null>(null)
const skusChartRef = ref<HTMLElement | null>(null)
const trendChartRef = ref<HTMLElement | null>(null)

let salesChart: echarts.ECharts | null = null
let ordersChart: echarts.ECharts | null = null
let skusChart: echarts.ECharts | null = null
let trendChart: echarts.ECharts | null = null
let requestSerial = 0
let marketRequestSerial = 0

const numberFormatter = new Intl.NumberFormat('zh-CN')
const currencyFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

const filteredRows = computed(() => {
  const keyword = searchQuery.value.trim().toLowerCase()
  if (!keyword) {
    return rows.value
  }
  return rows.value.filter((row) => row.name.toLowerCase().includes(keyword))
})

const summaryCards = computed(() => [
  {
    key: 'sales',
    label: '销售额',
    value: formatCurrency(summary.value.totalSales),
    delta: summary.value.salesDelta,
    extra: `范围客单价 ${formatCurrency(summary.value.avgOrderValue)}`,
  },
  {
    key: 'orders',
    label: '订单数',
    value: formatNumber(summary.value.orderCount),
    delta: summary.value.orderDelta,
    extra: `累计销量 ${formatNumber(summary.value.soldUnits)} 件`,
  },
  {
    key: 'activeSkus',
    label: '动销SKU',
    value: formatNumber(summary.value.activeSkus),
    delta: summary.value.activeSkusDelta,
    extra: `当前在售 ${formatNumber(summary.value.catalogSkus)} SKU`,
  },
  {
    key: 'avgOrderValue',
    label: '客单价',
    value: formatCurrency(summary.value.avgOrderValue),
    delta: summary.value.avgOrderValueDelta,
    extra: `低库存 ${formatNumber(summary.value.lowStockSkus)} SKU`,
  },
])

type MarketPieItem = AnalyticsChartItem & { itemId?: string }

const sumMarketValue = <K extends keyof MarketCategoryTrendRow>(rows: MarketCategoryTrendRow[], key: K) =>
  rows.reduce((total, row) => total + Number(row[key] || 0), 0)

function aggregateMarketSalesDelta(rows: MarketCategoryTrendRow[]) {
  const currentTotal = sumMarketValue(rows, 'salesAmount')
  let previousTotal = 0
  let comparableCount = 0

  rows.forEach((row) => {
    const currentValue = Number(row.salesAmount || 0)
    const delta = Number(row.salesDelta || 0)
    const denominator = 1 + delta / 100
    if (currentValue <= 0 || denominator <= 0) {
      return
    }
    previousTotal += currentValue / denominator
    comparableCount += 1
  })

  if (!comparableCount) {
    return null
  }
  if (previousTotal <= 0) {
    return currentTotal > 0 ? 100 : 0
  }

  return ((currentTotal - previousTotal) / previousTotal) * 100
}

function aggregateMarketUnitsDelta(rows: MarketCategoryTrendRow[]) {
  const currentTotal = sumMarketValue(rows, 'soldUnits')
  let previousTotal = 0
  let comparableCount = 0

  rows.forEach((row) => {
    const currentValue = Number(row.soldUnits || 0)
    const salesFactor = 1 + Number(row.salesDelta || 0) / 100
    const priceFactor = 1 + Number(row.avgPriceDelta || 0) / 100
    if (currentValue <= 0 || salesFactor <= 0 || priceFactor <= 0) {
      return
    }

    const unitFactor = salesFactor / priceFactor
    if (unitFactor <= 0) {
      return
    }

    previousTotal += currentValue / unitFactor
    comparableCount += 1
  })

  if (!comparableCount) {
    return null
  }
  if (previousTotal <= 0) {
    return currentTotal > 0 ? 100 : 0
  }

  return ((currentTotal - previousTotal) / previousTotal) * 100
}

function buildMarketPieItems(valueKey: 'salesAmount' | 'soldUnits' | 'sellerCount'): MarketPieItem[] {
  return marketRows.value
    .filter((row) => Number(row[valueKey] || 0) > 0)
    .map((row) => ({
      name: row.name,
      value: Number(row[valueKey] || 0),
      itemId: row.id,
    }))
}

const marketPieData = computed(() => ({
  sales: buildMarketPieItems('salesAmount'),
  units: buildMarketPieItems('soldUnits'),
  sellers: buildMarketPieItems('sellerCount'),
}))

const marketChartStats = computed(() => {
  const rowsForView = marketRows.value
  const salesTotal = sumMarketValue(rowsForView, 'salesAmount')
  const unitsTotal = sumMarketValue(rowsForView, 'soldUnits')
  const sellersTotal = sumMarketValue(rowsForView, 'sellerCount')
  const salesDelta = aggregateMarketSalesDelta(rowsForView)
  const unitsDelta = aggregateMarketUnitsDelta(rowsForView)

  return {
    sales: {
      centerLabel: marketScopeLabel.value,
      centerValue: salesTotal,
      footerLabel: '环比',
      footerValue: salesDelta,
      footerDisplay: formatDelta(salesDelta),
      footerClass: deltaClass(salesDelta),
    },
    units: {
      centerLabel: marketScopeLabel.value,
      centerValue: unitsTotal,
      footerLabel: '环比',
      footerValue: unitsDelta,
      footerDisplay: formatDelta(unitsDelta),
      footerClass: deltaClass(unitsDelta),
    },
    sellers: {
      centerLabel: marketScopeLabel.value,
      centerValue: sellersTotal,
      footerLabel: '环比',
      footerValue: null,
      footerDisplay: formatDelta(null),
      footerClass: deltaClass(null),
    },
  }
})

function formatNumber(value: number) {
  return numberFormatter.format(value || 0)
}

function formatCurrency(value: number) {
  return `¥${currencyFormatter.format(value || 0)}`
}

function formatCompactNumber(value: number) {
  const absValue = Math.abs(value || 0)
  if (absValue >= 100000000) {
    return `${(value / 100000000).toFixed(absValue >= 1000000000 ? 0 : 1)}亿`
  }
  if (absValue >= 10000) {
    return `${(value / 10000).toFixed(absValue >= 1000000 ? 0 : 1)}万`
  }
  return formatNumber(Math.round(value || 0))
}

function formatCompactCurrency(value: number) {
  return `¥${formatCompactNumber(value)}`
}

function formatPercent(value: number) {
  return `${(value || 0).toFixed(1)}%`
}

function formatDelta(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--'
  }
  const safeValue = Number(value)
  const prefix = safeValue > 0 ? '+' : ''
  return `${prefix}${safeValue.toFixed(1)}%`
}

function deltaClass(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'delta-flat'
  }
  if (value > 0) {
    return 'delta-positive'
  }
  if (value < 0) {
    return 'delta-negative'
  }
  return 'delta-flat'
}

function formatDateTime(value: string) {
  if (!value) {
    return '--'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function readStoredMarketRootSelection() {
  if (typeof window === 'undefined') {
    return ''
  }

  const rawValue = (window.localStorage.getItem(MARKET_ROOT_STORAGE_KEY) || '').trim()
  if (rawValue === MARKET_ROOT_ALL_VALUE) {
    return rawValue
  }
  const rootId = Number(rawValue)
  return Number.isInteger(rootId) && rootId > 0 ? String(rootId) : ''
}

function persistMarketRootSelection(selection?: string | null) {
  if (typeof window === 'undefined') {
    return
  }

  const normalizedSelection = String(selection || '').trim()
  if (normalizedSelection === MARKET_ROOT_ALL_VALUE) {
    window.localStorage.setItem(MARKET_ROOT_STORAGE_KEY, MARKET_ROOT_ALL_VALUE)
    return
  }

  const rootId = Number(normalizedSelection)
  if (Number.isInteger(rootId) && rootId > 0) {
    window.localStorage.setItem(MARKET_ROOT_STORAGE_KEY, String(rootId))
    return
  }

  window.localStorage.removeItem(MARKET_ROOT_STORAGE_KEY)
}

function restoreStoredMarketRootSelection() {
  if (marketCategoryPath.value.length || marketBasePathIds.value.length || marketRootCategoryId.value || marketRootUserCleared.value) {
    return false
  }

  const storedSelection = readStoredMarketRootSelection()
  if (!storedSelection) {
    return false
  }

  if (storedSelection === MARKET_ROOT_ALL_VALUE) {
    marketBasePathIds.value = []
    marketBasePathLabel.value = MARKET_SCOPE_ALL_LABEL
    marketRootCategoryId.value = MARKET_ROOT_ALL_VALUE
    return true
  }

  const storedRootId = Number(storedSelection)
  const option = marketRootOptions.value.find((item) => item.id === storedRootId)
  if (!option) {
    persistMarketRootSelection(null)
    return false
  }

  marketBasePathIds.value = [storedRootId]
  marketBasePathLabel.value = option.name
  marketRootCategoryId.value = String(storedRootId)
  return true
}

function applyMarketAllSelection() {
  marketRootUserCleared.value = false
  marketBasePathIds.value = []
  marketBasePathLabel.value = MARKET_SCOPE_ALL_LABEL
  marketCategoryPath.value = []
  marketRootCategoryId.value = MARKET_ROOT_ALL_VALUE
  marketSecondCategoryId.value = ''
  marketSecondLevelOptions.value = []
}

type MarketChartClickParams = {
  data?: {
    itemId?: string
  } | null
}

function initCharts() {
  if (trendChartRef.value && !trendChart) {
    trendChart = echarts.init(trendChartRef.value)
  }
  if (salesChartRef.value && !salesChart) {
    salesChart = echarts.init(salesChartRef.value)
    salesChart.on('click', (params) => handleMarketChartClick(params as MarketChartClickParams))
  }
  if (ordersChartRef.value && !ordersChart) {
    ordersChart = echarts.init(ordersChartRef.value)
    ordersChart.on('click', (params) => handleMarketChartClick(params as MarketChartClickParams))
  }
  if (skusChartRef.value && !skusChart) {
    skusChart = echarts.init(skusChartRef.value)
    skusChart.on('click', (params) => handleMarketChartClick(params as MarketChartClickParams))
  }
}

function buildPieOption(
  title: string,
  data: MarketPieItem[],
  formatValue: (value: number) => string,
  centerLabel: string,
  centerValue: string,
) {
  const hasData = data.length > 0

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
        `${params.name}<br/>${formatValue(params.value)} (${params.percent}%)`,
    },
    graphic: hasData
      ? [
          {
            type: 'text',
            left: 'center',
            top: '41%',
            style: {
              text: centerLabel,
              fill: '#6b7280',
              fontSize: 12,
              fontWeight: 500,
              textAlign: 'center',
            },
          },
          {
            type: 'text',
            left: 'center',
            top: '49%',
            style: {
              text: centerValue,
              fill: '#111827',
              fontSize: 18,
              fontWeight: 700,
              textAlign: 'center',
            },
          },
        ]
      : [
          {
            type: 'text',
            left: 'center',
            top: '44%',
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
        radius: ['54%', '74%'],
        center: ['50%', '46%'],
        avoidLabelOverlap: true,
        label: {
          show: false,
        },
        labelLine: {
          show: false,
        },
        emphasis: {
          scale: true,
          scaleSize: 6,
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

function renderCharts() {
  if (!trendChart || !salesChart || !ordersChart || !skusChart) {
    return
  }

  trendChart.setOption({
    color: ['#2563eb', '#10b981', '#f59e0b'],
    tooltip: {
      trigger: 'axis',
    },
    legend: {
      top: 0,
      data: ['销售额', '订单数', '销量'],
    },
    grid: {
      left: 48,
      right: 18,
      top: 48,
      bottom: 28,
    },
    xAxis: {
      type: 'category',
      data: trend.value.labels,
      axisTick: {
        show: false,
      },
    },
    yAxis: [
      {
        type: 'value',
        name: '销售额',
      },
      {
        type: 'value',
        name: '订单/销量',
      },
    ],
    series: [
      {
        name: '销售额',
        type: 'line',
        smooth: true,
        data: trend.value.sales,
        areaStyle: {
          opacity: 0.12,
        },
      },
      {
        name: '订单数',
        type: 'bar',
        yAxisIndex: 1,
        barMaxWidth: 24,
        data: trend.value.orders,
      },
      {
        name: '销量',
        type: 'line',
        smooth: true,
        yAxisIndex: 1,
        data: trend.value.units,
      },
    ],
  })

  salesChart.setOption(
    buildPieOption(
      '类目销售额',
      marketPieData.value.sales,
      formatCurrency,
      marketChartStats.value.sales.centerLabel,
      formatCompactCurrency(marketChartStats.value.sales.centerValue),
    ),
  )
  ordersChart.setOption(
    buildPieOption(
      '类目销量',
      marketPieData.value.units,
      formatNumber,
      marketChartStats.value.units.centerLabel,
      formatCompactNumber(marketChartStats.value.units.centerValue),
    ),
  )
  skusChart.setOption(
    buildPieOption(
      '类目卖家数',
      marketPieData.value.sellers,
      formatNumber,
      marketChartStats.value.sellers.centerLabel,
      formatCompactNumber(marketChartStats.value.sellers.centerValue),
    ),
  )
}

async function loadLocalData() {
  const requestId = ++requestSerial
  loading.value = true

  try {
    const localResult = await fetchCategoryAnalytics(selectedLocalDays.value, categoryPath.value.join('/'))
    if (requestId !== requestSerial) {
      return
    }

    analytics.value = localResult
    categoryPath.value = localResult.path || []

    await nextTick()
    initCharts()
    renderCharts()
  } catch (error) {
    console.error('Failed to load analytics data:', error)
    ElMessage.error('加载数据分析失败，请稍后重试')
  } finally {
    if (requestId === requestSerial) {
      loading.value = false
    }
  }
}

async function loadMarketData() {
  const requestId = ++marketRequestSerial
  marketLoading.value = true

  try {
    const requestPath = [...marketBasePathIds.value, ...marketCategoryPath.value.map((item) => item.id)]
    const marketResult = await fetchMarketCategoryTrends(
      requestPath,
      marketAllSelected.value ? 'all' : 'current',
      selectedMarketPeriod.value,
    )
    if (requestId !== marketRequestSerial) {
      return
    }

    marketAnalytics.value = marketResult
    marketError.value = ''
    marketRootOptions.value = Array.isArray(marketResult.rootOptions) ? marketResult.rootOptions : []

    if (marketResult.rootScope === 'all') {
      applyMarketAllSelection()
      marketBasePathLabel.value = marketResult.basePathLabel || MARKET_SCOPE_ALL_LABEL
      persistMarketRootSelection(MARKET_ROOT_ALL_VALUE)
    } else {
      if (!marketCategoryPath.value.length) {
        marketBasePathIds.value = (marketResult.path || []).slice(0, 1)
        marketBasePathLabel.value = marketResult.basePathLabel || ''
      }

      marketRootCategoryId.value = marketBasePathIds.value.length ? String(marketBasePathIds.value[0]) : ''
      if (!marketCategoryPath.value.length) {
        if (marketBasePathIds.value.length) {
          marketRootUserCleared.value = false
          persistMarketRootSelection(marketRootCategoryId.value)
        } else if (restoreStoredMarketRootSelection()) {
          loadMarketData()
          return
        }
      }

      if (marketResult.rootScope === 'selected' && marketResult.level === 2 && !marketCategoryPath.value.length) {
        marketSecondLevelOptions.value = marketResult.table.map((row) => ({
          id: Number(row.id),
          name: row.name,
        }))
        marketSecondCategoryId.value = ''
      } else if (!marketBasePathIds.value.length) {
        marketSecondLevelOptions.value = []
        marketSecondCategoryId.value = ''
      } else {
        marketSecondCategoryId.value = marketCategoryPath.value.length ? String(marketCategoryPath.value[0].id) : ''
      }
    }

    await nextTick()
    initCharts()
    renderCharts()
  } catch (error) {
    if (requestId !== marketRequestSerial) {
      return
    }

    marketAnalytics.value = createEmptyMarketCategoryTrends()
    marketError.value = resolveErrorMessage(
      error,
      'Seller 类目趋势暂无可用缓存，请先在 Chrome 打开一次类目趋势页完成同步',
    )
    marketSecondCategoryId.value = marketCategoryPath.value.length ? String(marketCategoryPath.value[0].id) : ''
    if (!marketCategoryPath.value.length && !marketBasePathIds.value.length && !marketAllSelected.value) {
      marketBasePathIds.value = []
      marketBasePathLabel.value = ''
      marketRootCategoryId.value = ''
      marketRootOptions.value = []
      marketSecondLevelOptions.value = []
    }
  } finally {
    if (requestId === marketRequestSerial) {
      marketLoading.value = false
    }
  }
}

async function loadData() {
  await Promise.all([loadLocalData(), loadMarketData()])
}

function resolveErrorMessage(error: unknown, fallback: string) {
  if (
    error &&
    typeof error === 'object' &&
    'response' in error &&
    error.response &&
    typeof error.response === 'object' &&
    'data' in error.response &&
    error.response.data &&
    typeof error.response.data === 'object' &&
    'detail' in error.response.data &&
    typeof error.response.data.detail === 'string'
  ) {
    return error.response.data.detail
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

function handleMarketChartClick(params: MarketChartClickParams) {
  const clickedId = params?.data?.itemId
  if (!clickedId) {
    return
  }

  const row = marketRows.value.find((item) => item.id === clickedId)
  if (!row) {
    return
  }
  drillIntoMarketRow(row)
}

function handleMarketRowClick(row: MarketCategoryTrendRow) {
  drillIntoMarketRow(row)
}

function marketRowClassName({ row }: { row: MarketCategoryTrendRow }) {
  return row.canDrillDown ? 'market-table-row drillable-row' : 'market-table-row'
}

function drillIntoMarketRow(row: MarketCategoryTrendRow) {
  if (!row.canDrillDown) {
    return
  }

  if (marketAllSelected.value && !marketBasePathIds.value.length) {
    handleMarketRootSelect(String(row.id))
    return
  }

  marketCategoryPath.value = [{ id: Number(row.id), name: row.name }]
  marketSecondCategoryId.value = String(row.id)
  loadMarketData()
}

function handleMarketSecondLevelSelect(categoryId: string) {
  if (!marketBasePathIds.value.length || marketAllSelected.value) {
    marketSecondCategoryId.value = ''
    return
  }

  if (!categoryId) {
    marketCategoryPath.value = []
    marketSecondCategoryId.value = ''
    loadMarketData()
    return
  }

  const option = marketSecondLevelOptions.value.find((item) => String(item.id) === categoryId)
  if (!option) {
    return
  }

  marketCategoryPath.value = [{ id: option.id, name: option.name }]
  marketSecondCategoryId.value = categoryId
  loadMarketData()
}

function handleMarketRootSelect(categoryId: string) {
  marketCategoryPath.value = []
  marketSecondCategoryId.value = ''

  if (!categoryId) {
    applyMarketAllSelection()
    persistMarketRootSelection(MARKET_ROOT_ALL_VALUE)
    loadMarketData()
    return
  }

  if (categoryId === MARKET_ROOT_ALL_VALUE) {
    applyMarketAllSelection()
    persistMarketRootSelection(MARKET_ROOT_ALL_VALUE)
    loadMarketData()
    return
  }

  const option = marketRootOptions.value.find((item) => String(item.id) === categoryId)
  marketRootUserCleared.value = false
  marketBasePathIds.value = [Number(categoryId)]
  marketBasePathLabel.value = option?.name || ''
  marketRootCategoryId.value = categoryId
  marketSecondLevelOptions.value = []
  persistMarketRootSelection(categoryId)
  loadMarketData()
}

function resetMarketCategory() {
  marketCategoryPath.value = []
  marketSecondCategoryId.value = ''
  loadMarketData()
}

function goBackMarketCategory() {
  if (!marketCategoryPath.value.length) {
    if (marketBasePathIds.value.length) {
      handleMarketRootSelect(MARKET_ROOT_ALL_VALUE)
    }
    return
  }

  marketCategoryPath.value = marketCategoryPath.value.slice(0, -1)
  marketSecondCategoryId.value = ''
  loadMarketData()
}

function jumpToMarketCategory(index: number) {
  marketCategoryPath.value = marketCategoryPath.value.slice(0, index + 1)
  marketSecondCategoryId.value = marketCategoryPath.value.length ? String(marketCategoryPath.value[0].id) : ''
  loadMarketData()
}

function handleRowClick(row: AnalyticsTableRow) {
  if (!row.canDrillDown) {
    return
  }

  categoryPath.value = [...row.nextPath]
  loadLocalData()
}

function rowClassName({ row }: { row: AnalyticsTableRow }) {
  return row.canDrillDown ? 'drillable-row' : ''
}

function resetCategory() {
  categoryPath.value = []
  loadLocalData()
}

function goBack() {
  if (!categoryPath.value.length) {
    return
  }

  categoryPath.value = categoryPath.value.slice(0, -1)
  loadLocalData()
}

function jumpToCategoryLevel(index: number) {
  categoryPath.value = categoryPath.value.slice(0, index + 1)
  loadLocalData()
}

function handleResize() {
  trendChart?.resize()
  salesChart?.resize()
  ordersChart?.resize()
  skusChart?.resize()
}

onMounted(() => {
  applyMarketAllSelection()
  persistMarketRootSelection(MARKET_ROOT_ALL_VALUE)
  loadData()
})

onActivated(() => {
  window.addEventListener('resize', handleResize)
  void nextTick(() => {
    handleResize()
  })
})

onDeactivated(() => {
  window.removeEventListener('resize', handleResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  trendChart?.dispose()
  salesChart?.dispose()
  ordersChart?.dispose()
  skusChart?.dispose()
})
</script>

<style scoped>
.data-analysis-container {
  display: grid;
  gap: 16px;
}

.analysis-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
  border: 1px solid var(--c-border-1);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-1);
}

.page-desc {
  margin: 6px 0 0;
  color: var(--c-text-2);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
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

.scope-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  border: 1px solid var(--c-border-1);
  border-radius: var(--radius-sm);
  background:
    radial-gradient(circle at top right, color-mix(in oklch, var(--c-brand-soft) 70%, white) 0, transparent 38%),
    linear-gradient(135deg, var(--c-surface-1), color-mix(in oklch, var(--c-surface-2) 82%, white));
}

.scope-left,
.scope-tags {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.scope-left > .el-button {
  display: none;
}

.breadcrumb-item {
  cursor: pointer;
}

.summary-grid,
.top-grid,
.pie-grid {
  margin: 0;
}

.metric-card,
.panel-card {
  border-radius: var(--radius-sm);
  border: 1px solid var(--c-border-1);
}

.metric-label {
  color: var(--c-text-2);
  font-size: var(--font-size-sm);
}

.metric-value {
  margin-top: 10px;
  font-size: 30px;
  font-weight: 700;
  color: var(--c-text-1);
}

.metric-note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.metric-note-text,
.metric-extra {
  color: var(--c-text-3);
  font-size: var(--font-size-sm);
}

.metric-extra {
  margin-top: 8px;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.panel-title {
  font-size: var(--font-size-md);
  font-weight: 650;
  color: var(--c-text-1);
}

.panel-subtitle {
  margin-top: 4px;
  color: var(--c-text-3);
  font-size: var(--font-size-sm);
}

.market-panel {
  padding-bottom: 4px;
}

.market-alert {
  margin-bottom: 16px;
}

.market-chart-card {
  min-height: 100%;
  border: 1px solid var(--c-border-1);
  border-radius: var(--radius-sm);
  background: linear-gradient(180deg, var(--c-surface-1), color-mix(in oklch, var(--c-surface-2) 92%, white));
  overflow: hidden;
}

.market-chart-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 18px 18px;
  color: var(--c-text-2);
  font-size: var(--font-size-sm);
}

.market-chart-meta-label {
  color: var(--c-text-3);
}

.market-browser {
  display: grid;
  gap: 12px;
  margin: 12px 0 16px;
}

.market-browser-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}

.market-browser-title {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.market-browser-title {
  align-items: flex-start;
  flex-direction: column;
}

.market-browser-actions {
  display: flex;
  flex-basis: 100%;
  align-items: center;
  justify-content: flex-start;
}

.market-browser-actions > .el-button + .el-button,
.table-toolbar-actions > .el-button {
  display: none;
}

.market-browser-controls {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.market-category-select {
  width: min(360px, 100%);
}

.market-search {
  width: min(360px, 100%);
}

.market-table {
  margin-bottom: 8px;
}

.market-empty {
  margin-bottom: 8px;
}

.chart-box {
  width: 100%;
  height: 320px;
}

.trend-chart {
  height: 360px;
}

.insights-card {
  height: 100%;
}

.insight-list {
  display: grid;
  gap: 12px;
}

.insight-item {
  display: grid;
  grid-template-columns: 36px 1fr;
  gap: 12px;
  padding: 12px;
  border-radius: var(--radius-sm);
  background: var(--c-surface-2);
}

.insight-item p {
  margin: 0;
  color: var(--c-text-2);
  line-height: 1.5;
}

.insight-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--c-brand) 14%, white);
  color: var(--c-brand);
  font-weight: 700;
}

.meta-list {
  display: grid;
  gap: 10px;
  margin-top: 16px;
}

.meta-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--c-border-1);
  color: var(--c-text-2);
}

.table-card {
  overflow: hidden;
}

.table-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.table-toolbar-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.delta-positive {
  color: var(--c-success);
  font-weight: 700;
}

.delta-negative,
.danger {
  color: var(--c-danger);
  font-weight: 700;
}

.delta-flat {
  color: var(--c-text-3);
  font-weight: 700;
}

:deep(.table-header) {
  background: var(--c-surface-2) !important;
  color: var(--c-text-2);
  font-weight: 650;
  font-size: var(--font-size-xs);
}

:deep(.drillable-row) {
  cursor: pointer;
}

:deep(.market-table-row) {
  cursor: pointer;
}

@media (max-width: 768px) {
  .scope-bar {
    padding: 14px 16px;
  }

  .metric-value {
    font-size: 26px;
  }

  .chart-box,
  .trend-chart {
    height: 300px;
  }
}
</style>
