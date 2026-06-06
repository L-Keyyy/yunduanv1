import asyncio
import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

from ozon_client import (
    get_attribute_values,
    get_category_attributes,
    get_category_tree,
)

CACHE_ROOT = Path(__file__).resolve().parent / "cache" / "extension_upload"
CACHE_ROOT.mkdir(parents=True, exist_ok=True)

CATEGORY_TREE_TTL_SECONDS = 86400.0
CATEGORY_ATTRIBUTES_TTL_SECONDS = 86400.0
ATTRIBUTE_VALUES_TTL_SECONDS = 86400.0
_MEMORY_CACHE: Dict[str, tuple[float, Dict[str, Any]]] = {}
CATEGORY_MATCH_CONCURRENCY = max(
    1,
    min(8, int(os.getenv("OZON_UPLOAD_CATEGORY_MATCH_CONCURRENCY", "4"))),
)

DEFAULT_CURRENCY_CODE = "CNY"
DEFAULT_VAT = "0"
DEFAULT_BARCODE = ""
DEFAULT_BRAND = "无品牌"
DEFAULT_MANUFACTURER = "China"
DEFAULT_DEPTH_MM = 100
DEFAULT_WIDTH_MM = 100
DEFAULT_HEIGHT_MM = 150
DEFAULT_WEIGHT_G = 500
MODEL_ATTRIBUTE_ID = 9048
COUNTRY_ATTRIBUTE_ID = 4389
ANNOTATION_ATTRIBUTE_ID = 4191
HASHTAGS_ATTRIBUTE_ID = 23171
MIN_COMPLETE_CHARACTERISTICS = 1

COLOR_ALIAS_GROUPS = [
    (["черн", "black", "黑"], ["Черный", "Чёрный"]),
    (["бел", "white", "白"], ["Белый"]),
    (["красн", "red", "红"], ["Красный"]),
    (["син", "blue", "蓝"], ["Синий"]),
    (["голуб", "light blue", "sky blue", "浅蓝"], ["Голубой"]),
    (["зелен", "green", "绿"], ["Зеленый"]),
    (["желт", "yellow", "黄"], ["Желтый"]),
    (["сер", "gray", "grey", "灰"], ["Серый"]),
    (["сереб", "silver", "银"], ["Серебристый"]),
    (["золот", "gold", "золото", "金"], ["Золотой"]),
    (["роз", "pink", "粉"], ["Розовый"]),
    (["фиолет", "purple", "violet", "紫"], ["Фиолетовый"]),
    (["оранж", "orange", "橙"], ["Оранжевый"]),
    (["корич", "brown", "кофе", "coffee", "咖", "棕"], ["Коричневый"]),
    (["беж", "beige", "米"], ["Бежевый"]),
    (["прозрач", "transparent", "透明"], ["Прозрачный"]),
    (["разноцвет", "мульти", "multi", "multicolor", "цветной", "彩"], ["Разноцветный"]),
]

COLOR_FALLBACK_VALUES = [
    "Разноцветный",
    "Мультиколор",
    "Многоцветный",
    "Цветной",
    "Другой",
]

DIMENSION_AXIS_KEYWORDS = {
    "height": ["высота", "height", "高"],
    "width": ["ширина", "width", "宽"],
    "depth": ["длина", "глубина", "length", "depth", "长"],
}

DIMENSION_SKIP_KEYWORDS = [
    "объем",
    "volume",
    "литр",
    "мл",
    "ml",
    "вес",
    "масса",
    "weight",
    "диаметр",
    "diameter",
]

MANUAL_NAME_MAP: Dict[str, Optional[str]] = {
    "артикул": None,
    "тип": "тип",
    "страна-изготовитель": "страна-изготовитель",
    "материал": "материал",
    "высота см": "высота",
    "ширина см": "ширина",
    "глубина см": "глубина",
    "объем главного отделения л": "объем",
    "материал подкладки": "материал подкладки",
    "вид замка на чемодане": "вид замка",
    "вид принта": "вид принта",
    "количество внутренних отделений": "количество отделений",
    "материал фурнитуры": "материал фурнитуры",
    "цвет": "цвет товара",
    "цвет товара": "цвет товара",
    "цвет модели": "цвет товара",
    "целевая аудитория": "целевая аудитория",
    "пол": "пол",
    "коллекция": "коллекция",
    "размер чемодана": "размер",
    "ручная кладь": "ручная кладь",
    "число колес": "число колес",
    "специальные отделения": "специальные отделения",
    "ручки": "ручки",
    "тип застежки": "тип застежки",
    "вес кг": None,
    "упаковка": "упаковка",
    "гарантийный срок": "гарантийный срок",
    "особенности конструкции сумки": "особенности",
}

SKIP_ATTRIBUTE_NAMES = {
    "артикул",
}

PLACEHOLDER_ATTRIBUTE_VALUES = {
    "",
    "-",
    "--",
    "n/a",
    "na",
    "none",
    "unknown",
    "нет",
    "не указан",
    "не указано",
}

SIZE_TOKENS = {
    "xxs",
    "xs",
    "s",
    "m",
    "l",
    "xl",
    "xxl",
    "xxxl",
    "4xl",
    "5xl",
    "6xl",
    "size",
    "размер",
    "шт",
    "pcs",
    "pc",
}

MANUFACTURER_ATTRIBUTE_KEYWORDS = [
    "manufacturer",
    "производител",
    "изготовител",
    "изготовителя",
]


def _cache_path(prefix: str, key: str) -> Path:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return CACHE_ROOT / f"{prefix}_{digest}.json"


def _memory_cache_key(prefix: str, key: str) -> str:
    return f"{prefix}:{key}"


def _ttl_for_prefix(prefix: str) -> float:
    if prefix == "category_tree":
        return CATEGORY_TREE_TTL_SECONDS
    if prefix == "category_attributes":
        return CATEGORY_ATTRIBUTES_TTL_SECONDS
    if prefix == "attribute_values":
        return ATTRIBUTE_VALUES_TTL_SECONDS
    return ATTRIBUTE_VALUES_TTL_SECONDS


def _load_cache(prefix: str, key: str, ttl_seconds: float) -> Optional[Dict[str, Any]]:
    memory_key = _memory_cache_key(prefix, key)
    memory_entry = _MEMORY_CACHE.get(memory_key)
    if memory_entry:
        expires_at, data = memory_entry
        if expires_at > time.time():
            return data
        _MEMORY_CACHE.pop(memory_key, None)

    path = _cache_path(prefix, key)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    cached_at = float(payload.get("cachedAt") or 0)
    if time.time() - cached_at > ttl_seconds:
        return None
    data = payload.get("data")
    if not isinstance(data, dict):
        return None
    if _looks_like_mojibake(data):
        return None
    _MEMORY_CACHE[memory_key] = (cached_at + ttl_seconds, data)
    return data


def _looks_like_mojibake(data: Dict[str, Any]) -> bool:
    sample = json.dumps(data, ensure_ascii=False)[:20000]
    return (sample.count("Ð") + sample.count("Ñ") > 20) or "�" in sample


