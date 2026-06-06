from __future__ import annotations

import argparse
import json
from typing import Any, Dict

from tasks import (
    run_due_schedules,
    run_sync_browser_warehouses,
    run_sync_core,
    run_sync_orders,
    run_sync_products,
    run_sync_schedule,
    run_verify_stores,
)


def _print_result(payload: Dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description="Run backend maintenance jobs")
    subparsers = parser.add_subparsers(dest="command", required=True)

    verify_parser = subparsers.add_parser("verify-stores")
    verify_parser.add_argument("--store-id", type=int, default=None)
    verify_parser.add_argument("--tenant-id", type=int, default=None)

    product_parser = subparsers.add_parser("sync-products")
    product_parser.add_argument("--store-id", type=int, default=None)
    product_parser.add_argument("--tenant-id", type=int, default=None)

    orders_parser = subparsers.add_parser("sync-orders")
    orders_parser.add_argument("--store-id", type=int, default=None)
    orders_parser.add_argument("--tenant-id", type=int, default=None)
    orders_parser.add_argument("--days", type=int, default=30)

    browser_warehouse_parser = subparsers.add_parser("sync-browser-warehouses")
    browser_warehouse_parser.add_argument("--store-id", type=int, required=True)
    browser_warehouse_parser.add_argument("--tenant-id", type=int, default=None)

    core_parser = subparsers.add_parser("sync-core")
    core_parser.add_argument("--tenant-id", type=int, default=None)
    core_parser.add_argument("--days", type=int, default=30)

    schedule_parser = subparsers.add_parser("run-sync-schedule")
    schedule_parser.add_argument("--schedule-id", type=int, required=True)
    schedule_parser.add_argument("--triggered-by", default="cli")

    due_parser = subparsers.add_parser("run-due-schedules")
    due_parser.add_argument("--limit", type=int, default=20)

    args = parser.parse_args()

    if args.command == "verify-stores":
        _print_result(run_verify_stores(store_id=args.store_id, tenant_id=args.tenant_id))
    elif args.command == "sync-products":
        _print_result(run_sync_products(store_id=args.store_id, tenant_id=args.tenant_id))
    elif args.command == "sync-orders":
        _print_result(
            run_sync_orders(
                store_id=args.store_id,
                days=args.days,
                tenant_id=args.tenant_id,
            )
        )
    elif args.command == "sync-browser-warehouses":
        _print_result(
            run_sync_browser_warehouses(
                store_id=args.store_id,
                tenant_id=args.tenant_id,
            )
        )
    elif args.command == "sync-core":
        _print_result(run_sync_core(days=args.days, tenant_id=args.tenant_id))
    elif args.command == "run-sync-schedule":
        _print_result(
            run_sync_schedule(
                schedule_id=args.schedule_id,
                triggered_by=args.triggered_by,
            )
        )
    elif args.command == "run-due-schedules":
        _print_result(run_due_schedules(limit=args.limit))
    else:
        parser.error(f"Unsupported command: {args.command}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
