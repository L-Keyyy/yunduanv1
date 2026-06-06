import json
import re
from typing import Any, Dict, Iterable, List, Optional, Sequence
from urllib.parse import urljoin


OZON_ORIGIN = "https://www.ozon.ru"


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def extract_product_id(value: Any) -> Optional[int]:
    text = str(value or "")
    match = re.search(r"(\d{6,})", text)
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def absolute_url(value: Any, base_url: str = OZON_ORIGIN) -> str:
    text = normalize_text(value)
    if not text:
        return ""
    return urljoin(base_url or OZON_ORIGIN, text)


def extract_text_rs(value: Any) -> str:
    if isinstance(value, list):
        return normalize_text(" ".join(extract_text_rs(item) for item in value))
    if isinstance(value, dict):
        parts = []
        for key in ("content", "text", "title", "value"):
            if key in value:
                parts.append(normalize_text(value.get(key)))
        if not parts:
            for child in value.values():
                if isinstance(child, (list, dict)):
                    parts.append(extract_text_rs(child))
        return normalize_text(" ".join(item for item in parts if item))
    return normalize_text(value)


def parse_widget_states(payloads: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    states: Dict[str, Any] = {}
    for payload in payloads:
        widget_states = payload.get("widgetStates")
        if not isinstance(widget_states, dict):
            continue
        for key, raw_value in widget_states.items():
            if isinstance(raw_value, str):
                try:
                    states[key] = json.loads(raw_value)
                except json.JSONDecodeError:
                    continue
            elif isinstance(raw_value, dict):
                states[key] = raw_value
    return states


def find_state(states: Dict[str, Any], prefix: str) -> Optional[Dict[str, Any]]:
    for key, value in states.items():
        if key.startswith(prefix) and isinstance(value, dict):
            return value
    return None


def find_states(states: Dict[str, Any], prefix: str) -> List[Dict[str, Any]]:
    return [
        value
        for key, value in states.items()
        if key.startswith(prefix) and isinstance(value, dict)
    ]


def parse_price_number(value: Any) -> Optional[float]:
    text = normalize_text(value).replace("\u2009", "").replace("\xa0", "")
    match = re.search(r"\d+(?:[.,]\d+)?", text)
    if not match:
        return None
    try:
        return float(match.group(0).replace(",", "."))
    except ValueError:
        return None


def format_price(value: Optional[float]) -> Optional[str]:
    if value is None:
        return None
    return f"{value:.2f}"


def values_from_ozon_values(values: Any) -> List[str]:
    result = []
    if not isinstance(values, list):
        return result
    for item in values:
        if isinstance(item, dict):
            text = normalize_text(item.get("text") or item.get("content") or item.get("value"))
        else:
            text = normalize_text(item)
        if text:
            result.append(text)
    return list(dict.fromkeys(result))


def characteristic_from_ozon_item(item: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(item, dict):
        return None
    name = normalize_text(item.get("name"))
    if not name and isinstance(item.get("title"), dict):
        name = extract_text_rs(item["title"].get("textRs") or item["title"])
    values = values_from_ozon_values(item.get("values"))
    value_text = normalize_text(item.get("content") or item.get("valueText"))
    if not value_text and values:
        value_text = ", ".join(values)
    if not name or not value_text:
        return None
    return {
        "name": name,
        "valueText": value_text,
        "values": values or [value_text],
    }


def collect_characteristics(states: Dict[str, Any]) -> List[Dict[str, Any]]:
    merged: Dict[str, Dict[str, Any]] = {}

    def add(raw_item: Any) -> None:
        item = characteristic_from_ozon_item(raw_item)
        if not item:
            return
        key = item["name"].casefold()
        existing = merged.get(key)
        if not existing:
            merged[key] = item
            return
        values = list(dict.fromkeys([*(existing.get("values") or []), *(item.get("values") or [])]))
        existing["values"] = values
        existing["valueText"] = existing.get("valueText") or item.get("valueText") or ", ".join(values)

    characteristics_state = find_state(states, "webCharacteristics-") or {}
    for group in characteristics_state.get("characteristics") or []:
        if isinstance(group, dict):
            for item in group.get("short") or group.get("items") or []:
                add(item)
            add(group)

    for description_state in find_states(states, "webDescription-"):
        for item in description_state.get("characteristics") or []:
            add({"name": item.get("title"), "values": [{"text": item.get("content")}]})

    return list(merged.values())


def collect_short_characteristics(states: Dict[str, Any]) -> List[Dict[str, Any]]:
    short_state = find_state(states, "webShortCharacteristics-") or {}
    result = []
    for item in short_state.get("characteristics") or []:
        parsed = characteristic_from_ozon_item(item)
        if parsed:
            result.append({"name": parsed["name"], "values": parsed["values"]})
    return result


def collect_rich_text_and_images(value: Any) -> Dict[str, List[str]]:
    texts: List[str] = []
    images: List[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for child in node:
                walk(child)
            return
        if not isinstance(node, dict):
            return
        image = node.get("img")
        if isinstance(image, dict):
            src = normalize_text(image.get("src") or image.get("srcMobile"))
            if src:
                images.append(src)
        for key in ("content", "text"):
            raw = node.get(key)
            if isinstance(raw, str):
                text = normalize_text(raw)
                if text:
                    texts.append(text)
            elif isinstance(raw, (list, dict)):
                walk(raw)
        for child in node.values():
            if isinstance(child, (list, dict)) and child is not node.get("img"):
                walk(child)

    walk(value)
    return {
        "texts": list(dict.fromkeys(texts)),
        "images": list(dict.fromkeys(images)),
    }


def extract_description(states: Dict[str, Any], payloads: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    text_parts: List[str] = []
    images: List[Dict[str, str]] = []
    html_parts: List[str] = []

    for description_state in find_states(states, "webDescription-"):
        rich = description_state.get("richAnnotationJson")
        if rich:
            extracted = collect_rich_text_and_images(rich)
            text_parts.extend(extracted["texts"])
            images.extend({"src": url} for url in extracted["images"])
        direct_text = normalize_text(description_state.get("text"))
        if direct_text:
            text_parts.append(direct_text)

    for payload in payloads:
        seo = payload.get("seo")
        if not isinstance(seo, dict):
            continue
        for script in seo.get("script") or []:
            if not isinstance(script, dict):
                continue
            if script.get("type") != "application/ld+json":
                continue
            try:
                data = json.loads(script.get("innerHTML") or "{}")
            except json.JSONDecodeError:
                continue
            description = normalize_text(data.get("description"))
            if description:
                text_parts.append(description)

    text = normalize_text(" ".join(text_parts))
    return {
        "text": text,
        "html": "\n".join(html_parts),
        "images": images,
        "videos": [],
    }


def extract_gallery(states: Dict[str, Any]) -> Dict[str, Any]:
    gallery_state = find_state(states, "webGallery-") or {}
    images = []
    for item in gallery_state.get("images") or []:
        if not isinstance(item, dict):
            continue
        src = normalize_text(item.get("src"))
        if src:
            images.append({"src": src, "alt": normalize_text(item.get("alt"))})
    videos = []
    for item in gallery_state.get("videos") or []:
        if not isinstance(item, dict):
            continue
        url = normalize_text(item.get("url"))
        if url:
            videos.append(
                {
                    "url": url,
                    "coverUrl": normalize_text(item.get("coverUrl")),
                    "name": normalize_text(item.get("name")),
                }
            )
    return {
        "sku": normalize_text(gallery_state.get("sku")),
        "coverImage": normalize_text(gallery_state.get("coverImage")) or (images[0]["src"] if images else ""),
        "images": images,
        "videos": videos,
    }


def extract_pricing(states: Dict[str, Any]) -> Dict[str, Any]:
    price_state = find_state(states, "webPrice-") or {}
    regular_text = normalize_text(price_state.get("price"))
    card_text = normalize_text(price_state.get("cardPrice"))
    original_text = normalize_text(price_state.get("originalPrice"))
    regular_value = parse_price_number(regular_text)
    card_value = parse_price_number(card_text)
    original_value = parse_price_number(original_text)
    upload_value = regular_value or parse_price_number(price_state.get("finalPrice")) or card_value
    return {
        "source": "entrypoint-api",
        "priceText": regular_text or card_text or None,
        "regularPriceText": regular_text or None,
        "cardPriceText": card_text or None,
        "originalPriceText": original_text or None,
        "priceValue": regular_value,
        "cardPriceValue": card_value,
        "originalPriceValue": original_value,
        "uploadPrice": format_price(upload_value),
        "oldPrice": format_price(original_value),
        "currency": "CNY" if "¥" in f"{regular_text}{card_text}{original_text}" else None,
        "disclaimerTitle": normalize_text(price_state.get("disclaimerPriceHeader")),
        "disclaimerBody": extract_text_rs(price_state.get("disclaimerPriceBodyRs")),
    }


def extract_variants(states: Dict[str, Any], product_id: int, source_url: str) -> List[Dict[str, Any]]:
    aspects_state = find_state(states, "webAspects-") or {}
    title_state = find_state(states, "webProductHeading-") or {}
    current_title = normalize_text(title_state.get("title"))
    variants_by_id: Dict[int, Dict[str, Any]] = {}

    def upsert(candidate: Dict[str, Any], axis_name: str = "", axis_value: str = "") -> None:
        candidate_id = extract_product_id(candidate.get("productId"))
        if not candidate_id:
            return
        current = variants_by_id.setdefault(
            candidate_id,
            {
                "productId": candidate_id,
                "productUrl": "",
                "title": "",
                "variantSummary": "",
                "variantAxes": [],
                "imageUrl": "",
                "currentPriceText": "",
                "originalPriceText": "",
                "availability": "",
                "isCurrent": candidate_id == int(product_id),
            },
        )
        for key in ("productUrl", "title", "variantSummary", "imageUrl", "currentPriceText", "originalPriceText", "availability"):
            if candidate.get(key):
                current[key] = candidate[key]
        current["isCurrent"] = bool(current.get("isCurrent") or candidate.get("isCurrent"))
        if axis_name and axis_value:
            current["variantAxes"] = [
                axis for axis in current.get("variantAxes") or [] if axis.get("name") != axis_name
            ]
            current["variantAxes"].append({"name": axis_name, "value": axis_value})

    upsert(
        {
            "productId": product_id,
            "productUrl": source_url,
            "title": current_title,
            "isCurrent": True,
        }
    )

    for aspect in aspects_state.get("aspects") or []:
        if not isinstance(aspect, dict):
            continue
        axis_name = normalize_text(aspect.get("aspectName"))
        for variant in aspect.get("variants") or []:
            if not isinstance(variant, dict):
                continue
            variant_data = variant.get("data") or {}
            axis_value = extract_text_rs(variant_data.get("textRs")) or normalize_text(variant_data.get("searchableText"))
            variant_id = extract_product_id(variant.get("sku") or variant.get("link"))
            product_url = absolute_url(variant.get("link"), source_url)
            upsert(
                {
                    "productId": variant_id,
                    "productUrl": product_url,
                    "title": normalize_text(variant_data.get("title")) or current_title,
                    "variantSummary": f"{axis_name}: {axis_value}" if axis_name and axis_value else axis_value or axis_name,
                    "imageUrl": normalize_text(variant_data.get("coverImage")),
                    "currentPriceText": normalize_text(variant_data.get("price")),
                    "originalPriceText": normalize_text(variant_data.get("originalPrice")),
                    "availability": normalize_text(variant.get("availability")),
                    "isCurrent": bool(variant.get("active")) or variant_id == int(product_id),
                },
                axis_name,
                axis_value,
            )

    return sorted(variants_by_id.values(), key=lambda item: (not item.get("isCurrent"), item.get("productId") or 0))


def extract_breadcrumbs(payloads: Sequence[Dict[str, Any]]) -> List[Dict[str, str]]:
    for payload in payloads:
        shared = payload.get("shared")
        if not isinstance(shared, dict):
            continue
        # Ozon changes breadcrumb widget shape often. Keep this as a best-effort hook.
    return []


def build_product_data(
    *,
    product_id: int,
    payloads: Sequence[Dict[str, Any]],
    source_url: Optional[str] = None,
) -> Dict[str, Any]:
    states = parse_widget_states(payloads)
    title_state = find_state(states, "webProductHeading-") or {}
    gallery = extract_gallery(states)
    pricing = extract_pricing(states)
    characteristics = collect_characteristics(states)
    short_characteristics = collect_short_characteristics(states)
    canonical_url = ""
    for payload in payloads:
        seo = payload.get("seo")
        if not isinstance(seo, dict):
            continue
        for item in seo.get("link") or []:
            if isinstance(item, dict) and item.get("rel") == "canonical":
                canonical_url = normalize_text(item.get("href"))
                break
        if canonical_url:
            break
    resolved_url = source_url or canonical_url or f"{OZON_ORIGIN}/product/{product_id}/"
    description = extract_description(states, payloads)
    variants = extract_variants(states, product_id, resolved_url)

    return {
        "extractionType": "ozon-entrypoint-api",
        "source": "entrypoint-api",
        "sourceUrl": resolved_url,
        "productId": product_id,
        "title": normalize_text(title_state.get("title")) or f"Ozon product {product_id}",
        "breadcrumbs": extract_breadcrumbs(payloads),
        "brand": {},
        "seller": {},
        "marketingLabels": [],
        "hashtags": [],
        "description": description,
        "pricing": pricing,
        "price": pricing.get("uploadPrice"),
        "oldPrice": pricing.get("oldPrice"),
        "productWeight": {},
        "characteristics": characteristics,
        "characteristicsUrl": f"{resolved_url.rstrip('/')}/features/",
        "shortCharacteristics": short_characteristics,
        "gallery": gallery,
        "variants": variants,
        "stats": {
            "characteristicCount": len(characteristics),
            "shortCharacteristicCount": len(short_characteristics),
            "galleryImageCount": len(gallery.get("images") or []),
            "galleryVideoCount": len(gallery.get("videos") or []),
            "descriptionImageCount": len(description.get("images") or []),
            "descriptionVideoCount": len(description.get("videos") or []),
            "variantCount": len(variants),
            "hasPrice": bool(pricing.get("uploadPrice")),
        },
    }
