import asyncio
import ipaddress
import json
import socket
import time
from typing import Any, Dict, List, Optional

import urllib3

OZON_API_HOST = "api-seller.ozon.ru"
OZON_BASE_URL = f"https://{OZON_API_HOST}"

_DOH_ENDPOINTS = (
    "https://dns.google/resolve?name={host}&type=A",
    "https://cloudflare-dns.com/dns-query?name={host}&type=A",
)
_POISONED_NETWORKS = (
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
)
_DNS_CACHE: Dict[str, tuple[float, List[str]]] = {}


def build_ozon_headers(
    client_id: str, api_key: str, accept: str = "application/json"
) -> Dict[str, str]:
    return {
        "Client-Id": client_id,
        "Api-Key": api_key,
        "Content-Type": "application/json",
        "Accept": accept,
    }


def _is_poisoned_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return True

    return any(address in network for network in _POISONED_NETWORKS)


def _system_resolve(host: str) -> List[str]:
    ips: List[str] = []
    try:
        records = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError:
        return ips

    for record in records:
        ip = str(record[4][0] or "").strip()
        if ip and ip not in ips:
            ips.append(ip)
    return ips


def _cache_dns_result(host: str, ips: List[str], ttl_seconds: int) -> None:
    if not ips:
        return
    ttl_seconds = max(60, min(ttl_seconds, 3600))
    _DNS_CACHE[host] = (time.time() + ttl_seconds, ips)


def _read_cached_ips(host: str) -> List[str]:
    cached = _DNS_CACHE.get(host)
    if not cached:
        return []
    expires_at, ips = cached
    if expires_at <= time.time():
        _DNS_CACHE.pop(host, None)
        return []
    return list(ips)


def _resolve_via_public_dns(host: str, timeout: float) -> List[str]:
    http = urllib3.PoolManager(
        timeout=urllib3.Timeout(connect=timeout, read=timeout),
        retries=False,
    )

    for endpoint in _DOH_ENDPOINTS:
        try:
            response = http.request(
                "GET",
                endpoint.format(host=host),
                headers={"accept": "application/dns-json"},
            )
        except Exception:
            continue

        try:
            payload = json.loads(response.data.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            continue

        answers = payload.get("Answer") or []
        ips: List[str] = []
        ttl_candidates: List[int] = []
        for answer in answers:
            if not isinstance(answer, dict) or answer.get("type") != 1:
                continue
            ip = str(answer.get("data") or "").strip()
            if not ip or _is_poisoned_ip(ip) or ip in ips:
                continue
            ips.append(ip)
            try:
                ttl_candidates.append(int(answer.get("TTL") or 0))
            except (TypeError, ValueError):
                pass

        if ips:
            _cache_dns_result(host, ips, min(ttl_candidates) if ttl_candidates else 300)
            return ips

    return []


def resolve_api_host_ips(host: str = OZON_API_HOST, timeout: float = 5.0) -> List[str]:
    cached_ips = _read_cached_ips(host)
    if cached_ips:
        return cached_ips

    system_ips = _system_resolve(host)
    usable_system_ips = [ip for ip in system_ips if not _is_poisoned_ip(ip)]
    if usable_system_ips:
        _cache_dns_result(host, usable_system_ips, 300)
        return usable_system_ips

    public_dns_ips = _resolve_via_public_dns(host, min(timeout, 10.0))
    if public_dns_ips:
        return public_dns_ips

    return usable_system_ips or system_ips


def _decode_response_body(response: urllib3.BaseHTTPResponse) -> str:
    return response.data.decode("utf-8", errors="replace")


def _format_result(
    endpoint: str,
    response: urllib3.BaseHTTPResponse,
    response_format: str = "json",
) -> Dict[str, Any]:
    if response.status < 400 and response_format == "binary":
        return {
            "ok": True,
            "status_code": response.status,
            "endpoint": endpoint,
            "data": {
                "content": response.data,
                "content_type": response.headers.get("Content-Type"),
            },
        }

    body_text = _decode_response_body(response)
    try:
        body_data: Any = json.loads(body_text) if body_text else {}
    except json.JSONDecodeError:
        body_data = {"raw": body_text}

    if response.status >= 400:
        return {
            "ok": False,
            "status_code": response.status,
            "endpoint": endpoint,
            "error": body_text,
            "data": body_data,
        }

    return {
        "ok": True,
        "status_code": response.status,
        "endpoint": endpoint,
        "data": body_data,
    }


def _request_via_ip(
    *,
    method: str,
    endpoint: str,
    host: str,
    ip: str,
    headers: Dict[str, str],
    payload: Optional[Dict[str, Any]],
    timeout: float,
    response_format: str,
) -> Dict[str, Any]:
    pool = urllib3.HTTPSConnectionPool(
        ip,
        port=443,
        assert_hostname=host,
        server_hostname=host,
        timeout=urllib3.Timeout(connect=timeout, read=timeout),
        retries=False,
    )
    request_headers = dict(headers)
    request_headers["Host"] = host
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    response = pool.urlopen(method, endpoint, body=body, headers=request_headers)
    return _format_result(endpoint, response, response_format=response_format)


def request_ozon_api_sync(
    *,
    method: str,
    endpoint: str,
    client_id: str,
    api_key: str,
    payload: Optional[Dict[str, Any]] = None,
    timeout: float = 20.0,
    accept: str = "application/json",
    response_format: str = "json",
) -> Dict[str, Any]:
    host = OZON_API_HOST
    headers = build_ozon_headers(client_id, api_key, accept=accept)
    resolved_ips = resolve_api_host_ips(host, timeout=timeout)
    errors: List[str] = []

    for ip in resolved_ips:
        if _is_poisoned_ip(ip):
            continue
        try:
            return _request_via_ip(
                method=method,
                endpoint=endpoint,
                host=host,
                ip=ip,
                headers=headers,
                payload=payload,
                timeout=timeout,
                response_format=response_format,
            )
        except Exception as exc:
            errors.append(f"{ip}: {type(exc).__name__}: {exc}")

    error_detail = "; ".join(errors) if errors else "no reachable IPs resolved"
    return {
        "ok": False,
        "status_code": 0,
        "endpoint": endpoint,
        "error": f"request_failed: {error_detail}",
    }


async def request_ozon_api(
    *,
    method: str,
    endpoint: str,
    client_id: str,
    api_key: str,
    payload: Optional[Dict[str, Any]] = None,
    timeout: float = 20.0,
    accept: str = "application/json",
    response_format: str = "json",
) -> Dict[str, Any]:
    return await asyncio.to_thread(
        request_ozon_api_sync,
        method=method,
        endpoint=endpoint,
        client_id=client_id,
        api_key=api_key,
        payload=payload,
        timeout=timeout,
        accept=accept,
        response_format=response_format,
    )
