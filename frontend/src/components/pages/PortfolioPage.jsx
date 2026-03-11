import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Plot from '../ThemedPlot';
import { portfolioList, portfolioDelete, portfolioClear, portfolioRevalue } from '../../api/client';
import { Panel, formatNumber, formatRs, formatPctVal } from './shared.jsx';

export default function PortfolioPage({ loading, activeSnapshotId, market }) {
  const [positions, setPositions] = useState([]);
  const [totals, setTotals] = useState({ expected_pnl: 0, actual_pnl: 0, delta: 0, gamma: 0, vega: 0, theta: 0, margin: 0 });
  const [liveSpot, setLiveSpot] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [revaluing, setRevaluing] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [tab, setTab] = useState('open');

  const fetchPositions = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await portfolioList(tab);
      const data = res.data || res;
      setPositions(data.positions || []);
      setTotals(data.totals || {});
    } catch (err) {
      console.error('Failed to fetch portfolio:', err);
    } finally {
      setRefreshing(false);
    }
  }, [tab]);

  useEffect(() => { fetchPositions(); }, [fetchPositions]);

  const handleRevalue = async () => {
    setRevaluing(true);
    try {
      const res = await portfolioRevalue();
      const data = res.data || res;
      setPositions(data.positions || []);
      setTotals(data.totals || {});
      if (data.live_spot) setLiveSpot(data.live_spot);
    } catch (err) {
      console.error('Revalue error:', err);
    } finally {
      setRevaluing(false);
    }
  };

  const handleDelete = async (posId) => {
    try {
      await portfolioDelete(posId);
      await fetchPositions();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const handleClearAll = async () => {
    if (!confirm('Delete ALL portfolio positions?')) return;
    try {
      await portfolioClear();
      await fetchPositions();
    } catch (err) {
      console.error('Clear failed:', err);
    }
  };

  const hasActualData = positions.some((p) => p.actual_pnl !== undefined);

  const comparisonData = useMemo(() => {
    if (!positions.length) return null;
    const labels = positions.map((p) => `${p.strategy_type}\n${(p.legs_label || '').slice(0, 20)}`);
    const expected = positions.map((p) => Number(p.expected_value || p.expected_pnl || 0));
    const actual = positions.map((p) => Number(p.actual_pnl ?? p.actual_ev ?? p.expected_value ?? 0));
    return { labels, expected, actual };
  }, [positions]);

  const greeksArr = useMemo(() => {
    const d = { delta: 0, gamma: 0, vega: 0, theta: 0 };
    positions.forEach((p) => {
      d.delta += Number(p.delta_exposure || 0);
      d.gamma += Number(p.gamma_exposure || 0);
      d.vega += Number(p.vega_exposure || 0);
      d.theta += Number(p.theta_exposure || 0);
    });
    return d;
  }, [positions]);

  const greekLabels = ['Delta', 'Gamma', 'Vega', 'Theta'];
  const greekRawValues = useMemo(
    () => [greeksArr.delta, greeksArr.gamma, greeksArr.vega, greeksArr.theta].map((v) => Number(v) || 0),
    [greeksArr],
  );
  const greekMiniSeries = useMemo(
    () => greekLabels.map((label, idx) => ({ label, value: greekRawValues[idx] })),
    [greekLabels, greekRawValues],
  );
  return (
    <div className="page-portfolio-grid">
      <div className="portfolio-left">
        <div className="portfolio-charts-row">
          {comparisonData && (
            <Panel title="Expected vs Actual PnL Comparison">
              <Plot
                data={[
                  { type: 'bar', name: 'Expected EV', x: comparisonData.labels, y: comparisonData.expected, marker: { color: '#f59e0b' } },
                  { type: 'bar', name: 'Actual PnL', x: comparisonData.labels, y: comparisonData.actual, marker: { color: '#22c55e' } },
                ]}
                layout={{
                  barmode: 'group',
                  height: 280,
                  margin: { l: 48, r: 16, b: 80, t: 20 },
                  paper_bgcolor: '#0a0f19',
                  plot_bgcolor: '#0a0f19',
                  font: { color: '#d1d5db', size: 10 },
                  xaxis: { gridcolor: '#1f2937', tickangle: -30 },
                  yaxis: { title: 'PnL', gridcolor: '#1f2937' },
                  legend: { orientation: 'h', y: 1.12 },
                }}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: '100%' }}
                useResizeHandler
              />
            </Panel>
          )}

          <Panel title="Portfolio Greeks Exposure">
            <div className="portfolio-greeks-mini-grid">
              {greekMiniSeries.map((greek) => (
                <div key={greek.label} className="portfolio-greeks-mini-cell">
                  <Plot
                    data={[
                      {
                        type: 'bar',
                        x: [0],
                        y: [greek.value],
                        width: [0.32],
                        marker: {
                          color: greek.value >= 0 ? '#22c55e' : '#ef4444',
                          line: { width: 0 },
                        },
                        hovertemplate: `${greek.label}<br>Exposure: %{y:.6f}<extra></extra>`,
                        name: greek.label,
                      },
                    ]}
                    layout={{
                      height: 122,
                      margin: { l: 36, r: 6, b: 14, t: 20 },
                      paper_bgcolor: '#0a0f19',
                      plot_bgcolor: '#0a0f19',
                      font: { color: '#d1d5db', size: 9 },
                      showlegend: false,
                      title: { text: greek.label, x: 0.03, xanchor: 'left', font: { size: 10, color: '#cbd5e1' } },
                      xaxis: {
                        range: [-0.75, 0.75],
                        showticklabels: false,
                        showgrid: false,
                        zeroline: false,
                      },
                      yaxis: {
                        title: '',
                        autorange: true,
                        gridcolor: '#1f2937',
                        zeroline: true,
                        zerolinecolor: '#94a3b8',
                        zerolinewidth: 1.1,
                      },
                    }}
                    config={{ displaylogo: false, responsive: true }}
                    style={{ width: '100%' }}
                    useResizeHandler
                  />
                </div>
              ))}
            </div>
            <div className="portfolio-greeks-raw">
              {greekLabels.map((label, idx) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{formatNumber(greekRawValues[idx], 6)}</strong>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 6, fontSize: 10, color: '#9ca3af' }}>
              Each mini chart uses its own y-axis scale. Green is above 0 and red is below 0.
            </div>
          </Panel>
        </div>

        <Panel title="Positions — Expected vs Actual">
          <div className="portfolio-controls-inline">
            <div className="portfolio-actions-inline">
              <button type="button" className="action-btn" onClick={fetchPositions} disabled={refreshing}>
                {refreshing ? 'Refreshing...' : 'Refresh'}
              </button>
              <button type="button" className="action-btn accent" onClick={handleRevalue} disabled={revaluing}>
                {revaluing ? 'Revaluing...' : 'Revalue Live'}
              </button>
              <button type="button" className="action-btn" style={{ background: '#7f1d1d' }} onClick={handleClearAll}>
                Clear All
              </button>
            </div>
            <div className="portfolio-tabs-inline">
              <button type="button" className={`action-btn${tab === 'open' ? ' accent' : ''}`} onClick={() => setTab('open')}>Open</button>
              <button type="button" className={`action-btn${tab === 'closed' ? ' accent' : ''}`} onClick={() => setTab('closed')}>Closed</button>
              <span>{positions.length} position{positions.length !== 1 ? 's' : ''}</span>
            </div>
          </div>

          <div className="table-wrap">
            <table className="dense-table sortable-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Strategy</th>
                  <th>Legs</th>
                  <th>Expiry</th>
                  <th>Entry Spot</th>
                  <th>Live Spot</th>
                  <th>Spot Δ%</th>
                  <th style={{ color: '#f59e0b' }}>Exp EV</th>
                  <th style={{ color: '#22c55e' }}>Act PnL</th>
                  <th style={{ color: '#f59e0b' }}>Exp VaR95</th>
                  <th style={{ color: '#22c55e' }}>Act VaR95</th>
                  <th style={{ color: '#f59e0b' }}>Exp VaR99</th>
                  <th style={{ color: '#22c55e' }}>Act VaR99</th>
                  <th style={{ color: '#f59e0b' }}>Exp ES</th>
                  <th style={{ color: '#22c55e' }}>Act ES</th>
                  <th>Delta</th>
                  <th>Gamma</th>
                  <th>Vega</th>
                  <th>Theta</th>
                  <th>Margin</th>
                  <th>P(Loss)</th>
                  <th>Fragility</th>
                  <th>Score</th>
                  <th>Added</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {positions.length ? positions.map((pos) => (
                  <React.Fragment key={pos.id}>
                    <tr
                      className={expandedId === pos.id ? 'selected-row' : ''}
                      onClick={() => setExpandedId(expandedId === pos.id ? null : pos.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={{ fontSize: 10 }}>{expandedId === pos.id ? '▼' : '▶'}</td>
                      <td>{pos.strategy_type}</td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: '0.8em' }}>{pos.legs_label || '-'}</td>
                      <td style={{ color: '#38bdf8', fontSize: '0.8em' }}>{pos.expiry_date || '-'}</td>
                      <td>{formatNumber(pos.spot_at_entry, 2)}</td>
                      <td>{pos.live_spot ? formatNumber(pos.live_spot, 2) : '-'}</td>
                      <td style={{ color: Number(pos.spot_change_pct ?? 0) >= 0 ? '#22c55e' : '#f43f5e' }}>
                        {pos.spot_change_pct !== undefined ? `${pos.spot_change_pct}%` : '-'}
                      </td>
                      <td style={{ color: '#f59e0b' }}>{formatNumber(pos.expected_value, 4)}</td>
                      <td style={{ color: Number(pos.actual_pnl ?? 0) >= 0 ? '#22c55e' : '#f43f5e' }}>
                        {pos.actual_pnl !== undefined ? formatNumber(pos.actual_pnl, 4) : '-'}
                      </td>
                      <td style={{ color: '#f59e0b' }}>{formatRs(pos.var_95)}</td>
                      <td style={{ color: '#22c55e' }}>{pos.actual_var95 !== undefined ? formatRs(pos.actual_var95) : '-'}</td>
                      <td style={{ color: '#f59e0b' }}>{formatRs(pos.var_99)}</td>
                      <td style={{ color: '#22c55e' }}>{pos.actual_var99 !== undefined ? formatRs(pos.actual_var99) : '-'}</td>
                      <td style={{ color: '#f59e0b' }}>{formatRs(pos.expected_shortfall)}</td>
                      <td style={{ color: '#22c55e' }}>{pos.actual_es !== undefined ? formatRs(pos.actual_es) : '-'}</td>
                      <td>{formatNumber(pos.delta_exposure, 4)}</td>
                      <td>{formatNumber(pos.gamma_exposure, 4)}</td>
                      <td>{formatNumber(pos.vega_exposure, 4)}</td>
                      <td>{formatNumber(pos.theta_exposure, 4)}</td>
                      <td>{formatRs(pos.margin_required)}</td>
                      <td style={{ color: Number(pos.probability_of_loss ?? 0) > 0.5 ? '#f43f5e' : '#22c55e' }}>
                        {formatPctVal(pos.probability_of_loss)}
                      </td>
                      <td>{formatNumber(pos.fragility_score, 4)}</td>
                      <td>{formatPctVal(pos.overall_score)}</td>
                      <td style={{ fontSize: '0.75em', whiteSpace: 'nowrap' }}>{pos.added_at ? pos.added_at.slice(0, 16).replace('T', ' ') : '-'}</td>
                      <td>
                        <button
                          type="button"
                          className="action-btn"
                          style={{ background: '#7f1d1d', padding: '2px 8px', fontSize: 11 }}
                          onClick={(e) => { e.stopPropagation(); handleDelete(pos.id); }}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                    {expandedId === pos.id && (
                      <tr>
                        <td colSpan={25} style={{ padding: 0 }}>
                          <PositionDetailRow pos={pos} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )) : (
                  <tr><td colSpan={25} style={{ textAlign: 'center', padding: 24, color: '#6b7280' }}>
                    No portfolio positions. Add strategies from the Strategy Screener.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <div className="portfolio-right">
        <Panel title="Portfolio Snapshot">
          <div className="portfolio-kpi-stack">
            <div><span>Expected PnL</span><strong style={{ color: '#f59e0b' }}>{formatNumber(totals.expected_pnl ?? totals.pnl, 2)}</strong></div>
            <div><span>Actual PnL</span><strong style={{ color: Number(totals.actual_pnl ?? 0) >= 0 ? '#22c55e' : '#f43f5e' }}>{hasActualData ? formatNumber(totals.actual_pnl, 2) : '-'}</strong></div>
            <div><span>Live Spot</span><strong>{liveSpot ? formatNumber(liveSpot, 2) : '-'}</strong></div>
            <div><span>Total Delta</span><strong>{formatNumber(totals.delta, 4)}</strong></div>
            <div><span>Total Margin</span><strong>{formatNumber(totals.margin, 2)}</strong></div>
          </div>
        </Panel>
      </div>
      </div>
  );
}


function PositionDetailRow({ pos }) {
  const pnlDist = Array.isArray(pos.pnl_distribution) ? pos.pnl_distribution.map(Number).filter(Number.isFinite) : [];
  const hasDist = pnlDist.length > 10;
  const expectedCenter = Number(pos.expected_value ?? 0);
  const actualCenter = pos.actual_pnl !== undefined && pos.actual_pnl !== null
    ? Number(pos.actual_pnl)
    : (pos.actual_ev !== undefined && pos.actual_ev !== null ? Number(pos.actual_ev) : null);
  const hasActualCenter = actualCenter !== null && Number.isFinite(actualCenter);
  const actualDist = hasDist && hasActualCenter
    ? pnlDist.map((v) => v + (actualCenter - expectedCenter))
    : [];
  const kdeExpected = pnlDist.length ? buildKdeSeries(pnlDist) : { x: [], y: [] };
  const kdeActual = actualDist.length ? buildKdeSeries(actualDist) : { x: [], y: [] };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12, background: '#0d1320', borderBottom: '1px solid #1f2937' }}>
      <div>
        <h4 style={{ margin: '0 0 8px', color: '#f59e0b', fontSize: 12 }}>Expected vs Actual Metrics</h4>
        <table className="dense-table" style={{ fontSize: 11 }}>
          <thead>
            <tr><th>Metric</th><th style={{ color: '#f59e0b' }}>Expected</th><th style={{ color: '#22c55e' }}>Actual</th><th>Diff</th></tr>
          </thead>
          <tbody>
            <MetricRow label="EV / PnL" expected={pos.expected_value} actual={pos.actual_pnl ?? pos.actual_ev} />
            <MetricRow label="VaR 95" expected={pos.var_95} actual={pos.actual_var95} isRs />
            <MetricRow label="VaR 99" expected={pos.var_99} actual={pos.actual_var99} isRs />
            <MetricRow label="Expected Shortfall" expected={pos.expected_shortfall} actual={pos.actual_es} isRs />
            <MetricRow label="P(Loss)" expected={pos.probability_of_loss} actual={pos.actual_prob_loss} digits={4} isPct />
            <tr>
              <td>Entry Spot → Live</td>
              <td>{formatNumber(pos.spot_at_entry, 2)}</td>
              <td>{pos.live_spot ? formatNumber(pos.live_spot, 2) : '-'}</td>
              <td style={{ color: Number(pos.spot_change ?? 0) >= 0 ? '#22c55e' : '#f43f5e' }}>
                {pos.spot_change !== undefined ? formatNumber(pos.spot_change, 2) : '-'}
              </td>
            </tr>
          </tbody>
        </table>
        <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>
          <div>Legs: {pos.legs_label || '-'}</div>
          <div>Strikes: {Array.isArray(pos.strikes) ? pos.strikes.join(', ') : '-'}</div>
          <div>Break Even: {Array.isArray(pos.break_even_levels) ? pos.break_even_levels.map((v) => Number(v).toFixed(2)).join(', ') : '-'}</div>
          <div>Margin: {formatRs(pos.margin_required)} | RoM: {formatNumber(pos.return_on_margin, 6)}</div>
        </div>
      </div>

      <div>
        {hasDist ? (
          <Plot
            data={[
              {
                type: 'scatter',
                mode: 'lines',
                x: kdeExpected.x,
                y: kdeExpected.y,
                line: { color: '#f59e0b', width: 2 },
                fill: 'tozeroy',
                fillcolor: 'rgba(245, 158, 11, 0.30)',
                name: 'Expected (P)',
              },
              ...(kdeActual.x.length
                ? [{
                    type: 'scatter',
                    mode: 'lines',
                    x: kdeActual.x,
                    y: kdeActual.y,
                    line: { color: '#22c55e', width: 2 },
                    fill: 'tozeroy',
                    fillcolor: 'rgba(34, 197, 94, 0.28)',
                    name: 'Actual (Q)',
                  }]
                : []),
            ]}
            layout={{
              height: 200,
              margin: { l: 36, r: 12, b: 28, t: 12 },
              paper_bgcolor: '#0d1320',
              plot_bgcolor: '#0d1320',
              font: { color: '#d1d5db', size: 10 },
              xaxis: { title: 'PnL', gridcolor: '#1f2937' },
              yaxis: { title: 'Density', gridcolor: '#1f2937' },
              showlegend: true,
              legend: { orientation: 'h', y: 1.12, x: 0 },
              shapes: [
                { type: 'line', x0: 0, x1: 0, y0: 0, y1: 1, yref: 'paper', line: { color: '#6b7280', width: 1, dash: 'dash' } },
                { type: 'line', x0: expectedCenter, x1: expectedCenter, y0: 0, y1: 1, yref: 'paper', line: { color: '#f59e0b', width: 2 } },
                ...(hasActualCenter ? [{ type: 'line', x0: actualCenter, x1: actualCenter, y0: 0, y1: 1, yref: 'paper', line: { color: '#22c55e', width: 2 } }] : []),
              ],
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        ) : (
          <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280' }}>
            No PnL distribution stored
          </div>
        )}
      </div>
    </div>
  );
}

function buildKdeSeries(values) {
  if (!Array.isArray(values) || values.length < 2) return { x: [], y: [] };
  const n = values.length;
  const mean = values.reduce((acc, v) => acc + v, 0) / n;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / Math.max(n - 1, 1);
  const std = Math.sqrt(Math.max(variance, 1e-12));
  const h = Math.max(1.06 * std * (n ** (-1 / 5)), 1e-6);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const pad = Math.max(std * 1.5, h * 3);
  const xMin = minV - pad;
  const xMax = maxV + pad;
  const steps = 140;
  const dx = (xMax - xMin) / steps;
  const invSqrt2Pi = 1 / Math.sqrt(2 * Math.PI);
  const invNh = 1 / (n * h);
  const x = [];
  const y = [];
  for (let i = 0; i <= steps; i += 1) {
    const xi = xMin + dx * i;
    let sum = 0;
    for (let j = 0; j < n; j += 1) {
      const u = (xi - values[j]) / h;
      sum += Math.exp(-0.5 * u * u) * invSqrt2Pi;
    }
    x.push(xi);
    y.push(invNh * sum);
  }
  return { x, y };
}


function MetricRow({ label, expected, actual, digits = 4, isPct = false, isRs = false }) {
  const exp = Number(expected ?? 0);
  const act = actual !== undefined && actual !== null ? Number(actual) : null;
  const diff = act !== null ? act - exp : null;
  const fmt = isRs ? (v) => formatRs(v) : isPct ? (v) => formatPctVal(v, digits) : (v) => formatNumber(v, digits);
  const fmtDiff = isRs
    ? (v) => { const rs = Number(v) * 65; return (rs >= 0 ? '+\u20B9' : '-\u20B9') + Math.abs(rs).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
    : isPct
    ? (v) => (v >= 0 ? '+' : '') + (v * 100).toFixed(digits) + '%'
    : (v) => (v >= 0 ? '+' : '') + formatNumber(v, digits);
  return (
    <tr>
      <td>{label}</td>
      <td style={{ color: '#f59e0b' }}>{fmt(expected)}</td>
      <td style={{ color: '#22c55e' }}>{act !== null ? fmt(act) : '-'}</td>
      <td style={{ color: diff !== null ? (diff >= 0 ? '#22c55e' : '#f43f5e') : '#6b7280' }}>
        {diff !== null ? fmtDiff(diff) : '-'}
      </td>
    </tr>
  );
}
