/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * 轻量任务队列 - 基于 JSON 文件存储
 * 生产环境可通过 REDIS_URL 切换到 BullMQ
 */
const { v4: uuid } = require('uuid');
const { stores } = require('./db');

function addJob(type, payload) {
  const jobId = uuid();
  stores.jobs.insert({
    id: jobId,
    type,
    payload,
    status: 'pending',
    result: null,
    error: null,
    started_at: null,
    finished_at: null,
  });
  return jobId;
}

function pickNextJob() {
  const job = stores.jobs.findOne((j) => j.status === 'pending');
  if (!job) return null;
  stores.jobs.update(job.id, { status: 'processing', started_at: new Date().toISOString() });
  return job;
}

function completeJob(jobId, result) {
  stores.jobs.update(jobId, { status: 'done', result, finished_at: new Date().toISOString() });
}

function failJob(jobId, error) {
  stores.jobs.update(jobId, { status: 'failed', error: String(error), finished_at: new Date().toISOString() });
}

module.exports = { addJob, pickNextJob, completeJob, failJob };