def _save_cache(prefix: str, key: str, data: Dict[str, Any]) -> None:
    now = time.time()
    path = _cache_path(prefix, key)
    payload = {
        "cachedAt": now,
        "data": data,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    _MEMORY_CACHE[_memory_cache_key(prefix, key)] = (now + _ttl_for_prefix(prefix), data)


def _require_ok(response: Dict[str, Any], label: str) -> Dict[str, Any]:
    if response.get("ok") is False:
        raise ValueError(response.get("error") or f"{label} request failed")
    data = response.get("data")
    if not isinstance(data, dict):
        raise ValueError(f"{label} returned invalid payload")
    return data


async def get_cached_category_tree_data(client_id: str, api_key: str) -> Dict[str, Any]:
    cached = _load_cache("category_tree", "default", CATEGORY_TREE_TTL_SECONDS)
    if cached:
        return cached

    response = await get_category_tree(client_id, api_key)
    data = _require_ok(response, "category tree")
    _save_cache("category_tree", "default", data)
    return data


async def get_cached_category_attributes_data(
    client_id: str,
    api_key: str,
    description_category_id: int,
    type_id: int,
) -> List[Dict[str, Any]]:
    key = f"{description_category_id}:{type_id}"
    cached = _load_cache("category_attributes", key, CATEGORY_ATTRIBUTES_TTL_SECONDS)
    if cached:
        result = cached.get("result")
        return result if isinstance(result, list) else []

    response = await get_category_attributes(
        client_id,
        api_key,
        description_category_id=description_category_id,
        type_id=type_id,
    )
    data = _require_ok(response, "category attributes")
    _save_cache("category_attributes", key, data)
    result = data.get("result")
    return result if isinstance(result, list) else []


async def get_cached_attribute_values_data(
    client_id: str,
    api_key: str,
    attribute_id: int,
    description_category_id: int,
    type_id: int,
) -> List[Dict[str, Any]]:
    key = f"{attribute_id}:{description_category_id}:{type_id}"
    cached = _load_cache("attribute_values", key, ATTRIBUTE_VALUES_TTL_SECONDS)
    if cached:
        result = cached.get("result")
        return result if isinstance(result, list) else []

    response = await get_attribute_values(
        client_id,
        api_key,
        attribute_id=attribute_id,
        description_category_id=description_category_id,
        type_id=type_id,
    )
    data = _require_ok(response, "attribute values")
    _save_cache("attribute_values", key, data)
    result = data.get("result")
    return result if isinstance(result, list) else []


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def normalize_name(value: Any) -> str:
    return re.sub(r"\s+", " ", normalize_text(value).lower())


def normalize_attribute_key(value: Any) -> str:
    normalized = normalize_name(value).replace("ё", "е")
    normalized = re.sub(r"[^0-9a-zа-я\u4e00-\u9fff#+\s]", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def tokenize_attribute_key(value: Any) -> List[str]:
    normalized = normalize_attribute_key(value)
    if not normalized:
        return []
    return [token for token in normalized.split(" ") if token and len(token) >= 2]


def attribute_token_overlap_score(left: Any, right: Any) -> int:
    left_key = normalize_attribute_key(left)
    right_key = normalize_attribute_key(right)
    if not left_key or not right_key:
        return 0
    if left_key == right_key:
        return 100

    left_tokens = set(tokenize_attribute_key(left_key))
    right_tokens = set(tokenize_attribute_key(right_key))
    if not left_tokens or not right_tokens:
        return 0

    shared = left_tokens & right_tokens
    if not shared:
        return 0

    coverage = len(shared) / max(len(left_tokens), len(right_tokens))
    score = int(len(shared) * 20 + coverage * 40)
    if coverage >= 0.75 and (len(left_tokens) >= 2 or len(right_tokens) >= 2):
        score += 20
    return score


def parse_numeric_value(value: Any) -> float:
    if value is None:
        return float("nan")
    match = re.search(r"-?\d+(?:[.,]\d+)?", str(value).replace(" ", ""))
    if not match:
        return float("nan")
    try:
        return float(match.group(0).replace(",", "."))
    except ValueError:
        return float("nan")


def is_finite_positive(value: Any) -> bool:
    try:
        numeric = float(value)
    except Exception:
        return False
    return numeric == numeric and numeric > 0


def first_present_value(source: Dict[str, Any], keys: List[str]) -> Any:
    if not isinstance(source, dict):
        return None
    for key in keys:
        if key in source and source.get(key) not in (None, ""):
            return source.get(key)
    return None


def _source_with_name(value: Any, name: Any = "") -> str:
    return normalize_text(f"{value or ''} {name or ''}".replace("\u00a0", " ")).lower()


def parse_weight_to_grams(
    value: Any,
    *,
    name: Any = "",
    default_unit: Optional[str] = None,
) -> Optional[int]:
    numeric = parse_numeric_value(value)
    if numeric != numeric or numeric <= 0:
        return None

    source = _source_with_name(value, name)
    normalized_name = normalize_attribute_key(name)
    unit = None
    if re.search(r"(^|[^a-zа-я])(кг|kg|килограмм(?:а|ов)?)([^a-zа-я]|$)", source) or any(
        token in source for token in ["千克", "公斤"]
    ):
        unit = "kg"
    elif re.search(r"(^|[^a-zа-я])(г|гр|g|gram|grams|грамм(?:а|ов)?)([^a-zа-я]|$)", source) or "克" in source:
        unit = "g"
    elif default_unit in {"kg", "g"}:
        unit = default_unit
    elif re.search(r"(^|\s)(кг|kg)(\s|$)", normalized_name):
        unit = "kg"
    elif re.search(r"(^|\s)(г|g)(\s|$)", normalized_name):
        unit = "g"

    if unit == "kg":
        grams = round(numeric * 1000)
    elif unit == "g":
        grams = round(numeric)
    else:
        return None
    return grams if grams > 0 else None


def infer_dimension_unit(value: Any, name: Any = "", default_unit: Optional[str] = None) -> Optional[str]:
    source = _source_with_name(value, name)
    normalized_name = normalize_attribute_key(name)
    if re.search(r"(^|[^a-zа-я])(мм|mm|миллиметр(?:а|ов)?)([^a-zа-я]|$)", source) or "毫米" in source:
        return "mm"
    if re.search(r"(^|[^a-zа-я])(см|cm|сантиметр(?:а|ов)?)([^a-zа-я]|$)", source) or "厘米" in source:
        return "cm"
    if re.search(r"(^|[^a-zа-я])(м|m|метр(?:а|ов)?)([^a-zа-я]|$)", source) or "米" in source:
        return "m"
    if default_unit in {"mm", "cm", "m"}:
        return default_unit
    if re.search(r"(^|\s)(мм|mm)(\s|$)", normalized_name):
        return "mm"
    if re.search(r"(^|\s)(см|cm)(\s|$)", normalized_name):
        return "cm"
    if re.search(r"(^|\s)(м|m)(\s|$)", normalized_name):
        return "m"
    return None


def parse_dimension_to_mm(
    value: Any,
    *,
    name: Any = "",
    default_unit: Optional[str] = None,
) -> Optional[int]:
    numeric = parse_numeric_value(value)
    if numeric != numeric or numeric <= 0:
        return None
    unit = infer_dimension_unit(value, name, default_unit)
    multiplier = {"mm": 1, "cm": 10, "m": 1000}.get(unit)
    if multiplier is None:
        return None
    millimeters = round(numeric * multiplier)
    return millimeters if millimeters > 0 else None


def normalize_price_input(value: Any) -> Optional[str]:
    numeric = parse_numeric_value(value)
    if numeric != numeric:
        return None
    text = f"{numeric:.2f}".rstrip("0").rstrip(".")
    return text or "0"


def build_default_old_price(price_text: str) -> str:
    try:
        numeric = float(str(price_text).replace(",", "."))
    except Exception:
        return "0"
    if numeric <= 0:
        return "0"
    return normalize_price_input(str(numeric * 1.5)) or "0"


def normalize_model(value: Any) -> str:
    return normalize_text(value)[:120]


def normalize_characteristic_entry(item: Any) -> Optional[Dict[str, Any]]:
    name = normalize_text(item.get("name") if isinstance(item, dict) else None)
    if not name:
        return None
    values = []
    raw_values = item.get("values") if isinstance(item, dict) else None
    if isinstance(raw_values, list):
        values = [normalize_text(value) for value in raw_values if normalize_text(value)]
    value_text = normalize_text(item.get("valueText") if isinstance(item, dict) else None)
    if not value_text and values:
        value_text = ", ".join(values)
    if not value_text and not values:
        return None
    return {
        "name": name,
        "valueText": value_text,
        "values": list(dict.fromkeys(values or ([value_text] if value_text else []))),
    }


def build_characteristic_pool(scraped_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    merged: Dict[str, Dict[str, Any]] = {}

    def merge(items: List[Dict[str, Any]]) -> None:
        for item in items:
            normalized = normalize_characteristic_entry(item)
            if not normalized:
                continue
            key = normalize_name(normalized["name"])
            existing = merged.get(key)
            if not existing:
                merged[key] = normalized
                continue
            if not existing.get("valueText") and normalized.get("valueText"):
                existing["valueText"] = normalized["valueText"]
            existing_values = existing.get("values") or []
            next_values = list(dict.fromkeys([*existing_values, *(normalized.get("values") or [])]))
            existing["values"] = next_values
            if not existing.get("valueText") and next_values:
                existing["valueText"] = ", ".join(next_values)

    merge(scraped_data.get("characteristics") or [])
    short_characteristics = []
    for item in scraped_data.get("shortCharacteristics") or []:
        short_characteristics.append(
            {
                "name": item.get("name"),
                "valueText": ", ".join(
                    [normalize_text(value) for value in (item.get("values") or []) if normalize_text(value)]
                ),
                "values": item.get("values") or [],
            }
        )
    merge(short_characteristics)
    return list(merged.values())


def get_char_value(characteristics: List[Dict[str, Any]], name: str) -> Optional[str]:
    target_name = normalize_name(name)
    for item in characteristics:
        if normalize_name(item.get("name")) != target_name:
            continue
        value_text = normalize_text(item.get("valueText"))
        if value_text:
            return value_text
        values = [normalize_text(value) for value in item.get("values") or [] if normalize_text(value)]
        if values:
            return ", ".join(values)
    return None


def has_meaningful_text(value: Any) -> bool:
    text = normalize_text(value)
    if not text:
        return False
    normalized = normalize_attribute_key(text)
    if not normalized:
        return False
    return normalized not in PLACEHOLDER_ATTRIBUTE_VALUES


def get_char_value_by_keywords(
    characteristics: List[Dict[str, Any]],
    keywords: List[str],
) -> Optional[str]:
    normalized_keywords = [
        normalize_attribute_key(item) for item in keywords if normalize_attribute_key(item)
    ]
    if not normalized_keywords:
        return None
    for item in characteristics:
        name_key = normalize_attribute_key(item.get("name"))
        if not name_key:
            continue
        if not any(keyword in name_key for keyword in normalized_keywords):
            continue
        value_text = normalize_text(item.get("valueText"))
        if has_meaningful_text(value_text):
            return value_text
        values = [
            normalize_text(value) for value in item.get("values") or [] if has_meaningful_text(value)
        ]
        if values:
            return ", ".join(values)
    return None


def get_first_char_value(characteristics: List[Dict[str, Any]], names: List[str]) -> Optional[str]:
    for name in names:
        value = get_char_value(characteristics, name)
        if value:
            return value
    return None


def normalize_color_value(raw_value: Any) -> Optional[str]:
    text = normalize_text(raw_value)
    if not has_meaningful_text(text):
        return None

    normalized = normalize_attribute_key(text)
    if not normalized:
        return None
    if normalized.startswith("size "):
        return None

    tokens = [token for token in re.split(r"\s+", normalized) if token]
    if tokens:
        all_size_tokens = True
        for token in tokens:
            if token in SIZE_TOKENS or token.isdigit():
                continue
            all_size_tokens = False
            break
        if all_size_tokens:
            return None

    return text


def is_color_attribute(attr: Dict[str, Any]) -> bool:
    normalized_name = normalize_attribute_key(attr.get("name"))
    if not normalized_name:
        return False
    return (
        "цвет" in normalized_name
        or normalized_name in {"color", "colour"}
        or "color" in normalized_name
    )


def expand_color_candidates(raw_value: Any) -> List[str]:
    color_text = normalize_color_value(raw_value)
    if not color_text:
        return []

    candidates = [color_text]
    normalized = normalize_attribute_key(color_text)
    for needles, aliases in COLOR_ALIAS_GROUPS:
        if any(needle in normalized for needle in needles):
            candidates.extend(aliases)

    result: List[str] = []
    seen = set()
    for item in candidates:
        normalized_item = normalize_attribute_key(item)
        if not normalized_item or normalized_item in seen:
            continue
        seen.add(normalized_item)
        result.append(item)
    return result


def find_color_dict_value(dict_values: List[Dict[str, Any]], raw_value: Any) -> Optional[Dict[str, Any]]:
    for candidate in expand_color_candidates(raw_value):
        matched = find_dict_value(dict_values, candidate)
        if matched:
            return matched
    return None


def find_current_variant(scraped_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    variants = scraped_data.get("variants") or []
    if not isinstance(variants, list) or not variants:
        return None

    product_id = normalize_text(scraped_data.get("productId"))
    fallback = None
    for variant in variants:
        if not isinstance(variant, dict):
            continue
        if fallback is None:
            fallback = variant
        if bool(variant.get("isCurrent")):
            return variant
        if product_id and normalize_text(variant.get("productId")) == product_id:
            return variant
    return fallback


def get_variant_axis_value(scraped_data: Dict[str, Any], keywords: List[str]) -> Optional[str]:
    normalized_keywords = [normalize_attribute_key(item) for item in keywords if normalize_attribute_key(item)]
    if not normalized_keywords:
        return None

    variants = [item for item in (scraped_data.get("variants") or []) if isinstance(item, dict)]
    current_variant = find_current_variant(scraped_data)
    ordered_variants: List[Dict[str, Any]] = []
    if isinstance(current_variant, dict):
        ordered_variants.append(current_variant)
    for variant in variants:
        if current_variant is variant:
            continue
        ordered_variants.append(variant)

    for variant in ordered_variants:
        for axis in variant.get("variantAxes") or []:
            if not isinstance(axis, dict):
                continue
            axis_name = normalize_attribute_key(axis.get("name"))
            if not axis_name:
                continue
            if not any(keyword in axis_name for keyword in normalized_keywords):
                continue
            axis_value = normalize_text(axis.get("value"))
            if axis_value:
                return axis_value

        summary = normalize_text(variant.get("variantSummary"))
        if ":" in summary:
            left, right = summary.split(":", 1)
            left_key = normalize_attribute_key(left)
            if any(keyword in left_key for keyword in normalized_keywords):
                summary_value = normalize_text(right)
                if summary_value:
                    return summary_value
    return None


def merge_variant_axis_characteristics(
    scraped_data: Dict[str, Any],
    characteristics: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    merged = list(characteristics)

    color_value = normalize_color_value(
        get_first_char_value(merged, ["Цвет", "Цвет товара", "Color"])
    )
    if not color_value:
        color_value = normalize_color_value(
            get_char_value_by_keywords(merged, ["цвет", "color", "colour"])
        )
    if not color_value:
        variant_color = get_variant_axis_value(scraped_data, ["цвет", "color", "colour"])
        variant_color = normalize_color_value(variant_color)
        if variant_color:
            merged.append({"name": "Цвет", "valueText": variant_color, "values": [variant_color]})

    model_value = get_first_char_value(merged, ["Модель", "Модель товара", "Model"])
    if not model_value:
        variant_model = get_variant_axis_value(scraped_data, ["модель", "model"])
        if variant_model:
            merged.append({"name": "Модель", "valueText": variant_model, "values": [variant_model]})

    return merged


def resolve_auto_model_value(
    explicit_model: str,
    scraped_data: Dict[str, Any],
    characteristics: List[Dict[str, Any]],
    scraped_sku: str,
) -> str:
    if explicit_model:
        return explicit_model

    characteristic_model = get_first_char_value(
        characteristics,
        ["Модель", "Модель товара", "Model", "Артикул модели", "SKU", "Артикул"],
    )
    if characteristic_model:
        return normalize_model(characteristic_model)

    variant_model = get_variant_axis_value(scraped_data, ["модель", "model"])
    if variant_model:
        return normalize_model(variant_model)

    variant = find_current_variant(scraped_data)
    if isinstance(variant, dict):
        variant_title = normalize_text(variant.get("title"))
        if variant_title:
            return normalize_model(variant_title)

    if scraped_sku:
        return normalize_model(scraped_sku)

    return normalize_model(str(scraped_data.get("productId") or "MODEL"))


def generate_offer_id(scraped_sku: str, product_title: str) -> str:
    prefix = scraped_sku or str(int(time.time() * 1000))
    title_chars = normalize_text(product_title)[:4]
    return f"{prefix}{title_chars}"


def parse_dimension_triplet(value: Any, name: Any = "") -> Optional[Dict[str, float]]:
    matches = re.findall(r"\d+(?:[.,]\d+)?", str(value or "").replace(",", "."))
    if len(matches) < 3:
        return None
    length_value, width_value, height_value = [float(item) for item in matches[:3]]
    unit = infer_dimension_unit(value, name, default_unit="mm")
    multiplier = {"mm": 1, "cm": 10, "m": 1000}.get(unit, 1)
    return {
        "depth": length_value * multiplier,
        "width": width_value * multiplier,
        "height": height_value * multiplier,
    }


def characteristic_raw_value(item: Dict[str, Any]) -> str:
    value_text = normalize_text(item.get("valueText"))
    if value_text:
        return value_text
    values = [normalize_text(value) for value in item.get("values") or [] if normalize_text(value)]
    return ", ".join(values)


def is_package_dimension_name(name_key: str) -> bool:
    return bool(re.search(r"(упаков|package|shipping|посылк)", name_key))


def is_dimension_scalar_name(name_key: str, axis: str) -> bool:
    if not name_key:
        return False
    if any(keyword in name_key for keyword in DIMENSION_SKIP_KEYWORDS):
        return False
    return any(keyword in name_key for keyword in DIMENSION_AXIS_KEYWORDS.get(axis, []))


def find_dimension_scalar(
    characteristics: List[Dict[str, Any]],
    axis: str,
    *,
    package_only: bool = False,
) -> Optional[Dict[str, Any]]:
    for item in characteristics:
        name = normalize_text(item.get("name"))
        name_key = normalize_attribute_key(name)
        if not is_dimension_scalar_name(name_key, axis):
            continue
        is_package_like = is_package_dimension_name(name_key)
        if package_only and not is_package_like:
            continue
        parsed = parse_dimension_to_mm(characteristic_raw_value(item), name=name)
        if not parsed:
            continue
        return {
            "value": parsed,
            "source": f"json-package-{axis}" if is_package_like else f"json-{axis}",
        }
    return None


def find_triplet_dimensions(
    characteristics: List[Dict[str, Any]],
    *,
    package_only: bool = False,
) -> Optional[Dict[str, Any]]:
    for item in characteristics:
        name = normalize_text(item.get("name"))
        name_key = normalize_attribute_key(name)
        if not name:
            continue
        if any(keyword in name_key for keyword in DIMENSION_SKIP_KEYWORDS):
            continue
        is_dimension_like = bool(
            re.search(
                r"(размер|габарит|dimensions|dimension|длина|ширина|высота|length|width|height)",
                name_key,
            )
        )
        is_package_like = is_package_dimension_name(name_key)
        if not is_dimension_like:
            continue
        if package_only and not is_package_like:
            continue

        raw_value = characteristic_raw_value(item)
        triplet = parse_dimension_triplet(raw_value, name)
        if not triplet:
            continue

        return {
            "height": round(triplet["height"]),
            "width": round(triplet["width"]),
            "depth": round(triplet["depth"]),
            "source": "json-package-triplet" if is_package_like else "json-triplet",
        }
    return None


def extract_payload_dimensions(scraped_data: Dict[str, Any], *, package_only: bool = False) -> Optional[Dict[str, Any]]:
    if not isinstance(scraped_data, dict):
        return None

    candidate_keys = (
        ["packageDimensions", "shippingDimensions", "packageSize"]
        if package_only
        else ["dimensions", "productDimensions", "productSize", "size"]
    )
    for key in candidate_keys:
        payload = scraped_data.get(key)
        if payload is None:
            continue
        if isinstance(payload, str):
            triplet = parse_dimension_triplet(payload, key)
            if triplet:
                return {
                    "height": round(triplet["height"]),
                    "width": round(triplet["width"]),
                    "depth": round(triplet["depth"]),
                    "source": f"payload-{key}",
                }
            continue
        if not isinstance(payload, dict):
            continue

        height = parse_dimension_to_mm(
            first_present_value(payload, ["height", "heightMm", "heightMM", "height_mm", "h"]),
            name=f"{key} height",
            default_unit="mm",
        )
        width = parse_dimension_to_mm(
            first_present_value(payload, ["width", "widthMm", "widthMM", "width_mm", "w"]),
            name=f"{key} width",
            default_unit="mm",
        )
        depth = parse_dimension_to_mm(
            first_present_value(
                payload,
                ["depth", "length", "lengthMm", "lengthMM", "length_mm", "depthMm", "depthMM", "depth_mm", "l"],
            ),
            name=f"{key} depth",
            default_unit="mm",
        )
        if height and width and depth:
            return {
                "height": height,
                "width": width,
                "depth": depth,
                "source": f"payload-{key}",
            }
    return None


def extract_dimensions(characteristics: List[Dict[str, Any]]) -> Dict[str, Any]:
    height_entry = find_dimension_scalar(characteristics, "height", package_only=True) or find_dimension_scalar(
        characteristics, "height"
    )
    width_entry = find_dimension_scalar(characteristics, "width", package_only=True) or find_dimension_scalar(
        characteristics, "width"
    )
    depth_entry = find_dimension_scalar(characteristics, "depth", package_only=True) or find_dimension_scalar(
        characteristics, "depth"
    )
    found_count = sum(1 for value in (height_entry, width_entry, depth_entry) if value)
    return {
        "height": height_entry["value"] if height_entry else DEFAULT_HEIGHT_MM,
        "width": width_entry["value"] if width_entry else DEFAULT_WIDTH_MM,
        "depth": depth_entry["value"] if depth_entry else DEFAULT_DEPTH_MM,
        "dimension_unit": "mm",
        "source": "default" if found_count == 0 else "json" if found_count == 3 else "mixed",
    }


def extract_preferred_dimensions(
    characteristics: List[Dict[str, Any]],
    scraped_data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    scraped_data = scraped_data or {}
    payload_package = extract_payload_dimensions(scraped_data, package_only=True)
    package_triplet = find_triplet_dimensions(characteristics, package_only=True)
    payload_generic = None if payload_package or package_triplet else extract_payload_dimensions(scraped_data)
    generic_triplet = None if payload_package or package_triplet or payload_generic else find_triplet_dimensions(characteristics)
    base = extract_dimensions(characteristics)
    chosen = payload_package or package_triplet or payload_generic or generic_triplet
    if not chosen:
        return base
    return {
        **base,
        "height": chosen.get("height") or base["height"],
        "width": chosen.get("width") or base["width"],
        "depth": chosen.get("depth") or base["depth"],
        "source": chosen.get("source") or base["source"],
    }


def extract_weight(characteristics: List[Dict[str, Any]], scraped_data: Dict[str, Any]) -> Dict[str, Any]:
    package_weight = scraped_data.get("packageWeight") or {}
    if isinstance(package_weight, dict):
        grams = parse_weight_to_grams(
            first_present_value(package_weight, ["grams", "weightG", "weightGrams", "weight_g"]),
            default_unit="g",
        )
        if grams:
            return {"weight": grams, "weight_unit": "g", "source": "payload-package-g"}
        grams = parse_weight_to_grams(package_weight.get("weightKg"), default_unit="kg")
        if grams:
            return {"weight": grams, "weight_unit": "g", "source": "payload-package-kg"}
        for key in ["weightText", "orderInfo", "text", "value"]:
            grams = parse_weight_to_grams(package_weight.get(key), name=key)
            if grams:
                return {"weight": grams, "weight_unit": "g", "source": f"payload-package-{key}"}

    for item in characteristics:
        name = normalize_text(item.get("name"))
        name_key = normalize_attribute_key(name)
        if not re.search(r"(вес|масса|weight)", name_key):
            continue
        if not re.search(r"(упаков|package|shipping|посылк)", name_key):
            continue
        grams = parse_weight_to_grams(characteristic_raw_value(item), name=name)
        if grams:
            return {"weight": grams, "weight_unit": "g", "source": "json-package"}

    product_weight = scraped_data.get("productWeight") or {}
    if isinstance(product_weight, dict):
        grams = parse_weight_to_grams(
            first_present_value(product_weight, ["grams", "weightG", "weightGrams", "weight_g"]),
            default_unit="g",
        )
        if grams:
            return {"weight": grams, "weight_unit": "g", "source": "payload-product-g"}
        grams = parse_weight_to_grams(product_weight.get("weightKg"), default_unit="kg")
        if grams:
            return {"weight": grams, "weight_unit": "g", "source": "payload-product-kg"}
        for key in ["weightText", "characteristicValueText", "text", "value"]:
            grams = parse_weight_to_grams(product_weight.get(key), name=key)
            if grams:
                return {"weight": grams, "weight_unit": "g", "source": f"payload-product-{key}"}

    for item in characteristics:
        name = normalize_text(item.get("name"))
        name_key = normalize_attribute_key(name)
        if not re.search(r"(вес|масса|weight)", name_key):
            continue
        if re.search(r"(упаков|package|shipping|посылк)", name_key):
            continue
        grams = parse_weight_to_grams(characteristic_raw_value(item), name=name)
        if grams:
            return {"weight": grams, "weight_unit": "g", "source": "json-product"}

    return {"weight": DEFAULT_WEIGHT_G, "weight_unit": "g", "source": "default"}


def extract_images(scraped_data: Dict[str, Any]) -> Dict[str, Any]:
    gallery = scraped_data.get("gallery") or {}
    raw_images = gallery.get("images") or []
    all_images = [
        normalize_text(item.get("src") if isinstance(item, dict) else item)
        for item in raw_images
        if normalize_text(item.get("src") if isinstance(item, dict) else item)
    ]
    cover = normalize_text(gallery.get("coverImage")) or (all_images[0] if all_images else "")
    if not cover:
        description_images = scraped_data.get("description", {}).get("images") or []
        all_images = [
            normalize_text(item.get("src") if isinstance(item, dict) else item)
            for item in description_images
            if normalize_text(item.get("src") if isinstance(item, dict) else item)
        ]
        cover = all_images[0] if all_images else ""
    other_images = [url for url in all_images if url and url != cover][:14]
    return {
        "primary_image": cover,
        "images": other_images,
    }


def extract_description(description_obj: Any) -> str:
    if not isinstance(description_obj, dict):
        return ""
    direct_text = normalize_text(description_obj.get("text"))
    if direct_text:
        return direct_text
    html = normalize_text(description_obj.get("html"))
    if not html:
        return ""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", html)).strip()


def build_fallback_description(
    scraped_data: Dict[str, Any],
    characteristics: List[Dict[str, Any]],
) -> str:
    title = normalize_text(scraped_data.get("title"))
    feature_parts: List[str] = []

    for char in characteristics:
        name = normalize_text(char.get("name"))
        if not name or normalize_attribute_key(name) in SKIP_ATTRIBUTE_NAMES:
            continue
        value_text = normalize_text(char.get("valueText"))
        if not value_text:
            values = [normalize_text(value) for value in (char.get("values") or []) if normalize_text(value)]
            value_text = ", ".join(values)
        if not value_text:
            continue
        feature_parts.append(f"{name}: {value_text}")
        if len(feature_parts) >= 8:
            break

    if not title and not feature_parts:
        return ""

    parts: List[str] = []
    if title:
        parts.append(title)
    if feature_parts:
        parts.append("Характеристики: " + "; ".join(feature_parts))
    return normalize_text(" ".join(parts))[:3500]


def flatten_tree(tree_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    leaves: List[Dict[str, Any]] = []

    def walk(nodes: List[Dict[str, Any]], parent_cat_id: Optional[int], path_names: List[str]) -> None:
        for node in nodes:
            if not isinstance(node, dict):
                continue
            if node.get("type_id") is not None:
                leaves.append(
                    {
                        "description_category_id": parent_cat_id,
                        "type_id": node.get("type_id"),
                        "type_name": node.get("type_name") or "",
                        "disabled": bool(node.get("disabled")),
                        "path": [*path_names, node.get("type_name") or ""],
                    }
                )
                continue
            cat_id = node.get("description_category_id") or parent_cat_id
            category_name = node.get("category_name") or ""
            walk(node.get("children") or [], cat_id, [*path_names, category_name])

    walk(tree_data.get("result") or [], None, [])
    return leaves


def find_best_match(
    tree_data: Dict[str, Any],
    breadcrumb_names: List[str],
    type_name: str,
) -> Optional[Dict[str, Any]]:
    leaves = flatten_tree(tree_data)
    normalized_type = normalize_name(type_name)
    normalized_breadcrumbs = [normalize_name(item) for item in breadcrumb_names if normalize_name(item)]
    best_match = None
    best_score = -1

    for leaf in leaves:
        if leaf.get("disabled"):
            continue
        normalized_leaf_type = normalize_name(leaf.get("type_name"))
        normalized_path = [normalize_name(item) for item in leaf.get("path") or []]
        if not normalized_type and not normalized_breadcrumbs:
            continue

        score = 0
        if normalized_type:
            if normalized_leaf_type == normalized_type:
                score += 20
            elif normalized_leaf_type and (
                normalized_leaf_type in normalized_type or normalized_type in normalized_leaf_type
            ):
                score += 10
            else:
                continue

        for breadcrumb in normalized_breadcrumbs:
            for path_part in normalized_path:
                if path_part == breadcrumb:
                    score += 5
                    break
                if path_part and (path_part in breadcrumb or breadcrumb in path_part):
                    score += 3
                    break

        if score > best_score:
            best_score = score
            best_match = {**leaf, "score": score}

    return best_match


def search_by_keyword(tree_data: Dict[str, Any], keyword: str) -> List[Dict[str, Any]]:
    normalized_keyword = normalize_name(keyword)
    if not normalized_keyword or len(normalized_keyword) < 3:
        return []
    result = []
    for leaf in flatten_tree(tree_data):
        if leaf.get("disabled"):
            continue
        full_path = " ".join(normalize_name(item) for item in leaf.get("path") or [])
        type_name = normalize_name(leaf.get("type_name"))
        if normalized_keyword in full_path or normalized_keyword in type_name:
            result.append(leaf)
    return result


def build_attribute_name_map(ozon_attributes: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    name_map: Dict[str, Dict[str, Any]] = {}
    for attribute in ozon_attributes:
        name_map[normalize_attribute_key(attribute.get("name"))] = attribute
    return name_map


def resolve_attribute_definition(
    name_map: Dict[str, Dict[str, Any]],
    raw_name: str,
) -> Optional[Dict[str, Any]]:
    normalized_name = normalize_attribute_key(raw_name)
    if not normalized_name:
        return None

    direct = name_map.get(normalized_name)
    if direct:
        return direct

    without_unit = re.sub(r"\s*(см|кг|kg|л|мм|г|cm|mm)\s*$", "", normalized_name).strip()
    if without_unit and without_unit in name_map:
        return name_map[without_unit]

    mapped_name = MANUAL_NAME_MAP.get(normalized_name)
    if mapped_name is not None:
        if mapped_name == "":
            return None
        mapped_attribute = name_map.get(normalize_attribute_key(mapped_name))
        if mapped_attribute:
            return mapped_attribute
    elif normalized_name in MANUAL_NAME_MAP and MANUAL_NAME_MAP[normalized_name] is None:
        return None

    best_match = None
    best_score = 0
    for key, attribute in name_map.items():
        if not key:
            continue
        score = attribute_token_overlap_score(normalized_name, key)
        if score > best_score:
            best_score = score
            best_match = attribute

    return best_match if best_score >= 60 else None


def count_attribute_matches(
    scraped_chars: List[Dict[str, Any]],
    ozon_attributes: List[Dict[str, Any]],
) -> int:
    name_map = build_attribute_name_map(ozon_attributes)
    matched_ids = set()
    for char in scraped_chars:
        normalized_name = normalize_attribute_key(char.get("name"))
        if normalized_name in SKIP_ATTRIBUTE_NAMES:
            continue
        attribute = resolve_attribute_definition(name_map, char.get("name") or "")
        if attribute:
            matched_ids.add(int(attribute.get("id") or 0))
    return len(matched_ids)


def find_dict_value(dict_values: List[Dict[str, Any]], text_value: str) -> Optional[Dict[str, Any]]:
    normalized_text = normalize_attribute_key(text_value)
    for value in dict_values:
        if normalize_attribute_key(value.get("value")) == normalized_text:
            return value
    for value in dict_values:
        normalized_value = normalize_attribute_key(value.get("value"))
        if normalized_value and (
            normalized_value in normalized_text or normalized_text in normalized_value
        ):
            return value
    return None


async def match_attributes(
    scraped_chars: List[Dict[str, Any]],
    ozon_attributes: List[Dict[str, Any]],
    get_dict_values: Callable[[int], Awaitable[List[Dict[str, Any]]]],
) -> Dict[str, Any]:
    name_map = build_attribute_name_map(ozon_attributes)
    matched: List[Dict[str, Any]] = []
    unmatched: List[Dict[str, Any]] = []
    ozon_format: List[Dict[str, Any]] = []

    for char in scraped_chars:
        normalized_name = normalize_attribute_key(char.get("name"))
        if normalized_name in SKIP_ATTRIBUTE_NAMES:
            matched.append({"scraped": char, "note": "handled elsewhere"})
            continue

        attribute = resolve_attribute_definition(name_map, char.get("name") or "")
        if attribute is None:
            unmatched.append(char)
            continue

        values = char.get("values") or []
        if not values and normalize_text(char.get("valueText")):
            values = [char.get("valueText")]

        ozon_values: List[Dict[str, Any]] = []
        for raw_value in values:
            text_value = normalize_text(raw_value)
            if not text_value:
                continue
            dictionary_id = int(attribute.get("dictionary_id") or 0)
            is_color = is_color_attribute(attribute)
            if dictionary_id > 0:
                dict_values = await get_dict_values(int(attribute.get("id") or 0))
                matched_value = (
                    find_color_dict_value(dict_values, text_value)
                    if is_color
                    else find_dict_value(dict_values, text_value)
                )
                if matched_value:
                    ozon_values.append(
                        {
                            "dictionary_value_id": int(matched_value.get("id") or 0),
                            "value": matched_value.get("value"),
                        }
                    )
                    continue
                if is_color:
                    for fallback in COLOR_FALLBACK_VALUES:
                        matched_value = find_dict_value(dict_values, fallback)
                        if matched_value:
                            ozon_values.append(
                                {
                                    "dictionary_value_id": int(matched_value.get("id") or 0),
                                    "value": matched_value.get("value"),
                                }
                            )
                            break
                    if matched_value:
                        continue
                    continue
            ozon_values.append(
                {
                    "dictionary_value_id": 0,
                    "value": text_value,
                }
            )

        if not ozon_values:
            unmatched.append(char)
            continue

        attr_id = int(attribute.get("id") or 0)
        existing = next((item for item in ozon_format if int(item.get("id") or 0) == attr_id), None)
        if existing:
            current_values = existing.get("values") or []
            merged_values = []
            seen_values = set()
            for value in [*current_values, *ozon_values]:
                dict_id = int(value.get("dictionary_value_id") or 0)
                text_value = normalize_text(value.get("value"))
                key = (dict_id, text_value.lower())
                if key in seen_values:
                    continue
                seen_values.add(key)
                merged_values.append(
                    {
                        "dictionary_value_id": dict_id,
                        "value": text_value,
                    }
                )
            existing["values"] = merged_values
        else:
            ozon_format.append(
                {
                    "id": attr_id,
                    "complex_id": 0,
                    "values": ozon_values,
                }
            )
        matched.append(
            {
                "scraped": char,
                "ozonAttr": {"id": attribute.get("id"), "name": attribute.get("name")},
                "values": ozon_values,
            }
        )

    return {
        "matched": matched,
        "unmatched": unmatched,
        "ozonFormat": ozon_format,
    }


def has_meaningful_attribute(entry: Optional[Dict[str, Any]]) -> bool:
    if not isinstance(entry, dict):
        return False
    for value in entry.get("values") or []:
        if int(value.get("dictionary_value_id") or 0) > 0:
            return True
        if has_meaningful_text(value.get("value")):
            return True
    return False


def has_meaningful_color_attribute(entry: Optional[Dict[str, Any]], attr: Dict[str, Any]) -> bool:
    if int(attr.get("dictionary_id") or 0) <= 0:
        return has_meaningful_attribute(entry)
    if not isinstance(entry, dict):
        return False
    return any(int(value.get("dictionary_value_id") or 0) > 0 for value in entry.get("values") or [])


def upsert_attribute(
    attributes: List[Dict[str, Any]],
    attr: Dict[str, Any],
    values: List[Dict[str, Any]],
) -> None:
    next_values = []
    for value in values or []:
        if int(value.get("dictionary_value_id") or 0) > 0 or normalize_text(value.get("value")):
            next_values.append(value)
    if not next_values:
        return

    existing = next((item for item in attributes if int(item.get("id") or 0) == int(attr.get("id") or 0)), None)
    if existing:
        existing["complex_id"] = 0
        existing["values"] = next_values
        return

    attributes.append(
        {
            "id": int(attr.get("id") or 0),
            "complex_id": 0,
            "values": next_values,
        }
    )


def normalize_hashtag(tag: Any) -> str:
    raw = normalize_text(tag)
    if not raw:
        return ""
    token = re.sub(r"[^\w\u0400-\u04ff]+", "", re.sub(r"\s+", "_", re.sub(r"^#+", "", raw)))
    return f"#{token}" if token else ""


def build_hashtag_text(scraped_data: Dict[str, Any]) -> str:
    tags = []
    raw_tags = list(scraped_data.get("hashtags") or [])
    raw_tags.extend(re.findall(r"#[^\s#]+", extract_description(scraped_data.get("description"))))
    for tag in raw_tags:
        normalized = normalize_hashtag(tag)
        if normalized and normalized not in tags:
            tags.append(normalized)
    return " ".join(tags[:30])


async def build_country_attribute_values(
    attr: Dict[str, Any],
    get_dict_values: Callable[[int], Awaitable[List[Dict[str, Any]]]],
) -> List[Dict[str, Any]]:
    if int(attr.get("dictionary_id") or 0) <= 0:
        return [{"dictionary_value_id": 0, "value": DEFAULT_MANUFACTURER}]

    dict_values = await get_dict_values(int(attr.get("id") or 0))
    for value in dict_values:
        normalized = normalize_name(value.get("value"))
        if "китай" in normalized or "china" in normalized or "中国" in normalized:
            return [
                {
                    "dictionary_value_id": int(value.get("id") or 0),
                    "value": value.get("value"),
                }
            ]
    return [{"dictionary_value_id": 0, "value": DEFAULT_MANUFACTURER}]


def is_manufacturer_attribute(attr: Dict[str, Any]) -> bool:
    attr_id = int(attr.get("id") or 0)
    if attr_id == COUNTRY_ATTRIBUTE_ID:
        return False
    normalized_name = normalize_attribute_key(attr.get("name"))
    if not normalized_name:
        return False
    if "страна" in normalized_name:
        return False
    return any(keyword in normalized_name for keyword in MANUFACTURER_ATTRIBUTE_KEYWORDS)


async def build_manufacturer_attribute_values(
    attr: Dict[str, Any],
    get_dict_values: Callable[[int], Awaitable[List[Dict[str, Any]]]],
) -> List[Dict[str, Any]]:
    if int(attr.get("dictionary_id") or 0) <= 0:
        return [{"dictionary_value_id": 0, "value": DEFAULT_MANUFACTURER}]

    dict_values = await get_dict_values(int(attr.get("id") or 0))
    matched = find_dict_value(dict_values, DEFAULT_MANUFACTURER)
    if matched:
        return [
            {
                "dictionary_value_id": int(matched.get("id") or 0),
                "value": matched.get("value"),
            }
        ]
    for value in dict_values:
        normalized = normalize_attribute_key(value.get("value"))
        if "china" in normalized or "китай" in normalized:
            return [
                {
                    "dictionary_value_id": int(value.get("id") or 0),
                    "value": value.get("value"),
                }
            ]
    return [{"dictionary_value_id": 0, "value": DEFAULT_MANUFACTURER}]


async def build_text_attribute_values(
    attr: Dict[str, Any],
    text_value: Any,
    get_dict_values: Callable[[int], Awaitable[List[Dict[str, Any]]]],
) -> List[Dict[str, Any]]:
    normalized = normalize_text(text_value)
    if not normalized:
        return []

    if int(attr.get("dictionary_id") or 0) > 0:
        dict_values = await get_dict_values(int(attr.get("id") or 0))
        matched = find_dict_value(dict_values, normalized)
        if matched:
            return [
                {
                    "dictionary_value_id": int(matched.get("id") or 0),
                    "value": matched.get("value"),
                }
            ]

    return [{"dictionary_value_id": 0, "value": normalized}]


async def build_color_attribute_values(
    attr: Dict[str, Any],
    text_value: Any,
    get_dict_values: Callable[[int], Awaitable[List[Dict[str, Any]]]],
) -> List[Dict[str, Any]]:
    color_text = normalize_color_value(text_value)
    if not color_text:
        return []

    if int(attr.get("dictionary_id") or 0) <= 0:
        return [{"dictionary_value_id": 0, "value": color_text}]

    dict_values = await get_dict_values(int(attr.get("id") or 0))
    matched = find_color_dict_value(dict_values, color_text)
    if not matched:
        for fallback in COLOR_FALLBACK_VALUES:
            matched = find_dict_value(dict_values, fallback)
            if matched:
                break
    if not matched:
        return []
    return [
        {
            "dictionary_value_id": int(matched.get("id") or 0),
            "value": matched.get("value"),
        }
    ]


async def resolve_category_info(
    client_id: str,
    api_key: str,
    scraped_data: Dict[str, Any],
) -> Dict[str, Any]:
    tree_data = await get_cached_category_tree_data(client_id, api_key)
    characteristics = merge_variant_axis_characteristics(
        scraped_data,
        build_characteristic_pool(scraped_data),
    )
    breadcrumbs = [
        normalize_text(item.get("text") if isinstance(item, dict) else item)
        for item in scraped_data.get("breadcrumbs") or []
        if normalize_text(item.get("text") if isinstance(item, dict) else item)
    ]
    type_name = (
        get_first_char_value(characteristics, ["Тип", "Type"])
        or normalize_text(scraped_data.get("typeName"))
        or ""
    )
    direct_match = find_best_match(tree_data, breadcrumbs, type_name)

    candidates: List[Dict[str, Any]] = []
    if direct_match:
        direct_score = int(direct_match.get("score") or 0)
        if direct_score >= 25:
            bonus = 80
        elif direct_score >= 15:
            bonus = 30
        else:
            bonus = 0
        candidates.append({**direct_match, "lexicalScore": direct_score + bonus})

    title_tokens = [
        token
        for token in re.split(r"\s+", normalize_text(scraped_data.get("title")))
        if token and len(token) >= 3
    ][:3]
    keyword_sources = [
        type_name,
        breadcrumbs[-1] if breadcrumbs else "",
        *title_tokens,
    ]
    for keyword in keyword_sources:
        for candidate in search_by_keyword(tree_data, keyword)[:12]:
            candidates.append({**candidate, "lexicalScore": int(candidate.get("score") or 0)})

    deduped: List[Dict[str, Any]] = []
    seen = set()
    for candidate in candidates:
        key = f"{candidate.get('description_category_id')}:{candidate.get('type_id')}"
        if key in seen or not candidate.get("description_category_id") or not candidate.get("type_id"):
            continue
        seen.add(key)
        deduped.append(candidate)

    if not deduped:
        raise ValueError("Unable to resolve Ozon category from scraped product data")

    candidate_batch = deduped[:8]
    semaphore = asyncio.Semaphore(min(CATEGORY_MATCH_CONCURRENCY, len(candidate_batch) or 1))

    async def score_candidate(candidate: Dict[str, Any]) -> Dict[str, Any]:
        description_category_id = int(candidate.get("description_category_id") or 0)
        type_id = int(candidate.get("type_id") or 0)
        async with semaphore:
            try:
                attrs = await get_cached_category_attributes_data(
                    client_id,
                    api_key,
                    description_category_id=description_category_id,
                    type_id=type_id,
                )
            except Exception:
                attrs = []
        attribute_score = count_attribute_matches(characteristics, attrs)
        lexical_score = int(candidate.get("lexicalScore") or 0)
        return {
            "description_category_id": description_category_id,
            "type_id": type_id,
            "lexicalScore": lexical_score,
            "attributeScore": attribute_score,
            "path": candidate.get("path") or [],
        }

    compared = await asyncio.gather(*(score_candidate(candidate) for candidate in candidate_batch))
    best = None
    for scored in compared:
        attribute_score = int(scored.get("attributeScore") or 0)
        lexical_score = int(scored.get("lexicalScore") or 0)
        total_score = attribute_score * 1000 + lexical_score
        if best is None or total_score > best["totalScore"]:
            best = {
                "description_category_id": int(scored.get("description_category_id") or 0),
                "type_id": int(scored.get("type_id") or 0),
                "attributeScore": attribute_score,
                "lexicalScore": lexical_score,
                "totalScore": total_score,
            }

    if best is None:
        raise ValueError("Unable to determine best Ozon category candidate")

    return {
        "description_category_id": best["description_category_id"],
        "type_id": best["type_id"],
        "resolution": {
            "strategy": "attribute-fit" if best["attributeScore"] >= 0 else "keyword",
            "attributeScore": best["attributeScore"],
            "compared": compared,
        },
    }


async def build_upload_item(
    *,
    client_id: str,
    api_key: str,
    scraped_data: Dict[str, Any],
    price: Any,
    old_price: Any = None,
    min_price: Any = None,
    model: Any = None,
) -> Dict[str, Any]:
    normalized_price = (
        normalize_price_input(price)
        or normalize_price_input(scraped_data.get("price"))
        or normalize_price_input((scraped_data.get("pricing") or {}).get("uploadPrice"))
        or normalize_price_input((scraped_data.get("pricing") or {}).get("priceText"))
        or normalize_price_input((scraped_data.get("pricing") or {}).get("cardPriceText"))
    )
    if not normalized_price or float(normalized_price) <= 0:
        raise ValueError("Missing upload price. Extract a buyer-side price first.")

    explicit_old_price = normalize_price_input(old_price)
    normalized_old_price = explicit_old_price or build_default_old_price(normalized_price)
    normalized_min_price = normalize_price_input(min_price) or normalize_price_input(
        (scraped_data.get("follow_config") or {}).get("min_price")
    )
    normalized_model = normalize_model(model or (scraped_data.get("follow_config") or {}).get("model"))

    characteristics = build_characteristic_pool(scraped_data)
    description = extract_description(scraped_data.get("description"))
    if not description:
        description = build_fallback_description(scraped_data, characteristics)
    if not description:
        raise ValueError("Product data incomplete: description was not captured. Reload the extension and product page, then upload again.")
    if len(characteristics) < MIN_COMPLETE_CHARACTERISTICS:
        raise ValueError(
            "Product data incomplete: no characteristics were captured. Wait for the full product page to load, then upload again."
        )

    category_info = await resolve_category_info(client_id, api_key, scraped_data)
    description_category_id = int(category_info["description_category_id"])
    type_id = int(category_info["type_id"])
    ozon_attributes = await get_cached_category_attributes_data(
        client_id,
        api_key,
        description_category_id=description_category_id,
        type_id=type_id,
    )

    dict_values_cache: Dict[int, List[Dict[str, Any]]] = {}

    async def get_dict_values(attribute_id: int) -> List[Dict[str, Any]]:
        normalized_attribute_id = int(attribute_id or 0)
        if normalized_attribute_id in dict_values_cache:
            return dict_values_cache[normalized_attribute_id]
        values = await get_cached_attribute_values_data(
            client_id,
            api_key,
            attribute_id=normalized_attribute_id,
            description_category_id=description_category_id,
            type_id=type_id,
        )
        dict_values_cache[normalized_attribute_id] = values
        return values

    match_report = await match_attributes(characteristics, ozon_attributes, get_dict_values)
    formatted_attributes = list(match_report["ozonFormat"])

    brand_attr = next(
        (attr for attr in ozon_attributes if "бренд" in normalize_name(attr.get("name"))),
        None,
    )
    if brand_attr:
        brand_value = {"dictionary_value_id": 0, "value": DEFAULT_BRAND}
        if int(brand_attr.get("dictionary_id") or 0) > 0:
            brand_dict_values = await get_dict_values(int(brand_attr.get("id") or 0))
            matched_brand = next(
                (
                    item
                    for item in brand_dict_values
                    if "нет бренда" in normalize_name(item.get("value"))
                ),
                None,
            )
            if matched_brand:
                brand_value = {
                    "dictionary_value_id": int(matched_brand.get("id") or 0),
                    "value": matched_brand.get("value"),
                }
        upsert_attribute(
            formatted_attributes,
            brand_attr,
            [brand_value],
        )

    country_attr = next(
        (
            attr
            for attr in ozon_attributes
            if int(attr.get("id") or 0) == COUNTRY_ATTRIBUTE_ID
            or "страна-изготовитель" in normalize_name(attr.get("name"))
            or "страна производства" in normalize_name(attr.get("name"))
        ),
        None,
    )
    if country_attr and not has_meaningful_attribute(
        next((item for item in formatted_attributes if int(item.get("id") or 0) == int(country_attr.get("id") or 0)), None)
    ):
        upsert_attribute(
            formatted_attributes,
            country_attr,
            await build_country_attribute_values(country_attr, get_dict_values),
        )

    manufacturer_attr = next((attr for attr in ozon_attributes if is_manufacturer_attribute(attr)), None)
    if manufacturer_attr and not has_meaningful_attribute(
        next(
            (
                item
                for item in formatted_attributes
                if int(item.get("id") or 0) == int(manufacturer_attr.get("id") or 0)
            ),
            None,
        )
    ):
        upsert_attribute(
            formatted_attributes,
            manufacturer_attr,
            await build_manufacturer_attribute_values(manufacturer_attr, get_dict_values),
        )

    gender_attr = next(
        (
            attr
            for attr in ozon_attributes
            if int(attr.get("id") or 0) == 9163
            or normalize_attribute_key(attr.get("name")) == "пол"
        ),
        None,
    )
    if gender_attr and not has_meaningful_attribute(
        next((item for item in formatted_attributes if int(item.get("id") or 0) == int(gender_attr.get("id") or 0)), None)
    ):
        gender_value = get_first_char_value(characteristics, ["Пол", "Gender"])
        if gender_value:
            upsert_attribute(
                formatted_attributes,
                gender_attr,
                await build_text_attribute_values(gender_attr, gender_value, get_dict_values),
            )

    color_attr = next(
        (
            attr
            for attr in ozon_attributes
            if is_color_attribute(attr)
        ),
        None,
    )
    if color_attr and int(color_attr.get("dictionary_id") or 0) > 0:
        color_attr_id = int(color_attr.get("id") or 0)
        formatted_attributes = [
            entry
            for entry in formatted_attributes
            if int(entry.get("id") or 0) != color_attr_id
            or any(int(value.get("dictionary_value_id") or 0) > 0 for value in entry.get("values") or [])
        ]
    if color_attr and not has_meaningful_color_attribute(
        next(
            (item for item in formatted_attributes if int(item.get("id") or 0) == int(color_attr.get("id") or 0)),
            None,
        ),
        color_attr,
    ):
        color_value = normalize_color_value(
            get_first_char_value(characteristics, ["Цвет", "Цвет товара", "Color"])
        )
        if not color_value:
            color_value = normalize_color_value(
                get_char_value_by_keywords(characteristics, ["цвет", "color", "colour"])
            )
        if not color_value:
            color_value = normalize_color_value(
                get_variant_axis_value(scraped_data, ["цвет", "color", "colour"])
            )
        if color_value:
            upsert_attribute(
                formatted_attributes,
                color_attr,
                await build_color_attribute_values(color_attr, color_value, get_dict_values),
            )

    annotation_attr = next(
        (
            attr
            for attr in ozon_attributes
            if int(attr.get("id") or 0) == ANNOTATION_ATTRIBUTE_ID
            or "аннотац" in normalize_name(attr.get("name"))
        ),
        None,
    )
    annotation_text = extract_description(scraped_data.get("description"))
    if annotation_attr and annotation_text and not has_meaningful_attribute(
        next((item for item in formatted_attributes if int(item.get("id") or 0) == int(annotation_attr.get("id") or 0)), None)
    ):
        upsert_attribute(
            formatted_attributes,
            annotation_attr,
            [{"dictionary_value_id": 0, "value": annotation_text}],
        )

    hashtags_attr = next(
        (
            attr
            for attr in ozon_attributes
            if int(attr.get("id") or 0) == HASHTAGS_ATTRIBUTE_ID
            or "хештег" in normalize_name(attr.get("name"))
        ),
        None,
    )
    hashtag_text = build_hashtag_text(scraped_data)
    if hashtags_attr and hashtag_text and not has_meaningful_attribute(
        next((item for item in formatted_attributes if int(item.get("id") or 0) == int(hashtags_attr.get("id") or 0)), None)
    ):
        upsert_attribute(
            formatted_attributes,
            hashtags_attr,
            [{"dictionary_value_id": 0, "value": hashtag_text}],
        )

    scraped_sku = get_char_value(characteristics, "Артикул") or str(scraped_data.get("productId") or "")
    model_value = resolve_auto_model_value(normalized_model, scraped_data, characteristics, scraped_sku)
    model_attr = next(
        (
            attr
            for attr in ozon_attributes
            if int(attr.get("id") or 0) == MODEL_ATTRIBUTE_ID
            or "модел" in normalize_attribute_key(attr.get("name"))
            or normalize_attribute_key(attr.get("name")) == "артикул модели"
        ),
        None,
    )
    if model_attr:
        upsert_attribute(
            formatted_attributes,
            model_attr,
            await build_text_attribute_values(model_attr, model_value, get_dict_values),
        )
    else:
        existing_model_attr = next(
            (item for item in formatted_attributes if int(item.get("id") or 0) == MODEL_ATTRIBUTE_ID),
            None,
        )
        model_payload = [{"dictionary_value_id": 0, "value": model_value}]
        if existing_model_attr:
            existing_model_attr["values"] = model_payload
        else:
            formatted_attributes.append(
                {
                    "id": MODEL_ATTRIBUTE_ID,
                    "complex_id": 0,
                    "values": model_payload,
                }
            )

    dimensions = extract_preferred_dimensions(characteristics, scraped_data)
    weight_info = extract_weight(characteristics, scraped_data)
    image_info = extract_images(scraped_data)
    item = {
        "offer_id": generate_offer_id(scraped_sku, normalize_text(scraped_data.get("title"))),
        "name": normalize_text(scraped_data.get("title")),
        "description_category_id": description_category_id,
        "type_id": type_id,
        "barcode": DEFAULT_BARCODE,
        "description": description,
        "price": normalized_price,
        "old_price": normalized_old_price,
        "min_price": normalized_min_price,
        "currency_code": DEFAULT_CURRENCY_CODE,
        "vat": DEFAULT_VAT,
        "height": dimensions["height"],
        "width": dimensions["width"],
        "depth": dimensions["depth"],
        "dimension_unit": dimensions["dimension_unit"],
        "weight": weight_info["weight"],
        "weight_unit": weight_info["weight_unit"],
        "primary_image": image_info["primary_image"],
        "images": image_info["images"],
        "attributes": formatted_attributes,
    }
    if not item["primary_image"]:
        raise ValueError("Missing primary image in scraped product data")

    meta = {
        "source_product_id": scraped_data.get("productId"),
        "source_url": scraped_data.get("sourceUrl"),
        "scraped_sku": scraped_sku,
        "dimensions_source": dimensions["source"],
        "weight_source": weight_info["source"],
        "total_images": len(item["images"]) + 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "category_resolution": category_info.get("resolution"),
        "matched_attributes": len(match_report["matched"]),
        "unmatched_attributes": len(match_report["unmatched"]),
    }
    return {
        "item": item,
        "meta": meta,
        "category_info": {
            "description_category_id": description_category_id,
            "type_id": type_id,
            "resolution": category_info.get("resolution"),
        },
    }
