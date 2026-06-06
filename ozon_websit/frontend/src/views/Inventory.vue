<template>
  <div class="inventory-container">
    <div class="page-header">
      <h2 class="page-title">库存管理</h2>
    </div>

    <div class="search-section">
      <div class="filter-row">
        <span class="label">搜索</span>
        <el-input v-model="searchQuery.sku" placeholder="SKU" clearable class="input-item" />
        <el-select v-model="searchQuery.storeId" placeholder="全部店铺" class="select-item" clearable>
          <el-option v-for="store in stores" :key="store.id" :label="store.store_name" :value="store.id" />
        </el-select>
        <el-select v-model="searchQuery.warehouseName" placeholder="全部仓库" class="select-item" clearable filterable>
          <el-option
            v-for="option in warehouseOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
        <el-select v-model="searchQuery.backupStatus" placeholder="备份状态" class="select-item">
          <el-option label="全部" value="" />
          <el-option label="已备份" value="backed_up" />
          <el-option label="未备份" value="unbacked" />
        </el-select>
        <el-select v-model="searchQuery.archiveStatus" placeholder="归档状态" class="select-item">
          <el-option label="未归档" value="unarchived" />
          <el-option label="已归档" value="archived" />
          <el-option label="全部" value="" />
        </el-select>
        <el-button type="primary" :icon="Search" @click="handleSearch">查询</el-button>
        <el-button :icon="RefreshRight" @click="handleReset">重置</el-button>
      </div>

      <div class="action-row">
        <span class="label">批量</span>
        <div class="batch-buttons">
          <el-button
            plain
            :loading="syncingSellerWarehouses"
            :disabled="!searchQuery.storeId"
            @click="handleSyncSellerWarehouses"
          >
            同步 Ozon 仓库
          </el-button>
          <el-button type="primary" @click="handleBatchStock">修改库存</el-button>
          <el-button @click="handleBackup">备份库存</el-button>
          <el-button @click="handleRestore">恢复库存</el-button>
          <el-button @click="handleAutoRestock">自动补货</el-button>
          <el-button @click="handleSchedule">定时上下架</el-button>
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
        <el-table-column prop="store_name" label="店铺" width="120" />
        <el-table-column prop="warehouse_name" label="仓库" width="180">
          <template #default="{ row }">
            {{ row.warehouse_name || '-' }}
          </template>
        </el-table-column>
        <el-table-column label="图片" width="90">
          <template #default="{ row }">
            <el-image
              :src="row.primary_image"
              fit="cover"
              style="width: 46px; height: 46px; border-radius: 8px"
            />
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
        <el-table-column prop="stock" label="当前库存" width="100" />
        <el-table-column prop="backup_stock" label="备份库存" width="100" />
        <el-table-column prop="auto_restock" label="自动补货" width="100">
          <template #default="{ row }">
            <el-tag :type="row.auto_restock ? 'success' : 'info'">
              {{ row.auto_restock ? '开启' : '关闭' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="scheduled_shelf" label="定时上下架" width="140">
          <template #default="{ row }">
            {{ row.scheduled_shelf || '-' }}
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100" />
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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { RefreshRight, Search } from '@element-plus/icons-vue'
import { submitSyncBrowserWarehousesJob } from '../api/jobs'
import { fetchStores } from '../api/store'
import { getSellerProductSearchUrl } from '../utils/ozon'
import {
  batchBackupInventory,
  batchRestoreInventory,
  batchUpdateInventoryAutomation,
  batchUpdateInventoryStock,
  fetchInventory,
} from '../api/products'
import { useAsyncJob } from '../composables/useAsyncJob'

type StoreItem = {
  id: number
  store_name: string
  warehouse_info?: string | null
}

type InventoryRow = {
  id: number
  store_id: number
  store_name?: string
  warehouse_name?: string | null
  sku?: string | null
  product_name?: string
  primary_image?: string | null
  stock: number
  backup_stock: number
  auto_restock: boolean
  scheduled_shelf?: string | null
  status?: string
}

const loading = ref(false)
const currentPage = ref(1)
const pageSize = ref(15)
const total = ref(0)
const stores = ref<StoreItem[]>([])
const tableData = ref<InventoryRow[]>([])
const selectedRows = ref<InventoryRow[]>([])
const warehouseSyncJob = useAsyncJob()
const { running: warehouseTaskRunning } = warehouseSyncJob
const syncingSellerWarehouses = computed(() => warehouseTaskRunning.value)

const searchQuery = ref({
  sku: '',
  warehouseName: '',
  backupStatus: '',
  archiveStatus: 'unarchived',
  storeId: undefined as number | undefined,
})

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

const selectedIds = () => selectedRows.value.map((row) => row.id)

const handleSelectionChange = (rows: InventoryRow[]) => {
  selectedRows.value = rows
}

const loadStores = async () => {
  stores.value = await fetchStores()
}

const buildInventoryParams = () => ({
  sku: searchQuery.value.sku || undefined,
  warehouse_name: searchQuery.value.warehouseName || undefined,
  backup_status: searchQuery.value.backupStatus || undefined,
  archive_status: searchQuery.value.archiveStatus,
  store_id: searchQuery.value.storeId,
  page: currentPage.value,
  page_size: pageSize.value,
})

const handleSearch = async () => {
  loading.value = true
  try {
    const data = await fetchInventory(buildInventoryParams())
    tableData.value = data.result || []
    total.value = data.total || 0
  } catch (error: any) {
    ElMessage.error(error.response?.data?.detail || '查询库存失败')
  } finally {
    loading.value = false
  }
}

const handleReset = () => {
  searchQuery.value = {
    sku: '',
    warehouseName: '',
    backupStatus: '',
    archiveStatus: 'unarchived',
    storeId: undefined,
  }
  currentPage.value = 1
  void handleSearch()
}

const ensureSelected = () => {
  if (!selectedRows.value.length) {
    ElMessage.warning('请先选择库存项')
    return false
  }
  return true
}

const ensureStockWarehouse = (rows: InventoryRow[] = []) => {
  const warehouseName = searchQuery.value.warehouseName.trim()
  if (!warehouseName) {
    ElMessage.warning('修改库存前请先选择仓库')
    return null
  }
  if (!rows.length) {
    return warehouseName
  }
  const mismatched = rows.some((row) => (row.warehouse_name || '').trim() !== warehouseName)
  if (mismatched) {
    ElMessage.warning('当前选中的库存项与已选仓库不一致，请先按仓库筛选后再修改库存')
    return null
  }
  return warehouseName
}

const buildFilteredInventoryPayload = () => ({
  sku: searchQuery.value.sku || undefined,
  warehouse_name: searchQuery.value.warehouseName || undefined,
  backup_status: searchQuery.value.backupStatus || undefined,
  archive_status: searchQuery.value.archiveStatus,
  store_id: searchQuery.value.storeId,
})

const chooseBatchStockScope = async () => {
  try {
    await ElMessageBox.confirm(
      `确定：只修改当前勾选的 ${selectedRows.value.length} 个商品；取消：修改当前筛选范围的全部 ${total.value} 个商品。`,
      '修改库存范围',
      {
        confirmButtonText: '只修改选中',
        cancelButtonText: '当前范围全部商品',
        distinguishCancelAndClose: true,
        type: 'warning',
      }
    )
    return 'selected' as const
  } catch (action) {
    if (action === 'cancel') {
      return 'filtered' as const
    }
    return null
  }
}

const handleBatchStock = async () => {
  const scope = await chooseBatchStockScope()
  if (!scope) return
  if (scope === 'selected' && !ensureSelected()) return
  if (scope === 'filtered' && !total.value) {
    ElMessage.warning('当前筛选范围没有可修改的商品')
    return
  }

  const scopeLabel =
    scope === 'selected'
      ? `选中的 ${selectedRows.value.length} 个商品`
      : `当前筛选范围的全部 ${total.value} 个商品`
  const warehouseName = ensureStockWarehouse(scope === 'selected' ? selectedRows.value : [])
  if (!warehouseName) return

  try {
    const { value } = await ElMessageBox.prompt(`输入新的库存值，将应用到${scopeLabel}`, '修改库存', {
      inputPattern: /^\d+$/,
      inputErrorMessage: '请输入整数库存',
    })
    const payload =
      scope === 'selected'
        ? { ids: selectedIds(), stock: Number(value), warehouse_name: warehouseName }
        : {
            stock: Number(value),
            apply_to_filtered: true,
            ...buildFilteredInventoryPayload(),
          }
    const data = await batchUpdateInventoryStock(payload)
    ElMessage.success(data.message || '库存已更新')
    await handleSearch()
  } catch (error: any) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error.response?.data?.detail || '修改库存失败')
  }
}

