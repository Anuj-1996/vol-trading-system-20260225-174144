import React, { useEffect, useMemo, useState } from 'react';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber } from './shared.jsx';

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

  const strikeGrid = Array.isArray(surface?.strike_grid) ? surface.strike_grid : [];
  const maturityGrid = Array.isArray(surface?.maturity_grid) ? surface.maturity_grid : [];
  const marketMatrix = Array.isArray(surface?.market_iv_matrix) ? surface.market_iv_matrix : [];
  const modelMatrix = Array.isArray(surface?.model_iv_matrix) ? surface.model_iv_matrix : [];
  const residualMatrix = Array.isArray(surface?.residual_iv_matrix) ? surface.residual_iv_matrix : [];
  const singleExpiry = maturityGrid.length < 2;
  const selectedStrikeValue = strikeGrid[sliceStrikeIndex] || 0;

  const strikeSeriesMarket = useMemo(
    () => maturityGrid.map((_, idx) => marketMatrix[idx]?.[sliceStrikeIndex] ?? null),
    [maturityGrid, marketMatrix, sliceStrikeIndex],
  );
  const strikeSeriesModel = useMemo(
    () => maturityGrid.map((_, idx) => modelMatrix[idx]?.[sliceStrikeIndex] ?? null),
    [maturityGrid, modelMatrix, sliceStrikeIndex],
  );

  const residualValues = residualMatrix.flat().map((value) => Number(value));
  const residualRmse = residualValues.length
    ? Math.sqrt(residualValues.reduce((acc, value) => acc + value * value, 0) / residualValues.length)
    : 0;

  useEffect(() => {
    setSliceExpiryIndex(selectedExpiryIndex);
  }, [selectedExpiryIndex]);

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-surface-grid">
        <Panel title="Market IV Surface 3D">
          <Plot
            data={singleExpiry
              ? [{ type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: marketMatrix[0] || [], line: { color: '#22c55e', width: 2 }, name: 'Market Smile' }]
              : [{ type: 'surface', x: strikeGrid, y: maturityGrid, z: marketMatrix, colorscale: 'Viridis' }]}
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
                    scene: { xaxis: { title: 'Strike' }, yaxis: { title: 'Maturity' }, zaxis: { title: 'IV' }, bgcolor: '#0a0f19' },
                  }),
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>
        <Panel title="Model IV Surface 3D">
          <Plot
            data={singleExpiry
              ? [{ type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: modelMatrix[0] || [], line: { color: '#f59e0b', width: 2 }, name: 'Model Smile' }]
              : [{ type: 'surface', x: strikeGrid, y: maturityGrid, z: modelMatrix, colorscale: 'Portland' }]}
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
                    scene: { xaxis: { title: 'Strike' }, yaxis: { title: 'Maturity' }, zaxis: { title: 'IV' }, bgcolor: '#0a0f19' },
                  }),
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>
        <Panel title="Surface Difference Heatmap">
          <Plot
            data={singleExpiry
              ? [{ type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: residualMatrix[0] || [], line: { color: '#38bdf8', width: 2 }, name: 'Residual Slice' }]
              : [{ type: 'heatmap', x: strikeGrid, y: maturityGrid, z: residualMatrix, colorscale: 'RdBu', zmid: 0 }]}
            layout={{
              height: 260,
              margin: { l: 38, r: 20, b: 32, t: 20 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Strike' },
              yaxis: { title: singleExpiry ? 'Residual IV' : 'Maturity' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>
        <Panel title="Slice Viewer">
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
          <Plot
            data={[
              {
                type: 'scatter',
                mode: 'lines+markers',
                x: strikeGrid.map((strike) => (logMoneyness && market?.spot ? Math.log(Number(strike) / Number(market.spot)) : Number(strike))),
                y: marketMatrix[sliceExpiryIndex] || [],
                line: { color: '#22c55e', width: 2 },
                name: 'Smile Market',
              },
              {
                type: 'scatter',
                mode: 'lines+markers',
                x: strikeGrid.map((strike) => (logMoneyness && market?.spot ? Math.log(Number(strike) / Number(market.spot)) : Number(strike))),
                y: modelMatrix[sliceExpiryIndex] || [],
                line: { color: '#f59e0b', width: 2 },
                name: 'Smile Model',
              },
              {
                type: 'scatter',
                mode: 'lines+markers',
                x: maturityGrid.map((value) => Number(value) * 365),
                y: strikeSeriesMarket,
                line: { color: '#38bdf8', width: 2 },
                name: `Strike Slice Mkt ${selectedStrikeValue}`,
              },
              {
                type: 'scatter',
                mode: 'lines+markers',
                x: maturityGrid.map((value) => Number(value) * 365),
                y: strikeSeriesModel,
                line: { color: '#f43f5e', width: 2 },
                name: `Strike Slice Mod ${selectedStrikeValue}`,
              },
            ]}
            layout={{
              height: 220,
              margin: { l: 38, r: 20, b: 32, t: 20 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: logMoneyness ? 'Log Moneyness / Days' : 'Strike / Days' },
              yaxis: { title: 'IV' },
              legend: { orientation: 'h' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
          <div className="kv-grid two-col compact">
            <div><span>Residual RMSE</span><strong>{formatNumber(residualRmse, 6)}</strong></div>
            <div><span>Selected Strike</span><strong>{formatNumber(selectedStrikeValue, 2)}</strong></div>
          </div>
        </Panel>
      </div>
    </SnapshotGuard>
  );
}
