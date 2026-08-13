from pathlib import Path
import unittest


class DashboardLocalSummaryTests(unittest.TestCase):
    def test_summary_does_not_wait_for_ozon(self) -> None:
        source = Path(__file__).with_name("main.py").read_text()
        summary_source = source.split("async def get_dashboard_summary", 1)[1].split(
            "@app.get(f\"{settings.API_V1_STR}/dashboard/trends\")", 1
        )[0]

        self.assertIn("total_products = products_query.count()", summary_source)
        self.assertNotIn("get_product_total_count", summary_source)


if __name__ == "__main__":
    unittest.main()
