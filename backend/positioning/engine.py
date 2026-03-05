from typing import Dict, Any, List
import numpy as np

# Import the high-performance C++ core
from ..cpp import vol_core
from ..logger import get_logger

class DealerPositioningEngine:
    """
    Computes Market Maker (Dealer) Exposures using the C++ vol_core module.
    Calculates Gamma, Vanna, Charm, and Delta exposures (GEX, VEX, CEX, DEX)
    as well as aggregate metrics such as the Gamma Flip Level.
    """
    def __init__(self):
        self._logger = get_logger(self.__class__.__name__)

    def calculate_positioning(
        self,
        spot: float,
        T: float,
        r: float,
        strikes: np.ndarray,
        option_types: np.ndarray, # 0 for Call, 1 for Put
        ivs: np.ndarray,
        open_interests: np.ndarray,
        lot_size: int = 25  # NIFTY lot size
    ) -> Dict[str, Any]:
        """
        Calculate GEX, VEX, CEX and aggregated metrics using C++ core.
        Returns a dictionary with raw curves and total scalar metrics.
        """
        # 1. Ensure inputs are contiguous C-style double/int arrays for pybind11
        strikes_c = np.ascontiguousarray(strikes, dtype=np.float64)
        option_types_c = np.ascontiguousarray(option_types, dtype=np.int32)
        ivs_c = np.ascontiguousarray(ivs, dtype=np.float64)
        oi_c = np.ascontiguousarray(open_interests, dtype=np.float64)

        # 2. Call C++ Core
        res = vol_core.compute_dealer_positioning(
            spot, T, r, strikes_c, option_types_c, ivs_c, oi_c
        )

        # 3. Scale results by lot size and spot price to get Notional Exposure ($/Rupees)
        # GEX scaling: Gamma * OI * LotSize * Spot^2 * 0.01 (per 1% move)
        # However, standard representation might just use Gamma * OI * 100 * Spot * 0.01
        # Let's use the standard SqueezeMetrics formula:
        # GEX = Gamma * OpenInterest * 100 * Spot * Spot * 0.01 
        # But we pass absolute notional. Since `res['gex']` is just `gamma * oi * direction`
        
        # Scaling factors:
        spot_sq = spot * spot
        gex_scale = lot_size * spot_sq * 0.01  # $$$ per 1% spot move
        vex_scale = lot_size * spot * 100.0    # $$$ per 1 point IV move
        cex_scale = lot_size * spot / 365.0    # Charm × OI × ContractSize × S, per-day
        dex_scale = lot_size * spot            # Notional delta
        
        gex_curve = res["gex"] * gex_scale
        vex_curve = res["vex"] * vex_scale
        cex_curve = res["cex"] * cex_scale
        dex_curve = res["dex"] * dex_scale

        total_gex = res["total_gex"] * gex_scale
        total_vex = res["total_vex"] * vex_scale
        total_cex = res["total_cex"] * cex_scale
        total_dex = res["total_dex"] * dex_scale
        
        # 4. Compute Gamma Flip Level (Approximation)
        # We find the spot price where Total GEX crosses zero.
        # This requires simulating GEX at various spots. We can do this via a quick vectorized scan
        flip_level = self._compute_gamma_flip(spot, T, r, strikes_c, option_types_c, ivs_c, oi_c, lot_size)

        # 5. Volatility Suppression Zones: 
        # Typically where GEX > 0 and VEX > 0
        gamma_regime = "Market Stabilized" if total_gex > 0 else "Market Unstable"

        # 6. Aggregate by Strike to find "Gamma Walls"
        walls = self._find_gamma_walls(strikes_c, gex_curve, ivs_c)

        # 7. Dealer Hedge Flow profile (simulated spot from 0.95*S to 1.05*S)
        hedge_profile = self._simulate_hedge_flow(spot, T, r, strikes_c, option_types_c, ivs_c, oi_c, lot_size)

        return {
            "totals": {
                "gex": total_gex,
                "vex": total_vex,
                "cex": total_cex,
                "dex": total_dex
            },
            "metrics": {
                "gamma_flip_level": flip_level,
                "gamma_regime": gamma_regime
            },
            "walls": walls,
            "curves": {
                "strikes": strikes_c.tolist(),
                "gex": gex_curve.tolist(),
                "vex": vex_curve.tolist(),
                "cex": cex_curve.tolist()
            },
            "hedge_profile": hedge_profile
        }

    def _compute_gamma_flip(self, spot, T, r, strikes, opt_types, ivs, ois, lot_size, range_pct=0.10, steps=200):
        """Simulate GEX across a range of spot prices to find where it crosses 0."""
        spots = np.linspace(spot * (1.0 - range_pct), spot * (1.0 + range_pct), steps)
        gex_profile = []
        
        # We can just call the C++ function in a loop. It's extremely fast.
        for s in spots:
            res = vol_core.compute_dealer_positioning(s, T, r, strikes, opt_types, ivs, ois)
            total = res["total_gex"] * (lot_size * s * s * 0.01)
            gex_profile.append(total)
            
        gex_profile = np.array(gex_profile)
        
        # Find crossing point 
        # If all positive or all negative, flip level is out of bounds
        if np.all(gex_profile > 0) or np.all(gex_profile < 0):
            return None
            
        # Find index where sign changes
        signs = np.sign(gex_profile)
        sign_diffs = np.diff(signs)
        cross_idx = np.where(sign_diffs != 0)[0]
        
        if len(cross_idx) > 0:
            # Return the first crossing point
            idx = cross_idx[0]
            # Interpolate for better precision
            s1, s2 = spots[idx], spots[idx+1]
            g1, g2 = gex_profile[idx], gex_profile[idx+1]
            # y - y1 = m(x - x1) => 0 = g1 + (g2-g1)/(s2-s1) * (flip - s1)
            flip = s1 - g1 * (s2 - s1) / (g2 - g1 + 1e-12)
            return round(float(flip), 2)
        return None

    def _find_gamma_walls(self, strikes: np.ndarray, gex_curve: np.ndarray, ivs: np.ndarray):
        """Find the top 5 strikes with maximum absolute GEX (Call/Put Walls)."""
        # Aggregate GEX by unique strike
        unique_strikes, indices = np.unique(strikes, return_inverse=True)
        agg_gex = np.zeros_like(unique_strikes)
        
        for i, val in enumerate(gex_curve):
            agg_gex[indices[i]] += val
            
        # Find top 5 by absolute magnitude
        abs_gex = np.abs(agg_gex)
        top_idx = np.argsort(abs_gex)[-5:][::-1]
        
        walls = []
        for idx in top_idx:
            val = agg_gex[idx]
            typ = "Call Wall" if val > 0 else "Put Wall"
            walls.append({
                "strike": float(unique_strikes[idx]),
                "gex": float(val),
                "type": typ
            })
            
        return walls

    def _simulate_hedge_flow(self, spot, T, r, strikes, opt_types, ivs, ois, lot_size, range_pct=0.05, steps=50):
        """
        Simulates how dealer delta changes as spot moves, representing required hedging flow.
        Hedge Flow = -d(Dealer Delta) = -Dealer Gamma * dS.
        We return Delta vs Spot so the frontend can plot the slope (Gamma).
        """
        spots = np.linspace(spot * (1.0 - range_pct), spot * (1.0 + range_pct), steps)
        delta_profile = []
        gex_profile = []
        
        for s in spots:
            res = vol_core.compute_dealer_positioning(s, T, r, strikes, opt_types, ivs, ois)
            total_dex = res["total_dex"] * (lot_size * s)
            total_gex = res["total_gex"] * (lot_size * s * s * 0.01)
            delta_profile.append(total_dex)
            gex_profile.append(total_gex)
            
        return {
            "spots": spots.tolist(),
            "net_delta": delta_profile,
            "net_gamma": gex_profile
        }
