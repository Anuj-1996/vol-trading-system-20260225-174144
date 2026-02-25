import React, { useMemo, useState } from 'react';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber } from './shared.jsx';

export default function StrategyScreenerPage({
  loading,
  activeSnapshotId,
  strategies,
  selectedStrategyId,
  onSelectStrategy,
  market,
}) {
  const [strategyTypeFilter, setStrategyTypeFilter] = useState('all');
  const [deltaRange, setDeltaRange] = useState(5);
  const [vegaRange, setVegaRange] = useState(5);
  const [maxMargin, setMaxMargin] = useState(500000);

  const items = Array.isArray(strategies?.items) ? strategies.items : [];
  const selectedStrategy = items.find((item) => item.id === selectedStrategyId) || items[0] || null;
  const spot = Number(market?.spot ?? 0);

  const payoffCurve = useMemo(() => {
    if (!selectedStrategy || !spot) {
      return { x: [], y: [] };
    }
    const expected = Number(selectedStrategy.expected_value ?? 0);
    const maxLoss = Number(selectedStrategy.max_loss ?? 0);
    const delta = Number(selectedStrategy.delta_exposure ?? 0);
    const gamma = Number(selectedStrategy.gamma_exposure ?? 0);
    const strikes = Array.isArray(selectedStrategy.strikes) ? selectedStrategy.strikes.map(Number) : [];
    const center = strikes.length ? strikes.reduce((a, b) => a + b, 0) / strikes.length : spot;

    const x = Array.from({ length: 41 }, (_, index) => spot * (0.85 + index * 0.0075));
    const y = x.map((s) => {
      const displacement = (s - center) / Math.max(spot, 1e-8);
      const pnl = expected + delta * displacement * spot + 0.5 * gamma * displacement * displacement * spot;
      return Math.max(-maxLoss, pnl);
    });
    return { x, y };
  }, [selectedStrategy, spot]);

  const strategyTypeOptions = useMemo(
    () => ['all', ...Array.from(new Set(items.map((item) => item.strategy_type).filter(Boolean)))],
    [items],
  );

  const filteredItems = useMemo(
    () => items.filter((item) => {
      const typePass = strategyTypeFilter === 'all' || item.strategy_type === strategyTypeFilter;
      const deltaPass = Math.abs(Number(item.delta_exposure ?? 0)) <= Number(deltaRange);
      const vegaPass = Math.abs(Number(item.vega_exposure ?? 0)) <= Number(vegaRange);
      const marginPass = Number(item.margin_required ?? 0) <= Number(maxMargin);
      return typePass && deltaPass && vegaPass && marginPass;
    }),
    [items, strategyTypeFilter, deltaRange, vegaRange, maxMargin],
  );

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-screener-grid">
        <Panel title="Filters Bar">
          <div className="filters-grid">
            <label>Strategy type
              <select value={strategyTypeFilter} onChange={(event) => setStrategyTypeFilter(event.target.value)}>
                {strategyTypeOptions.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>Delta range
              <input type="number" value={deltaRange} onChange={(event) => setDeltaRange(Number(event.target.value))} />
            </label>
            <label>Vega range
              <input type="number" value={vegaRange} onChange={(event) => setVegaRange(Number(event.target.value))} />
            </label>
            <label>Max margin
              <input type="number" value={maxMargin} onChange={(event) => setMaxMargin(Number(event.target.value))} />
            </label>
          </div>
        </Panel>

        <div className="screener-main">
          <Panel title="Ranking Table">
            <div className="table-wrap">
              <table className="dense-table">
                <thead>
                  <tr>
                    <th>Strategy Type</th>
                    <th>Strikes</th>
                    <th>Cost</th>
                    <th>Expected Return</th>
                    <th>VaR 95</th>
                    <th>VaR 99</th>
                    <th>Expected Shortfall</th>
                    <th>Return on Margin</th>
                    <th>Vega Exposure</th>
                    <th>Gamma Exposure</th>
                    <th>Fragility Score</th>
                    <th>Overall Score</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.length ? (
                    filteredItems.map((item) => (
                      <tr key={item.id} className={item.id === selectedStrategy?.id ? 'selected-row' : ''} onClick={() => onSelectStrategy(item.id)}>
                        <td>{item.strategy_type}</td>
                        <td>{Array.isArray(item.strikes) ? item.strikes.join(', ') : '-'}</td>
                        <td>{formatNumber(item.cost, 2)}</td>
                        <td>{formatNumber(item.expected_value, 4)}</td>
                        <td>{formatNumber(item.var_95, 4)}</td>
                        <td>{formatNumber(item.var_99, 4)}</td>
                        <td>{formatNumber(item.expected_shortfall, 4)}</td>
                        <td>{formatNumber(item.return_on_margin, 6)}</td>
                        <td>{formatNumber(item.vega_exposure, 4)}</td>
                        <td>{formatNumber(item.gamma_exposure, 4)}</td>
                        <td>{formatNumber(item.fragility_score, 6)}</td>
                        <td>{formatNumber(item.overall_score, 6)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr><td colSpan={12}>No strategies available for selected filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>

        <div className="screener-side">
          <Panel title="Selected Strategy Summary">
            <Plot
              data={[{ type: 'scatter', mode: 'lines', x: payoffCurve.x, y: payoffCurve.y, line: { color: '#f59e0b', width: 2 } }]}
              layout={{
                height: 220,
                margin: { l: 32, r: 12, b: 24, t: 18 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 11 },
                xaxis: { title: 'Spot', gridcolor: '#1f2937' },
                yaxis: { title: 'Payoff', gridcolor: '#1f2937' },
                showlegend: false,
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
            <div className="kv-grid one-col compact">
              <div><span>Delta</span><strong>{formatNumber(selectedStrategy?.delta_exposure, 4)}</strong></div>
              <div><span>Vega</span><strong>{formatNumber(selectedStrategy?.vega_exposure, 4)}</strong></div>
              <div><span>Gamma</span><strong>{formatNumber(selectedStrategy?.gamma_exposure, 4)}</strong></div>
              <div><span>Margin Required</span><strong>{formatNumber(selectedStrategy?.margin_required, 2)}</strong></div>
              <div><span>Break Even</span><strong>{Array.isArray(selectedStrategy?.break_even_levels) ? selectedStrategy.break_even_levels.join(', ') : '-'}</strong></div>
            </div>
          </Panel>
        </div>
      </div>
    </SnapshotGuard>
  );
}
