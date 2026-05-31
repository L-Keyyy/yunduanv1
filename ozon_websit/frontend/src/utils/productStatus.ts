const STATUS_LABELS: Record<string, string> = {
  approved: '正常',
  success: '正常',
  rejected: '失败',
  failed: '失败',
  error: '失败',
  archived: '已归档',
  created: '已创建',
  queued: '排队中',
  retrying: '重试中',
  uploading: '上传中',
  submitted: '已提交',
  processing: '处理中',
  completed: '已完成',
  completed_with_errors: '部分失败',
  queue_failed: '排队失败',
  submit_failed: '提交失败',
  canceled: '已取消',
  cancelled: '已取消',
  moderation: '审核中',
  pending: '待处理',
  active: '启用',
  inactive: '停用',
  disabled: '已禁用',
  draft: '草稿',
  unknown: '未知',
}

const normalizeStatus = (status?: string | null): string => {
  return String(status || '')
    .trim()
    .toLowerCase()
}

export const getProductStatusLabel = (status?: string | null): string => {
  const normalized = normalizeStatus(status)
  if (!normalized) return '-'
  if (STATUS_LABELS[normalized]) {
    return STATUS_LABELS[normalized]
  }
  if (/[\u4e00-\u9fff]/.test(normalized)) {
    return normalized
  }
  return '未知'
}

export const getProductStatusTagType = (
  status?: string | null
): 'success' | 'danger' | 'warning' | 'info' => {
  const normalized = normalizeStatus(status)
  if (
    normalized === 'rejected' ||
    normalized === 'failed' ||
    normalized === 'error' ||
    normalized === 'queue_failed' ||
    normalized === 'submit_failed' ||
    normalized === 'completed_with_errors' ||
    normalized === 'canceled' ||
    normalized === 'cancelled'
  ) {
    return 'danger'
  }
  if (normalized === 'archived') {
    return 'info'
  }
  if (
    normalized === 'queued' ||
    normalized === 'retrying' ||
    normalized === 'created' ||
    normalized === 'processing' ||
    normalized === 'uploading' ||
    normalized === 'submitted' ||
    normalized === 'moderation' ||
    normalized === 'pending'
  ) {
    return 'warning'
  }
  return 'info'
}
