<template>
  <div class="commissions-container">
    <div class="page-header">
      <h2 class="page-title">类目佣金</h2>
      <p class="page-desc">已同步 Ozon 官网中国站当前生效的类目佣金表，可按类目模块或商品类目检索。</p>
    </div>

    <div v-if="meta" class="meta-strip">
      <span class="meta-pill">官网同步</span>
      <span>生效日期：{{ meta.effectiveFrom }}</span>
      <span>类目数：{{ meta.rowCount }}</span>
      <el-link :href="meta.sourceUrl" target="_blank" type="primary" :underline="false">
        {{ meta.sourceLabel }}
      </el-link>
      <span v-if="meta.coverageNote" class="coverage-note">{{ meta.coverageNote }}</span>
    </div>

    <div class="search-section">
      <el-input
        v-model="searchQuery"
        placeholder="搜索类目模块或商品类目"
        style="width: 320px"
        clearable
        @keyup.enter="loadData"
      />
      <el-button type="primary" :icon="Search" @click="loadData">搜索</el-button>
      <el-button :icon="RefreshRight" @click="resetSearch">清空</el-button>
    </div>

    <el-card shadow="never" class="table-card">
      <el-table
        :data="tableData"
        border
        style="width: 100%"
        v-loading="loading"
        header-cell-class-name="table-header"
        empty-text="没有匹配到类目佣金数据"
      >
        <el-table-column prop="group" label="类目模块" min-width="150" />
        <el-table-column label="商品类目" min-width="260">
          <template #default="{ row }">
            <div class="category-cell">
              <span>{{ row.category }}</span>
              <el-tag
                v-if="row.sourceHeading"
                size="small"
                type="warning"
                effect="plain"
                :title="row.sourceHeading"
              >
                历史补齐
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="0-1500 RUB" align="center">
          <el-table-column prop="tier1Rfbs" label="rFBS" width="110" align="center" />
          <el-table-column prop="tier1Fbp" label="FBP" width="110" align="center" />
        </el-table-column>
        <el-table-column label="1501-5000 RUB" align="center">
          <el-table-column prop="tier2Rfbs" label="rFBS" width="110" align="center" />
          <el-table-column prop="tier2Fbp" label="FBP" width="110" align="center" />
        </el-table-column>
        <el-table-column label="5000+ RUB" align="center">
          <el-table-column prop="tier3Rfbs" label="rFBS" width="110" align="center" />
          <el-table-column prop="tier3Fbp" label="FBP" width="110" align="center" />
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RefreshRight, Search } from '@element-plus/icons-vue'
import { fetchCommissions } from '../api/analytics'

type CommissionRow = {
  group: string
  category: string
  tier1Rfbs: string
  tier1Fbp: string
  tier2Rfbs: string
  tier2Fbp: string
  tier3Rfbs: string
  tier3Fbp: string
  sourceHeading?: string
}

type CommissionMeta = {
  sourceLabel: string
  sourceUrl: string
  effectiveFrom: string
  updatedAt: string
  rowCount: number
  coverageNote?: string
}

const loading = ref(false)
const searchQuery = ref('')
const tableData = ref<CommissionRow[]>([])
const meta = ref<CommissionMeta | null>(null)

const loadData = async () => {
  loading.value = true
  try {
    const data = await fetchCommissions(searchQuery.value)
    tableData.value = data.result || []
    meta.value = data.meta || null
  } finally {
    loading.value = false
  }
}

const resetSearch = () => {
  searchQuery.value = ''
  loadData()
}

onMounted(loadData)
</script>

<style scoped>
.commissions-container {
  padding: 0;
}

.page-desc {
  color: var(--c-text-2);
  margin: 6px 0 0;
}

.meta-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  color: var(--c-text-2);
  font-size: var(--font-size-sm);
}

.coverage-note {
  color: var(--c-text-1);
}

.meta-pill {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(64, 158, 255, 0.1);
  color: #2f6df6;
  font-weight: 600;
}

.search-section {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
}

.table-card {
  border-radius: var(--radius-sm);
  border: 1px solid var(--c-border-1);
}

.category-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
}

:deep(.table-header) {
  background: var(--c-surface-2) !important;
  color: var(--c-text-2);
  font-weight: 650;
  font-size: var(--font-size-xs);
}
</style>
