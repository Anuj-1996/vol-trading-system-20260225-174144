import React, { useEffect, useMemo, useState } from 'react';
import { Panel, SnapshotGuard, formatNumber } from './shared.jsx';
import { fetchDealerPositioning } from '../../api/client';
import { bsmGreeks } from '../../utils/bsmGreeks';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatRsValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '-';
  return `₹${Math.round(numeric).toLocaleString('en-IN')}`;
}

function formatShortRs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '-';
  const abs = Math.abs(numeric);
  if (abs >= 1e7) return `₹${formatNumber(numeric / 1e7, 2)} Cr`;
  if (abs >= 1e5) return `₹${formatNumber(numeric / 1e5, 1)} L`;
  return formatRsValue(numeric);
}

function formatSignedRs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '-';
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${formatShortRs(numeric)}`;
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const value = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * value);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-value * value);
  return sign * y;
}

const GREEK_LABELS = {
  delta: 'Δ',
  gamma: 'Γ',
  vega: 'ν',
  theta: 'Θ/day',
  rho: 'ρ',
};

const MODEL_LABELS = {
  hidden: 'Hidden',
  Heston: 'Heston',
  SABR: 'SABR',
  BSM: 'BSM',
  Avg3: 'Avg 3',
};

const EXPOSURE_LABELS = {
  hidden: 'Hidden',
  gamma: 'Gamma',
  vega: 'Vega',
  charm: 'Charm',
  delta: 'Delta',
};

function nearestIndex(values, target) {
  if (!Array.isArray(values) || !values.length || !Number.isFinite(target)) return -1;
  return values.reduce((bestIndex, value, index) => (
    Math.abs(Number(value) - target) < Math.abs(Number(values[bestIndex]) - target) ? index : bestIndex
  ), 0);
}

export default function OptionChainPage({
  loading = false,
  activeSnapshotId = null,
  liveDataId = null,
  underlying = 'NIFTY',
  market = {},
  surface = {},
  selectedExpiryIndex = 0,
  onExpiryIndexChange,
}) {
  const [localExpiryIndex, setLocalExpiryIndex] = useState(selectedExpiryIndex);
  const [strikeWindow, setStrikeWindow] = useState(14);
  const [rowMode, setRowMode] = useState('around_atm');
  const [greekView, setGreekView] = useState('core');
  const [modelView, setModelView] = useState('hidden');
  const [exposureView, setExposureView] = useState('hidden');
  const [positioning, setPositioning] = useState(null);

  useEffect(() => {
    setLocalExpiryIndex(selectedExpiryIndex);
  }, [selectedExpiryIndex]);

  useEffect(() => {
    let active = true;
    async function loadPositioning() {
      if (!liveDataId) {
        setPositioning(null);
        return;
      }
      try {
        const response = await fetchDealerPositioning(liveDataId);
        if (active) {
          setPositioning(response?.data ?? null);
        }
      } catch {
        if (active) {
          setPositioning(null);
        }
      }
    }
    loadPositioning();
    return () => {
      active = false;
    };
  }, [liveDataId]);

  const strikeGrid = Array.isArray(surface?.strike_grid) ? surface.strike_grid.map(Number) : [];
  const expiryLabels = Array.isArray(surface?.expiry_labels) ? surface.expiry_labels : [];
  const maturityGrid = Array.isArray(surface?.maturity_grid) ? surface.maturity_grid.map(Number) : [];
  const marketMatrix = Array.isArray(surface?.market_iv_matrix) ? surface.market_iv_matrix : [];
  const modelVariants = surface?.model_variants && typeof surface.model_variants === 'object' ? surface.model_variants : {};
  const callMarketPriceMatrix = Array.isArray(surface?.call_market_price_matrix) ? surface.call_market_price_matrix : [];
  const putMarketPriceMatrix = Array.isArray(surface?.put_market_price_matrix) ? surface.put_market_price_matrix : [];
  const callLtpMatrix = Array.isArray(surface?.call_ltp_matrix) ? surface.call_ltp_matrix : [];
  const putLtpMatrix = Array.isArray(surface?.put_ltp_matrix) ? surface.put_ltp_matrix : [];
  const callMidMatrix = Array.isArray(surface?.call_mid_matrix) ? surface.call_mid_matrix : [];
  const putMidMatrix = Array.isArray(surface?.put_mid_matrix) ? surface.put_mid_matrix : [];
  const openInterestMatrix = Array.isArray(surface?.open_interest_matrix) ? surface.open_interest_matrix : [];
  const maxPainByExpiry = Array.isArray(surface?.max_pain_by_expiry) ? surface.max_pain_by_expiry.map(Number) : [];
  const spot = Number(market?.spot ?? 0);
  const riskFreeRate = Number.isFinite(Number(market?.risk_free_rate)) ? Number(market.risk_free_rate) : 0.06;
  const underlyingUpper = String(
    market?.underlying ?? surface?.underlying ?? underlying ?? 'NIFTY',
  ).toUpperCase();
  const lotSize = useMemo(() => {
    const explicit = Number(
      market?.lot_size ?? surface?.lot_size ?? market?.contract_size ?? surface?.contract_size,
    );
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    if (underlyingUpper.includes('BANKNIFTY')) return 15;
    if (underlyingUpper.includes('NIFTY')) return 25;
    return 1;
  }, [market?.contract_size, market?.lot_size, surface?.contract_size, surface?.lot_size, underlyingUpper]);

  const expiryIndex = clamp(localExpiryIndex, 0, Math.max(0, expiryLabels.length - 1));

  const expiryOptions = useMemo(
    () => expiryLabels.map((label, index) => ({ index, label })),
    [expiryLabels],
  );

  const atmIndex = useMemo(() => {
    if (!strikeGrid.length || !Number.isFinite(spot)) return 0;
    return strikeGrid.reduce((bestIndex, strike, index) => (
      Math.abs(strike - spot) < Math.abs(strikeGrid[bestIndex] - spot) ? index : bestIndex
    ), 0);
  }, [spot, strikeGrid]);

  const visibleGreekKeys = useMemo(() => {
    if (greekView === 'hidden') return [];
    if (greekView === 'delta_gamma') return ['delta', 'gamma'];
    if (greekView === 'all') return ['delta', 'gamma', 'vega', 'theta', 'rho'];
    return ['delta', 'gamma', 'vega', 'theta'];
  }, [greekView]);

  const positioningView = useMemo(() => {
    const curves = positioning?.curves ?? {};
    const strikes = Array.isArray(curves?.strikes) ? curves.strikes.map(Number) : [];
    const gamma = Array.isArray(curves?.gex) ? curves.gex.map(Number) : [];
    const vega = Array.isArray(curves?.vex) ? curves.vex.map(Number) : [];
    const charm = Array.isArray(curves?.cex) ? curves.cex.map(Number) : [];
    const delta = Array.isArray(curves?.dex) ? curves.dex.map(Number) : [];
    const walls = Array.isArray(positioning?.walls) ? positioning.walls : [];
    const flipLevel = Number(positioning?.metrics?.gamma_flip_level);
    const maxPain = Number(maxPainByExpiry[expiryIndex] ?? 0);
    const topCallWall = walls
      .filter((wall) => Number(wall?.strike) >= spot)
      .sort((left, right) => Math.abs(Number(right?.gex ?? 0)) - Math.abs(Number(left?.gex ?? 0)))[0] ?? null;
    const topPutWall = walls
      .filter((wall) => Number(wall?.strike) <= spot)
      .sort((left, right) => Math.abs(Number(right?.gex ?? 0)) - Math.abs(Number(left?.gex ?? 0)))[0] ?? null;
    return {
      strikes,
      series: {
        gamma,
        vega,
        charm,
        delta,
      },
      metrics: {
        gammaFlipLevel: Number.isFinite(flipLevel) ? flipLevel : null,
        totalGex: Number(positioning?.metrics?.total_gex ?? 0),
        totalVex: Number(positioning?.metrics?.total_vex ?? 0),
        totalCex: Number(positioning?.metrics?.total_cex ?? 0),
        totalDex: Number(positioning?.metrics?.total_dex ?? 0),
        gammaRegime: positioning?.metrics?.gamma_regime ?? null,
        maxPain: Number.isFinite(maxPain) ? maxPain : null,
      },
      walls,
      topCallWall,
      topPutWall,
    };
  }, [expiryIndex, maxPainByExpiry, positioning, spot]);

  const rows = useMemo(() => {
    const ivRow = Array.isArray(marketMatrix[expiryIndex]) ? marketMatrix[expiryIndex] : [];
    const oiRow = Array.isArray(openInterestMatrix[expiryIndex]) ? openInterestMatrix[expiryIndex] : [];
    const callMarketRow = Array.isArray(callMarketPriceMatrix[expiryIndex]) ? callMarketPriceMatrix[expiryIndex] : [];
    const putMarketRow = Array.isArray(putMarketPriceMatrix[expiryIndex]) ? putMarketPriceMatrix[expiryIndex] : [];
    const callLtpRow = Array.isArray(callLtpMatrix[expiryIndex]) ? callLtpMatrix[expiryIndex] : [];
    const putLtpRow = Array.isArray(putLtpMatrix[expiryIndex]) ? putLtpMatrix[expiryIndex] : [];
    const callMidRow = Array.isArray(callMidMatrix[expiryIndex]) ? callMidMatrix[expiryIndex] : [];
    const putMidRow = Array.isArray(putMidMatrix[expiryIndex]) ? putMidMatrix[expiryIndex] : [];
    const hestonIvRow = Array.isArray(modelVariants?.Heston?.model_iv_matrix?.[expiryIndex]) ? modelVariants.Heston.model_iv_matrix[expiryIndex] : [];
    const sabrIvRow = Array.isArray(modelVariants?.SABR?.model_iv_matrix?.[expiryIndex]) ? modelVariants.SABR.model_iv_matrix[expiryIndex] : [];
    const exposureSeries = positioningView.series?.[exposureView] ?? [];
    const exposureAbs = exposureSeries.map((value) => Math.abs(Number(value) || 0)).filter((value) => value > 0).sort((a, b) => a - b);
    const exposureThreshold = exposureAbs.length ? exposureAbs[Math.floor(exposureAbs.length * 0.7)] : 0;
    const strikeStep = strikeGrid.length > 1 ? Math.abs(Number(strikeGrid[1]) - Number(strikeGrid[0])) : 50;

    const expiryT = Math.max(Number(maturityGrid[expiryIndex] ?? 0), 1 / 365);
    const expirySqrtT = Math.sqrt(expiryT);
    const atmIvFallback = Number(market?.atm_iv ?? 0);
    const normCdf = (value) => 0.5 * (1 + erf(value / Math.SQRT2));

    return strikeGrid.map((strike, index) => {
      const callLtp = Number(callLtpRow[index] ?? 0);
      const putLtp = Number(putLtpRow[index] ?? 0);
      const callMid = Number(callMidRow[index] ?? 0);
      const putMid = Number(putMidRow[index] ?? 0);
      const callMarket = Number(callMarketRow[index] ?? 0);
      const putMarket = Number(putMarketRow[index] ?? 0);
      const iv = Number(ivRow[index] ?? 0);
      const oi = Number(oiRow[index] ?? 0);
      const callValue = callMarket > 0 ? callMarket : callMid > 0 ? callMid : callLtp;
      const putValue = putMarket > 0 ? putMarket : putMid > 0 ? putMid : putLtp;
      const callDisplayPrice = callLtp > 0 ? callLtp : callValue;
      const putDisplayPrice = putLtp > 0 ? putLtp : putValue;
      const callNotional = callDisplayPrice * lotSize;
      const putNotional = putDisplayPrice * lotSize;
      const distance = strike - spot;
      const sigmaForGreeks = iv > 0 ? iv : atmIvFallback;
      const callGreeks = sigmaForGreeks > 0 ? bsmGreeks(spot, strike, expiryT, sigmaForGreeks, riskFreeRate, true) : null;
      const putGreeks = sigmaForGreeks > 0 ? bsmGreeks(spot, strike, expiryT, sigmaForGreeks, riskFreeRate, false) : null;

      const hestonIv = Number(hestonIvRow[index] ?? 0);
      const sabrIv = Number(sabrIvRow[index] ?? 0);
      const bsmIv = atmIvFallback > 0 ? atmIvFallback : iv;
      const avg3Pool = [hestonIv, sabrIv, bsmIv].filter((value) => Number.isFinite(value) && value > 0);
      const avg3Iv = avg3Pool.length ? avg3Pool.reduce((sum, value) => sum + value, 0) / avg3Pool.length : 0;

      const modelSlices = Object.fromEntries(
        Object.entries({
          Heston: hestonIv,
          SABR: sabrIv,
          BSM: bsmIv,
          Avg3: avg3Iv,
        }).map(([modelName, sigma]) => {
          const callModel = sigma > 0 ? bsmGreeks(spot, strike, expiryT, sigma, riskFreeRate, true) : null;
          const putModel = sigma > 0 ? bsmGreeks(spot, strike, expiryT, sigma, riskFreeRate, false) : null;
          return [modelName, {
            iv: sigma,
            callPrice: callModel?.price ?? null,
            putPrice: putModel?.price ?? null,
          }];
        }),
      );

      const expectedMove = sigmaForGreeks > 0 ? spot * sigmaForGreeks * expirySqrtT : null;
      const sigmaDistance = expectedMove && expectedMove > 0 ? distance / expectedMove : null;
      const d2 = sigmaForGreeks > 0 && spot > 0 && strike > 0
        ? (Math.log(spot / strike) + (riskFreeRate - 0.5 * sigmaForGreeks * sigmaForGreeks) * expiryT) / (sigmaForGreeks * expirySqrtT)
        : null;
      const callProbItm = Number.isFinite(d2) ? normCdf(d2) : null;
      const putProbItm = Number.isFinite(d2) ? 1 - normCdf(d2) : null;

      const exposureIdx = nearestIndex(positioningView.strikes, strike);
      const exposureValue = exposureIdx >= 0 ? Number(exposureSeries[exposureIdx] ?? 0) : null;
      const isNearFlip = Number.isFinite(positioningView.metrics.gammaFlipLevel)
        && Math.abs(strike - positioningView.metrics.gammaFlipLevel) <= strikeStep * 0.75;
      const wall = positioningView.walls.find((item) => Math.abs(Number(item?.strike ?? 0) - strike) <= strikeStep * 0.5) ?? null;
      let exposureTag = '-';
      if (exposureView !== 'hidden') {
        if (isNearFlip) {
          exposureTag = 'Flip Zone';
        } else if (wall) {
          exposureTag = Number(wall.strike) >= spot ? 'Call Wall' : 'Put Wall';
        } else if (Number.isFinite(exposureValue) && Math.abs(exposureValue) >= exposureThreshold && exposureThreshold > 0) {
          if (exposureView === 'gamma') {
            exposureTag = exposureValue >= 0
              ? (strike <= spot ? 'Support' : 'Resistance')
              : 'Air Pocket';
          } else if (exposureView === 'vega') {
            exposureTag = exposureValue >= 0 ? 'Vol Bid' : 'Vol Offer';
          } else if (exposureView === 'charm') {
            exposureTag = exposureValue >= 0 ? 'Decay Buy' : 'Decay Sell';
          } else if (exposureView === 'delta') {
            exposureTag = exposureValue >= 0 ? 'Long Delta' : 'Short Delta';
          }
        }
      }

      return {
        strike,
        callLtp,
        putLtp,
        callMid,
        putMid,
        callValue,
        putValue,
        callDisplayPrice,
        putDisplayPrice,
        callNotional,
        putNotional,
        straddleNotional: callNotional + putNotional,
        iv,
        oi,
        distance,
        callGreeks,
        putGreeks,
        expectedMove,
        sigmaDistance,
        callProbItm,
        putProbItm,
        expiryT,
        modelSlices,
        exposureValue,
        exposureTag,
        isFlipZone: isNearFlip,
        isWall: Boolean(wall),
        straddle: (Number.isFinite(callValue) ? callValue : 0) + (Number.isFinite(putValue) ? putValue : 0),
        isAtm: index === atmIndex,
        bucket: Math.abs(index - atmIndex) <= 1 ? 'atm' : strike < spot ? 'put-side' : 'call-side',
      };
    });
  }, [
    expiryIndex,
    exposureView,
    positioningView,
    marketMatrix,
    modelVariants,
    callMarketPriceMatrix,
    putMarketPriceMatrix,
    callLtpMatrix,
    putLtpMatrix,
    callMidMatrix,
    putMidMatrix,
    openInterestMatrix,
    maturityGrid,
    market?.atm_iv,
    riskFreeRate,
    strikeGrid,
    spot,
    atmIndex,
    lotSize,
  ]);

  const visibleRows = useMemo(() => {
    const aroundAtm = rows.filter((_, index) => Math.abs(index - atmIndex) <= strikeWindow);
    if (rowMode === 'all') return rows;
    if (rowMode === 'otm_only') {
      return aroundAtm.filter((row) => (row.strike >= spot && row.putValue > 0) || (row.strike <= spot && row.callValue > 0));
    }
    return aroundAtm;
  }, [rows, atmIndex, strikeWindow, rowMode, spot]);

  const chainMetrics = useMemo(() => {
    if (!rows.length) {
      return {
        atmStrike: null,
        topOiStrike: null,
        topOi: null,
        richestStraddleStrike: null,
        richestStraddle: null,
        avgIv: null,
        atmExpectedMove: null,
        call16Strike: null,
        put16Strike: null,
      };
    }

    const topOiRow = rows.reduce((best, row) => (row.oi > (best?.oi ?? -Infinity) ? row : best), null);
    const richestStraddleRow = rows.reduce((best, row) => (row.straddle > (best?.straddle ?? -Infinity) ? row : best), null);
    const validIvRows = rows.filter((row) => Number.isFinite(row.iv) && row.iv > 0);
    const avgIv = validIvRows.length
      ? validIvRows.reduce((sum, row) => sum + row.iv, 0) / validIvRows.length
      : null;

    const nearestByProb = (target, key) => rows
      .filter((row) => Number.isFinite(row[key]))
      .reduce((best, row) => (
        Math.abs(row[key] - target) < Math.abs((best?.[key] ?? Infinity) - target) ? row : best
      ), null);

    return {
      atmStrike: rows[atmIndex]?.strike ?? null,
      topOiStrike: topOiRow?.strike ?? null,
      topOi: topOiRow?.oi ?? null,
      richestStraddleStrike: richestStraddleRow?.strike ?? null,
      richestStraddle: richestStraddleRow?.straddleNotional ?? null,
      avgIv,
      atmExpectedMove: rows[atmIndex]?.expectedMove ?? null,
      call16Strike: nearestByProb(0.16, 'callProbItm')?.strike ?? null,
      put16Strike: nearestByProb(0.16, 'putProbItm')?.strike ?? null,
    };
  }, [rows, atmIndex]);

  const maxOi = useMemo(() => visibleRows.reduce((best, row) => Math.max(best, row.oi || 0), 0), [visibleRows]);
  const exposureMagnitude = useMemo(
    () => visibleRows.reduce((best, row) => Math.max(best, Math.abs(Number(row.exposureValue) || 0)), 0),
    [visibleRows],
  );

  const handleExpiryChange = (nextValue) => {
    const nextIndex = Number(nextValue);
    if (!Number.isFinite(nextIndex)) return;
    setLocalExpiryIndex(nextIndex);
    onExpiryIndexChange?.(nextIndex);
  };

  const exposureMetricValue = exposureView === 'gamma'
    ? positioningView.metrics.totalGex
    : exposureView === 'vega'
      ? positioningView.metrics.totalVex
      : exposureView === 'charm'
        ? positioningView.metrics.totalCex
        : exposureView === 'delta'
          ? positioningView.metrics.totalDex
          : positioningView.metrics.totalGex;

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-option-chain-grid">
        <Panel title="Dynamic Option Chain">
          <div className="option-chain-toolbar">
            <label>
              Expiry
              <select value={expiryIndex} onChange={(event) => handleExpiryChange(event.target.value)}>
                {expiryOptions.map((option) => (
                  <option key={option.index} value={option.index}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              Strike Window
              <select value={strikeWindow} onChange={(event) => setStrikeWindow(Number(event.target.value))}>
                {[8, 10, 12, 14, 18, 24].map((value) => (
                  <option key={value} value={value}>{value} rows each side</option>
                ))}
              </select>
            </label>
            <label>
              View
              <select value={rowMode} onChange={(event) => setRowMode(event.target.value)}>
                <option value="around_atm">Around ATM</option>
                <option value="otm_only">OTM Focus</option>
                <option value="all">Full Chain</option>
              </select>
            </label>
            <label>
              Greeks
              <select value={greekView} onChange={(event) => setGreekView(event.target.value)}>
                <option value="hidden">Hidden</option>
                <option value="delta_gamma">Delta + Gamma</option>
                <option value="core">Core Greeks</option>
                <option value="all">All Greeks</option>
              </select>
            </label>
            <label>
              Model Compare
              <select value={modelView} onChange={(event) => setModelView(event.target.value)}>
                <option value="hidden">Hidden</option>
                <option value="Heston">Heston</option>
                <option value="SABR">SABR</option>
                <option value="BSM">BSM</option>
                <option value="Avg3">Avg 3</option>
              </select>
            </label>
            <label>
              Exposure View
              <select value={exposureView} onChange={(event) => setExposureView(event.target.value)}>
                <option value="hidden">Hidden</option>
                <option value="gamma">Gamma</option>
                <option value="vega">Vega</option>
                <option value="charm">Charm</option>
                <option value="delta">Delta</option>
              </select>
            </label>
          </div>

          <div className="option-chain-kpi-grid">
            <div><span>Spot</span><strong>{formatNumber(spot, 2)}</strong></div>
            <div><span>ATM Strike</span><strong>{chainMetrics.atmStrike != null ? formatNumber(chainMetrics.atmStrike, 0) : '-'}</strong></div>
            <div><span>Chain Avg IV</span><strong>{chainMetrics.avgIv != null ? `${formatNumber(chainMetrics.avgIv * 100, 2)}%` : '-'}</strong></div>
            <div><span>Top OI Strike</span><strong>{chainMetrics.topOiStrike != null ? `${formatNumber(chainMetrics.topOiStrike, 0)} (${formatNumber(chainMetrics.topOi, 0)})` : '-'}</strong></div>
            <div><span>Richest Straddle</span><strong>{chainMetrics.richestStraddleStrike != null ? `${formatNumber(chainMetrics.richestStraddleStrike, 0)} / ${formatRsValue(chainMetrics.richestStraddle)}` : '-'}</strong></div>
            <div><span>ATM 1σ Move</span><strong>{chainMetrics.atmExpectedMove != null ? formatRsValue(chainMetrics.atmExpectedMove * lotSize) : '-'}</strong></div>
            <div><span>16Δ Call Strike</span><strong>{chainMetrics.call16Strike != null ? formatNumber(chainMetrics.call16Strike, 0) : '-'}</strong></div>
            <div><span>16Δ Put Strike</span><strong>{chainMetrics.put16Strike != null ? formatNumber(chainMetrics.put16Strike, 0) : '-'}</strong></div>
            <div><span>Selected Expiry</span><strong>{expiryLabels[expiryIndex] || '-'}</strong></div>
            <div><span>Rows Shown</span><strong>{visibleRows.length}</strong></div>
            <div><span>ATM Straddle</span><strong>{rows[atmIndex]?.straddleNotional != null ? formatRsValue(rows[atmIndex].straddleNotional) : '-'}</strong></div>
            <div><span>Nearest Call Premium</span><strong>{rows[atmIndex]?.callNotional != null ? formatRsValue(rows[atmIndex].callNotional) : '-'}</strong></div>
            <div><span>Nearest Put Premium</span><strong>{rows[atmIndex]?.putNotional != null ? formatRsValue(rows[atmIndex].putNotional) : '-'}</strong></div>
            <div><span>Interpretation</span><strong>{chainMetrics.topOiStrike == null || chainMetrics.atmStrike == null ? '-' : chainMetrics.topOiStrike > chainMetrics.atmStrike ? 'Call-side OI overhead' : chainMetrics.topOiStrike < chainMetrics.atmStrike ? 'Put-side OI support' : 'OI centered at ATM'}</strong></div>
            <div><span>Expiry Horizon</span><strong>{rows[atmIndex]?.expiryT != null ? `${formatNumber(rows[atmIndex].expiryT * 365, 0)}D` : '-'}</strong></div>
            <div><span>ATM Call Δ</span><strong>{rows[atmIndex]?.callGreeks ? formatNumber(rows[atmIndex].callGreeks.delta, 3) : '-'}</strong></div>
            <div><span>ATM Γ</span><strong>{rows[atmIndex]?.callGreeks ? formatNumber(rows[atmIndex].callGreeks.gamma, 5) : '-'}</strong></div>
            <div><span>ATM ν</span><strong>{rows[atmIndex]?.callGreeks ? formatNumber(rows[atmIndex].callGreeks.vega, 3) : '-'}</strong></div>
          </div>

          <div className="option-chain-signal-grid">
            <div className="option-chain-signal-card">
              <span>Gamma Flip</span>
              <strong>{positioningView.metrics.gammaFlipLevel != null ? formatNumber(positioningView.metrics.gammaFlipLevel, 0) : '-'}</strong>
            </div>
            <div className="option-chain-signal-card">
              <span>Top Call Wall</span>
              <strong>{positioningView.topCallWall ? `${formatNumber(positioningView.topCallWall.strike, 0)} / ${formatSignedRs(positioningView.topCallWall.gex)}` : '-'}</strong>
            </div>
            <div className="option-chain-signal-card">
              <span>Top Put Wall</span>
              <strong>{positioningView.topPutWall ? `${formatNumber(positioningView.topPutWall.strike, 0)} / ${formatSignedRs(positioningView.topPutWall.gex)}` : '-'}</strong>
            </div>
            <div className="option-chain-signal-card">
              <span>Max Pain</span>
              <strong>{positioningView.metrics.maxPain != null ? formatNumber(positioningView.metrics.maxPain, 0) : '-'}</strong>
            </div>
            <div className="option-chain-signal-card">
              <span>{exposureView === 'hidden' ? 'Net GEX' : `Net ${EXPOSURE_LABELS[exposureView]} Exp.`}</span>
              <strong>{formatSignedRs(exposureMetricValue)}</strong>
            </div>
            <div className="option-chain-signal-card">
              <span>Gamma Regime</span>
              <strong>{positioningView.metrics.gammaRegime || '-'}</strong>
            </div>
          </div>

          {exposureView !== 'hidden' && (
            <div className="option-chain-legend">
              <span className="stabilizing">Green = stabilizing/sticky</span>
              <span className="destabilizing">Red = unstable/air pocket</span>
              <span className="vol-sensitive">Blue = vol-sensitive</span>
            </div>
          )}

          <div className="option-chain-table-wrap">
            <table className="dense-table option-chain-table">
              <thead>
                <tr>
                  <th>Call LTP</th>
                  <th>Call Mid</th>
                  <th>Call ₹</th>
                  {modelView !== 'hidden' && <th>{MODEL_LABELS[modelView]} Call ₹</th>}
                  {modelView !== 'hidden' && <th>Market-Model Call ₹</th>}
                  {visibleGreekKeys.map((key) => (
                    <th key={`call-${key}`}>{GREEK_LABELS[key]} C</th>
                  ))}
                  <th>Strike</th>
                  {exposureView !== 'hidden' && <th>{EXPOSURE_LABELS[exposureView]} Exp.</th>}
                  {exposureView !== 'hidden' && <th>Zone</th>}
                  <th>σ Dist</th>
                  <th>P(C ITM)</th>
                  <th>P(P ITM)</th>
                  <th>IV</th>
                  {modelView !== 'hidden' && <th>{MODEL_LABELS[modelView]} Modeled IV</th>}
                  {modelView !== 'hidden' && <th>Market-Model IV</th>}
                  <th>OI</th>
                  <th>Straddle</th>
                  <th>Put ₹</th>
                  {modelView !== 'hidden' && <th>{MODEL_LABELS[modelView]} Put ₹</th>}
                  {modelView !== 'hidden' && <th>Market-Model Put ₹</th>}
                  {visibleGreekKeys.map((key) => (
                    <th key={`put-${key}`}>{GREEK_LABELS[key]} P</th>
                  ))}
                  <th>Put Mid</th>
                  <th>Put LTP</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const oiOpacity = maxOi > 0 ? Math.max(0.08, row.oi / maxOi) : 0;
                  const exposureOpacity = exposureMagnitude > 0
                    ? Math.max(0.12, Math.abs(Number(row.exposureValue) || 0) / exposureMagnitude)
                    : 0;
                  const rowClass = row.isAtm
                    ? 'option-chain-row atm'
                    : row.bucket === 'put-side'
                      ? 'option-chain-row put-side'
                      : 'option-chain-row call-side';
                  const modelSlice = modelView !== 'hidden' ? row.modelSlices?.[modelView] : null;
                  const exposureClass = exposureView === 'vega'
                    ? 'vega'
                    : exposureView === 'charm'
                      ? 'charm'
                      : Number(row.exposureValue) >= 0
                        ? 'positive'
                        : 'negative';
                  return (
                    <tr
                      key={`${expiryIndex}-${row.strike}`}
                      className={`${rowClass}${row.isFlipZone ? ' flip-zone' : ''}${row.isWall ? ' wall-zone' : ''}`}
                    >
                      <td className="option-chain-center">{formatNumber(row.callLtp, 2)}</td>
                      <td className="option-chain-center">{formatNumber(row.callMid, 2)}</td>
                      <td className="call-side option-chain-center">{formatRsValue(row.callNotional)}</td>
                      {modelView !== 'hidden' && <td className="option-chain-center">{modelSlice?.callPrice != null ? formatRsValue(modelSlice.callPrice * lotSize) : '-'}</td>}
                      {modelView !== 'hidden' && <td className="option-chain-center">{modelSlice?.callPrice != null ? formatRsValue((row.callDisplayPrice - modelSlice.callPrice) * lotSize) : '-'}</td>}
                      {visibleGreekKeys.map((key) => (
                        <td key={`call-${row.strike}-${key}`} className="option-chain-center">
                          {row.callGreeks ? formatNumber(row.callGreeks[key], key === 'gamma' ? 5 : 3) : '-'}
                        </td>
                      ))}
                      <td className="strike-cell">
                        <div>{formatNumber(row.strike, 0)}</div>
                        <small>{row.isAtm ? 'ATM' : `${row.distance > 0 ? '+' : ''}${formatNumber(row.distance, 0)}`}</small>
                      </td>
                      {exposureView !== 'hidden' && (
                        <td className={`option-chain-center exposure-cell ${exposureClass}`}>
                          <span>{formatSignedRs(row.exposureValue)}</span>
                          <div className="exposure-bar">
                            <div className={`exposure-bar-fill ${exposureClass}`} style={{ opacity: exposureOpacity }} />
                          </div>
                        </td>
                      )}
                      {exposureView !== 'hidden' && (
                        <td className="option-chain-center">
                          <span className={`exposure-tag ${row.exposureTag === 'Flip Zone' ? 'flip' : row.exposureTag.includes('Wall') ? 'wall' : exposureClass}`}>{row.exposureTag}</span>
                        </td>
                      )}
                      <td className="option-chain-center">{row.sigmaDistance != null ? `${formatNumber(row.sigmaDistance, 2)}σ` : '-'}</td>
                      <td className="option-chain-center">{row.callProbItm != null ? `${formatNumber(row.callProbItm * 100, 1)}%` : '-'}</td>
                      <td className="option-chain-center">{row.putProbItm != null ? `${formatNumber(row.putProbItm * 100, 1)}%` : '-'}</td>
                      <td className="option-chain-center">{row.iv > 0 ? `${formatNumber(row.iv * 100, 2)}%` : '-'}</td>
                      {modelView !== 'hidden' && <td className="option-chain-center">{modelSlice?.iv > 0 ? `${formatNumber(modelSlice.iv * 100, 2)}%` : '-'}</td>}
                      {modelView !== 'hidden' && <td className="option-chain-center">{modelSlice?.iv > 0 && row.iv > 0 ? `${formatNumber((row.iv - modelSlice.iv) * 100, 2)} pts` : '-'}</td>}
                      <td className="option-chain-center">
                        <div className="oi-cell">
                          <span>{formatNumber(row.oi, 0)}</span>
                          <div className="oi-bar">
                            <div className="oi-bar-fill" style={{ opacity: oiOpacity }} />
                          </div>
                        </div>
                      </td>
                      <td className="option-chain-center">{formatRsValue(row.straddleNotional)}</td>
                      <td className="put-side option-chain-center">{formatRsValue(row.putNotional)}</td>
                      {modelView !== 'hidden' && <td className="option-chain-center">{modelSlice?.putPrice != null ? formatRsValue(modelSlice.putPrice * lotSize) : '-'}</td>}
                      {modelView !== 'hidden' && <td className="option-chain-center">{modelSlice?.putPrice != null ? formatRsValue((row.putDisplayPrice - modelSlice.putPrice) * lotSize) : '-'}</td>}
                      {visibleGreekKeys.map((key) => (
                        <td key={`put-${row.strike}-${key}`} className="option-chain-center">
                          {row.putGreeks ? formatNumber(row.putGreeks[key], key === 'gamma' ? 5 : 3) : '-'}
                        </td>
                      ))}
                      <td className="option-chain-center">{formatNumber(row.putMid, 2)}</td>
                      <td className="option-chain-center">{formatNumber(row.putLtp, 2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </SnapshotGuard>
  );
}
