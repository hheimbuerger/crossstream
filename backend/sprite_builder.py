import subprocess
import fractions
import time


def _run_ffprobe(*arguments, cwd=None):
    result = subprocess.run((cwd / "ffprobe",) + arguments, capture_output=True)
    return result.stdout

def _determine_parameters(filename, parameters, cwd=None):
    timer = time.perf_counter()
    result = _run_ffprobe(
        "-v", "error",
        "-select_streams", "v",
        "-show_entries", parameters,
        "-of", "default=noprint_wrappers=1:nokey=0",
        filename,
        cwd=cwd
    ).decode('ascii').strip()
    print(f'  ffprobe time: {time.perf_counter() - timer:.2f}s')
    return {pair.split('=')[0].strip(): pair.split('=')[1].strip() for pair in result.split('\n')}

def _probe_video(filename, cwd=None):
    keyvals = _determine_parameters(filename, "format=duration:stream=r_frame_rate", cwd=cwd)
    duration = float(keyvals['duration'])
    numerator, denominator = keyvals['r_frame_rate'].split('/')
    fps = fractions.Fraction(numerator=int(numerator),
                            denominator=int(denominator))
    print(f'  duration: {duration}, fps: {fps}')
    return duration, fps

def _build_thumbnail_sprite(input, output, seconds_per_shot, num_tiles, scale='128:72', debug=False, cwd=None):
    debug_arguments = (
        '-hide_banner', '-loglevel', 'info', '-stats',
    ) if debug else ()
    arguments = (
        #'-hwaccel', 'cuda',
        '-hwaccel', 'nvdec',   # couldn't detect any speed differences between cuda and nvdec
        '-discard', 'nokey',        # according to https://stackoverflow.com/a/71879201/6278, probably alias of -skip_frame, using both for good measure
        '-skip_frame', 'nokey',     # according to https://ffmpeg.org/ffmpeg-filters.html#Examples-127, -tile documentation of ffmpeg, but otherwise undocumented
        '-i', input,
        #'-pix_fmt', 'yuvj422p',
        #'-filter_complex', f"select='eq(pict_type,I)*not(mod(n,{frame_interval}))',scale={scale},tile={num_tiles}x1",
        '-filter:v', f"fps=1/{seconds_per_shot},scale={scale},tile={num_tiles}x1",
        '-frames:v', '1',
        '-qscale:v', '3',   # quality, less is higher
        '-vsync', '0',
        '-an',   # block audio streams
        '-y',   # TODO: for debugging: overwrite output!
        output
    )
    timer = time.perf_counter()
    results = subprocess.run((cwd / 'ffmpeg',) + debug_arguments + arguments, capture_output=True)
    print(f'  ffmpeg time: {time.perf_counter() - timer:.2f}s')
    return results.returncode == 0, results.stderr

def build_sprite(video_path, sprite_path, seconds_per_thumbnail, thumbnail_height, cwd=None):
    thumbnail_width = thumbnail_height / 9 * 16
    duration, fps = _probe_video(video_path, cwd=cwd)

    frame_interval = seconds_per_thumbnail * fps
    frame_count = int(duration * fps)
    num_tiles = int(frame_count // frame_interval)

    result = _build_thumbnail_sprite(video_path, sprite_path, seconds_per_thumbnail, num_tiles, scale=f'{thumbnail_width}:{thumbnail_height}', debug=True, cwd=cwd)
    if not result:
        print('Error running ffmpeg:')
        print(result.stderr)


if __name__ == '__main__':
    # ffmpeg ^
    #     -i "%1" ^
    #     -filter_complex "select='not(mod(n,300))',scale=128:72,tile=120x1" ^
    #     -frames:v 1 -qscale:v 3 ^
    #     -an "%2/thumbnail_sprite.jpeg"

    # video_path = "h\Hunt  Showdown 2022.11.07 - 21.51.11.18.mp4"
    # sprite_path = "h\henrik.jpeg"
    video_path = "s\Hunt  Showdown 2022.11.07 - 21.51.30.02.mp4"
    sprite_path = "s\sebastian.jpeg"

    keyvals = determine_parameters(video_path, )

    build_thumbnail_sprite(video_path, sprite_path, SECONDS_PER_SHOT, num_tiles)
