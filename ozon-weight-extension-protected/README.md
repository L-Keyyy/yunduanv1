# Ozon Product Tools

This Chrome extension supports two main actions on an Ozon product page:

1. One-click full extraction that combines product-page data, product weight, and package weight.
2. Package-weight-only extraction from the checkout flow.
3. Seller analytics overlay cards on buyer pages, sourced from an authenticated open `seller.ozon.ru` tab.

Current one-click full extraction behavior:

1. Start on an Ozon product page.
2. Read SSR `data-state` widgets already present in the page.
3. Parse rich description HTML and text from the DOM.
4. Parse tags, characteristics, images, videos, brand, breadcrumbs, and seller info.
5. Request the checkout flow in the background and parse package weight.
6. Merge everything into one JSON payload.
7. If the direct request flow is blocked, fall back to DOM automation and continue in checkout.

Current weight-only behavior:

1. Start on an Ozon product page.
2. Read the hidden `webOneClickButton` state from the page.
3. POST directly to the one-click checkout endpoint without navigating.
4. Parse the returned checkout HTML SSR `data-state`.
5. Fallback to an `addToCart` request if one-click is unavailable or blocked.
6. If both direct requests are blocked, click the real page buttons and continue in checkout.

Current seller analytics overlay behavior:

1. Keep a logged-in `seller.ozon.ru` analytics tab open.
2. Open any buyer-side Ozon product page, search page, category page, or recommendation feed.
3. The buyer page collects visible product IDs from product links already present in the DOM.
4. The extension background resolves the current seller company context from the open seller tab.
5. The background asks the seller tab content script to call `POST /api/site/seller-analytics/what_to_sell/data/v3` for missing product IDs, using the seller tab's first-party session.
6. Responses are normalized and cached in `chrome.storage.local`.
7. Buyer pages render a gray analytics panel under each matched product card or product detail block.
8. As more cards appear while scrolling, the page requests additional missing IDs and appends more panels.

Current limitations:

- It does not use a public stable API.
- It depends on the current product page structure.
- The DOM or `addToCart` fallback may leave the item in the cart.
- One-click full extraction still depends on the current checkout and delivery context for package weight.
- Ozon may trigger antibot checks after repeated automated requests or navigation.
- Seller analytics overlay currently depends on having at least one authenticated `seller.ozon.ru` tab open.
- Seller analytics data is fetched through seller-internal endpoints and is not based on a public stable API.
- Buyer pages may need one refresh after installing or reloading the unpacked extension.

Install:

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `D:\ozon\ozon-weight-extension`

Use:

1. Open an Ozon product page in the logged-in browser session.
2. Click the extension icon.
3. Click `One-Click Extract All` to build a combined payload in extension state.
4. Or click `Get Package Weight Only` if you only need the package weight.
5. For seller analytics overlays, keep the seller analytics tab open in the same Chrome instance and browse buyer pages normally.
