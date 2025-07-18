import datetime
import logging
import threading
import queue
import traceback
import time
import re
import sys
from itertools import zip_longest
from typing import Any
from logging.handlers import QueueHandler

from flask import Flask

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import RichLog

from .transcoder import TranscoderManager

class HostTUI(App):
    """Full-screen TUI displaying backend & transcoder output plus segment map."""

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
    #segment_map {
        width: 1fr;
        height: 100%;
        border: round $accent;
        background: $boost;
        overflow: hidden;
        min-width: 0;  /* Allow the panel to shrink below content size */
    }
    /* Ensure text wraps properly in log widgets */
    .text-log {
        width: 100%;
        height: 100%;
        overflow: auto;
    }
    .text-log > .text-log--line {
        width: 100%;
        text-wrap: wrap;
    }
    """

    BINDINGS = [
        ("q", "quit", "Quit"),
        ("ctrl+q", "quit", "Quit"),
        ("escape", "quit", "Quit"),
    ]

    def __init__(self, flask_app: Flask, flask_bind: str, flask_port: int, transcoder_manager: TranscoderManager):
        super().__init__()
        self._flask_app = flask_app
        self._flask_bind = flask_bind
        self._flask_port = flask_port
        self._transcoder_manager = transcoder_manager

        self._flask_queue: queue.Queue[str] = queue.Queue()
        self._transcoder_queue: queue.Queue[str] = queue.Queue()

    # --- Layout ----------------------------------------------------------------
    def compose(self) -> ComposeResult:  # type: ignore[override]
        with Horizontal():
            with Vertical(id="left"):
                yield RichLog(id="flask_log", wrap=False, markup=True, auto_scroll=True)
                yield RichLog(id="transcoder_log", wrap=False, markup=True, auto_scroll=True)
            yield RichLog(id="segment_map", wrap=True, markup=True, min_width=0)

    # --- Background tasks -------------------------------------------------------
    async def on_mount(self) -> None:  # type: ignore[override]
        """Set up the TUI after it's mounted."""
        try:
            # Get references to our widgets
            self.flask_log = self.query_one("#flask_log", RichLog)
            self.transcoder_log = self.query_one("#transcoder_log", RichLog)
            self.segment_map = self.query_one("#segment_map", RichLog)

            # Set titles
            self.flask_log.border_title = "Flask Log"
            self.transcoder_log.border_title = "Transcoder Log"
            self.segment_map.border_title = "Segment Map"

            # Initial messages
            # self.flask_log.write("Initializing Flask log...")
            # self.transcoder_log.write("Initializing transcoder log...")
            # self.segment_map.write("Segment map will appear here")

            # Start background threads
            self._should_stop = threading.Event()

            # Start Flask server in a separate thread
            self._flask_thread = threading.Thread(
                target=self._run_flask,
                name="flask-server",
                daemon=True
            )
            self._flask_thread.start()

            # Force live log capture for the TUI
            self._transcoder_manager.capture_output = True

            # Start transcoder output capture in a separate thread
            self._transcoder_thread = threading.Thread(
                target=self._capture_transcoder_output,
                name="transcoder-capture",
                daemon=True
            )
            self._transcoder_thread.start()

            # Start queue draining timer
            self.set_interval(0.1, self._drain_queues)

        except Exception as e:
            import traceback
            error_msg = f"Error during startup: {str(e)}\n{traceback.format_exc()}"
            if hasattr(self, 'transcoder_log'):
                self.transcoder_log.write(error_msg)
            else:
                print(error_msg, file=sys.stderr)
            # Re-raise to ensure the TUI shuts down
            raise

    def _run_flask(self):
        """Run Flask application in background WSGI server while capturing logs."""
        try:
            from werkzeug.serving import make_server
            import sys
            import io
            from contextlib import redirect_stderr, redirect_stdout

            # Name the thread for easier identification
            threading.current_thread().name = 'flask-server'

            # Create a queue handler and add it to all relevant loggers
            qh = QueueHandler(self._flask_queue)

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
            werkzeug_logger.addHandler(qh)

            # Create a stream to capture stderr
            class StreamToQueue(io.StringIO):
                def __init__(self, queue: queue.Queue[str]):
                    super().__init__()
                    self._flask_queue = queue

                def write(self, s: str) -> int:  # type: ignore[override]
                    if s.strip():
                        super().write(s)
                        self._flask_queue.put(s.strip('\n'))
                    return len(s)

            # Redirect stderr to our queue
            sys.stderr = StreamToQueue(self._flask_queue)  # type: ignore[assignment]

            # Log startup message
            self._flask_queue.put("Starting Flask server...")

            # Enable debug mode to get detailed error pages and tracebacks
            self._flask_app.debug = True

            # Create and start the server
            server = make_server(
                self._flask_bind,
                self._flask_port,
                self._flask_app,
                threaded=True
            )

            try:
                server.serve_forever()
            except Exception as e:
                error_msg = f"Flask server error: {str(e)}\n{traceback.format_exc()}"
                self._flask_queue.put(error_msg)
                raise
            finally:
                try:
                    server.shutdown()
                    server.server_close()
                except Exception as e:
                    self._flask_queue.put(f"Error shutting down Flask: {str(e)}")
        except Exception as e:
            error_msg = f"FATAL ERROR in Flask thread: {str(e)}\n{traceback.format_exc()}"
            self._flask_queue.put(error_msg)
            raise

    def _capture_transcoder_output(self):
        """Capture transcoder output and add to queue."""
        try:
            # Start the transcoder if it's not already running
            if not hasattr(self._transcoder_manager, 'process') or self._transcoder_manager.process is None:
                self.transcoder_log.write("Starting transcoder...")
                self._transcoder_manager.start()
                self.transcoder_log.write("Transcoder started successfully")

            # Get the transcoder process
            process = self._transcoder_manager.process
            if process is None:
                raise RuntimeError("Failed to start transcoder process")

            # Main loop to capture output
            while not self._should_stop.is_set():
                try:
                    if process.stdout:
                        raw_line = process.stdout.readline()
                        if not raw_line:
                            break
                        line = raw_line.rstrip("\n")
                        if line:
                            self._transcoder_queue.put(line)

                    if process.poll() is not None:
                        exit_code = process.returncode
                        if exit_code != 0:
                            error_msg = f"Transcoder process exited with code {exit_code}"
                            self._transcoder_queue.put(error_msg)
                            raise RuntimeError(error_msg)
                        break

                    time.sleep(0.1)

                except Exception as e:
                    error_msg = f"ERROR in transcoder output capture: {str(e)}\n{traceback.format_exc()}"
                    self._transcoder_queue.put(error_msg)
                    raise

        except Exception as e:
            error_msg = (
                "\n" + "="*80 + "\n"
                "FATAL ERROR in transcoder capture\n"
                f"Type: {type(e).__name__}\n"
                f"Error: {str(e)}\n"
                "\nFull traceback:\n"
                f"{traceback.format_exc()}\n"
                "\nThe application will now exit.\n"
                "="*80 + "\n"
            )
            try:
                self._transcoder_queue.put(error_msg)
                self.call_later(0.1, self.app.exit, error_msg)  # type: ignore[arg-type]
            except Exception:
                print(error_msg, file=sys.stderr)
                sys.stderr.flush()
            raise

    @staticmethod
    def _strip_ansi(text: str) -> str:
        ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
        return ansi_escape.sub('', text)

    def _format_log_record(self, record: Any) -> str:
        if isinstance(record, logging.LogRecord):
            if hasattr(record, 'msg') and record.msg is not None:
                if record.args:
                    msg = str(record.msg) % record.args
                else:
                    msg = str(record.msg)
                msg = self._strip_ansi(msg)
                timestamp = datetime.datetime.fromtimestamp(record.created).strftime('%H:%M:%S')
                level = record.levelname
                return f"[{timestamp}] {level}: {msg}"
            return self._strip_ansi(str(record))
        return self._strip_ansi(str(record))

    def _drain_queues(self):
        # try:
            flask_lines = []
            while not self._flask_queue.empty():
                try:
                    record = self._flask_queue.get_nowait()
                    formatted = self._format_log_record(record)
                    if formatted:
                        flask_lines.append(formatted)
                except queue.Empty:
                    break

            if flask_lines:
                chunk_size = 10
                for i in range(0, len(flask_lines), chunk_size):
                    chunk = flask_lines[i:i + chunk_size]
                    self.flask_log.write("\n".join(chunk))
                    time.sleep(0.01)

            transcoder_lines = []
            while not self._transcoder_queue.empty():
                try:
                    line = str(self._transcoder_queue.get_nowait())
                    if not line:
                        continue
                    line = self._strip_ansi(line).strip()
                    if 'status update' in line:
                        downloads_match = re.search(r'downloads="([^"]+)"', line)
                        segments_match = re.search(r'segments="([^"]+)"', line)
                        if segments_match:
                            segments = segments_match.group(1)
                            segments = segments.encode('utf-8', 'replace').decode('utf-8')
                            downloads = downloads_match.group(1) if downloads_match else ''
                            colored_segments = "".join(
                                f"[bright_magenta]{seg}[/]" if dl == '0' else seg
                                for seg, dl in zip_longest(segments, downloads, fillvalue=' ')
                            )
                            self.segment_map.clear()
                            self.segment_map.write(colored_segments)
                        continue
                    transcoder_lines.append(line)
                except queue.Empty:
                    break

            if transcoder_lines:
                chunk_size = 10
                for i in range(0, len(transcoder_lines), chunk_size):
                    chunk = transcoder_lines[i:i + chunk_size]
                    self.transcoder_log.write("\n".join(chunk))
                    time.sleep(0.01)

        # except Exception as e:
        #     error_msg = f"Error in _drain_queues: {str(e)}\n{traceback.format_exc()}"
        #     try:
        #         self.flask_log.write(f"[ERROR] {error_msg}")
        #     except Exception:
        #         print(error_msg, file=sys.stderr)
        #         sys.stderr.flush()

    # --- Clean-up --------------------------------------------------------------
    def action_quit(self) -> None:
        self._transcoder_manager.stop()
        for thread in threading.enumerate():
            if thread.name == 'flask-server':
                try:
                    import os
                    import signal
                    os.kill(os.getpid(), signal.SIGINT)
                except Exception:
                    pass
        self.app.exit()
