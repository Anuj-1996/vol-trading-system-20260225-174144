import React, { useMemo, useState, useRef, useCallback } from 'react';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber, formatPct } from './shared.jsx';

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function alignRightSeries(values, targetLength) {
  const source = Array.isArray(values) ? values : [];
  const out = Array.from({ length: Math.max(0, targetLength) }, () => null);
  if (!source.length || !targetLength) return out;
  const offset = Math.max(0, targetLength - source.length);
  for (let i = 0; i < targetLength; i += 1) {
    const j = i - offset;
    if (j >= 0 && j < source.length) out[i] = safeNum(source[j]);
  }
  return out;
}

// Linear interpolation to fill null/zero gaps in a numeric series
function interpolateGaps(arr, minValid = 0) {
  const out = [...arr];
  // Treat null, non-finite, and values <= minValid as gaps
  const isGap = (v) => v == null || !Number.isFinite(v) || v <= minValid;
  for (let i = 0; i < out.length; i += 1) {
    if (!isGap(out[i])) continue;
    // Find previous valid
    let left = i - 1;
    while (left >= 0 && isGap(out[left])) left -= 1;
    // Find next valid
    let right = i + 1;
    while (right < out.length && isGap(out[right])) right += 1;
    if (left >= 0 && right < out.length) {
      // Interpolate
      const frac = (i - left) / (right - left);
      out[i] = out[left] + frac * (out[right] - out[left]);
    } else if (left >= 0) {
      out[i] = out[left]; // Forward fill
    } else if (right < out.length) {
      out[i] = out[right]; // Back fill
    }
  }
  return out;
}

function computeReturns(close) {
  const out = Array.from({ length: close.length }, () => null);
  for (let i = 1; i < close.length; i += 1) {
    const prev = close[i - 1];
    const curr = close[i];
    if (prev && curr && prev > 0 && curr > 0) out[i] = Math.log(curr / prev);
  }
  return out;
}

function regimeRule(row) {
  const rv20 = row[0];
  const rv60 = row[1];
  const iv = row[2];
  if (!Number.isFinite(rv20) || !Number.isFinite(rv60) || !Number.isFinite(iv)) return 'normal';
  if (iv >= rv20 * 1.2 || rv20 >= rv60 * 1.2) return 'stress';
  if (iv <= rv20 * 0.92 && rv20 <= rv60) return 'calm';
  return 'normal';
}

function inferRegimeName(stats) {
  const { iv = 0, rv20 = 0, rv60 = 0, absRet = 0 } = stats || {};
  const ivRv = rv20 > 1e-8 ? iv / rv20 : 1;
  const rvTrend = rv60 > 1e-8 ? rv20 / rv60 : 1;
  if (ivRv >= 1.2 || rvTrend >= 1.2 || absRet >= 0.018) return 'Stress / Risk-Off';
  if (ivRv <= 0.92 && rvTrend <= 1.0 && absRet <= 0.011) return 'Calm / Carry';
  if (ivRv >= 1.05 && absRet >= 0.012) return 'Elevated Hedging';
  if (rvTrend > 1.05) return 'Vol Expansion';
  if (rvTrend < 0.95) return 'Vol Compression';
  return 'Neutral / Transition';
}

function standardize(rows) {
  if (!rows.length) return { scaled: [], means: [], stds: [] };
  const d = rows[0].length;
  const means = Array.from({ length: d }, (_, j) => rows.reduce((a, r) => a + r[j], 0) / rows.length);
  const stds = Array.from({ length: d }, (_, j) => {
    const v = rows.reduce((a, r) => a + (r[j] - means[j]) ** 2, 0) / Math.max(rows.length - 1, 1);
    return Math.sqrt(Math.max(v, 1e-9));
  });
  const scaled = rows.map((r) => r.map((v, j) => (v - means[j]) / stds[j]));
  return { scaled, means, stds };
}

function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

function kmeans(data, k = 3, maxIter = 30) {
  if (!data.length) return { labels: [], centers: [] };
  const n = data.length;
  const d = data[0].length;
  const centers = Array.from({ length: k }, (_, i) => [...data[Math.floor((i * n) / k)]]);
  const labels = Array.from({ length: n }, () => 0);

  for (let it = 0; it < maxIter; it += 1) {
    let changed = false;
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c += 1) {
        const dist = euclidean(data[i], centers[c]);
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
    const sums = Array.from({ length: k }, () => Array.from({ length: d }, () => 0));
    const counts = Array.from({ length: k }, () => 0);
    for (let i = 0; i < n; i += 1) {
      const c = labels[i];
      counts[c] += 1;
      for (let j = 0; j < d; j += 1) sums[c][j] += data[i][j];
    }
    for (let c = 0; c < k; c += 1) {
      if (!counts[c]) continue;
      for (let j = 0; j < d; j += 1) centers[c][j] = sums[c][j] / counts[c];
    }
  }
  return { labels, centers };
}

function gaussDiagPdf(x, mean, varDiag) {
  let logDet = 0;
  let quad = 0;
  for (let j = 0; j < x.length; j += 1) {
    const v = Math.max(varDiag[j], 1e-6);
    logDet += Math.log(v);
    quad += ((x[j] - mean[j]) ** 2) / v;
  }
  return Math.exp(-0.5 * (logDet + quad + x.length * Math.log(2 * Math.PI)));
}

