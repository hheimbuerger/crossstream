import threading
import queue
import time
import sys
import logging
import re
from itertools import zip_longest
from werkzeug.serving import make_server


def parse_status_update_log(line: str):
    """
    Parse a status update log line and extract segments, downloads, stats, and the colored segment map.
    Returns a dict with keys: segments, downloads, stats, colored_segments, stats_line
    """
    downloads_match = re.search(r'downloads="([^"]+)"', line)
    segments_match = re.search(r'segments="([^"]+)"', line)
    segments = segments_match.group(1) if segments_match else ''
    segments = segments.encode('utf-8', 'replace').decode('utf-8')
    downloads = downloads_match.group(1) if downloads_match else ''
    # Extract statistics from the status update
    stats = {}
    for stat in ['queued', 'in_progress', 'done', 'dl_requested', 'dl_sent']:
        match = re.search(rf'{stat}=(\d+)', line)
        if match:
            stats[stat] = int(match.group(1))
    colored_segments = render_segment_map(segments, downloads)
    # Get stat values with defaults
    q = stats.get('queued', 0)
    i = stats.get('in_progress', 0)
    d = stats.get('done', 0)
    r = stats.get('dl_requested', 0)
    s = stats.get('dl_sent', 0)
    stats_line = f"Seg: {q:2d}q  {i:1d}i {d:2d}d / DL: {r:2d}r  {s:1d}s"
    return {
        'segments': segments,
        'downloads': downloads,
        'stats': stats,
        'colored_segments': colored_segments,
        'stats_line': stats_line
    }

def render_segment_map(segments: str, downloads: str) -> str:
    """
    Render the segment map string using the segment character for display, only updating colors as requested.
    - Use the character from the segments string, not invented characters.
    - Completed download: dark green background, white foreground (unless segment char is a full square, then use dark green fg, no bg)
    - In-progress download: orange background, white foreground
    - Error download: red background, white foreground
    - Not requested: no background, default fg
    """
    DARK_GREEN = "#207520"
    ORANGE = "#d97c13"
    RED = "red"
    WHITE = "white"
    # Characters considered as "full square" for special fg handling
    FULL_SQUARES = {"█", "■"}
    out = []
    for seg_char, dl_char in zip_longest(segments, downloads, fillvalue="–"):
        if dl_char == "✓":
            if seg_char in FULL_SQUARES:
                out.append(f"[{DARK_GREEN}]{seg_char}[/]")
            else:
                out.append(f"[on {DARK_GREEN} {WHITE}]{seg_char}[/]")
        elif dl_char == "▶":
            out.append(f"[on {ORANGE} {WHITE}]{seg_char}[/]")
        elif dl_char == "!":
            out.append(f"[on {RED} {WHITE}]{seg_char}[/]")
        else:
            out.append(seg_char)
    return "".join(out)


