// SPDX-License-Identifier: GPL-3.0-or-later
import jettaImage from "file://./jetta.png?base64";

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
    let context: AudioContext | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const stop = () => {
        clearTimeout(timer);
        overlay.remove();
        if (context && context.state !== "closed") void context.close().catch(error => console.warn("FockyTV: encerrar som do Jetta", error));
    };
    timer = setTimeout(stop, JETTA_DURATION);
    try {
        context = new AudioContext();
        const engine = context.createOscillator();
        const turbo = context.createOscillator();
        const filter = context.createBiquadFilter();
        const volume = context.createGain();
        const turboVolume = context.createGain();
        const time = context.currentTime;
        engine.type = "sawtooth";
        engine.frequency.setValueAtTime(45, time);
        engine.frequency.exponentialRampToValueAtTime(170, time + 1.3);
        engine.frequency.exponentialRampToValueAtTime(85, time + 1.5);
        engine.frequency.exponentialRampToValueAtTime(240, time + 2.5);
        filter.type = "lowpass";
        filter.frequency.value = 1100;
        volume.gain.setValueAtTime(0, time);
        volume.gain.linearRampToValueAtTime(0.16, time + 0.2);
        volume.gain.setValueAtTime(0.16, time + 2);
        volume.gain.linearRampToValueAtTime(0, time + 2.9);
        engine.connect(filter).connect(volume).connect(context.destination);
        turbo.frequency.setValueAtTime(700, time);
        turbo.frequency.exponentialRampToValueAtTime(2400, time + 1.4);
        turbo.frequency.exponentialRampToValueAtTime(500, time + 2.9);
        turboVolume.gain.value = 0.025;
        turbo.connect(turboVolume).connect(volume);
        engine.start();
        turbo.start();
        engine.stop(time + 2.9);
        turbo.stop(time + 2.9);
        void context.resume().catch(error => console.warn("FockyTV: som do Jetta", error));
    } catch (error) {
        console.warn("FockyTV: som do Jetta indisponível", error);
    }
    return stop;
}
