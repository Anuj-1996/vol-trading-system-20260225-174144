import React, { useEffect, useMemo, useState } from 'react';
import {
  checkBackendHealth,
  getRecentLogs,
  getSnapshotModule,
  normalizeSnapshotModules,
  runLiveForSnapshot,
  aiSyncPipeline,
} from './api/client';
import AICopilotPanel from './components/AICopilotPanel';
import BacktestPage from './components/pages/BacktestPage';
import MarketPage from './components/pages/MarketPage';
import PortfolioPage from './components/pages/PortfolioPage';
import RiskLabPage from './components/pages/RiskLabPage';
import StrategyDetailPage from './components/pages/StrategyDetailPage';
import StrategyScreenerPage from './components/pages/StrategyScreenerPage';
import SurfacePage from './components/pages/SurfacePage';
import { Panel, formatNumber } from './components/pages/shared.jsx';
import { useSnapshotStore } from './store/useSnapshotStore';

const INITIAL_FORM = {
  spot: 0,
  risk_free_rate: 0.065,
  dividend_yield: 0.012,
  capital_limit: 500000,
  strike_increment: 50,
  max_legs: 4,
  max_width: 1000,
  simulation_paths: 5000,
  simulation_steps: 32,
  max_expiries: 5,
};

const NAV_ITEMS = [
  { key: 'market', label: 'Market' },
  { key: 'surface', label: 'Vol Surface' },
  { key: 'screener', label: 'Strategy Screener' },
  { key: 'detail', label: 'Strategy Detail' },
  { key: 'risk', label: 'Risk Lab' },
  { key: 'backtest', label: 'Backtest' },
  { key: 'portfolio', label: 'Portfolio' },
  { key: 'settings', label: 'Settings' },
];

