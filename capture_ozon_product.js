const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(input, limit = 120) {
  return input
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, limit);
}

function shortHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function maybeParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: text };
  }
}

function decodeWidgetStates(obj) {
  if (!obj || typeof obj !== 'object' || !obj.widgetStates || typeof obj.widgetStates !== 'object') {
    return null;
  }
  const decoded = {};
  for (const [key, value] of Object.entries(obj.widgetStates)) {
    if (typeof value === 'string') {
      const parsed = maybeParseJson(value);
      decoded[key] = parsed.ok ? parsed.value : value;
    } else {
      decoded[key] = value;
    }
  }
  return decoded;
}

function summarizeBody(body) {
  if (body === null) {
    return { kind: 'null' };
  }
  if (Array.isArray(body)) {
    return { kind: 'array', length: body.length };
  }
  if (typeof body === 'object') {
    return { kind: 'object', keys: Object.keys(body).slice(0, 30) };
  }
  return { kind: typeof body, sample: String(body).slice(0, 300) };
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.ws = null;
    this.seq = 0;
    this.waiters = new Map();
    this.eventHandlers = [];
  }

  async connect() {
    this.ws = new WebSocket(this.webSocketUrl);
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data.toString());
      if (msg.id) {
        const waiter = this.waiters.get(msg.id);
        if (waiter) {
          this.waiters.delete(msg.id);
          if (msg.error) {
            waiter.reject(new Error(JSON.stringify(msg.error)));
          } else {
            waiter.resolve(msg.result ?? {});
          }
        }
        return;
      }
      for (const handler of this.eventHandlers) {
        handler(msg);
      }
    };
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  onEvent(handler) {
    this.eventHandlers.push(handler);
  }

  async send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);
      this.waiters.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

