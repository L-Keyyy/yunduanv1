<template>
  <div class="cloud-follow-page">
    <div class="page-header">
      <div>
        <h2 class="page-title">精准跟卖商品</h2>
        <p class="page-subtitle">输入商品链接或 SKU，高效铺货。</p>
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
            <el-form-item label="浏览器会话">
              <el-switch v-model="form.use_browser_session" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="8">
            <el-form-item label="价格(可选)">
              <el-input v-model="form.price" placeholder="留空使用抓取价格" clearable />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="划线价(可选)">
              <el-input v-model="form.old_price" placeholder="留空则不覆盖" clearable />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="最低价(可选)">
              <el-input v-model="form.follow_min_price" placeholder="留空则不覆盖" clearable />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="型号(可选)">
              <el-input v-model="form.model" placeholder="留空则使用抓取值" clearable />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="URL 片段(可选)">
              <el-input v-model="form.preferred_url_fragment" placeholder="/product/xxx/" clearable />
            </el-form-item>
          </el-col>
        </el-row>

        <div class="action-row">
          <el-button :loading="configLoading" @click="configDialogVisible = true">配置</el-button>
          <el-button type="primary" :loading="previewLoading" @click="handlePreview">预览数据</el-button>
          <el-button type="success" :loading="submitLoading" @click="handleCreateCollectTask">提交铺货</el-button>
          <el-button :loading="batchLoading" @click="openBatchDialog">批量SKU</el-button>
        </div>
      </el-form>
    </el-card>

    <el-dialog v-model="configDialogVisible" title="配置" width="760px">
      <el-form label-width="110px">
        <el-form-item label="Front Cookie">
          <el-input
            v-model="form.front_cookie"
            type="textarea"
            :rows="4"
            placeholder="可选：用于服务端直接请求入口数据"
          />
        </el-form-item>
        <el-form-item label="User-Agent">
          <el-input
            v-model="form.user_agent"
            type="textarea"
            :rows="3"
            placeholder="可选：与 Cookie 配合请求"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="configDialogVisible = false">关闭</el-button>
        <el-button type="primary" :loading="configSaving" @click="handleSaveConfig">保存配置</el-button>
      </template>
    </el-dialog>

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
          <div class="batch-title">价格列表（可选，与SKU按行对应）</div>
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
        <el-table-column prop="job_id" label="任务ID" min-width="120" />
        <el-table-column prop="message" label="消息" min-width="260" show-overflow-tooltip />
      </el-table>

      <template #footer>
        <div class="batch-footer">
          <el-button @click="batchDialogVisible = false">关闭</el-button>
          <el-button type="success" :loading="batchLoading" @click="handleBatchCreateCollectTasks">开始批量提交</el-button>
        </div>
      </template>
    </el-dialog>

    <el-card v-if="previewData" shadow="never" class="panel-card">
      <template #header>
        <div class="card-header">预览结果</div>
      </template>
      <el-descriptions :column="3" border>
        <el-descriptions-item label="商品ID">{{ previewData.resolved_product_id }}</el-descriptions-item>
        <el-descriptions-item label="标题">{{ previewData.title || '-' }}</el-descriptions-item>
        <el-descriptions-item label="抓取源">{{ previewData.fetch_source || '-' }}</el-descriptions-item>
        <el-descriptions-item label="变体数">{{ previewData.variant_count }}</el-descriptions-item>
        <el-descriptions-item label="特征数">{{ previewData.characteristics_count }}</el-descriptions-item>
        <el-descriptions-item label="有描述">
          <el-tag :type="previewData.has_description ? 'success' : 'danger'">
            {{ previewData.has_description ? '是' : '否' }}
          </el-tag>
        </el-descriptions-item>
      </el-descriptions>
      <div class="meta-row">
        <span>来源链接：</span>
        <a :href="previewData.source_url" target="_blank" rel="noopener noreferrer">
          {{ previewData.source_url }}
        </a>
      </div>
      <div v-if="previewVariants.length > 0" class="table-wrap">
        <div class="table-title">变体预览（最多显示 30 条）</div>
        <el-table :data="previewVariants" size="small" border>
          <el-table-column prop="productId" label="Product ID" width="140" />
          <el-table-column prop="label" label="标签" min-width="180" show-overflow-tooltip />
          <el-table-column prop="image" label="图片" min-width="260" show-overflow-tooltip />
        </el-table>
      </div>
      <div v-if="previewCharacteristics.length > 0" class="table-wrap">
        <div class="table-title">特征预览（最多显示 20 条）</div>
        <el-table :data="previewCharacteristics" size="small" border>
          <el-table-column prop="name" label="名称" min-width="180" show-overflow-tooltip />
          <el-table-column prop="value" label="值" min-width="300" show-overflow-tooltip />
        </el-table>
      </div>
    </el-card>

    <el-card v-if="submitData" shadow="never" class="panel-card">
      <template #header>
        <div class="card-header">提交结果</div>
      </template>
      <el-descriptions :column="3" border>
        <el-descriptions-item label="任务ID">{{ submitData.job_id }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ submitData.status }}</el-descriptions-item>
        <el-descriptions-item label="店铺ID">{{ submitData.store_id }}</el-descriptions-item>
        <el-descriptions-item label="上传条数">{{ submitData.item_count }}</el-descriptions-item>
        <el-descriptions-item label="模式">{{ submitData.variant_mode }}</el-descriptions-item>
        <el-descriptions-item label="跳过变体">{{ submitData.skipped_variants }}</el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  createCloudFollowCollectTasks,
  fetchCloudFollowConfig,
  previewCloudFollow,
  saveCloudFollowConfig,
  submitCloudFollow,
  submitCloudFollowAsync,
  type CloudFollowCollectTask,
  type CloudFollowPreviewPayload,
  type CloudFollowPreviewResponse,
  type CloudFollowSubmitPayload,
  type CloudFollowSubmitResponse,
} from '../api/cloudFollow'
import { fetchStores } from '../api/store'

