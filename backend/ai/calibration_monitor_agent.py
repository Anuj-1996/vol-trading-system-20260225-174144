from __future__ import annotations

from .agent_base import AgentContext, BaseAgent
from .gemini_client import GeminiClient


class CalibrationMonitorAgent(BaseAgent):
    """
    Monitors Heston model calibration quality, parameter stability,
    and identifies regions where the model misprices the market surface.
    """

    def __init__(self, gemini_client: GeminiClient) -> None:
        super().__init__(gemini_client)

    @property
    def name(self) -> str:
        return "calibration_monitor"

    @property
    def role(self) -> str:
        return "Calibration Monitor"

    @property
    def system_prompt(self) -> str:
        return """You are a Heston model calibration monitor for NIFTY options.
Parameters: kappa (mean-reversion), theta (long-run var), xi (vol-of-vol), rho (spot-vol corr), v0 (initial var).
Feller condition: 2*kappa*theta > xi^2. RMSE < 0.01 excellent, 0.01-0.03 acceptable, > 0.03 poor.
Output: CALIBRATION VERDICT (PASS/WARNING/FAIL), PARAMETERS with interpretation, FELLER CHECK, FIT QUALITY, MODEL TRUST SCORE (0-100).
When FAIL/WARNING, include recalibrate JSON block:
```recalibrate
{"kappa": X, "theta": X, "xi": X, "rho": X, "v0": X}
```
Be quantitative. Show calculations."""

    def build_context_prompt(self, context: AgentContext) -> str:
        lines = []
        if context.calibration:
            cal = context.calibration
            params = cal.get("parameters", {})
            kappa = params.get("kappa", 0)
            theta = params.get("theta", 0)
            xi = params.get("xi", 0)
            rho = params.get("rho", 0)
            v0 = params.get("v0", 0)
            lines.append(f"kappa={kappa} theta={theta} xi={xi} rho={rho} v0={v0}")
            lines.append(f"RMSE={cal.get('weighted_rmse','')} converged={cal.get('converged','')} iterations={cal.get('iterations','')}")
            feller_lhs = 2 * kappa * theta
            feller_rhs = xi ** 2
            lines.append(f"Feller: 2kt={feller_lhs:.4f} vs xi2={feller_rhs:.4f} satisfied={feller_lhs > feller_rhs}")
            import numpy as np
            lines.append(f"long_run_vol={np.sqrt(max(theta,0)):.4f} current_vol={np.sqrt(max(v0,0)):.4f}")
        if context.surface and "residual_iv_matrix" in context.surface:
            import numpy as np
            arr = np.array(context.surface["residual_iv_matrix"], dtype=float)
            lines.append(f"residual: RMSE={np.sqrt(np.mean(arr**2)):.6f} bias={np.mean(arr):.6f} max_abs={np.max(np.abs(arr)):.6f}")
        mo = context.market_overview or {}
        for k in ["spot", "atm_market_iv", "atm_model_iv"]:
            if k in mo:
                lines.append(f"{k}={mo[k]}")
        return "\n".join(lines)
