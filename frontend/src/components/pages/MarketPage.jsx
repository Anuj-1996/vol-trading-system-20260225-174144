import React, { useEffect, useMemo, useState } from 'react';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber, formatPct } from './shared.jsx';

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
    return { points, slope: 0, intercept: 0, r2: null, lineX: [], lineY: [] };
  }

  const meanX = points.reduce((acc, p) => acc + p.x, 0) / points.length;
  const meanY = points.reduce((acc, p) => acc + p.y, 0) / points.length;
  let num = 0;
  let den = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    num += dx * (point.y - meanY);
    den += dx * dx;
  }
  const slope = den > 1e-12 ? num / den : 0;
  const intercept = meanY - slope * meanX;
  const predicted = points.map((p) => slope * p.x + intercept);
  const ssRes = points.reduce((acc, p, i) => acc + (p.y - predicted[i]) ** 2, 0);
  const ssTot = points.reduce((acc, p) => acc + (p.y - meanY) ** 2, 0);
  const r2 = ssTot > 1e-12 ? Math.max(0, 1 - ssRes / ssTot) : null;

  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  return {
    points,
    slope,
    intercept,
    r2,
    lineX: [minX, maxX],
    lineY: [slope * minX + intercept, slope * maxX + intercept],
  };
}

export default function MarketPage({ loading, activeSnapshotId, market, surface, selectedExpiryIndex = 0 }) {
  const [selectedModel, setSelectedModel] = useState('GARCH');
  const [scatterXKey, setScatterXKey] = useState('hv20');
  const [scatterYKey, setScatterYKey] = useState('iv_proxy');
  const [vrpBasis, setVrpBasis] = useState('atm_iv_rv20');
  const [vrpLogValues, setVrpLogValues] = useState(false);

  const strikeGrid = Array.isArray(surface?.strike_grid) ? surface.strike_grid : [];
  const marketMatrix = Array.isArray(surface?.market_iv_matrix) ? surface.market_iv_matrix : [];
  const marketSlice = marketMatrix[selectedExpiryIndex] || marketMatrix[0] || [];
  const termDays = Array.isArray(market?.term_structure_days) ? market.term_structure_days : [];
  const termMarketAtm = Array.isArray(market?.term_structure_market_atm) ? market.term_structure_market_atm : [];
  const termModelAtm = Array.isArray(market?.term_structure_model_atm) ? market.term_structure_model_atm : [];
  const spot = Number(market?.spot ?? 0);
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
  const ivProxySeries = Array.isArray(forecastBundle?.iv_proxy) ? forecastBundle.iv_proxy : [];
  const atmIvSeries = useMemo(() => {
    if (!hasHistory || !Array.isArray(history?.dates)) {
      return [];
    }
    const count = history.dates.length;
    const proxy = Array.isArray(ivProxySeries) ? ivProxySeries : [];
    const aligned = Array.from({ length: count }, () => null);
    if (proxy.length) {
      // Align proxy to the right edge (most recent dates).
      const offset = Math.max(0, count - proxy.length);
      for (let idx = 0; idx < count; idx += 1) {
        const sourceIndex = idx - offset;
        if (sourceIndex >= 0 && sourceIndex < proxy.length) {
          const value = Number(proxy[sourceIndex]);
          aligned[idx] = Number.isFinite(value) ? value : null;
        }
      }
    }

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
    const proxy = Array.isArray(ivProxySeries) ? ivProxySeries : [];
    const aligned = Array.from({ length: count }, () => null);
    if (proxy.length) {
      const offset = Math.max(0, count - proxy.length);
      for (let idx = 0; idx < count; idx += 1) {
        const sourceIndex = idx - offset;
        if (sourceIndex >= 0 && sourceIndex < proxy.length) {
          const value = Number(proxy[sourceIndex]);
          aligned[idx] = Number.isFinite(value) ? value : null;
        }
      }
    }
    return aligned;
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

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-market-split">
        <div className="market-plots-stack">
          <Panel title="Price Chart">
            <Plot
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
              <div><span>20D RV</span><strong>{formatPct(market?.rv_20d, 2)}</strong></div>
              <div><span>60D RV</span><strong>{formatPct(market?.rv_60d, 2)}</strong></div>
              <div><span>Volume (last)</span><strong>{formatNumber(volumeSeries[volumeSeries.length - 1], 0)}</strong></div>
              <div><span>ATM IV - 20D RV (pts)</span><strong>{spotSpreadPct !== null ? formatNumber(spotSpreadPct, 2) : '-'}</strong></div>
            </div>
          </Panel>
          <Panel title="IV Term Structure">
            <Plot
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
            <Plot
              data={[{ type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: marketSlice, line: { color: '#38bdf8', width: 2 } }]}
              layout={{
                height: 220,
                margin: { l: 36, r: 12, b: 28, t: 22 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 11 },
                xaxis: { title: 'Strike', gridcolor: '#1f2937' },
                yaxis: { title: 'IV', gridcolor: '#1f2937' },
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
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
                  xaxis: { title: regressionInputMap[scatterXKey]?.label || 'X', gridcolor: '#1f2937' },
                  yaxis: { title: regressionInputMap[scatterYKey]?.label || 'Y', gridcolor: '#1f2937' },
                  annotations: regression.r2 == null
                    ? []
                    : [
                        {
                          xref: 'paper',
                          yref: 'paper',
                          x: 0.01,
                          y: 0.99,
                          text: `R²=${regression.r2.toFixed(3)} | slope=${regression.slope.toFixed(3)}`,
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
          </Panel>
        </div>

        <div className="market-panels-stack">
          <Panel title="Realized Vol Metrics">
            <div className="kv-grid two-col market-metrics-grid">
              <div><span>10D RV</span><strong>{formatPct(market?.rv_10d, 2)}</strong></div>
              <div><span>20D RV</span><strong>{formatPct(market?.rv_20d, 2)}</strong></div>
              <div><span>60D RV</span><strong>{formatPct(market?.rv_60d, 2)}</strong></div>
              <div><span>RV Percentile</span><strong>{formatNumber(market?.rv_percentile, 2)}%</strong></div>
            </div>
          </Panel>
          <Panel title="Market Regime Box">
            <div className="kv-grid two-col market-metrics-grid">
              <div><span>Trend Regime</span><strong style={{color: market?.regime?.label === 'high_vol' ? '#ef4444' : '#22c55e'}}>{market?.regime?.label || '-'}</strong></div>
              <div><span>Vol Regime (IV/RV)</span><strong>{market?.regime?.volatility_regime_score != null ? Number(market.regime.volatility_regime_score).toFixed(2) + 'x' : '-'}</strong></div>
              <div><span>Skew (Put-Call)</span><strong>{market?.regime?.skew_regime_score != null ? (Number(market.regime.skew_regime_score) * 100).toFixed(2) + ' pts' : '-'}</strong></div>
              <div><span>Confidence</span><strong>{market?.regime?.confidence != null ? (Number(market.regime.confidence) * 100).toFixed(1) + '%' : '-'}</strong></div>
            </div>
          </Panel>
          <Panel title="Vol Stats">
            <div className="kv-grid two-col market-metrics-grid">
              <div><span>ATM Market IV</span><strong style={{color:'#f59e0b'}}>{market?.atm_iv != null ? (Number(market.atm_iv) * 100).toFixed(2) + '%' : '-'}</strong></div>
              <div><span>ATM Model IV</span><strong>{market?.atm_model_iv != null ? (Number(market.atm_model_iv) * 100).toFixed(2) + '%' : '-'}</strong></div>
              <div><span>IV Rank</span><strong>{market?.iv_rank != null ? Number(market.iv_rank).toFixed(1) + '%' : '-'}</strong></div>
              <div><span>IV Percentile</span><strong>{market?.iv_percentile != null ? Number(market.iv_percentile).toFixed(1) + '%' : '-'}</strong></div>
              <div><span>IV-RV Spread</span><strong style={{color: Number(market?.realized_implied_spread ?? 0) >= 0 ? '#22c55e' : '#ef4444'}}>{market?.realized_implied_spread != null ? (Number(market.realized_implied_spread) * 100).toFixed(2) + ' pts' : '-'}</strong></div>
              <div><span>VVIX Equivalent</span><strong>{market?.vvix_equivalent != null ? (Number(market.vvix_equivalent) * 100).toFixed(2) + '%' : '-'}</strong></div>
            </div>
            <Plot
              data={[
                {
                  type: 'bar',
                  x: ['IV Rank', 'IV Pctl', 'RV Pctl'],
                  y: [
                    Number(market?.iv_rank ?? 0),
                    Number(market?.iv_percentile ?? 0),
                    Number(market?.rv_percentile ?? 0),
                  ],
                  marker: { color: ['#f59e0b', '#22c55e', '#38bdf8'] },
                },
              ]}
              layout={{
                height: 160,
                margin: { l: 30, r: 12, b: 28, t: 8 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 10 },
                xaxis: { gridcolor: '#1f2937' },
                yaxis: { title: 'Percentile', gridcolor: '#1f2937', range: [0, 100] },
                showlegend: false,
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </Panel>
        </div>
      </div>
    </SnapshotGuard>
  );
}
