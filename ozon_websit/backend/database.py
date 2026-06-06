from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import sessionmaker

from config import settings

connect_args = {}
engine_kwargs = {}
database_url = str(settings.DATABASE_URL or "").strip()
database_url_lower = database_url.lower()
is_sqlite_url = database_url_lower.startswith("sqlite")

if settings.is_production:
    if is_sqlite_url:
        raise RuntimeError(
            "APP_ENV=production requires a PostgreSQL DATABASE_URL; SQLite is development-only."
        )
    if not database_url_lower.startswith("postgresql"):
        raise RuntimeError("APP_ENV=production requires a PostgreSQL DATABASE_URL.")

if is_sqlite_url:
    connect_args = {"check_same_thread": False}
else:
    engine_kwargs = {
        "pool_pre_ping": True,
        "pool_recycle": 300,
    }

engine = create_engine(
    database_url,
    connect_args=connect_args,
    **engine_kwargs,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
