Fixtures for local and staging browser publishing journeys. The HTML and 1×1 GIF are synthetic test data. `clip.mp4` is a silent, two-second blue H.264 video generated with:

```sh
ffmpeg -f lavfi -i color=c=blue:s=64x64:r=12 -t 2 -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart clip.mp4
```

The video is checked in so QA does not require ffmpeg. Tests verify decoding, playback, and seeking, rather than only an MP4 header.
