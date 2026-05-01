<template>
  <router-view v-if="isStandaloneRoute" />

  <el-container v-else class="layout-container">
    <el-aside width="200px">
      <div class="logo">
        <h2>欧卖通</h2>
      </div>
      <el-menu :default-active="$route.path" class="el-menu-vertical" router>
        <el-menu-item index="/dashboard">
          <template #title>仪表盘</template>
        </el-menu-item>
        <el-menu-item index="/store-management">
          <template #title>店铺管理</template>
        </el-menu-item>
        <el-menu-item index="/upload-records">
          <template #title>上传记录</template>
        </el-menu-item>
        <el-menu-item index="/products">
          <template #title>商品管理</template>
        </el-menu-item>
        <el-menu-item index="/inventory">
          <template #title>库存管理</template>
        </el-menu-item>
        <el-menu-item index="/orders">
          <template #title>订单管理</template>
        </el-menu-item>
        <el-menu-item index="/messages">
          <template #title>消息提醒</template>
        </el-menu-item>
        <el-menu-item index="/activities">
          <template #title>活动管理</template>
        </el-menu-item>
        <el-menu-item index="/data-analysis">
          <template #title>数据分析</template>
        </el-menu-item>
        <el-menu-item index="/commissions">
          <template #title>类目佣金</template>
        </el-menu-item>
        <el-menu-item index="/hot-tags">
          <template #title>热门标签</template>
        </el-menu-item>
        <el-menu-item index="/pricing-calculator">
          <template #title>定价计算器</template>
        </el-menu-item>
        <el-menu-item index="/cloud-follow">
          <template #title>批量铺货</template>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="header-left"></div>
        <div class="header-right">
          <el-popover placement="bottom" title="预警通知" :width="300" trigger="click">
            <template #reference>
              <el-badge
                :value="alerts.length"
                :max="99"
                class="notification-badge"
                :hidden="alerts.length === 0"
              >
                <el-button circle :icon="Bell" />
              </el-badge>
            </template>

            <div class="alert-list">
              <div v-if="alerts.length === 0" class="no-alerts">暂无预警消息</div>
              <div
                v-for="alert in alerts"
                :key="alert.id"
                class="alert-item"
                @click="handleItemClick(alert)"
              >
                <div class="alert-title">
                  <el-icon v-if="alert.type === 'order'"><Warning /></el-icon>
                  <el-icon v-else-if="alert.type === 'promo'"><Money /></el-icon>
                  {{ alert.title }}
                </div>
                <div class="alert-desc">{{ alert.desc }}</div>
              </div>

              <el-button
                v-if="alerts.length > 0"
                type="primary"
                link
                style="width: 100%; margin-top: 10px"
                @click="clearAllAlerts"
              >
                清空全部消息
              </el-button>
            </div>
          </el-popover>

          <el-avatar
            size="small"
            src="https://cube.elemecdn.com/3/7c/3ea6beec64369c2642b92c6726f1epng.png"
          />
          <span class="user-name">{{ usernameLabel }}</span>
          <el-button text @click="logout">退出</el-button>
        </div>
      </el-header>

      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Bell, Money, Warning } from '@element-plus/icons-vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchNotifications as getNotifications } from './api/notifications'
import {
  AUTH_SESSION_EVENT,
  clearAuthSession,
  getAuthUsername,
  isAuthenticated,
} from './utils/auth'

const router = useRouter()
const route = useRoute()

const alerts = ref<any[]>([])
const usernameLabel = ref(getAuthUsername() || '未登录')
let pollInterval: number | null = null

const isPublicRoute = computed(() => Boolean(route.meta.public))
const isAdminRoute = computed(() => route.path.startsWith('/admin'))
const isStandaloneRoute = computed(() => isPublicRoute.value || isAdminRoute.value)

const refreshAuthState = () => {
  usernameLabel.value = getAuthUsername() || '未登录'
}

const fetchNotifications = async () => {
  if (isStandaloneRoute.value || !isAuthenticated()) {
    alerts.value = []
    return
  }

  try {
    const data = await getNotifications()
    alerts.value = data.result || []
  } catch (error) {
    console.error('Failed to fetch notifications:', error)
  }
}

const startPolling = () => {
  if (pollInterval !== null) {
    return
  }

  void fetchNotifications()
  pollInterval = window.setInterval(fetchNotifications, 5 * 60 * 1000)
}

const stopPolling = () => {
  if (pollInterval !== null) {
    window.clearInterval(pollInterval)
    pollInterval = null
  }
}

watch(
  () => [route.fullPath, isPublicRoute.value],
  () => {
    refreshAuthState()
    if (isStandaloneRoute.value || !isAuthenticated()) {
      stopPolling()
      alerts.value = []
      return
    }
    startPolling()
  },
  { immediate: true }
)

onMounted(() => {
  refreshAuthState()
  window.addEventListener(AUTH_SESSION_EVENT, refreshAuthState)
  window.addEventListener('storage', refreshAuthState)
})

onUnmounted(() => {
  window.removeEventListener(AUTH_SESSION_EVENT, refreshAuthState)
  window.removeEventListener('storage', refreshAuthState)
  stopPolling()
})

const handleItemClick = (alert: any) => {
  if (alert.type === 'order') {
    void router.push({ path: '/orders', query: { highlight: alert.target_id } })
  } else if (alert.type === 'promo') {
    void router.push({ path: '/activities', query: { highlight: alert.target_id } })
  }
}

const clearAllAlerts = () => {
  alerts.value = []
}

const logout = async () => {
  clearAuthSession()
  stopPolling()
  alerts.value = []
  await router.replace('/login')
}
</script>

<style>
.layout-container {
  height: 100vh;
}

.el-aside {
  background: var(--c-surface-1);
  border-right: 1px solid var(--c-border-1);
}

.logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-bottom: 1px solid var(--c-border-1);
  color: var(--c-brand);
  letter-spacing: 0.3px;
}

.el-menu-vertical {
  border-right: none;
}

.header {
  background: var(--c-surface-1);
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--c-border-1);
  box-shadow: var(--shadow-1);
}

.header-right {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.notification-badge {
  margin-top: 4px;
}

.alert-item {
  padding: var(--space-3);
  border-bottom: 1px solid var(--c-border-1);
  cursor: pointer;
  transition: background-color 0.2s ease, transform 0.2s ease;
}

.alert-item:hover {
  background: var(--c-surface-2);
}

.alert-item:last-child {
  border-bottom: none;
}

.alert-title {
  font-weight: bold;
  color: color-mix(in oklch, var(--c-danger) 92%, var(--c-text-1));
  margin-bottom: var(--space-2);
}

.alert-desc {
  font-size: 12px;
  color: var(--c-text-2);
}

.no-alerts {
  text-align: center;
  color: var(--c-text-3);
  padding: var(--space-6) 0;
}

.user-name {
  font-size: var(--font-size-md);
  color: var(--c-text-2);
}

.el-main {
  padding: var(--space-5);
}
</style>
