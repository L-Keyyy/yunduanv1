<template>
  <div class="admin-shell">
    <aside class="admin-aside">
      <div class="admin-logo">
        <span>OMT</span>
        <strong>后台管理</strong>
      </div>
      <nav class="admin-nav">
        <button
          v-for="item in navItems"
          :key="item.name"
          type="button"
          :class="{ active: activeTab === item.name }"
          @click="activeTab = item.name"
        >
          {{ item.label }}
        </button>
      </nav>
    </aside>

    <section class="admin-main">
      <header class="admin-header">
        <div>
          <p class="eyebrow">SaaS Control Plane</p>
          <h1>系统管理</h1>
        </div>
        <div class="header-actions">
          <el-button :loading="loading" @click="loadData">刷新</el-button>
          <el-button type="danger" plain @click="logout">退出</el-button>
        </div>
      </header>

      <el-alert
        v-if="errorMessage"
        type="error"
        :closable="false"
        show-icon
        class="admin-alert"
        :title="errorMessage"
      />

      <section class="metric-grid">
        <article v-for="card in metricCards" :key="card.label" class="metric-card">
          <span>{{ card.label }}</span>
          <strong>{{ card.value }}</strong>
        </article>
      </section>

      <el-tabs v-model="activeTab" class="admin-tabs">
        <el-tab-pane label="租户" name="tenants">
          <div class="table-toolbar">
            <h2>租户与套餐</h2>
            <el-button type="primary" @click="openCreateTenant">新建租户</el-button>
          </div>
          <el-table v-loading="loading" :data="tenants" border>
            <el-table-column prop="name" label="租户" min-width="180" />
            <el-table-column prop="slug" label="标识" min-width="140" />
            <el-table-column prop="plan_code" label="套餐" width="110" />
            <el-table-column label="订阅" width="110">
              <template #default="{ row }">
                <el-tag :type="row.subscription_status === 'active' ? 'success' : 'info'">
                  {{ row.subscription_status }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="stores_count" label="店铺" width="90" />
            <el-table-column prop="store_limit" label="店铺额度" width="110" />
            <el-table-column prop="users_count" label="用户" width="90" />
            <el-table-column prop="user_limit" label="用户额度" width="110" />
            <el-table-column label="操作" width="110" fixed="right">
              <template #default="{ row }">
                <el-button type="primary" link @click="openEditTenant(row)">编辑</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="用户" name="users">
          <div class="table-toolbar">
            <h2>用户与角色</h2>
            <div class="toolbar-actions">
              <el-select v-model="userTenantFilter" clearable placeholder="全部租户" style="width: 180px">
                <el-option
                  v-for="tenant in tenants"
                  :key="tenant.id"
                  :label="tenant.name"
                  :value="tenant.id"
                />
              </el-select>
              <el-input
                v-model="userSearch"
                clearable
                placeholder="搜索账号"
                style="width: 180px"
                @keyup.enter="loadUsers"
              />
              <el-button @click="loadUsers">筛选</el-button>
              <el-button type="primary" @click="openCreateUser">新建用户</el-button>
            </div>
          </div>
          <el-table v-loading="loading" :data="users" border>
            <el-table-column prop="username" label="账号" min-width="140" />
            <el-table-column prop="display_name" label="名称" min-width="140" />
            <el-table-column prop="tenant_name" label="租户" min-width="160" />
            <el-table-column label="角色" min-width="220">
              <template #default="{ row }">
                <el-tag
                  v-for="role in row.roles"
                  :key="role"
                  class="role-tag"
                  :type="role === 'super_admin' ? 'danger' : role === 'tenant_admin' ? 'warning' : 'info'"
                >
                  {{ role }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.is_active ? 'success' : 'danger'">
                  {{ row.is_active ? '启用' : '停用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="last_login_at" label="最近登录" width="180">
              <template #default="{ row }">{{ formatDate(row.last_login_at) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="110" fixed="right">
              <template #default="{ row }">
                <el-button type="primary" link @click="openEditUser(row)">编辑</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="权限" name="roles">
          <section class="split-grid">
            <el-card shadow="never">
              <template #header>角色</template>
              <el-table v-loading="loading" :data="roles" size="small">
                <el-table-column prop="code" label="角色码" min-width="130" />
                <el-table-column prop="name" label="名称" min-width="140" />
                <el-table-column prop="scope" label="范围" width="90" />
              </el-table>
            </el-card>

            <el-card shadow="never">
              <template #header>权限点</template>
              <el-table v-loading="loading" :data="permissions" size="small">
                <el-table-column prop="code" label="权限码" min-width="150" />
                <el-table-column prop="name" label="名称" min-width="140" />
                <el-table-column prop="group" label="分组" width="110" />
              </el-table>
            </el-card>
          </section>
        </el-tab-pane>

        <el-tab-pane label="菜单" name="menus">
          <el-table v-loading="loading" :data="menus" border>
            <el-table-column prop="title" label="菜单" min-width="160" />
            <el-table-column prop="code" label="编码" min-width="150" />
            <el-table-column prop="path" label="路径" min-width="180" />
            <el-table-column prop="required_permission" label="权限" min-width="160" />
            <el-table-column prop="sort_order" label="排序" width="90" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.is_active ? 'success' : 'info'">
                  {{ row.is_active ? '启用' : '停用' }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="缓存" name="cache">
          <div class="table-toolbar">
            <h2>缓存与抓取兜底</h2>
            <div class="toolbar-actions">
              <el-select v-model="cacheScope" style="width: 180px">
                <el-option label="全部缓存" value="all" />
                <el-option label="活动缓存" value="activity" />
                <el-option label="Seller 类目缓存" value="seller_market" />
                <el-option label="热门标签缓存" value="hot_tags" />
                <el-option label="商品市场缓存" value="product_market" />
              </el-select>
              <el-button type="warning" :loading="submitting" @click="clearCache">清理缓存</el-button>
              <el-button type="primary" :loading="submitting" @click="syncSellerAnalyticsCache">
                同步 Seller 分析缓存
              </el-button>
            </div>
          </div>
          <section class="cache-grid">
            <article v-for="item in cacheCards" :key="item.label" class="cache-card">
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
            </article>
          </section>
        </el-tab-pane>

        <el-tab-pane label="任务监控" name="taskMonitor">
          <div class="table-toolbar">
            <h2>任务队列与系统告警</h2>
            <div class="toolbar-actions">
              <el-tag type="info">全局上传店铺：{{ taskMonitor?.upload_active_global_stores ?? 0 }}</el-tag>
              <el-tag :type="(taskMonitor?.upload_queue_backlog ?? 0) > 96 ? 'warning' : 'success'">
                上传排队：{{ taskMonitor?.upload_queue_backlog ?? 0 }}
              </el-tag>
              <el-button @click="loadTaskMonitor">刷新监控</el-button>
            </div>
          </div>

          <section class="cache-grid">
            <article v-for="item in uploadStatusCards" :key="`upload-${item.label}`" class="cache-card">
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
            </article>
            <article v-for="item in syncStatusCards" :key="`sync-${item.label}`" class="cache-card">
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
            </article>
          </section>

          <el-alert
            v-for="alert in systemAlerts"
            :key="alert.code"
            class="admin-alert"
            :type="alert.status === 'alert' ? (alert.severity === 'critical' ? 'error' : 'warning') : 'info'"
            :closable="false"
            show-icon
            :title="`${alert.code}: ${alert.message}`"
          />

          <div class="table-toolbar sub-toolbar">
            <h2>最近上传任务</h2>
          </div>
          <el-table v-loading="loading" :data="taskMonitor?.recent_upload_jobs || []" border>
            <el-table-column prop="id" label="ID" width="80" />
            <el-table-column prop="store_name" label="店铺" min-width="150" />
            <el-table-column prop="status" label="状态" width="130">
              <template #default="{ row }">
                <el-tag :type="taskStatusTag(row.status)">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="item_count" label="SKU" width="80" />
            <el-table-column label="重试" width="100">
              <template #default="{ row }">{{ row.attempt_count }}/{{ row.max_attempts }}</template>
            </el-table-column>
            <el-table-column prop="next_refresh_at" label="下次轮询" width="180">
              <template #default="{ row }">{{ formatDate(row.next_refresh_at) }}</template>
            </el-table-column>
            <el-table-column prop="error" label="错误" min-width="220" show-overflow-tooltip />
          </el-table>

          <div class="table-toolbar sub-toolbar">
            <h2>最近同步任务</h2>
          </div>
          <el-table v-loading="loading" :data="taskMonitor?.recent_sync_runs || []" border>
            <el-table-column prop="id" label="ID" width="80" />
            <el-table-column prop="tenant_name" label="客户" min-width="150" />
            <el-table-column label="任务" width="130">
              <template #default="{ row }">{{ jobTypeLabel(row.job_type) }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="110">
              <template #default="{ row }">
                <el-tag :type="taskStatusTag(row.status)">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="triggered_by" label="触发" width="120" />
            <el-table-column prop="started_at" label="开始" width="180">
              <template #default="{ row }">{{ formatDate(row.started_at) }}</template>
            </el-table-column>
            <el-table-column prop="error" label="错误" min-width="220" show-overflow-tooltip />
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="同步计划" name="syncSchedules">
          <div class="table-toolbar">
            <h2>同步计划</h2>
            <div class="toolbar-actions">
              <el-select
                v-model="scheduleTenantFilter"
                clearable
                placeholder="全部租户"
                style="width: 180px"
              >
                <el-option
                  v-for="tenant in tenants"
                  :key="tenant.id"
                  :label="tenant.name"
                  :value="tenant.id"
                />
              </el-select>
              <el-button @click="loadSchedules">筛选</el-button>
              <el-button type="primary" @click="openCreateSchedule">新建计划</el-button>
            </div>
          </div>
          <el-table v-loading="loading" :data="syncSchedules" border>
            <el-table-column prop="name" label="计划" min-width="160" />
            <el-table-column prop="tenant_name" label="租户" min-width="150" />
            <el-table-column prop="store_name" label="店铺" min-width="140">
              <template #default="{ row }">{{ row.store_name || '全部店铺' }}</template>
            </el-table-column>
            <el-table-column label="任务" width="130">
              <template #default="{ row }">{{ jobTypeLabel(row.job_type) }}</template>
            </el-table-column>
            <el-table-column label="间隔" width="100">
              <template #default="{ row }">{{ row.interval_minutes }} 分钟</template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag :type="row.enabled ? 'success' : 'info'">
                  {{ row.enabled ? '启用' : '停用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="上次结果" width="120">
              <template #default="{ row }">
                <el-tag :type="row.last_status === 'failed' ? 'danger' : row.last_status === 'success' ? 'success' : 'info'">
                  {{ row.last_status || 'idle' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="next_run_at" label="下次执行" width="180">
              <template #default="{ row }">{{ formatDate(row.next_run_at) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="170" fixed="right">
              <template #default="{ row }">
                <el-button type="primary" link @click="openEditSchedule(row)">编辑</el-button>
                <el-button type="warning" link @click="runSchedule(row)">运行</el-button>
              </template>
            </el-table-column>
          </el-table>

          <div class="table-toolbar sub-toolbar">
            <h2>运行记录</h2>
            <el-button @click="loadSyncRuns">刷新记录</el-button>
          </div>
          <el-table v-loading="loading" :data="syncRuns" border>
            <el-table-column prop="id" label="ID" width="80" />
            <el-table-column prop="tenant_name" label="租户" min-width="150" />
            <el-table-column label="任务" width="130">
              <template #default="{ row }">{{ jobTypeLabel(row.job_type) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag :type="row.status === 'failed' ? 'danger' : row.status === 'success' ? 'success' : 'info'">
                  {{ row.status }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="triggered_by" label="触发" width="120" />
            <el-table-column prop="started_at" label="开始" width="180">
              <template #default="{ row }">{{ formatDate(row.started_at) }}</template>
            </el-table-column>
            <el-table-column prop="finished_at" label="结束" width="180">
              <template #default="{ row }">{{ formatDate(row.finished_at) }}</template>
            </el-table-column>
            <el-table-column prop="error" label="错误" min-width="180" />
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="登录日志" name="loginLogs">
          <el-table v-loading="loading" :data="loginLogs" border>
            <el-table-column prop="username" label="账号" min-width="140" />
            <el-table-column prop="role_scope" label="范围" width="100" />
            <el-table-column label="结果" width="100">
              <template #default="{ row }">
                <el-tag :type="row.success ? 'success' : 'danger'">
                  {{ row.success ? '成功' : '失败' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="failure_reason" label="失败原因" min-width="140" />
            <el-table-column prop="ip_address" label="IP" min-width="130" />
            <el-table-column prop="created_at" label="时间" width="180">
              <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="审计日志" name="auditLogs">
          <el-table v-loading="loading" :data="auditLogs" border>
            <el-table-column prop="actor_username" label="操作者" min-width="140" />
            <el-table-column prop="action" label="动作" min-width="160" />
            <el-table-column prop="resource_type" label="资源" width="120" />
            <el-table-column prop="resource_id" label="资源ID" width="120" />
            <el-table-column prop="ip_address" label="IP" min-width="130" />
            <el-table-column prop="created_at" label="时间" width="180">
              <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </section>

    <el-dialog v-model="tenantDialogVisible" :title="tenantEditingId ? '编辑租户' : '新建租户'" width="560px">
      <el-form :model="tenantForm" label-width="110px">
        <el-form-item label="租户名称">
          <el-input v-model="tenantForm.name" />
        </el-form-item>
        <el-form-item v-if="!tenantEditingId" label="租户标识">
          <el-input v-model="tenantForm.slug" placeholder="留空自动生成" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="tenantForm.status">
            <el-option label="active" value="active" />
            <el-option label="paused" value="paused" />
            <el-option label="disabled" value="disabled" />
          </el-select>
        </el-form-item>
        <el-form-item label="套餐">
          <el-input v-model="tenantForm.plan_code" />
        </el-form-item>
        <el-form-item label="订阅状态">
          <el-select v-model="tenantForm.subscription_status">
            <el-option label="active" value="active" />
            <el-option label="trialing" value="trialing" />
            <el-option label="past_due" value="past_due" />
            <el-option label="cancelled" value="cancelled" />
          </el-select>
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="店铺额度">
            <el-input-number v-model="tenantForm.store_limit" :min="0" />
          </el-form-item>
          <el-form-item label="用户额度">
            <el-input-number v-model="tenantForm.user_limit" :min="0" />
          </el-form-item>
          <el-form-item label="日创建额度">
            <el-input-number v-model="tenantForm.max_daily_create" :min="0" />
          </el-form-item>
          <el-form-item label="日更新额度">
            <el-input-number v-model="tenantForm.max_daily_update" :min="0" />
          </el-form-item>
          <el-form-item label="商品总额度">
            <el-input-number v-model="tenantForm.max_total_products" :min="0" />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="tenantDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitTenant">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="userDialogVisible" :title="userEditingId ? '编辑用户' : '新建用户'" width="560px">
      <el-form :model="userForm" label-width="100px">
        <el-form-item v-if="!userEditingId" label="账号">
          <el-input v-model="userForm.username" />
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="userForm.display_name" />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="userForm.email" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="userForm.password"
            type="password"
            show-password
            :placeholder="userEditingId ? '留空不修改' : '至少 6 位'"
          />
        </el-form-item>
        <el-form-item label="租户">
          <el-select v-model="userForm.tenant_id" filterable>
            <el-option
              v-for="tenant in tenants"
              :key="tenant.id"
              :label="tenant.name"
              :value="tenant.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="userForm.is_active" active-text="启用" inactive-text="停用" />
        </el-form-item>
        <el-form-item label="角色">
          <el-checkbox-group v-model="userForm.roles">
            <el-checkbox label="user">user</el-checkbox>
            <el-checkbox label="tenant_admin">tenant_admin</el-checkbox>
            <el-checkbox label="super_admin">super_admin</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="userDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitUser">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="scheduleDialogVisible"
      :title="scheduleEditingId ? '编辑同步计划' : '新建同步计划'"
      width="560px"
    >
      <el-form :model="scheduleForm" label-width="110px">
        <el-form-item label="计划名称">
          <el-input v-model="scheduleForm.name" />
        </el-form-item>
        <el-form-item label="租户">
          <el-select v-model="scheduleForm.tenant_id" filterable>
            <el-option
              v-for="tenant in tenants"
              :key="tenant.id"
              :label="tenant.name"
              :value="tenant.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="店铺ID">
          <el-input-number
            v-model="scheduleForm.store_id"
            :min="1"
            placeholder="留空为全部店铺"
          />
        </el-form-item>
        <el-form-item label="任务类型">
          <el-select v-model="scheduleForm.job_type">
            <el-option label="校验店铺" value="verify_stores" />
            <el-option label="同步商品" value="sync_products" />
            <el-option label="同步订单" value="sync_orders" />
            <el-option label="核心同步" value="sync_core" />
          </el-select>
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="间隔分钟">
            <el-input-number v-model="scheduleForm.interval_minutes" :min="5" />
          </el-form-item>
          <el-form-item label="同步天数">
            <el-input-number v-model="scheduleForm.days" :min="1" :max="90" />
          </el-form-item>
        </div>
        <el-form-item label="状态">
          <el-switch v-model="scheduleForm.enabled" active-text="启用" inactive-text="停用" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="scheduleDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitSchedule">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  clearAdminCache,
  createAdminSyncSchedule,
  createAdminTenant,
  createAdminUser,
  fetchAdminAuditLogs,
  fetchAdminCacheStatus,
  fetchAdminLoginLogs,
  fetchAdminMenus,
  fetchAdminOverview,
  fetchAdminPermissions,
  fetchAdminRoles,
  fetchAdminSystemAlerts,
  fetchAdminTaskMonitor,
  fetchAdminSyncRuns,
  fetchAdminSyncSchedules,
  fetchAdminTenants,
  fetchAdminUsers,
  runAdminSyncSchedule,
  syncAdminSellerAnalyticsCache,
  updateAdminSyncSchedule,
  updateAdminTenant,
  updateAdminUser,
  type AdminAuditLog,
  type AdminCacheStatus,
  type AdminLoginLog,
  type AdminMenu,
  type AdminOverview,
  type AdminPermission,
  type AdminRole,
  type AdminSystemAlert,
  type AdminSyncRun,
  type AdminSyncSchedule,
  type AdminSyncSchedulePayload,
  type AdminTaskMonitor,
  type AdminTenant,
  type AdminTenantPayload,
  type AdminUser,
  type AdminUserCreatePayload,
  type AdminUserUpdatePayload,
} from '../api/admin'
import { clearAuthSession } from '../utils/auth'

const router = useRouter()
const loading = ref(false)
const submitting = ref(false)
const errorMessage = ref('')
const activeTab = ref('tenants')
const overview = ref<AdminOverview | null>(null)
const tenants = ref<AdminTenant[]>([])
const users = ref<AdminUser[]>([])
const roles = ref<AdminRole[]>([])
const permissions = ref<AdminPermission[]>([])
const menus = ref<AdminMenu[]>([])
const auditLogs = ref<AdminAuditLog[]>([])
const loginLogs = ref<AdminLoginLog[]>([])
const cacheStatus = ref<AdminCacheStatus | null>(null)
const syncSchedules = ref<AdminSyncSchedule[]>([])
const syncRuns = ref<AdminSyncRun[]>([])
const taskMonitor = ref<AdminTaskMonitor | null>(null)
const systemAlerts = ref<AdminSystemAlert[]>([])
const cacheScope = ref('all')
const userTenantFilter = ref<number | undefined>()
const userSearch = ref('')
const scheduleTenantFilter = ref<number | undefined>()
const tenantDialogVisible = ref(false)
const tenantEditingId = ref<number | null>(null)
const userDialogVisible = ref(false)
const userEditingId = ref<number | null>(null)
const scheduleDialogVisible = ref(false)
const scheduleEditingId = ref<number | null>(null)

const tenantForm = reactive<AdminTenantPayload>({
  name: '',
  slug: '',
  status: 'active',
  plan_code: 'starter',
  subscription_status: 'active',
  store_limit: 1,
  user_limit: 3,
  max_daily_create: 250,
  max_daily_update: 5000,
  max_total_products: 8000,
})

const userForm = reactive<AdminUserCreatePayload & { id?: number }>({
  username: '',
  password: '',
  display_name: '',
  email: '',
  tenant_id: 0,
  is_active: true,
  roles: ['user'],
})

const scheduleForm = reactive<AdminSyncSchedulePayload>({
  tenant_id: 0,
  store_id: null,
  name: '',
  job_type: 'sync_orders',
  enabled: true,
  interval_minutes: 120,
  days: 7,
})

const navItems = [
  { name: 'tenants', label: '租户' },
  { name: 'users', label: '用户' },
  { name: 'roles', label: '权限' },
  { name: 'menus', label: '菜单' },
  { name: 'cache', label: '缓存' },
  { name: 'taskMonitor', label: '任务监控' },
  { name: 'syncSchedules', label: '同步计划' },
  { name: 'loginLogs', label: '登录日志' },
  { name: 'auditLogs', label: '审计日志' },
]

const metricCards = computed(() => [
  { label: '租户', value: overview.value?.tenants ?? 0 },
  { label: '用户', value: overview.value?.users ?? 0 },
  { label: '店铺', value: overview.value?.stores ?? 0 },
  { label: '商品', value: overview.value?.products ?? 0 },
  { label: '订单', value: overview.value?.orders ?? 0 },
  { label: '有效订阅', value: overview.value?.active_subscriptions ?? 0 },
])

const cacheCards = computed(() => [
  { label: '活动列表缓存', value: cacheStatus.value?.activity_query_entries ?? 0 },
  { label: '活动商品详情缓存', value: cacheStatus.value?.activity_product_detail_entries ?? 0 },
  { label: 'Seller 类目趋势', value: cacheStatus.value?.seller_market_trends_entries ?? 0 },
  { label: 'Seller 全量类目', value: cacheStatus.value?.seller_market_all_roots_entries ?? 0 },
  { label: '热门标签', value: cacheStatus.value?.seller_hot_tags_entries ?? 0 },
  { label: '商品市场数据', value: cacheStatus.value?.seller_product_market_entries ?? 0 },
])

const uploadStatusCards = computed(() =>
  (taskMonitor.value?.upload_status_counts || []).map((item) => ({
    label: `上传 ${item.status}`,
    value: item.count,
  })),
)

const syncStatusCards = computed(() =>
  (taskMonitor.value?.sync_status_counts || []).map((item) => ({
    label: `同步 ${item.status}`,
    value: item.count,
  })),
)

const syncJobLabels: Record<string, string> = {
  verify_stores: '校验店铺',
  sync_products: '同步商品',
  sync_orders: '同步订单',
  sync_core: '核心同步',
}

function jobTypeLabel(value?: string | null) {
  return syncJobLabels[value || ''] || value || '-'
}

function taskStatusTag(status?: string | null) {
  if (!status) {
    return 'info'
  }
  if (['success', 'completed'].includes(status)) {
    return 'success'
  }
  if (['failed', 'submit_failed', 'queue_failed', 'completed_with_errors'].includes(status)) {
    return 'danger'
  }
  if (['retrying', 'queued', 'dispatching'].includes(status)) {
    return 'warning'
  }
  return 'info'
}

function formatDate(value?: string | null) {
  if (!value) {
    return '-'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function loadUsers() {
  users.value = await fetchAdminUsers({
    tenant_id: userTenantFilter.value,
    search: userSearch.value || undefined,
  })
}

async function loadSchedules() {
  syncSchedules.value = await fetchAdminSyncSchedules({
    tenant_id: scheduleTenantFilter.value,
  })
}

async function loadSyncRuns() {
  syncRuns.value = await fetchAdminSyncRuns({
    tenant_id: scheduleTenantFilter.value,
    limit: 100,
  })
}

async function loadTaskMonitor() {
  const [monitorData, alertData] = await Promise.all([
    fetchAdminTaskMonitor(),
    fetchAdminSystemAlerts(),
  ])
  taskMonitor.value = monitorData
  systemAlerts.value = alertData
}

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [
      overviewData,
      tenantData,
      roleData,
      permissionData,
      menuData,
      auditData,
      loginData,
      cacheData,
      scheduleData,
      runData,
      monitorData,
      alertData,
    ] = await Promise.all([
      fetchAdminOverview(),
      fetchAdminTenants(),
      fetchAdminRoles(),
      fetchAdminPermissions(),
      fetchAdminMenus(),
      fetchAdminAuditLogs(),
      fetchAdminLoginLogs(),
      fetchAdminCacheStatus(),
      fetchAdminSyncSchedules(),
      fetchAdminSyncRuns({ limit: 100 }),
      fetchAdminTaskMonitor(),
      fetchAdminSystemAlerts(),
    ])
    overview.value = overviewData
    tenants.value = tenantData
    roles.value = roleData
    permissions.value = permissionData
    menus.value = menuData
    auditLogs.value = auditData
    loginLogs.value = loginData
    cacheStatus.value = cacheData
    syncSchedules.value = scheduleData
    syncRuns.value = runData
    taskMonitor.value = monitorData
    systemAlerts.value = alertData
    await loadUsers()
  } catch (error: any) {
    errorMessage.value = error?.response?.data?.detail || error?.message || '后台数据加载失败'
  } finally {
    loading.value = false
  }
}

function resetTenantForm() {
  tenantForm.name = ''
  tenantForm.slug = ''
  tenantForm.status = 'active'
  tenantForm.plan_code = 'starter'
  tenantForm.subscription_status = 'active'
  tenantForm.store_limit = 1
  tenantForm.user_limit = 3
  tenantForm.max_daily_create = 250
  tenantForm.max_daily_update = 5000
  tenantForm.max_total_products = 8000
}

function openCreateTenant() {
  tenantEditingId.value = null
  resetTenantForm()
  tenantDialogVisible.value = true
}

function openEditTenant(row: AdminTenant) {
  tenantEditingId.value = row.id
  tenantForm.name = row.name
  tenantForm.slug = row.slug
  tenantForm.status = row.status
  tenantForm.plan_code = row.plan_code
  tenantForm.subscription_status = row.subscription_status
  tenantForm.store_limit = row.store_limit
  tenantForm.user_limit = row.user_limit
  tenantForm.max_daily_create = row.max_daily_create ?? 250
  tenantForm.max_daily_update = row.max_daily_update ?? 5000
  tenantForm.max_total_products = row.max_total_products ?? 8000
  tenantDialogVisible.value = true
}

async function submitTenant() {
  if (!tenantForm.name?.trim()) {
    ElMessage.error('请输入租户名称')
    return
  }
  submitting.value = true
  try {
    const payload: AdminTenantPayload = { ...tenantForm }
    if (tenantEditingId.value) {
      delete payload.slug
      await updateAdminTenant(tenantEditingId.value, payload)
      ElMessage.success('租户已更新')
    } else {
      await createAdminTenant(payload)
      ElMessage.success('租户已创建')
    }
    tenantDialogVisible.value = false
    await loadData()
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || error?.message || '租户保存失败')
  } finally {
    submitting.value = false
  }
}

function resetUserForm() {
  userForm.id = undefined
  userForm.username = ''
  userForm.password = ''
  userForm.display_name = ''
  userForm.email = ''
  userForm.tenant_id = tenants.value[0]?.id ?? 0
  userForm.is_active = true
  userForm.roles = ['user']
}

function openCreateUser() {
  userEditingId.value = null
  resetUserForm()
  userDialogVisible.value = true
}

function openEditUser(row: AdminUser) {
  userEditingId.value = row.id
  userForm.id = row.id
  userForm.username = row.username
  userForm.password = ''
  userForm.display_name = row.display_name
  userForm.email = row.email || ''
  userForm.tenant_id = row.primary_tenant_id || tenants.value[0]?.id || 0
  userForm.is_active = row.is_active
  userForm.roles = row.roles.length ? [...row.roles] : ['user']
  userDialogVisible.value = true
}

async function submitUser() {
  if (!userForm.tenant_id) {
    ElMessage.error('请选择租户')
    return
  }
  if (!userEditingId.value && (!userForm.username.trim() || userForm.password.length < 6)) {
    ElMessage.error('请输入账号和至少 6 位密码')
    return
  }
  submitting.value = true
  try {
    if (userEditingId.value) {
      const payload: AdminUserUpdatePayload = {
        display_name: userForm.display_name,
        email: userForm.email || null,
        tenant_id: userForm.tenant_id,
        is_active: userForm.is_active,
        roles: userForm.roles,
      }
      if (userForm.password) {
        payload.password = userForm.password
      }
      await updateAdminUser(userEditingId.value, payload)
      ElMessage.success('用户已更新')
    } else {
      await createAdminUser({
        username: userForm.username,
        password: userForm.password,
        display_name: userForm.display_name,
        email: userForm.email,
        tenant_id: userForm.tenant_id,
        is_active: userForm.is_active,
        roles: userForm.roles,
      })
      ElMessage.success('用户已创建')
    }
    userDialogVisible.value = false
    await loadData()
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || error?.message || '用户保存失败')
  } finally {
    submitting.value = false
  }
}

function resetScheduleForm() {
  scheduleForm.tenant_id = tenants.value[0]?.id ?? 0
  scheduleForm.store_id = null
  scheduleForm.name = ''
  scheduleForm.job_type = 'sync_orders'
  scheduleForm.enabled = true
  scheduleForm.interval_minutes = 120
  scheduleForm.days = 7
  scheduleForm.next_run_at = null
}

function openCreateSchedule() {
  scheduleEditingId.value = null
  resetScheduleForm()
  scheduleDialogVisible.value = true
}

function openEditSchedule(row: AdminSyncSchedule) {
  scheduleEditingId.value = row.id
  scheduleForm.tenant_id = row.tenant_id
  scheduleForm.store_id = row.store_id ?? null
  scheduleForm.name = row.name
  scheduleForm.job_type = row.job_type
  scheduleForm.enabled = row.enabled
  scheduleForm.interval_minutes = row.interval_minutes
  scheduleForm.days = row.days
  scheduleForm.next_run_at = row.next_run_at || null
  scheduleDialogVisible.value = true
}

async function submitSchedule() {
  if (!scheduleForm.tenant_id) {
    ElMessage.error('请选择租户')
    return
  }
  if (!scheduleForm.name?.trim()) {
    ElMessage.error('请输入计划名称')
    return
  }
  submitting.value = true
  try {
    const payload: AdminSyncSchedulePayload = { ...scheduleForm }
    if (!payload.store_id) {
      payload.store_id = null
    }
    if (scheduleEditingId.value) {
      await updateAdminSyncSchedule(scheduleEditingId.value, payload)
      ElMessage.success('同步计划已更新')
    } else {
      await createAdminSyncSchedule(payload)
      ElMessage.success('同步计划已创建')
    }
    scheduleDialogVisible.value = false
    await Promise.all([loadSchedules(), loadSyncRuns()])
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || error?.message || '同步计划保存失败')
  } finally {
    submitting.value = false
  }
}

async function runSchedule(row: AdminSyncSchedule) {
  submitting.value = true
  try {
    const result = await runAdminSyncSchedule(row.id)
    ElMessage.success(`已提交任务 ${result.task_id}`)
    await Promise.all([loadSchedules(), loadSyncRuns()])
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || error?.message || '同步计划运行失败')
  } finally {
    submitting.value = false
  }
}

async function clearCache() {
  submitting.value = true
  try {
    cacheStatus.value = await clearAdminCache(cacheScope.value)
    ElMessage.success('缓存已清理')
    auditLogs.value = await fetchAdminAuditLogs()
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || error?.message || '缓存清理失败')
  } finally {
    submitting.value = false
  }
}

async function syncSellerAnalyticsCache() {
  submitting.value = true
  try {
    const result = await syncAdminSellerAnalyticsCache({ days: 7 })
    ElMessage.success(`Seller 分析缓存同步已排队：${result.task_id}`)
    await Promise.all([loadTaskMonitor(), loadSyncRuns()])
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || error?.message || 'Seller 分析缓存同步失败')
  } finally {
    submitting.value = false
  }
}

async function logout() {
  clearAuthSession()
  ElMessage.success('已退出后台')
  await router.replace('/admin/login')
}

onMounted(loadData)
</script>

<style scoped>
.admin-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  background: #f3f6fb;
  color: #111827;
  font-family: "HarmonyOS Sans SC", "Microsoft YaHei UI", "PingFang SC", sans-serif;
}

.admin-aside {
  padding: 24px 18px;
  background: #0f172a;
  color: #e5e7eb;
}

.admin-logo {
  display: grid;
  gap: 8px;
  padding: 10px 10px 28px;
}

.admin-logo span {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  background: #2563eb;
  color: #ffffff;
  font-weight: 900;
}

.admin-logo strong {
  font-size: 18px;
}

.admin-nav {
  display: grid;
  gap: 8px;
}

.admin-nav button {
  width: 100%;
  padding: 12px 14px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: #cbd5e1;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  text-align: left;
}

.admin-nav button:hover,
.admin-nav button.active {
  background: rgba(37, 99, 235, 0.22);
  color: #ffffff;
}

.admin-main {
  min-width: 0;
  padding: 28px;
}

.admin-header,
.table-toolbar,
.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 16px;
}

.admin-header,
.table-toolbar {
  justify-content: space-between;
}

.admin-header {
  margin-bottom: 22px;
}

.table-toolbar {
  margin-bottom: 16px;
}

.sub-toolbar {
  margin-top: 24px;
}

.table-toolbar h2 {
  margin: 0;
  font-size: 18px;
}

.eyebrow {
  margin: 0 0 6px;
  color: #2563eb;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.admin-header h1 {
  margin: 0;
  font-size: 30px;
}

.header-actions {
  display: flex;
  gap: 10px;
}

.admin-alert {
  margin-bottom: 18px;
}

.metric-grid,
.cache-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 22px;
}

.metric-card,
.cache-card {
  min-height: 92px;
  display: grid;
  align-content: center;
  gap: 8px;
  padding: 18px;
  border: 1px solid #dbe4f0;
  border-radius: 18px;
  background: #ffffff;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.06);
}

.metric-card span,
.cache-card span {
  color: #64748b;
  font-size: 13px;
  font-weight: 700;
}

.metric-card strong,
.cache-card strong {
  color: #0f172a;
  font-size: 26px;
}

.admin-tabs {
  padding: 18px;
  border: 1px solid #dbe4f0;
  border-radius: 20px;
  background: #ffffff;
}

.role-tag {
  margin: 2px 6px 2px 0;
}

.split-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 10px;
}

@media (max-width: 1100px) {
  .admin-shell {
    grid-template-columns: 1fr;
  }

  .admin-nav,
  .metric-grid,
  .cache-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .split-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .admin-main {
    padding: 18px;
  }

  .admin-header,
  .table-toolbar,
  .toolbar-actions {
    align-items: flex-start;
    flex-direction: column;
  }

  .admin-nav,
  .metric-grid,
  .cache-grid,
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
