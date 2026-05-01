<template>
  <div class="auth-shell">
    <section class="auth-brand">
      <RouterLink class="brand-wordmark" to="/">欧卖通</RouterLink>

      <div class="brand-copy">
        <h1>智能化数据分析</h1>
        <p>
          欧卖通合作运营商，您身边的跨境助手
        </p>
      </div>

      <RouterLink class="back-link" to="/">返回</RouterLink>
    </section>

    <main class="auth-main">
      <section class="auth-panel">
        <div class="card-head">
          <p class="eyebrow">Secure Access</p>
          <h2>账号登录</h2>
          <p class="subcopy">输入账号后进入欧卖通工作台。</p>
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
          @submit.prevent="handleLogin"
        >
          <el-form-item label="用户名" prop="username">
            <el-input
              v-model="form.username"
              size="large"
              placeholder="输入登录用户名"
              autocomplete="username"
              @keyup.enter="handleLogin"
            />
          </el-form-item>

          <el-form-item label="密码" prop="password">
            <el-input
              v-model="form.password"
              size="large"
              type="password"
              show-password
              placeholder="输入登录密码"
              autocomplete="current-password"
              @keyup.enter="handleLogin"
            />
          </el-form-item>

          <div class="form-row">
            <el-checkbox>记住登录</el-checkbox>
            <RouterLink class="subtle-link" to="/forgot-password">忘记密码？</RouterLink>
          </div>

          <el-button
            class="auth-button"
            size="large"
            type="primary"
            :loading="submitting"
            @click="handleLogin"
          >
            <span>登录工作台</span>
            <span class="button-arrow">→</span>
          </el-button>
        </el-form>

        <div class="auth-divider">Or</div>

        <button class="google-button" type="button">
          <span class="google-mark">G</span>
          <span>使用 Google 账号登录</span>
        </button>

        <div class="auth-tip">
          <span>首次启动</span>
        </div>

        <div class="auth-footer">
          <span>还没有账号？</span>
          <RouterLink class="auth-link" to="/register">去注册</RouterLink>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type { FormInstance, FormRules } from 'element-plus'
import { login } from '../api/auth'
import { setAuthSession } from '../utils/auth'

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
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, message: '用户名至少 3 位', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
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

    setAuthSession(response.access_token, response.user)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard'
    await router.replace(redirect)
  } catch (error: any) {
    errorMessage.value =
      error?.response?.data?.detail || error?.message || '登录失败，请检查账号和密码。'
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.auth-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(320px, 38vw) minmax(0, 1fr);
  background: #f9f9fb;
  color: #2d2b37;
  font-family: "HarmonyOS Sans SC", "Microsoft YaHei UI", "PingFang SC", sans-serif;
}

.auth-brand {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: clamp(48px, 8vw, 132px) clamp(36px, 7vw, 110px);
  background:
    radial-gradient(circle at 68% 16%, rgba(95, 72, 242, 0.12), transparent 26%),
    linear-gradient(180deg, #eeecff 0%, #f0efff 100%);
}

.brand-wordmark {
  width: fit-content;
  color: #5b48f2;
  font-size: clamp(48px, 5vw, 76px);
  font-weight: 750;
  letter-spacing: -0.08em;
  line-height: 0.9;
  text-decoration: none;
}

.brand-copy {
  max-width: 470px;
  transform: translateY(18px);
}

.brand-copy h1 {
  margin: 0;
  max-width: 420px;
  color: #2f2d39;
  font-size: clamp(30px, 3.2vw, 44px);
  font-weight: 520;
  line-height: 1.22;
  letter-spacing: -0.035em;
}

.brand-copy p {
  margin: 18px 0 0;
  max-width: 390px;
  color: #5f5a72;
  font-size: 15px;
  line-height: 1.9;
}

.back-link {
  width: fit-content;
  color: #5b48f2;
  font-size: 15px;
  font-weight: 650;
  text-decoration: none;
}

.back-link::before {
  content: "‹";
  margin-right: 9px;
  font-size: 22px;
  line-height: 0;
  vertical-align: -1px;
}

.auth-main {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: clamp(32px, 6vw, 96px);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.72), rgba(247, 247, 250, 0.88)),
    radial-gradient(circle at 82% 92%, rgba(91, 72, 242, 0.08), transparent 26%);
}

