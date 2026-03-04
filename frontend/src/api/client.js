const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000/api/v1';
const snapshotCache = new Map();

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.detail || 'Request failed');
  }
  return payload;
}

function withStrategyIds(items = []) {
  return items.map((item, index) => ({
    ...item,
    id: item.id ?? `${item.strategy_type || 'strategy'}-${index}`,
  }));
}

function buildRiskFromStrategy(strategy = {}, dynamicResult = null, spot = 0) {
  return {
    spot: Number(spot),
    cost: Number(strategy.cost ?? strategy.margin_required ?? 0),
    strategy_type: strategy.strategy_type || 'unknown',
    strikes: Array.isArray(strategy.strikes) ? strategy.strikes : [],
    base_pnl: Number(dynamicResult?.mean_pnl ?? strategy.expected_value ?? 0),
    delta: Number(strategy.delta_exposure ?? 0),
    gamma: Number(strategy.gamma_exposure ?? 0),
    vega: Number(strategy.vega_exposure ?? 0),
    theta: Number(strategy.theta_exposure ?? 0),
    var_95: Number(strategy.var_95 ?? strategy.var_99 ?? dynamicResult?.var_99 ?? 0),
    var_99: Number(strategy.var_99 ?? dynamicResult?.var_99 ?? 0),
    expected_shortfall: Number(strategy.expected_shortfall ?? dynamicResult?.expected_shortfall ?? 0),
    pnl_distribution: Array.isArray(strategy.pnl_distribution) ? strategy.pnl_distribution : [],
    stress: {
      spot_down_5: Number(strategy.expected_value ?? 0) - Math.abs(Number(strategy.delta_exposure ?? 0)) * 0.05,
      spot_up_5: Number(strategy.expected_value ?? 0) + Math.abs(Number(strategy.delta_exposure ?? 0)) * 0.05,
      vol_up_10: Number(strategy.expected_value ?? 0) + Math.abs(Number(strategy.vega_exposure ?? 0)) * 0.1,
      vol_crush: Number(strategy.expected_value ?? 0) - Math.abs(Number(strategy.vega_exposure ?? 0)) * 0.12,
      time_decay_1w: Number(strategy.expected_value ?? 0) + Number(strategy.theta_exposure ?? 0) * 7,
    },
  };
}

function pickRandom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function toFiniteSeries(values = []) {
  return values.map((value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  });
}

function buildFallbackVolForecasts(marketOverview = {}) {
  const history = marketOverview?.price_history || null;
  const dates = Array.isArray(history?.dates) ? history.dates : [];
  if (!dates.length) {
    return null;
  }

  const hv20 = toFiniteSeries(history?.rv20_annualized || []);
  const rv60 = toFiniteSeries(history?.rv60_annualized || []);
  const atmIv = Number(marketOverview?.atm_market_iv ?? 0);
  const ivProxy = hv20.map((value) => (value != null ? value * 1.1 : (atmIv > 0 ? atmIv : null)));

  const smooth = (series, alpha = 0.12) => {
    const result = [];
    let prev = null;
    for (const value of series) {
      if (value == null) {
        result.push(prev);
        continue;
      }
      prev = prev == null ? value : alpha * value + (1 - alpha) * prev;
      result.push(prev);
    }
    return result;
  };

  const archRv = hv20.map((value, index) => (value != null ? value : rv60[index]));
  const garchRv = smooth(archRv, 0.10);
  const egarchRv = smooth(archRv, 0.16);
  const gjrRv = smooth(archRv, 0.08);
  const scale = hv20.length && hv20[hv20.length - 1]
    ? Math.max(0.7, Math.min(2.0, atmIv > 0 ? atmIv / hv20[hv20.length - 1] : 1.1))
    : 1.1;

  const withIv = (rvSeries) => ({
    rv_series: rvSeries,
    iv_series: rvSeries.map((value) => (value != null ? value * scale : null)),
    rv_forecast_20d: rvSeries[rvSeries.length - 1] ?? null,
    iv_forecast_20d: (rvSeries[rvSeries.length - 1] ?? null) != null ? rvSeries[rvSeries.length - 1] * scale : null,
  });

  return {
    dates,
    hv20,
    rv20: hv20,
    iv_proxy: ivProxy,
    models: {
      ARCH: withIv(archRv),
      GARCH: withIv(garchRv),
      GARCH_EPOW: withIv(egarchRv),
      GTR_GARCH: withIv(gjrRv),
      GJR_GARCH: withIv(gjrRv),
    },
  };
}

