#!/usr/bin/env python3
import asyncio
import json
import sys
import time
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[3]
BACKEND_DIR = ROOT_DIR / "ozon_websit" / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from sourcing_1688 import fetch_1688_offer_detail  # noqa: E402


async def run(offer_or_url: str) -> dict:
    detail = await fetch_1688_offer_detail(offer_or_url)
    scraped_data = detail.get("scrapedData") or {}
    offer_id = detail.get("offerId") or scraped_data.get("offerId1688") or ""
    source_url = detail.get("sourceUrl") or scraped_data.get("sourceUrl") or offer_or_url
    return {
        "platform": "1688",
        "sourceUrl": source_url,
        "productId": scraped_data.get("productId") or f"1688-{offer_id}",
        "fileName": f"1688-{offer_id or int(time.time())}.json",
        "scrapedData": scraped_data,
        "meta": detail.get("meta") or {},
    }


def main() -> int:
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        print("缺少 1688 商品链接", file=sys.stderr)
        return 2

    try:
        payload = asyncio.run(run(sys.argv[1].strip()))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
