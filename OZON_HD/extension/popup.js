/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
const serverUrlInput = document.getElementById('serverUrl');
const apiKeyInput = document.getElementById('apiKey');
const saveBtn = document.getElementById('saveBtn');
const collectBtn = document.getElementById('collectBtn');
const statusMsg = document.getElementById('statusMsg');
const preview = document.getElementById('preview');
const previewImg = document.getElementById('previewImg');
const previewTitle = document.getElementById('previewTitle');
const previewMeta = document.getElementById('previewMeta');

let scrapedData = null;

// 加载保存的设置
chrome.storage.local.get(['serverUrl', 'apiKey'], (data) => {
  serverUrlInput.value = data.serverUrl || 'http://localhost:3001';
  apiKeyInput.value = data.apiKey || '';
});

// 保存设置
saveBtn.addEventListener('click', () => {
  chrome.storage.local.set({
    serverUrl: serverUrlInput.value.replace(/\/+$/, ''),
    apiKey: apiKeyInput.value.trim(),
  });
  showStatus('设置已保存', 'success');
});

// 页面加载时尝试获取当前标签页的商品数据
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab || !tab.url || !tab.url.includes('ozon.ru')) {
    showStatus('请在 OZON 商品页面使用', 'info');
    return;
  }

  chrome.tabs.sendMessage(tab.id, { action: 'scrape' }, (response) => {
    if (chrome.runtime.lastError || !response || !response.data) {
      showStatus('未检测到商品数据，请在商品详情页使用', 'info');
      return;
    }

    scrapedData = response.data;
    collectBtn.disabled = false;

    // 显示预览
    previewTitle.textContent = scrapedData.title || '未知商品';
    previewMeta.textContent = `SKU: ${scrapedData.productId || '?'} · 图片: ${scrapedData.gallery?.images?.length || 0}`;
    const img = scrapedData.gallery?.images?.[0];
    if (img) previewImg.src = img;
    preview.classList.add('show');
  });
});

// 采集按钮
collectBtn.addEventListener('click', async () => {
  if (!scrapedData) return;

  const server = serverUrlInput.value.replace(/\/+$/, '');
  const apiKey = apiKeyInput.value.trim();
  if (!server || !apiKey) {
    showStatus('请先配置后端地址和 API Key', 'error');
    return;
  }

  collectBtn.disabled = true;
  collectBtn.textContent = '采集中...';
  showStatus('正在发送到后台...', 'info');

  try {
    const resp = await fetch(`${server}/api/v1/products/collect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${apiKey}`,
      },
      body: JSON.stringify({ scrapedJson: scrapedData }),
    });

    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error || '采集失败');

    showStatus(
      `采集成功! ID: ${result.product_id.slice(0, 8)}... 状态: ${result.status}`,
      'success'
    );
  } catch (err) {
    showStatus(`错误: ${err.message}`, 'error');
  } finally {
    collectBtn.disabled = false;
    collectBtn.textContent = '采集当前商品';
  }
});

function showStatus(text, type) {
  statusMsg.textContent = text;
  statusMsg.className = `status ${type}`;
}
