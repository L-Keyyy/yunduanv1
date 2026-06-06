from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from ozon_http import request_ozon_api


async def _request(
    method: str,
    endpoint: str,
    client_id: str,
    api_key: str,
    payload: Optional[Dict[str, Any]] = None,
    timeout: float = 30.0,
) -> Dict[str, Any]:
    return await request_ozon_api(
        method=method,
        endpoint=endpoint,
        client_id=client_id,
        api_key=api_key,
        payload=payload if payload is not None else {},
        timeout=timeout,
    )


def _format_limit(limit_obj: Optional[Dict[str, Any]]) -> str:
    if not limit_obj:
        return "-"

    usage = limit_obj.get("usage", 0)
    limit = limit_obj.get("limit", 0)
    return f"{usage} / {limit}"


async def verify_ozon_credentials(
    client_id: str, api_key: str
) -> Tuple[bool, str, str, str, str]:
    result = await _request(
        "POST",
        "/v4/product/info/limit",
        client_id,
        api_key,
        payload={},
        timeout=10.0,
    )
    if not result.get("ok"):
        message = result.get("error", "unknown_error")
        status_code = result.get("status_code", 0)
        return False, f"Credential verification failed: {status_code} - {message}", "-", "-", "-"

    payload = result.get("data", {})
    limits = payload.get("result", payload)
    daily_create = _format_limit(limits.get("daily_create"))
    daily_update = _format_limit(limits.get("daily_update"))
    total_limit = _format_limit(limits.get("total"))
    return True, "API credentials verified", daily_create, daily_update, total_limit


async def upload_products(
    client_id: str, api_key: str, items: list
) -> Dict[str, Any]:
    return await _request(
        "POST",
        "/v3/product/import",
        client_id,
        api_key,
        payload={"items": items},
        timeout=60.0,
    )


async def get_upload_task_info(
    client_id: str, api_key: str, task_id: int
) -> Dict[str, Any]:
    return await _request(
        "POST",
        "/v1/product/import/info",
        client_id,
        api_key,
        payload={"task_id": int(task_id)},
        timeout=30.0,
    )


async def get_category_tree(
    client_id: str,
    api_key: str,
    language: str = "DEFAULT",
) -> Dict[str, Any]:
    return await _request(
        "POST",
        "/v1/description-category/tree",
        client_id,
        api_key,
        payload={"language": language},
        timeout=30.0,
    )


async def get_category_attributes(
    client_id: str,
    api_key: str,
    description_category_id: int,
    type_id: int,
    language: str = "DEFAULT",
) -> Dict[str, Any]:
    return await _request(
        "POST",
        "/v1/description-category/attribute",
        client_id,
        api_key,
        payload={
            "description_category_id": int(description_category_id),
            "type_id": int(type_id),
            "language": language,
        },
        timeout=30.0,
    )


async def get_attribute_values(
    client_id: str,
    api_key: str,
    attribute_id: int,
    description_category_id: int,
    type_id: int,
    language: str = "DEFAULT",
) -> Dict[str, Any]:
    values: List[Dict[str, Any]] = []
    last_value_id = 0

    while True:
        response = await _request(
            "POST",
            "/v1/description-category/attribute/values",
            client_id,
            api_key,
            payload={
                "attribute_id": int(attribute_id),
                "description_category_id": int(description_category_id),
                "type_id": int(type_id),
                "language": language,
                "limit": 5000,
                "last_value_id": int(last_value_id),
            },
            timeout=30.0,
        )
        if not response.get("ok"):
            return response

        batch = response.get("data", {}).get("result")
        if not isinstance(batch, list):
            batch = []

        values.extend(item for item in batch if isinstance(item, dict))
        has_next = bool(response.get("data", {}).get("has_next"))
        if not has_next or not batch:
            break

        last_value_id = int(batch[-1].get("id") or 0)
        if last_value_id <= 0:
            break

    return {
        "ok": True,
        "status_code": 200,
        "endpoint": "/v1/description-category/attribute/values",
        "data": {
            "result": values,
            "total": len(values),
        },
    }


