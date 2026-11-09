#!/usr/bin/env bash
# FFmpeg do benchmark: o startCapture real chama este script no lugar do ffmpeg.exe. Troca a captura do Windows
# (gfxcapture) por quadros crus do FIFO $BENCH_FIFO e o NVENC por libx264, mantendo as flags de taxa/GOP/IDR do plugin.
# O muxer WHIP e o receptor passam sem mudança.
args=()
while (($#)); do
    case "$1" in
        gfxcapture=*) unset 'args[-1]' 'args[-1]' 'args[-1]' # tira "-f lavfi -i"
            args+=(-f rawvideo -pix_fmt yuv420p -video_size "$BENCH_SIZE" -framerate "$BENCH_FPS" -i "$BENCH_FIFO") ;;
        h264_nvenc) args+=(libx264) ;;
        p4) args+=(ultrafast) ;;
        ull) args+=(zerolatency) ;;
        -rc) shift ;; # "-rc cbr" do NVENC; no libx264 o teto vem de -maxrate/-bufsize
        *) args+=("$1") ;;
    esac
    shift
done
exec ffmpeg "${args[@]}"
