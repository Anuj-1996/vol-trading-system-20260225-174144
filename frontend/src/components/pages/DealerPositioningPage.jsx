import React, { useState, useEffect, useRef } from 'react';
import Plot from 'react-plotly.js';
import { Panel, formatNumber } from './shared';
import { fetchDealerPositioning, aiChatStream } from '../../api/client';

/* ─── Formatting helpers ─── */
const fmtCr = (v) => `₹${formatNumber(v / 1e7, 2)} Cr`;
const fmtLakh = (v) => `₹${formatNumber(v / 1e5, 1)} L`;
const shortNum = (v) => {
    const abs = Math.abs(v);
    if (abs >= 1e7) return fmtCr(v);
    if (abs >= 1e5) return fmtLakh(v);
    return `₹${formatNumber(v, 0)}`;
};

function formatMarkdown(text) {
    if (!text) return '';
    let html = text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^### (.+)$/gm, '<h4 style="margin: 12px 0 6px; color: #fff;">$1</h4>')
        .replace(/^## (.+)$/gm, '<h3 style="margin: 16px 0 8px; color: #fff;">$1</h3>')
        .replace(/^# (.+)$/gm, '<h2 style="margin: 20px 0 10px; color: #fff;">$1</h2>')
        .replace(/^- (.+)$/gm, '<li style="margin-left: 20px;">$1</li>')
        .replace(/^(\d+)\. (.+)$/gm, '<li style="margin-left: 20px;">$2</li>')
        .replace(/\n{2,}/g, '</p><p style="margin-bottom: 8px;">')
        .replace(/\n/g, '<br/>');
    return `<p style="margin-bottom: 8px;">${html}</p>`;
}

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
    const [camera, setCamera] = useState({ eye: { x: 1.25, y: 1.25, z: 1.25 } });

    // AI Analyst State
    const [aiThinking, setAiThinking] = useState(false);
    const [aiOutput, setAiOutput] = useState('');
    const [showAiResult, setShowAiResult] = useState(true);
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

    const runAiAnalyst = async () => {
        if (!data) return;
        setAiOutput('');
        setAiThinking(true);
        setShowAiResult(true); // Auto-show on new analysis
        console.log("Starting AI Analysis for Dealer Positioning...");
        try {
            // Context payload for AI
            const contextPayload = {
                market_overview: {
                    spot: data.spot,
                    metrics: data.metrics,
                    walls: data.walls,
                    realized_implied_spread: data.metrics.vrp, // Assuming VRP passed here
                    gamma_clusters: data.gamma_clusters
                },
                surface: data.heatmap,
            };

            await aiChatStream(
                "Perform full dealer positioning analysis.",
                "dealer_positioning",
                contextPayload,
                (chunk) => {
                    if (chunk.text) setAiOutput(chunk.text);
                    if (chunk.done) {
                        setAiThinking(false);
                        console.log("AI Analysis completed.");
                    }
                },
                "gemma3:4b"  // Changed from gemma3:2b which doesn't exist to gemma3:4b which is available
            );
        } catch (err) {
            console.error("AI Analysis Error:", err);
            setAiOutput(`Error: ${err.message}`);
            setAiThinking(false);
        }
    };

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
        gamma_clusters
    } = data;

    const flipLevel = metrics?.gamma_flip_level;

    /* ──────────────────────  PLOT  DATA  ────────────────────── */

    // §2  GEX by Strike (bar)
    const gexTrace = [{
        x: curves.strikes,
        y: curves.gex,
        type: 'bar',
        name: 'Net GEX',
        marker: { color: curves.gex.map(bullBear) },
    }];

    // §2.1 KNN Cluster Plot
    const clusterTrace = gamma_clusters?.length ? [{
        x: gamma_clusters.map(c => c.center_strike),
        y: gamma_clusters.map(c => c.total_gex),
        type: 'scatter',
        mode: 'markers+text',
        text: gamma_clusters.map(c => `Wall@${Math.round(c.center_strike)}`),
        textposition: 'top center',
        marker: {
            size: gamma_clusters.map(c => Math.sqrt(Math.abs(c.total_gex / 1e7)) * 2 + 10),
            color: gamma_clusters.map(c => bullBearSolid(c.total_gex)),
            opacity: 0.8
        },
        name: 'Gamma Clusters'
    }] : [];

    // Cumulative GEX Profile
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

    // §3  Gamma Regime Curve
    const gammaRegimeTrace = [{
        x: snapshots.hedge_flow_spot_range,
        y: snapshots.net_gamma_vs_spot,
        type: 'scatter', mode: 'lines',
        name: 'Total GEX',
        line: { color: '#8b5cf6', width: 2.5 },
        fill: 'tozeroy',
        fillcolor: 'rgba(139,92,246,0.08)',
    }];

    // §4  3D Gamma Surface
    const surfaceTrace = heatmap ? [{
        type: 'surface',
        z: heatmap.matrix,
        x: heatmap.strikes,
        y: heatmap.expiries,
        colorscale: 'RdBu',
        reversescale: true,
        colorbar: { title: 'GEX', tickfont: { color: '#9ca3af' } },
    }] : [];

    // §5  Vanna Exposure
    const vexTrace = [{
        x: curves.strikes,
        y: curves.vex,
        type: 'bar',
        name: 'Net VEX',
        marker: { color: curves.vex.map(v => v >= 0 ? 'rgba(56,189,248,0.7)' : 'rgba(244,114,182,0.7)') },
    }];

    // §6  Charm Exposure
    const cexTrace = [{
        x: curves.strikes,
        y: curves.cex,
        type: 'bar',
        name: 'Net CEX',
        marker: { color: curves.cex.map(v => v >= 0 ? 'rgba(52,211,153,0.7)' : 'rgba(251,146,60,0.7)') },
    }];

    // §7  Dealer Hedge Flow
    const hedgeTrace = [{
        x: snapshots.hedge_flow_spot_range,
        y: snapshots.hedge_flow,
        type: 'scatter', mode: 'lines',
        name: 'Net Delta',
        line: { color: '#3b82f6', width: 2.5 },
    }];

    // §9  Vol Suppression Map
    const volSuppTrace = vol_suppression ? [{
        x: vol_suppression.map(v => v.strike),
        y: vol_suppression.map(v => 1),
        type: 'bar',
        marker: { color: vol_suppression.map(v => zoneColor(v.zone)) },
        hovertext: vol_suppression.map(v => `Strike ${v.strike}\nGEX: ${shortNum(v.gex)}\nVEX: ${shortNum(v.vex)}\nZone: ${v.zone}`),
        hoverinfo: 'text',
    }] : [];

    // §10  Intraday Charm Flow
    const charmFlowTrace = intraday_charm ? [{
        x: intraday_charm.strikes,
        y: intraday_charm.delta_shift,
        type: 'bar',
        name: 'Delta Shift',
        marker: { color: intraday_charm.delta_shift.map(bullBear) },
    }] : [];

    // §11  Gamma Density Distribution
    const gammaDensityTrace = gamma_density?.bin_centers?.length ? [{
        x: gamma_density.bin_centers,
        y: gamma_density.counts,
        type: 'scatter', mode: 'lines',
        fill: 'tozeroy',
        fillcolor: 'rgba(139,92,246,0.15)',
        line: { color: '#8b5cf6', width: 2, shape: 'spline' },
        name: 'GEX Density',
    }] : [];

    const gexShapes = [spotLine(spot), flipLine(flipLevel)].filter(Boolean);
    const gexAnnotations = [spotAnnotation(spot), flipAnnotation(flipLevel)].filter(Boolean);
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

            {/* AI ANALYST BUTTON */}
            <div className="dp-span-full" style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                {(aiOutput || aiThinking) && (
                    <button
                        className="btn btn-secondary"
                        onClick={() => setShowAiResult(!showAiResult)}
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                        {showAiResult ? 'Hide Analysis' : 'Show Analysis'}
                    </button>
                )}
                <button
                    className={`btn ${aiThinking ? 'btn-loading' : 'btn-primary'}`}
                    onClick={runAiAnalyst}
                    disabled={aiThinking}
                >
                    {aiThinking ? 'Analysing...' : 'Analyse'}
                </button>
            </div>

            {/* AI RESULT PANEL */}
            {(aiThinking || aiOutput) && showAiResult && (
                <div className="dp-span-full">
                    <Panel title="Gemma3 AI Portfolio & Positioning Insight" className="ai-analyst-panel">
                        <div
                            className="ai-output-area ai-msg-markdown"
                            style={{
                                padding: 16,
                                backgroundColor: 'rgba(0,0,0,0.2)',
                                borderRadius: 8,
                                minHeight: 120,
                                fontFamily: 'Inter, sans-serif',
                                lineHeight: 1.6,
                                fontSize: 14,
                                color: '#e5e7eb'
                            }}
                            dangerouslySetInnerHTML={{ __html: aiOutput ? formatMarkdown(aiOutput) : 'Preparing analysis pipeline...' }}
                        />
                    </Panel>
                </div>
            )}

            {/* ═══ §1  MARKET SUMMARY ═══ */}
            <Panel title="Market Exposure Summary" className="dp-span-full">
                <div className="dp-metrics-row">
                    <MetricCard label="Regime" value={metrics.gamma_regime} color={bullBearSolid(metrics.total_gex)} />
                    <MetricCard label="Gamma Flip" value={flipLevel ? formatNumber(flipLevel, 0) : 'Far OTM/ITM'} sub={`Spot ≈ ${formatNumber(spot)}`} />
                    <MetricCard label="ATM IV" value={`${formatNumber(metrics.iv, 2)}%`} sub={`RV: ${formatNumber(metrics.rv, 2)}%`} />
                    <MetricCard label="Total GEX" value={fmtCr(metrics.total_gex)} color={bullBearSolid(metrics.total_gex)} />
                    <MetricCard label="Total VEX" value={fmtCr(metrics.total_vex)} color={bullBearSolid(metrics.total_vex)} />
                    <MetricCard label="Total CEX" value={fmtCr(metrics.total_cex)} color={bullBearSolid(metrics.total_cex)} />
                </div>
            </Panel>

            {/* ═══ §2  GEX BY STRIKE ═══ */}
            <div className="dp-span-half">
                <Panel title="Gamma Exposure by Strike">
                    <div className="dp-chart-container">
                        <Plot
                            data={gexTrace}
                            layout={{
                                ...DARK_LAYOUT,
                                xaxis: { ...DARK_LAYOUT.xaxis, title: 'Strike' },
                                yaxis: { ...DARK_LAYOUT.yaxis, title: 'GEX (₹)' },
                                shapes: gexShapes,
                                annotations: gexAnnotations,
                            }}
                            useResizeHandler style={{ width: '100%', height: '100%' }} config={PLOT_CFG}
                        />
                    </div>
                </Panel>
            </div>

            {/* ═══ KNN CLUSTERS ═══ */}
            <div className="dp-span-half">
                <Panel title="Gamma Clusters (Institutional Walls)">
                    <div className="dp-chart-container">
                        <Plot
                            data={clusterTrace}
                            layout={{
                                ...DARK_LAYOUT,
                                xaxis: { ...DARK_LAYOUT.xaxis, title: 'Strike' },
                                yaxis: { ...DARK_LAYOUT.yaxis, title: 'Total GEX Cluster' },
                                shapes: [spotLine(spot)],
                                annotations: [spotAnnotation(spot)],
                            }}
                            useResizeHandler style={{ width: '100%', height: '100%' }} config={PLOT_CFG}
                        />
                    </div>
                </Panel>
            </div>

            {/* ═══ §4  3D GAMMA SURFACE ═══ */}
            {heatmap?.matrix?.length > 0 && (
                <div className="dp-span-full">
                    <Panel title="3D Gamma Surface (Strike × Expiry × GEX)">
                        <div className="dp-chart-container" style={{ height: 450 }}>
                            <Plot
                                data={surfaceTrace}
                                layout={{
                                    ...DARK_LAYOUT,
                                    scene: {
                                        xaxis: { title: 'Strike', gridcolor: '#1f2937' },
                                        yaxis: { title: 'Expiry', gridcolor: '#1f2937' },
                                        zaxis: { title: 'GEX', gridcolor: '#1f2937' },
                                        camera: camera,
                                    },
                                    margin: { l: 0, r: 0, t: 0, b: 0 },
                                }}
                                onRelayout={(e) => {
                                    if (e['scene.camera']) setCamera(e['scene.camera']);
                                }}
                                useResizeHandler style={{ width: '100%', height: '100%' }}
                                config={{ ...PLOT_CFG, displayModeBar: true }}
                            />
                        </div>
                    </Panel>
                </div>
            )}

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
                            yaxis: { ...DARK_LAYOUT.yaxis, title: 'VEX (₹)' },
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
                            yaxis: { ...DARK_LAYOUT.yaxis, title: 'CEX (₹)' },
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
                            shapes: [spotLine(spot)],
                            annotations: [spotAnnotation(spot)],
                        }}
                        useResizeHandler style={{ width: '100%', height: '100%' }} config={PLOT_CFG}
                    />
                </div>
            </Panel>

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

            {/* ═══ §10 INTRADAY CHARM FLOW ═══ */}
            <Panel title="Intraday Charm Flow">
                <div className="dp-chart-container">
                    <Plot
                        data={charmFlowTrace}
                        layout={{
                            ...DARK_LAYOUT,
                            xaxis: { ...DARK_LAYOUT.xaxis, title: 'Strike' },
                            yaxis: { ...DARK_LAYOUT.yaxis, title: 'Delta Shift' },
                            shapes: [spotLine(spot)],
                            annotations: [spotAnnotation(spot)],
                        }}
                        useResizeHandler style={{ width: '100%', height: '100%' }} config={PLOT_CFG}
                    />
                </div>
            </Panel>

            {/* ═══ §11 GAMMA DENSITY ═══ */}
            <Panel title="Gamma Profile Distribution">
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
        </div>
    );
}

function MetricCard({ label, value, color, sub }) {
    return (
        <div className="dp-metric-card">
            <span className="dp-metric-label">{label}</span>
            <strong className="dp-metric-value" style={color ? { color } : undefined}>{value}</strong>
            {sub && <span className="dp-metric-sub">{sub}</span>}
        </div>
    );
}
