// SPDX-License-Identifier: GPL-3.0-or-later
import jettaImage from "file://./jetta.png?base64";
import jettaAudio from "file://./jetta.mp3?base64";

export const JETTA_DURATION = 3000;
export const JETTA_COOLDOWN = 60_000;

// Snapshot por canal: mute, câmera e eventos sintéticos não são novas entradas.
export function jettaEntrance(play: () => void, now = Date.now) {
    let channel: string | null | undefined;
    let present = new Set<string>();
    let lastPlayed = -Infinity;
    let initialized = false;
    return (channelId: string | null | undefined, users: string[], selfId?: string) => {
        const joined = !!channelId && initialized && (channelId === channel
            ? users.some(id => !present.has(id))
            : !!selfId && users.includes(selfId));
        initialized = true;
        channel = channelId;
        present = new Set(users);
        const time = now();
        if (!joined || time - lastPlayed < JETTA_COOLDOWN) return;
        lastPlayed = time;
        play();
    };
}

export function showJetta() {
    const overlay = document.createElement("div");
    overlay.className = "fockytv-jetta";
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-label", "huestavo chegou de Jetta turbo!");
    overlay.innerHTML = `<img class="fockytv-jetta-car" src="data:image/png;base64,${jettaImage}" alt="" aria-hidden="true">`;
    document.body.append(overlay);
    let audio: HTMLAudioElement | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const stop = () => {
        clearTimeout(timer);
        overlay.remove();
        audio?.pause();
        audio?.removeAttribute("src");
    };
    timer = setTimeout(stop, JETTA_DURATION);
    try {
        audio = new Audio(`data:audio/mpeg;base64,${jettaAudio}`);
        void audio.play().catch(error => console.warn("FockyTV: som do Jetta", error));
    } catch (error) {
        console.warn("FockyTV: som do Jetta indisponível", error);
    }
    return stop;
}
