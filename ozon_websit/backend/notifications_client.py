from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List
import logging

logger = logging.getLogger(__name__)

from ozon_http import request_ozon_api


UNFULFILLED_ORDER_STATUSES = ("awaiting_packaging", "awaiting_deliver")


def _iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


async def get_unfulfilled_orders(client_id: str, api_key: str) -> List[dict]:
    postings_by_number: Dict[str, dict] = {}
    try:
        now = datetime.now(timezone.utc)
        cutoff_from = _iso_utc(now - timedelta(days=1))
        cutoff_to = _iso_utc(now + timedelta(days=30))
        for status in UNFULFILLED_ORDER_STATUSES:
            payload = {
                "dir": "ASC",
                "filter": {
                    "cutoff_from": cutoff_from,
                    "cutoff_to": cutoff_to,
                    "delivery_method_id": [],
                    "provider_id": [],
                    "status": status,
                    "warehouse_id": [],
                },
                "limit": 100,
                "offset": 0,
                "with": {
                    "analytics_data": False,
                    "barcodes": False,
                    "financial_data": False,
                    "translit": False,
                },
            }
            response = await request_ozon_api(
                method="POST",
                endpoint="/v3/posting/fbs/unfulfilled/list",
                client_id=client_id,
                api_key=api_key,
                payload=payload,
                timeout=10.0,
            )
            if not response.get("ok"):
                logger.error(
                    "Error fetching unfulfilled orders for status %s: %s",
                    status,
                    response.get("error"),
                )
                continue
            data = response.get("data") or {}
            postings = data.get("result", {}).get("postings", [])
            for posting in postings:
                if not isinstance(posting, dict):
                    continue
                posting_number = str(posting.get("posting_number") or "").strip()
                if posting_number:
                    postings_by_number[posting_number] = posting
        return list(postings_by_number.values())
    except Exception as e:
        logger.error(f"Error fetching unfulfilled orders: {e}")
        return []


async def get_discount_tasks_alerts(client_id: str, api_key: str) -> List[dict]:
    payload = {
        "status": "UNKNOWN",
        "page": 1,
        "limit": 50,
    }

    try:
        response = await request_ozon_api(
            method="POST",
            endpoint="/v1/actions/discounts-task/list",
            client_id=client_id,
            api_key=api_key,
            payload=payload,
            timeout=10.0,
        )
        if not response.get("ok"):
            if response.get("status_code") == 404:
                logger.debug("Discount tasks API is unavailable for this store")
            else:
                logger.error("Error fetching discount tasks: %s", response.get("error"))
            return []
        data = response.get("data") or {}
        result = data.get("result", [])
        if isinstance(result, list):
            return result
        if isinstance(result, dict):
            for key in ("tasks", "items", "discount_tasks", "products"):
                value = result.get(key)
                if isinstance(value, list):
                    return value
        return []
    except Exception as e:
        logger.error(f"Error fetching discount tasks: {e}")
        return []

