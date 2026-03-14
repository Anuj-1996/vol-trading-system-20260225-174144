import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getKiteTokenInfo } from './api/token.js';
import { isKiteTokenExpired } from './utils/kiteToken.js';
import {
  getKiteLoginUrl,
  checkBackendHealth,
  getRecentLogs,
  getSnapshotModule,
  normalizeSnapshotModules,
  runLiveForSnapshot,
  getLatestLiveSnapshot,
  getLiveRefreshStatus,
  aiSyncPipeline,
  aiRecalibrate,
  triggerLiveRefresh,
} from './api/client';
import AICopilotPanel from './components/AICopilotPanel';
import BacktestPage from './components/pages/BacktestPage';
import DealerPositioningPage from './components/pages/DealerPositioningPage';
import MarketPage from './components/pages/MarketPage';
import OptionChainPage from './components/pages/OptionChainPage';
import PortfolioPage from './components/pages/PortfolioPage';
import RegimeMLPage from './components/pages/RegimeMLPage';
import RiskLabPage from './components/pages/RiskLabPage';
import StrategyDetailPage from './components/pages/StrategyDetailPage';
import StrategyScreenerPage from './components/pages/StrategyScreenerPage';
import SurfacePage from './components/pages/SurfacePage';
import { Panel, formatNumber } from './components/pages/shared.jsx';
import { useSnapshotStore } from './store/useSnapshotStore';
import { ThemeContext, THEME_OPTIONS, THEME_STORAGE_KEY } from './theme';

const PANEL_TITLE_COLOR_STORAGE_KEY = 'vol-trading-panel-title-color';
const DEFAULT_PANEL_TITLE_COLOR = '#f59e0b';

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
  refresh_interval_seconds: 240,
  auto_refresh_enabled: true,
};

const LIVE_SOURCE_OPTIONS = [
  { value: 'src1', label: 'src1' },
  { value: 'src2', label: 'src2' },
];

const NAV_ITEMS = [
  { key: 'market', label: 'Market' },
  { key: 'option_chain', label: 'Option Chain' },
  { key: 'surface', label: 'Vol Surface' },
  { key: 'positioning', label: 'Dealer Positioning' },
  { key: 'regime_ml', label: 'Regime ML' },
  { key: 'screener', label: 'Strategy Screener' },
  { key: 'detail', label: 'Strategy Detail' },
  { key: 'risk', label: 'Risk Lab' },
  { key: 'backtest', label: 'Backtest' },
  { key: 'portfolio', label: 'Portfolio' },
  { key: 'settings', label: 'Settings' },
];

