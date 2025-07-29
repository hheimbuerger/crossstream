from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import RichLog, Static


class HostTUI(App):
    """Full-screen TUI displaying backend & transcoder output plus segment map."""

    # Class variable to store startup errors for display after TUI shutdown
    startup_error = None

    CSS = """
    Screen {
        layout: horizontal;
        overflow: hidden;
        background: $surface;
        width: 100%;
        height: 100%;
    }
    #left {
        width: 2fr;
        height: 100%;
        layout: vertical;
        padding: 0 1 0 1;
        min-width: 0;  /* Allow the panel to shrink below content size */
    }
    #flask_log {
        border: round $accent;
        background: $boost;
        height: 1fr;
        width: 100%;
        margin-bottom: 1;
        overflow: auto;
        scrollbar-size: 1 1;
        padding: 0 1 0 1;
        content-align: left top;
    }
    #flask_log > .text-log {
        width: 100%;
        overflow: auto;
        scrollbar-size: 1 1;
    }
    #transcoder_log {
        border: round $accent;
        background: $boost;
        height: 1fr;
        width: 100%;
        overflow: auto;
        scrollbar-size: 1 1;
        padding: 0 1 0 1;
        content-align: left top;
    }
    #transcoder_log > .text-log {
        width: 100%;
        overflow: auto;
        scrollbar-size: 1 1;
    }
    #right {
        width: 1fr;
        height: 100%;
        layout: vertical;
        padding: 0 1 0 1;
        min-width: 0;  /* Allow the panel to shrink below content size */
    }
    #segment_map {
        border: round $accent;
        background: $boost;
        height: 1fr;
        width: 100%;
        margin-bottom: 1;
        overflow: auto;
        padding: 0 1 0 1;
        content-align: left top;
    }
    #stats_line {
        height: 1;
        width: 100%;
        background: $boost;
        content-align: center middle;
    }
    """

    def __init__(self, output_log_queue, service_orchestrator):
        super().__init__()
        self._output_log_queue = output_log_queue
        self._service_orchestrator = service_orchestrator
        self.flask_log, self.transcoder_log, self.segment_map, self.stats_display = None, None, None, None

    def compose(self) -> ComposeResult:
        with Horizontal():
            with Vertical(id="left"):
                yield RichLog(id="flask_log", wrap=False, markup=True, auto_scroll=True)
                yield RichLog(id="transcoder_log", wrap=False, markup=True, auto_scroll=True)
            with Vertical(id="right"):
                yield RichLog(id="segment_map", wrap=True, markup=True, min_width=0)
                yield Static("", id="stats_line")

    async def on_mount(self) -> None:
        try:
            # Get references to our widgets
            self.flask_log = self.query_one("#flask_log", RichLog)
            self.transcoder_log = self.query_one("#transcoder_log", RichLog)
            self.segment_map = self.query_one("#segment_map", RichLog)
            self.stats_display = self.query_one("#stats_line", Static)

            # Set titles
            self.flask_log.border_title = "Backend Log"
            self.transcoder_log.border_title = "Transcoder Log"
            self.segment_map.border_title = "Segment Map"

            # Connect UI widgets to service orchestrator for log draining
            self._service_orchestrator.set_ui_widgets(
                flask_log=self.flask_log,
                transcoder_log=self.transcoder_log,
                segment_map=self.segment_map,
                stats=self.stats_display
            )

            # Start queue draining timer
            self.set_interval(0.1, self._service_orchestrator.drain_logs)

        except Exception as e:
            error_msg = f"Error during TUI startup: {str(e)}"
            # Store the error for display after TUI shutdown
            HostTUI.startup_error = error_msg
            # Re-raise to ensure the TUI shuts down
            raise

    # --- Clean-up --------------------------------------------------------------
    async def action_quit(self) -> None:
        self.app.exit()
