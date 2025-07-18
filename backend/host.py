import argparse
import datetime
import pathlib
import sys
import urllib.parse
import urllib.request
import os

from flask import Flask, jsonify, send_from_directory, send_file

from .transcoder import TranscoderManager
from .video_manager import VideoManager
from .sprite_builder import SpriteBuilder

from .tui import HostTUI


# Constants
NAME = "CrossStream Backend"
DEFAULT_PORT = 6001
DEFAULT_TRANSCODER_PORT = 6002
THUMBNAIL_WIDTH = 64
SECONDS_PER_THUMBNAIL = 5.0
TRANSCODER_STOP_TIMEOUT = 5.0
TRANSCODER_FILENAME = 'transcode-wip2025.exe'


def create_app(host, port, transcoder_port, thumbnail_width, seconds_per_thumbnail, video_manager, transcoder_manager):
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
            profile = '2h' if '2h' in directories else '2s' if '2s' in directories else '1080p'
            stream_url = f'http://{host}:{transcoder_port}/vod/{video_name}/{profile}.m3u8'
            thumbnail_url = f'http://{host}:{port}/thumbnail_sprite'
            return jsonify({
                'stream': stream_url,
                'thumbnailSprite': thumbnail_url,
                'timestamp': video_manager.timestamp.isoformat() if video_manager.timestamp else datetime.datetime.now().isoformat(),
                'thumbnailSeconds': seconds_per_thumbnail,
                'thumbnailPixelWidth': thumbnail_width,
            })
        except Exception as e:
            app.logger.error(f"Error in get_config: {str(e)}")
            return jsonify({"error": str(e)}), 500

    @app.route('/thumbnail_sprite')
    def serve_thumbnail_sprite():
        thumbnail_path = video_manager.build_thumbnail_sprite(video_manager.video_path)
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
        args = parse_arguments()
        
        tools_dir = pathlib.Path('tools')
        cache_dir = pathlib.Path('cache')
        media_dir = pathlib.Path(args.media_dir).absolute()

        # Initialize managers
        sprite_builder = SpriteBuilder(tools_dir=tools_dir)
        video_manager = VideoManager(
            media_dir=media_dir,
            cache_dir=cache_dir,
            tools_dir=tools_dir,
            sprite_builder_manager=sprite_builder,
            thumbnail_width=THUMBNAIL_WIDTH,
            seconds_per_thumbnail=SECONDS_PER_THUMBNAIL,
        )

        transcoder_manager = TranscoderManager(
            tools_dir=tools_dir,
            media_dir=media_dir,
            transcoder_port=args.transcoder_port,
            executable_name=TRANSCODER_FILENAME,
            stop_timeout=TRANSCODER_STOP_TIMEOUT,
            capture_output=True,
        )

        # Create Flask app
        flask_app = create_app(
            host=args.host,
            port=args.port,
            transcoder_port=args.transcoder_port,
            thumbnail_width=THUMBNAIL_WIDTH,
            seconds_per_thumbnail=SECONDS_PER_THUMBNAIL,
            video_manager=video_manager,
            transcoder_manager=transcoder_manager,
        )

        # Run TUI (blocks until exit)
        tui = HostTUI(flask_app, args.bind, args.port, transcoder_manager)
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