export default function App() {
  const [kiteTokenInfo, setKiteTokenInfo] = useState({ token: '', updated_at: '' });
  const [kiteTokenExpired, setKiteTokenExpired] = useState(true);
  // Fetch Kite token info on mount and every 5 minutes
  useEffect(() => {
    async function fetchToken() {
      try {
        const info = await getKiteTokenInfo();
        setKiteTokenInfo(info);
        setKiteTokenExpired(isKiteTokenExpired(info.updated_at));
      } catch {
        setKiteTokenExpired(true);
      }
    }
    fetchToken();
    const interval = setInterval(fetchToken, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);
  const [form, setForm] = useState(INITIAL_FORM);
  const [activePage, setActivePage] = useState('market');
  const [clockValue, setClockValue] = useState(new Date());
  const [backendStatus, setBackendStatus] = useState('unknown');
  const [underlying, setUnderlying] = useState('NIFTY');
  const [liveSource, setLiveSource] = useState('src1');
  const [selectedExpiry, setSelectedExpiry] = useState('auto');
  const [recentLogs, setRecentLogs] = useState([]);
  const [modelSelection, setModelSelection] = useState('SABR');
  const [confidenceLevel, setConfidenceLevel] = useState(99);
  const [scoreWeights, setScoreWeights] = useState('EV:0.30, VaR:0.25, ES:0.20, RoM:0.15, Fragility:0.10');
  const [liveMetadata, setLiveMetadata] = useState(null);
  const [fetchProgress, setFetchProgress] = useState('');
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [lastPipelineData, setLastPipelineData] = useState(null);
  const [liveRefreshStatus, setLiveRefreshStatus] = useState(null);
  const [latestLiveVersion, setLatestLiveVersion] = useState(null);
  const [themeMode, setThemeMode] = useState(() => {
    if (typeof window === 'undefined') {
      return 'true-dark';
    }
    return window.localStorage.getItem(THEME_STORAGE_KEY) || 'true-dark';
  });
  const [panelTitleColor, setPanelTitleColor] = useState(() => {
    if (typeof window === 'undefined') {
      return DEFAULT_PANEL_TITLE_COLOR;
    }
    return window.localStorage.getItem(PANEL_TITLE_COLOR_STORAGE_KEY) || DEFAULT_PANEL_TITLE_COLOR;
  });

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

  // Auto-dismiss error banner after 5 seconds
  const errorTimerRef = useRef(null);
  useEffect(() => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    if (error) {
      errorTimerRef.current = setTimeout(() => clearError(), 5000);
    }
    return () => { if (errorTimerRef.current) clearTimeout(errorTimerRef.current); };
  }, [error, clearError]);

  useEffect(() => {
    const timer = setInterval(() => setClockValue(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    }
  }, [themeMode]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PANEL_TITLE_COLOR_STORAGE_KEY, panelTitleColor);
    }
  }, [panelTitleColor]);

  const fetchLogsOnce = async () => {
    try {
      const payload = await getRecentLogs(120);
      setRecentLogs(payload.lines || []);
    } catch {
      setRecentLogs([]);
    }
  };

  const formatRefreshClock = useCallback((timestampSeconds) => {
    const numeric = Number(timestampSeconds);
    if (!Number.isFinite(numeric) || numeric <= 0) return '-';
    return new Date(numeric * 1000).toLocaleTimeString();
  }, []);

  const applyPipelinePayload = useCallback((pipelinePayload, nextSnapshotId, nextLiveMetadata = null) => {
    const updatedPayload = {
      market_overview: pipelinePayload?.market_overview || null,
      surface: pipelinePayload?.surface || null,
      calibration: pipelinePayload?.calibration || null,
      regime: pipelinePayload?.regime || null,
      top_strategies: pipelinePayload?.top_strategies || [],
    };
    setLastPipelineData(updatedPayload);
    const modules = normalizeSnapshotModules(pipelinePayload);
    setSnapshotData({
      market: modules.market,
      surface: modules.surface,
      strategies: modules.strategies,
      risk: modules.risk,
      backtest: modules.backtest,
      portfolio: modules.portfolio,
      selectedStrategyId: modules.strategies?.items?.[0]?.id || null,
    });
    setActiveSnapshotId(nextSnapshotId);
    if (nextLiveMetadata?.spot != null) {
      setForm((prev) => ({ ...prev, spot: Number(nextLiveMetadata.spot) || prev.spot }));
      setLiveMetadata(nextLiveMetadata);
    }
    aiSyncPipeline(updatedPayload).catch(() => { });
  }, [setActiveSnapshotId, setSnapshotData]);

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
    'Fetching live option chain...',
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
        model_selection: modelSelection,
      };

      setFetchProgress(PROGRESS_STEPS[2]);
      const { snapshotId, fallbackModules, liveMetadata: meta } =
        await runLiveForSnapshot(underlying, pipelineParams, Number(form.max_expiries), liveSource);

      setFetchProgress(PROGRESS_STEPS[4]);
      setLiveMetadata(meta);
      setForm((prev) => ({ ...prev, spot: meta.spot }));
      setActiveSnapshotId(snapshotId);
      if (fallbackModules) {
        setSnapshotData({
          ...fallbackModules,
          selectedStrategyId: fallbackModules.strategies?.items?.[0]?.id || null,
        });
        const pipelinePayload = {
          market_overview: fallbackModules.market || null,
          surface: fallbackModules.surface || null,
          calibration: fallbackModules.surface?.calibration || null,
          regime: fallbackModules.market?.regime || null,
          top_strategies: fallbackModules.strategies?.items || [],
        };
        setLastPipelineData(pipelinePayload);
        aiSyncPipeline(pipelinePayload).catch(() => { });
      }
      await loadSnapshotModules(snapshotId);
      setLatestLiveVersion(snapshotId);
      triggerLiveRefresh({
        symbol: underlying,
        source: liveSource,
        max_expiries: Number(form.max_expiries),
        refresh_interval_seconds: Number(form.refresh_interval_seconds),
        auto_refresh_enabled: Boolean(form.auto_refresh_enabled),
        ...pipelineParams,
        force: false,
      }).catch(() => { });
      setFetchProgress('');
      await fetchLogsOnce();
    } catch (requestError) {
      setBackendStatus('disconnected');
      setError(requestError.message || 'Live pipeline failed.');
      setFetchProgress('');
      await fetchLogsOnce();
    } finally {
      setLoading(false);
    }
  };

  const connectZerodha = useCallback(() => {
    const url = getKiteLoginUrl();
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const liveSourceLabel = String(
    liveMetadata?.source
    || market?.data_source
    || liveRefreshStatus?.source
    || liveSource
    || 'src2'
  )
    .replace(/_live$/i, '')
    .toLowerCase();

  useEffect(() => {
    const symbol = String(liveMetadata?.symbol || underlying || 'NIFTY').toUpperCase();
    const source = String(liveMetadata?.source || liveSource || 'NSE').toUpperCase();
    let cancelled = false;

    async function pollLiveStatus() {
      try {
        const response = await getLiveRefreshStatus(symbol, source);
        if (cancelled) return;
        const status = response?.data || null;
        setLiveRefreshStatus(status);
        if (status?.version && status.version !== latestLiveVersion && status.has_snapshot) {
          const latestResponse = await getLatestLiveSnapshot(symbol, source);
          if (cancelled) return;
          const latest = latestResponse?.data;
          if (latest?.snapshot && latest?.version) {
            applyPipelinePayload(
              latest.snapshot,
              `live-auto-${latest.version}`,
              latest.live_metadata || null,
            );
            setLatestLiveVersion(latest.version);
          }
        }
      } catch {
        if (!cancelled) {
          setLiveRefreshStatus((prev) => prev || null);
        }
      }
    }

    pollLiveStatus();
    const timer = setInterval(pollLiveStatus, 20000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [applyPipelinePayload, latestLiveVersion, liveMetadata?.symbol, liveMetadata?.source, liveSource, underlying]);

  useEffect(() => {
    if (!liveMetadata?.symbol) return;
    triggerLiveRefresh({
      symbol: String(liveMetadata.symbol).toUpperCase(),
      source: String(liveMetadata.source || liveSource || 'NSE').toUpperCase(),
      max_expiries: Number(form.max_expiries),
      refresh_interval_seconds: Number(form.refresh_interval_seconds),
      auto_refresh_enabled: Boolean(form.auto_refresh_enabled),
      risk_free_rate: Number(form.risk_free_rate),
      dividend_yield: Number(form.dividend_yield),
      capital_limit: Number(form.capital_limit),
      strike_increment: Number(form.strike_increment),
      max_legs: Number(form.max_legs),
      max_width: Number(form.max_width),
      simulation_paths: Number(form.simulation_paths),
      simulation_steps: Number(form.simulation_steps),
      model_selection: modelSelection,
      force: false,
    }).catch(() => { });
  }, [
    form.auto_refresh_enabled,
    form.capital_limit,
    form.dividend_yield,
    form.max_expiries,
    form.max_legs,
    form.max_width,
    form.refresh_interval_seconds,
    form.risk_free_rate,
    form.simulation_paths,
    form.simulation_steps,
    form.strike_increment,
    liveMetadata?.source,
    liveMetadata?.symbol,
    liveSource,
    modelSelection,
  ]);

  const liveStatusLabel = useMemo(() => {
    if (liveRefreshStatus?.refreshing) return 'Updating';
    if (liveRefreshStatus?.stale_seconds == null) return 'Manual';
    if (liveRefreshStatus.stale_seconds >= 600) return `Stale ${Math.floor(liveRefreshStatus.stale_seconds / 60)}m`;
    return `Live ${liveRefreshStatus.stale_seconds}s`;
  }, [liveRefreshStatus]);

  const liveStatusClass = liveRefreshStatus?.refreshing
    ? 'status-text-warn'
    : liveRefreshStatus?.last_error
      ? 'status-text-bad'
      : 'status-text-ok';

  const liveUpdatedLabel = useMemo(
    () => formatRefreshClock(liveRefreshStatus?.last_success_ts),
    [formatRefreshClock, liveRefreshStatus?.last_success_ts],
  );

  const nextRefreshLabel = useMemo(() => {
    if (liveRefreshStatus?.cooldown_until_ts) {
      return `Cooldown ${formatRefreshClock(liveRefreshStatus.cooldown_until_ts)}`;
    }
    if (!liveRefreshStatus?.auto_refresh_enabled) {
      return 'Paused';
    }
    return formatRefreshClock(liveRefreshStatus?.next_refresh_ts);
  }, [formatRefreshClock, liveRefreshStatus?.auto_refresh_enabled, liveRefreshStatus?.cooldown_until_ts, liveRefreshStatus?.next_refresh_ts]);

  const renderSettingsPage = () => (
    <div className="page-settings-grid">
      <Panel title="Theme Mode">
        <label>
          Dashboard theme
          <div className="settings-theme-switcher" aria-label="Theme mode switcher">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={themeMode === option.key ? 'theme-switch-btn active' : 'theme-switch-btn'}
                onClick={() => setThemeMode(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </label>
      </Panel>
      <Panel title="Title Accent">
        <label>
          Panel title color
          <div className="settings-accent-row">
            <input
              type="color"
              value={panelTitleColor}
              onChange={(event) => setPanelTitleColor(event.target.value)}
              className="settings-color-input"
            />
            <input
              type="text"
              value={panelTitleColor}
              onChange={(event) => setPanelTitleColor(event.target.value)}
              className="settings-color-text"
            />
            <button
              type="button"
              className="theme-switch-btn"
              onClick={() => setPanelTitleColor(DEFAULT_PANEL_TITLE_COLOR)}
            >
              Reset
            </button>
          </div>
        </label>
      </Panel>
      <Panel title="Model Selection">
        <label>
          Model selection dropdown
          <select value={modelSelection} onChange={(event) => setModelSelection(event.target.value)}>
            <option value="Black Scholes" disabled>Black Scholes (Not wired)</option>
            <option value="Heston">Heston</option>
            <option value="SABR">SABR</option>
          </select>
        </label>
        <span style={{ fontSize: '11px', color: '#9ca3af', marginTop: 6, display: 'block', lineHeight: 1.4 }}>
          This sets the default comparison model on the Vol Surface page. Heston remains the production pricing and simulation engine; SABR is available for surface-fit comparison.
        </span>
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
          <label>
            Auto refresh
            <select
              value={form.auto_refresh_enabled ? 'on' : 'off'}
              onChange={(event) => setForm((prev) => ({ ...prev, auto_refresh_enabled: event.target.value === 'on' }))}
            >
              <option value="on">Enabled</option>
              <option value="off">Paused</option>
            </select>
          </label>
          <label>
            Refresh interval
            <select
              value={form.refresh_interval_seconds}
              onChange={(event) => setForm((prev) => ({ ...prev, refresh_interval_seconds: Number(event.target.value) }))}
            >
              {[180, 240, 300, 420, 600].map((seconds) => (
                <option key={seconds} value={seconds}>{Math.round(seconds / 60)} min</option>
              ))}
            </select>
          </label>
        </div>
        <span style={{ fontSize: '11px', color: '#9ca3af', marginTop: 6, display: 'block', lineHeight: 1.4 }}>
          Auto refresh runs from the backend only, during NSE market hours, with jitter and cooldown after repeated block responses.
        </span>
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
          <span style={{ fontSize: '11px', color: '#9ca3af', marginTop: 4, display: 'block' }}>More expiries = richer term structure for Heston calibration, but slower fetch (~2s each). 5-8 is optimal.</span>
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

  const regimeLabel = useMemo(() => {
    const raw = market?.regime?.label;
    if (!raw) return '-';
    return String(raw)
      .split('_')
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
      .join(' ');
  }, [market]);

  const backendStatusClass =
    backendStatus === 'connected'
      ? 'status-text-ok'
      : backendStatus === 'disconnected'
        ? 'status-text-bad'
        : 'status-text-warn';

  const calibrationStatusClass = market ? 'status-text-ok' : 'status-text-warn';

  const applyRecalibratedData = (recalData) => {
    const payload = recalData?.data || recalData;
    if (!payload || !payload.market_overview || !payload.surface) {
      throw new Error('Invalid recalibration payload received from backend.');
    }
    const updatedPayload = {
      market_overview: payload.market_overview || null,
      surface: payload.surface || null,
      calibration: payload.calibration || null,
      regime: payload.regime || null,
      top_strategies: payload.top_strategies || [],
    };
    setLastPipelineData(updatedPayload);

    const modules = normalizeSnapshotModules(payload);
    setSnapshotData({
      market: modules.market,
      surface: modules.surface,
      strategies: modules.strategies,
      risk: modules.risk,
      backtest: modules.backtest,
      portfolio: modules.portfolio,
      selectedStrategyId: modules.strategies?.items?.[0]?.id || null,
    });
  };

  const handleQuickRecalibrate = async () => {
    if (!liveMetadata?.data_id) {
      throw new Error('No live data_id available for recalibration. Run live fetch first.');
    }
    const result = await aiRecalibrate(liveMetadata.data_id, null, null, { model_selection: modelSelection });
    const recalData = result?.data || result;
    applyRecalibratedData(recalData);
    return recalData;
  };

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
          modelSelection={modelSelection}
          selectedExpiryIndex={selectedExpiryIndex}
          onExpiryIndexChange={(nextIndex) => setSelectedExpiry(String(nextIndex))}
          onRecalibrate={handleQuickRecalibrate}
          canRecalibrate={Boolean(liveMetadata?.data_id)}
        />
      );
    }
    if (activePage === 'option_chain') {
      return (
        <OptionChainPage
          loading={loading}
          activeSnapshotId={activeSnapshotId}
          liveDataId={liveMetadata?.data_id}
          underlying={underlying}
          market={market}
          surface={surface}
          strikeIncrement={form.strike_increment}
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
          pipelineData={lastPipelineData}
          onPortfolioAdd={() => {
            // Auto-switch to portfolio page after adding
          }}
        />
      );
    }
    if (activePage === 'regime_ml') {
      return <RegimeMLPage loading={loading} activeSnapshotId={activeSnapshotId} market={market} />;
    }
    if (activePage === 'positioning') {
      return (
        <DealerPositioningPage
          loading={loading}
          activeSnapshotId={activeSnapshotId}
          liveDataId={liveMetadata?.data_id}
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
      return <PortfolioPage loading={loading} activeSnapshotId={activeSnapshotId} market={market} />;
    }
    return renderSettingsPage();
  };

  return (
    <ThemeContext.Provider value={themeMode}>
      <div
        className={`bbg-shell theme-${themeMode}${aiPanelOpen ? ' ai-open' : ''}`}
        style={{ '--panel-title-color': panelTitleColor }}
      >
        <div className="bbg-main">
          <header className="top-status-bar">
            <div className="top-status-primary">
              <div className="brand top-status-brand">VOL TRADING</div>
              <label>
                Source
                <select
                  value={liveSource}
                  onChange={(event) => setLiveSource(event.target.value)}
                  title="Choose between src1 and src2. src1 is the primary source, src2 is the secondary source."
                >
                  {LIVE_SOURCE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Underlying
                <select
                  value={underlying}
                  onChange={(event) => {
                    setUnderlying(event.target.value);
                    setSelectedExpiry('auto');
                  }}
                  title="Choose the live index to fetch."
                >
                  <option value="NIFTY">NIFTY</option>
                  <option value="BANKNIFTY">BANKNIFTY</option>
                </select>
              </label>
              <label>
                View Expiry
                <select
                  value={selectedExpiry}
                  onChange={(event) => setSelectedExpiry(event.target.value)}
                  disabled={!selectedExpiryOptions.length || selectedExpiryOptions.length === 1}
                  title="Changes the selected expiry slice across supported views."
                >
                  {selectedExpiryOptions.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="top-metric"><span>Spot</span><strong>{formatNumber(market?.spot || form.spot, 2)}</strong></div>
              <div className="top-metric"><span>IV ATM</span><strong>{market?.atm_iv != null ? (Number(market.atm_iv) * 100).toFixed(2) + '%' : '-'}</strong></div>
              <div className="top-metric" title="Model-derived market state indicator. Informational only.">
                <span>Regime</span>
                <strong style={{ color: market?.regime?.label === 'high_vol' ? '#ef4444' : '#22c55e' }}>{regimeLabel}</strong>
              </div>
              {liveSource === 'src1' && kiteTokenExpired ? (
                <button
                  type="button"
                  className="action-btn top-connect-btn"
                  onClick={connectZerodha}
                  disabled={loading}
                  title="Open login to refresh the src1 access token."
                >
                  Connect
                </button>
              ) : null}
              <button type="button" className="action-btn accent top-fetch-btn" onClick={runLive} disabled={loading}>
                {loading ? 'Running...' : 'Fetch Live & Analyse'}
              </button>
            </div>

            <div className="top-status-meta">
              <div className="top-mini-metric"><span>Source</span><strong className="status-text-ok">{liveSourceLabel}</strong></div>
              <div className="top-mini-metric" title="Background refresh status from the backend live snapshot manager.">
                <span>Live</span>
                <strong className={liveStatusClass}>{liveStatusLabel}</strong>
              </div>
              <div className="top-mini-metric" title="Last successful background refresh time.">
                <span>Updated</span>
                <strong>{liveUpdatedLabel}</strong>
              </div>
              <div className="top-mini-metric" title="Next backend refresh attempt or cooldown release time.">
                <span>Next</span>
                <strong>{nextRefreshLabel}</strong>
              </div>
              <div className="top-mini-metric"><span>Clock</span><strong>{clockValue.toLocaleTimeString()}</strong></div>
            </div>
          </header>

          <header className="top-nav-bar">
            <nav className="nav-strip">
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
          </header>

          {error ? <div className="error-box">{error}<button className="error-dismiss" onClick={clearError} title="Dismiss">×</button></div> : null}

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
            <div><span>Data</span><strong className={calibrationStatusClass}>{liveMetadata ? `${liveSourceLabel} ${liveMetadata.symbol}` : 'pending'}</strong></div>
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
            applyRecalibratedData(recalData);
          }}
        />
      </div>
    </ThemeContext.Provider>
  );
}
