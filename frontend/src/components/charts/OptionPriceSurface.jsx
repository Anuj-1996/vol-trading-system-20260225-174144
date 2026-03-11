import React, { useMemo } from 'react';
import Plot from 'react-plotly.js';

/**
 * Option Price Surface (3D)
 * Visualizes the option premium landscape across strike and expiry.
 * X: Strike, Y: Expiry, Z: Option Price.
 */
export const OptionPriceSurface = ({
    strikes = [],
    expiries = [],
    priceMatrix = [], // 2D array where z[y][x] corresponds to y=expiry, x=strike
    title = 'Option Price Surface',
    height = 500,
}) => {
    const plotData = useMemo(() => {
        return [
            {
                z: priceMatrix,
                x: strikes,
                y: expiries,
                type: 'surface',
                colorscale: 'Viridis',
                colorbar: {
                    title: 'Premium',
                    titleside: 'right',
                    thickness: 15,
                    len: 0.6,
                },
                hovertemplate:
                    '<b>Strike:</b> %{x}<br>' +
                    '<b>Expiry:</b> %{y}<br>' +
                    '<b>Price:</b> ₹%{z:.2f}<extra></extra>',
                contours: {
                    z: { show: true, usecolormap: true, highlightcolor: 'limegreen', project: { z: true } }
                }
            },
        ];
    }, [strikes, expiries, priceMatrix]);

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
                zaxis: { title: 'Price (₹)', gridcolor: '#374151', zerolinecolor: '#374151' },
                camera: { eye: { x: 1.5, y: -1.5, z: 1.2 } },
                aspectratio: { x: 1, y: 1, z: 0.6 }
            },
            uirevision: 'option-price-surface',
        };
    }, [title, height]);

    if (!priceMatrix || priceMatrix.length === 0) {
        return (
            <div style={{ padding: 20, textAlign: 'center', color: '#6b7280' }}>
                No price data available for {title}
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
