import base64
import io
import math
import threading
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Dict, List, Optional, Sequence, Tuple


SUPPORTED_TARGET_LANGUAGES = {"ru", "en", "es", "de"}

_OCR_LOCK = threading.Lock()
_OCR_ENGINE: Any = None
_OCR_ENGINE_ERROR: Optional[str] = None


@dataclass
class ImageWorkshopResult:
    image_data_url: str
    background_data_url: str
    regions: List[Dict[str, Any]]
    engine: str
    warnings: List[str]


def process_product_image(
    image_bytes: bytes,
    *,
    filename: str = "image.png",
    target_language: str = "ru",
    translation_mode: str = "product_short",
) -> ImageWorkshopResult:
    if target_language not in SUPPORTED_TARGET_LANGUAGES:
        target_language = "ru"

    pil_image, np_image, cv2, np = _load_image_stack(image_bytes)
    regions, engine, warnings = _detect_text_regions(np_image)

    if not regions:
        regions = _detect_layout_text_regions(np_image)
        if regions:
            engine = f"{engine}+layout-fallback"
            warnings.append("OCR 未返回文字框，已使用图片布局检测兜底。")

    output, background = _inpaint_and_draw(
        pil_image=pil_image,
        np_image=np_image,
        cv2=cv2,
        np=np,
        regions=regions,
        target_language=target_language,
        translation_mode=translation_mode,
    )
    return ImageWorkshopResult(
        image_data_url=_image_to_data_url(output),
        background_data_url=_image_to_data_url(background),
        regions=regions,
        engine=engine,
        warnings=warnings,
    )


def process_product_image_regions(
    image_bytes: bytes,
    *,
    regions: List[Dict[str, Any]],
    target_language: str = "ru",
    engine: str = "external-vision",
    warnings: Optional[List[str]] = None,
) -> ImageWorkshopResult:
    """Erase and redraw externally translated text regions."""
    if target_language not in SUPPORTED_TARGET_LANGUAGES:
        target_language = "ru"

    pil_image, np_image, cv2, np = _load_image_stack(image_bytes)
    normalized_regions = [dict(region) for region in regions if isinstance(region, dict)]
    output, background = _inpaint_and_draw(
        pil_image=pil_image,
        np_image=np_image,
        cv2=cv2,
        np=np,
        regions=normalized_regions,
        target_language=target_language,
        translation_mode="provided",
    )
    return ImageWorkshopResult(
        image_data_url=_image_to_data_url(output),
        background_data_url=_image_to_data_url(background),
        regions=normalized_regions,
        engine=engine,
        warnings=list(warnings or []),
    )


