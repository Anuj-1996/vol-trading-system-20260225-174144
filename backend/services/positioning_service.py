import numpy as np
from typing import Dict, Any
from ..services.engine_service import _live_data_cache
from ..positioning.engine import DealerPositioningEngine
from ..logger import get_logger

class PositioningService:
    """
    Handles fetching data from the live cache, preparing numpy arrays,
    and invoking the high-performance C++ DealerPositioningEngine.
    """
    def __init__(self):
        self._logger = get_logger(self.__class__.__name__)
        self._engine = DealerPositioningEngine()

    def get_dealer_positioning(self, data_id: str, risk_free_rate: float = 0.065) -> Dict[str, Any]:
        """
        Retrieves the cached NSE data by data_id, extracts relevant fields into
        vectorized numpy arrays, and calls the C++ DealerPositioningEngine.
        """
        cached = _live_data_cache.get(data_id)
        if not cached:
            raise ValueError(f"No cached data found for data_id: {data_id}")
            
        spot = cached["spot"]
        records = cached["cleaned_records"]
        
        if not records:
            raise ValueError("No cleaned records in cached data.")

        # Group records by expiry
        from collections import defaultdict
        from datetime import datetime, timezone
        
        expiry_groups = defaultdict(list)
        now = datetime.now(timezone.utc)
        
        for r in records:
            expiry_groups[r.expiry].append(r)
            
        # We will accumulate the aggregated metrics
        total_gex, total_vex, total_cex, total_dex = 0.0, 0.0, 0.0, 0.0
        agg_gex_curve = defaultdict(float)
        agg_vex_curve = defaultdict(float)
        agg_cex_curve = defaultdict(float)
        agg_dex_curve = defaultdict(float)
        
        # Heatmap: per-expiry GEX by strike
        heatmap_data = {}  # { expiry_str: { strike: gex } }
        
        # Per-expiry T values for intraday charm
        expiry_T_map = {}
        
        lot_size = 25  # NIFTY
        
        # Accumulate metrics per expiry
        for expiry_str, exp_records in expiry_groups.items():
            # Parse expiry to get T (years)
            try:
                exp_date = datetime.strptime(expiry_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                delta = (exp_date - now).total_seconds()
                T = max(delta / (365.25 * 86400.0), 1e-4)
            except Exception:
                T = 7.0 / 365.25
            
            expiry_T_map[expiry_str] = T
                
            e_strikes = []
            e_types = []
            e_ivs = []
            e_ois = []
            
            for r in exp_records:
                if r.call_oi > 0:
                    e_strikes.append(r.strike)
                    e_types.append(0)
                    e_ivs.append(r.call_iv if r.call_iv > 0 else 0.2)
                    e_ois.append(r.call_oi)
                if r.put_oi > 0:
                    e_strikes.append(r.strike)
                    e_types.append(1)
                    e_ivs.append(r.put_iv if r.put_iv > 0 else 0.2)
                    e_ois.append(r.put_oi)
                    
            if not e_strikes:
                continue
            
            np_strikes = np.array(e_strikes)
            np_types = np.array(e_types)
            np_ivs = np.array(e_ivs)
            np_ois = np.array(e_ois)
                
            res = self._engine.calculate_positioning(
                spot=spot, T=T, r=risk_free_rate,
                strikes=np_strikes, option_types=np_types,
                ivs=np_ivs, open_interests=np_ois, lot_size=lot_size
            )
            
            # Aggregate Totals
            total_gex += res["totals"]["gex"]
            total_vex += res["totals"]["vex"]
            total_cex += res["totals"]["cex"]
            total_dex += res["totals"]["dex"]
            
            # Per-expiry heatmap: aggregate GEX by unique strike
            expiry_heatmap = defaultdict(float)
            
            # Aggregate Curves by Strike
            for st, g, v, c in zip(
                res["curves"]["strikes"], 
                res["curves"]["gex"], 
                res["curves"]["vex"], 
                res["curves"]["cex"],
            ):
                agg_gex_curve[st] += g
                agg_vex_curve[st] += v
                agg_cex_curve[st] += c
                expiry_heatmap[st] += g
            
            heatmap_data[expiry_str] = dict(expiry_heatmap)
            
            # ── Intraday Charm: compute delta shift T → T-1day ──
            T_minus_1 = max(T - (1.0 / 365.25), 1e-5)
            res_t1 = self._engine.calculate_positioning(
                spot=spot, T=T_minus_1, r=risk_free_rate,
                strikes=np_strikes, option_types=np_types,
                ivs=np_ivs, open_interests=np_ois, lot_size=lot_size
            )
            # Compute per-strike delta shift for this expiry (aggregate into global)
            for st_now, st_t1, dex_now, dex_t1 in zip(
                res["curves"]["strikes"],
                res_t1["curves"]["strikes"],
                res["curves"].get("dex", res["curves"]["gex"]),
                res_t1["curves"].get("dex", res_t1["curves"]["gex"]),
            ):
                if st_now in agg_dex_curve:
                    agg_dex_curve[st_now] += (dex_t1 - dex_now)
                else:
                    agg_dex_curve[st_now] = (dex_t1 - dex_now)
                
        # Format final curves sorted by strike
        unique_strikes = sorted(list(agg_gex_curve.keys()))
        final_gex_curve = [agg_gex_curve[k] for k in unique_strikes]
        final_vex_curve = [agg_vex_curve[k] for k in unique_strikes]
        final_cex_curve = [agg_cex_curve[k] for k in unique_strikes]
        
        # ── Heatmap: build matrix (expiries × strikes) ──
        sorted_expiries = sorted(heatmap_data.keys())
        heatmap_strikes = unique_strikes
        heatmap_matrix = []
        for exp in sorted_expiries:
            row = [heatmap_data[exp].get(st, 0.0) for st in heatmap_strikes]
            heatmap_matrix.append(row)
        
        # ── Volatility Suppression Zones ──
        vol_suppression = []
        for st, g, v in zip(unique_strikes, final_gex_curve, final_vex_curve):
            if g > 0 and v < 0:
                zone = "suppressed"
            elif g < 0 and v > 0:
                zone = "expansion"
            else:
                zone = "neutral"
            vol_suppression.append({
                "strike": st,
                "gex": g,
                "vex": v,
                "zone": zone
            })
        
        # ── Gamma Density Distribution (binned histogram) ──
        gex_arr = np.array(final_gex_curve)
        if len(gex_arr) > 5:
            n_bins = min(40, len(gex_arr) // 2)
            hist_counts, bin_edges = np.histogram(gex_arr, bins=n_bins)
            bin_centers = ((bin_edges[:-1] + bin_edges[1:]) / 2.0).tolist()
            gamma_density = {
                "bin_centers": bin_centers,
                "counts": hist_counts.tolist()
            }
        else:
            gamma_density = {"bin_centers": [], "counts": []}
        
        # ── Intraday Charm Flow (delta shift by strike) ──
        intraday_charm = {
            "strikes": unique_strikes,
            "delta_shift": [agg_dex_curve.get(k, 0.0) for k in unique_strikes]
        }
        
        # ── Weighted average T for aggregate flip-level calc ──
        total_oi = sum(r.call_oi + r.put_oi for r in records)
        weighted_T = 0.0
        all_strikes, all_types, all_ivs, all_ois = [], [], [], []
        
        for expiry_str, exp_records in expiry_groups.items():
            try:
                exp_date = datetime.strptime(expiry_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                delta = (exp_date - now).total_seconds()
                T = max(delta / (365.25 * 86400.0), 1e-4)
            except:
                T = 7.0 / 365.25
                
            exp_oi = sum(r.call_oi + r.put_oi for r in exp_records)
            if total_oi > 0:
                weighted_T += T * (exp_oi / total_oi)
                
            for r in exp_records:
                if r.call_oi > 0:
                    all_strikes.append(r.strike); all_types.append(0); all_ivs.append(max(r.call_iv, 0.2)); all_ois.append(r.call_oi)
                if r.put_oi > 0:
                    all_strikes.append(r.strike); all_types.append(1); all_ivs.append(max(r.put_iv, 0.2)); all_ois.append(r.put_oi)
                    
        # Calculate Flip Level using weighted average T
        dummy_res = self._engine.calculate_positioning(
            spot=spot, T=weighted_T, r=risk_free_rate,
            strikes=np.array(all_strikes), option_types=np.array(all_types),
            ivs=np.array(all_ivs), open_interests=np.array(all_ois),
            lot_size=lot_size
        )
        flip_level = dummy_res["metrics"]["gamma_flip_level"]
        gamma_regime = "Market Stabilized" if total_gex > 0 else "Market Unstable"
        
        walls = self._engine._find_gamma_walls(np.array(all_strikes), np.array(final_gex_curve), np.array(all_ivs))

        hedge_profile = dummy_res["hedge_profile"]

        return {
            "spot": spot,
            "timestamp": now.isoformat(),
            "metrics": {
                "total_gex": total_gex,
                "total_vex": total_vex,
                "total_cex": total_cex,
                "gamma_flip_level": flip_level,
                "gamma_regime": gamma_regime
            },
            "walls": walls,
            "curves": {
                "strikes": unique_strikes,
                "gex": final_gex_curve,
                "vex": final_vex_curve,
                "cex": final_cex_curve
            },
            "snapshots": {
                "hedge_flow_spot_range": hedge_profile["spots"],
                "hedge_flow": hedge_profile["net_delta"],
                "net_gamma_vs_spot": hedge_profile["net_gamma"]
            },
            "heatmap": {
                "strikes": heatmap_strikes,
                "expiries": sorted_expiries,
                "matrix": heatmap_matrix
            },
            "vol_suppression": vol_suppression,
            "gamma_density": gamma_density,
            "intraday_charm": intraday_charm
        }