async def get_product_total_count(client_id: str, api_key: str) -> Dict[str, Any]:
    return await _request(
        "POST",
        "/v3/product/list",
        client_id,
        api_key,
        payload={"filter": {}, "last_id": "", "limit": 1},
        timeout=20.0,
    )


async def list_products_page(
    client_id: str,
    api_key: str,
    last_id: str = "",
    limit: int = 100,
    filter_payload: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return await _request(
        "POST",
        "/v3/product/list",
        client_id,
        api_key,
        payload={
            "filter": filter_payload or {},
            "last_id": last_id,
            "limit": limit,
        },
        timeout=30.0,
    )


async def get_products_info_list(
    client_id: str,
    api_key: str,
    *,
    product_ids: Optional[List[int]] = None,
    offer_ids: Optional[List[str]] = None,
    skus: Optional[List[int]] = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {}
    if product_ids:
        payload["product_id"] = product_ids
    if offer_ids:
        payload["offer_id"] = offer_ids
    if skus:
        payload["sku"] = skus
    return await _request(
        "POST",
        "/v3/product/info/list",
        client_id,
        api_key,
        payload=payload,
        timeout=30.0,
    )


async def update_product_prices(
    client_id: str, api_key: str, prices: List[Dict[str, Any]]
) -> Dict[str, Any]:
    return await _request(
        "POST",
        "/v1/product/import/prices",
        client_id,
        api_key,
        payload={"prices": prices},
        timeout=60.0,
    )


async def update_product_stocks(
    client_id: str, api_key: str, stocks: List[Dict[str, Any]]
) -> Dict[str, Any]:
    return await _request(
        "POST",
        "/v2/products/stocks",
        client_id,
        api_key,
        payload={"stocks": stocks},
        timeout=60.0,
    )


async def archive_products(
    client_id: str, api_key: str, product_ids: List[int]
) -> Dict[str, Any]:
    return await _request(
        "POST",
        "/v1/product/archive",
        client_id,
        api_key,
        payload={"product_id": product_ids},
        timeout=60.0,
    )


async def unarchive_products(
    client_id: str, api_key: str, product_ids: List[int]
) -> Dict[str, Any]:
    return await _request(
        "POST",
        "/v1/product/unarchive",
        client_id,
        api_key,
        payload={"product_id": product_ids},
        timeout=60.0,
    )


async def list_warehouses(client_id: str, api_key: str) -> Dict[str, Any]:
    return await _request(
        "POST",
        "/v1/warehouse/list",
        client_id,
        api_key,
        payload={},
        timeout=30.0,
    )


def _iso_utc(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


async def fetch_fbs_postings(
    client_id: str,
    api_key: str,
    since: datetime,
    to: datetime,
    limit: int = 100,
    status: Optional[str] = None,
) -> Dict[str, Any]:
    postings: List[Dict[str, Any]] = []
    offset = 0

    while True:
        filter_payload: Dict[str, Any] = {
            "since": _iso_utc(since),
            "to": _iso_utc(to),
        }
        if status:
            filter_payload["status"] = status

        payload = {
            "dir": "DESC",
            "filter": filter_payload,
            "limit": limit,
            "offset": offset,
            "with": {
                "analytics_data": True,
                "barcodes": False,
                "financial_data": True,
                "translit": False,
            },
        }
        response = await _request(
            "POST",
            "/v3/posting/fbs/list",
            client_id,
            api_key,
            payload=payload,
            timeout=30.0,
        )
        if not response.get("ok"):
            return response

        result = response.get("data", {}).get("result", {})
        batch = result.get("postings", [])
        postings.extend(batch)
        if not result.get("has_next") or not batch:
            break
        offset += limit

    return {
        "ok": True,
        "status_code": 200,
        "endpoint": "/v3/posting/fbs/list",
        "data": {"result": {"postings": postings}},
    }
