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
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'awaiting_packaging'"
              size="small"
              type="primary"
              @click="handlePackaged(row)"
            >
              备货完成
            </el-button>
            <el-button v-else size="small">查看</el-button>
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
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useRoute } from 'vue-router'
import { submitSyncOrdersJob } from '../api/jobs'
import { fetchOrders, markOrderPackaged } from '../api/orders'
import { fetchStores } from '../api/store'
import { useAsyncJob } from '../composables/useAsyncJob'

const route = useRoute()
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

const handleSearch = async () => {
  loading.value = true
  try {
    const data = await fetchOrders({
      scheme: 'FBS',
      status: status.value,
      search: searchQuery.value.keyword || undefined,
      store_id: searchQuery.value.storeId,
      page: currentPage.value,
      page_size: pageSize.value,
    })
    tableData.value = data.result || []
    total.value = data.total || 0
    await nextTick()
    scrollToHighlight()
  } catch (error: any) {
    ElMessage.error(error.response?.data?.detail || '获取订单失败')
  } finally {
    loading.value = false
  }
}

const handlePackaged = async (row: any) => {
  await markOrderPackaged(row.id)
  ElMessage.success('订单已转为待发货')
  void handleSearch()
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
        await handleSearch()
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

:deep(.highlight-target-row) {
  outline: 2px solid #409eff;
  box-shadow: inset 0 0 10px rgba(64, 158, 255, 0.18);
}
</style>