async function getProductPage() {
  const pages = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
  const page = pages.find((p) => p.type === 'page' && /https:\/\/www\.ozon\.ru\/product\//.test(p.url));
  if (!page) {
    throw new Error('No Ozon product page is open in the debug Chrome instance.');
  }
  return page;
}

async function main() {
  const page = await getProductPage();
  const productMatch = page.url.match(/-(\d+)\/(?:\?|$)/) || page.url.match(/\/product\/.*?(\d+)(?:\/|\?|$)/);
  const productId = productMatch ? productMatch[1] : 'unknown';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.join(process.cwd(), 'captures', `ozon_product_${productId}_${stamp}`);
  const rawDir = path.join(outputDir, 'raw');
  const decodedDir = path.join(outputDir, 'decoded');
  ensureDir(rawDir);
  ensureDir(decodedDir);

  const client = new CdpClient(page.webSocketDebuggerUrl);
  const requests = new Map();
  const responseMeta = [];
  const frameIds = new Set();

  client.onEvent((msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      const p = msg.params;
      requests.set(p.requestId, {
        requestId: p.requestId,
        url: p.request.url,
        method: p.request.method,
        headers: p.request.headers,
        postData: p.request.postData || null,
        resourceType: p.type || null,
        initiator: p.initiator || null,
        documentURL: p.documentURL || null,
      });
      if (p.frameId) {
        frameIds.add(p.frameId);
      }
    }
    if (msg.method === 'Network.responseReceived') {
      const p = msg.params;
      const request = requests.get(p.requestId) || {};
      responseMeta.push({
        requestId: p.requestId,
        frameId: p.frameId || null,
        loaderId: p.loaderId || null,
        url: request.url || p.response.url,
        method: request.method || null,
        resourceType: p.type || null,
        status: p.response.status,
        mimeType: p.response.mimeType,
        headers: p.response.headers,
        fromDiskCache: !!p.response.fromDiskCache,
        fromServiceWorker: !!p.response.fromServiceWorker,
        remoteIPAddress: p.response.remoteIPAddress || null,
        timing: p.response.timing || null,
      });
      if (p.frameId) {
        frameIds.add(p.frameId);
      }
    }
  });

  await client.connect();
  await client.send('Page.enable');
  await client.send('Network.enable', { maxTotalBufferSize: 1024 * 1024 * 200, maxResourceBufferSize: 1024 * 1024 * 20 });
  await client.send('Runtime.enable');
  await client.send('DOM.enable');
  await client.send('Page.reload', { ignoreCache: true });
  await sleep(8000);

  for (let i = 0; i < 8; i += 1) {
    await client.send('Runtime.evaluate', {
      expression: `window.scrollTo({ top: document.body.scrollHeight * ${i / 7}, behavior: 'instant' });`,
      awaitPromise: true,
      returnByValue: true,
    });
    await sleep(1200);
  }
  await client.send('Runtime.evaluate', {
    expression: 'window.scrollTo({ top: 0, behavior: "instant" });',
    awaitPromise: true,
    returnByValue: true,
  });
  await sleep(2500);

  const htmlResult = await client.send('Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML',
    returnByValue: true,
  });
  fs.writeFileSync(path.join(outputDir, 'document.html'), htmlResult.result.value, 'utf8');

  const pageInfo = await client.send('Runtime.evaluate', {
    expression: `(() => ({
      title: document.title,
      url: location.href,
      userAgent: navigator.userAgent,
      lang: document.documentElement.lang,
      htmlLength: document.documentElement.outerHTML.length,
      textLength: document.body ? document.body.innerText.length : 0,
      widgetStateIds: Array.from(document.querySelectorAll('[data-widget]')).map(x => x.getAttribute('data-widget')).slice(0, 200)
    }))()`,
    returnByValue: true,
  });
  fs.writeFileSync(path.join(outputDir, 'page-info.json'), JSON.stringify(pageInfo.result.value, null, 2), 'utf8');

  responseMeta.sort((a, b) => a.url.localeCompare(b.url));
  fs.writeFileSync(path.join(outputDir, 'network-responses.json'), JSON.stringify(responseMeta, null, 2), 'utf8');

  const savedBodies = [];
  let index = 0;
  for (const meta of responseMeta) {
    if (meta.status < 200 || meta.status >= 300) {
      continue;
    }
    const looksUseful =
      meta.resourceType === 'Document' ||
      /\/api\//.test(meta.url) ||
      /json/.test(meta.mimeType) ||
      /html/.test(meta.mimeType);
    if (!looksUseful) {
      continue;
    }

    let bodyResult;
    try {
      bodyResult = await client.send('Network.getResponseBody', { requestId: meta.requestId }, 20000);
    } catch {
      continue;
    }

    let body = bodyResult.body || '';
    if (bodyResult.base64Encoded) {
      body = Buffer.from(body, 'base64').toString('utf8');
    }

    index += 1;
    const ext = /html/.test(meta.mimeType) ? 'html' : 'json';
    const baseName = `${String(index).padStart(3, '0')}_${safeName(path.basename(new URL(meta.url).pathname) || 'root')}_${shortHash(meta.url)}`;
    const rawPath = path.join(rawDir, `${baseName}.${ext}`);
    fs.writeFileSync(rawPath, body, 'utf8');

    const parsed = maybeParseJson(body);
    const record = {
      index,
      url: meta.url,
      method: meta.method,
      status: meta.status,
      mimeType: meta.mimeType,
      resourceType: meta.resourceType,
      rawFile: path.relative(outputDir, rawPath),
      summary: summarizeBody(parsed.value),
    };

    if (parsed.ok) {
      const prettyPath = path.join(decodedDir, `${baseName}.pretty.json`);
      fs.writeFileSync(prettyPath, JSON.stringify(parsed.value, null, 2), 'utf8');
      record.prettyFile = path.relative(outputDir, prettyPath);

      const widgetStates = decodeWidgetStates(parsed.value);
      if (widgetStates) {
        const widgetPath = path.join(decodedDir, `${baseName}.widgetStates.decoded.json`);
        fs.writeFileSync(widgetPath, JSON.stringify(widgetStates, null, 2), 'utf8');
        record.decodedWidgetStatesFile = path.relative(outputDir, widgetPath);
      }
    }

    savedBodies.push(record);
  }

  const apiSummary = savedBodies.filter((x) => /\/api\//.test(x.url));
  fs.writeFileSync(
    path.join(outputDir, 'saved-bodies.json'),
    JSON.stringify(savedBodies, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(outputDir, 'api-summary.json'),
    JSON.stringify(apiSummary, null, 2),
    'utf8'
  );

  const readme = [
    `Product ID: ${productId}`,
    `Captured from: ${page.url}`,
    `Saved at: ${outputDir}`,
    `Saved response bodies: ${savedBodies.length}`,
    `API response bodies: ${apiSummary.length}`,
    '',
    'Files:',
    '- document.html: page HTML after capture',
    '- page-info.json: basic page metadata',
    '- network-responses.json: all captured response metadata',
    '- saved-bodies.json: index of saved bodies and local file paths',
    '- api-summary.json: saved API responses only',
    '- raw/: raw response bodies',
    '- decoded/: pretty-printed JSON and decoded widgetStates where available',
    '',
    'Note:',
    '- widgetStates.decoded.json expands JSON strings inside widgetStates.',
    '- Some responses may be unavailable if Chrome does not retain the body buffer long enough.',
  ].join('\n');
  fs.writeFileSync(path.join(outputDir, 'README.txt'), readme, 'utf8');

  console.log(JSON.stringify({
    outputDir,
    productId,
    savedBodies: savedBodies.length,
    apiBodies: apiSummary.length,
    pageTitle: page.title,
    pageUrl: page.url,
  }, null, 2));

  client.close();
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
