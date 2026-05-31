<template>
  <div class="collection-upload-container">
    <div class="page-header">
      <div>
        <h2 class="page-title">采集上传记录</h2>
        <p class="page-subtitle">只保留任务核心字段：任务ID、商品图、上传价格、上传状态、商品名称。</p>
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
        <el-table-column prop="price" label="上传价格" width="120" />
        <el-table-column label="上传状态" width="130">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" effect="dark">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="productName" label="商品名称" min-width="260" show-overflow-tooltip />
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
import { fetchUploadJobs } from '../api/upload'

type UploadJobRow = {
  id: number
  productName: string
  price: string
  status: string
  image: string
}

const loading = ref(false)
const currentPage = ref(1)
const pageSize = ref(15)
const total = ref(0)
const selectedStoreId = ref<number | undefined>(undefined)
const stores = ref<any[]>([])
const jobs = ref<UploadJobRow[]>([])

const normalizePrice = (value: unknown) => {
  if (value == null || value === '') return '-'
  return String(value)
}

const normalizeJob = (job: any): UploadJobRow => {
  const items = job.request_payload?.items || []
  const firstItem = items[0] || {}
  return {
    id: job.id,
    productName: firstItem.name || firstItem.product_name || '-',
    price: normalizePrice(firstItem.price),
    status: job.status || 'unknown',
    image: firstItem.primary_image || firstItem.image || '',
  }
}

const pagedJobs = computed(() => {
  total.value = jobs.value.length
  const start = (currentPage.value - 1) * pageSize.value
  const end = start + pageSize.value
  return jobs.value.slice(start, end)
})

const statusLabel = (status: string) => {
  if (['completed', 'success'].includes(status)) return '完成'
  if (['failed', 'submit_failed', 'queue_failed', 'completed_with_errors', 'canceled'].includes(status)) return '失败'
  return '正在上传'
}

const statusType = (status: string) => {
  if (['completed', 'success'].includes(status)) return 'success'
  if (['failed', 'submit_failed', 'queue_failed', 'completed_with_errors', 'canceled'].includes(status)) return 'danger'
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
