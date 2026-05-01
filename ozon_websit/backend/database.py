from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import sessionmaker

from config import settings

connect_args = {}
engine_kwargs = {}

if "sqlite" in settings.DATABASE_URL:
    connect_args = {"check_same_thread": False}
else:
    engine_kwargs = {
        "pool_pre_ping": True,
        "pool_recycle": 300,
    }

engine = create_engine(
    settings.DATABASE_URL,
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
