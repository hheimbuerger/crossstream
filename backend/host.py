import datetime
import pathlib
import re
import signal
import sys
import urllib.parse
import urllib.request

from flask import Flask, jsonify, send_from_directory, send_file

from .transcoder import TranscoderManager
from .video_manager import VideoManager
from .sprite_builder import SpriteBuilder


# Constants
NAME = "CrossStream Backend"
DEFAULT_PORT = 6001
DEFAULT_TRANSCODER_PORT = 6002
THUMBNAIL_WIDTH = 64
SECONDS_PER_THUMBNAIL = 5.0
TRANSCODER_STOP_TIMEOUT = 5.0
TRANSCODER_FILENAME = 'tools/transcode-concurrency-1.exe'



def create_app(host, port, transcoder_port, thumbnail_width, seconds_per_thumbnail, video_manager, transcoder_manager):
    """Create and configure the Flask application."""
    app = Flask(NAME, static_folder='frontend', static_url_path='')

    @app.route('/')
    def index():
        return send_from_directory(app.static_folder, 'player.html')

    @app.route('/config')
    def get_config():
        video_name = urllib.parse.quote(video_manager.video_path.name)
        stream_url = f'http://{host}:{transcoder_port}/vod/{video_name}/1080p.m3u8'
        thumbnail_url = f'http://{host}:{port}/thumbnail_sprite'
        return jsonify({
            'stream': stream_url,
            'thumbnailSprite': thumbnail_url,
            'timestamp': video_manager.timestamp.isoformat() if video_manager.timestamp else datetime.datetime.now().isoformat(),
            'thumbnailSeconds': seconds_per_thumbnail,
            'thumbnailPixelWidth': thumbnail_width,
        })

    @app.route('/thumbnail_sprite')
    def serve_thumbnail_sprite():
        thumbnail_path = video_manager.build_thumbnail_sprite(video_manager.video_path)
        return send_file(thumbnail_path, mimetype='image/jpeg')

    return app

def parse_arguments():
    """Parse command line arguments."""
    import argparse
    parser = argparse.ArgumentParser(description='Run the CrossStream backend server.')
    parser.add_argument('--host', type=str, required=True, help='Public address to send to peers (required)')
    parser.add_argument('--bind', type=str, default='0.0.0.0', help='Local address to bind the server to (default: 0.0.0.0)')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT, help=f'Port to run the server on (default: {DEFAULT_PORT})')
    parser.add_argument('--transcoder-port', type=int, default=DEFAULT_TRANSCODER_PORT, 
                        help=f'Port for the transcoder (default: {DEFAULT_TRANSCODER_PORT})')
    parser.add_argument('--media-dir', type=pathlib.Path, required=True, help='Directory containing media files')
    args = parser.parse_args()
    return args

def main():
    """Main entry point."""
    args = parse_arguments()

    media_dir = pathlib.Path(args.media_dir)
    tools_dir = pathlib.Path('tools')
    cache_dir = pathlib.Path('cache')

    # Create managers
    sprite_builder_manager = SpriteBuilder(tools_dir=tools_dir)
    video_manager = VideoManager(
        media_dir=media_dir,
        cache_dir=cache_dir,
        tools_dir=tools_dir,
        sprite_builder_manager=sprite_builder_manager,
        thumbnail_width=THUMBNAIL_WIDTH,
        seconds_per_thumbnail=SECONDS_PER_THUMBNAIL
    )
    transcoder_manager = TranscoderManager(
        tools_dir=tools_dir,
        media_dir=media_dir,
        transcoder_port=args.transcoder_port,
        executable_name=TRANSCODER_FILENAME,
        stop_timeout=TRANSCODER_STOP_TIMEOUT
    )

    try:
        # Start transcoder
        print("Starting transcoder...")
        transcoder_manager.start()

        # Register signal handlers
        def signal_handler(sig, frame):
            print("\nShutting down gracefully...")
            transcoder_manager.stop()
            sys.exit(0)
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)

        # Find the latest video and build its thumbnail sprite
        video_path = video_manager.find_latest_video()
        if not video_path or not video_path.exists():
            raise FileNotFoundError(f"No valid video file found in {media_dir}")
        video_manager.build_thumbnail_sprite(video_path)

        # Create and run Flask app
        app = create_app(args.host, args.port, args.transcoder_port, THUMBNAIL_WIDTH, SECONDS_PER_THUMBNAIL, video_manager, transcoder_manager)

        print(f"Starting server on http://{args.host}:{args.port}")
        app.run(host=args.bind, port=args.port)
    except KeyboardInterrupt:
        print("\nShutdown requested by user")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    finally:
        transcoder_manager.stop()
    return 0

if __name__ == '__main__':
    sys.exit(main())