type StoreOption = {
  id: number
  store_name: string
}

type CharacteristicRow = {
  key: string
  name: string
  value: string
}

type VariantRow = {
  key: string
  productId: string
  label: string
  image: string
}

type BatchResultRow = {
  sku: string
  price: string
  ok: boolean
  job_id: string
  message: string
}

const stores = ref<StoreOption[]>([])
const storeLoading = ref(false)
const previewLoading = ref(false)
const submitLoading = ref(false)
const previewData = ref<CloudFollowPreviewResponse | null>(null)
const submitData = ref<CloudFollowSubmitResponse | null>(null)
const configDialogVisible = ref(false)
const configLoading = ref(false)
const configSaving = ref(false)
const batchDialogVisible = ref(false)
const batchLoading = ref(false)
const batchSkuText = ref('')
const batchPriceText = ref('')
const batchResults = ref<BatchResultRow[]>([])

const form = reactive({
  store_id: undefined as number | undefined,
  reference: '',
  include_variants: true,
  max_variants: 20,
  use_browser_session: true,
  price: '',
  old_price: '',
  follow_min_price: '',
  model: '',
  preferred_url_fragment: '',
  front_cookie: '',
  user_agent: '',
})

const optionalText = (value: string): string | undefined => {
  const text = value.trim()
  return text ? text : undefined
}

const optionalNumberText = (value: string): string | undefined => {
  const text = value.trim()
  return text ? text : undefined
}

const localizeCloudFollowError = (message: string): string => {
  const text = message.trim()
  if (!text) return ''
  if (text.includes('No open Ozon buyer page was found in Chrome')) {
    return '未检测到已打开的 Ozon 买家页。请先在云端 Chrome 打开 https://www.ozon.ru 后重试。'
  }
  if (text.includes('No usable frontend session source')) {
    return '缺少可用会话。请填写 Front Cookie，或开启“浏览器会话”并在云端 Chrome 打开 Ozon。'
  }
  if (text.includes('front_cookie is required for cookie mode')) {
    return '当前为 Cookie 模式，请先填写 Front Cookie。'
  }
  if (text.includes('Ozon browser session hit Antibot challenge (403)')) {
    return '云端浏览器会话被 Ozon 风控拦截。请先在云端 Chrome 打开 ozon.ru 完成验证，或填写 Front Cookie + User-Agent。'
  }
  if (text.includes('Ozon cookie session hit Antibot challenge (403)')) {
    return 'Front Cookie 会话被 Ozon 风控拦截。请从已登录的 Ozon 买家页重新复制 Cookie 和 User-Agent。'
  }
  return text
}

