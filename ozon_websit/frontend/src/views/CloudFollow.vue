<template>
  <div class="cloud-follow-page">
    <div class="page-header">
      <div>
        <h2 class="page-title">批量铺货</h2>
        <p class="page-subtitle">云端只下发任务，本地扩展抓取后回传云端。</p>
      </div>
    </div>

    <el-card shadow="never" class="panel-card">
      <el-form label-width="110px">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="店铺">
              <el-select
                v-model="form.store_id"
                placeholder="请选择店铺"
                filterable
                clearable
                :loading="storeLoading"
              >
                <el-option
                  v-for="store in stores"
                  :key="store.id"
                  :label="store.store_name"
                  :value="store.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="商品链接/SKU">
              <el-input
                v-model="form.reference"
                placeholder="https://www.ozon.ru/product/... 或 1374017526"
                clearable
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="8">
            <el-form-item label="包含变体">
              <el-switch v-model="form.include_variants" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="变体上限">
              <el-input-number
                v-model="form.max_variants"
                :min="1"
                :max="100"
                :disabled="!form.include_variants"
                controls-position="right"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="模型(可选)">
              <el-input v-model="form.model" clearable placeholder="留空自动生成" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="8">
            <el-form-item label="价格(可选)">
              <el-input v-model="form.price" clearable placeholder="留空使用抓取价格" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="划线价(可选)">
              <el-input v-model="form.old_price" clearable placeholder="留空不覆盖" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="最低价(可选)">
              <el-input v-model="form.follow_min_price" clearable placeholder="留空不覆盖" />
            </el-form-item>
          </el-col>
        </el-row>

        <div class="action-row">
          <el-button type="success" :loading="submitLoading" @click="handleCreateCollectTask">
            提交铺货任务
          </el-button>
          <el-button :loading="batchLoading" @click="openBatchDialog">批量SKU</el-button>
          <el-button :loading="tasksLoading" @click="refreshCollectTasks">刷新任务列表</el-button>
        </div>
        <div class="hint-row">
          扩展每分钟自动领取任务并抓取，不再使用云端浏览器抓取。
        </div>
      </el-form>
    </el-card>

    <el-dialog v-model="batchDialogVisible" title="批量提交SKU" width="920px">
      <div class="batch-grid">
        <div class="batch-column">
          <div class="batch-title">SKU 列表（每行一个）</div>
          <el-input
            v-model="batchSkuText"
            type="textarea"
            :rows="14"
            placeholder="1807550990&#10;1374017526"
          />
        </div>
        <div class="batch-column">
          <div class="batch-title">价格列表（可选，按行对应）</div>
          <el-input
            v-model="batchPriceText"
            type="textarea"
            :rows="14"
            placeholder="99.9&#10;129"
          />
          <div class="batch-price-actions">
            <span class="batch-hint">原价快捷:</span>
            <el-button size="small" @click="applyBatchPriceMultiplier(2)">x2</el-button>
            <el-button size="small" @click="applyBatchPriceMultiplier(2.5)">x2.5</el-button>
            <el-button size="small" @click="applyBatchPriceMultiplier(3)">x3</el-button>
          </div>
        </div>
      </div>

      <el-table v-if="batchResults.length > 0" :data="batchResults" size="small" border class="batch-result-table">
        <el-table-column prop="sku" label="SKU" min-width="160" />
        <el-table-column prop="price" label="价格" width="120" />
        <el-table-column prop="ok" label="结果" width="90">
          <template #default="{ row }">
            <el-tag :type="row.ok ? 'success' : 'danger'">{{ row.ok ? '成功' : '失败' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="task_id" label="任务ID" min-width="120" />
        <el-table-column prop="message" label="消息" min-width="280" show-overflow-tooltip />
      </el-table>

      <template #footer>
        <div class="batch-footer">
          <el-button @click="batchDialogVisible = false">关闭</el-button>
          <el-button type="success" :loading="batchLoading" @click="handleBatchCreateCollectTasks">
            开始批量提交
          </el-button>
        </div>
      </template>
    </el-dialog>

    <el-card v-if="lastSubmittedTask" shadow="never" class="panel-card">
      <template #header>
        <div class="card-header">最近提交</div>
      </template>
      <el-descriptions :column="3" border>
        <el-descriptions-item label="任务ID">{{ lastSubmittedTask.id }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="taskStatusTagType(lastSubmittedTask.status)">{{ taskStatusLabel(lastSubmittedTask.status) }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="店铺ID">{{ lastSubmittedTask.store_id }}</el-descriptions-item>
        <el-descriptions-item label="SKU/链接">{{ lastSubmittedTask.reference }}</el-descriptions-item>
        <el-descriptions-item label="上传任务ID">{{ lastSubmittedTask.upload_job_id || '-' }}</el-descriptions-item>
        <el-descriptions-item label="更新时间">{{ formatDateTime(lastSubmittedTask.updated_at) }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card shadow="never" class="panel-card">
      <template #header>
        <div class="task-header">
          <span class="card-header">扩展任务队列</span>
          <div class="task-actions">
            <el-select v-model="taskStatusFilter" placeholder="全部状态" clearable style="width: 170px" @change="refreshCollectTasks">
              <el-option label="待抓取" value="pending_collect" />
              <el-option label="抓取中" value="collecting" />
              <el-option label="已提交上传" value="submitted" />
              <el-option label="抓取失败" value="collect_failed" />
              <el-option label="构建失败" value="build_failed" />
              <el-option label="上传失败" value="upload_failed" />
            </el-select>
            <span class="refresh-time">最近刷新: {{ lastTasksRefreshAt || '-' }}</span>
          </div>
        </div>
      </template>

      <el-table :data="collectTasks" size="small" border v-loading="tasksLoading">
        <el-table-column prop="id" label="任务ID" width="100" />
        <el-table-column prop="reference" label="SKU/链接" min-width="200" show-overflow-tooltip />
        <el-table-column prop="store_id" label="店铺" width="90" />
        <el-table-column prop="status" label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="taskStatusTagType(row.status)">{{ taskStatusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="upload_job_id" label="上传任务ID" width="120">
          <template #default="{ row }">{{ row.upload_job_id || '-' }}</template>
        </el-table-column>
        <el-table-column prop="error" label="错误" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">{{ row.error || '-' }}</template>
        </el-table-column>
        <el-table-column prop="updated_at" label="更新时间" width="180">
          <template #default="{ row }">{{ formatDateTime(row.updated_at) }}</template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  createCloudFollowCollectTasks,
  fetchCloudFollowCollectTasks,
  type CloudFollowCollectTask,
} from '../api/cloudFollow'
import { fetchStores } from '../api/store'

type StoreOption = {
  id: number
  store_name: string
}

type BatchResultRow = {
  sku: string
  price: string
  ok: boolean
  task_id: string
  message: string
}

const stores = ref<StoreOption[]>([])
const storeLoading = ref(false)
const submitLoading = ref(false)
const tasksLoading = ref(false)
const batchDialogVisible = ref(false)
const batchLoading = ref(false)
const batchSkuText = ref('')
const batchPriceText = ref('')
const batchResults = ref<BatchResultRow[]>([])
const collectTasks = ref<CloudFollowCollectTask[]>([])
const taskStatusFilter = ref<string>('')
const lastTasksRefreshAt = ref('')
const lastSubmittedTaskId = ref<number | null>(null)
let taskRefreshTimer: number | null = null

const form = reactive({
  store_id: undefined as number | undefined,
  reference: '',
  include_variants: true,
  max_variants: 20,
  price: '',
  old_price: '',
  follow_min_price: '',
  model: '',
})

const lastSubmittedTask = computed(() => {
  if (lastSubmittedTaskId.value == null) return null
  return collectTasks.value.find((item) => item.id === lastSubmittedTaskId.value) || null
})

const optionalText = (value: string): string | undefined => {
  const text = value.trim()
  return text ? text : undefined
}

const normalizePriceText = (value: string): string => {
  const numeric = Number(value.replace(/,/g, '').trim())
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return ''
  }
  const text = numeric.toFixed(2)
  return text.replace(/\.00$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
}

const splitTextareaLines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => Boolean(line))

const extractApiErrorMessage = (error: any, fallback: string): string => {
  const response = error?.response
  const data = response?.data
  let message = ''
  if (typeof data === 'string' && data.trim()) {
    message = data.trim()
  } else if (data && typeof data === 'object') {
    const detail = (data as Record<string, unknown>).detail
    const rawMessage = (data as Record<string, unknown>).message
    const rawError = (data as Record<string, unknown>).error
    if (typeof detail === 'string' && detail.trim()) message = detail.trim()
    else if (typeof rawMessage === 'string' && rawMessage.trim()) message = rawMessage.trim()
    else if (typeof rawError === 'string' && rawError.trim()) message = rawError.trim()
  }
  if (!message && typeof error?.message === 'string') {
    message = error.message
  }
  const statusText = typeof response?.status === 'number' ? `HTTP ${response.status}: ` : ''
  return `${statusText}${message || fallback}`
}

const formatDateTime = (value?: string | null): string => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', { hour12: false })
}

const taskStatusLabel = (status?: string): string => {
  const value = String(status || '').trim()
  if (value === 'pending_collect') return '待抓取'
  if (value === 'collecting') return '抓取中'
  if (value === 'submitted') return '已提交上传'
  if (value === 'collect_failed') return '抓取失败'
  if (value === 'build_failed') return '构建失败'
  if (value === 'upload_failed') return '上传失败'
  return value || '-'
}

const taskStatusTagType = (status?: string): 'success' | 'warning' | 'danger' | 'info' => {
  const value = String(status || '').trim()
  if (value === 'submitted') return 'success'
  if (value === 'pending_collect' || value === 'collecting') return 'warning'
  if (value === 'collect_failed' || value === 'build_failed' || value === 'upload_failed') return 'danger'
  return 'info'
}

const loadStores = async () => {
  storeLoading.value = true
  try {
    const rows = await fetchStores()
    stores.value = Array.isArray(rows) ? (rows as StoreOption[]) : []
    if (!form.store_id && stores.value.length > 0) {
      form.store_id = stores.value[0].id
    }
  } catch (error: any) {
    ElMessage.error(extractApiErrorMessage(error, '加载店铺失败'))
  } finally {
    storeLoading.value = false
  }
}

const refreshCollectTasks = async () => {
  tasksLoading.value = true
  try {
    const response = await fetchCloudFollowCollectTasks({
      status: taskStatusFilter.value || undefined,
      store_id: form.store_id,
      limit: 100,
    })
    collectTasks.value = Array.isArray(response.result) ? response.result : []
    lastTasksRefreshAt.value = formatDateTime(new Date().toISOString())
  } catch (error: any) {
    ElMessage.error(extractApiErrorMessage(error, '刷新任务列表失败'))
  } finally {
    tasksLoading.value = false
  }
}

const validateSingleSubmit = (): boolean => {
  if (!form.store_id) {
    ElMessage.warning('请先选择店铺')
    return false
  }
  if (!form.reference.trim()) {
    ElMessage.warning('请输入商品链接或SKU')
    return false
  }
  return true
}

const applyBatchPriceMultiplier = (multiplier: number) => {
  const lines = splitTextareaLines(batchPriceText.value)
  if (!lines.length) {
    ElMessage.warning('请先填写价格列表')
    return
  }
  batchPriceText.value = lines
    .map((line) => normalizePriceText(String(Number(normalizePriceText(line) || 0) * multiplier)))
    .join('\n')
}

const openBatchDialog = () => {
  if (!form.store_id) {
    ElMessage.warning('请先选择店铺')
    return
  }
  batchDialogVisible.value = true
}

const handleCreateCollectTask = async () => {
  if (!validateSingleSubmit()) return
  submitLoading.value = true
  try {
    const response = await createCloudFollowCollectTasks({
      store_id: form.store_id,
      include_variants: form.include_variants,
      max_variants: form.max_variants,
      tasks: [
        {
          reference: form.reference.trim(),
          price: optionalText(form.price),
          old_price: optionalText(form.old_price),
          follow_min_price: optionalText(form.follow_min_price),
          model: optionalText(form.model),
        },
      ],
    })
    const created = response.result?.[0]
    if (created?.id) {
      lastSubmittedTaskId.value = created.id
    }
    ElMessage.success('任务已下发给本地扩展')
    await refreshCollectTasks()
  } catch (error: any) {
    ElMessage.error(extractApiErrorMessage(error, '提交任务失败'))
  } finally {
    submitLoading.value = false
  }
}

const handleBatchCreateCollectTasks = async () => {
  if (!form.store_id) {
    ElMessage.warning('请先选择店铺')
    return
  }
  const skuLines = splitTextareaLines(batchSkuText.value)
  if (!skuLines.length) {
    ElMessage.warning('请先输入SKU列表')
    return
  }
  const priceLines = batchPriceText.value.split(/\r?\n/).map((line) => line.trim())
  const rows = skuLines.map((sku, index) => ({
    sku,
    price: normalizePriceText(priceLines[index] || ''),
  }))

  batchLoading.value = true
  batchResults.value = []
  try {
    const response = await createCloudFollowCollectTasks({
      store_id: form.store_id,
      include_variants: form.include_variants,
      max_variants: form.max_variants,
      tasks: rows.map((row) => ({
        reference: row.sku,
        price: row.price || undefined,
        old_price: optionalText(form.old_price),
        follow_min_price: optionalText(form.follow_min_price),
        model: optionalText(form.model),
      })),
    })
    const created = Array.isArray(response.result) ? response.result : []
    batchResults.value = rows.map((row, index) => {
      const task = created[index]
      return {
        sku: row.sku,
        price: row.price || '-',
        ok: Boolean(task?.id),
        task_id: task?.id ? String(task.id) : '-',
        message: task?.status ? taskStatusLabel(task.status) : '提交失败',
      }
    })
    if (created[0]?.id) {
      lastSubmittedTaskId.value = created[0].id
    }
    ElMessage.success(`批量任务已下发: ${created.length}/${rows.length}`)
    await refreshCollectTasks()
  } catch (error: any) {
    batchResults.value = rows.map((row) => ({
      sku: row.sku,
      price: row.price || '-',
      ok: false,
      task_id: '-',
      message: extractApiErrorMessage(error, '提交失败'),
    }))
    ElMessage.error(extractApiErrorMessage(error, '批量提交失败'))
  } finally {
    batchLoading.value = false
  }
}

onMounted(() => {
  void loadStores()
  void refreshCollectTasks()
  taskRefreshTimer = window.setInterval(() => {
    void refreshCollectTasks()
  }, 8000)
})

onBeforeUnmount(() => {
  if (taskRefreshTimer !== null) {
    window.clearInterval(taskRefreshTimer)
    taskRefreshTimer = null
  }
})
</script>

<style scoped>
.cloud-follow-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.page-title {
  margin: 0;
}

.page-subtitle {
  margin: 8px 0 0;
  color: var(--c-text-3);
  font-size: var(--font-size-sm);
}

.panel-card {
  border-radius: var(--radius-sm);
  border: 1px solid var(--c-border-1);
}

.action-row {
  display: flex;
  gap: 12px;
  margin-top: 4px;
}

.hint-row {
  margin-top: 10px;
  color: var(--c-text-2);
  font-size: var(--font-size-sm);
}

.card-header {
  font-weight: 650;
}

.task-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.task-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.refresh-time {
  color: var(--c-text-3);
  font-size: var(--font-size-sm);
}

.batch-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.batch-column {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.batch-title {
  font-size: var(--font-size-sm);
  color: var(--c-text-2);
  font-weight: 600;
}

.batch-price-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.batch-hint {
  color: var(--c-text-2);
  font-size: var(--font-size-sm);
}

.batch-result-table {
  margin-top: 14px;
}

.batch-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