function estimateBacktestOverfitProbability(strategyItems, trials = 180, trainSize = 60, testSize = 60) {
  const candidates = strategyItems
    .map((item) => ({
      name: item.strategy_type || 'unknown',
      dist: Array.isArray(item.pnl_distribution)
        ? item.pnl_distribution.map(Number).filter(Number.isFinite)
        : [],
    }))
    .filter((item) => item.dist.length >= Math.max(trainSize, testSize));

  if (candidates.length < 2) {
    return null;
  }

  const sharpe = (series) => {
    if (!series.length) return -Infinity;
    const mean = series.reduce((a, b) => a + b, 0) / series.length;
    const variance = series.reduce((a, value) => a + (value - mean) ** 2, 0) / series.length;
    const std = Math.sqrt(Math.max(variance, 1e-12));
    return mean / std;
  };

  let overfitCount = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    const scored = candidates.map((item) => {
      const train = Array.from({ length: trainSize }, () => pickRandom(item.dist));
      const test = Array.from({ length: testSize }, () => pickRandom(item.dist));
      return { trainSharpe: sharpe(train), testSharpe: sharpe(test) };
    });

    let bestIdx = 0;
    for (let idx = 1; idx < scored.length; idx += 1) {
      if (scored[idx].trainSharpe > scored[bestIdx].trainSharpe) {
        bestIdx = idx;
      }
    }

    const testScores = scored.map((item) => item.testSharpe).sort((a, b) => a - b);
    const median = testScores[Math.floor(testScores.length / 2)];
    if (scored[bestIdx].testSharpe < median) {
      overfitCount += 1;
    }
  }

  return overfitCount / trials;
}

/**
 * Synthesize walk-forward backtest from MC PnL distributions using
 * hold-to-maturity periods (in days) from the selected strategy.
 */
function buildBacktestFromStrategies(strategyItems) {
  if (!strategyItems.length) return null;

  const top = strategyItems[0];
  const dist = Array.isArray(top.pnl_distribution) ? top.pnl_distribution.map(Number).filter(Number.isFinite) : [];
  if (dist.length < 10) return null;

  const maturityT = Number(top.maturity_T ?? 0);
  const holdDays = Number.isFinite(maturityT) && maturityT > 0
    ? Math.max(1, Math.round(maturityT * 365))
    : 20;
  const periods = holdDays;
  const annualizationFactor = Math.sqrt(252 / Math.max(holdDays, 1));

  // Sample from empirical distribution (bootstrap)
  const sample = () => pickRandom(dist);

  const pnlSeries = [];
  for (let i = 0; i < periods; i++) pnlSeries.push(sample());

  const equityCurve = [0];
  for (let i = 0; i < pnlSeries.length; i++) equityCurve.push(equityCurve[i] + pnlSeries[i]);

  const drawdownCurve = [];
  let peak = -Infinity;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    drawdownCurve.push(peak - eq);
  }

  const wins = pnlSeries.filter((p) => p > 0).length;
  const mean = pnlSeries.reduce((a, b) => a + b, 0) / pnlSeries.length;
  const std = Math.sqrt(pnlSeries.reduce((a, p) => a + (p - mean) ** 2, 0) / pnlSeries.length);
  const downside = pnlSeries.filter((p) => p < 0);
  const downStd = downside.length > 1
    ? Math.sqrt(downside.reduce((a, p) => a + p * p, 0) / downside.length)
    : 1;
  const sharpe = std > 1e-10 ? (mean / std) * annualizationFactor : 0;
  const sortino = downStd > 1e-10 ? (mean / downStd) * annualizationFactor : 0;
  const maxDD = Math.max(...drawdownCurve);
  const totalReturn = equityCurve[equityCurve.length - 1];
  const pbo = estimateBacktestOverfitProbability(strategyItems);
  const cagr = totalReturn;

  return {
    strategy_name: top.strategy_type || 'unknown',
    periods,
    hold_days_to_maturity: holdDays,
    maturity_T: maturityT,
    equity_curve: equityCurve,
    drawdown_curve: drawdownCurve,
    pnl_series: pnlSeries,
    metrics: {
      sharpe: Number.isFinite(sharpe) ? sharpe : 0,
      sortino: Number.isFinite(sortino) ? sortino : 0,
      max_drawdown: Number.isFinite(maxDD) ? maxDD : 0,
      win_rate: wins / periods,
      cagr: Number.isFinite(cagr) ? cagr : 0,
      total_return: totalReturn,
      mean_pnl: mean,
      std_pnl: std,
      best_day: Math.max(...pnlSeries),
      worst_day: Math.min(...pnlSeries),
      pbo: pbo,
    },
  };
}

