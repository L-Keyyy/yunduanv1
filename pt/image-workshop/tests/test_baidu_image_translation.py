import asyncio
import base64
import unittest

from backend.baidu_image_translation import (
    BAIDU_IMAGE_TRANSLATE_URL,
    BAIDU_MAX_IMAGE_BYTES,
    BaiduCredentialError,
    BaiduImageTranslationError,
    BaiduImageTranslationService,
)


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class FakeClient:
    def __init__(self, responses, calls, **kwargs):
        self.responses = responses
        self.calls = calls
        self.options = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs, self.options))
        return self.responses.pop(0)


def service_with_responses(responses):
    calls = []

    def factory(**kwargs):
        return FakeClient(responses, calls, **kwargs)

    return BaiduImageTranslationService(client_factory=factory), calls


class BaiduImageTranslationServiceTests(unittest.TestCase):
    def test_translates_with_bearer_token_and_high_precision(self):
        png_bytes = b"\x89PNG\r\n\x1a\nmock-image"
        pasted = base64.b64encode(png_bytes).decode("ascii")
        responses = [
            FakeResponse(
                200,
                {
                    "from": "zh",
                    "to": "ru",
                    "src": "原文",
                    "dst": "Перевод",
                    "paste_img": pasted,
                    "contents": [{"src": "原文", "dst": "Перевод"}],
                },
            ),
            FakeResponse(
                200,
                {
                    "from": "zh",
                    "to": "ru",
                    "paste_img": pasted,
                    "contents": [],
                },
            ),
        ]
        service, calls = service_with_responses(responses)

        async def run_test():
            first = await service.translate(
                b"source-image",
                app_id="app-id",
                api_key="api-key",
                target_language="ru",
            )
            second = await service.translate(
                b"source-image-2",
                app_id="app-id",
                api_key="api-key",
                target_language="ru",
            )
            return first, second

        first, second = asyncio.run(run_test())

        self.assertTrue(first.image_data_url.startswith("data:image/png;base64,"))
        self.assertEqual(first.translated_text, "Перевод")
        self.assertTrue(second.image_data_url.startswith("data:image/png;base64,"))
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][0], BAIDU_IMAGE_TRANSLATE_URL)
        self.assertEqual(calls[0][1]["headers"]["Authorization"], "Bearer api-key")
        self.assertEqual(calls[0][1]["json"]["paste"], 1)
        self.assertEqual(calls[0][1]["json"]["view_type"], 1)
        self.assertEqual(calls[0][1]["json"]["model_type"], "nmt")

    def test_rejects_invalid_credentials(self):
        service, _ = service_with_responses(
            [FakeResponse(401, {"error": "invalid_client", "error_description": "bad key"})]
        )

        with self.assertRaisesRegex(BaiduCredentialError, "bad key"):
            asyncio.run(
                service.check_credentials(
                    app_id="app-id",
                    api_key="bad-key",
                )
            )

    def test_surfaces_baidu_api_error(self):
        service, _ = service_with_responses(
            [
                FakeResponse(200, {"error_code": 55006, "error_msg": "service not enabled"}),
            ]
        )

        with self.assertRaisesRegex(BaiduImageTranslationError, "55006"):
            asyncio.run(
                service.translate(
                    b"source-image",
                    app_id="app-id",
                    api_key="api-key",
                )
            )

    def test_enforces_baidu_image_size_limit(self):
        service, calls = service_with_responses([])

        with self.assertRaisesRegex(ValueError, "5MB"):
            asyncio.run(
                service.translate(
                    b"x" * (BAIDU_MAX_IMAGE_BYTES + 1),
                    app_id="app-id",
                    api_key="api-key",
                )
            )
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