const handleSyncSellerWarehouses = async () => {
  if (!searchQuery.value.storeId) {
    ElMessage.warning('请先选择店铺，再同步 Ozon 仓库')
    return
  }

  await warehouseSyncJob.runJob(
    () => submitSyncBrowserWarehousesJob(searchQuery.value.storeId as number),
    {
      successMessage: '仓库同步完成',
      onSuccess: async () => {
        await loadStores()
        await handleSearch()
      },
    }
  )
}

const handleBackup = async () => {
  if (!ensureSelected()) return
  await batchBackupInventory({ ids: selectedIds() })
  ElMessage.success('库存已备份')
  await handleSearch()
}

const handleRestore = async () => {
  if (!ensureSelected()) return
  await batchRestoreInventory({ ids: selectedIds() })
  ElMessage.success('库存已恢复')
  await handleSearch()
}

const handleAutoRestock = async () => {
  if (!ensureSelected()) return
  await batchUpdateInventoryAutomation({ ids: selectedIds(), auto_restock: true })
  ElMessage.success('已开启自动补货')
  await handleSearch()
}

const handleSchedule = async () => {
  if (!ensureSelected()) return
  try {
    const { value } = await ElMessageBox.prompt(
      '输入定时上下架说明，例如：每天 10:00 上架',
      '定时上下架',
      {
        inputPattern: /^.{1,60}$/,
        inputErrorMessage: '请输入 1-60 字说明',
      }
    )
    await batchUpdateInventoryAutomation({ ids: selectedIds(), scheduled_shelf: value })
    ElMessage.success('定时上下架已更新')
    await handleSearch()
  } catch {
    // user cancelled
  }
}

watch(
  () => searchQuery.value.storeId,
  () => {
    searchQuery.value.warehouseName = ''
  }
)

onMounted(async () => {
  await loadStores()
  await handleSearch()
})
</script>

<style scoped>
.inventory-container {
  padding: 0;
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

.batch-buttons {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.sku-link {
  color: var(--el-color-primary);
  text-decoration: none;
}

.sku-link:hover {
  text-decoration: underline;
}

:deep(.table-header) {
  background: var(--c-surface-2) !important;
  color: var(--c-text-2);
  font-weight: 650;
  font-size: var(--font-size-xs);
}
</style>
