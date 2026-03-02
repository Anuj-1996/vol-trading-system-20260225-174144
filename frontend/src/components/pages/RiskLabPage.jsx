import React, { useMemo, useState } from 'react';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber } from './shared.jsx';

export default function RiskLabPage({ loading, activeSnapshotId, risk }) {
  const [spotShift, setSpotShift] = useState(0);
  const [volShift, setVolShift] = useState(0);
  const [skewTwist, setSkewTwist] = useState(0);
  const [timeForward, setTimeForward] = useState(0);
  const [correlation, setCorrelation] = useState(0);

  const updated = useMemo(() => {
    const basePnl = Number(risk?.base_pnl ?? 0);
    const baseDelta = Number(risk?.delta ?? 0);
    const baseGamma = Number(risk?.gamma ?? 0);
    const baseVega = Number(risk?.vega ?? 0);
    const baseVar95 = Number(risk?.var_95 ?? 0);
    const baseEs = Number(risk?.expected_shortfall ?? 0);

    const spotFactor = 1 + spotShift / 100;
    const volFactor = 1 + volShift / 100;
    const skewFactor = 1 + skewTwist / 100;
    const timeFactor = 1 - timeForward / 365;
    const corrFactor = 1 + correlation * 0.1;

    return {
      pnl: basePnl * spotFactor * volFactor * skewFactor * timeFactor,
      delta: baseDelta * spotFactor,
      gamma: baseGamma * spotFactor * skewFactor,
      vega: baseVega * volFactor * corrFactor,
      var95: Math.abs(baseVar95) * spotFactor * corrFactor,
      var99: Math.abs(Number(risk?.var_99 ?? baseVar95 * 1.3)) * spotFactor * corrFactor,
      es: Math.abs(baseEs) * spotFactor * corrFactor,
    };
  }, [risk, spotShift, volShift, skewTwist, timeForward, correlation]);

  const scenarioAxis = [-20, -10, 0, 10, 20];

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-risk-grid">
        <Panel title="Control Panel">
          <div className="control-stack">
            <label>Spot shift slider ({spotShift}%)
              <input type="range" min={-20} max={20} value={spotShift} onChange={(event) => setSpotShift(Number(event.target.value))} />
            </label>
            <label>Vol shift slider ({volShift}%)
              <input type="range" min={-30} max={30} value={volShift} onChange={(event) => setVolShift(Number(event.target.value))} />
            </label>
            <label>Skew twist control ({skewTwist}%)
              <input type="range" min={-20} max={20} value={skewTwist} onChange={(event) => setSkewTwist(Number(event.target.value))} />
            </label>
            <label>Time forward control ({timeForward} days)
              <input type="range" min={0} max={30} value={timeForward} onChange={(event) => setTimeForward(Number(event.target.value))} />
            </label>
            <label>Correlation control ({correlation.toFixed(2)})
              <input type="range" min={-1} max={1} step={0.05} value={correlation} onChange={(event) => setCorrelation(Number(event.target.value))} />
            </label>
          </div>
        </Panel>

        <Panel title="Risk Output">
          <div className="kv-grid two-col">
            <div><span>Updated PnL</span><strong>{formatNumber(updated.pnl, 4)}</strong></div>
            <div><span>Updated Delta</span><strong>{formatNumber(updated.delta, 4)}</strong></div>
            <div><span>Updated Gamma</span><strong>{formatNumber(updated.gamma, 4)}</strong></div>
            <div><span>Updated Vega</span><strong>{formatNumber(updated.vega, 4)}</strong></div>
            <div><span>VaR Recalculated</span><strong>{formatNumber(updated.var95, 4)}</strong></div>
            <div><span>VaR 99 Recalculated</span><strong>{formatNumber(updated.var99, 4)}</strong></div>
            <div><span>Expected Shortfall</span><strong>{formatNumber(updated.es, 4)}</strong></div>
          </div>
          <Plot
            data={[
              {
                type: 'scatter',
                mode: 'lines+markers',
                x: scenarioAxis,
                y: scenarioAxis.map((point) => updated.var95 * (1 + point / 150)),
                name: 'VaR 95',
                line: { color: '#f59e0b', width: 2 },
              },
              {
                type: 'scatter',
                mode: 'lines+markers',
                x: scenarioAxis,
                y: scenarioAxis.map((point) => updated.es * (1 + point / 150)),
                name: 'Expected Shortfall',
                line: { color: '#f43f5e', width: 2 },
              },
            ]}
            layout={{
              height: 180,
              margin: { l: 38, r: 20, b: 30, t: 20 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Scenario Shift %', gridcolor: '#1f2937' },
              yaxis: { title: 'Risk', gridcolor: '#1f2937' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
          <Plot
            data={[{ type: 'heatmap', x: scenarioAxis, y: scenarioAxis, z: scenarioAxis.map((row) => scenarioAxis.map((col) => updated.pnl * (1 + (row + col) / 200))), colorscale: 'Viridis' }]}
            layout={{
              height: 280,
              margin: { l: 38, r: 20, b: 32, t: 20 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Spot Shift', gridcolor: '#1f2937' },
              yaxis: { title: 'Vol Shift', gridcolor: '#1f2937' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>
      </div>
    </SnapshotGuard>
  );
}
