<template>
  <div class="products-container">
    <div class="page-header">
      <div>
        <h2 class="page-title">商品管理</h2>
        <p class="page-subtitle">查看商品基础信息、上传来源和状态，并支持单条或批量维护。</p>
      </div>
    </div>

    <div class="search-section">
      <div class="filter-row">
        <span class="label">搜索</span>
        <el-input v-model="searchQuery.productName" placeholder="商品名称" clearable class="input-item name-input" />
        <el-input v-model="searchQuery.sku" placeholder="SKU" clearable class="input-item" />
        <el-input v-model="searchQuery.articleNo" placeholder="货号" clearable class="input-item" />
        <el-select
          v-model="searchQuery.storeId"
          placeholder="全部店铺"
          class="select-item"
          clearable
          @change="handleStoreChange"
        >
          <el-option v-for="store in stores" :key="store.id" :label="store.store_name" :value="store.id" />
        </el-select>
        <el-select
          v-model="searchQuery.warehouseName"
          placeholder="商品仓库"
          class="select-item"
          clearable
          filterable
        >
          <el-option
            v-for="option in warehouseOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
        <el-button type="primary" :icon="Search" @click="handleSearch(true)">刷新</el-button>
        <el-button :icon="RefreshRight" @click="handleReset">重置</el-button>
        <el-button :icon="Refresh" @click="handleSync" :loading="syncing">从上传任务同步</el-button>
      </div>

      <div class="filter-row">
        <span class="label">分类</span>
        <el-select
          v-model="searchQuery.cat1"
          placeholder="一级类目"
          class="select-item"
          clearable
          @change="handleCategory1Change"
        >
          <el-option v-for="item in cat1Options" :key="item" :label="item" :value="item" />
        </el-select>
        <el-select
          v-model="searchQuery.cat2"
          placeholder="二级类目"
          class="select-item"
          clearable
          @change="handleCategory2Change"
        >
          <el-option v-for="item in cat2Options" :key="item" :label="item" :value="item" />
        </el-select>
        <el-select v-model="searchQuery.cat3" placeholder="三级类目" class="select-item" clearable>
          <el-option v-for="item in cat3Options" :key="item" :label="item" :value="item" />
        </el-select>
        <el-select v-model="searchQuery.source" placeholder="全部来源" class="select-item" clearable>
          <el-option v-for="item in sourceOptions" :key="item" :label="item" :value="item" />
        </el-select>
      </div>

      <div class="filter-row">
        <span class="label">范围</span>
        <el-input v-model="searchQuery.priceMin" placeholder="最低价" class="range-input" />
        <span>-</span>
        <el-input v-model="searchQuery.priceMax" placeholder="最高价" class="range-input" />
        <el-input v-model="searchQuery.stockMin" placeholder="最小库存" class="range-input" />
        <span>-</span>
        <el-input v-model="searchQuery.stockMax" placeholder="最大库存" class="range-input" />
        <el-input v-model="searchQuery.weightMin" placeholder="最小重量(g)" class="range-input wide" />
        <span>-</span>
        <el-input v-model="searchQuery.weightMax" placeholder="最大重量(g)" class="range-input wide" />
      </div>

      <div class="action-row">
        <span class="label">状态</span>
        <el-radio-group v-model="currentStatus" @change="handleStatusChange">
          <el-radio-button label="all">全部</el-radio-button>
          <el-radio-button label="approved">正常</el-radio-button>
          <el-radio-button label="rejected">失败</el-radio-button>
          <el-radio-button label="archived">已归档</el-radio-button>
        </el-radio-group>
      </div>

      <div class="action-row">
        <span class="label">批量</span>
        <div class="batch-buttons">
          <el-button type="primary" @click="handleBatchPrice">改价</el-button>
          <el-button type="primary" @click="handleBatchStock">改库存</el-button>
          <el-button type="primary" @click="handleBatchRemark">备注</el-button>
          <el-button @click="handleBatchArchive(true)">归档</el-button>
          <el-button @click="handleBatchArchive(false)">取消归档</el-button>
          <el-button @click="handleBatchRetry">重试</el-button>
        </div>
      </div>
    </div>

    <div class="table-section">
      <el-table
        :data="tableData"
        style="width: 100%"
        border
        v-loading="loading"
        @selection-change="handleSelectionChange"
        header-cell-class-name="table-header"
      >
        <el-table-column type="selection" width="55" />
        <el-table-column label="图片" width="90">
          <template #default="{ row }">
            <el-image
              v-if="row.primary_image"
              :src="row.primary_image"
              fit="cover"
              style="width: 46px; height: 46px; border-radius: 8px"
            />
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column prop="product_name" label="商品名称" min-width="220" show-overflow-tooltip />
        <el-table-column label="SKU" width="170">
          <template #default="{ row }">
            <a
              v-if="row.sku"
              :href="getSellerProductSearchUrl(row.sku)"
              target="_blank"
              rel="noopener noreferrer"
              class="sku-link"
            >
              {{ row.sku }}
            </a>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column prop="article_no" label="货号" width="120" />
        <el-table-column prop="warehouse_name" label="商品仓库" width="180" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.warehouse_name || '-' }}
          </template>
        </el-table-column>
        <el-table-column prop="price" label="售价" width="90" />
        <el-table-column prop="display_price" label="划线价" width="90" />
        <el-table-column prop="profit" label="利润" width="90" />
        <el-table-column prop="stock" label="库存" width="80" />
        <el-table-column prop="backup_stock" label="备份库存" width="100" />
        <el-table-column label="类目" min-width="200">
          <template #default="{ row }">
            {{ [row.category_level_1, row.category_level_2, row.category_level_3].filter(Boolean).join(' / ') || '-' }}
          </template>
        </el-table-column>
        <el-table-column prop="source" label="来源" width="110">
          <template #default="{ row }">
            <el-tag effect="plain">{{ row.source || '-' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="getProductStatusTagType(row.status)">{{ getProductStatusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip />
        <el-table-column prop="store_name" label="店铺" width="120" />
        <el-table-column prop="updated_at" label="更新时间" width="180">
          <template #default="{ row }">
            {{ formatDate(row.updated_at) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="{ row }">
            <div class="op-links">
              <el-button link type="primary" @click="openDetail(row)">详情</el-button>
              <el-button link type="primary" @click="handleSinglePrice(row)">改价</el-button>
              <el-button link type="primary" @click="handleSingleStock(row)">库存</el-button>
              <el-button link type="primary" @click="handleSingleRemark(row)">备注</el-button>
              <el-button link @click="handleSingleArchive(row, !row.archived)">
                {{ row.archived ? '恢复' : '归档' }}
              </el-button>
              <el-button v-if="row.status === 'rejected'" link type="warning" @click="handleSingleRetry(row)">
                重试
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="pagination-section">
      <el-pagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :page-sizes="[15, 30, 50, 100]"
        layout="sizes, total, prev, pager, next, jumper"
        :total="total"
        @size-change="handleSearch"
        @current-change="handleSearch"
      />
    </div>

    <el-drawer v-model="detailVisible" title="商品详情" size="720px">
      <div v-if="detailRow" class="detail-drawer" v-loading="detailLoading">
        <div class="detail-hero">
          <el-image
            v-if="detailRow.primary_image"
            :src="detailRow.primary_image"
            fit="cover"
            class="detail-image"
          />
          <div v-else class="detail-image detail-image-placeholder">无图</div>
          <div class="detail-main">
            <h3>{{ detailRow.product_name }}</h3>
            <div class="detail-tags">
              <el-tag>{{ detailRow.store_name || '-' }}</el-tag>
              <el-tag effect="plain">{{ detailRow.source || '-' }}</el-tag>
              <el-tag :type="getProductStatusTagType(detailRow.status)">
                {{ getProductStatusLabel(detailRow.status) }}
              </el-tag>
            </div>
            <div class="detail-summary">
              <span>Offer ID: {{ detailRow.offer_id || '-' }}</span>
              <span>
                SKU:
                <a
                  v-if="detailRow.sku"
                  :href="getSellerProductSearchUrl(detailRow.sku)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="sku-link"
                >
                  {{ detailRow.sku }}
                </a>
                <template v-else>-</template>
              </span>
              <span>上传任务: {{ detailRow.upload_job_id || '-' }}</span>
            </div>
          </div>
        </div>

        <div class="detail-block">
          <h4>基础信息</h4>
          <el-descriptions :column="2" border>
            <el-descriptions-item label="货号">{{ detailRow.article_no || '-' }}</el-descriptions-item>
            <el-descriptions-item label="国家">{{ detailRow.country || '-' }}</el-descriptions-item>
            <el-descriptions-item label="售价">{{ detailRow.price }}</el-descriptions-item>
            <el-descriptions-item label="划线价">{{ detailRow.display_price }}</el-descriptions-item>
            <el-descriptions-item label="利润">{{ detailRow.profit }}</el-descriptions-item>
            <el-descriptions-item label="库存">{{ detailRow.stock }}</el-descriptions-item>
            <el-descriptions-item label="商品仓库">{{ detailRow.warehouse_name || '-' }}</el-descriptions-item>
            <el-descriptions-item label="备份库存">{{ detailRow.backup_stock }}</el-descriptions-item>
            <el-descriptions-item label="重量(g)">{{ detailRow.weight_g }}</el-descriptions-item>
            <el-descriptions-item label="尺寸(mm)">{{ formatDimensions(detailRow) }}</el-descriptions-item>
            <el-descriptions-item label="更新时间">{{ formatDate(detailRow.updated_at) }}</el-descriptions-item>
            <el-descriptions-item label="类目" :span="2">
              {{ [detailRow.category_level_1, detailRow.category_level_2, detailRow.category_level_3].filter(Boolean).join(' / ') || '-' }}
            </el-descriptions-item>
            <el-descriptions-item label="备注" :span="2">{{ detailRow.remark || '-' }}</el-descriptions-item>
            <el-descriptions-item label="商品说明" :span="2">
              <div class="plain-text">{{ detailRow.info || '暂无说明' }}</div>
            </el-descriptions-item>
          </el-descriptions>
        </div>

        <div class="detail-block">
          <div class="block-header">
            <h4>市场分析</h4>
            <div class="block-actions">
              <el-radio-group v-model="marketInsightsPeriod" size="small">
                <el-radio-button label="weekly">近7天</el-radio-button>
                <el-radio-button label="monthly">近28天</el-radio-button>
              </el-radio-group>
              <el-button @click="handleRefreshMarketInsights" :loading="marketInsightsLoading">
                刷新数据
              </el-button>
            </div>
          </div>

          <div class="market-block" v-loading="marketInsightsLoading">
            <template v-if="marketInsightItem">
              <div class="detail-tags market-tags">
                <el-tag v-if="marketInsightItem.seller_name">{{ marketInsightItem.seller_name }}</el-tag>
                <el-tag v-if="marketInsightItem.brand" effect="plain">{{ marketInsightItem.brand }}</el-tag>
                <el-tag v-if="marketInsightItem.bin" type="warning" effect="plain">BIN {{ marketInsightItem.bin }}</el-tag>
                <el-tag v-if="marketInsightItem.sales_schema" type="success" effect="plain">
                  {{ marketInsightItem.sales_schema }}
                </el-tag>
                <el-tag effect="plain">{{ marketPeriodLabel }}</el-tag>
              </div>

              <div class="market-meta">
                <span>匹配方式: {{ marketInsights?.matched_by || '-' }}</span>
                <span>更新时间: {{ formatDate(marketInsights?.update_date) }}</span>
                <span>候选数: {{ marketInsights?.query?.candidate_count ?? 0 }}</span>
              </div>

              <el-descriptions :column="2" border>
                <el-descriptions-item label="销售额">{{ formatMetricAmount(marketInsightItem.sold_sum) }}</el-descriptions-item>
                <el-descriptions-item label="销量">{{ formatMetricNumber(marketInsightItem.sold_count) }}</el-descriptions-item>
                <el-descriptions-item label="销售动态">{{ formatMetricPercent(marketInsightItem.sales_dynamics) }}</el-descriptions-item>
                <el-descriptions-item label="平均价格">{{ formatMetricAmount(marketInsightItem.avg_price) }}</el-descriptions-item>
                <el-descriptions-item label="最低卖家价">{{ formatMetricAmount(marketInsightItem.min_seller_price) }}</el-descriptions-item>
                <el-descriptions-item label="DRR">{{ formatMetricPercent(marketInsightItem.drr) }}</el-descriptions-item>
                <el-descriptions-item label="总会话">{{ formatMetricNumber(marketInsightItem.session_count) }}</el-descriptions-item>
                <el-descriptions-item label="搜索会话">{{ formatMetricNumber(marketInsightItem.session_count_search) }}</el-descriptions-item>
                <el-descriptions-item label="PDP 浏览">{{ formatMetricNumber(marketInsightItem.qty_view_pdp) }}</el-descriptions-item>
                <el-descriptions-item label="浏览量">{{ formatMetricNumber(marketInsightItem.views) }}</el-descriptions-item>
                <el-descriptions-item label="PDP 加购转化">{{ formatMetricPercent(marketInsightItem.conv_to_cart_pdp) }}</el-descriptions-item>
                <el-descriptions-item label="搜索加购转化">{{ formatMetricPercent(marketInsightItem.conv_to_cart_search) }}</el-descriptions-item>
                <el-descriptions-item label="浏览转订单">{{ formatMetricPercent(marketInsightItem.conv_view_to_order) }}</el-descriptions-item>
                <el-descriptions-item label="总库存">{{ formatMetricNumber(marketInsightItem.stock) }}</el-descriptions-item>
                <el-descriptions-item label="FBS 库存">{{ formatMetricNumber(marketInsightItem.fbs_stock) }}</el-descriptions-item>
                <el-descriptions-item label="FBO 库存">{{ formatMetricNumber(marketInsightItem.fbo_stock) }}</el-descriptions-item>
                <el-descriptions-item label="促销收入占比">{{ formatMetricPercent(marketInsightItem.promo_revenue_share) }}</el-descriptions-item>
                <el-descriptions-item label="促销天数">{{ formatMetricNumber(marketInsightItem.days_in_promo) }}</el-descriptions-item>
                <el-descriptions-item label="广告天数">{{ formatMetricNumber(marketInsightItem.days_with_trafarets) }}</el-descriptions-item>
                <el-descriptions-item label="平均配送时长">{{ formatMetricAmount(marketInsightItem.avg_delivery_time) }}</el-descriptions-item>
                <el-descriptions-item label="创建时间">{{ formatDate(marketInsightItem.nullable_create_date) }}</el-descriptions-item>
                <el-descriptions-item label="商品链接" :span="2">
                  <a
                    v-if="marketInsightItem.link"
                    :href="marketInsightItem.link"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="sku-link market-link"
                  >
                    {{ marketInsightItem.link }}
                  </a>
                  <template v-else>-</template>
                </el-descriptions-item>
              </el-descriptions>
            </template>

            <el-alert
              v-else-if="marketInsightsError"
              :title="marketInsightsError"
              type="warning"
              show-icon
              :closable="false"
            />

            <el-empty v-else description="暂无市场分析数据" />
          </div>
        </div>

        <div class="detail-block">
          <div class="block-header">
            <h4>上传任务</h4>
            <div class="block-actions">
              <el-button
                v-if="detailRow.upload_job_id"
                @click="loadUploadJobDetail(detailRow.upload_job_id)"
                :loading="detailLoading"
              >
                刷新详情
              </el-button>
              <el-button
                v-if="detailRow.upload_job_id && uploadJobDetail?.ozon_task_id"
                type="primary"
                plain
                @click="handleRefreshUploadJob"
                :loading="refreshingUploadJob"
              >
                刷新任务状态
              </el-button>
            </div>
          </div>

          <el-empty v-if="!detailRow.upload_job_id" description="当前商品没有关联上传任务" />

          <template v-else>
            <el-descriptions v-if="uploadJobDetail" :column="2" border>
              <el-descriptions-item label="任务 ID">{{ uploadJobDetail.id }}</el-descriptions-item>
              <el-descriptions-item label="任务状态">{{ uploadJobDetail.status || '-' }}</el-descriptions-item>
              <el-descriptions-item label="Ozon 任务 ID">{{ uploadJobDetail.ozon_task_id || '-' }}</el-descriptions-item>
              <el-descriptions-item label="本地任务 ID">{{ uploadJobDetail.local_task_id || '-' }}</el-descriptions-item>
              <el-descriptions-item label="来源">{{ uploadJobDetail.source || '-' }}</el-descriptions-item>
              <el-descriptions-item label="商品数">{{ uploadJobDetail.item_count || 0 }}</el-descriptions-item>
              <el-descriptions-item label="创建时间">{{ formatDate(uploadJobDetail.created_at) }}</el-descriptions-item>
              <el-descriptions-item label="更新时间">{{ formatDate(uploadJobDetail.updated_at) }}</el-descriptions-item>
              <el-descriptions-item label="错误信息" :span="2">
                {{ uploadJobDetail.error || '-' }}
              </el-descriptions-item>
            </el-descriptions>

            <div v-if="uploadJobDetail" class="json-grid">
              <div class="json-card">
                <div class="json-title">上传请求</div>
                <pre class="json-content">{{ prettyJson(uploadJobDetail.request_payload) }}</pre>
              </div>
              <div class="json-card">
                <div class="json-title">上传结果</div>
                <pre class="json-content">{{ prettyJson(uploadJobDetail.result_payload) }}</pre>
              </div>
            </div>
          </template>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, RefreshRight, Search } from '@element-plus/icons-vue'
import { submitSyncProductsJob } from '../api/jobs'
import {
  batchArchiveProducts,
  batchRemarkProducts,
  batchRetryProducts,
  batchUpdateProductPrice,
  fetchProductMarketInsights,
  batchUpdateProductStock,
  fetchProductFilters,
  fetchProducts,
} from '../api/products'
import { fetchStores } from '../api/store'
import { fetchUploadJob, refreshUploadJob } from '../api/upload'
import { useAsyncJob } from '../composables/useAsyncJob'
import { getSellerProductSearchUrl } from '../utils/ozon'
import { getProductStatusLabel, getProductStatusTagType } from '../utils/productStatus'

const loading = ref(false)
const syncJob = useAsyncJob()
const { running: syncRunning } = syncJob
const syncing = computed(() => syncRunning.value)
const currentPage = ref(1)
const pageSize = ref(15)
const total = ref(0)
const stores = ref<any[]>([])
const tableData = ref<any[]>([])
const selectedRows = ref<any[]>([])
const currentStatus = ref('all')
const detailVisible = ref(false)
const detailLoading = ref(false)
const refreshingUploadJob = ref(false)
const marketInsightsLoading = ref(false)
const detailRow = ref<any | null>(null)
const uploadJobDetail = ref<any | null>(null)
const marketInsights = ref<any | null>(null)
const marketInsightsError = ref('')
const marketInsightsPeriod = ref<'weekly' | 'monthly'>('weekly')
let hasCompletedInitialLoad = false
const filterOptions = ref({
  categories: [] as Array<{ level_1?: string; level_2?: string; level_3?: string }>,
  sources: [] as string[],
})

const searchQuery = ref({
  productName: '',
  sku: '',
  articleNo: '',
  storeId: undefined as number | undefined,
  warehouseName: '',
  source: '',
  cat1: '',
  cat2: '',
  cat3: '',
  priceMin: '',
  priceMax: '',
  stockMin: '',
  stockMax: '',
  weightMin: '',
  weightMax: '',
})

const categoryRows = computed(() => filterOptions.value.categories || [])

const parseWarehouseNames = (value?: string | null) => {
  if (!value) return []
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

const warehouseOptions = computed(() => {
  const optionMap = new Map<string, { label: string; value: string }>()
  const scopedStores = searchQuery.value.storeId
    ? stores.value.filter((store) => store.id === searchQuery.value.storeId)
    : stores.value

  for (const store of scopedStores) {
    for (const name of parseWarehouseNames(store.warehouse_info)) {
      optionMap.set(name, { label: name, value: name })
    }
  }

  for (const row of tableData.value) {
    if (searchQuery.value.storeId && row.store_id !== searchQuery.value.storeId) {
      continue
    }
    const warehouseName = row.warehouse_name?.trim()
    if (warehouseName) {
      optionMap.set(warehouseName, { label: warehouseName, value: warehouseName })
    }
  }

  return Array.from(optionMap.values())
})

const cat1Options = computed(() =>
  Array.from(new Set(categoryRows.value.map((item) => item.level_1).filter(Boolean))).sort()
)

const cat2Options = computed(() =>
  Array.from(
    new Set(
      categoryRows.value
        .filter((item) => !searchQuery.value.cat1 || item.level_1 === searchQuery.value.cat1)
        .map((item) => item.level_2)
        .filter(Boolean)
    )
  ).sort()
)

const cat3Options = computed(() =>
  Array.from(
    new Set(
      categoryRows.value
        .filter((item) => !searchQuery.value.cat1 || item.level_1 === searchQuery.value.cat1)
        .filter((item) => !searchQuery.value.cat2 || item.level_2 === searchQuery.value.cat2)
        .map((item) => item.level_3)
        .filter(Boolean)
    )
  ).sort()
)

const sourceOptions = computed(() => filterOptions.value.sources || [])
const marketInsightItem = computed(() => marketInsights.value?.item || null)
const marketPeriodLabel = computed(() => (marketInsightsPeriod.value === 'weekly' ? '近7天' : '近28天'))
let suspendMarketPeriodWatch = false

const formatDate = (value: string) => {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return value
  }
}

const formatMetricNumber = (value: any, digits = 0) => {
  if (value === null || value === undefined || value === '') return '-'
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) return String(value)
  return numericValue.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

const formatMetricAmount = (value: any) => formatMetricNumber(value, 2)

const formatMetricPercent = (value: any) => {
  if (value === null || value === undefined || value === '') return '-'
  return `${formatMetricNumber(value, 2)}%`
}

const formatDimensions = (row: any) =>
  [row.length_mm || 0, row.width_mm || 0, row.height_mm || 0]
    .map((item) => Number(item).toFixed(0))
    .join(' / ')

const prettyJson = (value: any) => {
  if (!value) return '暂无数据'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const loadStores = async () => {
  stores.value = await fetchStores()
}

const loadProductFilters = async () => {
  const data = await fetchProductFilters(searchQuery.value.storeId)
  filterOptions.value = {
    categories: data.categories || [],
    sources: data.sources || [],
  }
  if (searchQuery.value.source && !filterOptions.value.sources.includes(searchQuery.value.source)) {
    searchQuery.value.source = ''
  }
}

const handleSelectionChange = (rows: any[]) => {
  selectedRows.value = rows
}

const selectedIds = () => selectedRows.value.map((row) => row.id)

const buildParams = () => ({
  product_name: searchQuery.value.productName || undefined,
  sku: searchQuery.value.sku || undefined,
  article_no: searchQuery.value.articleNo || undefined,
  source: searchQuery.value.source || undefined,
  warehouse_name: searchQuery.value.warehouseName || undefined,
  cat1: searchQuery.value.cat1 || undefined,
  cat2: searchQuery.value.cat2 || undefined,
  cat3: searchQuery.value.cat3 || undefined,
  price_min: searchQuery.value.priceMin || undefined,
  price_max: searchQuery.value.priceMax || undefined,
  stock_min: searchQuery.value.stockMin || undefined,
  stock_max: searchQuery.value.stockMax || undefined,
  weight_min: searchQuery.value.weightMin || undefined,
  weight_max: searchQuery.value.weightMax || undefined,
  store_id: searchQuery.value.storeId,
  status: currentStatus.value,
  page: currentPage.value,
  page_size: pageSize.value,
})

const syncOpenDetailRow = () => {
  if (!detailRow.value) return
  const updatedRow = tableData.value.find((item) => item.id === detailRow.value.id)
  if (updatedRow) {
    detailRow.value = updatedRow
  }
}

const handleSearch = async (forceRefresh = false, options: { background?: boolean } = {}) => {
  const shouldForceRefresh = forceRefresh === true
  const showLoading = !options.background && (shouldForceRefresh || tableData.value.length === 0)
  if (showLoading) {
    loading.value = true
  }
  try {
    const data = await fetchProducts(buildParams(), { forceRefresh: shouldForceRefresh })
    tableData.value = data.result || []
    total.value = data.total || 0
    syncOpenDetailRow()
  } catch (error: any) {
    ElMessage.error(error.response?.data?.detail || '查询商品失败')
  } finally {
    if (showLoading) {
      loading.value = false
    }
  }
}

const handleReset = async () => {
  searchQuery.value = {
    productName: '',
    sku: '',
    articleNo: '',
    storeId: undefined,
    warehouseName: '',
    source: '',
    cat1: '',
    cat2: '',
    cat3: '',
    priceMin: '',
    priceMax: '',
    stockMin: '',
    stockMax: '',
    weightMin: '',
    weightMax: '',
  }
  currentStatus.value = 'all'
  currentPage.value = 1
  await loadProductFilters()
  await handleSearch()
}

const handleCategory1Change = () => {
  searchQuery.value.cat2 = ''
  searchQuery.value.cat3 = ''
}

const handleCategory2Change = () => {
  searchQuery.value.cat3 = ''
}

const handleStoreChange = async () => {
  searchQuery.value.cat1 = ''
  searchQuery.value.cat2 = ''
  searchQuery.value.cat3 = ''
  searchQuery.value.source = ''
  searchQuery.value.warehouseName = ''
  currentPage.value = 1
  await loadProductFilters()
}

const handleStatusChange = async () => {
  currentPage.value = 1
  await handleSearch()
}

const ensureSelected = () => {
  if (!selectedRows.value.length) {
    ElMessage.warning('请先选择商品')
    return false
  }
  return true
}

const ensureStockWarehouse = (rows: any[]) => {
  const warehouseName = searchQuery.value.warehouseName.trim()
  if (!warehouseName) {
    ElMessage.warning('修改库存前请先选择商品仓库')
    return null
  }
  const mismatched = rows.some((row) => (row.warehouse_name || '').trim() !== warehouseName)
  if (mismatched) {
    ElMessage.warning('当前选中的商品与已选仓库不一致，请先按仓库筛选后再修改库存')
    return null
  }
  return warehouseName
}

const promptPrice = async (ids: number[], initialValue?: number) => {
  try {
    const { value } = await ElMessageBox.prompt('输入新的售价', '商品改价', {
      inputValue: initialValue != null ? String(initialValue) : '',
      inputPattern: /^\d+(\.\d+)?$/,
      inputErrorMessage: '请输入合法金额',
    })
    await batchUpdateProductPrice({ ids, price: Number(value) })
    ElMessage.success('改价完成')
    await handleSearch()
  } catch {
    // user cancelled
  }
}

const promptStock = async (rows: any[], initialValue?: number) => {
  const warehouseName = ensureStockWarehouse(rows)
  if (!warehouseName) return
  try {
    const { value } = await ElMessageBox.prompt('输入新的库存', '库存更新', {
      inputValue: initialValue != null ? String(initialValue) : '',
      inputPattern: /^\d+$/,
      inputErrorMessage: '请输入整数库存',
    })
    await batchUpdateProductStock({
      ids: rows.map((row) => row.id),
      stock: Number(value),
      warehouse_name: warehouseName,
    })
    ElMessage.success('库存更新完成')
    await handleSearch()
  } catch {
    // user cancelled
  }
}

const promptRemark = async (ids: number[], initialValue = '') => {
  try {
    const { value } = await ElMessageBox.prompt('输入备注内容', '商品备注', {
      inputValue: initialValue,
      inputPattern: /^.{1,100}$/,
      inputErrorMessage: '备注不能为空且不能超过 100 个字符',
    })
    await batchRemarkProducts({ ids, remark: value })
    ElMessage.success('备注已更新')
    await handleSearch()
  } catch {
    // user cancelled
  }
}

const handleSync = async () => {
  await syncJob.runJob(
    () =>
      submitSyncProductsJob({
        store_id: searchQuery.value.storeId,
      }),
    {
      successMessage: '商品同步完成',
      onSuccess: async () => {
        await loadProductFilters()
        await handleSearch()
      },
    }
  )
}

const handleBatchPrice = async () => {
  if (!ensureSelected()) return
  await promptPrice(selectedIds())
}

const handleBatchStock = async () => {
  if (!ensureSelected()) return
  await promptStock(selectedRows.value)
}

const handleBatchRemark = async () => {
  if (!ensureSelected()) return
  await promptRemark(selectedIds())
}

const handleBatchArchive = async (archived: boolean) => {
  if (!ensureSelected()) return
  await batchArchiveProducts({ ids: selectedIds(), archived })
  ElMessage.success(archived ? '已归档' : '已取消归档')
  await handleSearch()
}

const handleBatchRetry = async () => {
  if (!ensureSelected()) return
  await batchRetryProducts({ ids: selectedIds() })
  ElMessage.success('已重试选中商品')
  await handleSearch()
}

const handleSinglePrice = async (row: any) => {
  await promptPrice([row.id], row.price)
}

const handleSingleStock = async (row: any) => {
  await promptStock([row], row.stock)
}

const handleSingleRemark = async (row: any) => {
  await promptRemark([row.id], row.remark || '')
}

const handleSingleArchive = async (row: any, archived: boolean) => {
  await batchArchiveProducts({ ids: [row.id], archived })
  ElMessage.success(archived ? '商品已归档' : '商品已恢复')
  await handleSearch()
}

const handleSingleRetry = async (row: any) => {
  await batchRetryProducts({ ids: [row.id] })
  ElMessage.success('商品已重试')
  await handleSearch()
}

const loadUploadJobDetail = async (jobId: number) => {
  detailLoading.value = true
  try {
    uploadJobDetail.value = await fetchUploadJob(jobId)
  } catch (error: any) {
    uploadJobDetail.value = null
    ElMessage.error(error.response?.data?.detail || '加载上传任务详情失败')
  } finally {
    detailLoading.value = false
  }
}

const loadProductMarketInsights = async (productId: number, silent = false) => {
  marketInsightsLoading.value = true
  marketInsightsError.value = ''
  try {
    marketInsights.value = await fetchProductMarketInsights(productId, marketInsightsPeriod.value)
  } catch (error: any) {
    marketInsights.value = null
    marketInsightsError.value = error.response?.data?.detail || '加载市场分析失败'
    if (!silent) {
      ElMessage.error(marketInsightsError.value)
    }
  } finally {
    marketInsightsLoading.value = false
  }
}

const openDetail = async (row: any) => {
  detailRow.value = row
  uploadJobDetail.value = null
  marketInsights.value = null
  marketInsightsError.value = ''
  suspendMarketPeriodWatch = true
  marketInsightsPeriod.value = 'weekly'
  detailVisible.value = true
  const tasks: Promise<any>[] = [loadProductMarketInsights(row.id, true)]
  if (row.upload_job_id) {
    tasks.push(loadUploadJobDetail(row.upload_job_id))
  }
  await Promise.allSettled(tasks)
  suspendMarketPeriodWatch = false
}

const handleRefreshUploadJob = async () => {
  if (!detailRow.value?.upload_job_id) return
  refreshingUploadJob.value = true
  try {
    await refreshUploadJob(detailRow.value.upload_job_id)
    await loadUploadJobDetail(detailRow.value.upload_job_id)
    await handleSearch()
    ElMessage.success('上传任务状态已刷新')
  } catch (error: any) {
    ElMessage.error(error.response?.data?.detail || '刷新任务状态失败')
  } finally {
    refreshingUploadJob.value = false
  }
}

const handleRefreshMarketInsights = async () => {
  if (!detailRow.value?.id) return
  await loadProductMarketInsights(detailRow.value.id)
}

watch(
  () => searchQuery.value.storeId,
  () => {
    searchQuery.value.warehouseName = ''
  }
)

watch(marketInsightsPeriod, async () => {
  if (suspendMarketPeriodWatch) return
  if (!detailVisible.value || !detailRow.value?.id) return
  await loadProductMarketInsights(detailRow.value.id, true)
})

onMounted(async () => {
  await loadStores()
  await loadProductFilters()
  await handleSearch()
  hasCompletedInitialLoad = true
})

onActivated(async () => {
  if (!hasCompletedInitialLoad) {
    return
  }
  if (!tableData.value.length) {
    await loadStores()
    await loadProductFilters()
    await handleSearch()
  }
})
</script>

<style scoped>
.products-container {
  padding: 0;
}

.page-subtitle {
  margin: 8px 0 0;
  color: var(--c-text-3);
  font-size: var(--font-size-sm);
}

.filter-row,
.action-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.action-row:last-child {
  margin-bottom: 0;
}

.label {
  width: 48px;
  color: var(--c-text-2);
  font-weight: 650;
  flex-shrink: 0;
}

.input-item,
.select-item {
  width: 180px;
}

.name-input {
  width: 150px;
}

.range-input {
  width: 110px;
}

.range-input.wide {
  width: 130px;
}

.batch-buttons {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.op-links {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  line-height: 1.2;
}

.sku-link {
  color: var(--el-color-primary);
  text-decoration: none;
}

.sku-link:hover {
  text-decoration: underline;
}

.detail-drawer {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.detail-hero {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.detail-image {
  width: 110px;
  height: 110px;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
}

.detail-image-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--c-surface-2);
  color: var(--c-text-3);
}

.detail-main {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.detail-main h3 {
  margin: 0;
  font-size: 20px;
  color: var(--c-text-1);
}

.detail-tags,
.detail-summary,
.block-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.detail-summary {
  color: var(--c-text-2);
  font-size: var(--font-size-sm);
}

.detail-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.detail-block h4 {
  margin: 0;
  font-size: 15px;
  color: var(--c-text-1);
}

.block-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.market-block {
  min-height: 96px;
}

.market-tags {
  margin-bottom: 4px;
}

.market-meta {
  display: flex;
  gap: 10px 18px;
  flex-wrap: wrap;
  color: var(--c-text-2);
  font-size: var(--font-size-sm);
}

.market-link {
  word-break: break-all;
}

.plain-text {
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--c-text-2);
  line-height: 1.7;
}

.json-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
}

.json-card {
  border: 1px solid var(--c-border-1);
  border-radius: 12px;
  background: var(--c-surface-2);
  overflow: hidden;
}

.json-title {
  padding: 10px 12px;
  border-bottom: 1px solid var(--c-border-1);
  font-weight: 650;
  color: var(--c-text-1);
}

.json-content {
  margin: 0;
  padding: 12px;
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--c-text-2);
  font-size: 12px;
  line-height: 1.6;
}

:deep(.table-header) {
  background: var(--c-surface-2) !important;
  color: var(--c-text-2);
  font-weight: 650;
  font-size: var(--font-size-xs);
}
</style>
