/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
const OMTOZON_ORIGIN = 'http://35.209.87.105';
const AUTH_COOKIE_NAME = 'omtozon_token';

const loginBtn = document.getElementById('loginBtn');
const refreshAuthBtn = document.getElementById('refreshAuthBtn');
const authStatus = document.getElementById('authStatus');
const authUser = document.getElementById('authUser');
const collectBtn = document.getElementById('collectBtn');
const statusMsg = document.getElementById('statusMsg');
const preview = document.getElementById('preview');
const previewImg = document.getElementById('previewImg');
const previewTitle = document.getElementById('previewTitle');
const previewMeta = document.getElementById('previewMeta');

let scrapedData = null;
let cloudAuthReady = false;
let busy = false;

function setStatus(text, type) {
  statusMsg.textContent = text;
  statusMsg.className = `status ${type}`;
}

function setAuthStatus(text, type) {
  authStatus.textContent = text;
  authStatus.className = `auth-state ${type}`;
}

function updateCollectAvailability() {
  collectBtn.disabled = busy || !cloudAuthReady || !scrapedData;
}

function getOmtozonCookie() {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: OMTOZON_ORIGIN, name: AUTH_COOKIE_NAME }, (cookie) => {
      resolve(cookie || null);
    });
  });
}

function authHeaders(cookie) {
  return cookie?.value ? { Authorization: `Bearer ${cookie.value}` } : {};
}

async function verifyOmtozonLogin() {
  setAuthStatus('正在验证 omtozon 登录态...', 'checking');
  authUser.textContent = '';
  cloudAuthReady = false;
  updateCollectAvailability();

  const cookie = await getOmtozonCookie();
  if (!cookie) {
    setAuthStatus('未检测到 omtozon 登录 cookie', 'locked');
    setStatus('请先登录 35.209.87.105，登录后再重新打开扩展。', 'error');
    return false;
  }

  try {
    const resp = await fetch(`${OMTOZON_ORIGIN}/api/v1/me`, {
      credentials: 'include',
      headers: authHeaders(cookie),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.error || '登录已失效');
    }

    cloudAuthReady = true;
    setAuthStatus('omtozon 云端已连接', 'ready');
    authUser.textContent = data.email ? `当前账号：${data.email}` : '登录态验证通过';
    if (scrapedData) {
      setStatus('登录态正常，可以采集当前商品。', 'success');
    }
    updateCollectAvailability();
    return true;
  } catch (error) {
    setAuthStatus('omtozon 登录态无效', 'locked');
    setStatus(`请重新登录 35.209.87.105：${error.message}`, 'error');
    updateCollectAvailability();
    return false;
  }
}

function detectCurrentProduct() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.includes('ozon.ru')) {
      setStatus('请在 OZON 商品页面使用', 'info');
      updateCollectAvailability();
      return;
    }

    chrome.tabs.sendMessage(tab.id, { action: 'scrape' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.data) {
        setStatus('未检测到商品数据，请在商品详情页使用', 'info');
        updateCollectAvailability();
        return;
      }

      scrapedData = response.data;
      previewTitle.textContent = scrapedData.title || '未知商品';
      previewMeta.textContent = `SKU: ${scrapedData.productId || '?'} · 图片: ${
        scrapedData.gallery?.images?.length || 0
      }`;
      const img = scrapedData.gallery?.images?.[0];
      if (img) previewImg.src = img;
      preview.classList.add('show');
      if (cloudAuthReady) {
        setStatus('登录态正常，可以采集当前商品。', 'success');
      }
      updateCollectAvailability();
    });
  });
}

loginBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: OMTOZON_ORIGIN });
});

refreshAuthBtn.addEventListener('click', () => {
  verifyOmtozonLogin();
});

collectBtn.addEventListener('click', async () => {
  if (!scrapedData) return;

  const allowed = await verifyOmtozonLogin();
  if (!allowed) return;

  busy = true;
  updateCollectAvailability();
  collectBtn.textContent = '采集中...';
  setStatus('正在发送到 omtozon 云端...', 'info');

  try {
    const cookie = await getOmtozonCookie();
    const resp = await fetch(`${OMTOZON_ORIGIN}/api/v1/products/collect`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(cookie),
      },
      body: JSON.stringify({ scrapedJson: scrapedData }),
    });

    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error || '采集失败');

    setStatus(
      `采集成功! ID: ${result.product_id.slice(0, 8)}... 状态: ${result.status}`,
      'success'
    );
  } catch (err) {
    setStatus(`错误: ${err.message}`, 'error');
  } finally {
    busy = false;
    collectBtn.textContent = '采集当前商品';
    updateCollectAvailability();
  }
});

verifyOmtozonLogin();
detectCurrentProduct();
