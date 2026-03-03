import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return React.createElement('pre', {
        style: { color: '#f43f5e', background: '#0a0f19', padding: 24, fontSize: 14, whiteSpace: 'pre-wrap' }
      }, 'React Error:\n' + this.state.error.message + '\n\n' + this.state.error.stack);
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
