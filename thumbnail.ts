// SPDX-License-Identifier: GPL-3.0-or-later
export async function thumbnail(media: MediaStream, width = 320) {
    const height = Math.round(width * 9 / 16);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    try {
        await new Promise<void>((resolve, reject) => {
            const fail = (error: unknown) => { clearTimeout(timer); reject(error); };
            const timer = setTimeout(() => fail(new Error("A live não enviou uma imagem para a miniatura.")), 8000);
            video.onloadeddata = () => { clearTimeout(timer); resolve(); };
            video.onerror = () => fail(new Error("Não foi possível ler a imagem da live."));
            video.srcObject = media;
            void video.play().catch(fail);
        });
        if (!video.videoWidth || !video.videoHeight) throw new Error("A live não tem imagem.");
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas indisponível.");
        context.fillStyle = "black";
        context.fillRect(0, 0, width, height);
        const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
        const drawn = { width: video.videoWidth * scale, height: video.videoHeight * scale };
        context.drawImage(video, (width - drawn.width) / 2, (height - drawn.height) / 2, drawn.width, drawn.height);
        return canvas.toDataURL("image/jpeg", 0.7);
    } finally {
        video.onloadeddata = video.onerror = null;
        video.pause();
        video.srcObject = null;
    }
}
