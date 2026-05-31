<template>
  <div class="store-management-container">
    <div class="page-header">
      <h2 class="page-title">店铺管理</h2>
    </div>

    <div class="search-section">
      <div class="search-row">
        <span class="label">搜索</span>
        <el-input
          v-model="searchQuery.keyword"
          placeholder="店铺名 / Client ID / 邮箱"
          clearable
          style="width: 260px"
        />

        <span class="label compact">分组</span>
        <el-select v-model="searchQuery.storeGroup" placeholder="全部" style="width: 160px">
          <el-option label="全部" value="" />
          <el-option label="分组 A" value="group_a" />
          <el-option label="分组 B" value="group_b" />
        </el-select>

        <el-button type="primary" :icon="Search" @click="handleSearch">刷新</el-button>
        <el-button :icon="RefreshRight" @click="handleReset">清空</el-button>
      </div>

      <div class="action-row">
        <span class="label">操作</span>
        <el-button type="primary" :icon="Plus" @click="showAddDialog = true">新增店铺</el-button>
      </div>

    </div>

    <div class="table-section">
      <el-table
        :data="filteredData"
        style="width: 100%"
        border
        v-loading="loading"
        header-cell-class-name="table-header"
      >
        <el-table-column prop="store_name" label="店铺名称" min-width="150" />
        <el-table-column prop="client_id" label="Client ID" width="140" />
        <el-table-column prop="currency" label="币种" width="90" />
        <el-table-column prop="key_status" label="密钥状态" width="120">
          <template #default="{ row }">
            <el-tag :type="row.key_status === 'active' ? 'success' : 'danger'">
              {{ row.key_status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="daily_limit" label="每日上新限额" min-width="190" />
        <el-table-column prop="can_update" label="每日更新限额" min-width="190" />
        <el-table-column prop="total_limit" label="总限额" min-width="140" />
        <el-table-column prop="watermark" label="默认水印" width="120" />
        <el-table-column prop="warehouse_info" label="仓库信息" min-width="180" />
        <el-table-column prop="email" label="邮箱" min-width="180" />
        <el-table-column prop="store_group" label="分组" width="100" />
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{ row }">
            <div class="op-buttons">
              <el-button size="small" @click="openWatermarkDialog(row)">默认水印</el-button>
              <el-button size="small" @click="openWarehouseDialog(row)">仓库物流</el-button>
              <el-button size="small" type="primary" @click="openEditDialog(row)">编辑</el-button>
              <el-button
                size="small"
                :loading="verifyingStoreId === row.id && verifyJob.running"
                @click="handleVerify(row)"
              >
                重验
              </el-button>
              <el-button size="small" type="danger" @click="handleDelete(row)">删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>

  <el-dialog v-model="showAddDialog" title="新增店铺" width="520px">
    <el-form :model="newStore" label-width="100px" :rules="rules" ref="storeFormRef">
      <el-form-item label="店铺名称" prop="store_name">
        <el-input v-model="newStore.store_name" />
      </el-form-item>
      <el-form-item label="Client ID" prop="client_id">
        <el-input v-model="newStore.client_id" />
      </el-form-item>
      <el-form-item label="API Key" prop="api_key">
        <el-input v-model="newStore.api_key" show-password />
      </el-form-item>
      <el-form-item label="邮箱">
        <el-input v-model="newStore.email" />
      </el-form-item>
      <el-form-item label="分组">
        <el-select v-model="newStore.store_group" style="width: 100%">
          <el-option label="分组 A" value="group_a" />
          <el-option label="分组 B" value="group_b" />
        </el-select>
      </el-form-item>
      <el-form-item label="币种">
        <el-select v-model="newStore.currency" style="width: 100%">
          <el-option label="CNY" value="CNY" />
          <el-option label="USD" value="USD" />
          <el-option label="RUB" value="RUB" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="showAddDialog = false">取消</el-button>
      <el-button type="primary" @click="submitAddStore" :loading="submitLoading">保存并验证</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="showEditDialog" title="编辑店铺" width="520px">
    <el-form :model="editStore" label-width="100px">
      <el-form-item label="店铺名称">
        <el-input v-model="editStore.store_name" />
      </el-form-item>
      <el-form-item label="邮箱">
        <el-input v-model="editStore.email" />
      </el-form-item>
      <el-form-item label="分组">
        <el-select v-model="editStore.store_group" style="width: 100%">
          <el-option label="分组 A" value="group_a" />
          <el-option label="分组 B" value="group_b" />
        </el-select>
      </el-form-item>
      <el-form-item label="币种">
        <el-select v-model="editStore.currency" style="width: 100%">
          <el-option label="CNY" value="CNY" />
          <el-option label="USD" value="USD" />
          <el-option label="RUB" value="RUB" />
        </el-select>
      </el-form-item>
      <el-form-item label="Cookie 状态">
        <el-select v-model="editStore.cookie_status" style="width: 100%">
          <el-option label="unknown" value="unknown" />
          <el-option label="active" value="active" />
          <el-option label="expired" value="expired" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="showEditDialog = false">取消</el-button>
      <el-button type="primary" @click="submitEditStore">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="showWatermarkDialog" title="默认水印" width="420px">
    <el-form label-width="90px">
      <el-form-item label="水印名称">
        <el-input v-model="watermarkValue" placeholder="如 default-watermark" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="showWatermarkDialog = false">取消</el-button>
      <el-button type="primary" @click="saveWatermark">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="showWarehouseDialog" title="仓库物流" width="520px">
    <el-form label-width="100px">
      <el-form-item label="仓库信息">
        <el-input v-model="warehouseValue" type="textarea" :rows="4" placeholder="仓库/物流备注" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="showWarehouseDialog = false">取消</el-button>
      <el-button type="primary" @click="saveWarehouse">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'
import { Search, RefreshRight, Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { submitVerifyStoresJob } from '../api/jobs'
import {
  createStore,
  deleteStore,
  fetchStores,
  updateStore,
} from '../api/store'
import { useAsyncJob } from '../composables/useAsyncJob'

const loading = ref(false)
const tableData = ref<any[]>([])
const searchQuery = ref({
  keyword: '',
  storeGroup: '',
})

const showAddDialog = ref(false)
const showEditDialog = ref(false)
const showWatermarkDialog = ref(false)
const showWarehouseDialog = ref(false)
const submitLoading = ref(false)
const storeFormRef = ref()
const currentStoreId = ref<number | null>(null)
const verifyingStoreId = ref<number | null>(null)
const verifyJob = useAsyncJob()
let hasCompletedInitialLoad = false

const newStore = ref({
  store_name: '',
  client_id: '',
  api_key: '',
  email: '',
  store_group: '',
  currency: 'CNY',
})

const editStore = ref({
  store_name: '',
  email: '',
  store_group: '',
  currency: 'CNY',
  cookie_status: 'unknown',
})

const watermarkValue = ref('')
const warehouseValue = ref('')

const rules = {
  store_name: [{ required: true, message: '请输入店铺名称', trigger: 'blur' }],
  client_id: [{ required: true, message: '请输入 Client ID', trigger: 'blur' }],
  api_key: [{ required: true, message: '请输入 API Key', trigger: 'blur' }],
}

const filteredData = computed(() => {
  return tableData.value.filter((item) => {
    const keyword = searchQuery.value.keyword.trim().toLowerCase()
    const keywordMatch =
      !keyword ||
      item.store_name.toLowerCase().includes(keyword) ||
      item.client_id.toLowerCase().includes(keyword) ||
      (item.email || '').toLowerCase().includes(keyword)
    const groupMatch = !searchQuery.value.storeGroup || item.store_group === searchQuery.value.storeGroup
    return keywordMatch && groupMatch
  })
})

const resetNewStore = () => {
  newStore.value = {
    store_name: '',
    client_id: '',
    api_key: '',
    email: '',
    store_group: '',
    currency: 'CNY',
  }
}

const loadData = async (refresh = false, options: { background?: boolean } = {}) => {
  const showLoading = !options.background && (refresh || tableData.value.length === 0)
  if (showLoading) {
    loading.value = true
  }
  try {
    tableData.value = await fetchStores(refresh)
  } catch (error: any) {
    ElMessage.error(error.response?.data?.detail || '获取店铺失败')
  } finally {
    if (showLoading) {
      loading.value = false
    }
  }
}

const handleSearch = () => {
  void loadData(true)
}

const handleReset = () => {
  searchQuery.value.keyword = ''
  searchQuery.value.storeGroup = ''
}

const submitAddStore = async () => {
  if (!storeFormRef.value) return
  await storeFormRef.value.validate(async (valid: boolean) => {
    if (!valid) return
    submitLoading.value = true
    try {
      await createStore(newStore.value)
      ElMessage.success('店铺已创建')
      showAddDialog.value = false
      resetNewStore()
      await loadData()
    } catch (error: any) {
      ElMessage.error(error.response?.data?.detail || '新增店铺失败')
    } finally {
      submitLoading.value = false
    }
  })
}

const openEditDialog = (row: any) => {
  currentStoreId.value = row.id
  editStore.value = {
    store_name: row.store_name,
    email: row.email || '',
    store_group: row.store_group || '',
    currency: row.currency || 'CNY',
    cookie_status: row.cookie_status || 'unknown',
  }
  showEditDialog.value = true
}

const submitEditStore = async () => {
  if (!currentStoreId.value) return
  try {
    await updateStore(currentStoreId.value, editStore.value)
    ElMessage.success('店铺信息已更新')
    showEditDialog.value = false
    await loadData()
  } catch (error: any) {
    ElMessage.error(error.response?.data?.detail || '更新失败')
  }
}

const openWatermarkDialog = (row: any) => {
  currentStoreId.value = row.id
  watermarkValue.value = row.watermark || ''
  showWatermarkDialog.value = true
}

const saveWatermark = async () => {
  if (!currentStoreId.value) return
  try {
    await updateStore(currentStoreId.value, { watermark: watermarkValue.value })
    ElMessage.success('默认水印已保存')
    showWatermarkDialog.value = false
    await loadData()
  } catch (error: any) {
    ElMessage.error(error.response?.data?.detail || '保存水印失败')
  }
}

const openWarehouseDialog = (row: any) => {
  currentStoreId.value = row.id
  warehouseValue.value = row.warehouse_info || ''
  showWarehouseDialog.value = true
}

const saveWarehouse = async () => {
  if (!currentStoreId.value) return
  try {
    await updateStore(currentStoreId.value, { warehouse_info: warehouseValue.value })
    ElMessage.success('仓库物流信息已保存')
    showWarehouseDialog.value = false
    await loadData()
  } catch (error: any) {
    ElMessage.error(error.response?.data?.detail || '保存仓库信息失败')
  }
}

const handleDelete = (row: any) => {
  ElMessageBox.confirm(`确认删除店铺 ${row.store_name} 吗？`, '提示', {
    type: 'warning',
  })
    .then(async () => {
      await deleteStore(row.id)
      ElMessage.success('店铺已删除')
      await loadData()
    })
    .catch(() => {})
}

const handleVerify = async (row: any) => {
  verifyingStoreId.value = row.id
  const submission = await verifyJob.runJob(
    () =>
      submitVerifyStoresJob({
        store_id: row.id,
      }),
    {
      successMessage: '店铺验证完成',
      onSuccess: async () => {
        verifyingStoreId.value = null
        await loadData()
      },
      onFailure: async () => {
        verifyingStoreId.value = null
      },
    }
  )

  if (!submission) {
    verifyingStoreId.value = null
  }
}

onMounted(async () => {
  await loadData()
  hasCompletedInitialLoad = true
})

onActivated(() => {
  if (!hasCompletedInitialLoad) {
    return
  }
  if (!tableData.value.length) {
    void loadData()
  }
})
</script>

<style scoped>
.store-management-container {
  padding: 0;
}

.search-row,
.action-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.action-row {
  margin-bottom: 0;
}

.label {
  width: 60px;
  color: var(--c-text-2);
  font-weight: 650;
  flex-shrink: 0;
}

.label.compact {
  width: auto;
  margin-left: 8px;
}

.op-buttons {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

:deep(.table-header) {
  background: var(--c-surface-2) !important;
  color: var(--c-text-2);
  font-weight: 650;
  font-size: var(--font-size-xs);
}
</style>
