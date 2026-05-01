import { computed, onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { fetchJobStatus, type AsyncTaskStatusResponse, type AsyncTaskSubmitResponse } from '../api/jobs'

interface AsyncJobRunOptions {
  successMessage?: string | ((status: AsyncTaskStatusResponse) => string)
  failureMessage?: string | ((status: AsyncTaskStatusResponse) => string)
  onSuccess?: (status: AsyncTaskStatusResponse) => void | Promise<void>
  onFailure?: (status: AsyncTaskStatusResponse) => void | Promise<void>
  pollIntervalMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 2000

const resolveMessage = <T>(
  value: string | ((payload: T) => string) | undefined,
  payload: T,
  fallback: string
) => {
  if (typeof value === 'function') {
    return value(payload) || fallback
  }
  return value || fallback
}

export const useAsyncJob = () => {
  const taskId = ref('')
  const taskName = ref('')
  const status = ref('')
  const result = ref<any>(null)
  const errorMessage = ref('')
  const running = ref(false)
  const lastUpdatedAt = ref('')

  let pollTimer: number | null = null

  const stopPolling = () => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
  }

  const clearState = () => {
    taskId.value = ''
    taskName.value = ''
    status.value = ''
    result.value = null
    errorMessage.value = ''
    running.value = false
    lastUpdatedAt.value = ''
    stopPolling()
  }

  const refreshStatus = async (options: AsyncJobRunOptions = {}) => {
    if (!taskId.value) return null

    try {
      const response = await fetchJobStatus(taskId.value)
      taskName.value = response.task_name || taskName.value
      status.value = response.status
      result.value = response.result ?? result.value
      errorMessage.value = response.error || ''
      lastUpdatedAt.value = new Date().toLocaleString('zh-CN', { hour12: false })
      running.value = !response.ready

      if (!response.ready) {
        return response
      }

      stopPolling()

      if (response.successful) {
        ElMessage.success(resolveMessage(options.successMessage, response, '操作完成'))
        if (options.onSuccess) {
          await options.onSuccess(response)
        }
        return response
      }

      const failureText = resolveMessage(
        options.failureMessage,
        response,
        response.error || '操作失败'
      )
      ElMessage.error(failureText)
      if (options.onFailure) {
        await options.onFailure(response)
      }
      return response
    } catch (error: any) {
      stopPolling()
      running.value = false
      errorMessage.value = error.response?.data?.detail || '操作状态更新失败'
      ElMessage.error(errorMessage.value)
      return null
    }
  }

  const runJob = async (
    submitter: () => Promise<AsyncTaskSubmitResponse>,
    options: AsyncJobRunOptions = {}
  ) => {
    if (running.value) {
      ElMessage.warning('操作正在执行，请稍后')
      return null
    }

    try {
      result.value = null
      errorMessage.value = ''

      const submission = await submitter()
      taskId.value = submission.task_id
      taskName.value = submission.task_name
      status.value = submission.status
      running.value = true
      lastUpdatedAt.value = new Date().toLocaleString('zh-CN', { hour12: false })

      await refreshStatus(options)
      if (!running.value) {
        return submission
      }

      stopPolling()
      pollTimer = window.setInterval(() => {
        void refreshStatus(options)
      }, options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS)

      return submission
    } catch (error: any) {
      clearState()
      ElMessage.error(error.response?.data?.detail || '操作失败')
      return null
    }
  }

  const isFinished = computed(() => Boolean(taskId.value) && !running.value)

  onBeforeUnmount(() => {
    stopPolling()
  })

  return {
    taskId,
    taskName,
    status,
    result,
    errorMessage,
    running,
    isFinished,
    lastUpdatedAt,
    clearState,
    refreshStatus,
    runJob,
  }
}
