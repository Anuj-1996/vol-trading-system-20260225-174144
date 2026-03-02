import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber } from './shared.jsx';

const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatExpiryLabel(label) {
  const m = String(label).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return `${parseInt(m[3],10)} ${SHORT_MONTHS[parseInt(m[2],10)-1]} ${m[1].slice(2)}`;
  }
  return String(label);
}

function movingAverage(values, windowSize = 5) {
  const source = Array.isArray(values) ? values.map((item) => Number(item)) : [];
  if (source.length < 3 || windowSize < 3) {
    return source;
  }
  const radius = Math.floor(windowSize / 2);
  return source.map((_, index) => {
    let total = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const nextIndex = index + offset;
      if (nextIndex >= 0 && nextIndex < source.length) {
        total += source[nextIndex];
        count += 1;
      }
    }
    return count ? total / count : source[index];
  });
}

function rollingMedian(values, windowSize = 5) {
  const source = Array.isArray(values) ? values.map((item) => Number(item)) : [];
  if (source.length < 3 || windowSize < 3) {
    return source;
  }
  const radius = Math.floor(windowSize / 2);
  return source.map((_, index) => {
    const bucket = [];
    for (let offset = -radius; offset <= radius; offset += 1) {
      const nextIndex = index + offset;
      if (nextIndex >= 0 && nextIndex < source.length) {
        bucket.push(source[nextIndex]);
      }
    }
    bucket.sort((a, b) => a - b);
    return bucket[Math.floor(bucket.length / 2)] ?? source[index];
  });
}

function smoothMatrix2D(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) {
    return [];
  }

  const rows = matrix.length;
  const cols = Math.max(...matrix.map((row) => (Array.isArray(row) ? row.length : 0)));
  if (!cols) {
    return [];
  }

  const cleanedByRow = matrix.map((rawRow) => {
    const row = Array.isArray(rawRow) ? rawRow.map((value) => Number(value)) : [];
    const medianSmoothed = rollingMedian(row, 5);
    const maSmoothed = movingAverage(medianSmoothed, 5);
    return maSmoothed.map((value) => Math.max(0.01, Math.min(3.0, value)));
  });

  const byColumn = Array.from({ length: cols }, (_, colIndex) =>
    cleanedByRow.map((row) => row[colIndex] ?? row[row.length - 1] ?? 0.2),
  );

  const smoothedColumns = byColumn.map((column) => movingAverage(rollingMedian(column, 3), 3));

  const rebuilt = Array.from({ length: rows }, (_, rowIndex) =>
    Array.from({ length: cols }, (_, colIndex) => smoothedColumns[colIndex][rowIndex] ?? cleanedByRow[rowIndex]?.[colIndex] ?? 0.2),
  );

  return rebuilt.map((row) => row.map((value) => Math.max(0.01, Math.min(3.0, value))));
}

function interpolateLinear(points, values, target) {
  if (!points.length || !values.length) {
    return 0;
  }
  if (target <= points[0]) {
    return Number(values[0] ?? 0);
  }
  if (target >= points[points.length - 1]) {
    return Number(values[values.length - 1] ?? 0);
  }
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = Number(points[index]);
    const right = Number(points[index + 1]);
    if (target >= left && target <= right) {
      const leftValue = Number(values[index] ?? 0);
      const rightValue = Number(values[index + 1] ?? leftValue);
      const weight = right !== left ? (target - left) / (right - left) : 0;
      return leftValue + (rightValue - leftValue) * weight;
    }
  }
  return Number(values[values.length - 1] ?? 0);
}

function buildDenseAxis(axis, factor = 6) {
  const source = Array.isArray(axis) ? axis.map((value) => Number(value)).filter(Number.isFinite) : [];
  if (source.length < 2) {
    return source;
  }
  const result = [];
  for (let index = 0; index < source.length - 1; index += 1) {
    const left = source[index];
    const right = source[index + 1];
    const stepCount = Math.max(2, factor);
    for (let step = 0; step < stepCount; step += 1) {
      const weight = step / stepCount;
      result.push(left + (right - left) * weight);
    }
  }
  result.push(source[source.length - 1]);
  return result;
}

