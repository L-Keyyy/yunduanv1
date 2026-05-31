import { createRouter, createWebHistory } from 'vue-router'
import { isAdminAuthenticated, isAuthenticated } from '../utils/auth'

const routes = [
  {
    path: '/',
    redirect: () => (isAuthenticated() ? '/dashboard' : '/login')
  },
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/Login.vue'),
    meta: {
      public: true
    }
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('../views/Register.vue'),
    meta: {
      public: true
    }
  },
  {
    path: '/forgot-password',
    name: 'ForgotPassword',
    component: () => import('../views/ForgotPassword.vue'),
    meta: {
      public: true
    }
  },
  {
    path: '/admin/login',
    name: 'AdminLogin',
    component: () => import('../views/AdminLogin.vue'),
    meta: {
      public: true
    }
  },
  {
    path: '/admin',
    name: 'AdminDashboard',
    component: () => import('../views/AdminDashboard.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: true
    }
  },
  {
    path: '/dashboard',
    name: 'Dashboard',
    component: () => import('../views/Dashboard.vue'),
    meta: { requiresAuth: true, keepAlive: true }
  },
  {
    path: '/store-management',
    name: 'StoreManagement',
    component: () => import('../views/StoreManagement.vue'),
    meta: { requiresAuth: true, keepAlive: true }
  },
  {
    path: '/upload-records',
    name: 'UploadRecords',
    component: () => import('../views/CollectionUpload.vue'),
    meta: { requiresAuth: true, keepAlive: true }
  },
  {
    path: '/products',
    name: 'Products',
    component: () => import('../views/Products.vue'),
    meta: { requiresAuth: true, keepAlive: true }
  },
  {
    path: '/inventory',
    name: 'Inventory',
    component: () => import('../views/Inventory.vue'),
    meta: { requiresAuth: true, keepAlive: true }
  },
  {
    path: '/orders',
    name: 'Orders',
    component: () => import('../views/Orders.vue'),
    meta: { requiresAuth: true, keepAlive: true }
  },
  {
    path: '/warehouse',
    redirect: '/orders'
  },
  {
    path: '/activities',
    name: 'Activities',
    component: () => import('../views/Activities.vue'),
    meta: { requiresAuth: true, keepAlive: true }
  },
  {
    path: '/messages',
    name: 'Messages',
    component: () => import('../views/Messages.vue'),
    meta: { requiresAuth: true, keepAlive: true }
  },
  {
    path: '/data-analysis',
    name: 'DataAnalysis',
    component: () => import('../views/DataAnalysis.vue'),
    meta: { requiresAuth: true, keepAlive: true }
  },
  {
    path: '/commissions',
    name: 'Commissions',
    component: () => import('../views/Commissions.vue'),
    meta: { requiresAuth: true, keepAlive: true }
  },
  {
    path: '/hot-tags',
    name: 'HotTags',
    component: () => import('../views/HotTags.vue'),
    meta: { requiresAuth: true, keepAlive: true }
  },
  {
    path: '/pricing-calculator',
    name: 'PricingCalculator',
    component: () => import('../views/PricingCalculator.vue'),
    meta: { requiresAuth: true, keepAlive: true }
  },
  {
    path: '/cloud-follow',
    name: 'CloudFollow',
    component: () => import('../views/CloudFollow.vue'),
    meta: { requiresAuth: true, keepAlive: true }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach((to) => {
  const authenticated = isAuthenticated()
  const adminRoute = Boolean(to.meta.requiresAdmin) || to.path.startsWith('/admin')
  const requiresAuth = Boolean(to.meta.requiresAuth)
  const isPublic = Boolean(to.meta.public)

  if (requiresAuth && !authenticated) {
    return {
      path: adminRoute ? '/admin/login' : '/login',
      query: {
        redirect: to.fullPath
      }
    }
  }

  if (Boolean(to.meta.requiresAdmin) && authenticated && !isAdminAuthenticated()) {
    return '/dashboard'
  }

  if ((to.path === '/login' || to.path === '/register' || to.path === '/forgot-password' || to.path === '/admin/login') && authenticated) {
    const defaultRedirect = to.path === '/admin/login'
      ? (isAdminAuthenticated() ? '/admin' : '/dashboard')
      : '/dashboard'
    const redirect = typeof to.query.redirect === 'string' ? to.query.redirect : defaultRedirect
    if (redirect.startsWith('/admin') && !isAdminAuthenticated()) {
      return '/dashboard'
    }
    return redirect
  }

  if (!isPublic && !requiresAuth && !authenticated) {
    return '/login'
  }

  return true
})

export default router
