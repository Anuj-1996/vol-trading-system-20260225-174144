import React, { useState, useEffect } from 'react';
import Plot from 'react-plotly.js';
import { Panel, formatNumber } from './shared';
import { fetchDealerPositioning } from '../../api/client';

/* ─── Formatting helpers ─── */
const fmtCr = (v) => `₹${formatNumber(v / 1e7, 2)} Cr`;
const fmtLakh = (v) => `₹${formatNumber(v / 1e5, 1)} L`;
const shortNum = (v) => {
    const abs = Math.abs(v);
    if (abs >= 1e7) return fmtCr(v);
    if (abs >= 1e5) return fmtLakh(v);
    return `₹${formatNumber(v, 0)}`;
};

/* ─── Shared Plotly layout ─── */
const DARK_LAYOUT = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#d1d5db', family: 'Inter, system-ui, sans-serif', size: 11 },
    margin: { l: 60, r: 24, t: 36, b: 44 },
    xaxis: { gridcolor: '#1f2937', zerolinecolor: '#4b5563' },
    yaxis: { gridcolor: '#1f2937', zerolinecolor: '#4b5563' },
    showlegend: false,
    autosize: true,
};

const PLOT_CFG = { displayModeBar: false, responsive: true };

const spotLine = (spot) => ({
    type: 'line', x0: spot, x1: spot, y0: 0, y1: 1, yref: 'paper',
    line: { color: '#f59e0b', width: 2, dash: 'dot' },
});
const spotAnnotation = (spot) => ({
    x: spot, y: 1, yref: 'paper', text: 'Spot', showarrow: false,
    xanchor: 'left', xshift: 5, font: { color: '#f59e0b', size: 11 },
});
const flipLine = (flip) => flip ? ({
    type: 'line', x0: flip, x1: flip, y0: 0, y1: 1, yref: 'paper',
    line: { color: '#a855f7', width: 2, dash: 'dash' },
}) : null;
const flipAnnotation = (flip) => flip ? ({
    x: flip, y: 0.92, yref: 'paper', text: 'γ-Flip', showarrow: false,
    xanchor: 'left', xshift: 5, font: { color: '#a855f7', size: 11 },
}) : null;

/* ─── Color helpers ─── */
const bullBear = (v) => v >= 0 ? 'rgba(34,197,94,0.75)' : 'rgba(239,68,68,0.75)';
const bullBearSolid = (v) => v >= 0 ? '#22c55e' : '#ef4444';
const zoneColor = (z) => z === 'suppressed' ? 'rgba(34,197,94,0.5)' : z === 'expansion' ? 'rgba(239,68,68,0.5)' : 'rgba(107,114,128,0.25)';

/* ════════════════════════════════════════════════════════════════════════════ */

