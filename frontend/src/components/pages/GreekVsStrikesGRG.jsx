
import React, { useMemo, useState } from 'react';
import Plot from '../ThemedPlot';
import { Panel } from './shared.jsx';

const GREEK_KEYS = ['iv', 'delta', 'gamma', 'theta', 'vega'];
const GREEK_LABELS = { iv: 'IV', delta: 'Delta', gamma: 'Gamma', theta: 'Theta', vega: 'Vega' };

export default function GreekVsStrikesGRG({
  sortedStrikes,
  atmIdx,
  atmStrike,
  maturityGrid,
  expiryList,
  marketMatrix,
  sortedIndices,
  spot,
  bsmGreeks,
  grgOptionType: initialOptionType,
}) {
  const [selectedGreek, setSelectedGreek] = useState('vega');
  const [optionType, setOptionType] = useState(initialOptionType || 'call');
  const [expiryIdx, setExpiryIdx] = useState(maturityGrid.length - 1);

  // Compute RS-Ratio for all strikes at the latest expiry
  const { rsRatios, strikes, atmValue } = useMemo(() => {
    const ei = expiryIdx;
    const T_yr = Number(maturityGrid[ei]);
    const ratios = [];
    let atmGreek = null;
    const missingIVs = [];
    for (let i = 0; i < sortedStrikes.length; ++i) {
      const K = sortedStrikes[i];
      const iv = Number(marketMatrix[ei]?.[sortedIndices[i]?.i] ?? 0);
      if (!(T_yr > 0) || !(iv > 0) || !K) {
        missingIVs.push({strike: K, idx: i, iv});
        ratios.push(null);
        continue;
      }
      const g = bsmGreeks(spot, K, T_yr, iv, 0.06, optionType === 'call');
      if (!g) {
        missingIVs.push({strike: K, idx: i, iv});
        ratios.push(null);
        continue;
      }
      if (i === atmIdx) atmGreek = g[selectedGreek];
      ratios.push(g[selectedGreek]);
    }
    if (typeof window !== 'undefined' && missingIVs.length > 0) {
      // eslint-disable-next-line no-console
      console.log('[GRS] Missing or invalid IV for strikes (latest expiry):', missingIVs);
    }
    // Protect ATM denominator
    const minATM = 1e-6;
    const safeATM = (atmGreek && Math.abs(atmGreek) > minATM) ? atmGreek : (atmGreek < 0 ? -minATM : minATM);
    // Compute RS-Ratio and clip to [0,200]
    const rs = ratios.map((v) => (safeATM && v != null) ? Math.max(0, Math.min((v / safeATM) * 100, 200)) : null);
    return { rsRatios: rs, strikes: sortedStrikes, atmValue: atmGreek };
  }, [selectedGreek, sortedStrikes, atmIdx, maturityGrid, marketMatrix, sortedIndices, spot, bsmGreeks, optionType]);

  // Compute RS-Momentum (change in RS-Ratio across strikes)
  const rsMomentum = useMemo(() => {
    const mom = rsRatios.map((v, i, arr) => {
      if (i === 0 || arr[i - 1] == null || v == null) return 100;
      let m = 100 + (v - arr[i - 1]);
      // Clip RS-Momentum to [70,120]
      m = Math.max(70, Math.min(m, 120));
      return m;
    });
    return mom;
  }, [rsRatios]);

  // Prepare plot data with ATM-relative labels, color, and marker size
  const points = strikes.map((strike, i) => {
    if (rsRatios[i] == null || rsMomentum[i] == null) return null;
    let dist = i - atmIdx;
    let label = '0';
    if (dist < 0) label = `${dist}`;
    else if (dist > 0) label = `+${dist}`;
    // Clamp RS-Ratio to 200
    const xVal = Math.min(rsRatios[i], 200);
    // Color gradient: ITM=light blue, ATM=white, OTM=yellow/orange/red
    let color = '#fff';
    if (dist === 0) color = '#fff';
    else if (dist < 0) color = '#38bdf8'; // light blue for ITM
    else if (dist > 0 && Math.abs(dist) <= 5) color = '#ffe066';
    else if (dist > 0 && Math.abs(dist) <= 15) color = '#ffb347';
    else if (dist > 0) color = '#ff7043';
    // Marker size: ATM=10, others=6
    const size = dist === 0 ? 10 : 6;
    // Only show text for ATM and ±5, ±10, ±15, ±20, ±25, ±30
    const showText = dist === 0 || [5,10,15,20,25,30].includes(Math.abs(dist));
    return {
      x: xVal,
      y: rsMomentum[i],
      text: showText ? label : '',
      hovertext: label,
      marker: { color, size, opacity: 0.6, line: { color: '#fff', width: dist === 0 ? 2 : 1 } },
      dist,
    };
  }).filter(Boolean);

  const xR = points.length ? [Math.min(100, ...points.map(p => p.x)), Math.max(100, ...points.map(p => p.x))] : [90, 110];
  const yR = points.length ? [Math.min(100, ...points.map(p => p.y)), Math.max(100, ...points.map(p => p.y))] : [90, 110];
  const _xp = Math.max(8, (xR[1] - xR[0]) * 0.22);
  const _yp = Math.max(8, (yR[1] - yR[0]) * 0.22);
  const xRange = [xR[0] - _xp, xR[1] + _xp];
  const yRange = [yR[0] - _yp, yR[1] + _yp];

  // For axis-aligned quadrants, use the actual axis range for shapes
  const xMin = 0; // matches xaxis: { range: [0, 200] }
  const xMax = 200;
  const yMin = 70; // matches yaxis: { range: [70, 120] }
  const yMax = 120;

  return (
    <Panel title="Greek Rotation by Strike (GRS)">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <label style={{ color: '#9ca3af', fontSize: 12 }}>
          Option Type
          <select
            value={optionType}
            onChange={e => setOptionType(e.target.value)}
            style={{ marginLeft: 6, background: '#1f2937', color: '#d1d5db', border: '1px solid #374151', borderRadius: 4, padding: '2px 6px' }}
          >
            <option value="call">Call</option>
            <option value="put">Put</option>
          </select>
        </label>
        <label style={{ color: '#9ca3af', fontSize: 12 }}>
          Expiry
          <select
            value={expiryIdx}
            onChange={e => setExpiryIdx(Number(e.target.value))}
            style={{ marginLeft: 6, background: '#1f2937', color: '#d1d5db', border: '1px solid #374151', borderRadius: 4, padding: '2px 6px' }}
          >
            {expiryList.map((label, idx) => (
              <option key={idx} value={idx}>{label}</option>
            ))}
          </select>
        </label>
        <label style={{ color: '#9ca3af', fontSize: 12 }}>
          Greek
          <select
            value={selectedGreek}
            onChange={e => setSelectedGreek(e.target.value)}
            style={{ marginLeft: 6, background: '#1f2937', color: '#d1d5db', border: '1px solid #374151', borderRadius: 4, padding: '2px 6px' }}
          >
            {GREEK_KEYS.map(k => (
              <option key={k} value={k}>{GREEK_LABELS[k]}</option>
            ))}
          </select>
        </label>
      </div>
      <Plot
        data={[
          // Quadrant background shapes and axis lines
          { type:'scatter', mode:'lines', x:[xRange[0],xRange[1]], y:[100,100], line:{color:'#374151',width:1,dash:'dash'}, showlegend:false, hoverinfo:'skip' },
          { type:'scatter', mode:'lines', x:[100,100], y:[yRange[0],yRange[1]], line:{color:'#374151',width:1,dash:'dash'}, showlegend:false, hoverinfo:'skip' },
          {
            type: 'scatter',
            mode: 'lines+markers+text',
            x: points.map(p => p.x),
            y: points.map(p => p.y),
            text: points.map(p => p.text),
            textposition: 'top center',
            textfont: { size: 10, color: '#fff' },
            marker: {
              color: points.map(p => p.marker.color),
              size: points.map(p => p.marker.size),
              opacity: points.map(p => p.marker.opacity),
              line: points.map(p => p.marker.line),
            },
            line: { color: '#f59e0b', width: 1.5 },
            showlegend: false,
            hovertemplate: 'Strike: %{hovertext}<br>RS-Ratio: %{x:.1f}<br>RS-Mom: %{y:.1f}<extra></extra>',
          },
        ]}
        layout={{
          height: 420,
          margin: { l: 58, r: 20, b: 48, t: 32 },
          paper_bgcolor: '#0a0f19',
          plot_bgcolor: '#0a0f19',
          font: { color: '#d1d5db', size: 11 },
          title: { text: `${GREEK_LABELS[selectedGreek]}-GRS`, font: { size: 13, color: '#d1d5db' }, x: 0.5 },
          xaxis: { title: { text: 'RS-Ratio (Greek vs ATM, 100 = parity)', font: { color: '#fff', size: 14 } }, gridcolor: '#1f2937', range: [0, 200], zeroline: false },
          yaxis: { title: { text: 'RS-Momentum (Change across strikes, 100 = flat)', font: { color: '#fff', size: 14 } }, gridcolor: '#1f2937', range: [70, 120], zeroline: false },
          shapes:[
            // Top-left (Improving)
            { type:'rect', xref:'x', yref:'y', x0:xMin, x1:100, y0:100, y1:yMax, fillcolor:'rgba(56,189,248,0.06)', line:{width:0} },
            // Top-right (Leading)
            { type:'rect', xref:'x', yref:'y', x0:100, x1:xMax, y0:100, y1:yMax, fillcolor:'rgba(34,197,94,0.06)', line:{width:0} },
            // Bottom-right (Weakening)
            { type:'rect', xref:'x', yref:'y', x0:100, x1:xMax, y0:yMin, y1:100, fillcolor:'rgba(251,191,36,0.06)', line:{width:0} },
            // Bottom-left (Lagging)
            { type:'rect', xref:'x', yref:'y', x0:xMin, x1:100, y0:yMin, y1:100, fillcolor:'rgba(239,68,68,0.06)', line:{width:0} },
          ],
          annotations:[
            { xref:'paper', yref:'paper', x:0.02, y:0.97, text:'IMPROVING', showarrow:false, font:{color:'#38bdf8',size:11}, xanchor:'left' },
            { xref:'paper', yref:'paper', x:0.98, y:0.97, text:'LEADING',   showarrow:false, font:{color:'#22c55e',size:11}, xanchor:'right' },
            { xref:'paper', yref:'paper', x:0.98, y:0.03, text:'WEAKENING', showarrow:false, font:{color:'#f59e0b',size:11}, xanchor:'right' },
            { xref:'paper', yref:'paper', x:0.02, y:0.03, text:'LAGGING',   showarrow:false, font:{color:'#ef4444',size:11}, xanchor:'left' },
          ],
          showlegend: false,
          uirevision: 'grg-vs-strikes',
        }}
        config={{ displaylogo: false, responsive: true }}
        style={{ width: '100%' }}
        useResizeHandler
      />
    </Panel>
  );
}