.auth-panel {
  width: min(100%, 460px);
  animation: auth-panel-in 0.56s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.card-head {
  margin-bottom: 34px;
  text-align: center;
}

.eyebrow,
.subcopy {
  display: none;
}

.card-head h2 {
  margin: 0;
  color: #2f2d39;
  font-size: 36px;
  font-weight: 620;
  line-height: 1.1;
  letter-spacing: -0.03em;
}

.auth-alert {
  margin-bottom: 18px;
}

.auth-form {
  display: grid;
  gap: 16px;
}

.auth-form :deep(.el-form-item) {
  margin-bottom: 0;
}

.auth-form :deep(.el-form-item__label) {
  display: none;
}

.auth-form :deep(.el-input__wrapper) {
  min-height: 78px;
  padding: 0 20px;
  border: 1px solid #d8d2ff;
  border-radius: 16px;
  background: #fbfbfd;
  box-shadow: none;
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease,
    transform 0.2s ease;
}

.auth-form :deep(.el-input__wrapper:hover),
.auth-form :deep(.el-input__wrapper.is-focus) {
  border-color: #8877ff;
  background: #ffffff;
  transform: translateY(-1px);
  box-shadow: none;
}

.auth-form :deep(.el-input__inner) {
  color: #3f3b56;
  font-size: 15px;
  font-weight: 520;
}

.auth-form :deep(.el-input__inner::placeholder) {
  color: #53506b;
  opacity: 0.88;
}

.form-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 4px 4px 18px;
  color: #4d4a62;
  font-size: 14px;
}

.form-row :deep(.el-checkbox__label) {
  color: #4d4a62;
  font-weight: 560;
}

.form-row :deep(.el-checkbox__inner) {
  width: 18px;
  height: 18px;
  border-color: #beb5ff;
  border-radius: 5px;
  background: #f3f1ff;
}

.form-row :deep(.el-checkbox__input.is-checked .el-checkbox__inner) {
  border-color: #5b48f2;
  background: #5b48f2;
}

.subtle-link {
  color: #4d4a62;
  font-weight: 650;
  text-decoration: none;
}

.auth-button {
  width: 100%;
  height: 54px;
  border: none;
  border-radius: 15px;
  background: #553df1;
  box-shadow: none;
  font-size: 16px;
  font-weight: 650;
  transition:
    background-color 0.2s ease,
    transform 0.2s ease;
}

.auth-button:hover {
  background: #4a35de;
  transform: translateY(-1px);
}

.auth-button :deep(span) {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.button-arrow {
  font-size: 22px;
  line-height: 0;
}

.auth-divider {
  margin: 34px 0 26px;
  color: #68647a;
  font-size: 15px;
  font-weight: 520;
  text-align: center;
}

.google-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  width: fit-content;
  min-width: 194px;
  min-height: 40px;
  margin: 0 auto;
  padding: 8px 18px;
  border: 1px solid #dedde8;
  border-radius: 4px;
  background: #ffffff;
  color: #32303f;
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
}

.google-mark {
  color: #4285f4;
  font-weight: 800;
}

.auth-tip {
  margin: 26px auto 0;
  max-width: 360px;
  color: #7a768a;
  font-size: 12px;
  line-height: 1.7;
  text-align: center;
}

.auth-tip span {
  display: none;
}

.auth-tip code {
  color: inherit;
  font-family: inherit;
  font-size: inherit;
}

.auth-footer {
  margin-top: 24px;
  display: flex;
  justify-content: center;
  gap: 8px;
  color: #4d4a62;
  font-size: 15px;
  font-weight: 560;
}

.auth-link {
  color: #553df1;
  font-weight: 700;
  text-decoration: none;
}

@keyframes auth-panel-in {
  from {
    opacity: 0;
    transform: translateY(18px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 900px) {
  .auth-shell {
    grid-template-columns: 1fr;
  }

  .auth-brand {
    min-height: 38vh;
    padding: 36px 28px;
    gap: 48px;
  }

  .brand-copy {
    transform: none;
  }

  .auth-main {
    min-height: auto;
    padding: 42px 24px 56px;
  }
}

@media (max-width: 520px) {
  .auth-form :deep(.el-input__wrapper) {
    min-height: 64px;
    border-radius: 14px;
  }

  .form-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }

  .card-head h2 {
    font-size: 30px;
  }
}
</style>
