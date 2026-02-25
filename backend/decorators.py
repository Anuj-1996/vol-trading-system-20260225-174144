from __future__ import annotations

import time
from functools import wraps
from typing import Any, Callable, TypeVar, cast

from .logger import get_logger


FuncType = TypeVar("FuncType", bound=Callable[..., Any])


def log_execution_time(func: FuncType) -> FuncType:
    logger = get_logger(func.__module__)

    @wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        logger.info("START | function=%s", func.__qualname__)
        start_time = time.perf_counter()
        try:
            result = func(*args, **kwargs)
            return result
        except Exception:
            logger.exception("ERROR | function=%s", func.__qualname__)
            raise
        finally:
            elapsed = time.perf_counter() - start_time
            logger.info("END | function=%s | elapsed_seconds=%.6f", func.__qualname__, elapsed)

    return cast(FuncType, wrapper)
