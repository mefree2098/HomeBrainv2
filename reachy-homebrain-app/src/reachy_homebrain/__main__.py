"""Run the same stable launcher used by the Reachy managed-app entry point."""

from .main import ReachyHomebrain

if __name__ == "__main__":
    application = ReachyHomebrain()
    try:
        application.wrapped_run()
    except KeyboardInterrupt:
        application.stop()
