<template>
  <div class="collection-upload-container">
    <div class="page-header">
      <div>
        <h2 class="page-title">采集上传记录</h2>
        <p class="page-subtitle">显示云端上货任务、Ozon 任务号和最近同步状态。</p>
      </div>
      <div class="header-actions">
        <el-select
          v-model="selectedStoreId"
          clearable
          placeholder="全部店铺"
          style="width: 180px"
          @change="loadJobs"
        >
          <el-option
            v-for="store in stores"
            :key="store.id"
            :label="store.store_name"
            :value="store.id"
          />
        </el-select>
        <el-button :icon="RefreshRight" @click="loadJobs" :loading="loading">刷新</el-button>
      </div>
    </div>

    <div class="table-section">
      <el-table
        :data="pagedJobs"
        style="width: 100%"
        border
        v-loading="loading"
        header-cell-class-name="table-header"
      >
        <el-table-column prop="id" label="任务ID" width="90" />
        <el-table-column label="商品图" width="90">
          <template #default="{ row }">
            <el-image
              v-if="row.image"
              style="width: 48px; height: 48px"
              :src="row.image"
              fit="cover"
            />
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column prop="storeName" label="店铺" width="120" />
        <el-table-column prop="source" label="来源" width="120" />
        <el-table-column prop="productName" label="商品名称" min-width="220" show-overflow-tooltip />
        <el-table-column prop="offerId" label="Offer ID" width="180" show-overflow-tooltip />
        <el-table-column prop="price" label="价格" width="100" />
        <el-table-column prop="itemCount" label="商品数" width="90" />
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" effect="dark">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="ozonTaskId" label="Ozon任务ID" width="140" />
        <el-table-column prop="localTaskId" label="本地任务ID" width="140" />
        <el-table-column prop="error" label="错误信息" min-width="180" show-overflow-tooltip />
        <el-table-column prop="updatedAt" label="更新时间" width="180" />
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              @click="refreshJob(row)"
              :disabled="!row.ozonTaskId || refreshingId === row.id"
            >
              {{ refreshingId === row.id ? '刷新中' : '刷新状态' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="pagination-section">
      <el-pagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :page-sizes="[10, 20, 50, 100]"
        layout="sizes, total, prev, pager, next, jumper"
        :total="total"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { RefreshRight } from '@element-plus/icons-vue'
import { fetchStores } from '../api/store'
import { fetchUploadJobs, refreshUploadJob } from '../api/upload'

type UploadJobRow = {
  id: number
  storeName: string
  source: string
  productName: string
  offerId: string
  price: string
  itemCount: number
  status: string
  ozonTaskId: string
  localTaskId: string
  image: string
  error: string
  updatedAt: string
}

const loading = ref(false)
const refreshingId = ref<number | null>(null)
const currentPage = ref(1)
const pageSize = ref(15)
const total = ref(0)
const selectedStoreId = ref<number | undefined>(undefined)
const stores = ref<any[]>([])
const jobs = ref<UploadJobRow[]>([])

const formatTime = (value?: string) => {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return value
  }
}

const normalizeJob = (job: any): UploadJobRow => {
  const items = job.request_payload?.items || []
  const firstItem = items[0] || {}
  return {
    id: job.id,
    storeName: job.store_name || '-',
    source: job.source || '-',
    productName: firstItem.name || firstItem.product_name || '-',
    offerId: firstItem.offer_id || '-',
    price: firstItem.price || '-',
    itemCount: job.item_count || items.length || 0,
    status: job.status || 'unknown',
    ozonTaskId: job.ozon_task_id || '-',
    localTaskId: job.local_task_id || '-',
    image: firstItem.primary_image || firstItem.image || '',
    error: job.error || '-',
    updatedAt: formatTime(job.updated_at),
  }
}

const pagedJobs = computed(() => {
  total.value = jobs.value.length
  const start = (currentPage.value - 1) * pageSize.value
  const end = start + pageSize.value
  return jobs.value.slice(start, end)
})

const statusType = (status: string) => {
  if (['completed', 'success'].includes(status)) return 'success'
  if (['submitted', 'processing'].includes(status)) return 'warning'
  if (['failed', 'submit_failed', 'completed_with_errors'].includes(status)) return 'danger'
  return 'info'
}

const loadStores = async () => {
  const data = await fetchStores()
  stores.value = data
}

const loadJobs = async () => {
  loading.value = true
  try {
    const data = await fetchUploadJobs(selectedStoreId.value)
    jobs.value = (data.result || []).map(normalizeJob)
    currentPage.value = 1
  } catch (error: any) {
    ElMessage.error(error.response?.data?.detail || '加载上传记录失败')
  } finally {
    loading.value = false
  }
}

const refreshJob = async (row: UploadJobRow) => {
  refreshingId.value = row.id
  try {
    await refreshUploadJob(row.id)
    await loadJobs()
    ElMessage.success('任务状态已刷新')
  } catch (error: any) {
    ElMessage.error(error.response?.data?.detail || '刷新任务状态失败')
  } finally {
    refreshingId.value = null
  }
}

onMounted(async () => {
  await loadStores()
  await loadJobs()
})
</script>

<style scoped>
.collection-upload-container {
  padding: 0;
  background: var(--c-surface-1);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-5);
}

.page-subtitle {
  margin: 8px 0 0;
  color: var(--c-text-3);
  font-size: var(--font-size-sm);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

:deep(.table-header) {
  background: var(--c-surface-2) !important;
  color: var(--c-text-2);
  font-weight: 650;
  font-size: var(--font-size-xs);
}
</style>
