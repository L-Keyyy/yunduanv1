<template>
  <div class="auth-shell">
    <section class="auth-brand">
      <RouterLink class="brand-wordmark" to="/">欧卖通</RouterLink>

      <div class="brand-copy">
        <h1>智能化数据分析</h1>
        <p>欧卖通合作运营商，您身边的跨境助手</p>
      </div>

      <RouterLink class="back-link" to="/">返回</RouterLink>
    </section>

    <main class="auth-main">
      <section class="auth-panel">
        <div class="card-head">
          <p class="eyebrow">Create Account</p>
          <h2>用户注册</h2>
          <p class="subcopy">注册成功后会直接登录并跳转到欧卖通工作台。</p>
        </div>

        <el-alert
          v-if="errorMessage"
          type="error"
          :closable="false"
          show-icon
          class="auth-alert"
          :title="errorMessage"
        />

        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          label-position="top"
          class="auth-form"
          @submit.prevent="handleRegister"
        >
          <el-form-item label="用户名" prop="username">
            <el-input
              v-model="form.username"
              size="large"
              placeholder="输入登录用户名"
              autocomplete="username"
              @keyup.enter="handleRegister"
            />
          </el-form-item>

          <el-form-item label="邮箱" prop="email">
            <el-input
              v-model="form.email"
              size="large"
              placeholder="输入邮箱号"
              autocomplete="email"
              @keyup.enter="handleRegister"
            />
          </el-form-item>

          <el-form-item label="密码" prop="password">
            <el-input
              v-model="form.password"
              size="large"
              type="password"
              show-password
              placeholder="至少 6 位"
              autocomplete="new-password"
              @keyup.enter="handleRegister"
            />
          </el-form-item>

          <el-button
            class="auth-button"
            size="large"
            type="primary"
            :loading="submitting"
            @click="handleRegister"
          >
            <span>创建并进入工作台</span>
            <span class="button-arrow">→</span>
          </el-button>
        </el-form>

        <div class="auth-footer">
          <span>已经有账号？</span>
          <RouterLink class="auth-link" to="/login">去登录</RouterLink>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type { FormInstance, FormRules } from 'element-plus'
import { register } from '../api/auth'
import { setAuthSession } from '../utils/auth'

const router = useRouter()
const route = useRoute()
const formRef = ref<FormInstance>()
const submitting = ref(false)
const errorMessage = ref('')

const form = reactive({
  username: '',
  password: '',
  display_name: '',
  email: '',
})

const rules: FormRules<typeof form> = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, message: '用户名至少 3 位', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
}

async function handleRegister() {
  if (!formRef.value) {
    return
  }

  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) {
    return
  }

  submitting.value = true
  errorMessage.value = ''

  try {
    const response = await register({
      username: form.username.trim(),
      password: form.password,
      display_name: form.display_name.trim() || undefined,
      email: form.email.trim() || undefined,
    })

    setAuthSession(response.access_token, response.user)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard'
    await router.replace(redirect)
  } catch (error: any) {
    errorMessage.value =
      error?.response?.data?.detail || error?.message || '注册失败，请检查输入信息。'
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped src="../styles/auth-pages.css"></style>
