import React, { useEffect, useMemo, useRef, useState } from 'react';
import GreekVsStrikesGRG from './GreekVsStrikesGRG.jsx';
import Plot from '../ThemedPlot';
import { Panel, SnapshotGuard, formatNumber, formatPct } from './shared.jsx';

function logGamma(z) {
  const coeffs = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019571e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  let x = 0.9999999999998099;
  const tZ = z - 1;
  for (let i = 0; i < coeffs.length; i += 1) {
    x += coeffs[i] / (tZ + i + 1);
  }
  const t = tZ + coeffs.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (tZ + 0.5) * Math.log(t) - t + Math.log(x);
}

function betacf(a, b, x) {
  const maxIter = 100;
  const eps = 3e-7;
  const fpMin = 1e-30;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpMin) d = fpMin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

function regIncompleteBeta(x, a, b) {
  if (!(x >= 0 && x <= 1)) return NaN;
  if (x === 0 || x === 1) return x;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

function studentTCdf(t, df) {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return NaN;
  const x = df / (df + t * t);
  const ib = regIncompleteBeta(x, df / 2, 0.5);
  if (!Number.isFinite(ib)) return NaN;
  return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

function fCdf(f, d1, d2) {
  if (!Number.isFinite(f) || !Number.isFinite(d1) || !Number.isFinite(d2) || f < 0 || d1 <= 0 || d2 <= 0) return NaN;
  const x = (d1 * f) / (d1 * f + d2);
  return regIncompleteBeta(x, d1 / 2, d2 / 2);
}

function alignRightSeries(values, targetLength) {
  const source = Array.isArray(values) ? values : [];
  const aligned = Array.from({ length: Math.max(0, targetLength) }, () => null);
  if (!source.length || !targetLength) {
    return aligned;
  }
  const offset = Math.max(0, targetLength - source.length);
  for (let idx = 0; idx < targetLength; idx += 1) {
    const sourceIndex = idx - offset;
    if (sourceIndex >= 0 && sourceIndex < source.length) {
      const value = Number(source[sourceIndex]);
      aligned[idx] = Number.isFinite(value) ? value : null;
    }
  }
  return aligned;
}

function interpolateMissingSeries(values, treatZeroAsMissing = true) {
  const source = Array.isArray(values)
    ? values.map((value) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        if (treatZeroAsMissing && Math.abs(n) < 1e-12) return null;
        return n;
      })
    : [];
  if (!source.length) return [];

  const out = [...source];
  const validIdx = [];
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] != null) validIdx.push(i);
  }
  if (!validIdx.length) {
    return out;
  }

  // Fill leading/trailing gaps with nearest valid value.
  for (let i = 0; i < validIdx[0]; i += 1) out[i] = out[validIdx[0]];
  for (let i = validIdx[validIdx.length - 1] + 1; i < out.length; i += 1) out[i] = out[validIdx[validIdx.length - 1]];

  // Linear interpolation for interior gaps.
  for (let k = 0; k < validIdx.length - 1; k += 1) {
    const left = validIdx[k];
    const right = validIdx[k + 1];
    const leftVal = Number(out[left]);
    const rightVal = Number(out[right]);
    const gap = right - left;
    if (gap <= 1) continue;
    for (let i = 1; i < gap; i += 1) {
      out[left + i] = leftVal + ((rightVal - leftVal) * i) / gap;
    }
  }
  return out;
}

function buildRegression(xs, ys) {
  const xSeries = Array.isArray(xs) ? xs : [];
  const ySeries = Array.isArray(ys) ? ys : [];
  const n = Math.min(xSeries.length, ySeries.length);
  // Align on overlapping tail so different-length series compare on recent common window.
  const xStart = Math.max(0, xSeries.length - n);
  const yStart = Math.max(0, ySeries.length - n);
  const points = [];
  for (let idx = 0; idx < n; idx += 1) {
    const x = Number(xSeries[xStart + idx]);
    const y = Number(ySeries[yStart + idx]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ x, y });
    }
  }
  if (points.length < 3) {
    return {
      points,
      slope: 0,
      intercept: 0,
      r2: null,
      lineX: [],
      lineY: [],
      epsilonStd: null,
      stdX: null,
      stdY: null,
      covXY: null,
      varX: null,
      varY: null,
      df: 0,
      fStat: null,
      pF: null,
      tBeta: null,
      pBeta: null,
      tAlpha: null,
      pAlpha: null,
    };
  }

  const meanX = points.reduce((acc, p) => acc + p.x, 0) / points.length;
  const meanY = points.reduce((acc, p) => acc + p.y, 0) / points.length;
  let num = 0;
  let den = 0;
  let denY = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    num += dx * (point.y - meanY);
    den += dx * dx;
    denY += dy * dy;
  }
  const slope = den > 1e-12 ? num / den : 0;
  const intercept = meanY - slope * meanX;
  const predicted = points.map((p) => slope * p.x + intercept);
  const ssRes = points.reduce((acc, p, i) => acc + (p.y - predicted[i]) ** 2, 0);
  const ssTot = points.reduce((acc, p) => acc + (p.y - meanY) ** 2, 0);
  const ssReg = Math.max(0, ssTot - ssRes);
  const r2 = ssTot > 1e-12 ? Math.max(0, 1 - ssRes / ssTot) : null;
  const epsilonStd = points.length > 2 ? Math.sqrt(ssRes / (points.length - 2)) : null;
  const varX = points.length ? den / points.length : null;
  const varY = points.length ? denY / points.length : null;
  const covXY = points.length ? num / points.length : null;
  const stdX = varX != null ? Math.sqrt(Math.max(varX, 0)) : null;
  const stdY = varY != null ? Math.sqrt(Math.max(varY, 0)) : null;
  const df = points.length - 2;
  const mse = df > 0 ? ssRes / df : null;
  const fStat = mse != null && mse > 1e-14 ? ssReg / mse : null;
  const pF = fStat != null && df > 0 ? 1 - fCdf(fStat, 1, df) : null;
  const seBeta = mse != null && den > 1e-14 ? Math.sqrt(mse / den) : null;
  const tBeta = seBeta != null && seBeta > 1e-14 ? slope / seBeta : null;
  const pBeta = tBeta != null && df > 0 ? 2 * (1 - studentTCdf(Math.abs(tBeta), df)) : null;
  const seAlpha = mse != null && den > 1e-14 ? Math.sqrt(mse * (1 / points.length + (meanX * meanX) / den)) : null;
  const tAlpha = seAlpha != null && seAlpha > 1e-14 ? intercept / seAlpha : null;
  const pAlpha = tAlpha != null && df > 0 ? 2 * (1 - studentTCdf(Math.abs(tAlpha), df)) : null;

  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  return {
    points,
    slope,
    intercept,
    r2,
    epsilonStd,
    stdX,
    stdY,
    covXY,
    varX,
    varY,
    df,
    fStat,
    pF,
    tBeta,
    pBeta,
    tAlpha,
    pAlpha,
    lineX: [minX, maxX],
    lineY: [slope * minX + intercept, slope * maxX + intercept],
  };
}

function interpolateTermValue(days, values, targetDay) {
  const x = Array.isArray(days) ? days.map((value) => Number(value)) : [];
  const y = Array.isArray(values) ? values.map((value) => Number(value)) : [];
  if (!x.length || !y.length || x.length !== y.length) {
    return null;
  }
  if (x.length === 1) {
    return Number.isFinite(y[0]) ? y[0] : null;
  }
  if (targetDay <= x[0]) {
    return Number.isFinite(y[0]) ? y[0] : null;
  }
  if (targetDay >= x[x.length - 1]) {
    return Number.isFinite(y[y.length - 1]) ? y[y.length - 1] : null;
  }
  for (let idx = 0; idx < x.length - 1; idx += 1) {
    const leftX = x[idx];
    const rightX = x[idx + 1];
    const leftY = y[idx];
    const rightY = y[idx + 1];
    if (!Number.isFinite(leftX) || !Number.isFinite(rightX) || !Number.isFinite(leftY) || !Number.isFinite(rightY)) {
      continue;
    }
    if (targetDay >= leftX && targetDay <= rightX) {
      const weight = rightX === leftX ? 0 : (targetDay - leftX) / (rightX - leftX);
      return leftY + (rightY - leftY) * weight;
    }
  }
  return null;
}

// ── BSM Greeks helpers ─────────────────────────────────────────────────
function ncdf(x) {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t) * Math.exp(-x*x);
  return 0.5*(1+sign*y);
}
function npdf(x) { return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI); }
function bsmGreeks(S, K, T, sigma, r, isCall) {
  if (!S||!K||T<=0||sigma<=0) return null;
  const sq=Math.sqrt(T);
  const d1=(Math.log(S/K)+(r+0.5*sigma*sigma)*T)/(sigma*sq);
  const d2=d1-sigma*sq;
  const Nd1=ncdf(d1), Nd2=ncdf(d2), nd1=npdf(d1), DF=Math.exp(-r*T);
  const rhoRaw = isCall ? (K * T * DF * Nd2) / 100 : (-K * T * DF * (1 - Nd2)) / 100;
  return {
    iv: sigma*100,
    delta: Math.abs(isCall ? Nd1 : Nd1-1),
    gamma: nd1/(S*sigma*sq),
    theta: Math.abs((isCall ? -S*nd1*sigma/(2*sq)-r*K*DF*Nd2 : -S*nd1*sigma/(2*sq)+r*K*DF*(1-Nd2))/365),
    rho: Math.abs(rhoRaw),
    vega:  S*nd1*sq/100,
    price: isCall ? S*Nd1-K*DF*Nd2 : K*DF*(1-Nd2)-S*(1-Nd1),
  };
}
// ────────────────────────────────────────────────────────────────────────

