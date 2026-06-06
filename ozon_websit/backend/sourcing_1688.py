import asyncio
import base64
import hashlib
import json
import math
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import quote, urlencode

import httpx


APP_KEY = "12574478"
BASE_URL = "https://h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
)


def _normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _deep_get(data: Any, paths: Iterable[str], default: Any = None) -> Any:
    for path in paths:
        current = data
        for part in path.split("."):
            if isinstance(current, dict) and part in current:
                current = current[part]
            else:
                current = None
                break
        if current not in (None, ""):
            return current
    return default


def _parse_number(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    raw = _normalize_text(value)
    if not raw or raw == "-":
        return None
    compact = re.sub(r"\s+", "", raw)
    last_comma = compact.rfind(",")
    last_dot = compact.rfind(".")
    if last_comma >= 0 and last_dot >= 0:
        if last_comma > last_dot:
            compact = compact.replace(".", "").replace(",", ".")
        else:
            compact = compact.replace(",", "")
    elif last_comma >= 0:
        compact = compact.replace(",", ".") if re.search(r",\d{1,2}$", compact) else compact.replace(",", "")
    match = re.search(r"-?\d+(?:\.\d+)?", compact)
    if not match:
        return None
    try:
        parsed = float(match.group(0))
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def _first_number(values: Iterable[Any]) -> Optional[float]:
    for value in values:
        parsed = _parse_number(value)
        if parsed is not None:
            return parsed
    return None


def _jsonp_to_json(text: str) -> Optional[Dict[str, Any]]:
    raw = text or ""
    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(raw[start:end])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _sign(token_part: str, timestamp: str, data_string: str) -> str:
    source = f"{token_part}&{timestamp}&{APP_KEY}&{data_string}"
    return hashlib.md5(source.encode("utf-8")).hexdigest()


def _image_request_data(image_bytes: bytes) -> str:
    params_data = {
        "searchScene": "imageEx",
        "interfaceName": "imageBase64ToImageId",
        "serviceParam.extendParam[imageBase64]": base64.b64encode(image_bytes).decode("utf-8"),
        "subChannel": "pc_image_search_image_id",
    }
    return json.dumps(
        {"appId": 32517, "params": json.dumps(params_data, ensure_ascii=False)},
        ensure_ascii=False,
    )


def _tokens(value: str) -> List[str]:
    text = _normalize_text(value).lower()
    parts = re.findall(r"[\w\u4e00-\u9fff]{2,}", text, flags=re.UNICODE)
    ignored = {
        "для",
        "and",
        "the",
        "with",
        "без",
        "бренда",
        "шт",
        "pcs",
        "ozon",
    }
    return [part for part in parts if part not in ignored]


def _title_score(ozon_title: str, candidate_title: str) -> float:
    source = set(_tokens(ozon_title))
    target = set(_tokens(candidate_title))
    if not source or not target:
        return 0.0
    overlap = len(source & target)
    return round(overlap / max(1, min(len(source), len(target))), 4)


def _best_image(raw: Dict[str, Any]) -> Optional[str]:
    candidates = [
        _deep_get(raw, ["image.imgUrl", "image.url", "picUrl", "imgUrl", "imageUrl", "mainPicUrl", "offerImg"]),
    ]
    image_list = _deep_get(raw, ["images", "imageList", "picList"], [])
    if isinstance(image_list, list):
        for item in image_list:
            if isinstance(item, str):
                candidates.append(item)
            elif isinstance(item, dict):
                candidates.append(_deep_get(item, ["url", "imgUrl", "imageUrl"]))
    for candidate in candidates:
        text = _normalize_text(candidate)
        if text:
            if text.startswith("//"):
                return f"https:{text}"
            return text
    return None


def _offer_url(raw: Dict[str, Any], offer_id: str) -> str:
    url = _normalize_text(
        _deep_get(raw, ["url", "offerUrl", "detailUrl", "itemUrl", "auctionURL", "traceUrl"], "")
    )
    if url:
        if url.startswith("//"):
            return f"https:{url}"
        return url
    return f"https://m.1688.com/offer/{offer_id}.html" if offer_id else ""


def _tier_prices(raw: Dict[str, Any]) -> List[Dict[str, Any]]:
    source = _deep_get(raw, ["priceInfo.priceRanges", "priceInfo.tierPrices", "tierPrices", "priceRanges"], [])
    result: List[Dict[str, Any]] = []
    if not isinstance(source, list):
        return result
    for item in source:
        if not isinstance(item, dict):
            continue
        price = _first_number([item.get("price"), item.get("priceText"), item.get("priceRange")])
        begin_amount = _first_number([item.get("beginAmount"), item.get("startQuantity"), item.get("quantity")])
        if price is None:
            continue
        result.append(
            {
                "price": price,
                "beginAmount": int(begin_amount) if begin_amount is not None else None,
            }
        )
    return result


def _normalize_candidate(raw_item: Dict[str, Any], ozon_title: str, search_method: str) -> Optional[Dict[str, Any]]:
    raw = raw_item.get("data") if isinstance(raw_item.get("data"), dict) else raw_item
    if not isinstance(raw, dict):
        return None

    offer_id = _normalize_text(
        _deep_get(raw, ["offerId", "id", "offer_id", "itemId", "auctionId", "traceId"], "")
    )
    if not offer_id:
        url_text = _normalize_text(_deep_get(raw, ["url", "detailUrl", "itemUrl"], ""))
        match = re.search(r"offer/(\d+)", url_text)
        offer_id = match.group(1) if match else ""

    title = _normalize_text(
        _deep_get(raw, ["title", "subject", "shortTitle", "traceTitle", "name", "offerTitle"], "")
    )
    if not offer_id and not title:
        return None

    tier_prices = _tier_prices(raw)
    price_from = _first_number(
        [
            _deep_get(raw, ["priceFrom", "priceInfo.price", "priceInfo.priceText", "price", "strPriceMoney"]),
            *(item.get("price") for item in tier_prices),
        ]
    )
    price_to = _first_number([_deep_get(raw, ["priceTo", "priceInfo.maxPrice", "maxPrice", "priceInfo.price"])])
    min_order_quantity = _first_number(
        [_deep_get(raw, ["minOrderQuantity", "moq", "minOrder", "saleInfo.minOrderQuantity"])]
    )
    unit_weight = _first_number(
        [_deep_get(raw, ["logistics.unitWeight", "unitWeight", "weight", "skuInfo.unitWeight"])]
    )
    seller = _normalize_text(
        _deep_get(
            raw,
            [
                "sellerCompany",
                "sellerLoginId",
                "shopAddition.text",
                "shopName",
                "companyName",
                "loginId",
            ],
            "",
        )
    )
    location = _normalize_text(
        _deep_get(raw, ["location", "province", "provinceName", "city", "area"], "")
    )
    sold_count = _first_number([_deep_get(raw, ["soldCount", "saleQuantity", "bookedCount", "saleCount"])])
    candidate_title_score = _title_score(ozon_title, title)
    score = candidate_title_score + (0.35 if search_method == "image" else 0.0)
    if price_from is not None:
        score += 0.05
    if sold_count is not None and sold_count > 0:
        score += 0.05

    return {
        "offerId": offer_id,
        "title": title or f"1688 offer {offer_id}",
        "url": _offer_url(raw, offer_id),
        "image": _best_image(raw),
        "priceFrom": price_from,
        "priceTo": price_to,
        "tierPrices": tier_prices,
        "minOrderQuantity": int(min_order_quantity) if min_order_quantity is not None else None,
        "unitWeight": unit_weight,
        "seller": seller,
        "location": location,
        "soldCount": sold_count,
        "searchMethod": search_method,
        "matchScore": round(min(score, 1.0), 4),
        "titleScore": candidate_title_score,
        "raw": raw,
    }


@dataclass
class SourcingProduct:
    product_id: int
    title: str
    image_url: Optional[str] = None
    product_url: Optional[str] = None
    follow_price: Optional[float] = None
    market_price: Optional[float] = None
    min_follow_price: Optional[float] = None
    weight_g: Optional[float] = None
    monthly_sales: Optional[float] = None


class Sourcing1688Client:
    def __init__(self, timeout_seconds: float = 20.0):
        self.timeout = httpx.Timeout(timeout_seconds)
        self.cookies: Dict[str, str] = {}
        self.token_part: Optional[str] = None

    async def compare_products(
        self,
        products: List[SourcingProduct],
        max_candidates: int = 5,
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            await self._initialize(client)
            semaphore = asyncio.Semaphore(2)

            async def compare_one(product: SourcingProduct) -> Dict[str, Any]:
                async with semaphore:
                    return await self._compare_one(client, product, max_candidates)

            results = await asyncio.gather(*(compare_one(product) for product in products))

        return {
            "items": results,
            "meta": {
                "source": "1688_h5_mtop",
                "maxCandidates": max_candidates,
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
        }

    async def _initialize(self, client: httpx.AsyncClient) -> None:
        headers = {
            "user-agent": USER_AGENT,
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
        }
        for url in (
            "https://www.1688.com",
            "https://s.1688.com",
            "https://s.1688.com/selloffer/offer_search.htm?keywords=sample",
        ):
            try:
                response = await client.get(url, headers=headers)
                self._merge_cookies(response)
            except Exception:
                continue

        try:
            response = await client.get(
                BASE_URL,
                params={
                    "jsv": "2.7.4",
                    "appKey": APP_KEY,
                    "t": str(int(time.time() * 1000)),
                    "api": "mtop.relationrecommend.WirelessRecommend.recommend",
                    "v": "2.0",
                    "type": "originaljson",
                },
                headers={"user-agent": USER_AGENT},
            )
            self._merge_cookies(response)
        except Exception:
            pass

        token = self.cookies.get("_m_h5_tk") or client.cookies.get("_m_h5_tk")
        token_text = _normalize_text(token)
        self.token_part = token_text.split("_", 1)[0] if token_text else None

    def _merge_cookies(self, response: httpx.Response) -> None:
        for name, value in response.cookies.items():
            self.cookies[name] = value

    def _cookie_header(self) -> str:
        return "; ".join(f"{name}={value}" for name, value in self.cookies.items())

    async def _compare_one(
        self,
        client: httpx.AsyncClient,
        product: SourcingProduct,
        max_candidates: int,
    ) -> Dict[str, Any]:
        errors: List[str] = []
        candidates: List[Dict[str, Any]] = []
        if product.image_url:
            try:
                image_candidates = await self._search_by_image_url(client, product.image_url, product.title)
                candidates.extend(image_candidates)
            except Exception as exc:
                errors.append(f"image_search_failed: {exc}")

        if not candidates and product.title:
            try:
                text_candidates = await self._search_by_text(client, product.title, product.title)
                candidates.extend(text_candidates)
            except Exception as exc:
                errors.append(f"text_search_failed: {exc}")

        deduped: Dict[str, Dict[str, Any]] = {}
        for candidate in candidates:
            key = candidate.get("offerId") or candidate.get("url") or candidate.get("title")
            if not key:
                continue
            existing = deduped.get(str(key))
            if not existing or candidate.get("matchScore", 0) > existing.get("matchScore", 0):
                deduped[str(key)] = candidate

        sorted_candidates = sorted(
            deduped.values(),
            key=lambda item: (item.get("matchScore") or 0, -(item.get("priceFrom") or 0)),
            reverse=True,
        )[:max_candidates]
        best = sorted_candidates[0] if sorted_candidates else None
        return {
            "productId": product.product_id,
            "status": "ok" if best else "not_found",
            "query": {
                "title": product.title,
                "imageUrl": product.image_url,
                "productUrl": product.product_url,
            },
            "candidates": sorted_candidates,
            "bestCandidate": best,
            "profitInputs": {
                "ozonFollowPrice": product.follow_price,
                "ozonMarketPrice": product.market_price,
                "ozonMinFollowPrice": product.min_follow_price,
                "purchasePriceCny": best.get("priceFrom") if best else None,
                "minOrderQuantity": best.get("minOrderQuantity") if best else None,
                "unitWeight1688Kg": best.get("unitWeight") if best else None,
                "weightG": product.weight_g,
                "monthlySales": product.monthly_sales,
                "formulaReady": False,
            },
            "errors": errors,
        }

    async def _download_image(self, client: httpx.AsyncClient, image_url: str) -> bytes:
        response = await client.get(
            image_url,
            headers={
                "user-agent": USER_AGENT,
                "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            },
        )
        response.raise_for_status()
        content = response.content
        if not content or len(content) < 100:
            raise ValueError("image response is empty")
        return content[:4_000_000]

    async def _search_by_image_url(
        self,
        client: httpx.AsyncClient,
        image_url: str,
        ozon_title: str,
    ) -> List[Dict[str, Any]]:
        image_bytes = await self._download_image(client, image_url)
        image_id = await self._upload_image(client, image_bytes)
        if not image_id:
            return []
        return await self._get_offer_list(
            client,
            params_data={
                "beginPage": 1,
                "pageSize": 30,
                "method": "imageOfferSearchService",
                "searchScene": "pcImageSearch",
                "appName": "pctusou",
                "tab": "imageSearch",
                "imageId": image_id,
                "imageIdList": image_id,
                "spm": "a26352.13672862.imagesearch.upload",
            },
            referer=(
                "https://pages-fast.1688.com/wow/cbu/srch_rec/image_search/youyuan/index.html?"
                f"tab=imageSearch&imageId={quote(image_id)}&imageIdList={quote(image_id)}"
            ),
            ozon_title=ozon_title,
            search_method="image",
        )

    async def _search_by_text(
        self,
        client: httpx.AsyncClient,
        keywords: str,
        ozon_title: str,
    ) -> List[Dict[str, Any]]:
        return await self._get_offer_list(
            client,
            params_data={
                "beginPage": 1,
                "pageSize": 30,
                "method": "getOfferList",
                "pageId": "qWJOoeNkRwblv903Iv6KQqPVkYDrgMudKHTRsee9Sjz7N9z1",
                "verticalProductFlag": "pcmarket",
                "searchScene": "pcOfferSearch",
                "charset": "GBK",
                "spm": "a26352.b28411319/2508.searchbox.0",
                "keywords": keywords,
            },
            referer=f"https://s.1688.com/selloffer/offer_search.htm?keywords={quote(keywords)}",
            ozon_title=ozon_title,
            search_method="text",
        )

    async def _upload_image(self, client: httpx.AsyncClient, image_bytes: bytes) -> Optional[str]:
        data_string = _image_request_data(image_bytes)
        result = await self._mtop_request(
            client,
            data_string=data_string,
            params_extra={
                "api": "mtop.relationrecommend.WirelessRecommend.recommend",
                "ignoreLogin": "true",
                "prefix": "h5api",
                "type": "originaljson",
                "dataType": "jsonp",
                "jsonpIncPrefix": "search1688",
                "timeout": "20000",
            },
            method="POST",
            data={"data": data_string},
            referer="https://s.1688.com/",
        )
        return _normalize_text(_deep_get(result, ["data.imageId"], "")) or None

    async def _get_offer_list(
        self,
        client: httpx.AsyncClient,
        params_data: Dict[str, Any],
        referer: str,
        ozon_title: str,
        search_method: str,
    ) -> List[Dict[str, Any]]:
        request_data = {
            "appId": 32517,
            "params": json.dumps(params_data, ensure_ascii=False),
        }
        data_string = json.dumps(request_data, ensure_ascii=False)
        result = await self._mtop_request(
            client,
            data_string=data_string,
            params_extra={
                "api": "mtop.relationrecommend.WirelessRecommend.recommend",
                "type": "jsonp",
                "dataType": "jsonp",
                "timeout": "20000",
                "jsonpIncPrefix": "reqTppId_32517_getOfferList",
                "callback": f"mtopjsonpreqTppId_32517_getOfferList{int(time.time())}",
                "data": data_string,
            },
            method="GET",
            referer=referer,
        )
        items = _deep_get(result, ["data.data.OFFER.items"], [])
        if not isinstance(items, list):
            return []
        normalized = [
            item
            for item in (
                _normalize_candidate(raw_item, ozon_title, search_method)
                for raw_item in items
                if isinstance(raw_item, dict)
            )
            if item
        ]
        return normalized

    async def _mtop_request(
        self,
        client: httpx.AsyncClient,
        data_string: str,
        params_extra: Dict[str, Any],
        method: str = "GET",
        data: Optional[Dict[str, Any]] = None,
        referer: str = "https://s.1688.com/",
    ) -> Dict[str, Any]:
        timestamp = str(int(time.time() * 1000))
        token_part = self.token_part or ""
        if not token_part:
            raise RuntimeError("1688 token missing")
        params = {
            "jsv": "2.7.4",
            "appKey": APP_KEY,
            "t": timestamp,
            "sign": _sign(token_part, timestamp, data_string),
            "v": "2.0",
            **params_extra,
        }
        headers = {
            "user-agent": USER_AGENT,
            "accept": "*/*",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
            "cookie": self._cookie_header(),
            "referer": referer,
            "sec-fetch-dest": "script",
            "sec-fetch-mode": "no-cors",
            "sec-fetch-site": "same-site",
        }
        if method.upper() == "POST":
            response = await client.post(BASE_URL, params=params, data=data, headers=headers)
        else:
            response = await client.get(BASE_URL, params=params, headers=headers)
        self._merge_cookies(response)
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if "json" in content_type:
            try:
                parsed = response.json()
            except json.JSONDecodeError:
                parsed = _jsonp_to_json(response.text)
        else:
            parsed = _jsonp_to_json(response.text)
        if not parsed:
            return {}
        ret = parsed.get("ret") or []
        if ret and not str(ret[0]).upper().startswith("SUCCESS"):
            raise RuntimeError(str(ret[0]))
        return parsed


def sourcing_product_from_payload(item: Dict[str, Any]) -> Optional[SourcingProduct]:
    product_id = int(_first_number([item.get("product_id"), item.get("productId")]) or 0)
    if not product_id:
        return None
    return SourcingProduct(
        product_id=product_id,
        title=_normalize_text(item.get("title") or item.get("subtitle") or f"SKU {product_id}"),
        image_url=_normalize_text(item.get("image_url") or item.get("imageUrl")) or None,
        product_url=_normalize_text(item.get("product_url") or item.get("productUrl")) or None,
        follow_price=_first_number([item.get("follow_price"), item.get("followPrice")]),
        market_price=_first_number([item.get("market_price"), item.get("marketPrice")]),
        min_follow_price=_first_number([item.get("min_follow_price"), item.get("minFollowPrice")]),
        weight_g=_first_number([item.get("weight_g"), item.get("weightG")]),
        monthly_sales=_first_number([item.get("monthly_sales"), item.get("monthlySales")]),
    )


async def compare_1688_sources(
    items: List[Dict[str, Any]],
    max_candidates: int = 5,
) -> Dict[str, Any]:
    products = [product for product in (sourcing_product_from_payload(item) for item in items) if product]
    if not products:
        return {"items": [], "meta": {"source": "1688_h5_mtop", "maxCandidates": max_candidates}}
    client = Sourcing1688Client()
    return await client.compare_products(products, max_candidates=max(1, min(max_candidates, 10)))
