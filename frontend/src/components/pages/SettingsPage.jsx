import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ReportGenerator from '../../report/ReportGenerator';
import { Panel } from './shared.jsx';
import { THEME_OPTIONS, THEME_STORAGE_KEY } from '../../theme';

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

export default function SettingsPage() {
  const [reporting, setReporting] = useState(false);
  const [form, setForm] = useState(INITIAL_FORM);
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
  const [modelSelection, setModelSelection] = useState('SABR');
  const [confidenceLevel, setConfidenceLevel] = useState(99);
  const [scoreWeights, setScoreWeights] = useState('EV:0.30, VaR:0.25, ES:0.20, RoM:0.15, Fragility:0.10');
  const [recentLogs, setRecentLogs] = useState([]);

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


  const [showDialog, setShowDialog] = useState(false);
  const [reportStatus, setReportStatus] = useState('idle'); // idle | running | done | error
  const [reportPath, setReportPath] = useState('');

  const handleGenerateReport = () => {
    setShowDialog(true);
  };

  const confirmGenerateReport = async () => {
    setShowDialog(false);
    setReportStatus('running');
    setReporting(true);
    try {
      await window.generateReport();
      setReportStatus('done');
      setReportPath('Downloads/NIFTY_Options_Report.png');
    } catch (e) {
      // Log error to console for debugging
      // eslint-disable-next-line no-console
      console.error('Report generation failed:', e);
      setReportStatus('error');
    } finally {
      setReporting(false);
    }
  };

  const cancelGenerateReport = () => {
    setShowDialog(false);
  };

  return (
    <div className="settings-page">
      <h2>Settings</h2>
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
      <Panel title="Report Export">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0 }}>
          <button
            onClick={handleGenerateReport}
            disabled={reporting || reportStatus === 'running'}
            className="action-btn"
            style={{ marginTop: 0, opacity: reporting || reportStatus === 'running' ? 0.55 : 1, pointerEvents: reporting || reportStatus === 'running' ? 'none' : 'auto' }}
          >
            {reportStatus === 'running' ? 'Generating…' : 'Generate Report'}
          </button>
          {showDialog && (
            <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.3)', zIndex: 1000 }}>
              <div className="modal-dialog" style={{ background: '#222', color: '#fff', borderRadius: 8, padding: 32, maxWidth: 340, margin: '120px auto', boxShadow: '0 4px 24px #0008', textAlign: 'center' }}>
                <div style={{ fontSize: 18, marginBottom: 24 }}>Do you want to create a report?</div>
                <button onClick={confirmGenerateReport} style={{ marginRight: 16, padding: '8px 24px', background: '#181c23', color: '#fff', border: '1px solid #444', borderRadius: 6, fontWeight: 600 }}>Yes</button>
                <button onClick={cancelGenerateReport} style={{ padding: '8px 24px', background: '#444', color: '#fff', border: '1px solid #222', borderRadius: 6, fontWeight: 600 }}>No</button>
              </div>
            </div>
          )}
          {reportStatus === 'done' && (
            <div style={{ marginTop: 18, color: '#22c55e', fontWeight: 600 }}>
              Report saved to: <span style={{ color: '#fff' }}>{reportPath}</span>
            </div>
          )}
          {reportStatus === 'error' && (
            <div style={{ marginTop: 18, color: '#ef4444', fontWeight: 600 }}>
              Failed to generate report. Please try again.
            </div>
          )}
        </div>
      </Panel>
      <ReportGenerator />
    </div>
  );
}
