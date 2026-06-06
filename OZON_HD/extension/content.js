/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * Content Script - 在 OZON 页面中提取商品 JSON
 *
 * 寻找页面中嵌入的 __NEXT_DATA__ 或 state JSON 来提取商品数据。
 * 抓取模块的 JSON 格式与此处的提取方式保持一致。
 */

function extractProductData() {
  // 方式 1: 从 __NEXT_DATA__ 提取
  const nextDataEl = document.getElementById('__NEXT_DATA__');
  if (nextDataEl) {
    try {
      const nextData = JSON.parse(nextDataEl.textContent);
      const pageProps = nextData?.props?.pageProps;
      if (pageProps?.product) return pageProps.product;
    } catch {}
  }

  // 方式 2: 从 state JSON script 标签提取
  const scripts = document.querySelectorAll('script[type="application/json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent);
      if (data?.productId || data?.product?.productId) {
        return data.product || data;
      }
      // 递归查找包含 productId 的对象
      const found = findProductInObj(data, 3);
      if (found) return found;
    } catch {}
  }

  // 方式 3: 从 window.__state 提取
  try {
    const stateScript = document.querySelector('script:not([src])');
    if (stateScript) {
      const match = stateScript.textContent.match(/window\.__STATE__\s*=\s*({.+?});/s);
      if (match) {
        const state = JSON.parse(match[1]);
        const found = findProductInObj(state, 4);
        if (found) return found;
      }
    }
  } catch {}

  return null;
}

function findProductInObj(obj, maxDepth, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > maxDepth) return null;
  if (obj.productId && (obj.title || obj.characteristics || obj.gallery)) return obj;
  for (const key of Object.keys(obj)) {
    const found = findProductInObj(obj[key], maxDepth, depth + 1);
    if (found) return found;
  }
  return null;
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'scrape') {
    const data = extractProductData();
    sendResponse({ data });
  }
  return true;
});
