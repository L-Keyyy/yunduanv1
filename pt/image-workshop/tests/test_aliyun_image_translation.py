import asyncio
import json
import unittest
from types import SimpleNamespace

from Tea.exceptions import TeaException

from backend.aliyun_image_translation import (
    ALIYUN_MAX_IMAGE_BYTES,
    AliyunCredentialError,
    AliyunImageTranslationError,
    AliyunImageTranslationService,
)


class FakeAliClient:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    async def translate_image_with_options_async(self, request, runtime):
        self.calls.append((request, runtime))
        if self.error:
            raise self.error
        return self.response


class FakeDownloadResponse:
    def __init__(self, content=b"\x89PNG\r\n\x1a\ntranslated"):
        self.content = content
        self.headers = {"content-type": "image/png"}

    def raise_for_status(self):
        return None


class FakeDownloadClient:
    def __init__(self, calls, **kwargs):
        self.calls = calls
        self.options = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    async def get(self, url):
        self.calls.append(url)
        return FakeDownloadResponse()


def success_response(code=200, message="OK", final_url="https://example.com/final.png"):
    data = SimpleNamespace(
        final_image_url=final_url,
        in_painting_url="https://example.com/background.png",
        template_json="{}",
    )
    body = SimpleNamespace(code=code, message=message, data=data)
    return SimpleNamespace(body=body, status_code=200)


class AliyunImageTranslationServiceTests(unittest.TestCase):
    def service(self, ali_client):
        credentials = []
        downloads = []

        def client_factory(access_key_id, access_key_secret, region_id):
            credentials.append((access_key_id, access_key_secret, region_id))
            return ali_client

        def download_factory(**kwargs):
            return FakeDownloadClient(downloads, **kwargs)

        return (
            AliyunImageTranslationService(
                client_factory=client_factory,
                download_client_factory=download_factory,
            ),
            credentials,
            downloads,
        )

    def test_translates_ecommerce_image_and_downloads_result(self):
        ali_client = FakeAliClient(response=success_response())
        service, credentials, downloads = self.service(ali_client)

        result = asyncio.run(
            service.translate(
                b"source-image",
                access_key_id="access-id",
                access_key_secret="access-secret",
                target_language="ru",
                field="e-commerce",
            )
        )

        self.assertTrue(result.image_data_url.startswith("data:image/png;base64,"))
        self.assertEqual(credentials, [("access-id", "access-secret", "cn-hangzhou")])
        self.assertEqual(downloads, ["https://example.com/final.png"])
        request, runtime = ali_client.calls[0]
        self.assertEqual(request.source_language, "zh")
        self.assertEqual(request.target_language, "ru")
        self.assertEqual(request.field, "e-commerce")
        self.assertEqual(json.loads(request.ext)["ignoreEntityRecognize"], "true")
        self.assertEqual(runtime.max_attempts, 2)

    def test_maps_invalid_access_key_to_credential_error(self):
        error = TeaException(
            {
                "code": "InvalidAccessKeyId.NotFound",
                "message": "invalid access key",
                "data": {"statusCode": 401},
            }
        )
        service, _, _ = self.service(FakeAliClient(error=error))

        with self.assertRaisesRegex(AliyunCredentialError, "InvalidAccessKeyId"):
            asyncio.run(
                service.translate(
                    b"source-image",
                    access_key_id="bad-id",
                    access_key_secret="bad-secret",
                )
            )

    def test_surfaces_api_body_error(self):
        service, _, _ = self.service(
            FakeAliClient(response=success_response(code=500, message="EraseError"))
        )

        with self.assertRaisesRegex(AliyunImageTranslationError, "EraseError"):
            asyncio.run(
                service.translate(
                    b"source-image",
                    access_key_id="access-id",
                    access_key_secret="access-secret",
                )
            )

    def test_enforces_image_size_limit(self):
        ali_client = FakeAliClient(response=success_response())
        service, _, _ = self.service(ali_client)

        with self.assertRaisesRegex(ValueError, "10MB"):
            asyncio.run(
                service.translate(
                    b"x" * (ALIYUN_MAX_IMAGE_BYTES + 1),
                    access_key_id="access-id",
                    access_key_secret="access-secret",
                )
            )
        self.assertEqual(ali_client.calls, [])


if __name__ == "__main__":
    unittest.main()
