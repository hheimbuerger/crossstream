It does a couple of transcodes successfully. Then it runs into the telltale 'nvenc concurrency' error:
    
    2022/12/08 14:32:09 [h264_nvenc @ 00000273a548f1c0] OpenEncodeSessionEx failed: out of memory (10): (no details)
    2022/12/08 14:32:09 [h264_nvenc @ 00000273a548f1c0] No capable devices found
    2022/12/08 14:32:09 Error initializing output stream 0:1 -- Error while opening encoder for output stream #0:1 - maybe incorrect parameters such as bit_rate, rate, width or height
    2022/12/08 14:32:09 [h264_nvenc @ 00000282534df1c0] OpenEncodeSessionEx failed: out of memory (10): (no details)
    2022/12/08 14:32:09 [h264_nvenc @ 00000282534df1c0] No capable devices found
    2022/12/08 14:32:09 Error initializing output stream 0:1 -- Error while opening encoder for output stream #0:1 - maybe incorrect parameters such as bit_rate, rate, width or height

This is because consumer-grade Nvidia GPUs (I'm testing with a GTX 1050 and a GTX 1070) only allow 2 or 3 (apparently they increased this to 3 some time in 2021) simultaneous nvenc jobs.

As you can see from the logs, 

After that, go-transcode runs into some kind of hiccup where from now on until a restart, it only produces timeouts:
    
    1:32PM WRN media transcode timeouted module=hlsvod submodule=manager

I'm not sure why this is, but apparently it doesn't handle the ffmpeg failure all too well.