<template>
  <div class="orders-container">
    <el-card shadow="never">
      <div class="filter-bar">
        <el-input
          v-model="searchQuery.keyword"
          placeholder="订单号 / 商品名"
          style="width: 240px"
          clearable
        />
        <el-select v-model="status" placeholder="状态" style="width: 200px">
          <el-option label="全部状态" value="all" />
          <el-option label="待备货" value="awaiting_packaging" />
          <el-option label="待发货" value="awaiting_deliver" />
          <el-option label="配送中" value="delivering" />
          <el-option label="已送达" value="delivered" />
        </el-select>
        <el-select v-model="searchQuery.storeId" placeholder="全部店铺" style="width: 180px" clearable>
          <el-option
            v-for="store in stores"
            :key="store.id"
            :label="store.store_name"
            :value="store.id"
          />
        </el-select>
        <el-button type="primary" @click="handleSearch">查询</el-button>
        <el-radio-group v-model="syncDays" class="period-group" size="small">
          <el-radio-button
            v-for="option in syncDayOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </el-radio-button>
        </el-radio-group>
        <el-button @click="handleSync" :loading="syncing">同步订单</el-button>
      </div>

      <el-table
        :data="tableData"
        border
        style="width: 100%"
        v-loading="loading"
        :row-class-name="tableRowClassName"
      >
        <el-table-column prop="posting_number" label="订单号" width="180" />
        <el-table-column label="商品图片" width="96">
          <template #default="{ row }">
            <el-image
              v-if="row.product_image"
              :src="row.product_image"
              fit="cover"
              style="width: 46px; height: 46px; border-radius: 8px"
            />
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column prop="product_name" label="商品" min-width="220" show-overflow-tooltip />
        <el-table-column prop="store_name" label="店铺" width="120" />
        <el-table-column prop="created_at_label" label="创建时间" width="170" />
        <el-table-column prop="status_label" label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)">{{ row.status_label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="deadline_label" label="截止时间" width="160">
          <template #default="{ row }">
            <el-tag
              v-if="row.deadline_label !== '-'"
              :type="isUrgent(row.deadline_at) ? 'danger' : 'warning'"
            >
              {{ row.deadline_label }}
            </el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column prop="amount_label" label="金额" width="120" />
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <div class="order-actions">
              <el-button
                v-if="row.status === 'awaiting_packaging'"
                size="small"
                type="primary"
                @click="handlePackaged(row)"
              >
                备货完成
              </el-button>
              <el-button
                size="small"
                :type="row.downloaded || row.printed ? 'info' : 'success'"
                :icon="Download"
                @click="handlePrintWaybill(row)"
              >
                {{ row.downloaded || row.printed ? '重新下载 PDF' : '下载面单 PDF' }}
              </el-button>
              <el-button v-if="row.status !== 'awaiting_packaging'" size="small">查看</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-container">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          layout="sizes, total, prev, pager, next, jumper"
          :page-sizes="[10, 20, 50]"
          :total="total"
          @size-change="handleSearch"
          @current-change="handleSearch"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Download } from '@element-plus/icons-vue'
import { useRoute } from 'vue-router'
import { submitSyncOrdersJob } from '../api/jobs'
import { downloadOrderWaybillPdf, fetchOrders, markOrderPackaged } from '../api/orders'
import { fetchStores } from '../api/store'
import { getAuthUser } from '../utils/auth'
import { useAsyncJob } from '../composables/useAsyncJob'

const route = useRoute()
const ORDER_AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000
const ORDER_AUTO_SYNC_AT_PREFIX = 'ozon_orders_auto_sync_at:v1:'
const status = ref('all')
const loading = ref(false)
const syncJob = useAsyncJob()
const { running: syncRunning } = syncJob
const syncing = computed(() => syncRunning.value)
const syncDayOptions = [
  { value: 7, label: '7天' },
  { value: 30, label: '30天' },
  { value: 90, label: '90天' },
  { value: 180, label: '180天' },
  { value: 365, label: '365天' },
] as const
const syncDays = ref(30)
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)
const tableData = ref<any[]>([])
const stores = ref<any[]>([])
const searchQuery = ref({
  keyword: '',
  storeId: undefined as number | undefined,
})
let hasCompletedInitialLoad = false

const resolveOrderAutoSyncKey = () => {
  const username = (getAuthUser()?.username || 'anonymous').trim().toLowerCase()
  return `${ORDER_AUTO_SYNC_AT_PREFIX}${username || 'anonymous'}`
}

const readLastOrderAutoSyncAt = () => {
  if (typeof window === 'undefined') return 0
  try {
    const raw = localStorage.getItem(resolveOrderAutoSyncKey())
    const numeric = Number(raw || 0)
    return Number.isFinite(numeric) ? numeric : 0
  } catch {
    return 0
  }
}

const writeLastOrderAutoSyncAt = (timestamp: number) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(resolveOrderAutoSyncKey(), String(timestamp))
  } catch {
    // ignore storage failures
  }
}

const shouldAutoSyncOrdersNow = () => Date.now() - readLastOrderAutoSyncAt() >= ORDER_AUTO_SYNC_INTERVAL_MS

