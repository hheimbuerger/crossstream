# Interesting Links

* Detailed discussion how Emby/Dim handles JIT transcoding: https://www.reddit.com/r/ffmpeg/comments/royan4/how_do_media_centers_like_emby_achieve_video/ ("If done naively seeking will not work as we have to wait for the entire video to be transcoded. To fix this we can just restart ffmpeg with a new timestamp offset when the client requests a chunk that is not available (and will not be available for quite some time).")