export default function App() {
  const [form, setForm] = useState(INITIAL_FORM);
  const [activePage, setActivePage] = useState('market');
  const [clockValue, setClockValue] = useState(new Date());
  const [backendStatus, setBackendStatus] = useState('unknown');
  const [underlying, setUnderlying] = useState('NIFTY');
  const [selectedExpiry, setSelectedExpiry] = useState('auto');
  const [recentLogs, setRecentLogs] = useState([]);
  const [modelSelection, setModelSelection] = useState('Heston');
  const [confidenceLevel, setConfidenceLevel] = useState(99);
  const [scoreWeights, setScoreWeights] = useState('EV:0.30, VaR:0.25, ES:0.20, RoM:0.15, Fragility:0.10');
  const [liveMetadata, setLiveMetadata] = useState(null);
  const [fetchProgress, setFetchProgress] = useState('');
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [lastPipelineData, setLastPipelineData] = useState(null);

  const {
    activeSnapshotId,
    loading,
    error,
    market,
    surface,
    strategies,
    risk,
    backtest,
    portfolio,
    dynamicState,
    selectedStrategyId,
    setLoading,
    setError,
    clearError,
    setActiveSnapshotId,
    setSnapshotData,
    setDynamicState,
    setSelectedStrategyId,
  } = useSnapshotStore();

  useEffect(() => {
    const timer = setInterval(() => setClockValue(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const fetchLogsOnce = async () => {
    try {
      const payload = await getRecentLogs(120);
      setRecentLogs(payload.lines || []);
    } catch {
      setRecentLogs([]);
    }
  };

  const ensureBackend = async () => {
    const health = await checkBackendHealth();
    if (health.status !== 'ok') {
      throw new Error('Backend health check did not return ok status.');
    }
    setBackendStatus('connected');
  };

  const loadSnapshotModules = async (snapshotId) => {
    const [marketData, surfaceData, strategiesData, riskData, portfolioData] = await Promise.all([
      getSnapshotModule(snapshotId, 'market'),
      getSnapshotModule(snapshotId, 'surface'),
      getSnapshotModule(snapshotId, 'strategies'),
      getSnapshotModule(snapshotId, 'risk'),
      getSnapshotModule(snapshotId, 'portfolio'),
    ]);

    let backtestData = null;
    try {
      backtestData = await getSnapshotModule(snapshotId, 'backtest');
    } catch {
      backtestData = null;
    }

    const strategyItems = Array.isArray(strategiesData?.items) ? strategiesData.items : [];
    const nextSelected =
      strategyItems.find((item) => item.id === selectedStrategyId)?.id || strategyItems[0]?.id || null;

    setSnapshotData({
      market: marketData,
      surface: surfaceData,
      strategies: strategiesData,
      risk: riskData,
      backtest: backtestData,
      portfolio: portfolioData,
      selectedStrategyId: nextSelected,
    });
  };

  const PROGRESS_STEPS = [
    'Connecting to backend...',
    'Fetching live option chain from NSE...',
    'Building volatility surface & calibrating...',
    'Running Monte Carlo simulations...',
    'Ranking strategies & computing Greeks...',
  ];

  const runLive = async () => {
    clearError();
    setLoading(true);
    setFetchProgress(PROGRESS_STEPS[0]);
    try {
      await ensureBackend();
      setFetchProgress(PROGRESS_STEPS[1]);

      const pipelineParams = {
        risk_free_rate: Number(form.risk_free_rate),
        dividend_yield: Number(form.dividend_yield),
        capital_limit: Number(form.capital_limit),
        strike_increment: Number(form.strike_increment),
        max_legs: Number(form.max_legs),
        max_width: Number(form.max_width),
        simulation_paths: Number(form.simulation_paths),
        simulation_steps: Number(form.simulation_steps),
      };

      setFetchProgress(PROGRESS_STEPS[2]);
      const { snapshotId, fallbackModules, liveMetadata: meta } =
        await runLiveForSnapshot(underlying, pipelineParams, Number(form.max_expiries));

      setFetchProgress(PROGRESS_STEPS[4]);
      setLiveMetadata(meta);
      setForm((prev) => ({ ...prev, spot: meta.spot }));
      setActiveSnapshotId(snapshotId);
      if (fallbackModules) {
        setSnapshotData({
          ...fallbackModules,
          selectedStrategyId: fallbackModules.strategies?.items?.[0]?.id || null,
        });
        // Sync pipeline data to AI agents
        const pipelinePayload = {
          market_overview: fallbackModules.market || null,
          surface: fallbackModules.surface || null,
          calibration: fallbackModules.surface?.calibration || null,
          regime: fallbackModules.market?.regime || null,
          top_strategies: fallbackModules.strategies?.items || [],
        };
        setLastPipelineData(pipelinePayload);
        aiSyncPipeline(pipelinePayload).catch(() => {});
      }
      await loadSnapshotModules(snapshotId);
      setFetchProgress('');
      await fetchLogsOnce();
    } catch (requestError) {
      setBackendStatus('disconnected');
      setError(requestError.message || 'Live NSE pipeline failed.');
      setFetchProgress('');
      await fetchLogsOnce();
    } finally {
      setLoading(false);
    }
  };

  const renderSettingsPage = () => (
    <div className="page-settings-grid">
      <Panel title="Model Selection">
        <label>
          Model selection dropdown
          <select value={modelSelection} onChange={(event) => setModelSelection(event.target.value)}>
            <option value="Black Scholes">Black Scholes</option>
            <option value="Heston">Heston</option>
            <option value="SABR">SABR</option>
          </select>
        </label>
      </Panel>
      <Panel title="Calibration Panel">
        <div className="filters-grid">
          <label>
            Risk free rate
            <input
              type="number"
              step="0.0001"
              value={form.risk_free_rate}
              onChange={(event) => setForm((prev) => ({ ...prev, risk_free_rate: Number(event.target.value) }))}
            />
          </label>
          <label>
            Dividend yield
            <input
              type="number"
              step="0.0001"
              value={form.dividend_yield}
              onChange={(event) => setForm((prev) => ({ ...prev, dividend_yield: Number(event.target.value) }))}
            />
          </label>
          <label>
            Strike increment
            <input
              type="number"
              value={form.strike_increment}
              onChange={(event) => setForm((prev) => ({ ...prev, strike_increment: Number(event.target.value) }))}
            />
          </label>
          <label>
            Max width
            <input
              type="number"
              value={form.max_width}
              onChange={(event) => setForm((prev) => ({ ...prev, max_width: Number(event.target.value) }))}
            />
          </label>
        </div>
      </Panel>
      <Panel title="Simulation Paths">
        <label>
          Simulation paths
          <input
            type="number"
            value={form.simulation_paths}
            onChange={(event) => setForm((prev) => ({ ...prev, simulation_paths: Number(event.target.value) }))}
          />
        </label>
      </Panel>
      <Panel title="Expiry Settings">
        <label>
          Number of expiries to fetch
          <select value={form.max_expiries} onChange={(event) => setForm((prev) => ({ ...prev, max_expiries: Number(event.target.value) }))}>
            {[3, 4, 5, 6, 7, 8, 10, 12].map((n) => (
              <option key={n} value={n}>{n} expiries</option>
            ))}
          </select>
          <span style={{fontSize: '11px', color: '#9ca3af', marginTop: 4, display: 'block'}}>More expiries = richer term structure for Heston calibration, but slower fetch (~2s each). 5-8 is optimal.</span>
        </label>
      </Panel>
      <Panel title="Confidence Level">
        <label>
          Confidence level (%)
          <input type="number" value={confidenceLevel} onChange={(event) => setConfidenceLevel(Number(event.target.value))} />
        </label>
      </Panel>
      <Panel title="Scoring Weights Editor">
        <textarea value={scoreWeights} onChange={(event) => setScoreWeights(event.target.value)} rows={5} />
      </Panel>
      <Panel title="Live Logs">
        <pre className="live-logs">{recentLogs.length ? recentLogs.join('\n') : 'No logs yet.'}</pre>
      </Panel>
    </div>
  );

  const selectedExpiryOptions = useMemo(() => {
    const maturityGrid = Array.isArray(surface?.maturity_grid) ? surface.maturity_grid : [];
    if (!maturityGrid.length) {
      return [{ value: 'auto', label: 'Auto' }];
    }
    return [
      { value: 'auto', label: 'Auto' },
      ...maturityGrid.map((value, index) => ({
        value: String(index),
        label: `${Math.max(1, Math.round(Number(value) * 365))}D`,
      })),
    ];
  }, [surface]);

  const selectedExpiryIndex = useMemo(() => {
    const maturityGrid = Array.isArray(surface?.maturity_grid) ? surface.maturity_grid : [];
    if (!maturityGrid.length) {
      return 0;
    }
    if (selectedExpiry === 'auto') {
      return 0;
    }
    const parsed = Number(selectedExpiry);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return Math.max(0, Math.min(parsed, maturityGrid.length - 1));
  }, [selectedExpiry, surface]);

  const backendStatusClass =
    backendStatus === 'connected'
      ? 'status-text-ok'
      : backendStatus === 'disconnected'
        ? 'status-text-bad'
        : 'status-text-warn';

  const calibrationStatusClass = market ? 'status-text-ok' : 'status-text-warn';

  const renderActivePage = () => {
    if (activePage === 'market') {
      return (
        <MarketPage
          loading={loading}
          activeSnapshotId={activeSnapshotId}
          market={market}
          surface={surface}
          selectedExpiryIndex={selectedExpiryIndex}
        />
      );
    }
    if (activePage === 'surface') {
      return (
        <SurfacePage
          loading={loading}
          activeSnapshotId={activeSnapshotId}
          market={market}
          surface={surface}
          selectedExpiryIndex={selectedExpiryIndex}
          onExpiryIndexChange={(nextIndex) => setSelectedExpiry(String(nextIndex))}
        />
      );
    }
    if (activePage === 'screener') {
      return (
        <StrategyScreenerPage
          loading={loading}
          activeSnapshotId={activeSnapshotId}
          strategies={strategies}
          selectedStrategyId={selectedStrategyId}
          onSelectStrategy={setSelectedStrategyId}
          market={market}
        />
      );
    }
    if (activePage === 'detail') {
      return (
        <StrategyDetailPage
          loading={loading}
          activeSnapshotId={activeSnapshotId}
          strategies={strategies}
          selectedStrategyId={selectedStrategyId}
          risk={risk}
          market={market}
          surface={surface}
        />
      );
    }
    if (activePage === 'risk') {
      return <RiskLabPage loading={loading} activeSnapshotId={activeSnapshotId} risk={risk} />;
    }
    if (activePage === 'backtest') {
      return <BacktestPage loading={loading} activeSnapshotId={activeSnapshotId} backtest={backtest} />;
    }
    if (activePage === 'portfolio') {
      return <PortfolioPage loading={loading} activeSnapshotId={activeSnapshotId} portfolio={portfolio} />;
    }
    return renderSettingsPage();
  };

  return (
    <div className={`bbg-shell${aiPanelOpen ? ' ai-open' : ''}`}>
      <aside className="bbg-sidebar">
        <div className="brand">VOL TRADING</div>
        <nav>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={activePage === item.key ? 'nav-item active' : 'nav-item'}
              onClick={() => setActivePage(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="bbg-main">
        <header className="top-status-bar">
          <label>
            Underlying
            <select value={underlying} onChange={(event) => setUnderlying(event.target.value)}>
              <option value="NIFTY">NIFTY</option>
              <option value="BANKNIFTY">BANKNIFTY</option>
            </select>
          </label>
          <label>
            Expiry
            <select value={selectedExpiry} onChange={(event) => setSelectedExpiry(event.target.value)}>
              {selectedExpiryOptions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <div className="top-metric"><span>Spot</span><strong>{formatNumber(market?.spot || form.spot, 2)}</strong></div>
          <div className="top-metric"><span>IV ATM</span><strong>{market?.atm_iv != null ? (Number(market.atm_iv) * 100).toFixed(2) + '%' : '-'}</strong></div>
          <div className="top-metric"><span>Regime</span><strong style={{color: market?.regime?.label === 'high_vol' ? '#ef4444' : '#22c55e'}}>{market?.regime?.label || '-'}</strong></div>
          <div className="top-metric"><span>Source</span><strong className='status-text-ok'>NSE Live</strong></div>
          <div className="top-metric"><span>Clock</span><strong>{clockValue.toLocaleTimeString()}</strong></div>
          <button type="button" className="action-btn accent" onClick={runLive} disabled={loading}>
            {loading ? 'Running...' : 'Fetch Live & Analyse'}
          </button>
        </header>

        {error ? <div className="error-box">{error}</div> : null}

        {loading && fetchProgress && (
          <div className="loading-overlay">
            <div className="loading-overlay-content">
              <div className="spinner-ring" />
              <div className="loading-step-text">{fetchProgress}</div>
              <div className="loading-steps-list">
                {PROGRESS_STEPS.map((step, idx) => {
                  const currentIdx = PROGRESS_STEPS.indexOf(fetchProgress);
                  const isDone = idx < currentIdx;
                  const isActive = idx === currentIdx;
                  return (
                    <div key={step} className={`loading-step-item ${isDone ? 'done' : ''} ${isActive ? 'active' : ''}`}>
                      <span className="step-icon">{isDone ? '\u2713' : isActive ? '\u25CF' : '\u25CB'}</span>
                      <span>{step}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <main className="content-area">{renderActivePage()}</main>

        <footer className="bottom-strip">
          <div><span>Job status</span><strong>{dynamicState}</strong></div>
          <div><span>Backend</span><strong className={backendStatusClass}>{backendStatus}</strong></div>
          <div><span>Data</span><strong className={calibrationStatusClass}>{liveMetadata ? `NSE ${liveMetadata.symbol}` : 'pending'}</strong></div>
          <div><span>Records</span><strong>{liveMetadata ? liveMetadata.quality_report?.total_cleaned ?? '-' : (market?.ingestion?.record_count ?? '-')}</strong></div>
          <div><span>Snapshot</span><strong>{activeSnapshotId || '-'}</strong></div>
        </footer>
      </div>

      <AICopilotPanel
        pipelineData={lastPipelineData}
        isOpen={aiPanelOpen}
        onToggle={() => setAiPanelOpen((prev) => !prev)}
        dataId={liveMetadata?.data_id || null}
        onRecalibrated={(recalData) => {
          // Update pipeline data for AI agents
          const updatedPayload = {
            market_overview: recalData.market_overview || null,
            surface: recalData.surface || null,
            calibration: recalData.calibration || null,
            regime: recalData.regime || null,
            top_strategies: recalData.top_strategies || [],
          };
          setLastPipelineData(updatedPayload);

          // Push recalibrated data into snapshot store so dashboard updates
          const modules = normalizeSnapshotModules(recalData);
          setSnapshotData({
            market: modules.market,
            surface: modules.surface,
            strategies: modules.strategies,
            risk: modules.risk,
            backtest: modules.backtest,
            portfolio: modules.portfolio,
            selectedStrategyId: modules.strategies?.items?.[0]?.id || null,
          });
        }}
      />
    </div>
  );
}
