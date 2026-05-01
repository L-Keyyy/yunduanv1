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
import { ref, onMounted } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { fetchNotifications } from '../api/notifications'

const router = useRouter()
const messages = ref<any[]>([])
const loading = ref(false)

const fetchMessages = async () => {
  loading.value = true
  try {
    const data = await fetchNotifications()
    messages.value = data.result || []
  } catch (error) {
    console.error('Failed to fetch messages:', error)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  fetchMessages()
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