const triggerAutoSyncOnTabOpen = async () => {
  if (!shouldAutoSyncOrdersNow()) {
    return false
  }
  try {
    await submitSyncOrdersJob({
      days: syncDays.value,
    })
    writeLastOrderAutoSyncAt(Date.now())
    return true
  } catch (error) {
    console.warn('Auto order sync submit failed', error)
    return false
  }
}

const statusType = (value: string) => {
  if (value === 'awaiting_packaging') return 'danger'
  if (value === 'awaiting_deliver') return 'warning'
  if (value === 'delivering') return 'success'
  return 'info'
}

const isUrgent = (deadlineAt: string) => {
  if (!deadlineAt) return false
  const deadline = new Date(deadlineAt).getTime()
  return deadline - Date.now() < 12 * 60 * 60 * 1000
}

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

const getFilenameFromDisposition = (value?: string): string => {
  const fallback = `ozon-waybill-${Date.now()}.pdf`
  if (!value) return fallback
  const utfMatch = value.match(/filename\*=UTF-8''([^;]+)/i)
  if (utfMatch?.[1]) return decodeURIComponent(utfMatch[1])
  const plainMatch = value.match(/filename="?([^";]+)"?/i)
  return plainMatch?.[1] || fallback
}

const getBlobErrorMessage = async (error: any, fallback: string) => {
  const data = error?.response?.data
  if (data instanceof Blob) {
    const text = await data.text().catch(() => '')
    if (text) {
      try {
        const parsed = JSON.parse(text)
        if (parsed?.detail) return String(parsed.detail)
      } catch (_error) {
        return text
      }
    }
  }
  return error?.response?.data?.detail || fallback
}

const handleSearch = async (forceRefresh = false, options: { background?: boolean } = {}) => {
  const shouldForceRefresh = forceRefresh === true
  const showLoading = !options.background && (shouldForceRefresh || tableData.value.length === 0)
  if (showLoading) {
    loading.value = true
  }
  try {
    const data = await fetchOrders({
      scheme: 'FBS',
      status: status.value,
      search: searchQuery.value.keyword || undefined,
      store_id: searchQuery.value.storeId,
      page: currentPage.value,
      page_size: pageSize.value,
    }, {
      forceRefresh: shouldForceRefresh,
    })
    tableData.value = data.result || []
    total.value = data.total || 0
    await nextTick()
    scrollToHighlight()
  } catch (error: any) {
    ElMessage.error(error.response?.data?.detail || '获取订单失败')
  } finally {
    if (showLoading) {
      loading.value = false
    }
  }
}

const handlePackaged = async (row: any) => {
  await markOrderPackaged(row.id)
  ElMessage.success('订单已转为待发货')
  void handleSearch(true)
}

const handlePrintWaybill = async (row: any) => {
  if (!row.posting_number) {
    ElMessage.warning('当前订单缺少 Ozon 订单号，无法下载面单')
    return
  }

  try {
    const response = await downloadOrderWaybillPdf(row.id)
    const filename = getFilenameFromDisposition(response.headers['content-disposition'])
    downloadBlob(response.data, filename)
    row.printed = true
    row.downloaded = true
    ElMessage.success('PDF 面单已下载')
  } catch (error: any) {
    ElMessage.error(await getBlobErrorMessage(error, 'PDF 面单下载失败'))
  }
}

const handleSync = async () => {
  await syncJob.runJob(
    () =>
      submitSyncOrdersJob({
        store_id: searchQuery.value.storeId,
        days: syncDays.value,
      }),
    {
      successMessage: '订单同步完成',
      onSuccess: async () => {
        writeLastOrderAutoSyncAt(Date.now())
        await handleSearch(true)
      },
    }
  )
}

const tableRowClassName = ({ row }: { row: any }) => {
  return route.query.highlight === row.posting_number ? 'highlight-target-row' : ''
}

const scrollToHighlight = () => {
  if (!route.query.highlight) return
  setTimeout(() => {
    const element = document.querySelector('.highlight-target-row')
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, 200)
}

watch(() => route.query.highlight, () => scrollToHighlight())

onMounted(async () => {
  stores.value = await fetchStores()
  await handleSearch()
  const submitted = await triggerAutoSyncOnTabOpen()
  if (submitted) {
    void handleSearch(true, { background: true })
  }
  hasCompletedInitialLoad = true
})

onActivated(async () => {
  if (!hasCompletedInitialLoad) {
    return
  }
  if (!tableData.value.length) {
    stores.value = await fetchStores()
    await handleSearch()
    const submitted = await triggerAutoSyncOnTabOpen()
    if (submitted) {
      void handleSearch(true, { background: true })
    }
    return
  }

  const submitted = await triggerAutoSyncOnTabOpen()
  if (submitted) {
    void handleSearch(true, { background: true })
  }
})
</script>

<style scoped>
.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
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

.pagination-container {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
}

.order-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.order-actions .el-button {
  margin-left: 0;
}

:deep(.highlight-target-row) {
  outline: 2px solid #409eff;
  box-shadow: inset 0 0 10px rgba(64, 158, 255, 0.18);
}
</style>