export function normalizeSnapshotModules(staticPayload = {}, dynamicResult = null) {
  const strategyItems = withStrategyIds(staticPayload.top_strategies || []);
  const primaryStrategy = strategyItems[0] || {};

  const surfacePayload = staticPayload.surface || {};
  const strikeGrid = Array.isArray(surfacePayload.strike_grid) ? surfacePayload.strike_grid : [];
  const maturityGrid = Array.isArray(surfacePayload.maturity_grid) ? surfacePayload.maturity_grid : [];
  const marketMatrix = Array.isArray(surfacePayload.market_iv_matrix) ? surfacePayload.market_iv_matrix : [];
  const modelMatrix = Array.isArray(surfacePayload.model_iv_matrix) ? surfacePayload.model_iv_matrix : [];

  const spot = Number(staticPayload.market_overview?.spot ?? staticPayload.requestSpot ?? 0);
  const spread = Number(staticPayload.market_overview?.realized_implied_spread ?? 0);
  const atmMarketIv = Number(staticPayload.market_overview?.atm_market_iv ?? 0);
  const atmModelIv = Number(staticPayload.market_overview?.atm_model_iv ?? 0);
  const rvEstimate = Math.max(0, atmMarketIv - spread);

  let atmStrikeIndex = 0;
  if (strikeGrid.length && Number.isFinite(spot)) {
    atmStrikeIndex = strikeGrid.reduce((bestIndex, strike, index) => {
      const bestDistance = Math.abs(Number(strikeGrid[bestIndex]) - spot);
      const currentDistance = Math.abs(Number(strike) - spot);
      return currentDistance < bestDistance ? index : bestIndex;
    }, 0);
  }

  const termDays = maturityGrid.map((value) => Number(value) * 365);
  const termMarketAtm = maturityGrid.map((_, idx) => Number(marketMatrix[idx]?.[atmStrikeIndex] ?? 0));
  const termModelAtm = maturityGrid.map((_, idx) => Number(modelMatrix[idx]?.[atmStrikeIndex] ?? 0));

  const market = {
    ...(staticPayload.market_overview || {}),
    regime: staticPayload.regime || null,
    ingestion: staticPayload.ingestion || null,
    spot,
    atm_iv: atmMarketIv,
    atm_model_iv: atmModelIv,
    realized_implied_spread: spread,
    rv_10d: staticPayload.market_overview?.rv_10d ?? rvEstimate,
    rv_20d: staticPayload.market_overview?.rv_20d ?? rvEstimate,
    rv_60d: staticPayload.market_overview?.rv_60d ?? rvEstimate,
    rv_percentile: staticPayload.market_overview?.rv_percentile ?? null,
    iv_rank: staticPayload.market_overview?.iv_rank ?? null,
    iv_percentile: staticPayload.market_overview?.iv_percentile ?? null,
    vvix_equivalent: staticPayload.market_overview?.vvix_equivalent ?? null,
    price_history: staticPayload.market_overview?.price_history ?? null,
    vol_model_forecasts:
      staticPayload.market_overview?.vol_model_forecasts ||
      buildFallbackVolForecasts(staticPayload.market_overview || {}),
    term_structure_days: termDays,
    term_structure_market_atm: termMarketAtm,
    term_structure_model_atm: termModelAtm,
    atm_strike: strikeGrid[atmStrikeIndex] ?? null,
  };

  const surface = {
    ...surfacePayload,
    calibration: staticPayload.calibration || null,
  };

  const strategies = {
    items: strategyItems,
    generated_at: new Date().toISOString(),
  };

  const risk = buildRiskFromStrategy(primaryStrategy, dynamicResult, spot);

  const portfolio = {
    totals: strategyItems.reduce(
      (acc, item) => {
        acc.pnl += Number(item.expected_value ?? 0);
        acc.delta += Number(item.delta_exposure ?? 0);
        acc.gamma += Number(item.gamma_exposure ?? 0);
        acc.vega += Number(item.vega_exposure ?? 0);
        return acc;
      },
      { pnl: 0, delta: 0, gamma: 0, vega: 0 },
    ),
    positions: strategyItems,
  };

  const backtest = buildBacktestFromStrategies(strategyItems);

  return { market, surface, strategies, risk, backtest, portfolio };
}