def _image_to_data_url(image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _load_image_stack(image_bytes: bytes):
    try:
        from PIL import Image
    except Exception as exc:  # pragma: no cover - depends on deployment image deps
        raise RuntimeError("图片处理缺少 Pillow，请安装后端图片依赖。") from exc

    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on deployment image deps
        raise RuntimeError("图片修补缺少 OpenCV/Numpy，请安装后端图片依赖。") from exc

    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception as exc:
        raise ValueError("无法读取图片文件。") from exc

    return image, np.array(image), cv2, np


def _get_ocr_engine():
    global _OCR_ENGINE, _OCR_ENGINE_ERROR
    if _OCR_ENGINE is not None or _OCR_ENGINE_ERROR is not None:
        return _OCR_ENGINE, _OCR_ENGINE_ERROR

    with _OCR_LOCK:
        if _OCR_ENGINE is not None or _OCR_ENGINE_ERROR is not None:
            return _OCR_ENGINE, _OCR_ENGINE_ERROR
        try:
            from rapidocr_onnxruntime import RapidOCR  # type: ignore

            _OCR_ENGINE = RapidOCR()
        except Exception as exc:  # pragma: no cover - depends on optional OCR deps
            _OCR_ENGINE_ERROR = str(exc)
        return _OCR_ENGINE, _OCR_ENGINE_ERROR


def _detect_text_regions(np_image) -> Tuple[List[Dict[str, Any]], str, List[str]]:
    engine, engine_error = _get_ocr_engine()
    warnings: List[str] = []
    if engine is None:
        if engine_error:
            warnings.append(f"OCR 引擎不可用：{engine_error}")
        return [], "layout-fallback", warnings

    try:
        ocr_result = engine(np_image)
    except Exception as exc:  # pragma: no cover - depends on OCR runtime/model files
        warnings.append(f"OCR 执行失败：{exc}")
        return [], "rapidocr-error", warnings

    raw_rows = ocr_result[0] if isinstance(ocr_result, tuple) else ocr_result
    regions: List[Dict[str, Any]] = []
    height, width = np_image.shape[:2]

    for row in raw_rows or []:
        parsed = _parse_ocr_row(row)
        if not parsed:
            continue
        box, text, confidence = parsed
        text = text.strip()
        if confidence < 0.42 or not text:
            continue
        if not _contains_cjk(text):
            continue
        x, y, box_width, box_height = _box_to_rect(box, width, height)
        if box_width < 8 or box_height < 6:
            continue
        area_ratio = (box_width * box_height) / max(1, width * height)
        if area_ratio > 0.4:
            continue
        regions.append(
            {
                "x": x,
                "y": y,
                "width": box_width,
                "height": box_height,
                "text": text,
                "translatedText": "",
                "confidence": round(float(confidence), 3),
                "source": "ocr",
            }
        )

    return _merge_text_blocks(_merge_regions(regions, width, height), width, height), "rapidocr", warnings


def _parse_ocr_row(row: Any):
    if isinstance(row, dict):
        box = row.get("box") or row.get("points") or row.get("dt_boxes")
        text = row.get("text") or row.get("rec_text") or ""
        score = row.get("score") or row.get("confidence") or row.get("rec_score") or 0
        if box is not None:
            return box, str(text), float(score or 0)

    if isinstance(row, Sequence) and len(row) >= 3:
        return row[0], str(row[1]), float(row[2] or 0)
    return None


def _contains_cjk(text: str) -> bool:
    return any("\u3400" <= char <= "\u9fff" for char in text)


def _box_to_rect(box: Any, image_width: int, image_height: int) -> Tuple[int, int, int, int]:
    points = []
    for point in box:
        if isinstance(point, Sequence) and len(point) >= 2:
            points.append((float(point[0]), float(point[1])))

    if not points:
        return 0, 0, image_width, image_height

    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    x = int(max(0, min(xs)))
    y = int(max(0, min(ys)))
    right = int(min(image_width, max(xs)))
    bottom = int(min(image_height, max(ys)))
    pad = max(3, int(min(image_width, image_height) * 0.012))
    x = max(0, x - pad)
    y = max(0, y - pad)
    right = min(image_width, right + pad)
    bottom = min(image_height, bottom + pad)
    return x, y, max(1, right - x), max(1, bottom - y)


def _merge_regions(regions: List[Dict[str, Any]], image_width: int, image_height: int) -> List[Dict[str, Any]]:
    if len(regions) <= 1:
        return regions

    rows = sorted(regions, key=lambda item: (item["y"], item["x"]))
    merged: List[Dict[str, Any]] = []
    for region in rows:
        target = None
        for existing in merged:
            same_line = abs(_center_y(existing) - _center_y(region)) <= max(existing["height"], region["height"]) * 0.72
            close_x = region["x"] <= existing["x"] + existing["width"] + image_width * 0.035
            if same_line and close_x:
                target = existing
                break
        if target is None:
            merged.append(dict(region))
            continue

        right = max(target["x"] + target["width"], region["x"] + region["width"])
        bottom = max(target["y"] + target["height"], region["y"] + region["height"])
        target["x"] = min(target["x"], region["x"])
        target["y"] = min(target["y"], region["y"])
        target["width"] = min(image_width - target["x"], right - target["x"])
        target["height"] = min(image_height - target["y"], bottom - target["y"])
        target["text"] = " ".join(part for part in (target.get("text"), region.get("text")) if part)
        target["confidence"] = round(min(float(target.get("confidence", 1)), float(region.get("confidence", 1))), 3)

    return merged


def _merge_text_blocks(regions: List[Dict[str, Any]], image_width: int, image_height: int) -> List[Dict[str, Any]]:
    if len(regions) <= 1:
        return regions

    merged: List[Dict[str, Any]] = []
    for region in sorted(regions, key=lambda item: (item["y"], item["x"])):
        target = None
        for existing in merged:
            if _should_merge_block(existing, region, image_width, image_height):
                target = existing
                break
        if target is None:
            merged.append(dict(region))
        else:
            _absorb_region(target, region, image_width, image_height, separator="\n")
    return merged


def _should_merge_block(
    previous: Dict[str, Any],
    current: Dict[str, Any],
    image_width: int,
    image_height: int,
) -> bool:
    if "\n" in str(previous.get("text") or ""):
        return False

    previous_bottom = previous["y"] + previous["height"]
    vertical_gap = current["y"] - previous_bottom
    if vertical_gap < -min(previous["height"], current["height"]) * 0.25:
        return False
    if vertical_gap > min(previous["height"], current["height"]) * 0.55:
        return False
    if vertical_gap > image_height * 0.016:
        return False

    height_ratio = max(previous["height"], current["height"]) / max(1, min(previous["height"], current["height"]))
    if height_ratio > 1.55:
        return False

    overlap = _horizontal_overlap(previous, current)
    min_width = max(1, min(previous["width"], current["width"]))
    left_aligned = abs(previous["x"] - current["x"]) <= image_width * 0.022
    merged_height = max(previous["y"] + previous["height"], current["y"] + current["height"]) - min(previous["y"], current["y"])
    if merged_height > image_height * 0.13:
        return False
    return overlap / min_width >= 0.72 or left_aligned


def _absorb_region(
    target: Dict[str, Any],
    region: Dict[str, Any],
    image_width: int,
    image_height: int,
    *,
    separator: str = " ",
) -> None:
    right = max(target["x"] + target["width"], region["x"] + region["width"])
    bottom = max(target["y"] + target["height"], region["y"] + region["height"])
    target["x"] = min(target["x"], region["x"])
    target["y"] = min(target["y"], region["y"])
    target["width"] = min(image_width - target["x"], right - target["x"])
    target["height"] = min(image_height - target["y"], bottom - target["y"])
    target["text"] = separator.join(part for part in (target.get("text"), region.get("text")) if part)
    target["confidence"] = round(min(float(target.get("confidence", 1)), float(region.get("confidence", 1))), 3)


def _horizontal_overlap(first: Dict[str, Any], second: Dict[str, Any]) -> float:
    left = max(first["x"], second["x"])
    right = min(first["x"] + first["width"], second["x"] + second["width"])
    return max(0.0, float(right - left))


def _center_y(region: Dict[str, Any]) -> float:
    return float(region["y"]) + float(region["height"]) / 2


def _detect_layout_text_regions(np_image) -> List[Dict[str, Any]]:
    height, width = np_image.shape[:2]
    regions: List[Dict[str, Any]] = []
    top_height = max(1, int(height * 0.18))
    bottom_height = max(1, int(height * 0.19))

    top_score = _band_text_score(np_image[:top_height, :, :])
    bottom_score = _band_text_score(np_image[height - bottom_height :, :, :])

    if top_score > 0.035:
        regions.append(
            {
                "x": int(width * 0.05),
                "y": 0,
                "width": int(width * 0.9),
                "height": top_height,
                "text": "top",
                "translatedText": "",
                "confidence": 0,
                "source": "layout",
                "kind": "top",
            }
        )
    if bottom_score > 0.045:
        regions.append(
            {
                "x": int(width * 0.05),
                "y": height - bottom_height,
                "width": int(width * 0.9),
                "height": bottom_height,
                "text": "bottom",
                "translatedText": "",
                "confidence": 0,
                "source": "layout",
                "kind": "bottom",
            }
        )
    return regions


def _band_text_score(band) -> float:
    if band.size == 0:
        return 0
    try:
        import numpy as np  # type: ignore

        gray = (
            band[:, :, 0].astype("float32") * 0.299
            + band[:, :, 1].astype("float32") * 0.587
            + band[:, :, 2].astype("float32") * 0.114
        )
        dark_ratio = float(np.mean(gray < 88))
        edge_ratio = float(np.mean(np.abs(np.diff(gray, axis=1)) > 42))
        color_spread = band.max(axis=2).astype("float32") - band.min(axis=2).astype("float32")
        saturated_ratio = float(np.mean(color_spread > 62))
        return dark_ratio * 0.8 + edge_ratio * 0.9 + saturated_ratio * 0.25
    except Exception:
        return 0


def _inpaint_and_draw(
    *,
    pil_image,
    np_image,
    cv2,
    np,
    regions: List[Dict[str, Any]],
    target_language: str,
    translation_mode: str,
):
    from PIL import Image, ImageDraw

    height, width = np_image.shape[:2]
    mask = np.zeros((height, width), dtype=np.uint8)
    for region in regions:
        x, y, box_width, box_height = _region_bounds(region, width, height)
        pad = max(4, int(min(width, height) * 0.012))
        left = max(0, x - pad)
        top = max(0, y - pad)
        right = min(width, x + box_width + pad)
        bottom = min(height, y + box_height + pad)
        mask[top:bottom, left:right] = 255

    if regions:
        bgr = cv2.cvtColor(np_image, cv2.COLOR_RGB2BGR)
        repaired = cv2.inpaint(bgr, mask, 5, cv2.INPAINT_TELEA)
        background = Image.fromarray(cv2.cvtColor(repaired, cv2.COLOR_BGR2RGB))
    else:
        background = pil_image.copy()

    output = background.copy()
    draw = ImageDraw.Draw(output)
    for region in regions:
        translated = _translated_region_text(region, target_language, translation_mode)
        region["translatedText"] = translated
        x, y, box_width, box_height = _region_bounds(region, width, height)
        _draw_translated_text(draw, output, translated, x, y, box_width, box_height, region)
    return output, background


def _region_bounds(region: Dict[str, Any], image_width: int, image_height: int) -> Tuple[int, int, int, int]:
    x = int(max(0, min(image_width - 1, region.get("x", 0))))
    y = int(max(0, min(image_height - 1, region.get("y", 0))))
    width = int(max(1, min(image_width - x, region.get("width", image_width))))
    height = int(max(1, min(image_height - y, region.get("height", image_height))))
    return x, y, width, height


def _translated_region_text(region: Dict[str, Any], target_language: str, translation_mode: str = "product_short") -> str:
    source_text = str(region.get("text") or "")
    provided_translation = str(region.get("translatedText") or "").strip()
    if provided_translation:
        return provided_translation
    kind = str(region.get("kind") or "")
    normalized = _normalize_source_text(source_text)

    if kind in {"top", "bottom"}:
        return _layout_phrase(target_language, kind)

    if translation_mode == "direct":
        translated = _translate_text(source_text, target_language)
        return translated or normalized

    memory_key = _translation_memory_key(normalized)
    memory = TRANSLATION_MEMORY.get(memory_key, {})
    if target_language in memory:
        return memory[target_language]

    memory_translation = _translate_from_memory_segments(memory_key, target_language)
    if memory_translation:
        return memory_translation

    translated = _translate_text(source_text, target_language)
    if translated:
        return _shorten_product_translation(translated, target_language)

    if normalized:
        return normalized
    return _layout_phrase(target_language, "bottom")


def _shorten_product_translation(text: str, target_language: str) -> str:
    text = _normalize_source_text(text)
    if target_language != "ru":
        return text

    replacements = {
        "сопровождают вас, куда бы вы ни пошли": "всегда с вами",
        "куда бы вы ни пошли": "всегда с вами",
        "с индивидуальным заказом": "на заказ",
        "индивидуальному заказу": "на заказ",
        "профессиональная команда до полного результата": "профессиональная команда",
        "печати логотипа": "печать логотипа",
    }
    lowered = text
    for source, target in replacements.items():
        lowered = lowered.replace(source, target)
    if len(lowered) > 72:
        parts = [part.strip() for part in lowered.replace(" и ", "\n").split("\n") if part.strip()]
        lowered = "\n".join(parts[:3])
    return lowered


TRANSLATION_MEMORY: Dict[str, Dict[str, str]] = {
    "清新随行香气相伴": {
        "ru": "Свежесть и аромат всегда с вами",
        "en": "Fresh fragrance wherever you go",
        "es": "Frescura y aroma siempre contigo",
        "de": "Frische und Duft immer dabei",
    },
    "纸质香片定制": {
        "ru": "Индивидуальные бумажные ароматизаторы",
        "en": "Custom paper air fresheners",
        "es": "Ambientadores de papel personalizados",
        "de": "Individuelle Papier-Lufterfrischer",
    },
    "支持LOGO印刷自由定制设计": {
        "ru": "Печать логотипа и индивидуальный дизайн",
        "en": "Logo printing and custom design supported",
        "es": "Impresión de logotipo y diseño personalizado",
        "de": "Logo-Druck und individuelles Design",
    },
    "支持LOGO印刷": {
        "ru": "Поддержка печати логотипа",
        "en": "Logo printing supported",
        "es": "Impresión de logotipo disponible",
        "de": "Logo-Druck möglich",
    },
    "自由定制设计": {
        "ru": "Индивидуальный дизайн",
        "en": "Custom design",
        "es": "Diseño personalizado",
        "de": "Individuelles Design",
    },
    "品牌展示提升格调": {
        "ru": "Презентация бренда и премиальный стиль",
        "en": "Brand display with a premium feel",
        "es": "Presentación de marca con estilo premium",
        "de": "Markenpräsentation mit hochwertigem Stil",
    },
    "独立包装": {
        "ru": "Индивидуальная упаковка",
        "en": "Individual packaging",
        "es": "Embalaje individual",
        "de": "Einzelverpackung",
    },
    "干净卫生携带方便": {
        "ru": "Чисто, гигиенично и удобно носить",
        "en": "Clean, hygienic, and easy to carry",
        "es": "Limpio, higiénico y fácil de llevar",
        "de": "Sauber, hygienisch und leicht zu tragen",
    },
    "免费设计": {
        "ru": "Бесплатный дизайн",
        "en": "Free design",
        "es": "Diseño gratuito",
        "de": "Kostenloses Design",
    },
    "专业团队满意为止": {
        "ru": "Профессиональная команда до полного результата",
        "en": "Professional team until you are satisfied",
        "es": "Equipo profesional hasta su satisfacción",
        "de": "Professionelles Team bis zur Zufriedenheit",
    },
    "支持定制": {
        "ru": "Индивидуальный заказ",
        "en": "Custom orders supported",
        "es": "Pedidos personalizados",
        "de": "Individuelle Bestellungen",
    },
    "大功率高压洗车机": {
        "ru": "Мощная мойка автомобилей под высоким давлением",
        "en": "High power pressure washer",
        "es": "Lavadora de alta presión de gran potencia",
        "de": "Leistungsstarker Hochdruckreiniger",
    },
    "厂家直营支持定制": {
        "ru": "Поддержка прямых продаж с фабрики по индивидуальному заказу",
        "en": "Factory direct sales and custom orders supported",
        "es": "Venta directa de fábrica y pedidos personalizados",
        "de": "Direktverkauf ab Werk und individuelle Bestellungen",
    },
}


def _layout_phrase(target_language: str, kind: str) -> str:
    phrases = {
        "ru": {
            "top": "Мощная мойка автомобилей под высоким давлением",
            "bottom": "Поддержка прямых продаж с фабрики по индивидуальному заказу",
        },
        "en": {
            "top": "High power pressure washer",
            "bottom": "Factory direct sales and custom orders supported",
        },
        "es": {
            "top": "Lavadora de alta presión de gran potencia",
            "bottom": "Venta directa de fábrica y pedidos personalizados",
        },
        "de": {
            "top": "Leistungsstarker Hochdruckreiniger",
            "bottom": "Direktverkauf ab Werk und individuelle Bestellungen",
        },
    }
    return phrases.get(target_language, phrases["ru"]).get(kind, phrases["ru"]["bottom"])


def _normalize_source_text(text: str) -> str:
    return " ".join(text.strip().split())


def _translation_memory_key(text: str) -> str:
    ignored = "，。,.!！?？、|/·•・-—_：:；;（）()[]【】"
    return "".join(char for char in text if not char.isspace() and char not in ignored)


def _translate_from_memory_segments(memory_key: str, target_language: str) -> str:
    if not memory_key:
        return ""

    matches: List[Tuple[int, int, str]] = []
    for source_key, translations in sorted(TRANSLATION_MEMORY.items(), key=lambda item: len(item[0]), reverse=True):
        translated = translations.get(target_language)
        if not translated:
            continue
        start = memory_key.find(source_key)
        if start < 0:
            continue
        end = start + len(source_key)
        if any(not (end <= used_start or start >= used_end) for used_start, used_end, _ in matches):
            continue
        matches.append((start, end, translated))

    if not matches:
        return ""

    matches.sort(key=lambda item: item[0])
    covered = sum(end - start for start, end, _ in matches)
    if covered / max(1, len(memory_key)) < 0.45:
        return ""
    return "\n".join(translated for _, _, translated in matches)


@lru_cache(maxsize=512)
def _translate_text(text: str, target_language: str) -> str:
    text = _normalize_source_text(text)
    if not text:
        return ""
    try:
        from deep_translator import GoogleTranslator  # type: ignore

        return GoogleTranslator(source="auto", target=target_language).translate(text) or ""
    except Exception:
        return ""


def _draw_translated_text(draw, image, text: str, x: int, y: int, width: int, height: int, region: Dict[str, Any]) -> None:
    from PIL import ImageDraw

    if not text.strip():
        return

    layout_x, layout_y, layout_width, layout_height = _text_layout_bounds(image, x, y, width, height)
    max_lines = _max_lines_for_region(image, layout_height)
    font = _fit_font(text, layout_width, layout_height, bold=True, max_lines=max_lines)
    lines = _wrap_text(draw, text, font, layout_width * 0.96, max_lines=max_lines)
    if not lines:
        return

    text_box = _multiline_bbox(draw, lines, font)
    block_width = text_box[2] - text_box[0]
    block_height = text_box[3] - text_box[1]
    start_x = layout_x + (layout_width - block_width) / 2
    start_y = layout_y + (layout_height - block_height) / 2

    background = _sample_region_color(image, layout_x, layout_y, layout_width, layout_height)
    fill = (236, 191, 105) if _luma(background) < 105 and layout_y > image.height * 0.55 else (32, 38, 48)
    if _luma(background) < 70:
        shadow_fill = (0, 0, 0)
        for dx, dy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
            _draw_lines(draw, lines, font, start_x + dx, start_y + dy, shadow_fill)
    else:
        shadow_fill = (255, 255, 255)
        for dx, dy in ((1, 1),):
            _draw_lines(draw, lines, font, start_x + dx, start_y + dy, shadow_fill)
    _draw_lines(draw, lines, font, start_x, start_y, fill)


def _max_lines_for_region(image, height: int) -> int:
    ratio = height / max(1, image.height)
    if ratio < 0.045:
        return 2
    if ratio < 0.09:
        return 3
    return 4


def _text_layout_bounds(image, x: int, y: int, width: int, height: int) -> Tuple[int, int, int, int]:
    if width > image.width * 0.42 and y + height > image.height * 0.82:
        layout_y = max(0, y - int(image.height * 0.05))
        return 0, layout_y, image.width, image.height - layout_y

    return x, y, width, height


def _fit_font(text: str, width: int, height: int, *, bold: bool, max_lines: int):
    from PIL import Image, ImageDraw, ImageFont

    max_size = max(8, int(min(height * 0.68, width * 0.115)))
    min_size = 7
    probe = Image.new("RGB", (max(1, width), max(1, height)))
    draw = ImageDraw.Draw(probe)
    for size in range(max_size, min_size - 1, -1):
        font = _load_font(size, bold=bold)
        lines = _wrap_text(draw, text, font, width * 0.96, max_lines=max_lines)
        bbox = _multiline_bbox(draw, lines, font)
        if bbox[2] - bbox[0] <= width * 0.98 and bbox[3] - bbox[1] <= height * 0.88:
            return font
    return _load_font(min_size, bold=bold)


def _load_font(size: int, *, bold: bool):
    from PIL import ImageFont

    candidates = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc" if bold else "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc" if bold else "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size=size)
        except Exception:
            continue
    return ImageFont.load_default()


