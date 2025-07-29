import os
import urllib.parse
from flask import Flask, jsonify, send_from_directory, send_file


def create_app(host, port, transcoder_port, video_manager):
    """Create and configure the Flask application."""
    app = Flask(__name__)

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
            chapter_times = [chapter['start_time'] for chapter in video_manager.chapters]

            return jsonify({
                'stream': stream_url,
                'timestamp': video_manager.timestamp.isoformat(),
                'duration': video_manager.duration,
                'chapters': chapter_times,
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
        thumbnail_path = video_manager.thumbnail_sprite_path
        return send_file(thumbnail_path, mimetype='image/jpeg')

    return app
