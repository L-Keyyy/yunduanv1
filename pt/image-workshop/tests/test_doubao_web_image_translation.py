import unittest

from backend.doubao_web_image_translation import (
    DoubaoWebImageTranslationError,
    _extract_json_object,
    _normalize_regions,
)


class DoubaoWebImageTranslationTests(unittest.TestCase):
    def test_extracts_json_from_markdown_fence(self):
        payload = _extract_json_object(
            '```json\n{"detected_source_language":"en","regions":[]}\n```'
        )
        self.assertEqual(payload["detected_source_language"], "en")

    def test_normalizes_1000_coordinate_regions(self):
        regions = _normalize_regions(
            {
                "coordinate_space": "normalized_1000",
                "regions": [
                    {
                        "bbox": [100, 200, 600, 500],
                        "text": "HELLO",
                        "translated_text": "HALLO",
                    }
                ],
            },
            800,
            400,
        )

        self.assertEqual(
            regions,
            [
                {
                    "x": 80,
                    "y": 80,
                    "width": 400,
                    "height": 120,
                    "text": "HELLO",
                    "translatedText": "HALLO",
                    "confidence": 0.9,
                    "source": "doubao-web",
                }
            ],
        )

    def test_rejects_response_without_json(self):
        with self.assertRaises(DoubaoWebImageTranslationError):
            _extract_json_object("没有结构化结果")


if __name__ == "__main__":
    unittest.main()
