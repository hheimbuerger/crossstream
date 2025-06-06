import datetime
import functools
import sys
import http, http.server
import json
import urllib, urllib.request, urllib.parse
import pathlib
import re
import time
import subprocess

import sprite_builder


THUMBNAIL_WIDTH = 64
SECONDS_PER_THUMBNAIL = 5.0
TRANSCODER_FILENAME = '../go-transcode/go-transcode'


FILENAME_REGEX = re.compile('Hunt  Showdown (?P<year>\d{4}).(?P<month>\d{2}).(?P<day>\d{2}) - (?P<hour>\d{2}).(?P<minute>\d{2}).(?P<second>\d{2}).(?P<millisecond>\d{2,3})\.mp4')


last_message = None
transcode_proc = None


class MyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        self.routing_table = {
            '/config': self.process_config,
            '/thumbnailsprite': self.process_thumbnailsprite,
            '/join': self.process_join,
            '/status': self.process_status,
            '/sync': self.process_sync,
            '/stream': self.process_stream,
            '/': '/player.html',
        }

        super().__init__(*args, directory='.', **kwargs)

    def _router(self):
        parsed_url = urllib.parse.urlparse(self.path)
        query_parameters = urllib.parse.parse_qs(parsed_url.query)
        route = self.routing_table.get(parsed_url.path)
        # HACK: temporary support for matching partial path
        if parsed_url.path.startswith('/stream'):
            return self.routing_table['/stream'], query_parameters
        return route, query_parameters

    def _respond_success_json(self, data):
        self.send_response(200)
        self.send_header('Response-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def process_config(self, query_parameters):
        local_stream = f'{VOD_BASE_PATH}1080p.m3u8'
        # local_stream = "test_videos/h/henrik.m3u8"
        # local_stream = "stream/manifest"
        # remote_stream = "test_videos/s/sebastian.m3u8"
        # relative_path = str(thumbnail_sprite.relative_to(pathlib.Path())).replace('\\', '/')
        # local_thumbnail_sprite = f'http://{LOCAL_HOST}:{LOCAL_PORT}/{relative_path}'
        local_thumbnail_sprite = f'http://{LOCAL_HOST}:{TRANSCODER_PORT}/thumbnail_sprite.jpeg'
        # remote_thumbnail_sprite = "test_videos/s/sebastian.jpeg"
        offsetSeconds = 4.0   # should be: 30.02 - 11.18 = 19! ???

        # self._respond_success_json({
        #     'streams': [
        #         local_stream,
        #         remote_stream,
        #     ],
        #     'thumbnailSprites': [
        #         local_thumbnail_sprite,
        #         remote_thumbnail_sprite,
        #     ],
        #     'offsetSeconds': offsetSeconds,
        #     'thumbnailSeconds': SECONDS_PER_THUMBNAIL,
        #     'thumbnailPixelWidth': THUMBNAIL_WIDTH,
        # })
        self._respond_success_json({
            'stream': local_stream,
            'thumbnailSprite': local_thumbnail_sprite,
            'timestamp': TIMESTAMP.isoformat(),
            'thumbnailSeconds': SECONDS_PER_THUMBNAIL,
            'thumbnailPixelWidth': THUMBNAIL_WIDTH,
        })

    def process_join(self, query_parameters, payload):
        remote_host = payload['remote_host']
        remote_port = payload['remote_port']
        filename = payload['video_filename']
        timestamp = payload['timestamp']

    def process_thumbnailsprite(self, query_parameter):
        # self.path =
        super().do_GET()

    def process_stream(self, query_parameters):
        timer = time.perf_counter()

        # pass the JIT stream segment requests through to the go-transcode instance
        path_component = self.path[8:]
        forward_url =  + ('1080p.m3u8' if path_component == 'manifest' else path_component)
        headers = self.headers
        headers.add_header('X-Forwarded-For', self.client_address[0])
        req = urllib.request.Request(url=forward_url, headers=headers)

        # TODO: this entire terrible block just because Python decided that a 304 should raise an HTTPError...
        status, headers, payload = None, None, None
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                status = r.status
                headers = r.headers
                payload = r.read()
        except urllib.error.HTTPError as e:
            if e.status == 304:
                status = e.status
                headers = e.headers
            else:
                raise

        # proxy status, headers and payload through
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        if payload: self.wfile.write(payload)
        print(f'Proxied stream segment in {time.perf_counter() - timer:.2f}s')

    def process_sync(self, query_parameters, payload):
        # is remote call: store last message as new change request
        if 'remote' in query_parameters:
            global last_message
            last_message = payload
            print(f'Storing new message for pickup: {repr(last_message)}')

        # is local call: pass message to the remote server
        else:
            remote_url = f'http://{REMOTE_HOST}:{REMOTE_PORT}/sync?remote=true'
            print(f'Passing message to remote server {remote_url}: {repr(payload)}')
            req = urllib.request.Request(method='POST', url=remote_url, data=json.dumps(payload).encode('utf-8'))
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    pass
            # except TimeoutError:
                # print('Could not reach remote server')
            except urllib.error.URLError:
                print('Could not reach remote server (URLError)')

        # send response
        self._respond_success_json({'received': 'ok'})

    def process_status(self, query_parameters):
        global last_message
        self._respond_success_json(last_message or {})
        last_message = None

    # hack from https://stackoverflow.com/a/13354482/6278 to enable CORS on this server
    def send_my_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
    def end_headers(self):
        self.send_my_headers()
        super().end_headers()

    # GET handler
    def do_GET(self):
        route, query_parameters = self._router()

        if isinstance(route, str):
            self.path = route
        elif route:
            route(query_parameters)
            return

        # serve files from the filesystem
        super().do_GET()

    def do_POST(self):
        # parse POST body
        length = int(self.headers.get('content-length'))
        data = self.rfile.read(length)
        payload = json.loads(data.decode('utf-8'))

        route, query_parameters = self._router()
        if route:
            return route(query_parameters, payload)

        self.send_error(http.HTTPStatus.NOT_IMPLEMENTED, "Unsupported method (%r)" % self.command)
        return


def extract_geforce_experience_date(filename):
    result = FILENAME_REGEX.match(filename)
    values = {k: int(v) for k, v in result.groupdict().items()}
    values['microsecond'] = values['millisecond'] * (10**3 if len(result.groupdict()['millisecond'])==3 else 10**2)
    del values['millisecond']
    return datetime.datetime(**values)


def run_transcode_in_background(port=8888):
    global transcode_proc
    config_template = pathlib.Path('config.yaml.template')
    config_file = MEDIA_DIR / 'config.yaml'
    with open(config_template, 'r') as f:
        config = f.read().format(media_dir=str(MEDIA_DIR).replace('\\', '/'), transcoder_port=port)
        with open(config_file, 'w') as out:
            out.write(config)
    transcode_proc = subprocess.Popen([TRANSCODER.resolve(), 'serve', '--config', config_file.resolve()], shell=True)


def determine_latest_video():
    hunt_videos = [f for f in MEDIA_DIR.iterdir() if f.is_file() and FILENAME_REGEX.match(f.name)]
    if not hunt_videos:
        print('Error: No valid videos found in media directory!')
        sys.exit(1)
    newest_video = functools.reduce(lambda x, y: x if extract_geforce_experience_date(x.name) > extract_geforce_experience_date(y.name) else y, hunt_videos)
    #print('Newest video found is from: ' + extract_geforce_experience_date(newest_video.name).isoformat())
    return newest_video


if len(sys.argv) < 2:
    print('Syntax: python host.py external_ip:public_port [relative_path_to_video_directory [transcoder_port]]')
    sys.exit(400)


split_host_port = lambda x: (x.split(':')[0], int(x.split(':')[1]))
LOCAL_HOST, LOCAL_PORT = split_host_port(sys.argv[1])
#REMOTE_HOST, REMOTE_PORT = split_host_port(sys.argv[2])
MEDIA_DIR = pathlib.Path(sys.argv[2] if len(sys.argv) >= 3 else '.')
TRANSCODER_PORT = int(sys.argv[3]) if len(sys.argv) >= 4 else 8888
TRANSCODER = pathlib.Path(TRANSCODER_FILENAME)
VIDEO = determine_latest_video()
TIMESTAMP = extract_geforce_experience_date(VIDEO.name)
VOD_BASE_PATH = f'http://{LOCAL_HOST}:{TRANSCODER_PORT}/vod/{urllib.parse.quote(VIDEO.name)}/'
print(f'LOCAL_HOST: ({LOCAL_HOST}, {LOCAL_PORT})')
print(f'MEDIA_DIR: {MEDIA_DIR.resolve()}')
print(f'TRANSCODER: {TRANSCODER.resolve()}')
print(f'TRANSCODER_PORT: {TRANSCODER_PORT}')
print(f'VIDEO: {VIDEO.resolve()}')
print(f'TIMESTAMP: {TIMESTAMP.isoformat()}')
print()

print('Spawning on-demand transcoder...')
run_transcode_in_background(TRANSCODER_PORT)
time.sleep(1)      # let it print some initialization output here
print()

print('Building thumbnail sprite (may take a few seconds)...')
thumbnail_sprite = VIDEO.with_name('thumbnail_sprite.jpeg')
if thumbnail_sprite.is_file():
    print('  Found existing thumbnail sprite, using that.')
else:
    sprite_builder.build_sprite(VIDEO, thumbnail_sprite, seconds_per_thumbnail=SECONDS_PER_THUMBNAIL, thumbnail_height=THUMBNAIL_WIDTH)
    print('  Complete.')

print()
try:
    print(f'Running server on http://{LOCAL_HOST}:{LOCAL_PORT}/')
    httpd = http.server.HTTPServer(('', LOCAL_PORT), MyHTTPRequestHandler)
    httpd.serve_forever()
finally:
    if transcode_proc:
        transcode_proc.kill()
