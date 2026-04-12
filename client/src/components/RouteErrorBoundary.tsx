import { Component, type ErrorInfo, type ReactNode } from "react"

import { Button } from "./ui/button"

interface RouteErrorBoundaryProps {
  children: ReactNode
  routeName?: string
}

interface RouteErrorBoundaryState {
  hasError: boolean
}

export class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = {
    hasError: false
  }

  static getDerivedStateFromError() {
    return {
      hasError: true
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`RouteErrorBoundary: ${this.props.routeName || "Route"} crashed`, error, errorInfo)
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    return (
      <div className="flex min-h-[50vh] items-center justify-center px-4">
        <div className="glass-panel glass-panel-strong max-w-lg rounded-[2rem] px-8 py-7 text-center">
          <p className="section-kicker">Route Recovery</p>
          <p className="mt-3 text-xl font-semibold text-foreground">
            {this.props.routeName || "This page"} ran into a loading error.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            HomeBrain kept the rest of the app alive, but this page needs a refresh to recover cleanly.
          </p>
          <div className="mt-5 flex justify-center">
            <Button onClick={() => window.location.reload()}>
              Reload HomeBrain
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
