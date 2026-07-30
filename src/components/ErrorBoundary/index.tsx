import { t } from "i18next";
import React, { Component } from "react";

import Button from "src/components/Button";
import Icon from "src/components/Icon";

type ErrorBoundaryProps = {
  children: React.ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.hash = "#/";
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary__icon">
            <Icon.Warning width={48} height={48} />
          </div>
          <h2 className="error-boundary__title">
            {t("errorBoundary.title")}
          </h2>
          <p className="error-boundary__message">
            {this.state.error?.message || t("errorBoundary.unknown")}
          </p>
          <div className="error-boundary__action">
            <Button
              variant="solid"
              color="primary"
              size="lg"
              onClick={this.handleReset}
            >
              {t("errorBoundary.goHome")}
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
