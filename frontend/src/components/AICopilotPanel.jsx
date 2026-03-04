import React, { useCallback, useEffect, useRef, useState } from 'react';
import { aiChatStream, aiBriefing, aiClearConversation, aiSyncPipeline, aiRecalibrate } from '../api/client';

const AGENT_COLORS = {
  market_intel: '#3b82f6',
  strategy_advisor: '#f59e0b',
  risk_analyst: '#ef4444',
  calibration_monitor: '#8b5cf6',
  trade_execution: '#22c55e',
  pre_trade: '#06b6d4',
  vol_surface: '#ec4899',
  orchestrator: '#9ca3af',
  system: '#6b7280',
};

const AGENT_LABELS = {
  market_intel: 'Market Intel',
  strategy_advisor: 'Strategy Advisor',
  risk_analyst: 'Risk Analyst',
  calibration_monitor: 'Calibration Monitor',
  trade_execution: 'Trade Execution',
  pre_trade: 'Pre-Trade Analyst',
  vol_surface: 'Vol Surface',
  orchestrator: 'Orchestrator',
  system: 'System',
};

const QUICK_PROMPTS = [
  { label: 'Market Briefing', query: 'Give me a market intelligence briefing', agent: 'market_intel' },
  { label: 'Best Strategy', query: 'What is the best strategy for current conditions?', agent: 'strategy_advisor' },
  { label: 'Risk Check', query: 'Perform a comprehensive risk assessment', agent: 'risk_analyst' },
  { label: 'Calibration', query: 'Assess the Heston calibration quality', agent: 'calibration_monitor' },
  { label: 'Execution Plan', query: 'Create an execution plan for the top strategy', agent: 'trade_execution' },
  { label: 'Pre-Trade', query: 'Run pre-trade analysis on the top strategies', agent: 'pre_trade' },
  { label: 'Vol Surface', query: 'Deep analysis of the vol surface: IV rank, term structure, skew, and 3D surface topology', agent: 'vol_surface' },
];

const MODEL_OPTIONS = [
  { value: 'gemma:2b', label: 'Gemma 2B' },
  { value: 'gemma3:1b', label: 'Gemma 3 1B' },
  { value: 'gemma3:4b', label: 'Gemma 3 4B' },
];

function formatMarkdown(text) {
  if (!text) return '';
  // Strip recalibrate blocks from display
  let cleaned = text.replace(/```recalibrate\n[\s\S]*?```/g, '');
  let html = cleaned
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h4 class="ai-h4">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="ai-h3">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 class="ai-h2">$1</h2>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br/>');
  html = html.replace(/(<li>.*<\/li>)/gs, (match) => `<ul>${match}</ul>`);
  html = html.replace(/<\/ul>\s*<ul>/g, '');
  return `<p>${html}</p>`;
}

