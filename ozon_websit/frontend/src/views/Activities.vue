<template>
  <div class="activities-container">
    <div class="page-header">
      <h2 class="page-title">活动管理</h2>
    </div>

    <div class="search-section toolbar-panel">
      <div class="filter-row filter-row-wrap">
        <span class="label">选择店铺</span>
        <el-select
          v-model="selectedStoreId"
          placeholder="请选择店铺"
          style="width: 260px"
          @change="handleStoreChange"
        >
          <el-option
            v-for="store in stores"
            :key="store.id"
            :label="`${store.store_name} (ID:${store.id})`"
            :value="store.id"
          />
        </el-select>
        <el-button type="primary" :loading="loadingActions" @click="loadActions(true)">刷新活动列表</el-button>
      </div>

      <div class="summary-strip">
        <div class="summary-pill">
          <span class="summary-label">当前店铺</span>
          <strong class="summary-value">{{ currentStoreName }}</strong>
        </div>
        <div class="summary-pill">
          <span class="summary-label">活动数量</span>
          <strong class="summary-value">{{ actions.length }}</strong>
        </div>
      </div>
    </div>

    <div class="search-section">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="候选商品" name="candidates">
          <div class="filter-panel">
            <div class="filter-row filter-row-wrap">
              <span class="label">选择活动</span>
              <el-select
                v-model="selectedActionId"
                placeholder="请选择具体活动"
                style="width: 420px"
              >
                <el-option
                  v-for="action in actions"
                  :key="action.id"
                  :label="`${action.id} - ${action.title}`"
                  :value="action.id"
                />
              </el-select>
              <el-button type="primary" :loading="loadingCandidates" @click="loadCandidates(selectedActionId || 0)">
                查询候选商品
              </el-button>
              <el-button :loading="loadingCandidates" @click="loadAllCandidates">全部活动</el-button>
            </div>

            <div class="filter-row filter-row-wrap">
              <span class="label">加入模式</span>
              <el-radio-group v-model="candidateFilters.addMode">
                <el-radio-button label="all">全部</el-radio-button>
                <el-radio-button label="auto">自动加入</el-radio-button>
                <el-radio-button label="manual">手动加入</el-radio-button>
                <el-radio-button label="unset">未设置</el-radio-button>
              </el-radio-group>
              <el-switch
                v-model="candidateFilters.onlyBelowMin"
                active-text="仅看低于最低价"
                inactive-text="显示全部价格"
              />
            </div>

            <div class="summary-strip">
              <div class="summary-pill">
                <span class="summary-label">加载结果</span>
                <strong class="summary-value">{{ candidates.length }}</strong>
              </div>
              <div class="summary-pill">
                <span class="summary-label">筛选后</span>
                <strong class="summary-value">{{ filteredCandidates.length }}</strong>
              </div>
              <div class="summary-pill summary-pill-danger">
                <span class="summary-label">低于最低价</span>
                <strong class="summary-value">{{ candidateLowPriceCount }}</strong>
              </div>
            </div>
          </div>

          <el-table
            :data="filteredCandidates"
            :row-key="getRowKey"
            border
            v-loading="loadingCandidates"
            empty-text="暂无候选商品"
            style="width: 100%"
          >
            <el-table-column prop="action_title" label="活动名称" min-width="180" show-overflow-tooltip />
            <el-table-column label="商品图片" width="92">
              <template #default="{ row }">
                <el-image
                  v-if="row.image"
                  :src="row.image"
                  style="width: 52px; height: 52px; border-radius: 8px"
                  fit="cover"
                />
                <span v-else>-</span>
              </template>
            </el-table-column>
            <el-table-column prop="name" label="商品名称" min-width="220" show-overflow-tooltip />
            <el-table-column label="SKU / offer_id" width="200">
              <template #default="{ row }">
                <div class="sku-block">
                  <a
                    v-if="row.sku"
                    :href="getBuyerProductUrl(row.sku)"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {{ row.sku }}
                  </a>
                  <span v-else>-</span>
                  <span v-if="row.offer_id && row.offer_id !== row.sku" class="offer-id">
                    {{ row.offer_id }}
                  </span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="原价" width="110">
              <template #default="{ row }">{{ formatMoney(row.price) }}</template>
            </el-table-column>
            <el-table-column label="活动价" width="110">
              <template #default="{ row }">
                <span :class="{ 'price-danger': row.below_min_price }">
                  {{ formatMoney(row.action_price) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="最低价" width="110">
              <template #default="{ row }">
                <span>{{ formatMoney(row.local_min_price) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="最大活动价" width="120">
              <template #default="{ row }">{{ formatMoney(row.max_action_price) }}</template>
            </el-table-column>
            <el-table-column label="加入模式" width="120">
              <template #default="{ row }">
                <el-tag size="small" :type="getAddModeTagType(row)">
                  {{ row.add_mode_label || translateAddMode(row.add_mode) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="stock" label="活动库存" width="100" />
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="参与商品" name="participating">
          <div class="filter-panel">
            <div class="filter-row filter-row-wrap">
              <span class="label">选择活动</span>
              <el-select
                v-model="selectedActionId"
                placeholder="请选择具体活动"
                style="width: 420px"
              >
                <el-option
                  v-for="action in actions"
                  :key="action.id"
                  :label="`${action.id} - ${action.title}`"
                  :value="action.id"
                />
              </el-select>
              <el-button
                type="primary"
                :loading="loadingParticipating"
                @click="loadParticipating(selectedActionId || 0)"
              >
                查询参与商品
              </el-button>
              <el-button :loading="loadingParticipating" @click="loadAllParticipating">全部活动</el-button>
              <el-button
                type="danger"
                plain
                :loading="batchDeactivatingSelected"
                :disabled="!selectedParticipatingRows.length"
                @click="handleBatchDeactivateSelected"
              >
                批量退出勾选商品
              </el-button>
              <el-button
                type="danger"
                plain
                :loading="batchDeactivatingAuto"
                :disabled="!participatingAutoAddedRows.length"
                @click="handleDeactivateAllAutoAdded"
              >
                一键退出所有自动加入
              </el-button>
              <el-button
                type="danger"
                plain
                :loading="batchRemovingLowPrice"
                :disabled="!participatingLowPriceRows.length"
                @click="handleBatchRemoveLowPrice"
              >
                一键剔除低于最低价商品
              </el-button>
            </div>

            <div class="filter-row filter-row-wrap">
              <span class="label">加入模式</span>
              <el-radio-group v-model="participatingFilters.addMode">
                <el-radio-button label="all">全部</el-radio-button>
                <el-radio-button label="auto">自动加入</el-radio-button>
                <el-radio-button label="manual">手动加入</el-radio-button>
                <el-radio-button label="unset">未设置</el-radio-button>
              </el-radio-group>
              <el-switch
                v-model="participatingFilters.onlyBelowMin"
                active-text="仅看低于最低价"
                inactive-text="显示全部价格"
              />
            </div>

            <div class="summary-strip">
              <div class="summary-pill">
                <span class="summary-label">加载结果</span>
                <strong class="summary-value">{{ participating.length }}</strong>
              </div>
              <div class="summary-pill">
                <span class="summary-label">筛选后</span>
                <strong class="summary-value">{{ filteredParticipating.length }}</strong>
              </div>
              <div class="summary-pill summary-pill-danger">
                <span class="summary-label">低于最低价</span>
                <strong class="summary-value">{{ participatingLowPriceRows.length }}</strong>
              </div>
            </div>
          </div>

          <el-table
            ref="participatingTableRef"
            :data="filteredParticipating"
            :row-key="getRowKey"
            border
            v-loading="loadingParticipating"
            empty-text="暂无参与商品"
            style="width: 100%"
            @selection-change="handleParticipatingSelectionChange"
          >
            <el-table-column type="selection" width="48" reserve-selection />
            <el-table-column prop="action_title" label="活动名称" min-width="180" show-overflow-tooltip />
            <el-table-column label="商品图片" width="92">
              <template #default="{ row }">
                <el-image
                  v-if="row.image"
                  :src="row.image"
                  style="width: 52px; height: 52px; border-radius: 8px"
                  fit="cover"
                />
                <span v-else>-</span>
              </template>
            </el-table-column>
            <el-table-column prop="name" label="商品名称" min-width="220" show-overflow-tooltip />
            <el-table-column label="SKU / offer_id" width="200">
              <template #default="{ row }">
                <div class="sku-block">
                  <a
                    v-if="row.sku"
                    :href="getBuyerProductUrl(row.sku)"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {{ row.sku }}
                  </a>
                  <span v-else>-</span>
                  <span v-if="row.offer_id && row.offer_id !== row.sku" class="offer-id">
                    {{ row.offer_id }}
                  </span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="原价" width="110">
              <template #default="{ row }">{{ formatMoney(row.price) }}</template>
            </el-table-column>
            <el-table-column label="活动价" width="110">
              <template #default="{ row }">
                <span :class="{ 'price-danger': row.below_min_price }">
                  {{ formatMoney(row.action_price) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="最低价" width="110">
              <template #default="{ row }">{{ formatMoney(row.local_min_price) }}</template>
            </el-table-column>
            <el-table-column label="最大活动价" width="120">
              <template #default="{ row }">{{ formatMoney(row.max_action_price) }}</template>
            </el-table-column>
            <el-table-column label="加入模式" width="120">
              <template #default="{ row }">
                <el-tag size="small" :type="getAddModeTagType(row)">
                  {{ row.add_mode_label || translateAddMode(row.add_mode) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="stock" label="活动库存" width="100" />
            <el-table-column label="操作" width="120" fixed="right">
              <template #default="{ row }">
                <el-button
                  link
                  type="danger"
                  :disabled="!row.activity_product_id || !row.action_id"
                  :loading="isRowBusy(row)"
                  @click="handleQuickDeactivate(row)"
                >
                  快捷退出
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { fetchStores } from '../api/store'
import {
  deactivateProducts,
  getActions,
  getCandidates,
  getParticipating,
} from '../api/activities'
import { getAuthUser } from '../utils/auth'

type LoadScope = 'selected' | 'all'
type AddModeFilter = 'all' | 'auto' | 'manual' | 'unset'

const ACTIVITIES_AUTO_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
const ACTIVITIES_AUTO_REFRESH_AT_PREFIX = 'ozon_activities_auto_refresh_at:v1:'

interface ActivityAction {
  id: number
  title: string
  potential_products_count?: number
  participating_products_count?: number
}

interface ActivityProduct {
  action_id?: number | null
  action_title?: string
  activity_product_id?: number | null
  sku?: string
  offer_id?: string
  name?: string
  image?: string
  price?: number | null
  action_price?: number | null
  max_action_price?: number | null
  local_min_price?: number | null
  add_mode?: string
  add_mode_label?: string
  below_min_price?: boolean
  stock?: number | null
}

interface FilterState {
  addMode: AddModeFilter
  onlyBelowMin: boolean
}

const stores = ref<any[]>([])
const selectedStoreId = ref<number | undefined>(undefined)

const loadingActions = ref(false)
const loadingCandidates = ref(false)
const loadingParticipating = ref(false)
const batchRemovingLowPrice = ref(false)
const batchDeactivatingSelected = ref(false)
const batchDeactivatingAuto = ref(false)

const actions = ref<ActivityAction[]>([])
const candidates = ref<ActivityProduct[]>([])
const participating = ref<ActivityProduct[]>([])

const activeTab = ref('candidates')
const selectedActionId = ref<number | undefined>(undefined)
const candidatesScope = ref<LoadScope>('selected')
const participatingScope = ref<LoadScope>('selected')
const busyRowKeys = ref<string[]>([])
const selectedParticipatingRows = ref<ActivityProduct[]>([])
const participatingTableRef = ref<{ clearSelection?: () => void } | null>(null)
let hasCompletedInitialLoad = false

const candidateFilters = reactive<FilterState>({
  addMode: 'all',
  onlyBelowMin: false,
})

const participatingFilters = reactive<FilterState>({
  addMode: 'all',
  onlyBelowMin: false,
})

const currentStoreName = computed(() => {
  const currentStore = stores.value.find((store) => store.id === selectedStoreId.value)
  return currentStore?.store_name || '-'
})

const resolveActivitiesOwnerKey = () => {
  const username = (getAuthUser()?.username || 'anonymous').trim().toLowerCase()
  return username || 'anonymous'
}

const resolveActivitiesAutoRefreshKey = (storeId: number) =>
  `${ACTIVITIES_AUTO_REFRESH_AT_PREFIX}${resolveActivitiesOwnerKey()}:${storeId}`

const readActivitiesLastAutoRefreshAt = (storeId: number) => {
  if (typeof window === 'undefined') return 0
  try {
    const raw = localStorage.getItem(resolveActivitiesAutoRefreshKey(storeId))
    const numeric = Number(raw || 0)
    return Number.isFinite(numeric) ? numeric : 0
  } catch {
    return 0
  }
}

const markActivitiesAutoRefreshed = (storeId: number) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(resolveActivitiesAutoRefreshKey(storeId), String(Date.now()))
  } catch {
    // ignore storage failures
  }
}

const shouldAutoRefreshActivitiesOnTabOpen = (storeId: number) =>
  Date.now() - readActivitiesLastAutoRefreshAt(storeId) >= ACTIVITIES_AUTO_REFRESH_INTERVAL_MS

const ensureOk = (resp: any, fallbackMessage: string) => {
  if (!resp?.ok) {
    throw new Error(resp?.error || fallbackMessage)
  }
}

const extractActions = (resp: any): ActivityAction[] => {
  const list = resp?.data?.result
  return Array.isArray(list) ? list : []
}

const extractProducts = (resp: any): ActivityProduct[] => {
  const list = resp?.data?.result?.products
  return Array.isArray(list) ? list : []
}

const extractTotal = (resp: any, fallback: number) => {
  const total = Number(resp?.data?.result?.total)
  return Number.isFinite(total) ? total : fallback
}

const isUnsetAddMode = (value?: string) => {
  const upperValue = String(value || '').toUpperCase()
  return !upperValue || upperValue === 'NOT_SET' || upperValue === 'UNKNOWN'
}

const translateAddMode = (value?: string) => {
  const upperValue = String(value || '').toUpperCase()
  if (isUnsetAddMode(value)) return '未设置'
  if (upperValue.includes('AUTO')) return '自动加入'
  if (upperValue.includes('MANUAL')) return '手动加入'
  return value || '未设置'
}

const normalizeActivityRow = (row: ActivityProduct, action: ActivityAction): ActivityProduct => ({
  ...row,
  action_id: row.action_id ?? action.id,
  action_title: row.action_title || action.title,
  add_mode_label: row.add_mode_label || translateAddMode(row.add_mode),
})

const getRowKey = (row: ActivityProduct) =>
  `${row.action_id || 0}-${row.activity_product_id || row.sku || row.offer_id || 'row'}`

const setRowsBusy = (rows: ActivityProduct[], busy: boolean) => {
  const keys = rows.map(getRowKey)
  if (busy) {
    busyRowKeys.value = Array.from(new Set([...busyRowKeys.value, ...keys]))
    return
  }
  busyRowKeys.value = busyRowKeys.value.filter((item) => !keys.includes(item))
}

const isRowBusy = (row: ActivityProduct) => busyRowKeys.value.includes(getRowKey(row))

const formatMoney = (value?: number | null) => {
  if (value === null || value === undefined) return '-'
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue.toFixed(2) : '-'
}

const getBuyerProductUrl = (sku: string | number) =>
  `https://www.ozon.ru/search/?text=${encodeURIComponent(String(sku))}`

const matchAddMode = (row: ActivityProduct, addMode: AddModeFilter) => {
  const upperValue = String(row.add_mode || '').toUpperCase()
  if (addMode === 'auto') return upperValue.includes('AUTO')
  if (addMode === 'manual') return upperValue.includes('MANUAL')
  if (addMode === 'unset') return isUnsetAddMode(row.add_mode)
  return true
}

const getAddModeTagType = (row: ActivityProduct) => {
  if (matchAddMode(row, 'auto')) return 'success'
  if (matchAddMode(row, 'manual')) return 'info'
  return 'warning'
}

const applyFilters = (rows: ActivityProduct[], filters: FilterState) =>
  rows.filter((row) => {
    if (!matchAddMode(row, filters.addMode)) return false
    if (filters.onlyBelowMin && !row.below_min_price) return false
    return true
  })

const filteredCandidates = computed(() => applyFilters(candidates.value, candidateFilters))
const filteredParticipating = computed(() => applyFilters(participating.value, participatingFilters))
const candidateLowPriceCount = computed(() => candidates.value.filter((row) => row.below_min_price).length)
const participatingLowPriceRows = computed(() =>
  participating.value.filter((row) => row.below_min_price)
)
const participatingAutoAddedRows = computed(() =>
  participating.value.filter((row) => matchAddMode(row, 'auto'))
)

const clearParticipatingSelection = () => {
  selectedParticipatingRows.value = []
  participatingTableRef.value?.clearSelection?.()
}

const handleParticipatingSelectionChange = (rows: ActivityProduct[]) => {
  selectedParticipatingRows.value = rows
}

const dedupeRows = (rows: ActivityProduct[]) => {
  const rowMap = new Map<string, ActivityProduct>()
  for (const row of rows) {
    const key = getRowKey(row)
    if (!rowMap.has(key)) {
      rowMap.set(key, row)
    }
  }
  return Array.from(rowMap.values())
}

const resetProductTables = () => {
  candidates.value = []
  participating.value = []
  candidatesScope.value = 'selected'
  participatingScope.value = 'selected'
  clearParticipatingSelection()
}

const loadStores = async () => {
  const list = await fetchStores()
  stores.value = list || []
  if (!selectedStoreId.value && stores.value.length > 0) {
    selectedStoreId.value = stores.value[0].id
  }
}

const loadActions = async (forceRefresh = false, options: { background?: boolean } = {}) => {
  if (!selectedStoreId.value) {
    ElMessage.warning('请先选择店铺')
    return
  }

  const showLoading = !options.background && (forceRefresh || actions.value.length === 0)
  if (showLoading) {
    loadingActions.value = true
  }
  if (!options.background) {
    resetProductTables()
  }
  try {
    const resp = await getActions(selectedStoreId.value, {
      forceRefresh,
      syncProducts: forceRefresh,
    })
    if (forceRefresh && selectedStoreId.value) {
      markActivitiesAutoRefreshed(selectedStoreId.value)
    }
    ensureOk(resp, '活动列表加载失败')
    actions.value = extractActions(resp)

    if (!actions.value.length) {
      selectedActionId.value = undefined
      ElMessage.warning('当前店铺暂无可参与活动')
      return
    }

    const currentActionExists = actions.value.some((action) => action.id === selectedActionId.value)
    selectedActionId.value = currentActionExists ? selectedActionId.value : actions.value[0].id
  } catch (error: any) {
    if (!options.background) {
      actions.value = []
      selectedActionId.value = undefined
    }
    ElMessage.error(error.message || '活动列表加载失败')
  } finally {
    if (showLoading) {
      loadingActions.value = false
    }
  }
}

const fetchActionProducts = async (
  action: ActivityAction,
  loader: (payload: Record<string, any>, storeId?: number) => Promise<any>,
) => {
  const rows: ActivityProduct[] = []
  const limit = 100
  let offset = 0

  while (true) {
    const resp = await loader(
      {
        action_id: action.id,
        limit,
        offset,
      },
      selectedStoreId.value,
    )

    ensureOk(resp, `活动「${action.title}」加载失败`)
    const pageRows = extractProducts(resp).map((row) => normalizeActivityRow(row, action))
    const total = extractTotal(resp, pageRows.length)
    rows.push(...pageRows)

    if (!pageRows.length || rows.length >= total) {
      break
    }

    offset += pageRows.length
  }

  return rows
}

const loadRowsForScope = async (
  scope: LoadScope,
  loader: (payload: Record<string, any>, storeId?: number) => Promise<any>,
  target: typeof candidates,
  loading: typeof loadingCandidates,
  tabName: 'candidates' | 'participating',
  scopeRef: typeof candidatesScope,
  successText: string,
) => {
  if (!selectedStoreId.value) {
    ElMessage.warning('请先选择店铺')
    return
  }

  if (!actions.value.length) {
    ElMessage.warning('暂无活动可查询')
    return
  }

  const selectedActions =
    scope === 'all'
      ? actions.value
      : actions.value.filter((action) => action.id === selectedActionId.value)

  if (!selectedActions.length) {
    ElMessage.warning('请先选择活动')
    return
  }

  loading.value = true
  try {
    const allRows: ActivityProduct[] = []
    const failedActions: string[] = []

    for (const action of selectedActions) {
      try {
        const rows = await fetchActionProducts(action, loader)
        allRows.push(...rows)
      } catch (error: any) {
        if (scope === 'selected') throw error
        failedActions.push(action.title)
      }
    }

    target.value = dedupeRows(allRows)
    scopeRef.value = scope
    activeTab.value = tabName
    if (tabName === 'participating') {
      clearParticipatingSelection()
    }

    if (!target.value.length && !failedActions.length) {
      ElMessage.warning(`${successText}为空`)
      return
    }

    if (failedActions.length) {
      ElMessage.warning(`已加载部分结果，失败活动数：${failedActions.length}`)
      return
    }

    if (scope === 'all') {
      ElMessage.success(`已汇总 ${selectedActions.length} 个活动的${successText}`)
    }
  } catch (error: any) {
    ElMessage.error(error.message || `${successText}加载失败`)
  } finally {
    loading.value = false
  }
}

const loadCandidates = async (id: number) => {
  if (!id) {
    ElMessage.warning('请先选择活动')
    return
  }
  selectedActionId.value = id
  await loadRowsForScope(
    'selected',
    getCandidates,
    candidates,
    loadingCandidates,
    'candidates',
    candidatesScope,
    '候选商品',
  )
}

const loadAllCandidates = async () => {
  await loadRowsForScope(
    'all',
    getCandidates,
    candidates,
    loadingCandidates,
    'candidates',
    candidatesScope,
    '候选商品',
  )
}

const loadParticipating = async (id: number) => {
  if (!id) {
    ElMessage.warning('请先选择活动')
    return
  }
  selectedActionId.value = id
  await loadRowsForScope(
    'selected',
    getParticipating,
    participating,
    loadingParticipating,
    'participating',
    participatingScope,
    '参与商品',
  )
}

const loadAllParticipating = async () => {
  await loadRowsForScope(
    'all',
    getParticipating,
    participating,
    loadingParticipating,
    'participating',
    participatingScope,
    '参与商品',
  )
}

const reloadParticipatingView = async () => {
  if (participatingScope.value === 'all') {
    await loadAllParticipating()
    return
  }
  if (selectedActionId.value) {
    await loadParticipating(selectedActionId.value)
  }
}

const deactivateRows = async (rows: ActivityProduct[], successMessage: string) => {
  const groupedRows = new Map<number, number[]>()
  for (const row of rows) {
    const actionId = Number(row.action_id)
    const productId = Number(row.activity_product_id)
    if (!actionId || !productId) continue
    if (!groupedRows.has(actionId)) {
      groupedRows.set(actionId, [])
    }
    const currentIds = groupedRows.get(actionId)!
    if (!currentIds.includes(productId)) {
      currentIds.push(productId)
    }
  }

  if (!groupedRows.size) {
    ElMessage.warning('没有可退出的活动商品')
    return
  }

  let rejectedCount = 0
  for (const [actionId, productIds] of groupedRows.entries()) {
    const resp = await deactivateProducts(
      {
        action_id: actionId,
        product_ids: productIds,
      },
      selectedStoreId.value,
    )
    ensureOk(resp, `活动 ${actionId} 退出失败`)
    const rejected = resp?.data?.result?.rejected
    if (Array.isArray(rejected)) {
      rejectedCount += rejected.length
    }
  }

  if (rejectedCount > 0) {
    ElMessage.warning(`${successMessage}，但有 ${rejectedCount} 个商品被接口拒绝`)
  } else {
    ElMessage.success(successMessage)
  }
  await reloadParticipatingView()
}

const handleQuickDeactivate = async (row: ActivityProduct) => {
  try {
    await ElMessageBox.confirm(
      `确认将商品「${row.name || row.sku || row.offer_id || '-'}」从活动中退出吗？`,
      '快捷退出活动',
      {
        confirmButtonText: '确认退出',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }

  setRowsBusy([row], true)
  try {
    await deactivateRows([row], '退出活动请求已提交')
  } catch (error: any) {
    ElMessage.error(error.message || '退出活动失败')
  } finally {
    setRowsBusy([row], false)
  }
}

const handleBatchDeactivateSelected = async () => {
  const rowsToRemove = [...selectedParticipatingRows.value]

  if (!rowsToRemove.length) {
    ElMessage.warning('请先勾选要批量退出的商品')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认将已勾选的 ${rowsToRemove.length} 个商品批量退出活动吗？`,
      '批量退出活动',
      {
        confirmButtonText: '确认退出',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }

  batchDeactivatingSelected.value = true
  setRowsBusy(rowsToRemove, true)
  try {
    await deactivateRows(rowsToRemove, '批量退出活动完成')
  } catch (error: any) {
    ElMessage.error(error.message || '批量退出活动失败')
  } finally {
    setRowsBusy(rowsToRemove, false)
    batchDeactivatingSelected.value = false
    clearParticipatingSelection()
  }
}

const handleDeactivateAllAutoAdded = async () => {
  const rowsToRemove = [...participatingAutoAddedRows.value]

  if (!rowsToRemove.length) {
    ElMessage.warning('当前已加载结果中没有自动加入的商品')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认一键退出当前已加载结果中的 ${rowsToRemove.length} 个自动加入商品吗？`,
      '退出所有自动加入商品',
      {
        confirmButtonText: '确认退出',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }

  batchDeactivatingAuto.value = true
  setRowsBusy(rowsToRemove, true)
  try {
    await deactivateRows(rowsToRemove, '自动加入商品已全部退出')
  } catch (error: any) {
    ElMessage.error(error.message || '退出自动加入商品失败')
  } finally {
    setRowsBusy(rowsToRemove, false)
    batchDeactivatingAuto.value = false
    clearParticipatingSelection()
  }
}

const handleBatchRemoveLowPrice = async () => {
  const rowsToRemove = [...participatingLowPriceRows.value]

  if (!rowsToRemove.length) {
    ElMessage.warning('当前结果里没有低于最低价的商品')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认剔除当前结果中 ${rowsToRemove.length} 个低于最低价的活动商品吗？`,
      '批量剔除低价活动商品',
      {
        confirmButtonText: '确认剔除',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }

  batchRemovingLowPrice.value = true
  setRowsBusy(rowsToRemove, true)
  try {
    await deactivateRows(rowsToRemove, '低价活动商品剔除完成')
  } catch (error: any) {
    ElMessage.error(error.message || '批量剔除失败')
  } finally {
    setRowsBusy(rowsToRemove, false)
    batchRemovingLowPrice.value = false
  }
}

const handleStoreChange = async () => {
  actions.value = []
  await loadActions(false)
}

onMounted(async () => {
  await loadStores()
  const initialStoreId = selectedStoreId.value
  if (initialStoreId) {
    await loadActions(shouldAutoRefreshActivitiesOnTabOpen(initialStoreId))
  }
  hasCompletedInitialLoad = true
})

onActivated(async () => {
  if (!hasCompletedInitialLoad) {
    return
  }
  if (!selectedStoreId.value) {
    await loadStores()
  }
  const currentStoreId = selectedStoreId.value
  if (!currentStoreId) return
  if (!actions.value.length) {
    await loadActions(shouldAutoRefreshActivitiesOnTabOpen(currentStoreId))
    return
  }
  if (shouldAutoRefreshActivitiesOnTabOpen(currentStoreId)) {
    void loadActions(true, { background: true })
  }
})
</script>

<style scoped>
.activities-container {
  padding: 0;
  background: var(--c-surface-1);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.toolbar-panel,
.filter-panel {
  display: grid;
  gap: var(--space-4);
}

.filter-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: 0;
}

.filter-row-wrap {
  flex-wrap: wrap;
}

.label {
  font-size: var(--font-size-md);
  color: var(--c-text-1);
  font-weight: 650;
}

.summary-strip {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.summary-pill {
  min-width: 132px;
  padding: 10px 12px;
  border: 1px solid var(--c-border-1);
  border-radius: var(--radius-sm);
  background: var(--c-surface-2);
}

.summary-pill-danger {
  border-color: color-mix(in oklch, var(--c-danger) 24%, white);
  background: color-mix(in oklch, var(--c-danger) 10%, white);
}

.summary-label {
  display: block;
  margin-bottom: 4px;
  font-size: var(--font-size-xs);
  color: var(--c-text-3);
}

.summary-value {
  font-size: var(--font-size-lg);
  color: var(--c-text-1);
}

.sku-block {
  display: grid;
  gap: 4px;
}

.offer-id {
  font-size: var(--font-size-xs);
  color: var(--c-text-3);
  word-break: break-all;
}

.price-danger {
  color: var(--c-danger);
  font-weight: 700;
}

:deep(.table-header) {
  background: var(--c-surface-2) !important;
  color: var(--c-text-2);
  font-weight: 650;
  font-size: var(--font-size-xs);
}
</style>
