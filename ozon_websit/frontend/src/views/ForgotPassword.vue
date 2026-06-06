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
          <p class="eyebrow">Account Recovery</p>
          <h2>忘记密码</h2>
          <p class="subcopy">输入注册邮箱。</p>
        </div>

        <el-form label-position="top" class="auth-form" @submit.prevent="backToLogin">
          <el-form-item label="邮箱">
            <el-input
              v-model="email"
              size="large"
              placeholder="输入注册邮箱"
              autocomplete="email"
              @keyup.enter="backToLogin"
            />
          </el-form-item>

          <el-button class="auth-button" size="large" type="primary" @click="backToLogin">
            <span>返回登录</span>
            <span class="button-arrow">→</span>
          </el-button>
        </el-form>

        <div class="auth-footer">
          <span>还没有账号？</span>
          <RouterLink class="auth-link" to="/register">去注册</RouterLink>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

const router = useRouter()
const email = ref('')

function backToLogin() {
  router.push('/login')
}
</script>

<style scoped src="../styles/auth-pages.css"></style>