function cacheSnapshot(snapshotId, modules) {
  snapshotCache.set(snapshotId, modules);
}

function getCachedSnapshot(snapshotId) {
  return snapshotCache.get(snapshotId) || null;
}

export async function runStaticPipeline(configPayload) {
  return request('/pipeline/static', {
    method: 'POST',
    body: JSON.stringify(configPayload),
  });
}

export async function runStaticForSnapshot(configPayload) {
  try {
    const payload = await request('/run_static', {
      method: 'POST',
      body: JSON.stringify(configPayload),
    });
    return { snapshotId: payload.snapshot_id, backendSnapshot: true };
  } catch {
    const response = await runStaticPipeline(configPayload);
    const snapshotId = `static-${Date.now()}`;
    const modules = normalizeSnapshotModules(response.data);
    cacheSnapshot(snapshotId, modules);
    return { snapshotId, backendSnapshot: false, fallbackModules: modules };
  }
}

export async function submitDynamicPipeline(configPayload) {
  return request('/pipeline/dynamic/submit', {
    method: 'POST',
    body: JSON.stringify(configPayload),
  });
}

export async function runDynamicForSnapshot(configPayload, options = {}) {
  const { activeSnapshotId, onStatus } = options;

  try {
    const payload = await request('/run_dynamic', {
      method: 'POST',
      body: JSON.stringify(configPayload),
    });
    return { snapshotId: payload.snapshot_id, backendSnapshot: true };
  } catch {
    const submit = await submitDynamicPipeline(configPayload);
    let finalStatus = null;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const status = await getJobStatus(submit.job_id);
      onStatus?.(status.state);
      if (status.state === 'completed') {
        finalStatus = status;
        break;
      }
      if (status.state === 'failed' || status.state === 'canceled' || status.state === 'not_found') {
        throw new Error(status.error || `Dynamic pipeline ${status.state}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    if (!finalStatus) {
      throw new Error('Dynamic pipeline timed out.');
    }

    const baseModules = getCachedSnapshot(activeSnapshotId) || {
      market: null,
      surface: null,
      strategies: { items: [] },
      risk: null,
      backtest: null,
      portfolio: { totals: { pnl: 0, delta: 0, gamma: 0, vega: 0 }, positions: [] },
    };

    const firstStrategy = baseModules.strategies?.items?.[0] || {};
    const snapshotId = `dynamic-${Date.now()}`;
    const modules = {
      ...baseModules,
      risk: buildRiskFromStrategy(firstStrategy, finalStatus.result, baseModules.market?.spot ?? 0),
      portfolio: {
        ...(baseModules.portfolio || {}),
        dynamic: finalStatus.result,
      },
    };

    cacheSnapshot(snapshotId, modules);
    return { snapshotId, backendSnapshot: false, fallbackModules: modules };
  }
}

export async function getSnapshotModule(snapshotId, moduleName) {
  const cached = getCachedSnapshot(snapshotId);
  if (cached) {
    if (!(moduleName in cached)) {
      throw new Error(`Module ${moduleName} missing for snapshot ${snapshotId}.`);
    }
    return cached[moduleName];
  }

  try {
    return await request(`/snapshot/${snapshotId}/${moduleName}`);
  } catch {
    throw new Error(`Snapshot ${snapshotId} is not available.`);
  }
}

export async function getJobStatus(jobId) {
  return request(`/jobs/${jobId}`);
}

export async function cancelJob(jobId) {
  return request(`/jobs/${jobId}`, {
    method: 'DELETE',
  });
}

export async function checkBackendHealth() {
  return request('/health');
}

export async function getRecentLogs(lineCount = 120) {
  return request(`/logs/recent?lines=${lineCount}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// NSE Live Data
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchLiveNSEData(symbol = 'NIFTY', expiries = null, maxExpiries = 5) {
  return request('/data/fetch-live', {
    method: 'POST',
    body: JSON.stringify({ symbol, expiries, max_expiries: maxExpiries }),
  });
}

export async function getNSEExpiries(symbol = 'NIFTY') {
  return request(`/data/expiries?symbol=${encodeURIComponent(symbol)}`);
}

export async function runLiveStaticPipeline(payload) {
  return request('/pipeline/live-static', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function runLiveForSnapshot(symbol = 'NIFTY', pipelineParams = {}, maxExpiries = 5) {
  // Step 1: Fetch live data from NSE
  const fetchResponse = await fetchLiveNSEData(symbol, null, maxExpiries);
  const { data_id, spot, quality_report, expiry_dates } = fetchResponse.data;

  // Step 2: Run the pipeline on the cached live data
  const pipelinePayload = {
    data_id,
    risk_free_rate: 0.065,
    dividend_yield: 0.012,
    capital_limit: 500000,
    strike_increment: 50,
    max_legs: 4,
    max_width: 1000,
    simulation_paths: 30000,
    simulation_steps: 64,
    ...pipelineParams,
  };
  const pipelineResponse = await runLiveStaticPipeline(pipelinePayload);

  // Step 3: Normalize into snapshot modules (reuse existing function)
  const snapshotId = `live-${Date.now()}`;
  const modules = normalizeSnapshotModules(pipelineResponse.data);
  cacheSnapshot(snapshotId, modules);

  return {
    snapshotId,
    backendSnapshot: false,
    fallbackModules: modules,
    liveMetadata: { data_id, spot, quality_report, expiry_dates, symbol },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Agent System
// ─────────────────────────────────────────────────────────────────────────────

export async function aiChat(query, agent = null, pipelineData = null, modelId = null) {
  const body = { query };
  if (agent) body.agent = agent;
  if (pipelineData) body.pipeline_data = pipelineData;
  if (modelId) body.model_id = modelId;
  return request('/ai/chat', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function aiChatStream(query, agent = null, pipelineData = null, onChunk = null, modelId = null) {
  const body = { query };
  if (agent) body.agent = agent;
  if (pipelineData) body.pipeline_data = pipelineData;
  if (modelId) body.model_id = modelId;

  const response = await fetch(`${API_BASE}/ai/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.detail || 'AI stream request failed');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let agentInfo = { agent: '', role: '' };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.agent) agentInfo.agent = data.agent;
        if (data.role) agentInfo.role = data.role;
        if (data.chunk) {
          fullText += data.chunk;
          onChunk?.({ ...agentInfo, text: fullText, chunk: data.chunk, done: false });
        }
        if (data.done) {
          onChunk?.({ ...agentInfo, text: fullText, chunk: '', done: true });
        }
        if (data.error) {
          throw new Error(data.error);
        }
      } catch (parseErr) {
        if (parseErr.message !== 'AI stream request failed') {
          // Ignore JSON parse errors from partial chunks
        }
      }
    }
  }

  return { ...agentInfo, text: fullText };
}

export async function aiBriefing(pipelineData = null, modelId = null) {
  const body = {};
  if (pipelineData) body.pipeline_data = pipelineData;
  if (modelId) body.model_id = modelId;
  return request('/ai/briefing', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function aiListAgents() {
  return request('/ai/agents');
}

export async function aiSyncPipeline(pipelineData) {
  return request('/ai/pipeline-sync', {
    method: 'POST',
    body: JSON.stringify(pipelineData),
  });
}

export async function aiClearConversation() {
  return request('/ai/clear', { method: 'POST', body: '{}' });
}

export async function aiRecalibrate(dataId, initialGuess = null, paramBounds = null, extraParams = {}) {
  const body = { data_id: dataId, ...extraParams };
  if (initialGuess) body.initial_guess = initialGuess;
  if (paramBounds) body.param_bounds = paramBounds;
  return request('/ai/recalibrate', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function aiStrategyPick(pipelineData = null, modelId = 'gemma3:1b', maxCandidates = 3) {
  const body = {
    model_id: modelId,
    max_candidates: maxCandidates,
  };
  if (pipelineData) body.pipeline_data = pipelineData;
  return request('/ai/strategy-pick', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Portfolio Management
// ─────────────────────────────────────────────────────────────────────────────

export async function portfolioAdd(strategy, spot) {
  return request('/portfolio/add', {
    method: 'POST',
    body: JSON.stringify({ strategy, spot }),
  });
}

export async function portfolioList(status = 'open') {
  return request(`/portfolio/positions?status=${encodeURIComponent(status)}`);
}

export async function portfolioGet(posId) {
  return request(`/portfolio/positions/${encodeURIComponent(posId)}`);
}

export async function portfolioDelete(posId) {
  return request(`/portfolio/positions/${encodeURIComponent(posId)}`, {
    method: 'DELETE',
  });
}

export async function portfolioClear() {
  return request('/portfolio/clear', { method: 'DELETE' });
}

export async function portfolioRevalue() {
  return request('/portfolio/revalue', { method: 'POST' });
}