function fitGmmDiag(data, k = 3, maxIter = 25) {
  if (!data.length) return { probs: [], means: [], weights: [] };
  const n = data.length;
  const d = data[0].length;
  const km = kmeans(data, k, 10);
  const means = km.centers.map((c) => [...c]);
  const vars = Array.from({ length: k }, () => Array.from({ length: d }, () => 1));
  const weights = Array.from({ length: k }, () => 1 / k);
  const resp = Array.from({ length: n }, () => Array.from({ length: k }, () => 1 / k));

  for (let iter = 0; iter < maxIter; iter += 1) {
    for (let i = 0; i < n; i += 1) {
      let den = 0;
      for (let c = 0; c < k; c += 1) {
        const v = weights[c] * gaussDiagPdf(data[i], means[c], vars[c]);
        resp[i][c] = v;
        den += v;
      }
      if (den <= 1e-15) {
        for (let c = 0; c < k; c += 1) resp[i][c] = 1 / k;
      } else {
        for (let c = 0; c < k; c += 1) resp[i][c] /= den;
      }
    }

    for (let c = 0; c < k; c += 1) {
      let nk = 0;
      for (let i = 0; i < n; i += 1) nk += resp[i][c];
      weights[c] = Math.max(nk / n, 1e-6);
      if (nk <= 1e-8) continue;
      for (let j = 0; j < d; j += 1) {
        let num = 0;
        for (let i = 0; i < n; i += 1) num += resp[i][c] * data[i][j];
        means[c][j] = num / nk;
      }
      for (let j = 0; j < d; j += 1) {
        let num = 0;
        for (let i = 0; i < n; i += 1) num += resp[i][c] * (data[i][j] - means[c][j]) ** 2;
        vars[c][j] = Math.max(num / nk, 1e-4);
      }
    }
    const ws = weights.reduce((a, b) => a + b, 0) || 1;
    for (let c = 0; c < k; c += 1) weights[c] /= ws;
  }
  return { probs: resp, means, weights };
}

