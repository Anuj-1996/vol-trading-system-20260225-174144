import React, { useMemo } from 'react';
import Plot from 'react-plotly.js';

/**
 * Volatility Drift Map (2D Heatmap)
 * Shows how implied volatility changes when the underlying price moves.
 * X: Spot Move (%), Y: Strike Price, Color: Change in IV.
 */
export const VolDriftMap = ({
    strikes = [],
    spotMoves = [], // Percentage moves, e.g., [-3, -2, -1, 0, 1, 2, 3]
    driftMatrix = [], // 2D array representing change in IV (y=strike, x=spotMove)
    title = 'Volatility Drift Map',
    height = 500,
}) => {
    const plotData = useMemo(() => {
        return [
            {
                z: driftMatrix,
                x: spotMoves,
                y: strikes,
                type: 'heatmap',
                colorscale: 'Spectral',
                reversescale: true,
                colorbar: {
                    title: 'Δ IV (%)',
                    titleside: 'right',
                    thickness: 15,
                },
                hovertemplate:
                    '<b>Spot Move:</b> %{x}%<br>' +
                    '<b>Strike:</b> %{y}<br>' +
                    '<b>IV Change:</b> %{z:+.2f}%<extra></extra>',
            },
        ];
    }, [strikes, spotMoves, driftMatrix]);

    const layout = useMemo(() => {
        return {
            title: { text: title, font: { color: '#d1d5db', size: 16 } },
            autosize: true,
            height,
            margin: { l: 60, r: 20, t: 40, b: 60 },
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            font: { color: '#d1d5db', size: 11 },
            xaxis: {
                title: 'Spot Move (%)',
                gridcolor: '#374151',
                zerolinecolor: '#4b5563',
                zerolinewidth: 2,
                tickformat: '+.1f'
            },
            yaxis: {
                title: 'Strike Price',
                gridcolor: '#374151',
                zerolinecolor: '#374151'
            },
            uirevision: 'vol-drift-map',
        };
    }, [title, height]);

    if (!driftMatrix || driftMatrix.length === 0) {
        return (
            <div style={{ padding: 20, textAlign: 'center', color: '#6b7280' }}>
                No drift data available for {title}
            </div>
        );
    }

    return (
        <div style={{ width: '100%', height: '100%' }}>
            <Plot
                data={plotData}
                layout={layout}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: '100%', height: '100%' }}
                useResizeHandler
            />
        </div>
    );
};