const extractApiErrorMessage = (error: any, fallback: string): string => {
  const response = error?.response
  const data = response?.data
  const parts: string[] = []

  if (typeof data === 'string' && data.trim()) {
    parts.push(data.trim())
  } else if (data && typeof data === 'object') {
    const detail = (data as Record<string, unknown>).detail
    const message = (data as Record<string, unknown>).message
    const errorText = (data as Record<string, unknown>).error
    if (typeof detail === 'string' && detail.trim()) {
      parts.push(detail.trim())
    }
    if (typeof message === 'string' && message.trim()) {
      parts.push(message.trim())
    }
    if (typeof errorText === 'string' && errorText.trim()) {
      parts.push(errorText.trim())
    }
  }

  if (parts.length === 0 && typeof error?.message === 'string' && error.message.trim()) {
    parts.push(error.message.trim())
  }

  const raw = parts.find((item) => item.length > 0) || fallback
  const localized = localizeCloudFollowError(raw) || fallback
  const status = typeof response?.status === 'number' ? `HTTP ${response.status}` : ''
  return status ? `${status}: ${localized}` : localized
}

const extractRawApiDetail = (error: any): string => {
  const data = error?.response?.data
  if (typeof data === 'string') return data
  if (data && typeof data === 'object') {
    const detail = (data as Record<string, unknown>).detail
    const message = (data as Record<string, unknown>).message
    const errorText = (data as Record<string, unknown>).error
    if (typeof detail === 'string') return detail
    if (typeof message === 'string') return message
    if (typeof errorText === 'string') return errorText
  }
  if (typeof error?.message === 'string') return error.message
  return ''
}

const isAntibotChallengeError = (error: any): boolean => {
  const normalized = extractRawApiDetail(error).toLowerCase()
  if (!normalized) return false
  return (
    normalized.includes('antibot challenge page') ||
    normalized.includes('cdn1.ozone.ru/s3/abt-complaints') ||
    (normalized.includes('browser frontend fetch failed') && normalized.includes("status': 403")) ||
    (normalized.includes('browser frontend fetch failed') && normalized.includes('status=403'))
  )
}

const canRetryWithCookieMode = (): boolean => {
  return Boolean(form.use_browser_session && optionalText(form.front_cookie))
}

const isAsyncWorkerUnavailable = (error: any): boolean => {
  const status = error?.response?.status
  const data = error?.response?.data
  const detail =
    typeof data === 'string'
      ? data
      : typeof data?.detail === 'string'
        ? data.detail
        : typeof data?.message === 'string'
          ? data.message
          : ''
  if (status !== 503) return false
  const normalized = String(detail || '').toLowerCase()
  return (
    normalized.includes('async task worker is unavailable') ||
    normalized.includes('celery is not installed') ||
    normalized.includes('async task broker is unavailable') ||
    normalized.includes('localhost:6379') ||
    normalized.includes('redis worker')
  )
}

const splitTextareaLines = (value: string): string[] => {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => Boolean(line))
}

const normalizePriceText = (value: string): string => {
  const numeric = Number(value.replace(/,/g, '').trim())
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return ''
  }
  const text = numeric.toFixed(2)
  return text.replace(/\.00$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
}

const applyBatchPriceMultiplier = (multiplier: number) => {
  const lines = splitTextareaLines(batchPriceText.value)
  if (lines.length === 0) {
    ElMessage.warning('请先在右侧填入原价列表')
    return
  }
  const nextLines = lines.map((line) => {
    const normalized = normalizePriceText(line)
    if (!normalized) return ''
    return normalizePriceText(String(Number(normalized) * multiplier))
  })
  batchPriceText.value = nextLines.join('\n')
}

