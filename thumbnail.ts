// SPDX-License-Identifier: GPL-3.0-or-later
export async function thumbnail(media: MediaStream) {
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
        canvas.width = 320; canvas.height = 180;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas indisponível.");
        context.fillStyle = "black";
        context.fillRect(0, 0, 320, 180);
        const scale = Math.min(320 / video.videoWidth, 180 / video.videoHeight);
        const width = video.videoWidth * scale, height = video.videoHeight * scale;
        context.drawImage(video, (320 - width) / 2, (180 - height) / 2, width, height);
        return canvas.toDataURL("image/jpeg", 0.7);
    } finally {
        video.onloadeddata = video.onerror = null;
        video.pause();
        video.srcObject = null;
    }
}
