import os
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SQLITE_PATH = os.path.join(BASE_DIR, "ozon.db").replace("\\", "/")
DEFAULT_APP_ENV = os.getenv("APP_ENV", "development")


def _env_bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    PROJECT_NAME: str = "欧卖通管理服务"
    API_V1_STR: str = "/api/v1"
    APP_ENV: str = DEFAULT_APP_ENV
    API_HOST: str = os.getenv("API_HOST", "0.0.0.0")
    API_PORT: int = int(os.getenv("API_PORT", "8000"))
    AUTO_CREATE_SCHEMA: bool = _env_bool(
        "AUTO_CREATE_SCHEMA",
        DEFAULT_APP_ENV == "development",
    )
    ENABLE_LOCAL_BOOTSTRAP: bool = _env_bool(
        "ENABLE_LOCAL_BOOTSTRAP",
        DEFAULT_APP_ENV == "development",
    )

    OZON_CLIENT_ID: str = os.getenv("OZON_CLIENT_ID", "")
    OZON_API_KEY: str = os.getenv("OZON_API_KEY", "")

    DATABASE_URL: str = os.getenv("DATABASE_URL", f"sqlite:///{DEFAULT_SQLITE_PATH}")

    REDIS_URL: str = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    CELERY_BROKER_URL: str = REDIS_URL
    CELERY_RESULT_BACKEND: str = REDIS_URL
    UPLOAD_MAX_ACTIVE_STORES_PER_TENANT: int = int(
        os.getenv("UPLOAD_MAX_ACTIVE_STORES_PER_TENANT", "2")
    )
    UPLOAD_MAX_GLOBAL_ACTIVE_STORES: int = int(
        os.getenv("UPLOAD_MAX_GLOBAL_ACTIVE_STORES", "48")
    )
    UPLOAD_MAX_ATTEMPTS: int = int(os.getenv("UPLOAD_MAX_ATTEMPTS", "3"))
    UPLOAD_TIMEOUT_SECONDS: int = int(os.getenv("UPLOAD_TIMEOUT_SECONDS", "900"))
    UPLOAD_RESULT_POLL_INTERVAL_SECONDS: int = int(
        os.getenv("UPLOAD_RESULT_POLL_INTERVAL_SECONDS", "30")
    )
    UPLOAD_INITIAL_RESULT_POLL_DELAY_SECONDS: int = int(
        os.getenv("UPLOAD_INITIAL_RESULT_POLL_DELAY_SECONDS", "10")
    )
    CLOUD_FOLLOW_FRONTEND_FETCH_CONCURRENCY: int = int(
        os.getenv("CLOUD_FOLLOW_FRONTEND_FETCH_CONCURRENCY", "4")
    )
    UPLOAD_BUILD_ITEM_CONCURRENCY: int = int(
        os.getenv("UPLOAD_BUILD_ITEM_CONCURRENCY", "4")
    )
    MANUAL_ORDER_SYNC_LIMIT: int = int(os.getenv("MANUAL_ORDER_SYNC_LIMIT", "5"))
    MANUAL_ORDER_SYNC_WINDOW_SECONDS: int = int(
        os.getenv("MANUAL_ORDER_SYNC_WINDOW_SECONDS", "1800")
    )
    ORDER_SYNC_INTERVAL_MINUTES: int = int(
        os.getenv("ORDER_SYNC_INTERVAL_MINUTES", "120")
    )
    SELLER_ANALYTICS_CACHE_TTL_SECONDS: int = int(
        os.getenv("SELLER_ANALYTICS_CACHE_TTL_SECONDS", str(3 * 24 * 60 * 60))
    )

    SECRET_KEY: str = os.getenv("SECRET_KEY", "your-super-secret-key-here")
    FIELD_ENCRYPTION_KEY: str = os.getenv("FIELD_ENCRYPTION_KEY", "")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7
    ADMIN_USERNAME: str = os.getenv("ADMIN_USERNAME", "admin")
    ADMIN_PASSWORD: str = os.getenv("ADMIN_PASSWORD", "")
    CHROME_DEVTOOLS_BASE: str = os.getenv(
        "CHROME_DEVTOOLS_BASE", "http://127.0.0.1:9222"
    )
    CORS_ORIGINS: str = os.getenv(
        "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
    )

    @property
    def chrome_devtools_base(self) -> str:
        return self.CHROME_DEVTOOLS_BASE.rstrip("/")

    @property
    def cors_origins_list(self) -> List[str]:
        raw_value = self.CORS_ORIGINS.strip()
        if not raw_value:
            return []
        if raw_value == "*":
            return ["*"]
        return [item.strip() for item in raw_value.split(",") if item.strip()]

    @property
    def is_development(self) -> bool:
        return self.APP_ENV == "development"

    @property
    def is_production(self) -> bool:
        return self.APP_ENV in {"production", "prod"}


settings = Settings()