export default function DealerPositioningPage({ loading: globalLoading, liveDataId }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        async function loadData() {
            if (!liveDataId) return;
            setLoading(true);
            setError('');
            try {
                const res = await fetchDealerPositioning(liveDataId);
                if (res?.data) {
                    setData(res.data);
                } else {
                    setError('No data returned.');
                }
            } catch (err) {
                setError(err.message || 'Failed to fetch dealer positioning');
            } finally {
                setLoading(false);
            }
        }
        loadData();
    }, [liveDataId]);

    /* ── Guards ── */
    if (!liveDataId) {
        return (
            <div className="empty-state">
                <p>No active market data session.</p>
                <p style={{ fontSize: 14, color: '#888' }}>Click "Fetch Live &amp; Analyse" on the top right to begin.</p>
            </div>
        );
    }
    if (globalLoading || loading) {
        return <div className="loading-state">Loading Dealer Positioning…</div>;
    }
    if (error) {
        return <div className="error-box">{error}</div>;
    }
    if (!data) return null;

    /* ── Destructure API response ── */
    const {
        spot, metrics, walls, curves, snapshots,
        heatmap, vol_suppression, gamma_density, intraday_charm,
    } = data;

    const flipLevel = metrics?.gamma_flip_level;

    /* ──────────────────────  PLOT  DATA  ────────────────────── */

    // §1 — already rendered as cards

    // §2  GEX by Strike (bar)
    const gexTrace = [{
        x: curves.strikes,
        y: curves.gex,
        type: 'bar',
        name: 'Net GEX',
        marker: { color: curves.gex.map(bullBear) },
    }];

    // Cumulative GEX Profile (institutional-grade)
    const cumGex = [];
    let runningSum = 0;
    for (let i = 0; i < curves.gex.length; i++) {
        runningSum += curves.gex[i];
        cumGex.push(runningSum);
    }
    const cumGexTrace = [{
        x: curves.strikes,
        y: cumGex,
        type: 'scatter', mode: 'lines',
        name: 'Cumulative GEX',
        line: { color: '#f59e0b', width: 2.5 },
        fill: 'tozeroy',
        fillcolor: 'rgba(245,158,11,0.06)',
    }];

    // §3  Gamma Regime Curve (net GEX vs simulated spot)
    const gammaRegimeTrace = [{
        x: snapshots.hedge_flow_spot_range,
        y: snapshots.net_gamma_vs_spot,
        type: 'scatter', mode: 'lines',
        name: 'Total GEX',
        line: { color: '#8b5cf6', width: 2.5 },
        fill: 'tozeroy',
        fillcolor: 'rgba(139,92,246,0.08)',
    }];

    // §4  Gamma Surface Heatmap
    const heatmapTrace = heatmap ? [{
        z: heatmap.matrix,
        x: heatmap.strikes,
        y: heatmap.expiries,
        type: 'heatmap',
        colorscale: [
            [0, '#1e3a5f'], [0.25, '#155e75'], [0.5, '#0f766e'],
            [0.75, '#ca8a04'], [1, '#dc2626'],
        ],
        colorbar: { title: 'GEX', tickfont: { color: '#9ca3af' }, titlefont: { color: '#9ca3af' } },
    }] : [];

    // §5  Vanna Exposure (bar)
    const vexTrace = [{
        x: curves.strikes,
        y: curves.vex,
        type: 'bar',
        name: 'Net VEX',
        marker: { color: curves.vex.map(v => v >= 0 ? 'rgba(56,189,248,0.7)' : 'rgba(244,114,182,0.7)') },
    }];

    // §6  Charm Exposure (bar)
    const cexTrace = [{
        x: curves.strikes,
        y: curves.cex,
        type: 'bar',
        name: 'Net CEX',
        marker: { color: curves.cex.map(v => v >= 0 ? 'rgba(52,211,153,0.7)' : 'rgba(251,146,60,0.7)') },
    }];

    // §7  Dealer Hedge Flow (line — net delta vs spot)
    const hedgeTrace = [{
        x: snapshots.hedge_flow_spot_range,
        y: snapshots.hedge_flow,
        type: 'scatter', mode: 'lines',
        name: 'Net Delta',
        line: { color: '#3b82f6', width: 2.5 },
    }];

    // §9  Vol Suppression Map (colored bars)
    const volSuppTrace = vol_suppression ? [{
        x: vol_suppression.map(v => v.strike),
        y: vol_suppression.map(v => 1),
        type: 'bar',
        marker: { color: vol_suppression.map(v => zoneColor(v.zone)) },
        hovertext: vol_suppression.map(v => `Strike ${v.strike}\nGEX: ${shortNum(v.gex)}\nVEX: ${shortNum(v.vex)}\nZone: ${v.zone}`),
        hoverinfo: 'text',
    }] : [];

    // §10  Intraday Charm Flow (bar)
    const charmFlowTrace = intraday_charm ? [{
        x: intraday_charm.strikes,
        y: intraday_charm.delta_shift,
        type: 'bar',
        name: 'Delta Shift',
        marker: { color: intraday_charm.delta_shift.map(bullBear) },
    }] : [];

    // §11  Gamma Density Distribution (area)
    const gammaDensityTrace = gamma_density?.bin_centers?.length ? [{
        x: gamma_density.bin_centers,
        y: gamma_density.counts,
        type: 'scatter', mode: 'lines',
        fill: 'tozeroy',
        fillcolor: 'rgba(139,92,246,0.15)',
        line: { color: '#8b5cf6', width: 2, shape: 'spline' },
        name: 'GEX Density',
    }] : [];

    /* helper: shapes + annotations for GEX-style charts */
    const gexShapes = [spotLine(spot), flipLine(flipLevel)].filter(Boolean);
    const gexAnnotations = [spotAnnotation(spot), flipAnnotation(flipLevel)].filter(Boolean);
    const hedgeShapes = [spotLine(spot)];

    /* Gamma Regime shapes: spot + flip level (red) */
    const flipRedLine = flipLevel ? ({
        type: 'line', x0: flipLevel, x1: flipLevel, y0: 0, y1: 1, yref: 'paper',
        line: { color: '#ef4444', width: 2.5, dash: 'dash' },
    }) : null;
    const flipRedAnnotation = flipLevel ? ({
        x: flipLevel, y: 0.95, yref: 'paper', text: `γ-Flip ${formatNumber(flipLevel, 0)}`,
        showarrow: false, xanchor: 'left', xshift: 6,
        font: { color: '#ef4444', size: 11, weight: 700 },
    }) : null;
    const regimeShapes = [spotLine(spot), flipRedLine].filter(Boolean);
    const regimeAnnotations = [spotAnnotation(spot), flipRedAnnotation].filter(Boolean);

    /* ──────────────────────  RENDER  ────────────────────── */
    return (
        <div className="dealer-positioning-grid">

            {/* ═══ §1  MARKET SUMMARY ═══ */}
            <Panel title="Market Exposure Summary" className="dp-span-full">
                <div className="dp-metrics-row">
                    <MetricCard label="Regime" value={metrics.gamma_regime} color={bullBearSolid(metrics.total_gex)} />
                    <MetricCard label="Gamma Flip" value={flipLevel ?? '—'} sub={`Spot ≈ ${formatNumber(spot)}`} />
                    <MetricCard label="Total GEX" value={fmtCr(metrics.total_gex)} color={bullBearSolid(metrics.total_gex)} />
                    <MetricCard label="Total VEX" value={fmtCr(metrics.total_vex)} color={bullBearSolid(metrics.total_vex)} />
                    <MetricCard label="Total CEX" value={fmtCr(metrics.total_cex)} color={bullBearSolid(metrics.total_cex)} />
                </div>
            </Panel>

            {/* ═══ §2  GEX BY STRIKE ═══ */}
            <div className="dp-span-full">
                <Panel title="Gamma Exposure by Strike">
                    <div className="dp-chart-container">
                        <Plot
                            data={gexTrace}
                            layout={{
                                ...DARK_LAYOUT,
                                xaxis: { ...DARK_LAYOUT.xaxis, title: 'Strike' },
                                yaxis: { ...DARK_LAYOUT.yaxis, title: 'GEX (Notional ₹)' },
                                shapes: gexShapes,
                                annotations: gexAnnotations,
                            }}
                            useResizeHandler style={{ width: '100%', height: '100%' }} config={PLOT_CFG}
                        />
                    </div>
                </Panel>
            </div>

            {/* ═══ CUMULATIVE GEX PROFILE ═══ */}
            <div className="dp-span-full">
                <Panel title="Cumulative Gamma Profile">
                    <div className="dp-chart-container">
                        <Plot
                            data={cumGexTrace}
                            layout={{
                                ...DARK_LAYOUT,
                                xaxis: { ...DARK_LAYOUT.xaxis, title: 'Strike' },
                                yaxis: { ...DARK_LAYOUT.yaxis, title: 'Cumulative GEX (₹)' },
                                shapes: gexShapes,
                                annotations: gexAnnotations,
                            }}
                            useResizeHandler style={{ width: '100%', height: '100%' }} config={PLOT_CFG}
                        />
                    </div>
                </Panel>
            </div>

            {/* ═══ §5  VANNA EXPOSURE ═══ */}
            <Panel title="Vanna Exposure by Strike">
                <div className="dp-chart-container">
                    <Plot
                        data={vexTrace}
                        layout={{
                            ...DARK_LAYOUT,
                            xaxis: { ...DARK_LAYOUT.xaxis, title: 'Strike' },
                            yaxis: { ...DARK_LAYOUT.yaxis, title: 'VEX (Notional ₹)' },
                            shapes: [spotLine(spot)],
                            annotations: [spotAnnotation(spot)],
                        }}
                        useResizeHandler style={{ width: '100%', height: '100%' }} config={PLOT_CFG}
                    />
                </div>
            </Panel>

            {/* ═══ §6  CHARM EXPOSURE ═══ */}
            <Panel title="Charm Exposure by Strike">
                <div className="dp-chart-container">
                    <Plot
                        data={cexTrace}
                        layout={{
                            ...DARK_LAYOUT,
                            xaxis: { ...DARK_LAYOUT.xaxis, title: 'Strike' },
                            yaxis: { ...DARK_LAYOUT.yaxis, title: 'CEX (Notional ₹)' },
                            shapes: [spotLine(spot)],
                            annotations: [spotAnnotation(spot)],
                        }}
                        useResizeHandler style={{ width: '100%', height: '100%' }} config={PLOT_CFG}
                    />
                </div>
            </Panel>

            {/* ═══ §3  GAMMA REGIME CURVE ═══ */}
            <Panel title="Gamma Regime Curve (GEX vs Spot)">
                <div className="dp-chart-container">
                    <Plot
                        data={gammaRegimeTrace}
                        layout={{
                            ...DARK_LAYOUT,
                            xaxis: { ...DARK_LAYOUT.xaxis, title: 'Simulated Spot' },
                            yaxis: { ...DARK_LAYOUT.yaxis, title: 'Total GEX' },
                            shapes: regimeShapes,
                            annotations: regimeAnnotations,
                        }}
                        useResizeHandler style={{ width: '100%', height: '100%' }} config={PLOT_CFG}
                    />
                </div>
            </Panel>

            {/* ═══ §7  DEALER HEDGE FLOW ═══ */}
            <Panel title="Dealer Hedge Flow vs Price">
                <div className="dp-chart-container">
                    <Plot
                        data={hedgeTrace}
                        layout={{
                            ...DARK_LAYOUT,
                            xaxis: { ...DARK_LAYOUT.xaxis, title: 'Spot Price' },
                            yaxis: { ...DARK_LAYOUT.yaxis, title: 'Net Delta (₹)' },
                            shapes: hedgeShapes,
                            annotations: [spotAnnotation(spot)],
                        }}
                        useResizeHandler style={{ width: '100%', height: '100%' }} config={PLOT_CFG}
                    />
                </div>
            </Panel>

            {/* ═══ §4  GAMMA SURFACE HEATMAP ═══ */}
            {heatmap?.matrix?.length > 0 && (
                <div className="dp-span-full">
                    <Panel title="Gamma Surface (Strike × Expiry)">
                        <div className="dp-chart-container" style={{ height: Math.max(260, heatmap.expiries.length * 60 + 80) }}>
                            <Plot
                                data={heatmapTrace}
                                layout={{
                                    ...DARK_LAYOUT,
                                    xaxis: { ...DARK_LAYOUT.xaxis, title: 'Strike' },
                                    yaxis: { ...DARK_LAYOUT.yaxis, title: 'Expiry', type: 'category' },
                                }}
                                useResizeHandler style={{ width: '100%', height: '100%' }} config={PLOT_CFG}
                            />
                        </div>
                    </Panel>
                </div>
            )}

            {/* ═══ §8  GAMMA WALL TABLE ═══ */}
            <Panel title="Gamma Walls (Support / Resistance)">
                <table className="data-table" style={{ width: '100%' }}>
                    <thead>
                        <tr><th>Type</th><th>Strike</th><th>GEX (Cr)</th></tr>
                    </thead>
                    <tbody>
                        {walls?.map((w, i) => (
                            <tr key={i}>
                                <td>
                                    <span style={{
                                        padding: '2px 8px', borderRadius: 4, fontSize: 11,
                                        backgroundColor: w.type.includes('Call') ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                                        color: w.type.includes('Call') ? '#22c55e' : '#ef4444',
                                    }}>{w.type}</span>
                                </td>
                                <td>{formatNumber(w.strike)}</td>
                                <td style={{ color: bullBearSolid(w.gex) }}>{fmtCr(w.gex)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </Panel>

            {/* ═══ §9  VOL SUPPRESSION MAP ═══ */}
            {vol_suppression?.length > 0 && (
                <Panel title="Volatility Suppression Map">
                    <div className="dp-chart-container">
                        <Plot
                            data={volSuppTrace}
                            layout={{
                                ...DARK_LAYOUT,
                                xaxis: { ...DARK_LAYOUT.xaxis, title: 'Strike' },
                                yaxis: { ...DARK_LAYOUT.yaxis, visible: false },
                                bargap: 0,
                                annotations: [{
                                    x: 0.02, y: 1.08, xref: 'paper', yref: 'paper', showarrow: false,
                                    text: '<span style="color:#22c55e">■</span> Suppressed  <span style="color:#ef4444">■</span> Expansion  <span style="color:#6b7280">■</span> Neutral',
                                    font: { size: 11, color: '#9ca3af' },
                                }],
                            }}
                            useResizeHandler style={{ width: '100%', height: '100%' }} config={PLOT_CFG}
                        />
                    </div>
                </Panel>
            )}

            {/* ═══ §10  INTRADAY CHARM FLOW ═══ */}
            {intraday_charm?.strikes?.length > 0 && (
                <Panel title="Intraday Charm Flow (Delta Shift T→T−1d)">
                    <div className="dp-chart-container">
                        <Plot
                            data={charmFlowTrace}
                            layout={{
                                ...DARK_LAYOUT,
                                xaxis: { ...DARK_LAYOUT.xaxis, title: 'Strike' },
                                yaxis: { ...DARK_LAYOUT.yaxis, title: 'Delta Shift (₹)' },
                                shapes: [spotLine(spot)],
                                annotations: [spotAnnotation(spot)],
                            }}
                            useResizeHandler style={{ width: '100%', height: '100%' }} config={PLOT_CFG}
                        />
                    </div>
                </Panel>
            )}

            {/* ═══ §11  GAMMA DENSITY ═══ */}
            {gammaDensityTrace.length > 0 && (
                <Panel title="Gamma Profile Distribution (Density)">
                    <div className="dp-chart-container">
                        <Plot
                            data={gammaDensityTrace}
                            layout={{
                                ...DARK_LAYOUT,
                                xaxis: { ...DARK_LAYOUT.xaxis, title: 'GEX Value' },
                                yaxis: { ...DARK_LAYOUT.yaxis, title: 'Count' },
                            }}
                            useResizeHandler style={{ width: '100%', height: '100%' }} config={PLOT_CFG}
                        />
                    </div>
                </Panel>
            )}
        </div>
    );
}

/* ─── Small metric card component ─── */
function MetricCard({ label, value, color, sub }) {
    return (
        <div className="dp-metric-card">
            <span className="dp-metric-label">{label}</span>
            <strong className="dp-metric-value" style={color ? { color } : undefined}>{value}</strong>
            {sub && <span className="dp-metric-sub">{sub}</span>}
        </div>
    );
}
