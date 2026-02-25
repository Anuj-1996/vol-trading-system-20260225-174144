from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.routes import router as api_router
from .logger import configure_logging


configure_logging()

app = FastAPI(title="NIFTY Stochastic Volatility Strategy Engine", version="3.0.0")
app.add_middleware(
	CORSMiddleware,
	allow_origins=[
		"http://127.0.0.1:5173",
		"http://localhost:5173",
	],
	allow_credentials=True,
	allow_methods=["*"],
	allow_headers=["*"],
)
app.include_router(api_router, prefix="/api/v1")
