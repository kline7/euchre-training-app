import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: string | null;
}

export default class WasmErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '60vh',
          gap: 16,
          color: '#e0e0e0',
          textAlign: 'center',
          padding: 24,
        }}>
          <h2 style={{ color: '#e74c3c', margin: 0 }}>Engine Error</h2>
          <p style={{ maxWidth: 400, opacity: 0.8, fontSize: '0.9rem' }}>
            The WASM engine failed to load. This may be due to browser compatibility
            or a temporary issue.
          </p>
          {this.state.error && (
            <code style={{
              background: 'rgba(0,0,0,0.3)',
              padding: '6px 12px',
              borderRadius: 4,
              fontSize: '0.75rem',
              maxWidth: 400,
              wordBreak: 'break-word',
            }}>
              {this.state.error}
            </code>
          )}
          <button
            onClick={this.handleRetry}
            style={{
              background: '#2e86c1',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '8px 20px',
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
