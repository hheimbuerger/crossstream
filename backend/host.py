import argparse
import datetime
import pathlib
import io
import sys
import urllib.parse
import urllib.request
import os
import signal

from flask import Flask, jsonify, send_from_directory, send_file

from .transcoder import TranscoderManager
from .video_manager import VideoManager
from .sprite_builder import SpriteBuilder

from .tui import HostTUI


# Constants
NAME = "CrossStream Backend"
DEFAULT_PORT = 6001
DEFAULT_TRANSCODER_PORT = 6002
TRANSCODER_STOP_TIMEOUT = 5.0
TRANSCODER_FILENAME = 'transcode-wip2025.exe'


def create_app(host, port, transcoder_port, video_manager, transcoder_manager):
    """Create and configure the Flask application."""
    app = Flask(__name__)

    # Ensure we have a video file before setting up routes
    try:
        video_path = video_manager.find_latest_video()
        app.logger.info(f"Using video file: {video_path}")
    except Exception as e:
        app.logger.error(f"Failed to find video file: {e}")
        raise

    FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'frontend'))

    @app.route('/')
    def index():
        return send_from_directory(FRONTEND_DIR, 'player.html')

    @app.route('/<path:filename>')
    def frontend_files(filename):
        return send_from_directory(FRONTEND_DIR, filename)

    @app.route('/config')
    def get_config():
        if not video_manager.video_path:
            return jsonify({"error": "No video file available"}), 500

        try:
            video_name = urllib.parse.quote(video_manager.video_path.name)
            directories = video_manager.video_path.parts
            profile = '2h' if '2h' in directories else '2s' if '2s' in directories else '2h'
            stream_url = f'http://{host}:{transcoder_port}/vod/{video_name}/{profile}.m3u8'
            thumbnail_url = f'http://{host}:{port}/thumbnail_sprite'
            return jsonify({
                'stream': stream_url,
                'timestamp': video_manager.timestamp.isoformat(),
                'duration': 60,
                'thumbnailSprite': thumbnail_url,
                'thumbnailSeconds': video_manager.seconds_per_thumbnail,
                'thumbnailPixelWidth': video_manager.thumbnail_width,
                'thumbnailPixelHeight': video_manager.thumbnail_height,
            })
        except Exception as e:
            app.logger.error(f"Error in get_config: {str(e)}")
            return jsonify({"error": str(e)}), 500

    @app.route('/thumbnail_sprite')
    def serve_thumbnail_sprite():
        thumbnail_path = video_manager.build_thumbnail_sprite()
        return send_file(thumbnail_path, mimetype='image/jpeg')

    return app


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description='Run the CrossStream backend server.')
    parser.add_argument('--host', type=str, required=True, help='Public address to send to peers (required)')
    parser.add_argument('--bind', type=str, default='0.0.0.0', help='Local address to bind the server to (default: 0.0.0.0)')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT, help=f'Port to run the server on (default: {DEFAULT_PORT})')
    parser.add_argument('--transcoder-port', type=int, default=DEFAULT_TRANSCODER_PORT, 
                        help=f'Port for the transcoder (default: {DEFAULT_TRANSCODER_PORT})')
    parser.add_argument('--media-dir', type=pathlib.Path, required=True, help='Directory containing media files')
    args = parser.parse_args()
    return args


def main() -> int:
    """Launch backend together with the Textual TUI."""
    try:
        import queue, logging
        args = parse_arguments()

        # ------------------------------------------------------------------
        # Backend log queue capturing *all* initialization & Flask output
        # ------------------------------------------------------------------
        flask_queue: "queue.Queue[str]" = queue.Queue()

        # Send stdio to queue so plain prints appear in Backend Log
        class _StreamToQueue(io.TextIOBase):
            def __init__(self, q: "queue.Queue[str]"):
                super().__init__()
                self._q = q

            def write(self, s: str):
                if s.strip():
                    self._q.put(s.rstrip("\n"))
                return len(s)
        sys.stdout = _StreamToQueue(flask_queue)  # type: ignore
        sys.stderr = _StreamToQueue(flask_queue)  # type: ignore

        # Route logging records to queue as well
        queue_handler = logging.handlers.QueueHandler(flask_queue)  # type: ignore[attr-defined]
        root_logger = logging.getLogger()
        root_logger.setLevel(logging.INFO)
        root_logger.addHandler(queue_handler)

        media_dir = pathlib.Path(args.media_dir).resolve()
        cache_dir = pathlib.Path('cache').resolve()
        tools_dir = pathlib.Path('tools').resolve()

        # Initialize managers
        sprite_builder = SpriteBuilder(tools_dir=tools_dir)
        video_manager = VideoManager(
            media_dir=media_dir,
            cache_dir=cache_dir,
            tools_dir=tools_dir,
            sprite_builder_manager=sprite_builder,
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
        def _signal_handler(sig, frame):  # type: ignore[unused-argument]
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
            transcoder_manager=transcoder_manager,
        )

        # Run TUI (blocks until exit)
        tui = HostTUI(flask_app, args.bind, args.port, transcoder_manager, flask_queue)
        tui.run()
        return 0

    except Exception as e:
        # If we get here, the TUI couldn't even start
        import traceback
        print("\n" + "=" * 80)
        print("FATAL ERROR: The application could not start")
        print("=" * 80)
        traceback.print_exc()
        print("\nPress Enter to exit...")
        input()
        return 1


if __name__ == '__main__':
    sys.exit(main())