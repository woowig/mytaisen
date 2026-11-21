import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** エラーの表示のタイトル(どの画面でエラーが起きたか) */
  title: string;
  children: ReactNode;
}

/** 子の描画中にエラーが起きても、画面全体が真っ暗にならないよう、エラーの内容を表示する */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.title}でエラーが起きました`, error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-box" role="alert">
        <h3>{this.props.title}でエラーが起きました</h3>
        <pre>{error.message || String(error)}</pre>
        <button className="btn" onClick={() => this.setState({ error: null })}>
          もう一度表示する
        </button>
      </div>
    );
  }
}