function densifyMatrix(strikeAxis, maturityAxis, matrix, strikeFactor = 6, maturityFactor = 6) {
  const strike = Array.isArray(strikeAxis) ? strikeAxis.map((value) => Number(value)) : [];
  const maturity = Array.isArray(maturityAxis) ? maturityAxis.map((value) => Number(value)) : [];
  const source = Array.isArray(matrix) ? matrix : [];

  if (strike.length < 2 || maturity.length < 2 || !source.length) {
    return { strikeDense: strike, maturityDense: maturity, matrixDense: source };
  }

  const strikeDense = buildDenseAxis(strike, strikeFactor);
  const maturityDense = buildDenseAxis(maturity, maturityFactor);

  const rowInterpolated = source.map((row) =>
    strikeDense.map((strikeValue) => interpolateLinear(strike, Array.isArray(row) ? row : [], strikeValue)),
  );

  const matrixDense = maturityDense.map((maturityValue) => {
    const interpolatedRow = [];
    for (let colIndex = 0; colIndex < strikeDense.length; colIndex += 1) {
      const colValues = rowInterpolated.map((row) => Number(row[colIndex] ?? 0));
      interpolatedRow.push(interpolateLinear(maturity, colValues, maturityValue));
    }
    return interpolatedRow;
  });

  return { strikeDense, maturityDense, matrixDense };
}

