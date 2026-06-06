<template>
  <main class="admin-login">
    <section class="login-card">
      <div class="login-head">
        <p class="eyebrow">Control Plane</p>
        <h1>后台管理登录</h1>
        <p>仅限 Super Admin 访问。</p>
      </div>

      <el-alert
        v-if="errorMessage"
        type="error"
        :closable="false"
        show-icon
        class="login-alert"
        :title="errorMessage"
      />

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        @submit.prevent="handleLogin"
      >
        <el-form-item label="用户名" prop="username">
          <el-input
            v-model="form.username"
            size="large"
            autocomplete="username"
            placeholder="输入管理员用户名"
            @keyup.enter="handleLogin"
          />
        </el-form-item>

        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            size="large"
            type="password"
            show-password
            autocomplete="current-password"
            placeholder="输入管理员密码"
            @keyup.enter="handleLogin"
          />
        </el-form-item>

        <el-button
          class="login-button"
          type="primary"
          size="large"
          :loading="submitting"
          @click="handleLogin"
        >
          进入后台
        </el-button>
      </el-form>

      <RouterLink class="back-link" to="/login">返回用户端登录</RouterLink>
    </section>
  </main>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type { FormInstance, FormRules } from 'element-plus'
import { login } from '../api/auth'
import { clearAuthSession, setAuthSession } from '../utils/auth'

const router = useRouter()
const route = useRoute()
const formRef = ref<FormInstance>()
const submitting = ref(false)
const errorMessage = ref('')

const form = reactive({
  username: '',
  password: '',
})

const rules: FormRules<typeof form> = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}

async function handleLogin() {
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
    const response = await login({
      username: form.username.trim(),
      password: form.password,
    })
    const isSuperAdmin =
      response.user.is_super_admin ||
      response.user.is_admin ||
      response.user.roles?.includes('super_admin')

    if (!isSuperAdmin) {
      clearAuthSession()
      errorMessage.value = '当前账号没有后台管理权限'
      return
    }

    setAuthSession(response.access_token, response.user)
    const redirect =
      typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/admin')
        ? route.query.redirect
        : '/admin'
    await router.replace(redirect)
  } catch (error: any) {
    errorMessage.value =
      error?.response?.data?.detail || error?.message || '登录失败，请检查账号和密码'
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.admin-login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
  background:
    radial-gradient(circle at 15% 10%, rgba(37, 99, 235, 0.14), transparent 28%),
    linear-gradient(135deg, #111827 0%, #1f2937 46%, #0f172a 100%);
  color: #0f172a;
  font-family: "HarmonyOS Sans SC", "Microsoft YaHei UI", "PingFang SC", sans-serif;
}

.login-card {
  width: min(100%, 430px);
  padding: 34px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 24px 80px rgba(15, 23, 42, 0.34);
}

.login-head {
  margin-bottom: 26px;
}

.eyebrow {
  margin: 0 0 10px;
  color: #2563eb;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.login-head h1 {
  margin: 0;
  color: #111827;
  font-size: 30px;
  line-height: 1.2;
}

.login-head p {
  margin: 10px 0 0;
  color: #64748b;
}

.login-alert {
  margin-bottom: 18px;
}

.login-button {
  width: 100%;
  margin-top: 8px;
}

.back-link {
  display: inline-flex;
  margin-top: 22px;
  color: #2563eb;
  font-size: 14px;
  font-weight: 700;
  text-decoration: none;
}
</style>
