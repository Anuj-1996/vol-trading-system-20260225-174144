import React, { useMemo } from 'react';
import Plot from '../ThemedPlot';

/**
 * Volatility Terrain Map (3D)
 * Visualizes implied volatility across strikes and expiries.
 * X: Strike, Y: Expiry, Z: Implied Volatility.
 * Color represents market IV vs model IV deviation.
 */
export const VolTerrainMap = ({
    strikes = [],
    expiries = [],
    marketIvMatrix = [],
    modelIvMatrix = [],
    title = 'Volatility Terrain Map',
    height = 500,
}) => {
    const { surfacecolors, hovertext } = useMemo(() => {
        if (!marketIvMatrix || marketIvMatrix.length === 0 || !modelIvMatrix || modelIvMatrix.length === 0) {
            return { surfacecolors: [], hovertext: [] };
        }

        const colors = [];
        const text = [];

        for (let r = 0; r < marketIvMatrix.length; r++) {
            const colorRow = [];
            const textRow = [];

            for (let c = 0; c < marketIvMatrix[r].length; c++) {
                const mktIv = marketIvMatrix[r][c] || 0;
                const modIv = modelIvMatrix[r]?.[c] || mktIv;

                const deviation = mktIv - modIv;
                colorRow.push(deviation);

                textRow.push(
                    `<b>Strike:</b> ${strikes[c]}<br>` +
                    `<b>Expiry:</b> ${expiries[r]}<br>` +
                    `<b>Market IV:</b> ${(mktIv * 100).toFixed(2)}%<br>` +
                    `<b>Model IV:</b> ${(modIv * 100).toFixed(2)}%<br>` +
                    `<b>Deviation:</b> ${(deviation * 100).toFixed(2)} bps`
                );
            }
            colors.push(colorRow);
            text.push(textRow);
        }

        return { surfacecolors: colors, hovertext: text };
    }, [marketIvMatrix, modelIvMatrix, strikes, expiries]);

    const plotData = useMemo(() => {
        return [
            {
                z: marketIvMatrix,
                x: strikes,
                y: expiries,
                type: 'surface',
                surfacecolor: surfacecolors,
                colorscale: 'RdBu',
                reversescale: true,
                cmin: -0.05,
                cmax: 0.05,
                colorbar: {
                    title: 'Δ IV',
                    titleside: 'right',
                    thickness: 15,
                    len: 0.6,
                },
                hoverinfo: 'text',
                text: hovertext,
                contours: {
                    z: { show: true, usecolormap: true, highlightcolor: 'yellow', project: { z: true } }
                }
            },
        ];
    }, [marketIvMatrix, strikes, expiries, surfacecolors, hovertext]);

    const layout = useMemo(() => {
        return {
            title: { text: title, font: { color: '#d1d5db', size: 16 } },
            autosize: true,
            height,
            margin: { l: 0, r: 0, t: 40, b: 0 },
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            font: { color: '#d1d5db', size: 11 },
            scene: {
                xaxis: { title: 'Strike', gridcolor: '#374151', zerolinecolor: '#374151' },
                yaxis: { title: 'Expiry', gridcolor: '#374151', zerolinecolor: '#374151' },
                zaxis: { title: 'Market IV', gridcolor: '#374151', zerolinecolor: '#374151' },
                camera: { eye: { x: 1.5, y: -1.5, z: 1.2 } },
                aspectratio: { x: 1, y: 1, z: 0.6 }
            },
            uirevision: 'vol-terrain-map',
        };
    }, [title, height]);

    if (!marketIvMatrix || marketIvMatrix.length === 0) {
        return (
            <div style={{ padding: 20, textAlign: 'center', color: '#6b7280' }}>
                No implied volatility data available for {title}
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
