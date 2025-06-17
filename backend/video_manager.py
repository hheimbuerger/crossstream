import datetime
from pathlib import Path
from typing import Optional
from .sprite_builder import SpriteBuilder

class VideoManager:
    """Handles video file operations and thumbnail generation."""
    def __init__(self, media_dir: Path, cache_dir: Path, tools_dir: Path, sprite_builder_manager: SpriteBuilder, thumbnail_width: int = 64, seconds_per_thumbnail: float = 5.0):
        self.media_dir = media_dir
        self.cache_dir = cache_dir
        self.tools_dir = tools_dir
        self.thumbnail_width = thumbnail_width
        self.seconds_per_thumbnail = seconds_per_thumbnail
        self.sprite_builder_manager = sprite_builder_manager
        self.video_path: Optional[Path] = None
        self.timestamp: Optional[datetime.datetime] = None

    def find_latest_video(self) -> Path:
        """Find and return the most recently created video file."""
        video_extensions = {'.mp4', '.mov', '.avi', '.mkv', '.wmv'}
        video_files = [
            f for f in self.media_dir.iterdir()
            if f.is_file() and f.suffix.lower() in video_extensions
        ]
        if not video_files:
            raise FileNotFoundError("No video files found in media directory")
        self.video_path = max(video_files, key=lambda f: f.stat().st_ctime)
        self.timestamp = self._get_file_creation_time(self.video_path)
        print(f'Using most recently created video: {self.video_path.name} (created: {self.timestamp.isoformat()})')
        return self.video_path

    def build_thumbnail_sprite(self, video_path: Optional[Path] = None) -> Path:
        """Build and return path to thumbnail sprite."""
        video_path = video_path or self.video_path
        if not video_path:
            raise ValueError("No video path provided and no default video set")
        thumbnail_path = self.cache_dir / f"{video_path.stem}.thumbnail.jpeg"
        if not thumbnail_path.exists():
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self.sprite_builder_manager.submit_job(
                str(video_path),
                str(thumbnail_path),
                self.seconds_per_thumbnail,
                self.thumbnail_width
            )
        return thumbnail_path

    @staticmethod
    def _get_file_creation_time(filepath: Path) -> datetime.datetime:
        """Get file creation time as timezone-aware datetime."""
        creation_time = filepath.stat().st_ctime
        return datetime.datetime.fromtimestamp(creation_time, datetime.timezone.utc).astimezone()