export default function SurfacePage({
  loading,
  activeSnapshotId,
  market,
  surface,
  selectedExpiryIndex = 0,
  onExpiryIndexChange,
}) {
  const [sliceExpiryIndex, setSliceExpiryIndex] = useState(0);
  const [sliceStrikeIndex, setSliceStrikeIndex] = useState(0);
  const [logMoneyness, setLogMoneyness] = useState(false);
  const [maximizedChart, setMaximizedChart] = useState(null);

  const strikeGrid = Array.isArray(surface?.strike_grid) ? surface.strike_grid : [];
  const maturityGrid = Array.isArray(surface?.maturity_grid) ? surface.maturity_grid : [];
  const expiryLabels = Array.isArray(surface?.expiry_labels)
    ? surface.expiry_labels
    : maturityGrid.map((value) => `${Math.max(1, Math.round(Number(value) * 365))}D`);
  const formattedExpiryLabels = useMemo(() => expiryLabels.map(formatExpiryLabel), [expiryLabels]);

  // 2D text array for market surface hover (rows = expiries, cols = strikes)
  const marketExpiryText = useMemo(
    () => maturityGrid.map((_, ri) => strikeGrid.map(() => formattedExpiryLabels[ri] || '')),
    [maturityGrid, strikeGrid, formattedExpiryLabels],
  );

  // Y-axis scene config for 3D charts: show expiry labels instead of numeric years
  const expiryYAxis = useMemo(() => ({
    title: 'Expiry',
    tickvals: maturityGrid,
    ticktext: formattedExpiryLabels,
  }), [maturityGrid, formattedExpiryLabels]);

  const openInterestMatrix = Array.isArray(surface?.open_interest_matrix) ? surface.open_interest_matrix : [];
  const maxPainByExpiry = Array.isArray(surface?.max_pain_by_expiry) ? surface.max_pain_by_expiry : [];
  const marketMatrix = Array.isArray(surface?.market_iv_matrix) ? surface.market_iv_matrix : [];
  const modelMatrix = Array.isArray(surface?.model_iv_matrix) ? surface.model_iv_matrix : [];
  const smoothedModelMatrix = useMemo(() => smoothMatrix2D(modelMatrix), [modelMatrix]);
  const denseModelSurface = useMemo(
    () => densifyMatrix(strikeGrid, maturityGrid, smoothedModelMatrix, 7, 7),
    [strikeGrid, maturityGrid, smoothedModelMatrix],
  );
  const residualMatrix = Array.isArray(surface?.residual_iv_matrix) ? surface.residual_iv_matrix : [];
  const displayResidualMatrix = useMemo(() => {
    if (!marketMatrix.length || !smoothedModelMatrix.length) {
      return residualMatrix;
    }
    return marketMatrix.map((row, rowIndex) =>
      (Array.isArray(row) ? row : []).map((value, colIndex) => Number(value) - Number(smoothedModelMatrix[rowIndex]?.[colIndex] ?? 0)),
    );
  }, [marketMatrix, smoothedModelMatrix, residualMatrix]);
  const singleExpiry = maturityGrid.length < 2;
  const selectedStrikeValue = strikeGrid[sliceStrikeIndex] || 0;

  const strikeSeriesMarket = useMemo(
    () => maturityGrid.map((_, idx) => marketMatrix[idx]?.[sliceStrikeIndex] ?? null),
    [maturityGrid, marketMatrix, sliceStrikeIndex],
  );
  const strikeSeriesModel = useMemo(
    () => maturityGrid.map((_, idx) => smoothedModelMatrix[idx]?.[sliceStrikeIndex] ?? null),
    [maturityGrid, smoothedModelMatrix, sliceStrikeIndex],
  );

  const residualValues = displayResidualMatrix.flat().map((value) => Number(value));
  const residualRmse = residualValues.length
    ? Math.sqrt(residualValues.reduce((acc, value) => acc + value * value, 0) / residualValues.length)
    : 0;
  const residualMaxAbs = residualValues.length
    ? Math.max(...residualValues.map((value) => Math.abs(value)))
    : 0;
  const selectedOiRow = openInterestMatrix[sliceExpiryIndex] || [];
  const selectedMaxPain = Number(maxPainByExpiry[sliceExpiryIndex] ?? 0);
  const marketIvDistribution = (marketMatrix[sliceExpiryIndex] || marketMatrix.flat() || []).map((value) => Number(value)).filter((value) => Number.isFinite(value));
  const modelIvDistribution = (smoothedModelMatrix[sliceExpiryIndex] || smoothedModelMatrix.flat() || []).map((value) => Number(value)).filter((value) => Number.isFinite(value));

  useEffect(() => {
    setSliceExpiryIndex(selectedExpiryIndex);
  }, [selectedExpiryIndex]);

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-surface-grid">
        <div className="surface-hero">
          <Panel title="Market + Model Combined Surface 3D" onMaximize={() => setMaximizedChart('hero')}>
            <Plot
              data={singleExpiry
                ? [
                    { type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: marketMatrix[0] || [], line: { color: '#22c55e', width: 2 }, name: 'Market Smile' },
                    { type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: smoothedModelMatrix[0] || [], line: { color: '#f59e0b', width: 2, shape: 'spline', smoothing: 1.1 }, name: 'Model Smile' },
                  ]
                : [
                    { type: 'surface', x: strikeGrid, y: maturityGrid, z: marketMatrix, colorscale: 'Viridis', opacity: 0.92, showscale: false, name: 'Market', text: marketExpiryText, hovertemplate: 'Strike: %{x:.0f}<br>Expiry: %{text}<br>IV: %{z:.4f}<extra>Market</extra>' },
                    { type: 'surface', x: denseModelSurface.strikeDense, y: denseModelSurface.maturityDense, z: denseModelSurface.matrixDense, colorscale: 'Portland', opacity: 0.72, showscale: true, name: 'Model', hovertemplate: 'Strike: %{x:.0f}<br>IV: %{z:.4f}<extra>Model</extra>' },
                  ]}
              layout={{
                height: 360,
                margin: { l: 20, r: 20, b: 20, t: 20 },
                paper_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 11 },
                ...(singleExpiry
                  ? {
                      xaxis: { title: 'Strike', gridcolor: '#1f2937' },
                      yaxis: { title: 'IV', gridcolor: '#1f2937' },
                      annotations: [{ xref: 'paper', yref: 'paper', x: 0.02, y: 0.95, text: 'Single expiry: rendering smile slice', showarrow: false, font: { color: '#9ca3af', size: 10 } }],
                    }
                  : {
                      scene: { xaxis: { title: 'Strike' }, yaxis: expiryYAxis, zaxis: { title: 'IV' }, bgcolor: '#0a0f19' },
                    }),
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </Panel>
        </div>

        <Panel title="Market IV Surface 3D" onMaximize={() => setMaximizedChart('market')}>
          <Plot
            data={singleExpiry
              ? [{ type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: marketMatrix[0] || [], line: { color: '#22c55e', width: 2 }, name: 'Market Smile' }]
              : [{ type: 'surface', x: strikeGrid, y: maturityGrid, z: marketMatrix, colorscale: 'Viridis', text: marketExpiryText, hovertemplate: 'Strike: %{x:.0f}<br>Expiry: %{text}<br>IV: %{z:.4f}<extra></extra>' }]}
            layout={{
              height: 260,
              margin: { l: 20, r: 20, b: 20, t: 20 },
              paper_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              ...(singleExpiry
                ? {
                    xaxis: { title: 'Strike', gridcolor: '#1f2937' },
                    yaxis: { title: 'IV', gridcolor: '#1f2937' },
                  }
                : {
                    scene: { xaxis: { title: 'Strike' }, yaxis: expiryYAxis, zaxis: { title: 'IV' }, bgcolor: '#0a0f19' },
                  }),
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="Model IV Surface 3D" onMaximize={() => setMaximizedChart('model')}>
          <Plot
            data={singleExpiry
              ? [{ type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: smoothedModelMatrix[0] || [], line: { color: '#f59e0b', width: 2, shape: 'spline', smoothing: 1.1 }, name: 'Model Smile' }]
              : [{
                  type: 'surface',
                  x: denseModelSurface.strikeDense,
                  y: denseModelSurface.maturityDense,
                  z: denseModelSurface.matrixDense,
                  colorscale: 'Portland',
                  showscale: true,
                  contours: {
                    z: { show: false },
                  },
                  hovertemplate: 'Strike: %{x:.0f}<br>IV: %{z:.4f}<extra>Model</extra>',
                }]}
            layout={{
              height: 260,
              margin: { l: 20, r: 20, b: 20, t: 20 },
              paper_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              ...(singleExpiry
                ? {
                    xaxis: { title: 'Strike', gridcolor: '#1f2937' },
                    yaxis: { title: 'IV', gridcolor: '#1f2937' },
                    annotations: [{ xref: 'paper', yref: 'paper', x: 0.02, y: 0.95, text: 'Single expiry: rendering smile slice', showarrow: false, font: { color: '#9ca3af', size: 10 } }],
                  }
                : {
                    scene: { xaxis: { title: 'Strike' }, yaxis: expiryYAxis, zaxis: { title: 'IV' }, bgcolor: '#0a0f19' },
                  }),
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>
        <Panel title="Residual IV Surface 3D" onMaximize={() => setMaximizedChart('residual')}>
          <Plot
            data={singleExpiry
              ? [{ type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: displayResidualMatrix[0] || [], line: { color: '#f43f5e', width: 2 }, name: 'Residual' },
                 { type: 'scatter', mode: 'lines', x: [strikeGrid[0], strikeGrid[strikeGrid.length - 1]], y: [0, 0], line: { color: '#6b7280', width: 1, dash: 'dash' }, showlegend: false }]
              : [{
                  type: 'surface',
                  x: strikeGrid,
                  y: maturityGrid,
                  z: displayResidualMatrix,
                  colorscale: [[0,'#3b82f6'],[0.5,'#111827'],[1,'#ef4444']],
                  showscale: true,
                  colorbar: { title: 'Residual', tickformat: '.4f' },
                  cmid: 0,
                  hovertemplate: 'Strike: %{x:.0f}<br>Residual: %{z:.4f}<extra></extra>',
                }]}
            layout={{
              height: 260,
              margin: { l: 20, r: 20, b: 20, t: 20 },
              paper_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              ...(singleExpiry
                ? {
                    xaxis: { title: 'Strike', gridcolor: '#1f2937' },
                    yaxis: { title: 'Residual IV', gridcolor: '#1f2937' },
                  }
                : {
                    scene: { xaxis: { title: 'Strike' }, yaxis: expiryYAxis, zaxis: { title: 'Residual IV' }, bgcolor: '#0a0f19' },
                  }),
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>
        <Panel title="Max Pain by Expiry">
          <Plot
            data={[
              {
                type: 'scatter',
                mode: 'lines+markers',
                x: expiryLabels,
                y: maxPainByExpiry,
                line: { color: '#f59e0b', width: 2 },
                marker: { color: '#f59e0b', size: 6 },
                name: 'Max Pain Strike',
              },
            ]}
            layout={{
              height: 180,
              margin: { l: 38, r: 20, b: 32, t: 20 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Expiry' },
              yaxis: { title: 'Max Pain Strike' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
          <Plot
            data={[
              { type: 'bar', x: strikeGrid, y: selectedOiRow, marker: { color: '#38bdf8', opacity: 0.75 }, name: 'Open Interest' },
              selectedMaxPain
                ? {
                    type: 'scatter',
                    mode: 'lines',
                    x: [selectedMaxPain, selectedMaxPain],
                    y: [0, Math.max(...selectedOiRow.map((value) => Number(value) || 0), 1)],
                    line: { color: '#f59e0b', width: 2, dash: 'dash' },
                    name: 'Selected Expiry Max Pain',
                  }
                : null,
            ].filter(Boolean)}
            layout={{
              height: 170,
              margin: { l: 38, r: 20, b: 30, t: 20 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 10 },
              xaxis: { title: 'Strike', gridcolor: '#1f2937' },
              yaxis: { title: 'Open Interest', gridcolor: '#1f2937' },
              barmode: 'overlay',
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="Distribution Plots">
          <Plot
            data={[
              {
                type: 'histogram',
                x: marketIvDistribution,
                opacity: 0.6,
                marker: { color: '#22c55e' },
                name: 'Market IV Dist',
                nbinsx: 24,
              },
              {
                type: 'histogram',
                x: modelIvDistribution,
                opacity: 0.6,
                marker: { color: '#f59e0b' },
                name: 'Model IV Dist',
                nbinsx: 24,
              },
            ]}
            layout={{
              height: 240,
              margin: { l: 36, r: 20, b: 30, t: 20 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Implied Vol', gridcolor: '#1f2937' },
              yaxis: { title: 'Frequency', gridcolor: '#1f2937' },
              barmode: 'overlay',
              legend: { orientation: 'h' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
          <div className="metric-strip">
            <div><span>Selected Expiry</span><strong>{expiryLabels[sliceExpiryIndex] || '-'}</strong></div>
            <div><span>Max Pain Strike</span><strong>{formatNumber(selectedMaxPain, 2)}</strong></div>
            <div><span>Market IV Mean</span><strong>{formatNumber(marketIvDistribution.length ? marketIvDistribution.reduce((a, b) => a + b, 0) / marketIvDistribution.length : 0, 6)}</strong></div>
            <div><span>Model IV Mean</span><strong>{formatNumber(modelIvDistribution.length ? modelIvDistribution.reduce((a, b) => a + b, 0) / modelIvDistribution.length : 0, 6)}</strong></div>
          </div>
        </Panel>
        <Panel title="Heston Calibration">
          {surface?.calibration ? (
            <div className="kv-grid two-col compact">
              <div><span>Status</span><strong style={{color: surface.calibration.converged ? '#22c55e' : '#f43f5e'}}>{surface.calibration.converged ? 'Converged' : 'Not Converged'}</strong></div>
              <div><span>Iterations</span><strong>{surface.calibration.iterations ?? '-'}</strong></div>
              <div><span>Weighted RMSE</span><strong>{formatNumber(surface.calibration.weighted_rmse, 6)}</strong></div>
              <div><span>v\u2080 (Inst. Var)</span><strong>{formatNumber(surface.calibration.parameters?.v0, 6)}</strong></div>
              <div><span>\u03B8 (Long Var)</span><strong>{formatNumber(surface.calibration.parameters?.theta, 6)}</strong></div>
              <div><span>\u03BA (Mean Rev)</span><strong>{formatNumber(surface.calibration.parameters?.kappa, 4)}</strong></div>
              <div><span>\u03C3 (Vol of Vol)</span><strong>{formatNumber(surface.calibration.parameters?.sigma, 6)}</strong></div>
              <div><span>\u03C1 (Correlation)</span><strong>{formatNumber(surface.calibration.parameters?.rho, 4)}</strong></div>
            </div>
          ) : (
            <p style={{color:'#6b7280', fontSize:'0.75rem'}}>Run pipeline to see calibration parameters.</p>
          )}
        </Panel>
        <Panel title="Slice Viewer" className="surface-slice-wide">
          <div className="slice-controls">
            <label>Select Expiry
              <input
                type="range"
                min={0}
                max={Math.max(0, maturityGrid.length - 1)}
                value={sliceExpiryIndex}
                onChange={(event) => {
                  const nextIndex = Number(event.target.value);
                  setSliceExpiryIndex(nextIndex);
                  onExpiryIndexChange?.(nextIndex);
                }}
              />
            </label>
            <label>Select Strike
              <input type="range" min={0} max={Math.max(0, strikeGrid.length - 1)} value={sliceStrikeIndex} onChange={(event) => setSliceStrikeIndex(Number(event.target.value))} />
            </label>
            <label className="checkbox-inline">
              <input type="checkbox" checked={logMoneyness} onChange={(event) => setLogMoneyness(event.target.checked)} />
              Toggle log moneyness
            </label>
          </div>
          <div className="slice-mini-grid">
            <Plot
              data={[
                {
                  type: 'scatter',
                  mode: 'lines+markers',
                  x: strikeGrid.map((strike) => (logMoneyness && market?.spot ? Math.log(Number(strike) / Number(market.spot)) : Number(strike))),
                  y: marketMatrix[sliceExpiryIndex] || [],
                  line: { color: '#22c55e', width: 2 },
                  name: 'Expiry Slice Mkt',
                },
                {
                  type: 'scatter',
                  mode: 'lines+markers',
                  x: strikeGrid.map((strike) => (logMoneyness && market?.spot ? Math.log(Number(strike) / Number(market.spot)) : Number(strike))),
                  y: smoothedModelMatrix[sliceExpiryIndex] || [],
                  line: { color: '#f59e0b', width: 2, shape: 'spline', smoothing: 1.1 },
                  name: 'Expiry Slice Mod',
                },
              ]}
              layout={{
                height: 150,
                margin: { l: 34, r: 12, b: 24, t: 20 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 10 },
                xaxis: { title: logMoneyness ? 'Log Moneyness' : 'Strike', gridcolor: '#1f2937' },
                yaxis: { title: 'IV', gridcolor: '#1f2937' },
                title: { text: 'Expiry Slice', font: { size: 10, color: '#9ca3af' }, x: 0.02, xanchor: 'left' },
                legend: { orientation: 'h', y: 1.2, font: { size: 9 } },
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
            <Plot
              data={[
                {
                  type: 'scatter',
                  mode: 'lines+markers',
                  x: formattedExpiryLabels,
                  y: strikeSeriesMarket,
                  line: { color: '#38bdf8', width: 2 },
                  name: 'Strike Slice Mkt',
                },
                {
                  type: 'scatter',
                  mode: 'lines+markers',
                  x: formattedExpiryLabels,
                  y: strikeSeriesModel,
                  line: { color: '#f43f5e', width: 2, shape: 'spline', smoothing: 1.1 },
                  name: 'Strike Slice Mod',
                },
              ]}
              layout={{
                height: 150,
                margin: { l: 34, r: 12, b: 24, t: 20 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 10 },
                xaxis: { title: 'Expiry', gridcolor: '#1f2937' },
                yaxis: { title: 'IV', gridcolor: '#1f2937' },
                title: { text: 'Strike Slice', font: { size: 10, color: '#9ca3af' }, x: 0.02, xanchor: 'left' },
                legend: { orientation: 'h', y: 1.2, font: { size: 9 } },
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </div>
          <div className="metric-strip">
            <div><span>Residual RMSE</span><strong>{formatNumber(residualRmse, 6)}</strong></div>
            <div><span>Selected Strike</span><strong>{formatNumber(selectedStrikeValue, 2)}</strong></div>
            <div><span>Max |Residual|</span><strong>{formatNumber(residualMaxAbs, 6)}</strong></div>
            <div><span>Selected Expiry</span><strong>{formattedExpiryLabels[sliceExpiryIndex] || '-'}</strong></div>
          </div>
        </Panel>
      </div>

      {/* Fullscreen overlay for maximized 3D chart */}
      {maximizedChart && !singleExpiry && ReactDOM.createPortal(
        <div className="chart-fullscreen-overlay">
          <div className="fullscreen-header">
            <span>{maximizedChart === 'hero' ? 'Market + Model Combined Surface 3D' : maximizedChart === 'market' ? 'Market IV Surface 3D' : maximizedChart === 'residual' ? 'Residual IV Surface 3D' : 'Model IV Surface 3D'}</span>
            <button className="close-btn" onClick={() => setMaximizedChart(null)} type="button">✕ Close</button>
          </div>
          <div className="fullscreen-body">
            <Plot
              data={
                maximizedChart === 'hero'
                  ? [
                      { type: 'surface', x: strikeGrid, y: maturityGrid, z: marketMatrix, colorscale: 'Viridis', opacity: 0.92, showscale: false, name: 'Market', text: marketExpiryText, hovertemplate: 'Strike: %{x:.0f}<br>Expiry: %{text}<br>IV: %{z:.4f}<extra>Market</extra>' },
                      { type: 'surface', x: denseModelSurface.strikeDense, y: denseModelSurface.maturityDense, z: denseModelSurface.matrixDense, colorscale: 'Portland', opacity: 0.72, showscale: true, name: 'Model', hovertemplate: 'Strike: %{x:.0f}<br>IV: %{z:.4f}<extra>Model</extra>' },
                    ]
                  : maximizedChart === 'market'
                  ? [{ type: 'surface', x: strikeGrid, y: maturityGrid, z: marketMatrix, colorscale: 'Viridis', text: marketExpiryText, hovertemplate: 'Strike: %{x:.0f}<br>Expiry: %{text}<br>IV: %{z:.4f}<extra></extra>' }]
                  : maximizedChart === 'residual'
                  ? [{
                      type: 'surface',
                      x: strikeGrid,
                      y: maturityGrid,
                      z: displayResidualMatrix,
                      colorscale: [[0,'#3b82f6'],[0.5,'#111827'],[1,'#ef4444']],
                      showscale: true,
                      colorbar: { title: 'Residual', tickformat: '.4f' },
                      cmid: 0,
                      hovertemplate: 'Strike: %{x:.0f}<br>Residual: %{z:.4f}<extra></extra>',
                    }]
                  : [{
                      type: 'surface',
                      x: denseModelSurface.strikeDense,
                      y: denseModelSurface.maturityDense,
                      z: denseModelSurface.matrixDense,
                      colorscale: 'Portland',
                      showscale: true,
                      contours: { z: { show: false } },
                      hovertemplate: 'Strike: %{x:.0f}<br>IV: %{z:.4f}<extra>Model</extra>',
                    }]
              }
              layout={{
                height: window.innerHeight - 60,
                margin: { l: 20, r: 20, b: 20, t: 20 },
                paper_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 12 },
                scene: { xaxis: { title: 'Strike' }, yaxis: expiryYAxis, zaxis: { title: maximizedChart === 'residual' ? 'Residual IV' : 'IV' }, bgcolor: '#0a0f19' },
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%', height: '100%' }}
              useResizeHandler
            />
          </div>
        </div>,
        document.body,
      )}
    </SnapshotGuard>
  );
}