class ServiceOrchestrator:
    """Orchestrates backend services and their communication."""

    def __init__(self, output_log_queue, video_manager, transcoder_manager, flask_app, bind_address, port):
        self.output_log_queue = output_log_queue
        self.video_manager = video_manager
        self.transcoder_manager = transcoder_manager
        self.flask_app = flask_app
        self.bind_address = bind_address
        self.port = port

        # Thread management
        self.flask_thread = None
        self.transcoder_thread = None
        self.log_drain_timer = None
        self._should_stop = threading.Event()

        # TUI components (will be set by TUI)
        self.flask_log_widget = None
        self.transcoder_log_widget = None
        self.segment_map_widget = None
        self.stats_widget = None

        # Transcoder queue for internal communication
        self._transcoder_queue = queue.Queue()

    def start(self):
        """Start all backend services."""
        # Initialize VideoManager
        self._initialize_video_manager()

        # Start Flask server
        self._start_flask_server()

        # Start transcoder output capture
        self._start_transcoder_capture()

        # Start log draining (will be called by TUI timer)
        # Note: The actual timer setup happens in TUI since it needs the TUI event loop

    def stop(self):
        """Stop all backend services."""
        self._should_stop.set()

        # Stop transcoder
        self.transcoder_manager.stop()

        # Stop Flask server
        if self.flask_thread and self.flask_thread.is_alive():
            # Flask server shutdown is handled in the thread
            self.flask_thread.join(timeout=2.0)

    def set_ui_widgets(self, flask_log, transcoder_log, segment_map, stats):
        """Set UI widgets for log draining."""
        self.flask_log_widget = flask_log
        self.transcoder_log_widget = transcoder_log
        self.segment_map_widget = segment_map
        self.stats_widget = stats

    def drain_logs(self):
        """Drain logs from all sources and update UI widgets."""
        if not all([self.flask_log_widget, self.transcoder_log_widget,
                   self.segment_map_widget, self.stats_widget]):
            return

        # Drain Flask/output logs
        flask_lines = []
        while not self.output_log_queue.empty():
            try:
                record = self.output_log_queue.get_nowait()
                formatted = self._format_log_record(record)
                if formatted:
                    # Strip ANSI colors from Flask logs as they break Textual display
                    formatted = self._strip_ansi(formatted)
                    flask_lines.append(formatted)
            except queue.Empty:
                break

        if flask_lines:
            chunk_size = 10
            for i in range(0, len(flask_lines), chunk_size):
                chunk = flask_lines[i:i + chunk_size]
                self.flask_log_widget.write("\n".join(chunk))
                time.sleep(0.01)

        # Drain transcoder logs
        transcoder_lines = []
        while not self._transcoder_queue.empty():
            try:
                line = self._transcoder_queue.get_nowait()
                line = self._strip_ansi(line).strip()
                if 'status update' in line:
                    # Parse and process the status update
                    status_info = parse_status_update_log(line)
                    self.segment_map_widget.clear()
                    self.segment_map_widget.write(status_info['colored_segments'])
                    self.stats_widget.update(status_info['stats_line'])
                    continue
                transcoder_lines.append(line)
            except queue.Empty:
                break

        if transcoder_lines:
            chunk_size = 10
            for i in range(0, len(transcoder_lines), chunk_size):
                chunk = transcoder_lines[i:i + chunk_size]
                self.transcoder_log_widget.write("\n".join(chunk))
                time.sleep(0.01)

    def _initialize_video_manager(self):
        """Initialize VideoManager with output captured to backend log."""
        # Capture stdout/stderr during VideoManager initialization
        original_stdout = sys.stdout
        original_stderr = sys.stderr

        # Reuse the same stream capture pattern as host.py
        class _StreamToQueue:
            def __init__(self, q):
                self._q = q

            def write(self, s: str):
                if s.strip():
                    self._q.put(s.rstrip("\n"))
                return len(s)

        # Redirect output to output_log_queue
        capture = _StreamToQueue(self.output_log_queue)
        sys.stdout = capture
        sys.stderr = capture

        try:
            # Initialize VideoManager (heavy operations)
            self.video_manager.prepare_video()
        finally:
            # Always restore original stdout/stderr
            sys.stdout = original_stdout
            sys.stderr = original_stderr

    def _start_flask_server(self):
        """Start Flask server in background thread."""
        def run_flask():
            # Name the thread for easier identification
            threading.current_thread().name = 'flask-server'

            # Create a queue handler and add it to all relevant loggers
            class QueueHandler(logging.Handler):
                def __init__(self, q):
                    super().__init__()
                    self._q = q

                def emit(self, record):
                    self._q.put(self.format(record))

            qh = QueueHandler(self.output_log_queue)

            # Configure root logger
            root_logger = logging.getLogger()
            root_logger.setLevel(logging.INFO)

            # Remove any existing handlers to avoid duplicate logs
            for handler in root_logger.handlers[:]:
                root_logger.removeHandler(handler)

            # Add our queue handler
            root_logger.addHandler(qh)

            # Also capture werkzeug logs
            werkzeug_logger = logging.getLogger('werkzeug')
            werkzeug_logger.setLevel(logging.INFO)
            # Remove all handlers and prevent propagation to root
            for handler in werkzeug_logger.handlers[:]:
                werkzeug_logger.removeHandler(handler)
            werkzeug_logger.propagate = True  # Let it propagate to root (which goes to queue)

            # Create and start the server
            server = make_server(
                self.bind_address,
                self.port,
                self.flask_app,
                threaded=True
            )

            try:
                server.serve_forever()
            finally:
                server.shutdown()
                server.server_close()

        self.flask_thread = threading.Thread(target=run_flask, daemon=True)
        self.flask_thread.start()

    def _start_transcoder_capture(self):
        """Start transcoder output capture in background thread."""
        def capture_transcoder_output():
            # Start the transcoder if it's not already running
            if not hasattr(self.transcoder_manager, 'process') or self.transcoder_manager.process is None:
                self._transcoder_queue.put("Starting transcoder...")
                self.transcoder_manager.start()
                self._transcoder_queue.put("Transcoder started successfully")

            # Get the transcoder process
            process = self.transcoder_manager.process
            if process is None:
                raise RuntimeError("Failed to start transcoder process")

            # Main loop to capture output
            while not self._should_stop.is_set():
                if process.poll() is not None:
                    self._transcoder_queue.put("Transcoder process has terminated")
                    break

                # Read from stdout with timeout
                if process.stdout and process.stdout.readable():
                    line = process.stdout.readline()
                    if line:
                        decoded_line = line.strip()
                        if decoded_line:
                            self._transcoder_queue.put(decoded_line)

                # Read from stderr with timeout
                if process.stderr and process.stderr.readable():
                    line = process.stderr.readline()
                    if line:
                        decoded_line = line.strip()
                        if decoded_line:
                            self._transcoder_queue.put(f"[STDERR] {decoded_line}")

                # Small sleep to prevent busy waiting
                time.sleep(0.01)

        # Set transcoder to capture output
        self.transcoder_manager.capture_output = True

        # Start transcoder output capture in a separate thread
        self.transcoder_thread = threading.Thread(
            target=capture_transcoder_output,
            name="transcoder-capture",
            daemon=True
        )
        self.transcoder_thread.start()

    def _strip_ansi(self, text: str) -> str:
        """Strip ANSI escape sequences from text."""
        ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
        return ansi_escape.sub('', text)

    def _format_log_record(self, record):
        """Format a log record for display."""
        if isinstance(record, str):
            return record
        return self._strip_ansi(str(record))
