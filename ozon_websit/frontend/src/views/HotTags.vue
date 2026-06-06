<template>
  <div class="hot-tags-container">
    <div class="page-header">
      <h2 class="page-title">热门标签</h2>
      <p class="page-desc">按热度与趋势查看站内关键词，支持直接复制。</p>
    </div>

    <div class="search-section">
      <el-input
        v-model="searchQuery"
        class="search-input"
        placeholder="搜索关键词"
        clearable
        @keyup.enter="applyFilters"
      />
      <el-select v-model="competitionFilter" class="competition-filter" placeholder="竞争度" clearable>
        <el-option
          v-for="option in competitionOptions"
          :key="option"
          :label="option"
          :value="option"
        />
      </el-select>
      <el-select v-model="trendWindowDays" class="trend-window-filter" placeholder="动态窗口">
        <el-option
          v-for="option in trendWindowOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
      <el-input
        v-model="searchVolumeMinInput"
        class="search-volume-filter"
        placeholder="最低热度"
        clearable
      />
      <el-input
        v-model="searchVolumeMaxInput"
        class="search-volume-filter"
        placeholder="最高热度"
        clearable
      />
      <el-input v-model="trendMinInput" class="trend-filter" placeholder="最低动态" clearable>
        <template #append>%</template>
      </el-input>
      <el-input v-model="trendMaxInput" class="trend-filter" placeholder="最高动态" clearable>
        <template #append>%</template>
      </el-input>
      <el-button type="primary" :icon="Search" @click="applyFilters">搜索</el-button>
      <el-button @click="resetFilters">重置筛选</el-button>
    </div>

    <div v-if="appliedSubcategorySelection.length" class="subcategory-summary">
      <span class="subcategory-summary__label">
        已选细分类目
        <template v-if="appliedSubcategoryGroup"> · {{ appliedSubcategoryGroup }}</template>
      </span>
      <div class="subcategory-summary__tags">
        <el-tag
          v-for="tag in appliedSubcategorySelection"
          :key="tag"
          closable
          effect="plain"
          @close="removeSelectedSubcategory(tag)"
        >
          {{ tag }}
        </el-tag>
      </div>
      <el-button link type="primary" @click="clearAppliedSubcategories">清空细分类目</el-button>
    </div>

    <el-card shadow="never" class="table-card">
      <el-table
        :data="pagedTableData"
        border
        style="width: 100%"
        v-loading="loading"
        header-cell-class-name="table-header"
      >
        <el-table-column type="index" label="排名" width="80" align="center" :index="tableRowIndex" />
        <el-table-column prop="tag" label="标签" min-width="220">
          <template #default="{ row }">
            <div class="tag-cell">
              <el-button link type="primary" class="tag-link" @click="openSubcategoryDrawer(row)">
                {{ row.tag }}
              </el-button>
              <span v-if="row.group" class="tag-group">{{ row.group }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="searchVolume" label="搜索热度" width="140" sortable />
        <el-table-column prop="competition" label="竞争度" width="120" align="center">
          <template #default="{ row }">
            <el-tag :type="competitionType(row.competition)">{{ row.competition }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="trend" label="动态" width="120" align="center">
          <template #default="{ row }">
            <span
              v-if="row.trend !== null && row.trend !== undefined"
              :style="{ color: row.trend >= 0 ? 'var(--c-success)' : 'var(--c-danger)' }"
            >
              {{ row.trend >= 0 ? '+' : '' }}{{ row.trend }}%
            </span>
            <span v-else class="trend-empty">--</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" align="center">
          <template #default="{ row }">
            <el-button link type="primary" @click="copyTag(row.tag)">复制</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="table-pagination">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          background
          layout="total, sizes, prev, pager, next"
          :page-sizes="pageSizeOptions"
          :total="filteredTableData.length"
        />
      </div>
    </el-card>

    <el-drawer
      v-model="subcategoryDrawerVisible"
      :title="subcategoryDrawerTitle"
      size="560px"
      destroy-on-close
    >
      <div v-if="subcategoryContextRow" class="subcategory-drawer">
        <div class="subcategory-drawer__meta">
          <div class="subcategory-drawer__headline">{{ subcategoryContextRow.tag }}</div>
          <div class="subcategory-drawer__desc">
            {{
              subcategoryContextRow.group
                ? `选择“${subcategoryContextRow.group}”下要查看的细分标签。`
                : '当前标签暂时没有稳定分组，可以单独筛选或直接复制。'
            }}
          </div>
        </div>

        <div class="subcategory-drawer__actions">
          <el-button size="small" @click="selectAllSubcategories">全选</el-button>
          <el-button size="small" @click="resetPendingSubcategories">恢复默认</el-button>
        </div>

        <el-checkbox-group v-model="pendingSubcategorySelection" class="subcategory-options">
          <el-checkbox
            v-for="option in subcategoryOptions"
            :key="option.tag"
            :value="option.tag"
            :label="option.tag"
            class="subcategory-option"
          >
            <div class="subcategory-option__content">
              <span class="subcategory-option__name">{{ option.tag }}</span>
              <span class="subcategory-option__meta">
                {{ option.competition }} ·
                <template v-if="option.trend !== null && option.trend !== undefined">
                  {{ option.trend >= 0 ? '+' : '' }}{{ option.trend }}%
                </template>
                <template v-else>--</template>
              </span>
            </div>
          </el-checkbox>
        </el-checkbox-group>

        <div class="subcategory-drawer__footer">
          <el-button @click="subcategoryDrawerVisible = false">取消</el-button>
          <el-button type="primary" @click="applySubcategorySelection">应用选择</el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { fetchHotTags } from '../api/analytics'

type HotTagRow = {
  tag: string
  searchVolume: number
  competition: string
  trend: number | null
  trend7d?: number | null
  trend28d?: number | null
  group?: string
  source?: string
}

const loading = ref(false)
const searchQuery = ref('')
const competitionFilter = ref('')
const trendWindowDays = ref(7)
const searchVolumeMinInput = ref('')
const searchVolumeMaxInput = ref('')
const trendMinInput = ref('')
const trendMaxInput = ref('')
const tableData = ref<HotTagRow[]>([])
const competitionOptions = ['低', '中', '高', '极高']
const trendWindowOptions = [
  { label: '动态 7天', value: 7 },
  { label: '动态 28天', value: 28 },
]
const currentPage = ref(1)
const pageSize = ref(20)
const pageSizeOptions = [10, 20, 50]
const subcategoryDrawerVisible = ref(false)
const subcategoryContextRow = ref<HotTagRow | null>(null)
const pendingSubcategorySelection = ref<string[]>([])
const appliedSubcategorySelection = ref<string[]>([])
const appliedSubcategoryGroup = ref('')

const parseTrendInput = (value: string) => {
  const normalized = String(value || '').replace(/%/g, '').trim()
  if (!normalized) {
    return null
  }
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

const parseSearchVolumeInput = (value: string) => {
  const normalized = String(value || '').replace(/[,\s]/g, '').trim()
  if (!normalized) {
    return null
  }
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

const searchVolumeBounds = computed(() => {
  const min = parseSearchVolumeInput(searchVolumeMinInput.value)
  const max = parseSearchVolumeInput(searchVolumeMaxInput.value)
  if (min === null && max === null) {
    return { min: null, max: null }
  }
  if (min === null) {
    return { min: null, max }
  }
  if (max === null) {
    return { min, max: null }
  }
  return { min: Math.min(min, max), max: Math.max(min, max) }
})

const trendBounds = computed(() => {
  const min = parseTrendInput(trendMinInput.value)
  const max = parseTrendInput(trendMaxInput.value)
  if (min === null && max === null) {
    return { min: null, max: null }
  }
  if (min === null) {
    return { min: null, max }
  }
  if (max === null) {
    return { min, max: null }
  }
  return { min: Math.min(min, max), max: Math.max(min, max) }
})

const filteredTableData = computed(() => {
  const keyword = String(searchQuery.value || '').trim().toLocaleLowerCase()
  const { min: searchVolumeMin, max: searchVolumeMax } = searchVolumeBounds.value
  const { min, max } = trendBounds.value
  return tableData.value.filter((row) => {
    const searchVolumeValue = Number(row.searchVolume || 0)
    const trendValue = row.trend === null || row.trend === undefined ? null : Number(row.trend)
    if (
      keyword &&
      !String(row.tag || '').toLocaleLowerCase().includes(keyword) &&
      !String(row.group || '').toLocaleLowerCase().includes(keyword)
    ) {
      return false
    }
    if (competitionFilter.value && row.competition !== competitionFilter.value) {
      return false
    }
    if (searchVolumeMin !== null && searchVolumeValue < searchVolumeMin) {
      return false
    }
    if (searchVolumeMax !== null && searchVolumeValue > searchVolumeMax) {
      return false
    }
    if (min !== null && (trendValue === null || trendValue < min)) {
      return false
    }
    if (max !== null && (trendValue === null || trendValue > max)) {
      return false
    }
    if (
      appliedSubcategorySelection.value.length > 0 &&
      appliedSubcategoryGroup.value &&
      row.group !== appliedSubcategoryGroup.value
    ) {
      return false
    }
    if (
      appliedSubcategorySelection.value.length > 0 &&
      !appliedSubcategorySelection.value.includes(row.tag)
    ) {
      return false
    }
    return true
  })
})

const pagedTableData = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredTableData.value.slice(start, start + pageSize.value)
})

const subcategoryOptions = computed(() => {
  if (!subcategoryContextRow.value) {
    return []
  }
  const group = subcategoryContextRow.value.group || ''
  const rows = tableData.value.filter((row) => {
    if (group) {
      return row.group === group
    }
    return row.tag === subcategoryContextRow.value?.tag
  })
  return [...rows].sort((a, b) => b.searchVolume - a.searchVolume)
})

const subcategoryDrawerTitle = computed(() => {
  if (!subcategoryContextRow.value) {
    return '细分类目'
  }
  return `${subcategoryContextRow.value.tag} · 细分类目`
})

const loadData = async () => {
  loading.value = true
  try {
    const data = await fetchHotTags('', trendWindowDays.value)
    tableData.value = data.result || []
    currentPage.value = 1
    if (appliedSubcategorySelection.value.length > 0) {
      const availableTags = new Set(
        tableData.value
          .filter((row) =>
            appliedSubcategoryGroup.value ? row.group === appliedSubcategoryGroup.value : true
          )
          .map((row) => row.tag)
      )
      appliedSubcategorySelection.value = appliedSubcategorySelection.value.filter((tag) =>
        availableTags.has(tag)
      )
      if (!appliedSubcategorySelection.value.length) {
        appliedSubcategoryGroup.value = ''
      }
    }
  } finally {
    loading.value = false
  }
}

const applyFilters = () => {
  currentPage.value = 1
}

const resetFilters = () => {
  searchQuery.value = ''
  competitionFilter.value = ''
  trendWindowDays.value = 7
  searchVolumeMinInput.value = ''
  searchVolumeMaxInput.value = ''
  trendMinInput.value = ''
  trendMaxInput.value = ''
  clearAppliedSubcategories()
  currentPage.value = 1
}

const openSubcategoryDrawer = (row: HotTagRow) => {
  subcategoryContextRow.value = row
  const sameGroupApplied =
    appliedSubcategorySelection.value.length > 0 &&
    appliedSubcategoryGroup.value === (row.group || '')
  pendingSubcategorySelection.value = sameGroupApplied
    ? [...appliedSubcategorySelection.value]
    : [row.tag]
  subcategoryDrawerVisible.value = true
}

const applySubcategorySelection = () => {
  appliedSubcategorySelection.value = [...new Set(pendingSubcategorySelection.value)]
  appliedSubcategoryGroup.value = appliedSubcategorySelection.value.length
    ? subcategoryContextRow.value?.group || ''
    : ''
  subcategoryDrawerVisible.value = false
}

const selectAllSubcategories = () => {
  pendingSubcategorySelection.value = subcategoryOptions.value.map((option) => option.tag)
}

const resetPendingSubcategories = () => {
  pendingSubcategorySelection.value = subcategoryContextRow.value ? [subcategoryContextRow.value.tag] : []
}

const clearAppliedSubcategories = () => {
  appliedSubcategorySelection.value = []
  appliedSubcategoryGroup.value = ''
}

const removeSelectedSubcategory = (tag: string) => {
  appliedSubcategorySelection.value = appliedSubcategorySelection.value.filter((item) => item !== tag)
  if (!appliedSubcategorySelection.value.length) {
    appliedSubcategoryGroup.value = ''
  }
}

const competitionType = (value: string) => {
  if (value === '极高') return 'danger'
  if (value === '高') return 'warning'
  if (value === '中') return 'info'
  return 'success'
}

const tableRowIndex = (index: number) => (currentPage.value - 1) * pageSize.value + index + 1

const copyTag = async (tag: string) => {
  await navigator.clipboard.writeText(tag)
  ElMessage.success(`已复制：${tag}`)
}

watch(
  trendWindowDays,
  () => {
    void loadData()
  }
)

watch(
  () => [filteredTableData.value.length, pageSize.value],
  ([totalRows, currentPageSize]) => {
    const totalPages = Math.max(1, Math.ceil(Number(totalRows || 0) / Number(currentPageSize || 1)))
    if (currentPage.value > totalPages) {
      currentPage.value = totalPages
    }
  }
)

watch(
  [
    searchQuery,
    competitionFilter,
    searchVolumeMinInput,
    searchVolumeMaxInput,
    trendMinInput,
    trendMaxInput,
    appliedSubcategoryGroup,
    () => appliedSubcategorySelection.value.join('\u0000'),
  ],
  () => {
    currentPage.value = 1
  }
)

onMounted(loadData)
</script>

<style scoped>
.hot-tags-container {
  padding: 0;
}

.page-desc {
  color: var(--c-text-2);
  margin: 6px 0 0;
}

.search-section {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}

.search-input {
  width: 280px;
}

.competition-filter {
  width: 140px;
}

.trend-window-filter {
  width: 150px;
}

.search-volume-filter {
  width: 160px;
}

.trend-filter {
  width: 160px;
}

.subcategory-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.subcategory-summary__label {
  color: var(--c-text-2);
  font-size: var(--font-size-sm);
}

.subcategory-summary__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.table-card {
  border-radius: var(--radius-sm);
  border: 1px solid var(--c-border-1);
}

.table-pagination {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
}

.tag-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.tag-link {
  padding: 0;
  height: auto;
}

.tag-group {
  color: var(--c-text-3);
  font-size: var(--font-size-xs);
}

.subcategory-drawer {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
}

.subcategory-drawer__meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.subcategory-drawer__headline {
  font-size: var(--font-size-lg);
  font-weight: 700;
}

.subcategory-drawer__desc {
  color: var(--c-text-2);
  font-size: var(--font-size-sm);
}

.subcategory-drawer__actions {
  display: flex;
  gap: 8px;
}

.subcategory-options {
  display: grid;
  gap: 10px;
  overflow: auto;
  padding-right: 4px;
}

.subcategory-option {
  margin-right: 0;
  min-width: 0;
}

.subcategory-option :deep(.el-checkbox__label) {
  width: 100%;
}

.subcategory-option__content {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.subcategory-option__name {
  color: var(--c-text-1);
}

.subcategory-option__meta {
  color: var(--c-text-3);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.subcategory-drawer__footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--c-border-1);
}

:deep(.table-header) {
  background: var(--c-surface-2) !important;
  color: var(--c-text-2);
  font-weight: 650;
  font-size: var(--font-size-xs);
}

@media (max-width: 900px) {
  .search-input,
  .competition-filter,
  .trend-filter {
    width: 100%;
  }

  .subcategory-option__content {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
