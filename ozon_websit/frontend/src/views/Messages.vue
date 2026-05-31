<template>
  <div class="messages-container">
    <div class="page-header">
      <h2 class="page-title">消息提醒</h2>
      <el-button type="primary" :icon="Refresh" @click="fetchMessages" :loading="loading">刷新消息</el-button>
    </div>

    <el-card shadow="never" class="messages-card">
      <el-table
        :data="messages"
        style="width: 100%"
        v-loading="loading"
        header-cell-class-name="table-header"
      >
        <el-table-column label="类型" width="120">
          <template #default="{ row }">
            <el-tag :type="row.type === 'order' ? 'warning' : 'success'">
              {{ row.type === 'order' ? '订单预警' : '活动预警' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" width="200" />
        <el-table-column prop="desc" label="详细内容" />
        <el-table-column prop="created_at" label="时间" width="180">
          <template #default="{ row }">
            {{ formatTime(row.created_at) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="goToDetail(row)">去处理</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onActivated, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { fetchNotifications } from '../api/notifications'
import { getAuthUser } from '../utils/auth'

const router = useRouter()
const MESSAGE_FETCH_INTERVAL_MS = 60 * 60 * 1000
const MESSAGE_LIST_CACHE_PREFIX = 'ozon_messages_list_cache:v1:'
const MESSAGE_LAST_FETCH_PREFIX = 'ozon_messages_last_fetch_at:v1:'
const messages = ref<any[]>([])
const loading = ref(false)
let hasCompletedInitialLoad = false

const resolveMessageOwnerKey = () => {
  const username = (getAuthUser()?.username || 'anonymous').trim().toLowerCase()
  return username || 'anonymous'
}

const resolveMessageListCacheKey = () =>
  `${MESSAGE_LIST_CACHE_PREFIX}${resolveMessageOwnerKey()}`

const resolveMessageLastFetchKey = () =>
  `${MESSAGE_LAST_FETCH_PREFIX}${resolveMessageOwnerKey()}`

const readMessageCache = (): any[] | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(resolveMessageListCacheKey())
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const writeMessageCache = (list: any[]) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(resolveMessageListCacheKey(), JSON.stringify(Array.isArray(list) ? list : []))
  } catch {
    // ignore storage failures
  }
}

const readMessageLastFetchAt = () => {
  if (typeof window === 'undefined') return 0
  try {
    const raw = localStorage.getItem(resolveMessageLastFetchKey())
    const numeric = Number(raw || 0)
    return Number.isFinite(numeric) ? numeric : 0
  } catch {
    return 0
  }
}

const writeMessageLastFetchAt = (timestamp: number) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(resolveMessageLastFetchKey(), String(timestamp))
  } catch {
    // ignore storage failures
  }
}

const canFetchMessagesNow = () =>
  Date.now() - readMessageLastFetchAt() >= MESSAGE_FETCH_INTERVAL_MS

type MessageFetchOptions = {
  silentWhenLimited?: boolean
  forceRefresh?: boolean
  background?: boolean
}

const fetchMessages = async (
  options: MessageFetchOptions | MouseEvent = {},
) => {
  const normalizedOptions: MessageFetchOptions =
    typeof MouseEvent !== 'undefined' && options instanceof MouseEvent
      ? { forceRefresh: true }
      : (options as MessageFetchOptions)
  const cached = readMessageCache()
  if (cached) {
    messages.value = cached
  }

  const shouldRequest = Boolean(normalizedOptions.forceRefresh) || canFetchMessagesNow() || !cached
  if (!shouldRequest) {
    messages.value = cached || []
    if (!normalizedOptions.silentWhenLimited) {
      ElMessage.info('消息1小时内只抓取一次，当前展示缓存数据')
    }
    return
  }

  const showLoading = !cached || (!normalizedOptions.background && Boolean(normalizedOptions.forceRefresh))
  if (showLoading) {
    loading.value = true
  }
  try {
    const data = await fetchNotifications()
    const latestMessages = Array.isArray(data.result) ? data.result : []
    messages.value = latestMessages
    writeMessageCache(latestMessages)
    writeMessageLastFetchAt(Date.now())
  } catch (error) {
    console.error('Failed to fetch messages:', error)
    if (cached) {
      messages.value = cached
    }
  } finally {
    if (showLoading) {
      loading.value = false
    }
  }
}

onMounted(async () => {
  await fetchMessages({ silentWhenLimited: true, background: true })
  hasCompletedInitialLoad = true
})

onActivated(() => {
  if (!hasCompletedInitialLoad) {
    return
  }
  void fetchMessages({ silentWhenLimited: true, background: true })
})

const goToDetail = (alert: any) => {
  if (alert.type === 'order') {
    router.push({ path: '/orders', query: { highlight: alert.target_id } })
  } else if (alert.type === 'promo') {
    router.push({ path: '/activities', query: { highlight: alert.target_id } })
  }
}

const formatTime = (timeStr: string) => {
  if (!timeStr) return '-'
  try {
    const d = new Date(timeStr)
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return timeStr
  }
}
</script>

<style scoped>
.messages-container {
  padding: 0;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-5);
}
.messages-card {
  border-radius: var(--radius-sm);
  border: 1px solid var(--c-border-1);
}
:deep(.table-header) {
  background: var(--c-surface-2) !important;
  color: var(--c-text-2);
  font-weight: 650;
  font-size: var(--font-size-xs);
}
</style>
