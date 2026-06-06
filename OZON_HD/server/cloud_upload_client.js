/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('../config');

function ensureApiBase() {
  const raw = String(config.CLOUD_API_BASE || '').trim();
  if (!raw) {
    throw new Error('Missing OZON cloud API base URL.');
  }
  return raw.replace(/\/+$/, '');
}

function requestJson(method, pathname, body = null) {
  const base = ensureApiBase();
  const url = new URL(`${base}${pathname}`);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const payload = body === null ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        timeout: config.CLOUD_REQUEST_TIMEOUT_MS,
        headers: {
          accept: 'application/json',
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          let data = {};
          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch (_error) {
              return reject(new Error(`Cloud API returned invalid JSON: ${raw.slice(0, 200)}`));
            }
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            return reject(
              new Error(
                data?.detail ||
                  data?.error ||
                  `Cloud API request failed with status ${response.statusCode}`
              )
            );
          }

          resolve(data);
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error('Cloud API request timed out.'));
    });
    request.on('error', (error) => {
      reject(error);
    });

    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function buildUploadPayload({ items, localTaskId = null, source = 'ozon_hd_local', store = null }) {
  const resolvedStoreId = Number(store?.cloud_store_id || config.CLOUD_DEFAULT_STORE_ID || 0);
  const resolvedStoreName =
    String(store?.store_name || config.CLOUD_DEFAULT_STORE_NAME || '').trim() || null;

  const payload = {
    items,
    source,
    local_task_id: localTaskId,
  };

  if (resolvedStoreId > 0) {
    payload.store_id = resolvedStoreId;
  } else if (resolvedStoreName) {
    payload.store_name = resolvedStoreName;
  }

  return payload;
}

async function createUploadJob(payload) {
  return requestJson('POST', '/upload/jobs', payload);
}

async function getUploadJob(jobId) {
  return requestJson('GET', `/upload/jobs/${encodeURIComponent(jobId)}`);
}

async function refreshUploadJob(jobId) {
  return requestJson('POST', `/upload/jobs/${encodeURIComponent(jobId)}/refresh`);
}

function extractOzonStatus(remoteJob) {
  return remoteJob?.result_payload?.data?.result || remoteJob?.result_payload?.result || null;
}

module.exports = {
  buildUploadPayload,
  createUploadJob,
  getUploadJob,
  refreshUploadJob,
  extractOzonStatus,
  isEnabled: () => Boolean(config.CLOUD_UPLOAD_ENABLED),
};
