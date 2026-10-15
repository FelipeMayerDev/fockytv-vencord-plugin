// SPDX-License-Identifier: GPL-3.0-or-later
import { findByCodeLazy } from "@webpack";
import { UserStore } from "@webpack/common";

import { retimeCamera } from "./camera-timing";

const acquireVideo = findByCodeLazy("addDirectVideoOutputSink") as (id: string) => { stream: MediaStream; release(): void; };
const applyBackground = findByCodeLazy("CAMERA_BACKGROUND_PREVIEW") as (option: unknown, id: string, options: { track: boolean; }) => Promise<void>;
const backgroundOption = findByCodeLazy("videoBackgroundFilterDesktop", "canUseCustomBackgrounds") as (user: unknown) => unknown;
let active: { deviceId: string; filterKey?: string; } | undefined;
let filterChanges: Promise<void> = Promise.resolve();

export function syncCameraFilter() {
    const camera = active;
    const change = filterChanges.catch(() => {}).then(async () => {
        if (!camera || active !== camera) return;
        const option = backgroundOption(UserStore.getCurrentUser());
        const key = JSON.stringify(option ?? null);
        if (camera.filterKey === key) return;
        await applyBackground(option, camera.deviceId, { track: false });
        camera.filterKey = key;
        console.info("FockyTV: fundo da câmera nativa aplicado", { filter: option == null ? "none" : typeof option === "object" ? "custom" : option });
    });
    filterChanges = change;
    return change;
}

export async function captureNativeCamera(deviceId: string) {
    const lease = acquireVideo(deviceId);
    const camera = { deviceId };
    active = camera;
    let capture: MediaStream | undefined;
    let timing: ReturnType<typeof retimeCamera> | undefined;
    const video = document.createElement("video");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const releaseVideo = () => {
        if (active === camera) active = undefined;
        timing?.stop();
        lease.release();
    };
    try {
        await syncCameraFilter();
        const track = lease.stream.getVideoTracks()[0];
        if (!track) throw new Error("A câmera nativa do Discord não forneceu vídeo.");
        // A sessão só pode parar a própria faixa, nunca a compartilhada com o preview do Discord.
        timing = retimeCamera(track);
        capture = new MediaStream([timing.track]);
        video.muted = true;
        video.srcObject = capture;
        await Promise.race([video.play(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("A câmera nativa do Discord não enviou imagens.")), 10_000);
        })]);
        console.info("FockyTV: câmera processada pronta", { width: video.videoWidth, height: video.videoHeight });
        return { capture, releaseVideo };
    } catch (error) {
        capture?.getTracks().forEach(track => track.stop());
        releaseVideo();
        throw error;
    } finally {
        clearTimeout(timer);
        video.pause();
        video.srcObject = null;
    }
}
