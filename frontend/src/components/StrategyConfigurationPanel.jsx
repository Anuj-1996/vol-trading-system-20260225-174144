import React from 'react';

export default function StrategyConfigurationPanel({
  form,
  onChange,
  onStartSession,
  onRunStatic,
  onRunDynamic,
  onStopDynamic,
  sessionStarted,
  dynamicState,
  dynamicJobId,
  backendStatus,
  runStatus,
  loading,
}) {
  const setField = (name, value) => onChange({ ...form, [name]: value });
  const dynamicActive = Boolean(dynamicJobId) && ['queued', 'running', 'cancel_requested'].includes(dynamicState);

  return (
    <section className="panel">
      <h3>Strategy Generator Panel</h3>
      <div className="session-row">
        <button
          className={sessionStarted ? 'btn' : 'btn btn-active'}
          onClick={onStartSession}
          type="button"
          disabled={sessionStarted || loading}
        >
          {sessionStarted ? 'Session Started' : 'Start Session'}
        </button>
        <span className="status-text">{runStatus}</span>
      </div>
      <div className="backend-status">Backend: {backendStatus}</div>
      <div className="form-grid">
        <label>
          Data File Name
          <input value={form.file_path} onChange={(e) => setField('file_path', e.target.value)} />
        </label>
        <label>
          Spot
          <input type="number" value={form.spot} onChange={(e) => setField('spot', Number(e.target.value))} />
        </label>
        <label>
          Capital
          <input type="number" value={form.capital_limit} onChange={(e) => setField('capital_limit', Number(e.target.value))} />
        </label>
        <label>
          Strike Increment
          <input type="number" value={form.strike_increment} onChange={(e) => setField('strike_increment', Number(e.target.value))} />
        </label>
        <label>
          Liquidity Threshold (min OI)
          <input type="number" value={form.min_oi_hint} onChange={(e) => setField('min_oi_hint', Number(e.target.value))} />
        </label>
        <label>
          Simulation Paths
          <input type="number" value={form.simulation_paths} onChange={(e) => setField('simulation_paths', Number(e.target.value))} />
        </label>
        <label>
          Hedge Mode
          <select value={form.hedge_mode} onChange={(e) => setField('hedge_mode', e.target.value)}>
            <option value="no_hedge">No hedge</option>
            <option value="daily_delta">Daily delta hedge</option>
            <option value="threshold">Threshold hedge</option>
          </select>
        </label>
      </div>
      <div className="action-row">
        <button className="btn btn-active" onClick={onRunStatic} type="button" disabled={loading || !sessionStarted}>
          Run Static
        </button>
        <button className="btn" onClick={onRunDynamic} type="button" disabled={loading || !sessionStarted}>
          Run Dynamic
        </button>
        <button className="btn" onClick={onStopDynamic} type="button" disabled={!dynamicActive}>
          Stop Dynamic
        </button>
      </div>
    </section>
  );
}
