import io
import unittest

from PIL import Image

from backend.image_translation_atlas import (
    AtlasInput,
    build_atlas_batches,
    crop_translated_atlas,
)


def image_bytes(color, size=(120, 80)):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format="PNG")
    return output.getvalue()


class ImageTranslationAtlasTests(unittest.TestCase):
    def test_builds_atlas_and_preserves_mapping(self):
        batches = build_atlas_batches(
            [
                AtlasInput("a", "a.png", image_bytes("red")),
                AtlasInput("b", "b.png", image_bytes("blue")),
            ],
            max_width=512,
            max_height=512,
            margin=16,
            gutter=24,
        )

        self.assertEqual(len(batches), 1)
        self.assertEqual([item.image_id for item in batches[0].placements], ["a", "b"])
        self.assertGreater(batches[0].width, 240)

    def test_crops_translated_atlas_back_to_original_images(self):
        batch = build_atlas_batches(
            [
                AtlasInput("a", "a.png", image_bytes("red", (120, 80))),
                AtlasInput("b", "b.png", image_bytes("blue", (90, 110))),
            ],
            max_width=512,
            max_height=512,
            margin=16,
            gutter=24,
        )[0]

        crops = crop_translated_atlas(batch.image_bytes, batch)
        self.assertEqual([(crop.image_id, crop.width, crop.height) for crop in crops], [
            ("a", 120, 80),
            ("b", 90, 110),
        ])
        with Image.open(io.BytesIO(crops[0].image_bytes)) as first:
            self.assertEqual(first.getpixel((20, 20)), (255, 0, 0))
        with Image.open(io.BytesIO(crops[1].image_bytes)) as second:
            self.assertEqual(second.getpixel((20, 20)), (0, 0, 255))

    def test_splits_images_into_multiple_atlases(self):
        batches = build_atlas_batches(
            [
                AtlasInput(str(index), f"{index}.png", image_bytes("white", (180, 180)))
                for index in range(5)
            ],
            max_width=420,
            max_height=420,
            margin=20,
            gutter=20,
        )
        self.assertEqual(len(batches), 2)
        self.assertEqual(sum(len(batch.placements) for batch in batches), 5)


if __name__ == "__main__":
    unittest.main()
