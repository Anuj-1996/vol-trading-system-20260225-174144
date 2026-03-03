import React from 'react';
import ReactDOM from 'react-dom';

export const NIFTY_LOT_SIZE = 65;

export function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '-';
  }
  return Number(value).toFixed(digits);
}

export function formatPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '-';
  }
  return (Number(value) * 100).toFixed(digits) + '%';
}

export function formatRs(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '-';
  }
  const rs = Number(value) * NIFTY_LOT_SIZE;
  return '\u20B9' + rs.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatPctVal(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '-';
  }
  return (Number(value) * 100).toFixed(digits) + '%';
}

export function Panel({ title, children, className = '', onMaximize, enableCopyPlot = false }) {
  const panelRef = React.useRef(null);
  const fullscreenRef = React.useRef(null);
  const [hasPlot, setHasPlot] = React.useState(false);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [copyState, setCopyState] = React.useState('idle');

  React.useEffect(() => {
    const panelNode = panelRef.current;
    if (!panelNode) {
      return undefined;
    }

    const refreshPlotState = () => {
      setHasPlot(Boolean(panelNode.querySelector('.js-plotly-plot')));
    };

    refreshPlotState();
    const observer = new MutationObserver(refreshPlotState);
    observer.observe(panelNode, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [children]);

  const copyPlotToClipboard = async (preferFullscreen = false) => {
    try {
      const sourceNode =
        (preferFullscreen ? fullscreenRef.current : null) ||
        (isFullscreen ? fullscreenRef.current : null) ||
        panelRef.current;
      const plotNode = sourceNode?.querySelector('.js-plotly-plot');
      if (!plotNode) {
        throw new Error('No plot found in this panel.');
      }
      if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
        throw new Error('Clipboard image copy is not supported in this browser.');
      }

      const { default: Plotly } = await import('plotly.js-dist-min');
      const width = Math.max(640, Math.round(plotNode.clientWidth || 800));
      const height = Math.max(360, Math.round(plotNode.clientHeight || 480));
      const imageDataUrl = await Plotly.toImage(plotNode, {
        format: 'png',
        width,
        height,
        scale: 2,
      });

      const response = await fetch(imageDataUrl);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new window.ClipboardItem({
          [blob.type]: blob,
        }),
      ]);
      setCopyState('copied');
    } catch (error) {
      console.error(error);
      setCopyState('failed');
    } finally {
      window.setTimeout(() => setCopyState('idle'), 1400);
    }
  };

  const showPlotActions = hasPlot || enableCopyPlot || Boolean(onMaximize);
  const handleMaximize = () => {
    if (onMaximize) {
      onMaximize();
      return;
    }
    setIsFullscreen(true);
  };

  return (
    <>
      <section className={`bbg-panel ${className}`.trim()} ref={panelRef}>
        <header className="bbg-panel-header">
          <span>{title}</span>
          {showPlotActions && (
            <div className="panel-header-actions">
              <button
                className={`copy-plot-btn ${copyState === 'failed' ? 'error' : ''}`.trim()}
                onClick={() => copyPlotToClipboard(false)}
                title="Copy plot image to clipboard"
                type="button"
              >
                {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Retry' : 'Copy Plot'}
              </button>
              <button className="maximize-btn" onClick={handleMaximize} title="Maximize" type="button">
                ⛶
              </button>
            </div>
          )}
        </header>
        <div className="bbg-panel-body">{children}</div>
      </section>

      {isFullscreen &&
        ReactDOM.createPortal(
          <div className="panel-fullscreen-overlay">
            <header className="panel-fullscreen-header">
              <span>{title}</span>
              <div className="panel-header-actions">
                <button
                  className={`copy-plot-btn ${copyState === 'failed' ? 'error' : ''}`.trim()}
                  onClick={() => copyPlotToClipboard(true)}
                  title="Copy plot image to clipboard"
                  type="button"
                >
                  {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Retry' : 'Copy Plot'}
                </button>
                <button className="close-btn" onClick={() => setIsFullscreen(false)} type="button">
                  ✕ Close
                </button>
              </div>
            </header>
            <div className="panel-fullscreen-body" ref={fullscreenRef}>
              <section className={`bbg-panel panel-fullscreen-panel ${className}`.trim()}>
                <div className="bbg-panel-body">{children}</div>
              </section>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export function SnapshotGuard({ loading, activeSnapshotId, children }) {
  if (loading) {
    return <div className="snapshot-placeholder">Loading snapshot...</div>;
  }
  if (!activeSnapshotId) {
    return <div className="snapshot-placeholder">Click "Fetch Live &amp; Analyse" to load data from NSE</div>;
  }
  return children;
}
