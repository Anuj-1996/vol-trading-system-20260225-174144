from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, Dict
from uuid import uuid4

from ..logger import get_logger


@dataclass(frozen=True)
class JobStatus:
    job_id: str
    state: str
    result: Dict[str, Any] | None
    error: str | None


class AsyncJobService:
    def __init__(self, max_workers: int = 2) -> None:
        self._logger = get_logger(self.__class__.__name__)
        self._executor = ThreadPoolExecutor(max_workers=max_workers)
        self._jobs: Dict[str, Future[Dict[str, Any]]] = {}
        self._cancel_requested: set[str] = set()

    def submit(self, task: Callable[[], Dict[str, Any]]) -> str:
        job_id = uuid4().hex
        self._logger.info("START | submit_job | job_id=%s", job_id)
        future = self._executor.submit(task)
        self._jobs[job_id] = future
        self._logger.info("END | submit_job | job_id=%s", job_id)
        return job_id

    def status(self, job_id: str) -> JobStatus:
        future = self._jobs.get(job_id)
        if future is None:
            return JobStatus(job_id=job_id, state="not_found", result=None, error="job_id not found")

        if future.cancelled():
            return JobStatus(job_id=job_id, state="canceled", result=None, error=None)

        if job_id in self._cancel_requested and future.running():
            return JobStatus(job_id=job_id, state="cancel_requested", result=None, error=None)

        if future.running():
            return JobStatus(job_id=job_id, state="running", result=None, error=None)
        if not future.done():
            return JobStatus(job_id=job_id, state="queued", result=None, error=None)

        exception = future.exception()
        if exception is not None:
            return JobStatus(job_id=job_id, state="failed", result=None, error=str(exception))

        return JobStatus(job_id=job_id, state="completed", result=future.result(), error=None)

    def cancel(self, job_id: str) -> JobStatus:
        future = self._jobs.get(job_id)
        if future is None:
            return JobStatus(job_id=job_id, state="not_found", result=None, error="job_id not found")

        if future.done():
            return self.status(job_id=job_id)

        self._cancel_requested.add(job_id)
        canceled = future.cancel()
        if canceled:
            self._logger.info("JOB_CANCELED | job_id=%s", job_id)
            return JobStatus(job_id=job_id, state="canceled", result=None, error=None)

        self._logger.info("JOB_CANCEL_REQUESTED | job_id=%s", job_id)
        return JobStatus(
            job_id=job_id,
            state="cancel_requested",
            result=None,
            error="Job already running; cancellation requested but may complete.",
        )