export default function MarketPage({ loading = false, activeSnapshotId = null, market = {}, surface = {}, selectedExpiryIndex = 0 }) {
  // Legend visibility for GRG
  const [grgShowLegend, setGrgShowLegend] = useState(true);
  const [selectedModel, setSelectedModel] = useState('GARCH');
  const [scatterXKey, setScatterXKey] = useState('hv20');
  const [scatterYKey, setScatterYKey] = useState('iv_proxy');
  const [vrpBasis, setVrpBasis] = useState('atm_iv_rv20');
  const [vrpLogValues, setVrpLogValues] = useState(false);
  const [strikeRange, setStrikeRange] = useState(500);
  const [skewExpiryIndex, setSkewExpiryIndex] = useState(selectedExpiryIndex);
  const [skewCompareAll, setSkewCompareAll] = useState(false);
  const [skewHiddenExpiries, setSkewHiddenExpiries] = useState(new Set());
  const [skewYAxisMetric, setSkewYAxisMetric] = useState('iv_pct');
  const [priceCompExpiryIndex, setPriceCompExpiryIndex] = useState(selectedExpiryIndex);
  const [priceCompStrikeRange, setPriceCompStrikeRange] = useState(1200);
  const [priceCompSideMode, setPriceCompSideMode] = useState('both');
  const [priceCompShowLabels, setPriceCompShowLabels] = useState(true);
  const priceCompLegendStateRef = useRef({});
  const [grgStrikeIdx, setGrgStrikeIdx] = useState(null);   // null = auto ATM
  const [grgOptionType, setGrgOptionType] = useState('call'); // 'call' | 'put'

  useEffect(() => {
    setSkewExpiryIndex(selectedExpiryIndex);
    setPriceCompExpiryIndex(selectedExpiryIndex);
  }, [selectedExpiryIndex]);

  const strikeGrid = Array.isArray(surface?.strike_grid) ? surface.strike_grid : [];
  const marketMatrix = Array.isArray(surface?.market_iv_matrix) ? surface.market_iv_matrix : [];
  const callMarketPriceMatrix = Array.isArray(surface?.call_market_price_matrix) ? surface.call_market_price_matrix : [];
  const putMarketPriceMatrix = Array.isArray(surface?.put_market_price_matrix) ? surface.put_market_price_matrix : [];
  const callLtpMatrix = Array.isArray(surface?.call_ltp_matrix) ? surface.call_ltp_matrix : [];
  const putLtpMatrix = Array.isArray(surface?.put_ltp_matrix) ? surface.put_ltp_matrix : [];
  const callMidMatrix = Array.isArray(surface?.call_mid_matrix) ? surface.call_mid_matrix : [];
  const putMidMatrix = Array.isArray(surface?.put_mid_matrix) ? surface.put_mid_matrix : [];
  const spot = Number(market?.spot ?? 0);

  // Expiry options for the skew curve dropdown
  const maturityGrid = Array.isArray(surface?.maturity_grid) ? surface.maturity_grid : [];
  const expiryList = Array.isArray(surface?.expiry_list) ? surface.expiry_list : [];

  const getMatrixPrice = (matrix, expiryIdx, strikeIdx) => {
    const row = Array.isArray(matrix?.[expiryIdx]) ? matrix[expiryIdx] : null;
    const value = Number(row?.[strikeIdx]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  const getPreferredOptionPrice = (expiryIdx, strikeIdx, side) => {
    const isCall = side === 'call';
    const marketPrice = getMatrixPrice(
      isCall ? callMarketPriceMatrix : putMarketPriceMatrix,
      expiryIdx,
      strikeIdx,
    );
    if (marketPrice != null) return marketPrice;

    const ltpPrice = getMatrixPrice(isCall ? callLtpMatrix : putLtpMatrix, expiryIdx, strikeIdx);
    if (ltpPrice != null) return ltpPrice;

    return getMatrixPrice(isCall ? callMidMatrix : putMidMatrix, expiryIdx, strikeIdx);
  };
  const skewExpiryOptions = maturityGrid.map((t, i) => {
    const days = Math.max(1, Math.round(Number(t) * 365));
    const label = expiryList[i] ? `${expiryList[i]} (${days}D)` : `${days}D`;
    return { value: i, label };
  });

  // Build clean, sorted skew curve data using skewExpiryIndex
  const safeSkewIndex = Math.min(skewExpiryIndex, Math.max(0, marketMatrix.length - 1));
  const skewMarketSlice = marketMatrix[safeSkewIndex] || marketMatrix[0] || [];
  const sortedIndices = strikeGrid
    .map((s, i) => ({ s: Number(s), i }))
    .filter(({ s }) => Number.isFinite(s))
    .sort((a, b) => a.s - b.s);
  const sortedStrikes = sortedIndices.map(({ s }) => s);
  // Auto-detect ATM as the strike closest to spot
  const atmStrike = sortedStrikes.length && spot > 0
    ? sortedStrikes.reduce((best, s) => Math.abs(s - spot) < Math.abs(best - spot) ? s : best, sortedStrikes[0])
    : null;
  const termDays = Array.isArray(market?.term_structure_days) ? market.term_structure_days : [];
  const termMarketAtm = Array.isArray(market?.term_structure_market_atm) ? market.term_structure_market_atm : [];
  const termModelAtm = Array.isArray(market?.term_structure_model_atm) ? market.term_structure_model_atm : [];
  const hasSingleExpiry = termDays.length <= 1;
  const history = market?.price_history || null;
  const hasHistory = Boolean(history && Array.isArray(history.dates) && history.dates.length > 2);

  const rv20Series = hasHistory ? history.rv20_annualized : [];
  const rv60Series = hasHistory ? history.rv60_annualized : [];
  const closeSeries = hasHistory ? (history.close || []).map((value) => Number(value)).filter(Number.isFinite) : [];
  const normalReturnsSeries = useMemo(() => {
    if (closeSeries.length < 2) return [];
    const out = [];
    for (let idx = 1; idx < closeSeries.length; idx += 1) {
      const prev = closeSeries[idx - 1];
      const curr = closeSeries[idx];
      out.push(prev !== 0 ? (curr - prev) / prev : null);
    }
    return out;
  }, [closeSeries]);
  const logReturnsSeries = useMemo(() => {
    if (closeSeries.length < 2) return [];
    const out = [];
    for (let idx = 1; idx < closeSeries.length; idx += 1) {
      const prev = closeSeries[idx - 1];
      const curr = closeSeries[idx];
      out.push(prev > 0 && curr > 0 ? Math.log(curr / prev) : null);
    }
    return out;
  }, [closeSeries]);
  const volumeSeries = hasHistory ? history.volume || [] : [];
  const spotSpreadPct = market?.atm_iv && market?.rv_20d ? ((Number(market.atm_iv) - Number(market.rv_20d)) * 100) : null;
  const forecastBundle = market?.vol_model_forecasts || null;
  const forecastDates = Array.isArray(forecastBundle?.dates) ? forecastBundle.dates : [];
  const modelForecasts = forecastBundle?.models && typeof forecastBundle.models === 'object' ? forecastBundle.models : {};
  const modelKeys = useMemo(() => Object.keys(modelForecasts), [modelForecasts]);
  const hv20Series = Array.isArray(forecastBundle?.hv20) ? forecastBundle.hv20 : [];
  const ivProxySeriesRaw = Array.isArray(forecastBundle?.iv_proxy) ? forecastBundle.iv_proxy : [];
  const ivProxySeries = useMemo(() => interpolateMissingSeries(ivProxySeriesRaw, true), [ivProxySeriesRaw]);
  const atmIvSeries = useMemo(() => {
    if (!hasHistory || !Array.isArray(history?.dates)) {
      return [];
    }
    const count = history.dates.length;
    const aligned = interpolateMissingSeries(alignRightSeries(ivProxySeries, count), true);

    const fallback = Number(market?.atm_iv);
    if (!aligned.some((value) => value != null) && Number.isFinite(fallback)) {
      return Array.from({ length: count }, () => fallback);
    }
    return aligned;
  }, [hasHistory, history, ivProxySeries, market?.atm_iv]);
  const ivProxyAlignedSeries = useMemo(() => {
    if (!hasHistory || !Array.isArray(history?.dates)) {
      return [];
    }
    const count = history.dates.length;
    return interpolateMissingSeries(alignRightSeries(ivProxySeries, count), true);
  }, [hasHistory, history, ivProxySeries]);
  const hv20AlignedSeries = useMemo(() => {
    if (!hasHistory || !Array.isArray(history?.dates)) {
      return [];
    }
    const count = history.dates.length;
    const source = Array.isArray(hv20Series) ? hv20Series : [];
    const aligned = Array.from({ length: count }, () => null);
    if (source.length) {
      const offset = Math.max(0, count - source.length);
      for (let idx = 0; idx < count; idx += 1) {
        const sourceIndex = idx - offset;
        if (sourceIndex >= 0 && sourceIndex < source.length) {
          const value = Number(source[sourceIndex]);
          aligned[idx] = Number.isFinite(value) ? value : null;
        }
      }
    }
    return aligned;
  }, [hasHistory, history, hv20Series]);

  useEffect(() => {
    if (!modelKeys.length) return;
    if (!modelKeys.includes(selectedModel)) {
      setSelectedModel(modelKeys[0]);
    }
  }, [modelKeys, selectedModel]);

  const selectedModelPayload = modelForecasts[selectedModel] || null;
  const hasForecastData = Boolean(
    forecastDates.length &&
    (
      hv20Series.some((value) => Number.isFinite(Number(value))) ||
      modelKeys.some((key) => {
        const series = modelForecasts?.[key]?.rv_series || [];
        return Array.isArray(series) && series.some((value) => Number.isFinite(Number(value)));
      })
    ),
  );
  const regressionInputMap = useMemo(() => {
    const map = {
      hv20: { label: 'HV20', values: hv20Series },
      iv_proxy: { label: 'IV Proxy', values: ivProxySeries },
      returns: { label: 'Returns', values: normalReturnsSeries },
      log_returns: { label: 'Log Returns', values: logReturnsSeries },
    };
    for (const key of modelKeys) {
      const payload = modelForecasts[key] || {};
      map[`${key}_rv`] = { label: `${key} RV`, values: Array.isArray(payload.rv_series) ? payload.rv_series : [] };
      map[`${key}_iv`] = { label: `${key} IV`, values: Array.isArray(payload.iv_series) ? payload.iv_series : [] };
    }
    return map;
  }, [hv20Series, ivProxySeries, normalReturnsSeries, logReturnsSeries, modelKeys, modelForecasts]);

  const regressionOptions = Object.entries(regressionInputMap).map(([value, meta]) => ({ value, label: meta.label }));
  const regressionX = regressionInputMap[scatterXKey]?.values || [];
  const regressionY = regressionInputMap[scatterYKey]?.values || [];
  const regression = useMemo(() => buildRegression(regressionX, regressionY), [regressionX, regressionY]);
  const rvRegimeTintShapes = useMemo(() => {
    if (!hasHistory || !Array.isArray(history?.dates) || history.dates.length < 2) {
      return [];
    }

    const shapes = [];
    for (let idx = 1; idx < history.dates.length; idx += 1) {
      const rv20 = Number(rv20Series[idx]);
      const rv60 = Number(rv60Series[idx]);
      if (!Number.isFinite(rv20) || !Number.isFinite(rv60)) {
        continue;
      }

      // Red tint when short-term RV is above long-term RV (stress regime),
      // green tint when short-term RV is below/around long-term RV.
      const tint = rv20 > rv60 ? 'rgba(239, 68, 68, 0.10)' : 'rgba(34, 197, 94, 0.10)';
      shapes.push({
        type: 'rect',
        xref: 'x',
        yref: 'paper',
        x0: history.dates[idx - 1],
        x1: history.dates[idx],
        y0: 0,
        y1: 1,
        fillcolor: tint,
        line: { width: 0 },
        layer: 'below',
      });
    }

    return shapes;
  }, [hasHistory, history, rv20Series, rv60Series]);
  const priceChartData = useMemo(() => {
    if (!hasHistory) {
      return [
        {
          type: 'scatter',
          mode: 'lines+markers',
          x: ['t-1', 't'],
          y: [spot, spot],
          line: { color: '#f59e0b', width: 2 },
          name: 'Spot',
        },
      ];
    }

    return [
      {
        type: 'candlestick',
        x: history.dates,
        open: history.open,
        high: history.high,
        low: history.low,
        close: history.close,
        name: 'Price',
        increasing: { line: { color: '#22c55e' } },
        decreasing: { line: { color: '#ef4444' } },
      },
      {
        type: 'bar',
        x: history.dates,
        y: volumeSeries,
        name: 'Volume',
        yaxis: 'y2',
        marker: { color: '#334155', opacity: 0.7 },
      },
      {
        type: 'scatter',
        mode: 'lines',
        x: history.dates,
        y: rv20Series,
        name: '20D RV',
        yaxis: 'y3',
        line: { color: '#38bdf8', width: 1.5 },
      },
      {
        type: 'scatter',
        mode: 'lines',
        x: history.dates,
        y: rv60Series,
        name: '60D RV',
        yaxis: 'y3',
        line: { color: '#f59e0b', width: 1.5 },
      },
      {
        type: 'scatter',
        mode: 'lines',
        x: history.dates,
        y: atmIvSeries,
        name: 'ATM IV',
        yaxis: 'y3',
        line: { color: '#ef4444', width: 1.8 },
      },
    ];
  }, [hasHistory, spot, history, volumeSeries, rv20Series, rv60Series, atmIvSeries]);
  const vrpAreaSeries = useMemo(() => {
    if (!hasHistory || !Array.isArray(history?.dates)) {
      return { dates: [], values: [], positive: [], negative: [], basisLabel: '' };
    }
    const basisLabelMap = {
      atm_iv_rv20: 'ATM IV - RV20',
      atm_iv_rv60: 'ATM IV - RV60',
      iv_proxy_hv20: 'IV Proxy - HV20',
      model_iv_model_rv: `${selectedModel} IV - ${selectedModel} RV`,
    };

    const modelIvSeries = Array.isArray(selectedModelPayload?.iv_series) ? selectedModelPayload.iv_series : [];
    const modelRvSeries = Array.isArray(selectedModelPayload?.rv_series) ? selectedModelPayload.rv_series : [];
    const count = history.dates.length;
    const alignRight = (series) => {
      const source = Array.isArray(series) ? series : [];
      const aligned = Array.from({ length: count }, () => null);
      if (!source.length) return aligned;
      const offset = Math.max(0, count - source.length);
      for (let idx = 0; idx < count; idx += 1) {
        const sourceIndex = idx - offset;
        if (sourceIndex >= 0 && sourceIndex < source.length) {
          const value = Number(source[sourceIndex]);
          aligned[idx] = Number.isFinite(value) ? value : null;
        }
      }
      return aligned;
    };

    const modelIvAligned = alignRight(modelIvSeries);
    const modelRvAligned = alignRight(modelRvSeries);

    const dates = history.dates;
    const values = [];
    const positive = [];
    const negative = [];
    for (let idx = 0; idx < dates.length; idx += 1) {
      let iv = null;
      let rv = null;

      if (vrpBasis === 'atm_iv_rv20') {
        iv = Number(atmIvSeries[idx]);
        rv = Number(rv20Series[idx]);
      } else if (vrpBasis === 'atm_iv_rv60') {
        iv = Number(atmIvSeries[idx]);
        rv = Number(rv60Series[idx]);
      } else if (vrpBasis === 'iv_proxy_hv20') {
        iv = Number(ivProxyAlignedSeries[idx]);
        rv = Number(hv20AlignedSeries[idx]);
      } else {
        iv = Number(modelIvAligned[idx]);
        rv = Number(modelRvAligned[idx]);
      }

      if (!Number.isFinite(iv) || !Number.isFinite(rv)) {
        values.push(null);
        positive.push(null);
        negative.push(null);
        continue;
      }
      const vrpPts = (iv - rv) * 100;
      values.push(vrpPts);
      positive.push(vrpPts >= 0 ? vrpPts : null);
      negative.push(vrpPts < 0 ? vrpPts : null);
    }
    return {
      dates,
      values,
      positive,
      negative,
      basisLabel: basisLabelMap[vrpBasis] || basisLabelMap.atm_iv_rv20,
    };
  }, [
    hasHistory,
    history,
    vrpBasis,
    atmIvSeries,
    rv20Series,
    rv60Series,
    ivProxyAlignedSeries,
    hv20AlignedSeries,
    selectedModel,
    selectedModelPayload,
  ]);
  const vrpChartSeries = useMemo(() => {
    const signedLog = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return null;
      }
      return Math.sign(numeric) * Math.log10(1 + Math.abs(numeric));
    };
    if (!vrpLogValues) {
      return vrpAreaSeries;
    }
    return {
      ...vrpAreaSeries,
      values: (vrpAreaSeries.values || []).map(signedLog),
      positive: (vrpAreaSeries.positive || []).map(signedLog),
      negative: (vrpAreaSeries.negative || []).map(signedLog),
    };
  }, [vrpAreaSeries, vrpLogValues]);
  const vrpMetrics = useMemo(() => {
    const values = (vrpAreaSeries.values || []).filter((value) => Number.isFinite(Number(value))).map((value) => Number(value));
    if (!values.length) {
      return {
        latest: null,
        avg5: null,
        avg20: null,
        std20: null,
        hitRatio20: null,
        min20: null,
        max20: null,
        basisLabel: vrpAreaSeries.basisLabel || 'VRP',
      };
    }

    const latest = values[values.length - 1];
    const window5 = values.slice(Math.max(0, values.length - 5));
    const window20 = values.slice(Math.max(0, values.length - 20));
    const avg = (arr) => (arr.length ? arr.reduce((acc, value) => acc + value, 0) / arr.length : null);
    const avg5 = avg(window5);
    const avg20 = avg(window20);
    const std20 = window20.length
      ? Math.sqrt(window20.reduce((acc, value) => acc + (value - (avg20 || 0)) ** 2, 0) / window20.length)
      : null;
    const hitRatio20 = window20.length
      ? (window20.filter((value) => value > 0).length / window20.length) * 100
      : null;
    const min20 = window20.length ? Math.min(...window20) : null;
    const max20 = window20.length ? Math.max(...window20) : null;

    return {
      latest,
      avg5,
      avg20,
      std20,
      hitRatio20,
      min20,
      max20,
      basisLabel: vrpAreaSeries.basisLabel || 'VRP',
    };
  }, [vrpAreaSeries]);
  const diagnostics = useMemo(() => {
    const forwardVrp20 =
      Number.isFinite(Number(selectedModelPayload?.iv_forecast_20d)) &&
      Number.isFinite(Number(selectedModelPayload?.rv_forecast_20d))
        ? (Number(selectedModelPayload.iv_forecast_20d) - Number(selectedModelPayload.rv_forecast_20d)) * 100
        : null;
    const atmRv20 =
      Number.isFinite(Number(market?.atm_iv)) && Number.isFinite(Number(market?.rv_20d))
        ? (Number(market.atm_iv) - Number(market.rv_20d)) * 100
        : null;
    const atmRv60 =
      Number.isFinite(Number(market?.atm_iv)) && Number.isFinite(Number(market?.rv_60d))
        ? (Number(market.atm_iv) - Number(market.rv_60d)) * 100
        : null;

    const lastIvProxy = ivProxyAlignedSeries.length ? Number(ivProxyAlignedSeries[ivProxyAlignedSeries.length - 1]) : null;
    const lastHv20 = hv20AlignedSeries.length ? Number(hv20AlignedSeries[hv20AlignedSeries.length - 1]) : null;
    const ivProxyHv20 =
      Number.isFinite(lastIvProxy) && Number.isFinite(lastHv20)
        ? (lastIvProxy - lastHv20) * 100
        : null;

    const iv7 = interpolateTermValue(termDays, termMarketAtm, 7);
    const iv30 = interpolateTermValue(termDays, termMarketAtm, 30);
    const iv60 = interpolateTermValue(termDays, termMarketAtm, 60);
    const slope30_7 =
      Number.isFinite(iv30) && Number.isFinite(iv7)
        ? (iv30 - iv7) * 100
        : null;
    const slope60_30 =
      Number.isFinite(iv60) && Number.isFinite(iv30)
        ? (iv60 - iv30) * 100
        : null;

    const ivRvRatioSpot =
      Number.isFinite(Number(market?.atm_iv)) && Number.isFinite(Number(market?.rv_20d)) && Number(market.rv_20d) > 0
        ? Number(market.atm_iv) / Number(market.rv_20d)
        : null;
    const percentileGap =
      Number.isFinite(Number(market?.iv_percentile)) && Number.isFinite(Number(market?.rv_percentile))
        ? Number(market.iv_percentile) - Number(market.rv_percentile)
        : null;

    return {
      forwardVrp20,
      atmRv20,
      atmRv60,
      ivProxyHv20,
      slope30_7,
      slope60_30,
      ivRvRatioSpot,
      percentileGap,
    };
  }, [
    selectedModelPayload,
    market,
    ivProxyAlignedSeries,
    hv20AlignedSeries,
    termDays,
    termMarketAtm,
  ]);
  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-market-split">
        <div className="market-plots-stack">
          <Panel title="Price Chart">
            <Plot
              id="price-chart"
              data={priceChartData}
              layout={{
                height: 360,
                margin: { l: 36, r: 40, b: 28, t: 22 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 11 },
                uirevision: 'market-price-chart',
                xaxis: {
                  title: 'Date',
                  gridcolor: '#1f2937',
                  rangeslider: { visible: hasHistory },
                },
                yaxis: { title: 'Price', gridcolor: '#1f2937' },
                yaxis2: {
                  title: 'Volume',
                  overlaying: 'y',
                  side: 'right',
                  showgrid: false,
                  zeroline: false,
                },
                yaxis3: {
                  title: 'RV',
                  overlaying: 'y',
                  side: 'right',
                  gridcolor: '#1f2937',
                  tickformat: '.2f',
                  position: 0.94,
                },
                shapes: rvRegimeTintShapes,
                showlegend: true,
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
            <div className="kv-grid two-col compact">
              <div data-report-metric="rv20"><span>20D RV</span><strong>{formatPct(market?.rv_20d, 2)}</strong></div>
              <div data-report-metric="rv60"><span>60D RV</span><strong>{formatPct(market?.rv_60d, 2)}</strong></div>
              <div data-report-metric="volume-last"><span>Volume (last)</span><strong>{formatNumber(volumeSeries[volumeSeries.length - 1], 0)}</strong></div>
              <div data-report-metric="atm-iv-rv20"><span>ATM IV - 20D RV (pts)</span><strong>{spotSpreadPct !== null ? formatNumber(spotSpreadPct, 2) : '-'}</strong></div>
            </div>
          </Panel>
          <Panel title="Volatility Summary">
            <div className="market-summary-strip">
              <section className="market-summary-section">
                <h4>Realized Vol</h4>
                <div className="kv-grid two-col market-metrics-grid">
                  <div data-report-metric="rv10"><span>10D RV</span><strong>{formatPct(market?.rv_10d, 2)}</strong></div>
                  <div data-report-metric="rv20"><span>20D RV</span><strong>{formatPct(market?.rv_20d, 2)}</strong></div>
                  <div data-report-metric="rv60"><span>60D RV</span><strong>{formatPct(market?.rv_60d, 2)}</strong></div>
                  <div data-report-metric="rv-percentile"><span>RV Percentile</span><strong>{formatNumber(market?.rv_percentile, 2)}%</strong></div>
                </div>
              </section>
              <section className="market-summary-section">
                <h4>Regime</h4>
                <div className="kv-grid two-col market-metrics-grid">
                  <div data-report-metric="trend-regime"><span>Trend Regime</span><strong style={{color: market?.regime?.label === 'high_vol' ? '#ef4444' : '#22c55e'}}>{market?.regime?.label || '-'}</strong></div>
                  <div data-report-metric="vol-regime-score"><span>Vol Regime (IV/RV)</span><strong>{market?.regime?.volatility_regime_score != null ? Number(market.regime.volatility_regime_score).toFixed(2) + 'x' : '-'}</strong></div>
                  <div data-report-metric="skew-regime-score"><span>Skew (Put-Call)</span><strong>{market?.regime?.skew_regime_score != null ? (Number(market.regime.skew_regime_score) * 100).toFixed(2) + ' pts' : '-'}</strong></div>
                  <div data-report-metric="regime-confidence"><span>Confidence</span><strong>{market?.regime?.confidence != null ? (Number(market.regime.confidence) * 100).toFixed(1) + '%' : '-'}</strong></div>
                </div>
              </section>
              <section className="market-summary-section">
                <h4>Vol Stats</h4>
                <div className="kv-grid two-col market-metrics-grid">
                  <div data-report-metric="atm-market-iv"><span>ATM Market IV</span><strong style={{color:'#f59e0b'}}>{market?.atm_iv != null ? (Number(market.atm_iv) * 100).toFixed(2) + '%' : '-'}</strong></div>
                  <div data-report-metric="atm-model-iv"><span>ATM Model IV</span><strong>{market?.atm_model_iv != null ? (Number(market.atm_model_iv) * 100).toFixed(2) + '%' : '-'}</strong></div>
                  <div data-report-metric="iv-rank"><span>IV Rank</span><strong>{market?.iv_rank != null ? Number(market.iv_rank).toFixed(1) + '%' : '-'}</strong></div>
                  <div data-report-metric="iv-percentile"><span>IV Percentile</span><strong>{market?.iv_percentile != null ? Number(market.iv_percentile).toFixed(1) + '%' : '-'}</strong></div>
                  <div data-report-metric="iv-rv-spread"><span>IV-RV Spread</span><strong style={{color: Number(market?.realized_implied_spread ?? 0) >= 0 ? '#22c55e' : '#ef4444'}}>{market?.realized_implied_spread != null ? (Number(market.realized_implied_spread) * 100).toFixed(2) + ' pts' : '-'}</strong></div>
                  <div data-report-metric="vvix-equivalent"><span>VVIX Equivalent</span><strong>{market?.vvix_equivalent != null ? (Number(market.vvix_equivalent) * 100).toFixed(2) + '%' : '-'}</strong></div>
                </div>
              </section>
              <section className="market-summary-section">
                <h4>Diagnostics</h4>
                <div className="kv-grid two-col market-metrics-grid">
                  <div data-report-metric="forward-vrp-20d"><span>Forward VRP 20D ({selectedModel})</span><strong style={{color: Number(diagnostics.forwardVrp20 ?? 0) >= 0 ? '#22c55e' : '#ef4444'}}>{diagnostics.forwardVrp20 != null ? `${formatNumber(diagnostics.forwardVrp20, 2)} pts` : '-'}</strong></div>
                  <div data-report-metric="spot-vrp-atm-iv-rv20"><span>Spot VRP (ATM IV - RV20)</span><strong style={{color: Number(diagnostics.atmRv20 ?? 0) >= 0 ? '#22c55e' : '#ef4444'}}>{diagnostics.atmRv20 != null ? `${formatNumber(diagnostics.atmRv20, 2)} pts` : '-'}</strong></div>
                  <div data-report-metric="spot-vrp-atm-iv-rv60"><span>Spot VRP (ATM IV - RV60)</span><strong style={{color: Number(diagnostics.atmRv60 ?? 0) >= 0 ? '#22c55e' : '#ef4444'}}>{diagnostics.atmRv60 != null ? `${formatNumber(diagnostics.atmRv60, 2)} pts` : '-'}</strong></div>
                  <div data-report-metric="spot-vrp-ivproxy-hv20"><span>Spot VRP (IV Proxy - HV20)</span><strong style={{color: Number(diagnostics.ivProxyHv20 ?? 0) >= 0 ? '#22c55e' : '#ef4444'}}>{diagnostics.ivProxyHv20 != null ? `${formatNumber(diagnostics.ivProxyHv20, 2)} pts` : '-'}</strong></div>
                  <div data-report-metric="term-slope-iv30-iv7"><span>Term Slope (IV30 - IV7)</span><strong>{diagnostics.slope30_7 != null ? `${formatNumber(diagnostics.slope30_7, 2)} pts` : '-'}</strong></div>
                  <div data-report-metric="term-slope-iv60-iv30"><span>Term Slope (IV60 - IV30)</span><strong>{diagnostics.slope60_30 != null ? `${formatNumber(diagnostics.slope60_30, 2)} pts` : '-'}</strong></div>
                  <div data-report-metric="spot-iv-rv20-ratio"><span>Spot IV/RV20 Ratio</span><strong>{diagnostics.ivRvRatioSpot != null ? `${formatNumber(diagnostics.ivRvRatioSpot, 2)}x` : '-'}</strong></div>
                  <div data-report-metric="percentile-gap-iv-rv"><span>Percentile Gap (IV-RV)</span><strong>{diagnostics.percentileGap != null ? `${formatNumber(diagnostics.percentileGap, 1)} pts` : '-'}</strong></div>
                </div>
              </section>
            </div>
          </Panel>
          <Panel title="IV Term Structure">
            <Plot
              id="iv-term-structure-chart"
              data={[
                {
                  type: 'scatter',
                  mode: 'lines+markers',
                  x: termDays,
                  y: termMarketAtm,
                  line: { color: '#22c55e', width: 2 },
                  name: 'Market ATM IV',
                },
                {
                  type: 'scatter',
                  mode: 'lines+markers',
                  x: termDays,
                  y: termModelAtm,
                  line: { color: '#f59e0b', width: 2 },
                  name: 'Model ATM IV',
                },
              ]}
              layout={{
                height: 220,
                margin: { l: 36, r: 12, b: 28, t: 22 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 11 },
                xaxis: { title: 'Days', gridcolor: '#1f2937' },
                yaxis: { title: 'ATM IV', gridcolor: '#1f2937' },
                annotations: hasSingleExpiry
                  ? [
                      {
                        xref: 'paper',
                        yref: 'paper',
                        x: 0.02,
                        y: 0.96,
                        text: 'Single-expiry snapshot: term structure has one point',
                        showarrow: false,
                        font: { color: '#9ca3af', size: 10 },
                      },
                    ]
                  : [],
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </Panel>
          <Panel title="Skew Curve">
            {(() => {
              const COLORS = ['#38bdf8','#22c55e','#f59e0b','#a78bfa','#f472b6','#34d399','#fb923c','#60a5fa','#e879f9','#facc15'];
              const isPriceAxis = skewYAxisMetric === 'combined_price';
              const toIvFraction = (value) => {
                const iv = Number(value);
                if (!Number.isFinite(iv) || iv <= 0) return null;
                return iv <= 2 ? iv : iv / 100;
              };
              const buildPairs = (slice, expiryIdx) => {
                const T_yr = Number(maturityGrid[expiryIdx] ?? 0);
                const ivs = sortedIndices.map(({ i }) => toIvFraction(slice[i]));
                const smoothed = ivs.map((v, idx, arr) => {
                  const vals = [arr[idx - 1], v, arr[idx + 1]].filter((x) => x != null);
                  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
                });
                return sortedIndices
                  .map(({ s, i: strikeIdx }, sortedIdx) => {
                    const iv = smoothed[sortedIdx];
                    if (iv == null) return null;
                    if (atmStrike != null && (s < atmStrike - strikeRange || s > atmStrike + strikeRange)) return null;
                    if (!isPriceAxis) return { s, y: iv };

                    const callMarketPrice = getPreferredOptionPrice(expiryIdx, strikeIdx, 'call');
                    const putMarketPrice = getPreferredOptionPrice(expiryIdx, strikeIdx, 'put');
                    if (callMarketPrice != null && putMarketPrice != null) {
                      return { s, y: callMarketPrice + putMarketPrice };
                    }

                    if (!(spot > 0) || !(s > 0) || !(T_yr > 0)) return null;
                    const call = bsmGreeks(spot, s, T_yr, iv, 0.06, true);
                    const put = bsmGreeks(spot, s, T_yr, iv, 0.06, false);
                    if (!call || !put) return null;
                    return { s, y: call.price + put.price };
                  })
                  .filter(Boolean);
              };
              const toggleExpiry = (ei) => {
                setSkewHiddenExpiries((prev) => {
                  const next = new Set(prev);
                  if (next.has(ei)) next.delete(ei); else next.add(ei);
                  return next;
                });
              };
              // Build all-expiry traces for compare mode
              const allExpiryTraces = skewCompareAll
                ? marketMatrix.map((slice, ei) => {
                    if (skewHiddenExpiries.has(ei)) return null;
                    const pairs = buildPairs(slice, ei);
                    return {
                      type: 'scatter',
                      mode: 'lines',
                      x: pairs.map(({ s }) => s),
                      y: pairs.map(({ y }) => y),
                      line: { color: COLORS[ei % COLORS.length], width: 2 },
                      name: skewExpiryOptions[ei]?.label || `Exp ${ei}`,
                      hovertemplate: isPriceAxis
                        ? '<b>%{fullData.name}</b><br>Strike:%{x:,.0f}<br>Combined Price:\u20b9%{y:,.2f}<extra></extra>'
                        : '<b>%{fullData.name}</b><br>Strike:%{x:,.0f}<br>IV:%{y:.2%}<extra></extra>',
                    };
                  }).filter((t) => t && t.x.length > 0)
                : null;
              const singlePairs = buildPairs(skewMarketSlice, safeSkewIndex);
              const plotData = skewCompareAll
                ? allExpiryTraces
                : [{
                    type: 'scatter',
                    mode: 'lines+markers',
                    x: singlePairs.map(({ s }) => s),
                    y: singlePairs.map(({ y }) => y),
                    line: { color: '#38bdf8', width: 2 },
                    name: skewExpiryOptions[skewExpiryIndex]?.label || 'Skew',
                    hovertemplate: isPriceAxis
                      ? '<b>%{fullData.name}</b><br>Strike:%{x:,.0f}<br>Combined Price:\u20b9%{y:,.2f}<extra></extra>'
                      : '<b>%{fullData.name}</b><br>Strike:%{x:,.0f}<br>IV:%{y:.2%}<extra></extra>',
                  }];
              const hasData = plotData && plotData.length > 0 && plotData.some((t) => t.x.length > 0);
              return (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '8px', flexWrap: 'wrap' }}>
                    <span style={{ color: '#9ca3af', fontSize: 12 }}>
                      ATM: <strong style={{ color: '#f59e0b' }}>{atmStrike != null ? atmStrike.toLocaleString() : '-'}</strong>
                      {spot > 0 && <span style={{ color: '#6b7280' }}> (Spot: {spot.toLocaleString()})</span>}
                    </span>
                    {skewExpiryOptions.length > 0 && (
                      <label style={{ color: skewCompareAll ? '#4b5563' : '#9ca3af', fontSize: 12 }}>
                        Expiry
                        <select value={skewExpiryIndex} disabled={skewCompareAll} onChange={(e) => setSkewExpiryIndex(Number(e.target.value))} style={{ marginLeft: '6px', background: '#1f2937', color: skewCompareAll ? '#4b5563' : '#d1d5db', border: '1px solid #374151', borderRadius: 4, padding: '2px 6px' }}>
                          {skewExpiryOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label style={{ color: '#9ca3af', fontSize: 12 }}>
                      Range ±
                      <select value={strikeRange} onChange={(e) => setStrikeRange(Number(e.target.value))} style={{ marginLeft: '6px', background: '#1f2937', color: '#d1d5db', border: '1px solid #374151', borderRadius: 4, padding: '2px 6px' }}>
                        <option value={500}>500</option>
                        <option value={800}>800</option>
                        <option value={1200}>1200</option>
                        <option value={1500}>1500</option>
                      </select>
                    </label>
                    <label style={{ color: '#9ca3af', fontSize: 12 }}>
                      Y Axis
                      <select value={skewYAxisMetric} onChange={(e) => setSkewYAxisMetric(e.target.value)} style={{ marginLeft: '6px', background: '#1f2937', color: '#d1d5db', border: '1px solid #374151', borderRadius: 4, padding: '2px 6px' }}>
                        <option value="iv_pct">IV %</option>
                        <option value="combined_price">Combined Price (Call+Put)</option>
                      </select>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#9ca3af', fontSize: 12, cursor: 'pointer', userSelect: 'none' }}>
                      <input type="checkbox" checked={skewCompareAll} onChange={(e) => { setSkewCompareAll(e.target.checked); setSkewHiddenExpiries(new Set()); }} style={{ accentColor: '#38bdf8' }} />
                      Compare all expiries
                    </label>
                  </div>
                  {skewCompareAll && skewExpiryOptions.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                      {skewExpiryOptions.map((opt) => {
                        const hidden = skewHiddenExpiries.has(opt.value);
                        const color = COLORS[opt.value % COLORS.length];
                        return (
                          <button
                            key={opt.value}
                            onClick={() => toggleExpiry(opt.value)}
                            style={{
                              display: 'flex', alignItems: 'center', gap: '5px',
                              background: hidden ? '#111827' : color + '22',
                              border: `1px solid ${hidden ? '#374151' : color}`,
                              borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
                              color: hidden ? '#4b5563' : color, fontSize: 11,
                              textDecoration: hidden ? 'line-through' : 'none',
                              transition: 'all 0.15s',
                            }}
                          >
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: hidden ? '#374151' : color, display: 'inline-block', flexShrink: 0 }} />
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {!hasData ? (
                    <div style={{ color: '#ef4444', textAlign: 'center' }}>No data available for Skew Curve</div>
                  ) : (
                    <Plot
                      id="skew-curve-chart"
                      data={plotData}
                      layout={{
                        height: 260,
                        margin: { l: 58, r: 12, b: 36, t: 10 },
                        paper_bgcolor: '#0a0f19',
                        plot_bgcolor: '#0a0f19',
                        font: { color: '#d1d5db', size: 11 },
                        xaxis: { title: 'Strike', gridcolor: '#1f2937', tickformat: ',.0f' },
                        yaxis: {
                          title: isPriceAxis ? 'Combined Price (\u20b9)' : 'Implied Vol (%)',
                          gridcolor: '#1f2937',
                          tickformat: isPriceAxis ? ',.2f' : '.1%',
                        },
                        shapes: atmStrike != null ? [{
                          type: 'line',
                          x0: atmStrike, x1: atmStrike, y0: 0, y1: 1, yref: 'paper',
                          line: { color: '#f59e0b', width: 2, dash: 'dash' },
                        }] : [],
                        annotations: atmStrike != null ? [{
                          x: atmStrike, y: 1, yref: 'paper',
                          text: `ATM ${atmStrike.toLocaleString()}`,
                          showarrow: false, font: { color: '#f59e0b', size: 10 },
                          xanchor: 'left', yanchor: 'top',
                        }] : [],
                        showlegend: false,
                      }}
                      config={{ displaylogo: false, responsive: true }}
                      style={{ width: '100%' }}
                      useResizeHandler
                    />
                  )}
                </>
              );
            })()}
          </Panel>
          <Panel title="Price Composition by Strike (Stacked)">
            {(() => {
              const COMP_KEYS = ['delta', 'gamma', 'theta', 'vega', 'rho'];
              const COMP_LABELS = { delta: 'Δ', gamma: 'Γ', theta: 'Θ', vega: 'ν', rho: 'ρ' };
              const CALL_COLORS = { delta: '#15803d', gamma: '#0369a1', theta: '#b45309', vega: '#0f766e', rho: '#5b21b6' };
              const PUT_COLORS = { delta: '#b91c1c', gamma: '#9d174d', theta: '#9a3412', vega: '#be123c', rho: '#6b21a8' };
              const safeExpiryIdx = Math.min(priceCompExpiryIndex, Math.max(0, marketMatrix.length - 1));
              const T_yr = Number(maturityGrid[safeExpiryIdx] ?? 0);
              const ivRow = marketMatrix[safeExpiryIdx] || [];

              const toIvFraction = (value) => {
                const iv = Number(value);
                if (!Number.isFinite(iv) || iv <= 0) return null;
                return iv <= 2 ? iv : iv / 100;
              };

              const splitPriceByGreeks = (greeks, marketPrice = null) => {
                const market = Number(marketPrice);
                const model = Number(greeks?.price);
                const price = Number.isFinite(market) && market > 0 ? market : model;
                if (!Number.isFinite(price) || price <= 0) return null;
                const deltaShock = Math.abs(Number(greeks?.delta) * spot * 0.01);
                const gammaShock = Math.abs(0.5 * Number(greeks?.gamma) * (spot * 0.01) * (spot * 0.01));
                const thetaShock = Math.abs(Number(greeks?.theta));
                const vegaShock = Math.abs(Number(greeks?.vega));
                const rhoShock = Math.abs(Number(greeks?.rho));
                const shockMap = { delta: deltaShock, gamma: gammaShock, theta: thetaShock, vega: vegaShock, rho: rhoShock };
                const shockTotal = COMP_KEYS.reduce((acc, key) => acc + (Number.isFinite(shockMap[key]) ? shockMap[key] : 0), 0);
                if (!(shockTotal > 1e-12)) {
                  return {
                    price,
                    compPrice: { delta: price / 5, gamma: price / 5, theta: price / 5, vega: price / 5, rho: price / 5 },
                    compPct: { delta: 20, gamma: 20, theta: 20, vega: 20, rho: 20 },
                  };
                }
                const compPrice = {};
                const compPct = {};
                COMP_KEYS.forEach((key) => {
                  const ratio = (shockMap[key] || 0) / shockTotal;
                  compPrice[key] = price * ratio;
                  compPct[key] = ratio * 100;
                });
                return { price, compPrice, compPct };
              };

              const rows = sortedIndices.map(({ s, i }) => {
                if (atmStrike != null && Math.abs(s - atmStrike) > priceCompStrikeRange) return null;
                const iv = toIvFraction(ivRow[i]);
                if (iv == null || !(T_yr > 0) || !(spot > 0) || !(s > 0)) return null;
                const callGreeks = bsmGreeks(spot, s, T_yr, iv, 0.06, true);
                const putGreeks = bsmGreeks(spot, s, T_yr, iv, 0.06, false);
                const callMarketPrice = getPreferredOptionPrice(safeExpiryIdx, i, 'call');
                const putMarketPrice = getPreferredOptionPrice(safeExpiryIdx, i, 'put');
                const callSplit = splitPriceByGreeks(callGreeks, callMarketPrice);
                const putSplit = splitPriceByGreeks(putGreeks, putMarketPrice);
                if (!callSplit || !putSplit) return null;
                return { strike: s, call: callSplit, put: putSplit };
              }).filter(Boolean);

              const makeTrace = (side, key) => {
                const isCall = side === 'call';
                const palette = isCall ? CALL_COLORS : PUT_COLORS;
                const traceKey = `${side}-${key}`;
                return {
                  type: 'bar',
                  x: rows.map((row) => row.strike),
                  y: rows.map((row) => row[side].compPrice[key]),
                  name: `${isCall ? 'Call' : 'Put'} ${COMP_LABELS[key]}`,
                  marker: { color: palette[key], opacity: 0.9 },
                  offsetgroup: side,
                  legendgroup: traceKey,
                  uid: traceKey,
                  visible: priceCompLegendStateRef.current[traceKey] ?? true,
                  customdata: rows.map((row) => [row[side].compPct[key], row[side].price]),
                  hovertemplate:
                    `<b>${isCall ? 'Call' : 'Put'} ${COMP_LABELS[key]}</b><br>`
                    + 'Strike:%{x:,.0f}<br>'
                    + 'Component Price:\u20b9%{y:,.2f}<br>'
                    + 'Share:%{customdata[0]:.1f}%<br>'
                    + `${isCall ? 'Call' : 'Put'} Price:\u20b9%{customdata[1]:,.2f}<extra></extra>`,
                };
              };

              const traces = [];
              if (priceCompSideMode === 'call' || priceCompSideMode === 'both') {
                COMP_KEYS.forEach((key) => traces.push(makeTrace('call', key)));
              }
              if (priceCompSideMode === 'put' || priceCompSideMode === 'both') {
                COMP_KEYS.forEach((key) => traces.push(makeTrace('put', key)));
              }

              const captureLegendState = (figure) => {
                const data = Array.isArray(figure?.data) ? figure.data : [];
                if (!data.length) return;
                data.forEach((trace) => {
                  const traceKey = trace?.uid || trace?.legendgroup;
                  if (!traceKey) return;
                  priceCompLegendStateRef.current[traceKey] = trace?.visible ?? true;
                });
              };

              const hasData = rows.length > 0 && traces.length > 0;
              return (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px', flexWrap: 'wrap' }}>
                    <span style={{ color: '#9ca3af', fontSize: 12 }}>
                      ATM: <strong style={{ color: '#f59e0b' }}>{atmStrike != null ? atmStrike.toLocaleString() : '-'}</strong>
                      {spot > 0 && <span style={{ color: '#6b7280' }}> (Spot: {spot.toLocaleString()})</span>}
                    </span>
                    {skewExpiryOptions.length > 0 && (
                      <label style={{ color: '#9ca3af', fontSize: 12 }}>
                        Expiry
                        <select value={priceCompExpiryIndex} onChange={(e) => setPriceCompExpiryIndex(Number(e.target.value))} style={{ marginLeft: '6px', background: '#1f2937', color: '#d1d5db', border: '1px solid #374151', borderRadius: 4, padding: '2px 6px' }}>
                          {skewExpiryOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label style={{ color: '#9ca3af', fontSize: 12 }}>
                      Strike Range
                      <select value={priceCompStrikeRange} onChange={(e) => setPriceCompStrikeRange(Number(e.target.value))} style={{ marginLeft: '6px', background: '#1f2937', color: '#d1d5db', border: '1px solid #374151', borderRadius: 4, padding: '2px 6px' }}>
                        {[500, 800, 1200, 1500].map((value) => <option key={value} value={value}>±{value}</option>)}
                      </select>
                    </label>
                    <label style={{ color: '#9ca3af', fontSize: 12 }}>
                      Price Separation
                      <select value={priceCompSideMode} onChange={(e) => setPriceCompSideMode(e.target.value)} style={{ marginLeft: '6px', background: '#1f2937', color: '#d1d5db', border: '1px solid #374151', borderRadius: 4, padding: '2px 6px' }}>
                        <option value="both">Call + Put (Separated)</option>
                        <option value="call">Call only</option>
                        <option value="put">Put only</option>
                      </select>
                    </label>
                    <label style={{ color: '#9ca3af', fontSize: 12 }}>
                      Legend Labels
                      <select value={priceCompShowLabels ? 'on' : 'off'} onChange={(e) => setPriceCompShowLabels(e.target.value === 'on')} style={{ marginLeft: '6px', background: '#1f2937', color: '#d1d5db', border: '1px solid #374151', borderRadius: 4, padding: '2px 6px' }}>
                        <option value="on">On</option>
                        <option value="off">Off</option>
                      </select>
                    </label>
                  </div>

                  {!hasData ? (
                    <div className="snapshot-placeholder">No data available for selected expiry/range.</div>
                  ) : (
                    <Plot
                      id="price-comp-stacked-chart"
                      data={traces}
                      layout={{
                        height: 360,
                        margin: { l: 58, r: 16, b: 40, t: 10 },
                        paper_bgcolor: '#0a0f19',
                        plot_bgcolor: '#0a0f19',
                        font: { color: '#d1d5db', size: 11 },
                        uirevision: 'price-comp-stacked',
                        barmode: 'relative',
                        xaxis: { title: 'Strike', gridcolor: '#1f2937', tickformat: ',.0f' },
                        yaxis: { title: 'Price (\u20b9)', gridcolor: '#1f2937', tickformat: ',.2f' },
                        shapes: atmStrike != null ? [
                          {
                            type: 'line',
                            x0: atmStrike,
                            x1: atmStrike,
                            y0: 0,
                            y1: 1,
                            yref: 'paper',
                            line: { color: '#f59e0b', width: 2, dash: 'dash' },
                          },
                        ] : [],
                        annotations: atmStrike != null ? [
                          {
                            x: atmStrike,
                            y: 1,
                            yref: 'paper',
                            text: `ATM ${atmStrike.toLocaleString()}`,
                            showarrow: false,
                            font: { color: '#f59e0b', size: 10 },
                            xanchor: 'left',
                            yanchor: 'top',
                          },
                        ] : [],
                        showlegend: priceCompShowLabels,
                        legend: { orientation: 'h', y: 1.12, font: { size: 10 }, itemclick: 'toggle', itemdoubleclick: 'toggleothers' },
                      }}
                      config={{ displaylogo: false, responsive: true }}
                      style={{ width: '100%' }}
                      useResizeHandler
                      onInitialized={captureLegendState}
                      onUpdate={captureLegendState}
                    />
                  )}
                </>
              );
            })()}
          </Panel>
          <Panel title="Greeks Rotation Graph (GRG)">
            {(() => {
              const R = 0.06; // risk-free rate (India ~6%)
              const GREEK_KEYS = ['iv','delta','gamma','theta','vega'];
              const GREEK_LABELS = { iv:'IV', delta:'Delta', gamma:'Gamma', theta:'Theta', vega:'Vega' };
              const GREEK_COLORS = { iv:'#38bdf8', delta:'#22c55e', gamma:'#f59e0b', theta:'#ef4444', vega:'#a78bfa' };

              // Find ATM index in sortedStrikes
              const atmIdx = atmStrike != null
                ? sortedStrikes.reduce((bi,s,i) => Math.abs(s-atmStrike)<Math.abs(sortedStrikes[bi]-atmStrike)?i:bi, 0)
                : 0;
              // Strike options for dropdown (within ±1500 of ATM)
              // Build strike options as ATM, ATM±100, ±200, ... up to ±1500
              let grgStrikeOptions = [];
              if (atmStrike != null && sortedStrikes.length > 0) {
                const atmIdxInSorted = atmIdx;
                grgStrikeOptions.push({ label: `${sortedStrikes[atmIdxInSorted].toLocaleString()} (ATM)`, value: atmIdxInSorted });
                for (let offset = 100; offset <= 1500; offset += 100) {
                  // ATM + offset
                  const plusIdx = sortedStrikes.findIndex((s, i) => i > atmIdxInSorted && Math.abs(s - (atmStrike + offset)) < 50);
                  if (plusIdx !== -1) {
                    grgStrikeOptions.push({ label: `${sortedStrikes[plusIdx].toLocaleString()} (ATM+${offset})`, value: plusIdx });
                  }
                  // ATM - offset
                  const minusIdx = sortedStrikes.findIndex((s, i) => i < atmIdxInSorted && Math.abs(s - (atmStrike - offset)) < 50);
                  if (minusIdx !== -1) {
                    grgStrikeOptions.push({ label: `${sortedStrikes[minusIdx].toLocaleString()} (ATM-${offset})`, value: minusIdx });
                  }
                }
                // Sort by strike value ascending
                grgStrikeOptions = grgStrikeOptions.sort((a, b) => sortedStrikes[a.value] - sortedStrikes[b.value]);
              } else {
                grgStrikeOptions = sortedStrikes.map((s, i) => ({ label: s.toLocaleString(), value: i }));
              }
              const effectiveStrikeIdx = grgStrikeIdx != null ? grgStrikeIdx : atmIdx;
              const K = sortedStrikes[effectiveStrikeIdx];
              const isCall = grgOptionType === 'call';

              // For each expiry compute RS-Ratio per Greek (greek_at_K / greek_at_ATM * 100)
              const seriesData = maturityGrid.map((T, ei) => {
                const T_yr = Number(T);
                const ivK   = Number(marketMatrix[ei]?.[sortedIndices[effectiveStrikeIdx]?.i] ?? 0);
                const ivAtm = Number(marketMatrix[ei]?.[sortedIndices[atmIdx]?.i] ?? 0);
                if (!(T_yr > 0) || !(ivK > 0) || !(ivAtm > 0) || !K || !atmStrike) return null;
                const gK   = bsmGreeks(spot, K,         T_yr, ivK,   R, isCall);
                const gAtm = bsmGreeks(spot, atmStrike, T_yr, ivAtm, R, isCall);
                if (!gK || !gAtm) return null;
                const days = Math.max(1, Math.round(T_yr * 365));
                const label = expiryList[ei] ? `${expiryList[ei]} (${days}D)` : `${days}D`;
                const ratio = {};
                for (const k of GREEK_KEYS) {
                  ratio[k] = gAtm[k] > 1e-10 ? (gK[k] / gAtm[k]) * 100 : null;
                }
                return { ei, days, label, ratio, gK };
              }).filter(Boolean);

              // Compute RS-Momentum: change in RS-Ratio per Greek between consecutive expiries, centred at 100
              const withMomentum = seriesData.map((d, idx) => {
                const prev = seriesData[idx - 1];
                const mom = {};
                for (const k of GREEK_KEYS) {
                  if (prev && prev.ratio[k] != null && d.ratio[k] != null && prev.ratio[k] > 0) {
                    mom[k] = ((d.ratio[k] - prev.ratio[k]) / prev.ratio[k]) * 100 + 100;
                  } else {
                    mom[k] = 100; // no momentum at first point
                  }
                }
                return { ...d, mom };
              });

              const hasGrg = withMomentum.length >= 2;
              // Dynamic axis bounds from actual data
              const _allX = hasGrg ? withMomentum.flatMap(d => GREEK_KEYS.map(k => d.ratio[k]).filter(v => v!=null)) : [];
              const _allY = hasGrg ? withMomentum.flatMap(d => GREEK_KEYS.map(k => d.mom[k]).filter(v => v!=null)) : [];
              const _x0 = _allX.length ? Math.min(100, ..._allX) : 50;
              const _x1 = _allX.length ? Math.max(100, ..._allX) : 150;
              const _y0 = _allY.length ? Math.min(100, ..._allY) : 50;
              const _y1 = _allY.length ? Math.max(100, ..._allY) : 150;
              const _xp = Math.max(8, (_x1 - _x0) * 0.22);
              const _yp = Math.max(8, (_y1 - _y0) * 0.22);
              const xR = [_x0 - _xp, _x1 + _xp];
              const yR = [_y0 - _yp, _y1 + _yp];
              // Build plot traces: one trail + endpoint per Greek
              const traces = React.useMemo(() => {
                if (!hasGrg) return [];
                return GREEK_KEYS.map((k) => {
                  const pts = withMomentum.filter(d => d.ratio[k] != null && d.mom[k] != null);
                  if (pts.length === 0) return null;
                  return {
                    type: 'scatter',
                    mode: 'lines+markers+text',
                    x: pts.map(d => d.ratio[k]),
                    y: pts.map(d => d.mom[k]),
                    marker: { color: GREEK_COLORS[k], size: 8, line: { color: '#fff', width: 1.5 } },
                    line: { color: GREEK_COLORS[k], width: 2, dash: 'dot' },
                    text: pts.map(d => d.days+'D'),
                    textposition: 'top center',
                    textfont: { size: 10, color: GREEK_COLORS[k] },
                    name: GREEK_LABELS[k],
                    legendgroup: GREEK_LABELS[k],
                    hovertemplate: `<b>${GREEK_LABELS[k]}</b><br>RS-Ratio: %{x:.1f}<br>RS-Mom: %{y:.1f}<br>Days: %{text}<extra></extra>`,
                    showlegend: true,
                  };
                }).filter(Boolean);
              }, [hasGrg, withMomentum]);

              const currentExpiry = withMomentum[withMomentum.length - 1];
              return (
                <>
                  <div style={{ display:'flex', alignItems:'center', gap:'12px', marginBottom:'8px', flexWrap:'wrap' }}>
                                        <label style={{ color:'#9ca3af', fontSize:12 }}>
                                          Legend
                                          <select
                                            value={grgShowLegend ? 'on' : 'off'}
                                            onChange={e => setGrgShowLegend(e.target.value === 'on')}
                                            style={{ marginLeft:'6px', background:'#1f2937', color:'#d1d5db', border:'1px solid #374151', borderRadius:4, padding:'2px 6px' }}
                                          >
                                            <option value="on">On</option>
                                            <option value="off">Off</option>
                                          </select>
                                        </label>
                    <div style={{ display:'flex', borderRadius:6, overflow:'hidden', border:'1px solid #374151' }}>
                      {['call','put'].map(t => (
                        <button key={t} onClick={() => setGrgOptionType(t)} style={{
                          padding:'3px 14px', fontSize:12, cursor:'pointer', border:'none',
                          background: grgOptionType===t ? (t==='call'?'#22c55e':'#ef4444') : '#1f2937',
                          color: grgOptionType===t ? '#fff' : '#6b7280',
                        }}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>
                      ))}
                    </div>
                    <label style={{ color:'#9ca3af', fontSize:12 }}>
                      Strike
                      <select
                        value={effectiveStrikeIdx}
                        onChange={e => setGrgStrikeIdx(Number(e.target.value))}
                        style={{ marginLeft:'6px', background:'#1f2937', color:'#d1d5db', border:'1px solid #374151', borderRadius:4, padding:'2px 6px' }}
                      >
                        {grgStrikeOptions.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </label>
                    {currentExpiry && (
                      <span style={{ fontSize:11, color:'#6b7280' }}>
                        Showing {withMomentum.length} expiries · Current: <strong style={{color:'#f59e0b'}}>{currentExpiry.label}</strong>
                      </span>
                    )}
                  </div>
                  {!hasGrg ? (
                    <div className="snapshot-placeholder">Need ≥2 expiries to compute rotation. Load a multi-expiry snapshot.</div>
                  ) : (
                    <Plot
                      id="grg-rotation-chart"
                      data={[
                        // Quadrant background shapes are in layout.shapes; add centre lines as traces
                        { type:'scatter', mode:'lines', x:[xR[0],xR[1]], y:[100,100], line:{color:'#374151',width:1,dash:'dash'}, showlegend:false, hoverinfo:'skip' },
                        { type:'scatter', mode:'lines', x:[100,100], y:[yR[0],yR[1]], line:{color:'#374151',width:1,dash:'dash'}, showlegend:false, hoverinfo:'skip' },
                        ...traces,
                      ]}
                      layout={{
                        height: 420,
                        margin: { l:58, r:20, b:48, t:32 },
                        paper_bgcolor:'#0a0f19', plot_bgcolor:'#0a0f19',
                        font:{ color:'#d1d5db', size:11 },
                        title:{ text: `${isCall?'Call':'Put'} Greeks Rotation — K=${K?.toLocaleString()}`, font:{size:13,color:'#d1d5db'}, x:0.5 },
                        xaxis:{ title: { text: 'RS-Ratio (Greek vs ATM, 100 = parity)', font: { color: '#fff', size: 14 } }, gridcolor:'#1f2937', range:xR, zeroline:false },
                        yaxis:{ title: { text: 'RS-Momentum (Rate of Change, 100 = flat)', font: { color: '#fff', size: 14 } }, gridcolor:'#1f2937', range:yR, zeroline:false },
                        shapes:[
                          { type:'rect', x0:xR[0], x1:100,   y0:100,   y1:yR[1], fillcolor:'rgba(56,189,248,0.06)', line:{width:0} },  // Improving
                          { type:'rect', x0:100,   x1:xR[1], y0:100,   y1:yR[1], fillcolor:'rgba(34,197,94,0.06)',  line:{width:0} },  // Leading
                          { type:'rect', x0:100,   x1:xR[1], y0:yR[0], y1:100,   fillcolor:'rgba(251,191,36,0.06)', line:{width:0} },  // Weakening
                          { type:'rect', x0:xR[0], x1:100,   y0:yR[0], y1:100,   fillcolor:'rgba(239,68,68,0.06)',  line:{width:0} },  // Lagging
                        ],
                        annotations:[
                          { xref:'paper', yref:'paper', x:0.02, y:0.97, text:'IMPROVING', showarrow:false, font:{color:'#38bdf8',size:11}, xanchor:'left' },
                          { xref:'paper', yref:'paper', x:0.98, y:0.97, text:'LEADING',   showarrow:false, font:{color:'#22c55e',size:11}, xanchor:'right' },
                          { xref:'paper', yref:'paper', x:0.98, y:0.03, text:'WEAKENING', showarrow:false, font:{color:'#f59e0b',size:11}, xanchor:'right' },
                          { xref:'paper', yref:'paper', x:0.02, y:0.03, text:'LAGGING',   showarrow:false, font:{color:'#ef4444',size:11}, xanchor:'left' },
                        ],
                        legend:{ orientation:'h', y:1.08, font:{size:10}, itemclick:'toggle', itemdoubleclick:'toggleothers' },
                        showlegend: grgShowLegend,
                        uirevision: 'grg-rotation',
                      }}
                      config={{ displaylogo:false, responsive:true, legend: { itemclick: 'toggle', itemdoubleclick: 'toggleothers' } }}
                      style={{ width:'100%' }}
                      useResizeHandler
                    />
                  )}
                  {hasGrg && currentExpiry?.gK && (
                    <div className="metric-strip" style={{marginTop:6}}>
                      <div><span>IV</span><strong style={{color:'#38bdf8'}}>{Number(currentExpiry.gK.iv).toFixed(2)}%</strong></div>
                      <div><span>{isCall?'Call':'Put'} Δ</span><strong style={{color:'#22c55e'}}>{Number(currentExpiry.gK.delta).toFixed(4)}</strong></div>
                      <div><span>Γ</span><strong style={{color:'#f59e0b'}}>{Number(currentExpiry.gK.gamma).toFixed(6)}</strong></div>
                      <div><span>Θ/day</span><strong style={{color:'#ef4444'}}>-{Number(currentExpiry.gK.theta).toFixed(2)}</strong></div>
                      <div><span>ν (Vega)</span><strong style={{color:'#a78bfa'}}>{Number(currentExpiry.gK.vega).toFixed(2)}</strong></div>
                      <div><span>Price</span><strong style={{color:'#d1d5db'}}>₹{Number(currentExpiry.gK.price).toFixed(2)}</strong></div>
                    </div>
                  )}

                  {/* New GreekVsStrikesGRG chart below the existing GRG chart */}
                  <GreekVsStrikesGRG
                    sortedStrikes={sortedStrikes}
                    atmIdx={atmIdx}
                    atmStrike={atmStrike}
                    maturityGrid={maturityGrid}
                    expiryList={expiryList}
                    marketMatrix={marketMatrix}
                    sortedIndices={sortedIndices}
                    spot={spot}
                    bsmGreeks={bsmGreeks}
                  />
                </>
              );
            })()}
          </Panel>
          <Panel title="VRP Area Plot">
            <div className="filters-grid" style={{ gridTemplateColumns: '1fr' }}>
              <label>
                VRP Basis
                <select value={vrpBasis} onChange={(event) => setVrpBasis(event.target.value)}>
                  <option value="atm_iv_rv20">ATM IV - RV20 (current)</option>
                  <option value="atm_iv_rv60">ATM IV - RV60</option>
                  <option value="iv_proxy_hv20">IV Proxy - HV20</option>
                  <option value="model_iv_model_rv">Model IV - Model RV</option>
                </select>
              </label>
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={vrpLogValues}
                  onChange={(event) => setVrpLogValues(event.target.checked)}
                />
                Log Values (signed log10)
              </label>
            </div>
            {vrpChartSeries.dates.length ? (
              <Plot
                id="vrp-area-chart"
                data={[
                  {
                    type: 'scatter',
                    mode: 'lines',
                    x: vrpChartSeries.dates,
                    y: vrpChartSeries.positive,
                    line: { color: '#00ff66', width: 2.1, shape: 'spline', smoothing: 1.15 },
                    fill: 'tozeroy',
                    fillcolor: 'rgba(0,255,102,0.30)',
                    connectgaps: false,
                    name: 'Positive VRP',
                  },
                  {
                    type: 'scatter',
                    mode: 'lines',
                    x: vrpChartSeries.dates,
                    y: vrpChartSeries.negative,
                    line: { color: '#ff3b30', width: 2.0, shape: 'spline', smoothing: 1.1 },
                    fill: 'tozeroy',
                    fillcolor: 'rgba(255,59,48,0.24)',
                    connectgaps: false,
                    name: 'Negative VRP',
                  },
                  {
                    type: 'scatter',
                    mode: 'lines',
                    x: vrpChartSeries.dates,
                    y: vrpChartSeries.values,
                    line: { color: '#e2e8f0', width: 1.15, shape: 'spline', smoothing: 1.05 },
                    name: vrpChartSeries.basisLabel,
                  },
                ]}
                layout={{
                  height: 220,
                  margin: { l: 36, r: 12, b: 28, t: 22 },
                  paper_bgcolor: '#0a0f19',
                  plot_bgcolor: '#0a0f19',
                  font: { color: '#d1d5db', size: 11 },
                  xaxis: { title: 'Date', gridcolor: '#1f2937' },
                  yaxis: {
                    title: vrpLogValues ? 'VRP (signed log10 of vol pts)' : 'VRP (vol pts)',
                    gridcolor: '#1f2937',
                    zeroline: true,
                    zerolinecolor: '#94a3b8',
                  },
                  legend: { orientation: 'h', y: 1.15, font: { size: 9 } },
                }}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: '100%' }}
                useResizeHandler
              />
            ) : (
              <div className="snapshot-placeholder">No VRP series available.</div>
            )}
            <div className="metric-strip">
              <div><span>{vrpMetrics.basisLabel} (Latest)</span><strong>{vrpMetrics.latest != null ? `${formatNumber(vrpMetrics.latest, 2)} pts` : '-'}</strong></div>
              <div><span>VRP Mean (5D)</span><strong>{vrpMetrics.avg5 != null ? `${formatNumber(vrpMetrics.avg5, 2)} pts` : '-'}</strong></div>
              <div><span>VRP Mean (20D)</span><strong>{vrpMetrics.avg20 != null ? `${formatNumber(vrpMetrics.avg20, 2)} pts` : '-'}</strong></div>
              <div><span>VRP Std Dev (20D)</span><strong>{vrpMetrics.std20 != null ? `${formatNumber(vrpMetrics.std20, 2)} pts` : '-'}</strong></div>
              <div><span>VRP Positive Days (20D)</span><strong>{vrpMetrics.hitRatio20 != null ? `${formatNumber(vrpMetrics.hitRatio20, 1)}%` : '-'}</strong></div>
              <div><span>VRP Min (20D)</span><strong>{vrpMetrics.min20 != null ? `${formatNumber(vrpMetrics.min20, 2)} pts` : '-'}</strong></div>
              <div><span>VRP Max (20D)</span><strong>{vrpMetrics.max20 != null ? `${formatNumber(vrpMetrics.max20, 2)} pts` : '-'}</strong></div>
              <div><span>Mode</span><strong>{vrpLogValues ? 'Signed Log' : 'Linear'}</strong></div>
            </div>
          </Panel>
          <Panel title="Vol Forecast Models (ARCH / GARCH / EPOW / GJR)">
            <div className="filters-grid" style={{ gridTemplateColumns: '1fr' }}>
              <label>
                Model
                <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
                  {modelKeys.length
                    ? modelKeys.map((modelKey) => (
                        <option value={modelKey} key={modelKey}>{modelKey}</option>
                      ))
                    : <option value="">No model data</option>}
                </select>
              </label>
            </div>
            {hasForecastData ? (
              <Plot
                id="vol-forecast-chart"
                data={[
                  {
                    type: 'scatter',
                    mode: 'lines',
                    x: forecastDates,
                    y: hv20Series,
                    line: { color: '#38bdf8', width: 1.8, dash: 'dash' },
                    name: 'HV20',
                  },
                  {
                    type: 'scatter',
                    mode: 'lines',
                    x: forecastDates,
                    y: ivProxySeries,
                    line: { color: '#f59e0b', width: 1.8, dash: 'dash' },
                    name: 'IV Proxy',
                  },
                  {
                    type: 'scatter',
                    mode: 'lines',
                    x: forecastDates,
                    y: selectedModelPayload?.rv_series || [],
                    line: { color: '#22c55e', width: 2.2 },
                    name: `${selectedModel} RV`,
                  },
                  {
                    type: 'scatter',
                    mode: 'lines',
                    x: forecastDates,
                    y: selectedModelPayload?.iv_series || [],
                    line: { color: '#ef4444', width: 2.2 },
                    name: `${selectedModel} IV`,
                  },
                ]}
                layout={{
                  height: 240,
                  margin: { l: 36, r: 12, b: 28, t: 18 },
                  paper_bgcolor: '#0a0f19',
                  plot_bgcolor: '#0a0f19',
                  font: { color: '#d1d5db', size: 11 },
                  uirevision: 'vol-forecast-chart',
                  xaxis: { title: 'Date', gridcolor: '#1f2937' },
                  yaxis: { title: 'Volatility', gridcolor: '#1f2937' },
                  legend: {
                    orientation: 'h',
                    y: 1.15,
                    font: { size: 9 },
                    itemclick: 'toggle',
                    itemdoubleclick: 'toggleothers',
                  },
                }}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: '100%' }}
                useResizeHandler
              />
            ) : (
              <div className="snapshot-placeholder">No forecast series available. Fetch live data and re-run analysis.</div>
            )}
            <div className="metric-strip">
              <div><span>{selectedModel} RV Forecast (20D)</span><strong>{formatPct(selectedModelPayload?.rv_forecast_20d, 2)}</strong></div>
              <div><span>{selectedModel} IV Forecast (20D)</span><strong>{formatPct(selectedModelPayload?.iv_forecast_20d, 2)}</strong></div>
              <div><span>HV20 (Last)</span><strong>{formatPct(hv20Series[hv20Series.length - 1], 2)}</strong></div>
              <div><span>IV Proxy (Last)</span><strong>{formatPct(ivProxySeries[ivProxySeries.length - 1], 2)}</strong></div>
            </div>
          </Panel>
          <Panel title="Model Scatter Compare (Regression + R²)">
            <div className="filters-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <label>
                X Axis
                <select value={scatterXKey} onChange={(event) => setScatterXKey(event.target.value)}>
                  {regressionOptions.map((option) => (
                    <option value={option.value} key={`x-${option.value}`}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Y Axis
                <select value={scatterYKey} onChange={(event) => setScatterYKey(event.target.value)}>
                  {regressionOptions.map((option) => (
                    <option value={option.value} key={`y-${option.value}`}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>
            {regression.points.length ? (
              <Plot
                id="model-scatter-chart"
                data={[
                  {
                    type: 'scatter',
                    mode: 'markers',
                    x: regression.points.map((point) => point.x),
                    y: regression.points.map((point) => point.y),
                    marker: { color: '#38bdf8', size: 6, opacity: 0.7 },
                    name: 'Observations',
                  },
                  {
                    type: 'scatter',
                    mode: 'lines',
                    x: regression.lineX,
                    y: regression.lineY,
                    line: { color: '#f59e0b', width: 2 },
                    name: 'Linear Fit',
                  },
                ]}
                layout={{
                  height: 240,
                  margin: { l: 36, r: 12, b: 28, t: 18 },
                  paper_bgcolor: '#0a0f19',
                  plot_bgcolor: '#0a0f19',
                  font: { color: '#d1d5db', size: 11 },
                  xaxis: {
                    title: `${regressionInputMap[scatterXKey]?.label || 'X'} (%)`,
                    gridcolor: '#1f2937',
                    tickformat: '.1%',
                  },
                  yaxis: {
                    title: `${regressionInputMap[scatterYKey]?.label || 'Y'} (%)`,
                    gridcolor: '#1f2937',
                    tickformat: '.1%',
                  },
                  annotations: regression.r2 == null
                    ? []
                    : [
                        {
                          xref: 'paper',
                          yref: 'paper',
                          x: 0.01,
                          y: 0.99,
                          text: `R²=${regression.r2.toFixed(3)} | β=${regression.slope.toFixed(3)} | α=${regression.intercept.toFixed(4)} | εσ=${regression.epsilonStd != null ? regression.epsilonStd.toFixed(4) : '-'} | σx=${regression.stdX != null ? regression.stdX.toFixed(4) : '-'} | σy=${regression.stdY != null ? regression.stdY.toFixed(4) : '-'} | Cov(x,y)=${regression.covXY != null ? regression.covXY.toFixed(4) : '-'} | Var(x)=${regression.varX != null ? regression.varX.toFixed(4) : '-'} | Var(y)=${regression.varY != null ? regression.varY.toFixed(4) : '-'}`,
                          showarrow: false,
                          font: { color: '#f59e0b', size: 10 },
                        },
                      ],
                }}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: '100%' }}
                useResizeHandler
              />
            ) : (
              <div className="snapshot-placeholder">Not enough points for regression. Try another X/Y pair.</div>
            )}
            <div className="metric-strip">
              <div><span>ANOVA F</span><strong>{regression.fStat != null ? formatNumber(regression.fStat, 4) : '-'}</strong></div>
              <div><span>ANOVA p-value</span><strong>{regression.pF != null ? formatNumber(regression.pF, 6) : '-'}</strong></div>
              <div><span>t(β)</span><strong>{regression.tBeta != null ? formatNumber(regression.tBeta, 4) : '-'}</strong></div>
              <div><span>p-value (β)</span><strong>{regression.pBeta != null ? formatNumber(regression.pBeta, 6) : '-'}</strong></div>
              <div><span>t(α)</span><strong>{regression.tAlpha != null ? formatNumber(regression.tAlpha, 4) : '-'}</strong></div>
              <div><span>p-value (α)</span><strong>{regression.pAlpha != null ? formatNumber(regression.pAlpha, 6) : '-'}</strong></div>
              <div><span>df</span><strong>{regression.df != null ? formatNumber(regression.df, 0) : '-'}</strong></div>
              <div><span>εσ</span><strong>{regression.epsilonStd != null ? formatNumber(regression.epsilonStd, 4) : '-'}</strong></div>
            </div>
          </Panel>
        </div>
      </div>
    </SnapshotGuard>
  );
}
