import httpx
import asyncio

async def test():
    url = "https://api-seller.ozon.ru/v4/product/info/limit"
    headers = {
        "Client-Id": "123",
        "Api-Key": "abc",
        "Content-Type": "application/json"
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, headers=headers, json={})
        print(resp.status_code)
        print(resp.text)

asyncio.run(test())