function parseRecalibrateBlock(text) {
  if (!text) return null;
  const match = text.match(/```recalibrate\s*\n([\s\S]*?)```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

export default function AICopilotPanel({ pipelineData, isOpen, onToggle, dataId, onRecalibrated }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('auto');
  const [selectedModelId, setSelectedModelId] = useState('gemma:2b');
  const [isSynced, setIsSynced] = useState(false);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [recalibrating, setRecalibrating] = useState(false);
  const [showRecalParams, setShowRecalParams] = useState(null); // msg id with open editor
  const [editedParams, setEditedParams] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (pipelineData && !isSynced) {
      aiSyncPipeline(pipelineData).then(() => {
        setIsSynced(true);
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now(),
            type: 'system',
            text: 'Pipeline data synced. AI agents are ready for analysis.',
          },
        ]);
      }).catch(() => {});
    }
  }, [pipelineData, isSynced]);

  useEffect(() => {
    setIsSynced(false);
  }, [pipelineData]);

  const sendMessage = useCallback(
    async (queryOverride, agentOverride) => {
      const query = queryOverride || input.trim();
      if (!query || isStreaming) return;

      const userMsg = { id: Date.now(), type: 'user', text: query };
      const aiMsg = {
        id: Date.now() + 1,
        type: 'ai',
        agent: '',
        role: '',
        text: '',
        streaming: true,
      };

      setMessages((prev) => [...prev, userMsg, aiMsg]);
      setInput('');
      setIsStreaming(true);

      const agent = agentOverride || (selectedAgent !== 'auto' ? selectedAgent : null);

      try {
        await aiChatStream(query, agent, pipelineData, (update) => {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === aiMsg.id
                ? {
                    ...msg,
                    agent: update.agent,
                    role: update.role,
                    text: update.text,
                    streaming: !update.done,
                  }
              : msg,
            ),
          );
        }, selectedModelId);
      } catch (err) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === aiMsg.id
              ? { ...msg, text: `Error: ${err.message}`, streaming: false, type: 'error' }
              : msg,
          ),
        );
      } finally {
        setIsStreaming(false);
      }
    },
    [input, isStreaming, selectedAgent, pipelineData, selectedModelId],
  );

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleBriefing = async () => {
    if (briefingLoading) return;
    setBriefingLoading(true);
    setMessages((prev) => [
      ...prev,
      { id: Date.now(), type: 'system', text: 'Generating full market briefing (consulting all agents)...' },
    ]);

    try {
      const result = await aiBriefing(pipelineData, selectedModelId);
      const briefingData = result.data || result;

      for (const [key, section] of Object.entries(briefingData)) {
        if (section?.analysis) {
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now() + Math.random(),
              type: 'ai',
              agent: section.agent || key,
              role: section.role || key,
              text: section.analysis,
              streaming: false,
            },
          ]);
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: Date.now(), type: 'error', text: `Briefing error: ${err.message}` },
      ]);
    } finally {
      setBriefingLoading(false);
    }
  };

  const handleClear = async () => {
    setMessages([]);
    setShowRecalParams(null);
    setEditedParams(null);
    try {
      await aiClearConversation();
    } catch {}
  };

  const handleRecalibrate = async (suggestedParams, msgId) => {
    if (recalibrating || !dataId) return;
    const params = editedParams || suggestedParams;
    // Extract bounds if present (from agent's suggestion)
    const bounds = params.bounds || suggestedParams.bounds || null;
    // Build clean initial guess without the bounds key
    const { bounds: _b, ...initialGuess } = params;
    setRecalibrating(true);
    setShowRecalParams(null);

    setMessages((prev) => [
      ...prev,
      {
        id: Date.now(),
        type: 'system',
        text: `Re-calibrating Heston model with: kappa=${initialGuess.kappa}, theta=${initialGuess.theta}, xi=${initialGuess.xi}, rho=${initialGuess.rho}, v0=${initialGuess.v0}${bounds ? ' (with custom bounds)' : ''} ...`,
      },
    ]);

    try {
      const result = await aiRecalibrate(dataId, initialGuess, bounds);
      const recalData = result.data || result;
      const cal = recalData.calibration || {};
      const newParams = cal.parameters || {};
      const rmse = cal.weighted_rmse;
      const converged = cal.converged;

      // Sync new pipeline data to AI agents
      await aiSyncPipeline(recalData).catch(() => {});

      const verdict = rmse < 0.01 ? 'EXCELLENT' : rmse < 0.03 ? 'ACCEPTABLE' : 'POOR';
      const verdictColor = rmse < 0.01 ? '#22c55e' : rmse < 0.03 ? '#f59e0b' : '#ef4444';

      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          type: 'ai',
          agent: 'calibration_monitor',
          role: 'Calibration Monitor',
          text: `**RE-CALIBRATION COMPLETE** \\n\\n` +
            `**Result**: ${verdict} (RMSE: ${rmse?.toFixed(6) || 'N/A'})\\n` +
            `**Converged**: ${converged ? 'Yes' : 'No'} in ${cal.iterations || '?'} iterations\\n\\n` +
            `**New Parameters**:\\n` +
            `- kappa = ${newParams.kappa?.toFixed(6) || 'N/A'}\\n` +
            `- theta = ${newParams.theta?.toFixed(6) || 'N/A'} (long-run vol = ${newParams.theta ? (Math.sqrt(newParams.theta) * 100).toFixed(2) + '%' : 'N/A'})\\n` +
            `- xi = ${newParams.xi?.toFixed(6) || 'N/A'}\\n` +
            `- rho = ${newParams.rho?.toFixed(6) || 'N/A'}\\n` +
            `- v0 = ${newParams.v0?.toFixed(6) || 'N/A'} (current vol = ${newParams.v0 ? (Math.sqrt(newParams.v0) * 100).toFixed(2) + '%' : 'N/A'})\\n\\n` +
            `**Feller**: 2κθ = ${newParams.kappa && newParams.theta ? (2 * newParams.kappa * newParams.theta).toFixed(6) : '?'} vs ξ² = ${newParams.xi ? (newParams.xi ** 2).toFixed(6) : '?'} → ${newParams.kappa && newParams.theta && newParams.xi && (2 * newParams.kappa * newParams.theta > newParams.xi ** 2) ? 'SATISFIED' : 'VIOLATED'}\\n\\n` +
            `Pipeline data has been updated with the new calibration. All agents now use the re-calibrated model.`,
          streaming: false,
          recalData,
        },
      ]);

      // Notify parent to update dashboard data
      if (onRecalibrated) onRecalibrated(recalData);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 2,
          type: 'error',
          text: `Re-calibration failed: ${err.message}`,
        },
      ]);
    } finally {
      setRecalibrating(false);
      setEditedParams(null);
    }
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        className="ai-copilot-toggle"
        onClick={onToggle}
        title="Open AI Copilot"
      >
        <span className="ai-toggle-icon">AI</span>
      </button>
    );
  }

  return (
    <div className="ai-copilot-panel">
      <div className="ai-copilot-header">
        <div className="ai-header-left">
          <span className="ai-header-title">AI COPILOT</span>
          <span className="ai-header-model">
            {(MODEL_OPTIONS.find((opt) => opt.value === selectedModelId)?.label || selectedModelId)} · Ollama
          </span>
        </div>
        <div className="ai-header-right">
          <select
            className="ai-agent-select"
            value={selectedModelId}
            onChange={(e) => setSelectedModelId(e.target.value)}
            title="Ollama model"
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <select
            className="ai-agent-select"
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
          >
            <option value="auto">Auto-Route</option>
            <option value="market_intel">Market Intel</option>
            <option value="strategy_advisor">Strategy Advisor</option>
            <option value="risk_analyst">Risk Analyst</option>
            <option value="calibration_monitor">Calibration</option>
            <option value="trade_execution">Execution</option>
            <option value="pre_trade">Pre-Trade</option>
            <option value="vol_surface">Vol Surface</option>
          </select>
          <button type="button" className="ai-header-btn" onClick={handleClear} title="Clear chat">
            CLR
          </button>
          <button type="button" className="ai-header-btn" onClick={onToggle} title="Close">
            X
          </button>
        </div>
      </div>

      <div className="ai-quick-prompts">
        {QUICK_PROMPTS.map((qp) => (
          <button
            key={qp.label}
            type="button"
            className="ai-quick-btn"
            style={{ borderColor: AGENT_COLORS[qp.agent] || '#374151' }}
            onClick={() => sendMessage(qp.query, qp.agent)}
            disabled={isStreaming}
          >
            {qp.label}
          </button>
        ))}
        <button
          type="button"
          className="ai-quick-btn ai-briefing-btn"
          onClick={handleBriefing}
          disabled={isStreaming || briefingLoading}
        >
          {briefingLoading ? 'Generating...' : 'Full Briefing'}
        </button>
      </div>

      <div className="ai-messages">
        {messages.length === 0 && (
          <div className="ai-empty-state">
            <div className="ai-empty-title">Multi-Agent AI System</div>
            <div className="ai-empty-desc">
              7 specialist agents powered by local Ollama.
              Ask anything about the market, strategies, risk, calibration, vol surface, or execution.
            </div>
            <div className="ai-agent-grid">
              {Object.entries(AGENT_LABELS).filter(([k]) => k !== 'orchestrator' && k !== 'system').map(([key, label]) => (
                <div key={key} className="ai-agent-card" style={{ borderLeftColor: AGENT_COLORS[key] }}>
                  <span className="ai-agent-card-name">{label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => {
          if (msg.type === 'user') {
            return (
              <div key={msg.id} className="ai-msg ai-msg-user">
                <div className="ai-msg-content">{msg.text}</div>
              </div>
            );
          }
          if (msg.type === 'system') {
            return (
              <div key={msg.id} className="ai-msg ai-msg-system">
                <div className="ai-msg-content">{msg.text}</div>
              </div>
            );
          }
          if (msg.type === 'error') {
            return (
              <div key={msg.id} className="ai-msg ai-msg-error">
                <div className="ai-msg-content">{msg.text}</div>
              </div>
            );
          }
          const agentColor = AGENT_COLORS[msg.agent] || '#9ca3af';
          const agentLabel = AGENT_LABELS[msg.agent] || msg.role || msg.agent;
          const recalParams = !msg.streaming ? parseRecalibrateBlock(msg.text) : null;
          const isEditing = showRecalParams === msg.id;
          return (
            <div key={msg.id} className="ai-msg ai-msg-ai">
              <div className="ai-msg-agent-tag" style={{ color: agentColor }}>
                {agentLabel}
                {msg.streaming && <span className="ai-streaming-dot" />}
              </div>
              <div
                className="ai-msg-content ai-msg-markdown"
                dangerouslySetInnerHTML={{ __html: formatMarkdown(msg.text) }}
              />
              {recalParams && dataId && (
                <div className="ai-recal-action">
                  <div className="ai-recal-header">
                    <button
                      type="button"
                      className="ai-recal-btn"
                      disabled={recalibrating || isStreaming}
                      onClick={() => handleRecalibrate(recalParams, msg.id)}
                    >
                      {recalibrating ? 'Re-Calibrating...' : 'Re-Calibrate with Suggested Params'}
                    </button>
                    <button
                      type="button"
                      className="ai-recal-edit-btn"
                      onClick={() => {
                        if (isEditing) {
                          setShowRecalParams(null);
                          setEditedParams(null);
                        } else {
                          setShowRecalParams(msg.id);
                          setEditedParams({ ...recalParams });
                        }
                      }}
                      title="Edit parameters before re-calibrating"
                    >
                      {isEditing ? 'Close' : 'Edit'}
                    </button>
                  </div>
                  <div className="ai-recal-params-preview">
                    κ={recalParams.kappa} θ={recalParams.theta} ξ={recalParams.xi} ρ={recalParams.rho} v₀={recalParams.v0}
                  </div>
                  {isEditing && editedParams && (
                    <div className="ai-recal-editor">
                      {['kappa', 'theta', 'xi', 'rho', 'v0'].map((param) => (
                        <label key={param} className="ai-recal-field">
                          <span>{param === 'v0' ? 'v₀' : param === 'kappa' ? 'κ' : param === 'theta' ? 'θ' : param === 'xi' ? 'ξ' : 'ρ'}</span>
                          <input
                            type="number"
                            step="any"
                            value={editedParams[param]}
                            onChange={(e) => setEditedParams((prev) => ({ ...prev, [param]: parseFloat(e.target.value) || 0 }))}
                          />
                        </label>
                      ))}
                      <button
                        type="button"
                        className="ai-recal-btn ai-recal-btn-custom"
                        disabled={recalibrating || isStreaming}
                        onClick={() => handleRecalibrate(editedParams, msg.id)}
                      >
                        {recalibrating ? 'Re-Calibrating...' : 'Re-Calibrate with Custom Params'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="ai-input-area">
        <textarea
          ref={inputRef}
          className="ai-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about market, strategy, risk, calibration..."
          rows={2}
          disabled={isStreaming}
        />
        <button
          type="button"
          className="ai-send-btn"
          onClick={() => sendMessage()}
          disabled={isStreaming || !input.trim()}
        >
          {isStreaming ? '...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