def _wrap_text(draw, text: str, font, max_width: float, *, max_lines: int = 4) -> List[str]:
    paragraphs = [part.strip() for part in text.splitlines() if part.strip()]
    if not paragraphs:
        paragraphs = [text.strip()]

    lines: List[str] = []
    for paragraph in paragraphs:
        words = paragraph.split()
        if len(words) <= 1:
            lines.append(paragraph)
            continue

        current = ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if _text_width(draw, candidate, font) <= max_width or not current:
                current = candidate
            else:
                lines.append(current)
                current = word
        if current:
            lines.append(current)

    if len(lines) <= max_lines:
        return lines

    clipped = lines[:max_lines]
    clipped[-1] = _ellipsize_to_width(draw, clipped[-1], font, max_width)
    return clipped


def _ellipsize_to_width(draw, text: str, font, max_width: float) -> str:
    suffix = "..."
    if _text_width(draw, text, font) <= max_width:
        return text
    candidate = text
    while candidate and _text_width(draw, f"{candidate}{suffix}", font) > max_width:
        candidate = candidate[:-1].rstrip()
    return f"{candidate}{suffix}" if candidate else suffix


def _text_width(draw, text: str, font) -> float:
    box = draw.textbbox((0, 0), text, font=font)
    return float(box[2] - box[0])


