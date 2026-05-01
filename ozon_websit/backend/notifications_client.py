from typing import Dict, Any, List
import logging

logger = logging.getLogger(__name__)

from ozon_http import request_ozon_api


async def get_unfulfilled_orders(client_id: str, api_key: str) -> List[dict]:
    payload = {
        "dir": "ASC",
        "filter": {
            "status": ["awaiting_packaging", "awaiting_deliver"],
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

    try:
        response = await request_ozon_api(
            method="POST",
            endpoint="/v3/posting/fbs/unfulfilled/list",
            client_id=client_id,
            api_key=api_key,
            payload=payload,
            timeout=10.0,
        )
        if not response.get("ok"):
            logger.error("Error fetching unfulfilled orders: %s", response.get("error"))
            return []
        data = response.get("data") or {}
        return data.get("result", {}).get("postings", [])
    except Exception as e:
        logger.error(f"Error fetching unfulfilled orders: {e}")
        return []


async def get_discount_tasks_alerts(client_id: str, api_key: str) -> List[dict]:
    payload = {
        "status": "UNKNOWN",
    }

    try:
        response = await request_ozon_api(
            method="POST",
            endpoint="/v1/actions/discount-task",
            client_id=client_id,
            api_key=api_key,
            payload=payload,
            timeout=10.0,
        )
        if not response.get("ok"):
            logger.error("Error fetching discount tasks: %s", response.get("error"))
            return []
        data = response.get("data") or {}
        return data.get("result", [])
    except Exception as e:
        logger.error(f"Error fetching discount tasks: {e}")
        return []

