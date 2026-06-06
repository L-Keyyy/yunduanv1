from typing import Any, Dict, Optional

from ozon_http import request_ozon_api


async def _request(
    method: str,
    endpoint: str,
    client_id: str,
    api_key: str,
    payload: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return await request_ozon_api(
        method=method,
        endpoint=endpoint,
        client_id=client_id,
        api_key=api_key,
        payload=payload,
        timeout=20.0,
    )


async def get_actions(client_id: str, api_key: str) -> Dict[str, Any]:
    # Current API uses GET for the action list, but keep POST fallback for older setups.
    result = await _request("GET", "/v1/actions", client_id, api_key, None)
    if not result.get("ok") and result.get("status_code") in (404, 405):
        result = await _request("POST", "/v1/actions", client_id, api_key, {})
    return result


async def get_candidates(
    client_id: str, api_key: str, payload: Dict[str, Any]
) -> Dict[str, Any]:
    return await _request("POST", "/v1/actions/candidates", client_id, api_key, payload)


async def get_participating_products(
    client_id: str, api_key: str, payload: Dict[str, Any]
) -> Dict[str, Any]:
    return await _request("POST", "/v1/actions/products", client_id, api_key, payload)


async def activate_products(
    client_id: str, api_key: str, payload: Dict[str, Any]
) -> Dict[str, Any]:
    return await _request(
        "POST", "/v1/actions/products/activate", client_id, api_key, payload
    )


async def deactivate_products(
    client_id: str, api_key: str, payload: Dict[str, Any]
) -> Dict[str, Any]:
    return await _request(
        "POST", "/v1/actions/products/deactivate", client_id, api_key, payload
    )


async def get_discount_tasks(
    client_id: str, api_key: str, payload: Dict[str, Any]
) -> Dict[str, Any]:
    return await _request(
        "POST", "/v1/actions/discounts-task/list", client_id, api_key, payload
    )


async def approve_discount_tasks(
    client_id: str, api_key: str, payload: Dict[str, Any]
) -> Dict[str, Any]:
    return await _request(
        "POST", "/v1/actions/discounts-task/approve", client_id, api_key, payload
    )


async def reject_discount_tasks(
    client_id: str, api_key: str, payload: Dict[str, Any]
) -> Dict[str, Any]:
    return await _request(
        "POST", "/v1/actions/discounts-task/reject", client_id, api_key, payload
    )