def _multiline_bbox(draw, lines: List[str], font) -> Tuple[int, int, int, int]:
    if not lines:
        return 0, 0, 0, 0
    widths = []
    heights = []
    for line in lines:
        box = draw.textbbox((0, 0), line, font=font)
        widths.append(box[2] - box[0])
        heights.append(box[3] - box[1])
    line_gap = max(1, int(max(heights) * 0.25)) if heights else 1
    return 0, 0, max(widths or [0]), sum(heights) + line_gap * max(0, len(lines) - 1)


def _draw_lines(draw, lines: List[str], font, x: float, y: float, fill) -> None:
    cursor_y = y
    for line in lines:
        box = draw.textbbox((0, 0), line, font=font)
        draw.text((x, cursor_y), line, font=font, fill=fill)
        cursor_y += (box[3] - box[1]) * 1.2


def _sample_region_color(image, x: int, y: int, width: int, height: int) -> Tuple[int, int, int]:
    crop = image.crop((x, y, min(image.width, x + width), min(image.height, y + height)))
    if crop.width <= 0 or crop.height <= 0:
        return (255, 255, 255)
    thumb = crop.resize((1, 1))
    return thumb.getpixel((0, 0))


def _luma(color: Tuple[int, int, int]) -> float:
    return color[0] * 0.299 + color[1] * 0.587 + color[2] * 0.114
