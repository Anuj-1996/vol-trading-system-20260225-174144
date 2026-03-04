import React, { useMemo, useState } from 'react';
import Plot from 'react-plotly.js';
import { aiStrategyPick, portfolioAdd } from '../../api/client';
import { Panel, SnapshotGuard, formatNumber, formatRs, formatPctVal, NIFTY_LOT_SIZE } from './shared.jsx';

const ADD_BTN_STYLE = {
  background: '#065f46', border: 'none', color: '#34d399', cursor: 'pointer',
  padding: '3px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
};

export default function StrategyScreenerPage({
  loading,
  activeSnapshotId,
  strategies,
  selectedStrategyId,
  onSelectStrategy,
  market,
  pipelineData,
  onPortfolioAdd,
}) {
  const [strategyTypeFilter, setStrategyTypeFilter] = useState('all');
  const [expiryFilter, setExpiryFilter] = useState('all');
  const [deltaRange, setDeltaRange] = useState(100);
  const [addingToPortfolio, setAddingToPortfolio] = useState(null); // null or strategy id
  const [vegaRange, setVegaRange] = useState(100);
  const [maxMargin, setMaxMargin] = useState(5000000);
  const [sortCol, setSortCol] = useState('overall_score');
  const [sortAsc, setSortAsc] = useState(false);
  const [agentModel, setAgentModel] = useState('gemma3:1b');
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentResult, setAgentResult] = useState(null);
  const [agentError, setAgentError] = useState('');

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

  const expiryOptions = useMemo(
    () => ['all', ...Array.from(new Set(items.map((item) => item.expiry || item.expiry_date).filter(Boolean)))],
    [items],
  );

  const filteredItems = useMemo(
    () => {
      const filtered = items.filter((item) => {
        const typePass = strategyTypeFilter === 'all' || item.strategy_type === strategyTypeFilter;
        const expiryValue = item.expiry || item.expiry_date || null;
        const expiryPass = expiryFilter === 'all' || expiryValue === expiryFilter;
        const deltaPass = Math.abs(Number(item.delta_exposure ?? 0)) <= Number(deltaRange);
        const vegaPass = Math.abs(Number(item.vega_exposure ?? 0)) <= Number(vegaRange);
        const marginPass = Number(item.margin_required ?? 0) <= Number(maxMargin);
        return typePass && expiryPass && deltaPass && vegaPass && marginPass;
      });
      const sorted = [...filtered].sort((a, b) => {
        const av = Number(a[sortCol] ?? 0);
        const bv = Number(b[sortCol] ?? 0);
        return sortAsc ? av - bv : bv - av;
      });
      return sorted;
    },
    [items, strategyTypeFilter, expiryFilter, deltaRange, vegaRange, maxMargin, sortCol, sortAsc],
  );

  const handleSort = (col) => {
    if (sortCol === col) { setSortAsc(!sortAsc); } else { setSortCol(col); setSortAsc(false); }
  };
  const sortIndicator = (col) => sortCol === col ? (sortAsc ? ' \u25b2' : ' \u25bc') : '';

  const runAgentPick = async () => {
    setAgentError('');
    setAgentLoading(true);
    try {
      const response = await aiStrategyPick(pipelineData || null, agentModel, 3);
      const result = response?.data || response;
      setAgentResult(result);
      const pickedId = result?.primary?.id;
      if (pickedId) {
        onSelectStrategy?.(pickedId);
      }
    } catch (err) {
      setAgentError(err?.message || 'Failed to run strategy picker.');
    } finally {
      setAgentLoading(false);
    }
  };

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-screener-grid">
        <Panel title="Agentic Strategy Selector">
          <div style={{display: 'grid', gridTemplateColumns: '220px 180px 1fr', gap: 10, alignItems: 'center'}}>
            <button type="button" className="action-btn accent" onClick={runAgentPick} disabled={agentLoading || loading}>
              {agentLoading ? 'Selecting...' : 'Agent Pick Strategy'}
            </button>
            <select value={agentModel} onChange={(e) => setAgentModel(e.target.value)}>
              <option value="gemma3:1b">Gemma 3 1B</option>
              <option value="gemma:2b">Gemma 2B</option>
              <option value="gemma3:4b">Gemma 3 4B</option>
            </select>
            <div style={{fontSize: 12, color: '#9ca3af'}}>
              Separate from Copilot chat: picks strategy using current market snapshot + regime policy.
            </div>
          </div>
          {agentError ? <div style={{marginTop: 8, color: '#ef4444'}}>{agentError}</div> : null}
          {agentResult ? (
            <div style={{marginTop: 10, display: 'grid', gap: 8}}>
              <div style={{fontSize: 13}}>
                <strong style={{color: '#22c55e'}}>Primary:</strong>{' '}
                {agentResult?.primary?.strategy_type || '-'} | {agentResult?.primary?.legs_label || '-'} | Confidence {formatNumber(agentResult?.confidence, 1)}%
              </div>
              <div style={{fontSize: 12, color: '#d1d5db'}}>{agentResult?.summary || ''}</div>
              {Array.isArray(agentResult?.why_bullets) && agentResult.why_bullets.length ? (
                <ul style={{margin: 0, paddingLeft: 18, fontSize: 12, color: '#d1d5db'}}>
                  {agentResult.why_bullets.map((line, idx) => <li key={idx}>{line}</li>)}
                </ul>
              ) : null}
              {Array.isArray(agentResult?.alternatives) && agentResult.alternatives.length ? (
                <div style={{fontSize: 12, color: '#9ca3af'}}>
                  Alternatives: {agentResult.alternatives.map((x) => x?.strategy_type).filter(Boolean).join(', ')}
                </div>
              ) : null}
            </div>
          ) : null}
        </Panel>

        <Panel title="Selected Strategy Summary" className="screener-summary-panel">
          <div className="screener-summary-grid">
            <Plot
              data={[{ type: 'scatter', mode: 'lines', x: payoffCurve.x, y: payoffCurve.y, line: { color: '#f59e0b', width: 2 } }]}
              layout={{
                height: 300,
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
            <div className="kv-grid two-col compact screener-summary-kv">
              <div className="full-span"><span>Legs</span><strong style={{fontSize:'0.8em'}}>{selectedStrategy?.legs_label || '-'}</strong></div>
              <div><span>Expiry</span><strong style={{color:'#38bdf8'}}>{selectedStrategy?.expiry_date || '-'}</strong></div>
              <div><span>Premium</span><strong style={{color: Number(selectedStrategy?.net_premium ?? 0) < 0 ? '#f43f5e' : '#22c55e'}}>{formatRs(selectedStrategy?.net_premium)}</strong></div>
              <div><span>Delta</span><strong>{formatNumber(selectedStrategy?.delta_exposure, 4)}</strong></div>
              <div><span>Vega</span><strong>{formatNumber(selectedStrategy?.vega_exposure, 4)}</strong></div>
              <div><span>Gamma</span><strong>{formatNumber(selectedStrategy?.gamma_exposure, 4)}</strong></div>
              <div><span>Margin Required</span><strong>{formatRs(selectedStrategy?.margin_required)}</strong></div>
              <div className="full-span"><span>Break Even</span><strong>{Array.isArray(selectedStrategy?.break_even_levels) ? selectedStrategy.break_even_levels.join(', ') : '-'}</strong></div>
              <button
                type="button"
                className="action-btn accent"
                style={{ marginTop: 4, width: '100%', fontSize: 13, padding: '8px 0', fontWeight: 700, gridColumn: '1 / -1' }}
                disabled={!selectedStrategy || addingToPortfolio === selectedStrategy?.id}
                onClick={async () => {
                  if (!selectedStrategy) return;
                  setAddingToPortfolio(selectedStrategy.id);
                  try {
                    await portfolioAdd(selectedStrategy, spot);
                    onPortfolioAdd?.();
                    alert('Added to Portfolio: ' + selectedStrategy.strategy_type + ' ' + (selectedStrategy.legs_label || ''));
                  } catch (err) {
                    console.error('Failed to add to portfolio:', err);
                    alert('Failed: ' + (err.message || err));
                  } finally {
                    setAddingToPortfolio(null);
                  }
                }}
              >
                {addingToPortfolio === selectedStrategy?.id ? 'Adding...' : '+ ADD TO PORTFOLIO'}
              </button>
            </div>
            <Plot
              data={[
                {
                  type: 'bar',
                  x: ['Delta', 'Gamma', 'Vega'],
                  y: [
                    Number(selectedStrategy?.delta_exposure ?? 0),
                    Number(selectedStrategy?.gamma_exposure ?? 0),
                    Number(selectedStrategy?.vega_exposure ?? 0),
                  ],
                  marker: { color: ['#22c55e', '#38bdf8', '#f59e0b'] },
                },
              ]}
              layout={{
                height: 300,
                margin: { l: 32, r: 12, b: 24, t: 8 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 10 },
                xaxis: { gridcolor: '#1f2937' },
                yaxis: { title: 'Exposure', gridcolor: '#1f2937' },
                showlegend: false,
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </div>
        </Panel>

        <Panel title="Filters Bar" className="screener-filters-panel">
          <div className="filters-grid screener-filters-grid">
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
            <label>Expiry
              <select value={expiryFilter} onChange={(event) => setExpiryFilter(event.target.value)}>
                {expiryOptions.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
          </div>
        </Panel>

        <Panel title="Ranking Table" className="screener-main">
          <div className="table-wrap">
            <table className="dense-table sortable-table">
              <thead>
                <tr>
                  <th>Strategy Type</th>
                  <th>Legs</th>
                  <th>Expiry</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('net_premium')}>Premium{sortIndicator('net_premium')}</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('expected_value')}>EV{sortIndicator('expected_value')}</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('var_95')}>VaR95{sortIndicator('var_95')}</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('var_99')}>VaR99{sortIndicator('var_99')}</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('expected_shortfall')}>ES{sortIndicator('expected_shortfall')}</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('return_on_margin')}>RoM{sortIndicator('return_on_margin')}</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('probability_of_loss')}>P(Loss){sortIndicator('probability_of_loss')}</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('max_loss')}>Max Loss{sortIndicator('max_loss')}</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('pnl_kurtosis')}>Kurtosis{sortIndicator('pnl_kurtosis')}</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('theta_exposure')}>Theta{sortIndicator('theta_exposure')}</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('vega_exposure')}>Vega{sortIndicator('vega_exposure')}</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('gamma_exposure')}>Gamma{sortIndicator('gamma_exposure')}</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('fragility_score')}>Fragility{sortIndicator('fragility_score')}</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('overall_score')}>Score (%){sortIndicator('overall_score')}</th>
                  <th style={{cursor:'pointer'}} onClick={() => handleSort('bid_ask_spread_pct')}>Spread %{sortIndicator('bid_ask_spread_pct')}</th>
                  <th>Call</th>
                  <th>Put</th>
                  <th style={{width: 70}}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length ? (
                  filteredItems.map((item) => (
                    <tr key={item.id} className={item.id === selectedStrategy?.id ? 'selected-row' : ''} onClick={() => onSelectStrategy(item.id)}>
                      <td>{item.strategy_type}</td>
                      <td style={{whiteSpace:'nowrap',fontSize:'0.8em'}}>{item.legs_label || (Array.isArray(item.strikes) ? item.strikes.join(', ') : '-')}</td>
                      <td style={{whiteSpace:'nowrap',fontSize:'0.8em',color:'#38bdf8'}}>{item.expiry_date || '-'}</td>
                      <td style={{color: Number(item.net_premium ?? 0) < 0 ? '#f43f5e' : '#22c55e'}}>{formatRs(item.net_premium ?? item.cost)}</td>
                      <td>{formatNumber(item.expected_value, 4)}</td>
                      <td>{formatRs(item.var_95)}</td>
                      <td>{formatRs(item.var_99)}</td>
                      <td>{formatRs(item.expected_shortfall)}</td>
                      <td>{formatNumber(item.return_on_margin, 6)}</td>
                      <td style={{color: Number(item.probability_of_loss ?? 0) > 0.5 ? '#f43f5e' : '#22c55e'}}>{formatPctVal(item.probability_of_loss)}</td>
                      <td style={{color: '#f43f5e'}}>{formatRs(item.max_loss)}</td>
                      <td>{formatNumber(item.pnl_kurtosis, 2)}</td>
                      <td>{formatNumber(item.theta_exposure, 4)}</td>
                      <td>{formatNumber(item.vega_exposure, 4)}</td>
                      <td>{formatNumber(item.gamma_exposure, 4)}</td>
                      <td>{formatNumber(item.fragility_score, 6)}</td>
                      <td>{formatPctVal(item.overall_score)}</td>
                      <td style={{color: item.liquidity_warning ? '#f59e0b' : '#22c55e', fontWeight: item.liquidity_warning ? 700 : 400}}>
                        {item.bid_ask_spread_pct != null ? item.bid_ask_spread_pct.toFixed(1) + '%' : '-'}
                        {item.liquidity_warning ? ' ⚠' : ''}
                      </td>
                      <td style={{fontSize:'0.75em',whiteSpace:'nowrap'}}>
                        {Array.isArray(item.legs) && item.legs.length
                          ? item.legs.filter(l => l.option_type === 'C').map(l => `${Math.round(l.strike)}${l.option_type}${l.direction > 0 ? '↑' : '↓'}: ${l.price != null ? formatRs(l.price) : '-'}`).join(' · ') || '-'
                          : '-'}
                      </td>
                      <td style={{fontSize:'0.75em',whiteSpace:'nowrap'}}>
                        {Array.isArray(item.legs) && item.legs.length
                          ? item.legs.filter(l => l.option_type === 'P').map(l => `${Math.round(l.strike)}${l.option_type}${l.direction > 0 ? '↑' : '↓'}: ${l.price != null ? formatRs(l.price) : '-'}`).join(' · ') || '-'
                          : '-'}
                      </td>
                      <td>
                        <button
                          type="button"
                          style={ADD_BTN_STYLE}
                          disabled={addingToPortfolio === item.id}
                          onClick={async (e) => {
                            e.stopPropagation();
                            setAddingToPortfolio(item.id);
                            try {
                              await portfolioAdd(item, spot);
                              onPortfolioAdd?.();
                            } catch (err) {
                              console.error('Add failed:', err);
                              alert('Failed: ' + (err.message || err));
                            } finally {
                              setAddingToPortfolio(null);
                            }
                          }}
                        >
                          {addingToPortfolio === item.id ? '...' : '+ Add'}
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={20}>No strategies available for selected filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </SnapshotGuard>
  );
}
