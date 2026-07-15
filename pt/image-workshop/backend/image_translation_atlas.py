import base64
import io
from dataclasses import dataclass
from typing import List, Sequence, Tuple

from PIL import Image, ImageOps


@dataclass
class AtlasInput:
    image_id: str
    name: str
    image_bytes: bytes


@dataclass
class AtlasPlacement:
    image_id: str
    name: str
    x: int
    y: int
    width: int
    height: int
    original_width: int
    original_height: int


@dataclass
class AtlasBatch:
    index: int
    width: int
    height: int
    image_bytes: bytes
    placements: List[AtlasPlacement]


@dataclass
class AtlasCrop:
    image_id: str
    name: str
    image_bytes: bytes
    width: int
    height: int
    atlas_index: int


def build_atlas_batches(
    inputs: Sequence[AtlasInput],
    *,
    max_width: int = 4096,
    max_height: int = 4096,
    margin: int = 32,
    gutter: int = 48,
) -> List[AtlasBatch]:
    if not inputs:
        return []
    if max_width < 256 or max_height < 256:
        raise ValueError("图集尺寸过小")

    prepared = [_prepare_input(item, max_width, max_height, margin) for item in inputs]
    batches: List[AtlasBatch] = []
    current: List[Tuple[AtlasInput, Image.Image, AtlasPlacement]] = []
    cursor_x = margin
    cursor_y = margin
    row_height = 0

    def finish_current() -> None:
        nonlocal current, cursor_x, cursor_y, row_height
        if not current:
            return
        batches.append(_render_batch(len(batches), current, margin))
        current = []
        cursor_x = margin
        cursor_y = margin
        row_height = 0

    for source, image, original_width, original_height in prepared:
        width, height = image.size
        if cursor_x + width + margin > max_width and cursor_x > margin:
            cursor_x = margin
            cursor_y += row_height + gutter
            row_height = 0

        if cursor_y + height + margin > max_height and current:
            finish_current()

        if cursor_y + height + margin > max_height:
            raise ValueError(f"图片 {source.name} 超出图集尺寸")

        placement = AtlasPlacement(
            image_id=source.image_id,
            name=source.name,
            x=cursor_x,
            y=cursor_y,
            width=width,
            height=height,
            original_width=original_width,
            original_height=original_height,
        )
        current.append((source, image, placement))
        cursor_x += width + gutter
        row_height = max(row_height, height)

    finish_current()
    return batches


def crop_translated_atlas(
    translated_atlas_bytes: bytes,
    batch: AtlasBatch,
) -> List[AtlasCrop]:
    with Image.open(io.BytesIO(translated_atlas_bytes)) as loaded:
        translated = ImageOps.exif_transpose(loaded).convert("RGB")

    scale_x = translated.width / batch.width
    scale_y = translated.height / batch.height
    crops: List[AtlasCrop] = []
    for placement in batch.placements:
        left = round(placement.x * scale_x)
        top = round(placement.y * scale_y)
        right = round((placement.x + placement.width) * scale_x)
        bottom = round((placement.y + placement.height) * scale_y)
        cropped = translated.crop((left, top, right, bottom))
        if cropped.size != (placement.original_width, placement.original_height):
            cropped = cropped.resize(
                (placement.original_width, placement.original_height),
                Image.Resampling.LANCZOS,
            )
        output = io.BytesIO()
        cropped.save(output, format="PNG", optimize=True)
        crops.append(
            AtlasCrop(
                image_id=placement.image_id,
                name=placement.name,
                image_bytes=output.getvalue(),
                width=placement.original_width,
                height=placement.original_height,
                atlas_index=batch.index,
            )
        )
    return crops


def data_url_bytes(value: str) -> bytes:
    comma_index = str(value or "").find(",")
    if comma_index < 0:
        raise ValueError("翻译图集 dataURL 格式无效")
    return base64.b64decode(value[comma_index + 1 :], validate=True)


def png_data_url(image_bytes: bytes) -> str:
    return f"data:image/png;base64,{base64.b64encode(image_bytes).decode('ascii')}"


def _prepare_input(
    source: AtlasInput,
    max_width: int,
    max_height: int,
    margin: int,
):
    if not source.image_bytes:
        raise ValueError(f"图片 {source.name} 内容为空")
    try:
        with Image.open(io.BytesIO(source.image_bytes)) as loaded:
            image = ImageOps.exif_transpose(loaded).convert("RGBA")
    except Exception as exc:
        raise ValueError(f"图片 {source.name} 读取失败") from exc

    original_width, original_height = image.size
    available_width = max_width - margin * 2
    available_height = max_height - margin * 2
    scale = min(
        1.0,
        available_width / max(original_width, 1),
        available_height / max(original_height, 1),
    )
    if scale < 1.0:
        image = image.resize(
            (
                max(1, round(original_width * scale)),
                max(1, round(original_height * scale)),
            ),
            Image.Resampling.LANCZOS,
        )

    flattened = Image.new("RGB", image.size, "white")
    flattened.paste(image, mask=image.getchannel("A"))
    return source, flattened, original_width, original_height


def _render_batch(
    index: int,
    entries: Sequence[Tuple[AtlasInput, Image.Image, AtlasPlacement]],
    margin: int,
) -> AtlasBatch:
    width = max(placement.x + placement.width for _, _, placement in entries) + margin
    height = max(placement.y + placement.height for _, _, placement in entries) + margin
    atlas = Image.new("RGB", (width, height), "white")
    placements: List[AtlasPlacement] = []
    for _, image, placement in entries:
        atlas.paste(image, (placement.x, placement.y))
        placements.append(placement)
    output = io.BytesIO()
    atlas.save(output, format="PNG", optimize=True)
    return AtlasBatch(
        index=index,
        width=width,
        height=height,
        image_bytes=output.getvalue(),
        placements=placements,
    )