const buildPreviewPayload = (): CloudFollowPreviewPayload => {
  return {
    reference: form.reference.trim(),
    use_browser_session: form.use_browser_session,
    preferred_url_fragment: optionalText(form.preferred_url_fragment),
    front_cookie: optionalText(form.front_cookie),
    user_agent: optionalText(form.user_agent),
  }
}

const previewVariants = computed<VariantRow[]>(() => {
  const payload = previewData.value?.product_data
  if (!payload || typeof payload !== 'object') return []
  const rawVariants = (payload as Record<string, unknown>).variants
  if (!Array.isArray(rawVariants)) return []

  const rows: VariantRow[] = []
  rawVariants.slice(0, 30).forEach((variant, index) => {
    if (!variant || typeof variant !== 'object') return
    const entry = variant as Record<string, unknown>
    const productIdRaw = entry.productId
    const productUrlRaw = entry.productUrl
    const productId = String(productIdRaw || productUrlRaw || '').trim()
    if (!productId) return
    rows.push({
      key: `${productId}-${index}`,
      productId,
      label: String(entry.label || entry.name || entry.variantSummary || entry.title || '-'),
      image: String(entry.image || entry.imageUrl || '-'),
    })
  })
  return rows
})

const previewCharacteristics = computed<CharacteristicRow[]>(() => {
  const payload = previewData.value?.product_data
  if (!payload || typeof payload !== 'object') return []
  const rawCharacteristics = (payload as Record<string, unknown>).characteristics
  if (!Array.isArray(rawCharacteristics)) return []

  const rows: CharacteristicRow[] = []
  rawCharacteristics.slice(0, 20).forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const entry = item as Record<string, unknown>
    const name = String(entry.name || entry.title || '').trim()
    if (!name) return
    let valueText = ''
    const rawValue = entry.value ?? entry.valueText ?? entry.values ?? entry.text
    if (Array.isArray(rawValue)) {
      valueText = rawValue.map((value) => String(value)).join(', ')
    } else if (rawValue && typeof rawValue === 'object') {
      valueText = String((rawValue as Record<string, unknown>).text || '').trim()
    } else {
      valueText = String(rawValue || '').trim()
    }
    if (!valueText && Array.isArray(entry.values)) {
      valueText = entry.values.map((value) => String(value)).join(', ')
    }
    rows.push({
      key: `${name}-${index}`,
      name,
      value: valueText || '-',
    })
  })
  return rows
})

const loadCloudFollowConfig = async () => {
  configLoading.value = true
  try {
    const config = await fetchCloudFollowConfig()
    form.front_cookie = config.front_cookie || ''
    form.user_agent = config.user_agent || ''
    if (form.front_cookie) {
      form.use_browser_session = true
    }
  } catch (error: any) {
    ElMessage.error(extractApiErrorMessage(error, '加载配置失败'))
  } finally {
    configLoading.value = false
  }
}

