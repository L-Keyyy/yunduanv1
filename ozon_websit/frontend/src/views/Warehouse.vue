<template>
  <div class="warehouse-container">
    <div class="page-header">
      <h2 class="page-title">仓库管理</h2>
    </div>

    <div class="search-section">
      <div class="search-row">
        <span class="label">搜索</span>
        <el-input v-model="searchQuery.orderNo" placeholder="订单号" clearable />
        <el-input v-model="searchQuery.waybillNo" placeholder="运单号" clearable />
        <el-input v-model="searchQuery.trackingNo" placeholder="跟踪号" clearable />
        <el-input v-model="searchQuery.senderName" placeholder="发件人" clearable />
        <el-button type="primary" :icon="Search" @click="handleSearch">查询</el-button>
        <el-button :icon="RefreshRight" @click="handleReset">重置</el-button>
      </div>

      <div class="filter-row">
        <span class="label">筛选</span>
        <el-select v-model="searchQuery.storeId" placeholder="全部店铺" style="width: 180px" clearable>
          <el-option v-for="store in stores" :key="store.id" :label="store.store_name" :value="store.id" />
        </el-select>
        <el-radio-group v-model="searchQuery.status" @change="handleSearch">
          <el-radio-button label="全部订单">全部订单</el-radio-button>
          <el-radio-button label="待入库">待入库</el-radio-button>
          <el-radio-button label="已入库">已入库</el-radio-button>
          <el-radio-button label="已出库">已出库</el-radio-button>
        </el-radio-group>
      </div>

      <div class="batch-row">
        <span class="label">批量</span>
        <el-button type="primary" @click="handleInbound">批量入库</el-button>
        <el-button @click="handlePrint">标记已打印</el-button>
        <el-button @click="handleDownload">标记已下载</el-button>
        <el-button @click="handleClose">批量关闭</el-button>
        <el-button @click="exportTable">导出当前页</el-button>
      </div>
    </div>

    <div class="table-section">
      <el-table
        :data="tableData"
        style="width: 100%"
        border
        v-loading="loading"
        @selection-change="handleSelectionChange"
        header-cell-class-name="table-header"
      >
        <el-table-column type="selection" width="55" />
        <el-table-column prop="all_waybills" label="总运单号" width="130" />
        <el-table-column label="商品图" width="80">
          <template #default="{ row }">
            <el-image :src="row.product_image" fit="cover" style="width: 40px; height: 40px" />
          </template>
        </el-table-column>
        <el-table-column prop="posting_number" label="订单号" width="170" />
        <el-table-column prop="domestic_waybill" label="国内运单" width="150" />
        <el-table-column prop="tracking_no" label="跟踪号" width="150" />
        <el-table-column prop="product_name" label="商品名称" min-width="220" show-overflow-tooltip />
        <el-table-column prop="warehouse_status" label="仓库状态" width="170" />
        <el-table-column prop="created_at_label" label="下单时间" width="160" />
        <el-table-column prop="responsible_person" label="负责人" width="100" />
        <el-table-column prop="dimensions" label="尺寸(mm)" width="110" />
        <el-table-column prop="weight_g" label="重量(g)" width="90" />
        <el-table-column prop="estimated_price" label="估算售价" width="100" />
        <el-table-column prop="total_purchase_price" label="采购成本" width="100" />
        <el-table-column prop="warehouse_name" label="仓库" width="130" />
        <el-table-column prop="logistics_type" label="物流类型" width="100" />
        <el-table-column prop="store_name" label="店铺" width="120" />
      </el-table>
    </div>

    <div class="pagination-section">
      <el-pagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :page-sizes="[15, 30, 50, 100]"
        layout="sizes, total, prev, pager, next, jumper"
        :total="total"
        @size-change="handleSearch"
        @current-change="handleSearch"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { RefreshRight, Search } from '@element-plus/icons-vue'
import { fetchStores } from '../api/store'
import {
  batchWarehouseClose,
  batchWarehouseDownload,
  batchWarehouseInbound,
  batchWarehousePrint,
  fetchWarehouseOrders,
} from '../api/orders'

const loading = ref(false)
const currentPage = ref(1)
const pageSize = ref(15)
const total = ref(0)
const stores = ref<any[]>([])
const tableData = ref<any[]>([])
const selectedRows = ref<any[]>([])

const searchQuery = ref({
  orderNo: '',
  waybillNo: '',
  trackingNo: '',
  senderName: '',
  storeId: undefined as number | undefined,
  status: '全部订单',
})

const selectedIds = () => selectedRows.value.map((row) => row.id)

const handleSelectionChange = (rows: any[]) => {
  selectedRows.value = rows
}

const ensureSelected = () => {
  if (!selectedRows.value.length) {
    ElMessage.warning('请先选择仓库订单')
    return false
  }
  return true
}

const handleSearch = async () => {
  loading.value = true
  try {
    const data = await fetchWarehouseOrders({
      order_no: searchQuery.value.orderNo || undefined,
      waybill_no: searchQuery.value.waybillNo || undefined,
      tracking_no: searchQuery.value.trackingNo || undefined,
      sender_name: searchQuery.value.senderName || undefined,
      store_id: searchQuery.value.storeId,
      status: searchQuery.value.status,
      page: currentPage.value,
      page_size: pageSize.value,
    })
    tableData.value = data.result || []
    total.value = data.total || 0
  } catch (error: any) {
    ElMessage.error(error.response?.data?.detail || '获取仓库订单失败')
  } finally {
    loading.value = false
  }
}

const handleReset = () => {
  searchQuery.value = {
    orderNo: '',
    waybillNo: '',
    trackingNo: '',
    senderName: '',
    storeId: undefined,
    status: '全部订单',
  }
  currentPage.value = 1
  handleSearch()
}

const handleInbound = async () => {
  if (!ensureSelected()) return
  await batchWarehouseInbound({ ids: selectedIds() })
  ElMessage.success('批量入库完成')
  handleSearch()
}

const handlePrint = async () => {
  if (!ensureSelected()) return
  await batchWarehousePrint({ ids: selectedIds() })
  ElMessage.success('已标记打印')
  handleSearch()
}

const handleDownload = async () => {
  if (!ensureSelected()) return
  await batchWarehouseDownload({ ids: selectedIds() })
  ElMessage.success('已标记下载')
  handleSearch()
}

const handleClose = async () => {
  if (!ensureSelected()) return
  await batchWarehouseClose({ ids: selectedIds() })
  ElMessage.success('已关闭选中订单')
  handleSearch()
}

const exportTable = () => {
  if (!tableData.value.length) {
    ElMessage.warning('当前页没有可导出的数据')
    return
  }
  const rows = [
    ['订单号', '店铺', '商品', '仓库状态', '跟踪号'],
    ...tableData.value.map((row) => [
      row.posting_number,
      row.store_name,
      row.product_name,
      row.warehouse_status,
      row.tracking_no,
    ]),
  ]
  const content = rows.map((row) => row.join(',')).join('\n')
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `warehouse-${Date.now()}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

onMounted(async () => {
  stores.value = await fetchStores()
  await handleSearch()
})
</script>

<style scoped>
.warehouse-container {
  padding: 0;
}

.search-row,
.filter-row,
.batch-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.batch-row {
  margin-bottom: 0;
}

.label {
  width: 48px;
  color: var(--c-text-2);
  font-weight: 650;
  flex-shrink: 0;
}

.search-row :deep(.el-input) {
  width: 180px;
}

:deep(.table-header) {
  background: var(--c-surface-2) !important;
  color: var(--c-text-2);
  font-weight: 650;
}
</style>
