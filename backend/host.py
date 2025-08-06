import argparse
import pathlib
import io
import sys
import signal
import queue
import logging.handlers

from .transcoder import TranscoderManager
from .video_manager import VideoManager
from .web import create_app
from .service_orchestrator import ServiceOrchestrator
from .tui import HostTUI


# Constants
NAME = "CrossStream Backend"
DEFAULT_PORT = 6001
DEFAULT_TRANSCODER_PORT = 6002
TRANSCODER_STOP_TIMEOUT = 5.0
TRANSCODER_FILENAME = 'transcode-wip2025.exe'


class StreamRedirection:
    """Context manager for redirecting stdout/stderr to a queue while preserving originals."""

    def __init__(self, output_log_queue):
        self.output_log_queue = output_log_queue
        self.original_stdout = None
        self.original_stderr = None

    def __enter__(self):
        # Save original streams
        self.original_stdout = sys.stdout
        self.original_stderr = sys.stderr

        # Create queue redirection class
        class _StreamToQueue(io.TextIOBase):
            def __init__(self, q):
                super().__init__()
                self._q = q

            def write(self, s: str):
                if s.strip():
                    self._q.put(s.rstrip("\n"))
                return len(s)

        # Redirect streams
        sys.stdout = _StreamToQueue(self.output_log_queue)
        sys.stderr = _StreamToQueue(self.output_log_queue)

        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        # Always restore original streams
        if self.original_stdout:
            sys.stdout = self.original_stdout
        if self.original_stderr:
            sys.stderr = self.original_stderr
        self._reset_terminal()

    def _reset_terminal(self):
        """Reset terminal to normal state to prevent control character issues."""
        sys.stdout.write('\033[0m')      # Reset all attributes
        sys.stdout.write('\033[?25h')    # Show cursor
        sys.stdout.write('\033[?1000l')  # Disable mouse tracking
        sys.stdout.write('\033[?1002l')  # Disable button event mouse tracking
        sys.stdout.write('\033[?1003l')  # Disable any motion mouse tracking
        sys.stdout.write('\033[?1006l')  # Disable SGR mouse mode
        sys.stdout.write('\033[?1015l')  # Disable urxvt mouse mode
        sys.stdout.write('\033[?47l')    # Use normal screen buffer
        sys.stdout.write('\033[?2004l')  # Disable bracketed paste mode
        sys.stdout.flush()


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description='Run the CrossStream backend server.')
    parser.add_argument('--host', type=str, required=True, help='Public address to send to peers (required)')
    parser.add_argument('--bind', type=str, default='0.0.0.0', help='Local address to bind the server to (default: 0.0.0.0)')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT, help=f'Port to run the server on (default: {DEFAULT_PORT})')
    parser.add_argument('--transcoder-port', type=int, default=DEFAULT_TRANSCODER_PORT,
                        help=f'Port for the transcoder (default: {DEFAULT_TRANSCODER_PORT})')
    parser.add_argument('--media-dir', type=pathlib.Path, required=True, help='Directory containing media files')
    parser.add_argument('--file-name', type=str, help='Partial file name to match in media directory (if not specified, uses latest file)')
    parser.add_argument('--force-timestamp-from-filename', action='store_true',
                        help='Extract timestamp from filename using pattern YYYY*MM*DD*HH*mm*SS instead of using file creation time')
    args = parser.parse_args()
    return args


def main() -> int:
    """Launch backend together with the Textual TUI."""
    # try:
    args = parse_arguments()

    # ------------------------------------------------------------------
    # Output log queue capturing *all* backend output for TUI display
    # ------------------------------------------------------------------
    output_log_queue = queue.Queue()

    # Route logging records to queue as well
    queue_handler = logging.handlers.QueueHandler(output_log_queue)  # type: ignore[attr-defined]
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    root_logger.addHandler(queue_handler)

    # resolve directories
    media_dir = pathlib.Path(args.media_dir).resolve()
    cache_dir = pathlib.Path('cache').resolve()
    tools_dir = pathlib.Path('tools').resolve()

    # Initialize managers
    video_manager = VideoManager(
        media_dir=media_dir,
        cache_dir=cache_dir,
        tools_dir=tools_dir,
        force_timestamp=args.force_timestamp_from_filename,
        file_name=args.file_name,
    )
    transcoder_manager = TranscoderManager(
        tools_dir=tools_dir,
        media_dir=media_dir,
        transcoder_port=args.transcoder_port,
        executable_name=TRANSCODER_FILENAME,
        stop_timeout=TRANSCODER_STOP_TIMEOUT,
        capture_output=True,
    )

    # ------------------------------------------------------------------
    # Restore graceful shutdown on SIGINT / SIGTERM
    # ------------------------------------------------------------------
    def _signal_handler(sig, frame):  # pylint: disable=unused-argument
        print("\nShutting down gracefully...")
        try:
            transcoder_manager.stop()
        finally:
            sys.exit(0)

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    # Create Flask app
    flask_app = create_app(
        host=args.host,
        port=args.port,
        transcoder_port=args.transcoder_port,
        video_manager=video_manager,
    )

    # Create service orchestrator
    service_orchestrator = ServiceOrchestrator(
        output_log_queue=output_log_queue,
        video_manager=video_manager,
        transcoder_manager=transcoder_manager,
        flask_app=flask_app,
        bind_address=args.bind,
        port=args.port
    )

    # Run TUI with stream redirection
    with StreamRedirection(output_log_queue):
        # Start backend services
        service_orchestrator.start()
        
        # Run TUI (simplified - no more internal service management)
        tui = HostTUI(output_log_queue, service_orchestrator)
        tui.run()
        
        # Stop backend services
        service_orchestrator.stop()

    # Streams are now automatically restored by context manager
    # Check if there was a startup error that needs to be displayed
    if HostTUI.startup_error:
        print("\n" + "=" * 80)
        print("ERROR DURING TUI STARTUP")
        print("=" * 80)
        print(HostTUI.startup_error)
        print("\nPress Enter to exit...")
        return 1

    return 0


if __name__ == '__main__':
    sys.exit(main())