const handleSaveConfig = async () => {
  configSaving.value = true
  try {
    const config = await saveCloudFollowConfig({
      front_cookie: optionalText(form.front_cookie) || null,
      user_agent: optionalText(form.user_agent) || null,
    })
    form.front_cookie = config.front_cookie || ''
    form.user_agent = config.user_agent || ''
    if (form.front_cookie) {
      form.use_browser_session = true
    }
    ElMessage.success('配置已保存')
    configDialogVisible.value = false
  } catch (error: any) {
    ElMessage.error(extractApiErrorMessage(error, '保存配置失败'))
  } finally {
    configSaving.value = false
  }
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

const validateReference = (): boolean => {
  if (!form.reference.trim()) {
    ElMessage.warning('请先输入商品链接或 SKU')
    return false
  }
  return true
}

const openBatchDialog = () => {
  if (!form.store_id) {
    ElMessage.warning('请先选择店铺')
    return
  }
  batchDialogVisible.value = true
}

const buildBatchPayload = (
  sku: string,
  priceText: string | undefined,
): CloudFollowSubmitPayload => {
  const previewPayload = buildPreviewPayload()
  return {
    ...previewPayload,
    reference: sku,
    store_id: form.store_id,
    include_variants: form.include_variants,
    max_variants: form.max_variants,
    price: priceText,
    old_price: optionalNumberText(form.old_price),
    follow_min_price: optionalNumberText(form.follow_min_price),
    model: optionalText(form.model),
  }
}

const verifyBatchSessionReady = async (sampleReference: string): Promise<boolean> => {
  try {
    await previewCloudFollow({
      ...buildPreviewPayload(),
      reference: sampleReference,
    })
    return true
  } catch (error: any) {
    ElMessage.error(`批量提交前检查失败：${extractApiErrorMessage(error, '会话不可用')}`)
    return false
  }
}

const verifyBatchSessionReadySafe = async (sampleReference: string): Promise<boolean> => {
  const browserReady = await verifyBatchSessionReady(sampleReference)
  if (browserReady) {
    return true
  }
  if (!canRetryWithCookieMode()) {
    return false
  }

  const payload: CloudFollowPreviewPayload = {
    ...buildPreviewPayload(),
    reference: sampleReference,
    use_browser_session: false,
  }
  try {
    await previewCloudFollow(payload)
    form.use_browser_session = false
    ElMessage.warning('Browser session unavailable, switched to cookie mode.')
    return true
  } catch (cookieError: any) {
    ElMessage.error(`Batch precheck failed: ${extractApiErrorMessage(cookieError, 'Cookie session unavailable')}`)
    return false
  }
}

const handlePreview = async () => {
  if (!validateReference()) return
  previewLoading.value = true
  submitData.value = null
  try {
    const payload = buildPreviewPayload()
    previewData.value = await previewCloudFollow(payload)
    ElMessage.success('预览成功')
  } catch (error: any) {
    ElMessage.error(extractApiErrorMessage(error, '预览失败'))
  } finally {
    previewLoading.value = false
  }
}

const handleSubmit = async () => {
  if (!validateReference()) return
  if (!form.store_id) {
    ElMessage.warning('请选择店铺')
    return
  }
  submitLoading.value = true
  try {
    const previewPayload = buildPreviewPayload()
    const payload: CloudFollowSubmitPayload = {
      ...previewPayload,
      store_id: form.store_id,
      include_variants: form.include_variants,
      max_variants: form.max_variants,
      price: optionalNumberText(form.price),
      old_price: optionalNumberText(form.old_price),
      follow_min_price: optionalNumberText(form.follow_min_price),
      model: optionalText(form.model),
    }
    try {
      submitData.value = await submitCloudFollow(payload)
    } catch (error: any) {
      if (isAntibotChallengeError(error) && canRetryWithCookieMode()) {
        submitData.value = await submitCloudFollow({
          ...payload,
          use_browser_session: false,
        })
        form.use_browser_session = false
        ElMessage.warning('Browser session blocked by Ozon challenge, switched to cookie mode.')
      } else {
        throw error
      }
    }
    ElMessage.success('铺货任务已提交')
  } catch (error: any) {
    ElMessage.error(extractApiErrorMessage(error, '提交铺货失败'))
  } finally {
    submitLoading.value = false
  }
}

const handleBatchSubmit = async () => {
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

  const sessionReady = await verifyBatchSessionReadySafe(rows[0].sku)
  if (!sessionReady) return

  batchLoading.value = true
  batchResults.value = []
  try {
    let successCount = 0
    let useAsyncSubmit = true
    let fallbackNotified = false
    for (const row of rows) {
      const payload = buildBatchPayload(row.sku, row.price || undefined)
      try {
        if (useAsyncSubmit) {
          try {
            const asyncResult = await submitCloudFollowAsync(payload)
            batchResults.value.push({
              sku: row.sku,
              price: row.price || '-',
              ok: true,
              job_id: asyncResult.task_id || '-',
              message: asyncResult.message || asyncResult.status || 'queued',
            })
            successCount += 1
            continue
          } catch (error: any) {
            if (!isAsyncWorkerUnavailable(error)) {
              throw error
            }
            useAsyncSubmit = false
            if (!fallbackNotified) {
              ElMessage.warning('检测到后端未启用异步 Worker，已自动切换为同步提交。')
              fallbackNotified = true
            }
          }
        }

        let syncResult: CloudFollowSubmitResponse
        try {
          syncResult = await submitCloudFollow(payload)
        } catch (error: any) {
          if (isAntibotChallengeError(error) && canRetryWithCookieMode()) {
            syncResult = await submitCloudFollow({
              ...payload,
              use_browser_session: false,
            })
            form.use_browser_session = false
            ElMessage.warning('Browser session blocked by Ozon challenge, switched to cookie mode.')
          } else {
            throw error
          }
        }
        submitData.value = syncResult
        batchResults.value.push({
          sku: row.sku,
          price: row.price || '-',
          ok: true,
          job_id: syncResult.job_id || '-',
          message: syncResult.status || 'submitted',
        })
        successCount += 1
      } catch (error: any) {
        batchResults.value.push({
          sku: row.sku,
          price: row.price || '-',
          ok: false,
          job_id: '-',
          message: extractApiErrorMessage(error, '提交失败'),
        })
      }
    }
    if (successCount === rows.length) {
      ElMessage.success(`批量提交完成: ${successCount}/${rows.length}`)
    } else if (successCount > 0) {
      ElMessage.warning(`批量提交部分失败: ${successCount}/${rows.length}`)
    } else {
      ElMessage.error(`批量提交失败: ${successCount}/${rows.length}`)
    }
  } finally {
    batchLoading.value = false
  }
}

const collectTaskToSubmitData = (task: CloudFollowCollectTask): CloudFollowSubmitResponse => {
  return {
    ok: true,
    job_id: String(task.id),
    status: task.status,
    store_id: task.store_id,
    item_count: 0,
    variant_mode: task.include_variants ? 'extension_collect_variants' : 'extension_collect_single',
    resolved_product_id: Number(task.resolved_product_id || 0),
    source_url: task.source_url || '',
    skipped_variants: 0,
  }
}

const handleCreateCollectTask = async () => {
  if (!validateReference()) return
  if (!form.store_id) {
    ElMessage.warning('请选择店铺')
    return
  }
  submitLoading.value = true
  try {
    const response = await createCloudFollowCollectTasks({
      store_id: form.store_id,
      include_variants: form.include_variants,
      max_variants: form.max_variants,
      tasks: [
        {
          reference: form.reference.trim(),
          price: optionalNumberText(form.price),
          old_price: optionalNumberText(form.old_price),
          follow_min_price: optionalNumberText(form.follow_min_price),
          model: optionalText(form.model),
        },
      ],
    })
    if (response.result.length > 0) {
      submitData.value = collectTaskToSubmitData(response.result[0])
    }
    ElMessage.success('已创建扩展采集任务')
  } catch (error: any) {
    ElMessage.error(extractApiErrorMessage(error, '提交铺货失败'))
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
        old_price: optionalNumberText(form.old_price),
        follow_min_price: optionalNumberText(form.follow_min_price),
        model: optionalText(form.model),
      })),
    })
    batchResults.value = response.result.map((task, index) => ({
      sku: rows[index]?.sku || task.reference,
      price: rows[index]?.price || '-',
      ok: true,
      job_id: String(task.id),
      message: task.status || 'pending_collect',
    }))
    if (response.result.length > 0) {
      submitData.value = collectTaskToSubmitData(response.result[0])
    }
    ElMessage.success(`已创建扩展采集任务: ${response.result.length}/${rows.length}`)
  } catch (error: any) {
    batchResults.value = rows.map((row) => ({
      sku: row.sku,
      price: row.price || '-',
      ok: false,
      job_id: '-',
      message: extractApiErrorMessage(error, '提交失败'),
    }))
    ElMessage.error(extractApiErrorMessage(error, '提交失败'))
  } finally {
    batchLoading.value = false
  }
}

void handleSubmit
void handleBatchSubmit

onMounted(() => {
  void loadStores()
  void loadCloudFollowConfig()
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

.card-header {
  font-weight: 650;
}

.meta-row {
  margin-top: 12px;
  color: var(--c-text-2);
  font-size: var(--font-size-sm);
  word-break: break-all;
}

.table-wrap {
  margin-top: 16px;
}

.table-title {
  margin-bottom: 8px;
  color: var(--c-text-2);
  font-size: var(--font-size-sm);
  font-weight: 600;
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
