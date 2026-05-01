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

    SECRET_KEY: str = os.getenv("SECRET_KEY", "your-super-secret-key-here")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7
    ADMIN_USERNAME: str = os.getenv("ADMIN_USERNAME", "admin")
    ADMIN_PASSWORD: str = os.getenv("ADMIN_PASSWORD", "ChangeMe123!")
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


settings = Settings()