function knnPredict(trainX, trainY, x, k = 9) {
  const pairs = trainX.map((row, idx) => ({ idx, dist: euclidean(row, x) })).sort((a, b) => a.dist - b.dist);
  const top = pairs.slice(0, Math.max(1, Math.min(k, pairs.length)));
  const votes = new Map();
  for (const item of top) {
    const y = trainY[item.idx];
    votes.set(y, (votes.get(y) || 0) + 1);
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'normal';
}

function buildConfusion(actual, pred, classes) {
  const map = new Map(classes.map((c, i) => [c, i]));
  const mat = classes.map(() => classes.map(() => 0));
  let correct = 0;
  for (let i = 0; i < actual.length; i += 1) {
    const ai = map.get(actual[i]);
    const pi = map.get(pred[i]);
    if (ai == null || pi == null) continue;
    mat[ai][pi] += 1;
    if (ai === pi) correct += 1;
  }
  return { matrix: mat, acc: actual.length ? correct / actual.length : 0 };
}

/* ── Isolated 3-D scatter component ── keeps Plotly camera across parent re-renders ── */
const AXIS_OPTS_3D = {
  rv20:   { label: 'RV20',         get: (r) => r.rv20 },
  rv60:   { label: 'RV60',         get: (r) => r.rv60 },
  iv:     { label: 'IV Proxy',     get: (r) => r.iv },
  hv20:   { label: 'HV20',         get: (r) => r.hv20 },
  absRet: { label: '|Log Return|', get: (r) => r.absRet },
  date:   { label: 'Date',         get: (r) => r.date },
};

const Scatter3DPlot = React.memo(function Scatter3DPlot({ rows, clusterLabels, xKey, yKey, zKey }) {
  const cameraRef = useRef(null);
  const xOpt = AXIS_OPTS_3D[xKey] || AXIS_OPTS_3D.rv20;
  const yOpt = AXIS_OPTS_3D[yKey] || AXIS_OPTS_3D.iv;
  const zOpt = AXIS_OPTS_3D[zKey] || AXIS_OPTS_3D.rv60;
  const xVals = useMemo(() => rows.map((r) => xOpt.get(r)), [rows, xKey]); // eslint-disable-line
  const yVals = useMemo(() => rows.map((r) => yOpt.get(r)), [rows, yKey]); // eslint-disable-line
  const zVals = useMemo(() => rows.map((r) => zOpt.get(r)), [rows, zKey]); // eslint-disable-line
  const k = Math.max(...clusterLabels) + 1;
  const palette = ['#fef9c3','#fde047','#facc15','#f59e0b','#ea580c','#dc2626','#b91c1c','#7f1d1d'];
  const fmtX = xKey === 'date' ? '' : ':.4f';
  const fmtY = yKey === 'date' ? '' : ':.4f';
  const fmtZ = zKey === 'date' ? '' : ':.4f';

  const data = useMemo(() => {
    const scatter = Array.from({ length: k }, (_, c) => {
      const mask = clusterLabels.map((l, i) => l === c ? i : -1).filter((i) => i >= 0);
      return {
        type: 'scatter3d', mode: 'markers', name: `Cluster ${c}`,
        x: mask.map((i) => xVals[i]), y: mask.map((i) => yVals[i]), z: mask.map((i) => zVals[i]),
        marker: { size: 4, color: palette[Math.round(c * (palette.length - 1) / Math.max(k - 1, 1))], opacity: 0.85 },
        hovertemplate: `${xOpt.label}: %{x${fmtX}}<br>${yOpt.label}: %{y${fmtY}}<br>${zOpt.label}: %{z${fmtZ}}<br>Cluster ${c}<extra></extra>`,
      };
    });
    const mesh = Array.from({ length: k }, (_, c) => {
      const mask = clusterLabels.map((l, i) => l === c ? i : -1).filter((i) => i >= 0);
      if (mask.length < 4) return null;
      return {
        type: 'mesh3d', name: `Surface ${c}`,
        x: mask.map((i) => xVals[i]), y: mask.map((i) => yVals[i]), z: mask.map((i) => zVals[i]),
        alphahull: 7, color: palette[Math.round(c * (palette.length - 1) / Math.max(k - 1, 1))], opacity: 0.15,
        showlegend: false, hoverinfo: 'skip',
      };
    }).filter(Boolean);
    return [...scatter, ...mesh];
  }, [xVals, yVals, zVals, clusterLabels, k]); // eslint-disable-line

  const layout = useMemo(() => ({
    height: 420, margin: { l: 0, r: 0, b: 0, t: 10 },
    paper_bgcolor: '#0a0f19',
    font: { color: '#d1d5db', size: 10 },
    uirevision: 'cluster3d-persist',
    scene: {
      bgcolor: '#0a0f19',
      xaxis: { title: xOpt.label, gridcolor: '#1f2937', color: '#94a3b8', zerolinecolor: '#334155', ...(xKey === 'date' ? { type: 'date' } : {}) },
      yaxis: { title: yOpt.label, gridcolor: '#1f2937', color: '#94a3b8', zerolinecolor: '#334155', ...(yKey === 'date' ? { type: 'date' } : {}) },
      zaxis: { title: zOpt.label, gridcolor: '#1f2937', color: '#94a3b8', zerolinecolor: '#334155', ...(zKey === 'date' ? { type: 'date' } : {}) },
      ...(cameraRef.current ? { camera: cameraRef.current } : {}),
    },
    legend: { orientation: 'h', y: -0.05, font: { size: 10 } },
  }), [xKey, yKey, zKey]); // eslint-disable-line

  const handleUpdate = useCallback((figure) => {
    const cam = figure?.layout?.scene?.camera;
    if (cam) cameraRef.current = cam;
  }, []);

  return (
    <Plot
      data={data}
      layout={layout}
      config={{ displaylogo: false, responsive: true }}
      style={{ width: '100%' }}
      useResizeHandler
      onUpdate={handleUpdate}
    />
  );
});

export default function RegimeMLPage({ loading, activeSnapshotId, market }) {
  const [neighbors, setNeighbors] = useState(9);
  const [clusters, setClusters] = useState(3);
  const [scatter2dX, setScatter2dX] = useState('rv20');
  const [scatter2dY, setScatter2dY] = useState('iv');
  const [scatter3dX, setScatter3dX] = useState('rv20');
  const [scatter3dY, setScatter3dY] = useState('iv');
  const [scatter3dZ, setScatter3dZ] = useState('rv60');
  const dataBundle = useMemo(() => {
    const history = market?.price_history || null;
    const dates = Array.isArray(history?.dates) ? history.dates : [];
    if (dates.length < 40) return null;
    const close = (history.close || []).map(safeNum);
    const rv20 = (history.rv20_annualized || []).map(safeNum);
    const rv60 = (history.rv60_annualized || []).map(safeNum);
    const forecasts = market?.vol_model_forecasts || {};
    const ivProxyRaw = alignRightSeries(forecasts.iv_proxy || [], dates.length);
    const ivProxy = interpolateGaps(ivProxyRaw, 0.005);
    const hv20Raw = alignRightSeries(forecasts.hv20 || [], dates.length);
    const hv20 = interpolateGaps(hv20Raw);
    const ret = computeReturns(close);

    const rows = [];
    for (let i = 0; i < dates.length; i += 1) {
      const feats = [rv20[i], rv60[i], ivProxy[i], hv20[i], Math.abs(ret[i] ?? 0)];
      if (feats.some((v) => !Number.isFinite(v))) continue;
      rows.push({ i, date: dates[i], feats, rv20: feats[0], rv60: feats[1], iv: feats[2], hv20: feats[3], absRet: feats[4] });
    }
    if (rows.length < 30) return null;

    const xRaw = rows.map((r) => r.feats);
    const yRule = rows.map((r) => regimeRule(r.feats));
    const { scaled } = standardize(xRaw);
    const km = kmeans(scaled, Math.max(2, Math.min(5, clusters)), 40);
    const gm = fitGmmDiag(scaled, Math.max(2, Math.min(5, clusters)), 25);
    const k = gm.probs[0]?.length || 0;
    const regimeStats = Array.from({ length: k }, (_, c) => {
      let w = 0;
      let rv20 = 0;
      let rv60 = 0;
      let iv = 0;
      let absRet = 0;
      for (let i = 0; i < rows.length; i += 1) {
        const p = Number(gm.probs[i]?.[c] ?? 0);
        if (!Number.isFinite(p) || p <= 0) continue;
        w += p;
        rv20 += p * rows[i].feats[0];
        rv60 += p * rows[i].feats[1];
        iv += p * rows[i].feats[2];
        absRet += p * rows[i].feats[4];
      }
      if (w > 0) {
        rv20 /= w;
        rv60 /= w;
        iv /= w;
        absRet /= w;
      }
      return { rv20, rv60, iv, absRet, weight: w / Math.max(rows.length, 1) };
    });

    const usedNames = new Map();
    const regimeNames = regimeStats.map((s) => {
      const base = inferRegimeName(s);
      const count = (usedNames.get(base) || 0) + 1;
      usedNames.set(base, count);
      return count > 1 ? `${base} ${count}` : base;
    });

    const split = Math.max(20, Math.floor(scaled.length * 0.7));
    const xTrain = scaled.slice(0, split);
    const yTrain = yRule.slice(0, split);
    const xTest = scaled.slice(split);
    const yTest = yRule.slice(split);
    const predTest = xTest.map((x) => knnPredict(xTrain, yTrain, x, neighbors));
    const classes = ['calm', 'normal', 'stress'];
    const confusion = buildConfusion(yTest, predTest, classes);
    const latestPred = scaled.length > 1 ? knnPredict(scaled.slice(0, -1), yRule.slice(0, -1), scaled[scaled.length - 1], neighbors) : yRule[yRule.length - 1];
    const regimeColors = ['#38bdf8', '#f59e0b', '#ef4444', '#22c55e', '#a78bfa'];
    let dominantRegimeName = '-';
    const dominantStateIdx = [];
    if (gm.probs.length && regimeNames.length) {
      for (let i = 0; i < gm.probs.length; i += 1) {
        const rowProb = gm.probs[i] || [];
        let best = 0;
        for (let c = 1; c < rowProb.length; c += 1) {
          if ((rowProb[c] || 0) > (rowProb[best] || 0)) best = c;
        }
        dominantStateIdx.push(best);
      }
      const last = dominantStateIdx[dominantStateIdx.length - 1] ?? 0;
      dominantRegimeName = regimeNames[last] || '-';
    }

    const transitionMatrix = Array.from({ length: regimeNames.length }, () =>
      Array.from({ length: regimeNames.length }, () => 0),
    );
    for (let i = 1; i < dominantStateIdx.length; i += 1) {
      const from = dominantStateIdx[i - 1];
      const to = dominantStateIdx[i];
      if (transitionMatrix[from] && transitionMatrix[from][to] != null) transitionMatrix[from][to] += 1;
    }

    const runLengths = Array.from({ length: regimeNames.length }, () => []);
    if (dominantStateIdx.length) {
      let runState = dominantStateIdx[0];
      let runLen = 1;
      for (let i = 1; i < dominantStateIdx.length; i += 1) {
        if (dominantStateIdx[i] === runState) {
          runLen += 1;
        } else {
          runLengths[runState].push(runLen);
          runState = dominantStateIdx[i];
          runLen = 1;
        }
      }
      runLengths[runState].push(runLen);
    }
    const regimeDurationStats = runLengths.map((arr, idx) => {
      const mean = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      const max = arr.length ? Math.max(...arr) : 0;
      return { idx, mean, max };
    });

    const spreadByRegime = Array.from({ length: regimeNames.length }, () => []);
    for (let i = 0; i < rows.length; i += 1) {
      const c = dominantStateIdx[i] ?? 0;
      const spread = Number(rows[i].iv) - Number(rows[i].rv20);
      if (Number.isFinite(spread) && spreadByRegime[c]) spreadByRegime[c].push(spread);
    }

    return {
      rows,
      yRule,
      scaled,
      clusterLabels: km.labels,
      gmmProbs: gm.probs,
      regimeNames,
      regimeStats,
      dominantRegimeName,
      dominantStateIdx,
      transitionMatrix,
      regimeDurationStats,
      spreadByRegime,
      confusion,
      latestPred,
      classes,
      regimeColors,
    };
  }, [market, neighbors, clusters]);

  const gmmTraces = useMemo(() => {
    if (!dataBundle?.gmmProbs?.length) return [];
    const k = dataBundle.gmmProbs[0].length;
    const x = dataBundle.rows.map((r) => r.date);
    const traces = [];
    for (let c = 0; c < k; c += 1) {
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x,
        y: dataBundle.gmmProbs.map((p) => p[c]),
        name: dataBundle.regimeNames?.[c] || `Regime ${c + 1}`,
        stackgroup: 'one',
        line: { width: 1.4, color: dataBundle.regimeColors[c % dataBundle.regimeColors.length] },
      });
    }
    return traces;
  }, [dataBundle]);

  // --- Regime Rotation Graph (RRG-style) ---
  const rotationData = useMemo(() => {
    if (!dataBundle?.gmmProbs?.length) return null;
    const probs = dataBundle.gmmProbs;
    const k = probs[0].length;
    const n = probs.length;
    const window = Math.min(14, Math.floor(n / 4));
    if (n < window + 2) return null;

    // Exponential moving average helper
    const ema = (arr, span) => {
      const alpha = 2 / (span + 1);
      const out = [arr[0]];
      for (let i = 1; i < arr.length; i += 1) out.push(alpha * arr[i] + (1 - alpha) * out[i - 1]);
      return out;
    };

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // Compute rolling average of each regime's probability
    const rollingAvg = Array.from({ length: k }, () => []);
    for (let c = 0; c < k; c += 1) {
      for (let i = window - 1; i < n; i += 1) {
        let sum = 0;
        for (let j = i - window + 1; j <= i; j += 1) sum += (probs[j][c] || 0);
        rollingAvg[c].push(sum / window);
      }
    }

    const mLen = rollingAvg[0].length;

    // RS-Ratio: use percentile rank across regimes at each time step
    // Then smooth with EMA and scale to [50,150] centered at 100
    const rsRatio = Array.from({ length: k }, () => new Array(mLen).fill(100));
    for (let t = 0; t < mLen; t += 1) {
      const vals = [];
      for (let c = 0; c < k; c += 1) vals.push(rollingAvg[c][t]);
      const sorted = [...vals].sort((a, b) => a - b);
      for (let c = 0; c < k; c += 1) {
        // Percentile rank: 0 to 1
        const rank = sorted.indexOf(vals[c]) / Math.max(k - 1, 1);
        rsRatio[c][t] = 60 + rank * 80; // Maps to [60, 140]
      }
    }
    // EMA smooth the ratios
    const smoothRatio = rsRatio.map((arr) => ema(arr, Math.min(10, Math.floor(mLen / 4))));

    // RS-Momentum: smoothed rate of change of RS-Ratio
    const mom = Math.max(3, Math.min(7, Math.floor(mLen / 5)));
    const rsMomentum = smoothRatio.map((arr) => {
      const raw = arr.map((v, i) => {
        if (i < mom) return 100;
        const delta = v - arr[i - mom];
        // Scale delta: map ~±40 spread to ±40 on chart
        return 100 + clamp(delta * 1.5, -40, 40);
      });
      return ema(raw, Math.min(8, Math.floor(mLen / 4)));
    });

    // Take last N points as trail
    const tailLen = Math.min(20, mLen);
    const regimes = [];
    for (let c = 0; c < k; c += 1) {
      const len = smoothRatio[c].length;
      const xTail = smoothRatio[c].slice(len - tailLen).map((v) => clamp(v, 55, 145));
      const yTail = rsMomentum[c].slice(len - tailLen).map((v) => clamp(v, 55, 145));
      regimes.push({
        name: dataBundle.regimeNames[c] || `Regime ${c + 1}`,
        color: dataBundle.regimeColors[c % dataBundle.regimeColors.length],
        xTail,
        yTail,
        xNow: xTail[xTail.length - 1],
        yNow: yTail[yTail.length - 1],
      });
    }
    return regimes;
  }, [dataBundle]);

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-regime-grid">
        <div className="regime-main-stack">
          <Panel title="Regime Timeline (RV20 + IV Proxy + Cluster State)" enableCopyPlot>
            {dataBundle ? (
              <Plot
                data={[
                  {
                    type: 'scatter',
                    mode: 'lines',
                    x: dataBundle.rows.map((r) => r.date),
                    y: dataBundle.rows.map((r) => r.rv20),
                    name: 'RV20',
                    line: { color: '#38bdf8', width: 1.8 },
                  },
                  {
                    type: 'scatter',
                    mode: 'lines',
                    x: dataBundle.rows.map((r) => r.date),
                    y: dataBundle.rows.map((r) => r.iv),
                    name: 'IV Proxy',
                    line: { color: '#ef4444', width: 1.8, shape: 'spline', smoothing: 0.8 },
                    connectgaps: true,
                  },
                  {
                    type: 'scatter',
                    mode: 'markers',
                    x: dataBundle.rows.map((r) => r.date),
                    y: dataBundle.rows.map((r) => r.rv20),
                    name: 'Cluster',
                    marker: {
                      size: 7,
                      color: dataBundle.clusterLabels,
                      colorscale: 'Turbo',
                      showscale: false,
                      opacity: 0.9,
                    },
                    hovertemplate: 'Date: %{x}<br>RV20: %{y:.4f}<br>Cluster: %{marker.color}<extra></extra>',
                  },
                ]}
                layout={{
                  height: 280,
                  margin: { l: 46, r: 12, b: 34, t: 8 },
                  paper_bgcolor: '#0a0f19',
                  plot_bgcolor: '#0a0f19',
                  font: { color: '#d1d5db', size: 10 },
                  xaxis: { gridcolor: '#1f2937' },
                  yaxis: { title: 'Vol', gridcolor: '#1f2937' },
                  legend: { orientation: 'h', y: 1.12 },
                }}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: '100%' }}
                useResizeHandler
              />
            ) : (
              <div className="snapshot-placeholder">Not enough history yet for regime modeling.</div>
            )}
          </Panel>

          <Panel title="Feature Space Clustering (K-Means) — 2D" enableCopyPlot>
            {dataBundle ? (() => {
              const axisOpts = {
                rv20: { label: 'RV20', get: (r) => r.rv20 },
                rv60: { label: 'RV60', get: (r) => r.rv60 },
                iv: { label: 'IV Proxy', get: (r) => r.iv },
                hv20: { label: 'HV20', get: (r) => r.hv20 },
                absRet: { label: '|Log Return|', get: (r) => r.absRet },
                date: { label: 'Date', get: (r) => r.date },
              };
              const xOpt = axisOpts[scatter2dX] || axisOpts.rv20;
              const yOpt = axisOpts[scatter2dY] || axisOpts.iv;
              const xVals = dataBundle.rows.map((r, i) => xOpt.get(r, i));
              const yVals = dataBundle.rows.map((r, i) => yOpt.get(r, i));
              const labels = dataBundle.clusterLabels;
              const k = Math.max(...labels) + 1;
              const palette = ['#fef9c3', '#fde047', '#facc15', '#f59e0b', '#ea580c', '#dc2626', '#b91c1c', '#7f1d1d'];
              const selStyle = { background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, padding: '2px 8px', fontSize: '0.75rem' };
              const optionEls = Object.entries(axisOpts).map(([k, v]) => <option key={k} value={k}>{v.label}</option>);

              return (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                    <label style={{ color: '#94a3b8', fontSize: '0.75rem' }}>X:</label>
                    <select value={scatter2dX} onChange={(e) => setScatter2dX(e.target.value)} style={selStyle}>{optionEls}</select>
                    <label style={{ color: '#94a3b8', fontSize: '0.75rem' }}>Y:</label>
                    <select value={scatter2dY} onChange={(e) => setScatter2dY(e.target.value)} style={selStyle}>{optionEls}</select>
                  </div>
                  <Plot
                    data={Array.from({ length: k }, (_, c) => {
                      const mask = labels.map((l, i) => l === c ? i : -1).filter((i) => i >= 0);
                      return {
                        type: 'scatter', mode: 'markers', name: `Cluster ${c}`,
                        x: mask.map((i) => xVals[i]), y: mask.map((i) => yVals[i]),
                        marker: { size: 5, color: palette[Math.round(c * (palette.length - 1) / Math.max(k - 1, 1))], opacity: 0.85 },
                        hovertemplate: `${xOpt.label}: %{x${scatter2dX === 'date' ? '' : ':.4f'}}<br>${yOpt.label}: %{y${scatter2dY === 'date' ? '' : ':.4f'}}<br>Cluster ${c}<extra></extra>`,
                      };
                    })}
                    layout={{
                      height: 380, margin: { l: 55, r: 20, b: 45, t: 10 },
                      paper_bgcolor: '#0a0f19', plot_bgcolor: '#0a0f19',
                      font: { color: '#d1d5db', size: 10 },
                      xaxis: { title: xOpt.label, gridcolor: '#1f2937', color: '#94a3b8', zerolinecolor: '#334155', ...(scatter2dX === 'date' ? { type: 'date' } : {}) },
                      yaxis: { title: yOpt.label, gridcolor: '#1f2937', color: '#94a3b8', zerolinecolor: '#334155', ...(scatter2dY === 'date' ? { type: 'date' } : {}) },
                      legend: { orientation: 'h', y: -0.15, font: { size: 10 } },
                    }}
                    config={{ displaylogo: false, responsive: true }}
                    style={{ width: '100%' }}
                    useResizeHandler
                  />
                </>
              );
            })() : (
              <div className="snapshot-placeholder">No cluster output to show yet.</div>
            )}
          </Panel>

          <Panel title="Feature Space Clustering (K-Means) — 3D" enableCopyPlot>
            {dataBundle ? (() => {
              const selStyle = { background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, padding: '2px 8px', fontSize: '0.75rem' };
              const optionEls = Object.entries(AXIS_OPTS_3D).map(([k, v]) => <option key={k} value={k}>{v.label}</option>);
              return (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                    <label style={{ color: '#94a3b8', fontSize: '0.75rem' }}>X:</label>
                    <select value={scatter3dX} onChange={(e) => setScatter3dX(e.target.value)} style={selStyle}>{optionEls}</select>
                    <label style={{ color: '#94a3b8', fontSize: '0.75rem' }}>Y:</label>
                    <select value={scatter3dY} onChange={(e) => setScatter3dY(e.target.value)} style={selStyle}>{optionEls}</select>
                    <label style={{ color: '#94a3b8', fontSize: '0.75rem' }}>Z:</label>
                    <select value={scatter3dZ} onChange={(e) => setScatter3dZ(e.target.value)} style={selStyle}>{optionEls}</select>
                  </div>
                  <Scatter3DPlot
                    rows={dataBundle.rows}
                    clusterLabels={dataBundle.clusterLabels}
                    xKey={scatter3dX}
                    yKey={scatter3dY}
                    zKey={scatter3dZ}
                  />
                </>
              );
            })() : (
              <div className="snapshot-placeholder">No cluster output to show yet.</div>
            )}
          </Panel>

          <Panel title="Latent Regime Transition Matrix" enableCopyPlot>
            {dataBundle ? (() => {
              const tm = dataBundle.transitionMatrix;
              const names = dataBundle.regimeNames;
              const maxVal = Math.max(...tm.flat(), 1);
              return (
                <Plot
                  data={[{
                    type: 'heatmap',
                    z: tm,
                    x: names,
                    y: names,
                    colorscale: 'YlOrRd',
                    hovertemplate: 'From: %{y}<br>To: %{x}<br>Count: %{z}<extra></extra>',
                    showscale: true,
                  }]}
                  layout={{
                    height: 290,
                    title: { text: 'Regime Transition Counts', font: { size: 13, color: '#e5e7eb' }, x: 0.5 },
                    margin: { l: 90, r: 20, b: 70, t: 36 },
                    paper_bgcolor: '#0a0f19',
                    plot_bgcolor: '#0a0f19',
                    font: { color: '#d1d5db', size: 10 },
                    xaxis: { title: { text: 'To (Next Regime)', font: { size: 11 } }, tickangle: -20 },
                    yaxis: { title: { text: 'From (Current Regime)', font: { size: 11 } } },
                    annotations: tm.flatMap((row, ri) =>
                      row.map((val, ci) => ({
                        x: names[ci],
                        y: names[ri],
                        text: String(val),
                        showarrow: false,
                        font: { color: val > maxVal * 0.55 ? '#1a0a0a' : '#fef2f2', size: 12, family: 'monospace' },
                      }))
                    ),
                  }}
                  config={{ displaylogo: false, responsive: true }}
                  style={{ width: '100%' }}
                  useResizeHandler
                />
              );
            })() : (
              <div className="snapshot-placeholder">No transition matrix available.</div>
            )}
          </Panel>

          <Panel title="Regime Duration (Consecutive Days)" enableCopyPlot>
            {dataBundle ? (
              <Plot
                data={[
                  {
                    type: 'bar',
                    x: dataBundle.regimeNames,
                    y: dataBundle.regimeDurationStats.map((r) => r.mean),
                    name: 'Avg Run',
                    marker: { color: '#ef4444' },
                  },
                  {
                    type: 'bar',
                    x: dataBundle.regimeNames,
                    y: dataBundle.regimeDurationStats.map((r) => r.max),
                    name: 'Max Run',
                    marker: { color: '#fca5a5' },
                  },
                ]}
                layout={{
                  height: 280,
                  barmode: 'group',
                  title: { text: 'Regime Persistence (Avg vs Max Consecutive Days)', font: { size: 13, color: '#e5e7eb' }, x: 0.5 },
                  margin: { l: 56, r: 12, b: 72, t: 36 },
                  paper_bgcolor: '#0a0f19',
                  plot_bgcolor: '#0a0f19',
                  font: { color: '#d1d5db', size: 10 },
                  xaxis: { title: { text: 'Latent Regime', font: { size: 11 } }, tickangle: -20, gridcolor: '#1f2937' },
                  yaxis: { title: { text: 'Duration (Days)', font: { size: 11 } }, gridcolor: '#1f2937' },
                  legend: { orientation: 'h', y: 1.18 },
                }}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: '100%' }}
                useResizeHandler
              />
            ) : (
              <div className="snapshot-placeholder">No duration stats available.</div>
            )}
          </Panel>

          <Panel title="IV-RV Spread by Regime" enableCopyPlot>
            {dataBundle ? (
              <Plot
                data={dataBundle.spreadByRegime.map((arr, idx) => {
                  const reds = ['#7f1d1d', '#b91c1c', '#ef4444', '#f87171', '#fca5a5'];
                  const c = reds[idx % reds.length];
                  return {
                    type: 'box',
                    name: dataBundle.regimeNames[idx],
                    y: arr,
                    boxpoints: 'outliers',
                    marker: { color: c, size: 4 },
                    line: { color: c },
                    fillcolor: c + '44',
                  };
                })}
                layout={{
                  height: 290,
                  title: { text: 'IV − RV Spread Distribution by Regime', font: { size: 13, color: '#e5e7eb' }, x: 0.5 },
                  margin: { l: 56, r: 12, b: 72, t: 36 },
                  paper_bgcolor: '#0a0f19',
                  plot_bgcolor: '#0a0f19',
                  font: { color: '#d1d5db', size: 10 },
                  xaxis: { title: { text: 'Latent Regime', font: { size: 11 } }, tickangle: -18, gridcolor: '#1f2937' },
                  yaxis: { title: { text: 'IV − RV Spread', font: { size: 11 } }, gridcolor: '#1f2937', zeroline: true, zerolinecolor: '#94a3b8' },
                  showlegend: false,
                }}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: '100%' }}
                useResizeHandler
              />
            ) : (
              <div className="snapshot-placeholder">No spread distribution available.</div>
            )}
          </Panel>

          <Panel title="Regime Rotation Graph" enableCopyPlot>
            {rotationData ? (
              <Plot
                data={[
                  // Quadrant background shapes are added via layout.shapes
                  // Trail lines for each regime
                  ...rotationData.map((r) => ({
                    type: 'scatter',
                    mode: 'lines',
                    x: r.xTail,
                    y: r.yTail,
                    name: r.name + ' trail',
                    line: { color: r.color, width: 1.5, dash: 'dot' },
                    opacity: 0.5,
                    showlegend: false,
                    hoverinfo: 'skip',
                    cliponaxis: true,
                  })),
                  // Current position markers
                  ...rotationData.map((r) => ({
                    type: 'scatter',
                    mode: 'markers+text',
                    x: [r.xNow],
                    y: [r.yNow],
                    name: r.name,
                    text: [r.name],
                    textposition: 'top center',
                    textfont: { color: r.color, size: 10 },
                    marker: { color: r.color, size: 14, symbol: 'circle', line: { color: '#fff', width: 1.5 } },
                    cliponaxis: true,
                    hovertemplate: `<b>${r.name}</b><br>RS-Ratio: %{x:.1f}<br>RS-Momentum: %{y:.1f}<extra></extra>`,
                  })),
                  // Arrow-head for last segment of trail
                  ...rotationData.map((r) => {
                    const tLen = r.xTail.length;
                    if (tLen < 2) return null;
                    return {
                      type: 'scatter',
                      mode: 'markers',
                      x: [r.xTail[tLen - 2]],
                      y: [r.yTail[tLen - 2]],
                      marker: { color: r.color, size: 6, symbol: 'circle' },
                      showlegend: false,
                      hoverinfo: 'skip',
                      cliponaxis: true,
                    };
                  }).filter(Boolean),
                ]}
                layout={{
                  height: 400,
                  title: { text: 'Regime Rotation Graph (RRG)', font: { size: 13, color: '#e5e7eb' }, x: 0.5 },
                  margin: { l: 60, r: 20, b: 60, t: 40 },
                  paper_bgcolor: '#0a0f19',
                  plot_bgcolor: '#0a0f19',
                  font: { color: '#d1d5db', size: 10 },
                  xaxis: {
                    title: { text: 'RS-Ratio (Relative Strength)', font: { size: 11 } },
                    gridcolor: '#1e293b',
                    zeroline: false,
                    range: [50, 150],
                    dtick: 10,
                  },
                  yaxis: {
                    title: { text: 'RS-Momentum (Rate of Change)', font: { size: 11 } },
                    gridcolor: '#1e293b',
                    zeroline: false,
                    range: [50, 150],
                    dtick: 10,
                  },
                  shapes: [
                    // Quadrant background fills
                    // Leading (top-right) - green
                    { type: 'rect', x0: 100, x1: 150, y0: 100, y1: 150, xref: 'x', yref: 'y', fillcolor: 'rgba(34,197,94,0.08)', line: { width: 0 }, layer: 'below' },
                    // Improving (top-left) - blue
                    { type: 'rect', x0: 50, x1: 100, y0: 100, y1: 150, xref: 'x', yref: 'y', fillcolor: 'rgba(56,189,248,0.08)', line: { width: 0 }, layer: 'below' },
                    // Lagging (bottom-left) - red
                    { type: 'rect', x0: 50, x1: 100, y0: 50, y1: 100, xref: 'x', yref: 'y', fillcolor: 'rgba(239,68,68,0.08)', line: { width: 0 }, layer: 'below' },
                    // Weakening (bottom-right) - amber
                    { type: 'rect', x0: 100, x1: 150, y0: 50, y1: 100, xref: 'x', yref: 'y', fillcolor: 'rgba(245,158,11,0.08)', line: { width: 0 }, layer: 'below' },
                    // Vertical center line at 100
                    { type: 'line', x0: 100, x1: 100, y0: 50, y1: 150, xref: 'x', yref: 'y', line: { color: '#475569', width: 1.5, dash: 'dash' } },
                    // Horizontal center line at 100
                    { type: 'line', x0: 50, x1: 150, y0: 100, y1: 100, xref: 'x', yref: 'y', line: { color: '#475569', width: 1.5, dash: 'dash' } },
                  ],
                  annotations: [
                    { x: 0.95, y: 0.97, xref: 'paper', yref: 'paper', text: '<b>LEADING</b>', showarrow: false, font: { color: '#22c55e', size: 12 }, opacity: 0.6 },
                    { x: 0.05, y: 0.97, xref: 'paper', yref: 'paper', text: '<b>IMPROVING</b>', showarrow: false, font: { color: '#38bdf8', size: 12 }, opacity: 0.6 },
                    { x: 0.05, y: 0.03, xref: 'paper', yref: 'paper', text: '<b>LAGGING</b>', showarrow: false, font: { color: '#ef4444', size: 12 }, opacity: 0.6 },
                    { x: 0.95, y: 0.03, xref: 'paper', yref: 'paper', text: '<b>WEAKENING</b>', showarrow: false, font: { color: '#f59e0b', size: 12 }, opacity: 0.6 },
                  ],
                  legend: { orientation: 'h', y: -0.18 },
                }}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: '100%' }}
                useResizeHandler
              />
            ) : (
              <div className="snapshot-placeholder">Not enough data for regime rotation graph.</div>
            )}
          </Panel>

          <Panel title="Latent Regime Probability (Gaussian Mixture)" enableCopyPlot>
            {dataBundle ? (
              <>
                <Plot
                  data={gmmTraces}
                  layout={{
                    height: 250,
                    margin: { l: 44, r: 12, b: 32, t: 8 },
                    paper_bgcolor: '#0a0f19',
                    plot_bgcolor: '#0a0f19',
                    font: { color: '#d1d5db', size: 10 },
                    xaxis: { gridcolor: '#1f2937' },
                    yaxis: { title: 'Probability', gridcolor: '#1f2937', range: [0, 1] },
                    legend: { orientation: 'h', y: 1.13 },
                  }}
                  config={{ displaylogo: false, responsive: true }}
                  style={{ width: '100%' }}
                  useResizeHandler
                />
                <div className="regime-label-grid" style={{ marginTop: 6 }}>
                  {dataBundle.regimeNames.map((name, idx) => (
                    <div key={`${name}-${idx}`} className="regime-label-card">
                      <span>{`Component ${idx + 1}`}</span>
                      <strong>{name}</strong>
                      <span style={{ color: '#94a3b8', fontSize: '0.66rem' }}>
                        {`IV=${formatPct(dataBundle.regimeStats[idx]?.iv, 2)}, RV20=${formatPct(dataBundle.regimeStats[idx]?.rv20, 2)}, |ret|=${formatPct(dataBundle.regimeStats[idx]?.absRet, 2)}`}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="snapshot-placeholder">No GMM probabilities available.</div>
            )}
          </Panel>
        </div>

        <div className="regime-side-stack">
          <Panel title="Model Controls">
            <div className="filters-grid regime-filters-grid">
              <label>
                KNN Neighbors (k)
                <select value={neighbors} onChange={(e) => setNeighbors(Number(e.target.value))}>
                  {[3, 5, 7, 9, 11, 15].map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>
              <label>
                Cluster Count
                <select value={clusters} onChange={(e) => setClusters(Number(e.target.value))}>
                  {[2, 3, 4, 5].map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>
            </div>
          </Panel>

          <Panel title="Regime ML Snapshot">
            {dataBundle ? (
              <div className="kv-grid two-col compact">
                <div><span>Samples Used</span><strong>{dataBundle.rows.length}</strong></div>
                <div><span>KNN Accuracy</span><strong>{formatPct(dataBundle.confusion.acc, 2)}</strong></div>
                <div><span>Predicted Next Regime</span><strong style={{ color: dataBundle.latestPred === 'stress' ? '#ef4444' : dataBundle.latestPred === 'calm' ? '#22c55e' : '#f59e0b' }}>{dataBundle.latestPred}</strong></div>
                <div><span>Dominant Latent Regime</span><strong>{dataBundle.dominantRegimeName}</strong></div>
                <div><span>Current Rule Regime</span><strong>{dataBundle.yRule[dataBundle.yRule.length - 1]}</strong></div>
                <div><span>Avg RV20</span><strong>{formatNumber(dataBundle.rows.reduce((a, r) => a + r.rv20, 0) / dataBundle.rows.length, 4)}</strong></div>
                <div><span>Avg IV Proxy</span><strong>{formatNumber(dataBundle.rows.reduce((a, r) => a + r.iv, 0) / dataBundle.rows.length, 4)}</strong></div>
              </div>
            ) : (
              <div className="snapshot-placeholder">Run live fetch to populate ML metrics.</div>
            )}
          </Panel>

          <Panel title="KNN Confusion Matrix">
            {dataBundle ? (() => {
              const cm = dataBundle.confusion.matrix;
              const cls = dataBundle.classes;
              const maxVal = Math.max(...cm.flat(), 1);
              return (
                <Plot
                  data={[{
                    type: 'heatmap',
                    z: cm,
                    x: cls,
                    y: cls,
                    colorscale: 'YlOrRd',
                    hovertemplate: 'Actual: %{y}<br>Pred: %{x}<br>Count: %{z}<extra></extra>',
                  }]}
                  layout={{
                    height: 250,
                    title: { text: 'KNN Confusion Matrix', font: { size: 13, color: '#e5e7eb' }, x: 0.5 },
                    margin: { l: 60, r: 20, b: 40, t: 36 },
                    paper_bgcolor: '#0a0f19',
                    plot_bgcolor: '#0a0f19',
                    font: { color: '#d1d5db', size: 10 },
                    xaxis: { title: 'Predicted' },
                    yaxis: { title: 'Actual' },
                    annotations: cm.flatMap((row, ri) =>
                      row.map((val, ci) => ({
                        x: cls[ci],
                        y: cls[ri],
                        text: String(val),
                        showarrow: false,
                        font: { color: val > maxVal * 0.55 ? '#000' : '#e5e7eb', size: 13, family: 'monospace' },
                      }))
                    ),
                  }}
                  config={{ displaylogo: false, responsive: true }}
                  style={{ width: '100%' }}
                  useResizeHandler
                />
              );
            })() : (
              <div className="snapshot-placeholder">No confusion matrix available.</div>
            )}
          </Panel>

          <Panel title="Methodology">
            <ol className="method-list">
              <li>Build feature vectors from RV20, RV60, IV proxy, HV20, and absolute log-returns.</li>
              <li>Run K-Means for hard regime segmentation and visualize clusters in feature space.</li>
              <li>Run Gaussian Mixture (EM, diagonal covariance) for latent regime probabilities over time.</li>
              <li>Train KNN on historical rule-labeled regimes and estimate out-of-sample accuracy.</li>
              <li>Use predicted next regime with probability stack as regime decision support.</li>
            </ol>
          </Panel>
        </div>
      </div>
    </SnapshotGuard>
  );
}
