<template>
  <div class="calculator-container">
    <div class="page-header">
      <h2 class="page-title">定价计算器</h2>
      <p class="page-desc">支持模板保存、云端计算和多条物流方案对比。</p>
    </div>

    <el-row :gutter="20">
      <el-col :xs="24" :lg="8">
        <el-card shadow="never" class="form-card">
          <div class="card-head">
            <span class="card-title">计算参数</span>
            <el-button type="primary" link @click="handleSaveTemplate">保存模板</el-button>
          </div>

          <el-form label-width="120px" size="small">
            <el-form-item label="模板">
              <el-select v-model="selectedTemplateId" placeholder="选择模板" style="width: 100%" @change="applyTemplate">
                <el-option v-for="item in templates" :key="item.id" :label="item.name" :value="item.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="模板名称">
              <el-input v-model="form.name" placeholder="用于保存模板" />
            </el-form-item>
            <el-form-item label="采购成本">
              <el-input-number v-model="form.purchase_cost" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
            <el-form-item label="重量(g)">
              <el-input-number v-model="form.weight_g" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
            <el-form-item label="目标毛利率%">
              <el-input-number v-model="form.target_margin_rate" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
            <el-form-item label="长(mm)">
              <el-input-number v-model="form.length_mm" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
            <el-form-item label="宽(mm)">
              <el-input-number v-model="form.width_mm" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
            <el-form-item label="高(mm)">
              <el-input-number v-model="form.height_mm" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
            <el-form-item label="国内运费">
              <el-input-number v-model="form.domestic_shipping" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
            <el-form-item label="划线折扣%">
              <el-input-number v-model="form.strike_discount_rate" :min="0" :max="90" :precision="2" style="width: 100%" />
            </el-form-item>
            <el-form-item label="广告费率%">
              <el-input-number v-model="form.ad_rate" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
            <el-form-item label="退货率%">
              <el-input-number v-model="form.return_rate" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
            <el-form-item label="其他费用%">
              <el-input-number v-model="form.other_fee_rate" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
            <el-form-item label="物流类型">
              <el-select v-model="form.logistics_type" style="width: 100%">
                <el-option label="FBS" value="FBS" />
                <el-option label="rFBS" value="rFBS" />
              </el-select>
            </el-form-item>
            <el-form-item label="取件方式">
              <el-input v-model="form.pickup_type" />
            </el-form-item>
            <el-form-item label="目的地区">
              <el-input v-model="form.destination_region" />
            </el-form-item>
            <el-form-item label="带电">
              <el-switch v-model="form.has_battery" />
            </el-form-item>
            <el-form-item label="带液体">
              <el-switch v-model="form.has_liquid" />
            </el-form-item>
          </el-form>

          <div class="form-actions">
            <el-button type="primary" @click="handleCalculate" :loading="calculating">计算结果</el-button>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="16">
        <el-card shadow="never" class="result-card">
          <div class="card-head">
            <span class="card-title">计算结果</span>
            <span class="result-note">结果按毛利润从高到低排序</span>
          </div>

          <el-table :data="results" border style="width: 100%" v-loading="calculating" header-cell-class-name="table-header">
            <el-table-column prop="shortName" label="简称" width="90" />
            <el-table-column prop="logisticsName" label="物流商" min-width="160" />
            <el-table-column prop="deliveryDays" label="时效" width="120" />
            <el-table-column prop="salePrice" label="售价" width="100" />
            <el-table-column prop="strikePrice" label="划线价" width="100" />
            <el-table-column prop="logisticsCost" label="物流成本" width="110" />
            <el-table-column prop="totalCost" label="总成本" width="110" />
            <el-table-column prop="grossProfit" label="毛利润" width="110" />
            <el-table-column prop="commissionAmount" label="佣金" width="100" />
            <el-table-column prop="commissionRate" label="佣金率%" width="100" />
            <el-table-column prop="adCost" label="广告费" width="100" />
            <el-table-column prop="otherCost" label="其他费用" width="100" />
            <el-table-column prop="chargeableWeight" label="计费重(kg)" width="120" />
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  calculatePricing,
  fetchPricingTemplates,
  savePricingTemplate,
} from '../api/pricing'

const calculating = ref(false)
const templates = ref<any[]>([])
const results = ref<any[]>([])
const selectedTemplateId = ref<number | undefined>(undefined)

const defaultForm = () => ({
  name: '默认模板',
  purchase_cost: 35,
  weight_g: 300,
  target_margin_rate: 18,
  length_mm: 20,
  width_mm: 20,
  height_mm: 20,
  domestic_shipping: 1,
  strike_discount_rate: 10,
  ad_rate: 3,
  return_rate: 2,
  other_fee_rate: 3,
  has_battery: false,
  has_liquid: false,
  logistics_type: 'FBS',
  pickup_type: 'Pickup',
  destination_region: 'Russia',
})

const form = ref(defaultForm())

const loadTemplates = async () => {
  templates.value = await fetchPricingTemplates()
  if (!selectedTemplateId.value && templates.value.length > 0) {
    selectedTemplateId.value = templates.value[0].id
    applyTemplate(selectedTemplateId.value)
  }
}

const applyTemplate = (templateId?: number) => {
  const template = templates.value.find((item) => item.id === templateId)
  if (!template) return
  form.value = { ...template }
}

const handleCalculate = async () => {
  calculating.value = true
  try {
    const payload = { ...form.value }
    delete (payload as any).id
    const data = await calculatePricing(payload)
    results.value = data.result || []
  } finally {
    calculating.value = false
  }
}

const handleSaveTemplate = async () => {
  try {
    if (!form.value.name?.trim()) {
      const { value } = await ElMessageBox.prompt('输入模板名称', '保存模板', {
        inputPattern: /^.{1,40}$/,
        inputErrorMessage: '请输入 1-40 字模板名',
      })
      form.value.name = value
    }
    const payload = { ...form.value }
    delete (payload as any).id
    await savePricingTemplate(payload)
    ElMessage.success('模板已保存')
    loadTemplates()
  } catch {
    // user cancelled
  }
}

onMounted(async () => {
  await loadTemplates()
  await handleCalculate()
})
</script>

<style scoped>
.calculator-container {
  padding: 0;
}

.page-desc {
  color: var(--c-text-2);
  margin: 6px 0 0;
}

.form-card,
.result-card {
  border-radius: var(--radius-sm);
  border: 1px solid var(--c-border-1);
}

.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.card-title {
  font-size: var(--font-size-md);
  font-weight: 650;
}

.result-note {
  color: var(--c-text-3);
  font-size: var(--font-size-sm);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
}

:deep(.table-header) {
  background: var(--c-surface-2) !important;
  color: var(--c-text-2);
  font-weight: 650;
  font-size: var(--font-size-xs);
}
</style>
