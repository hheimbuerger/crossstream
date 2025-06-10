:: Set environment variables
SET "MY_PUBLIC_HOSTNAME=localhost"
SET "MY_BACKEND_PORT=7001"
SET "MY_TRANSCODER_PORT=7002"
SET "MY_VIDEO_PATH=..\test_videos\3b"

:: Run the backend.host module with UV
uv run -m backend.host %MY_PUBLIC_HOSTNAME%:%MY_BACKEND_PORT% "%MY_VIDEO_PATH%" %MY_TRANSCODER_PORT%
