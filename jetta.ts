// SPDX-License-Identifier: GPL-3.0-or-later
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
    overlay.innerHTML = `<div class="fockytv-jetta-car">
        <span>HUESTAVO CHEGOU!</span>
        <svg viewBox="0 0 640 240" aria-hidden="true">
            <defs><linearGradient id="fockytv-jetta-paint" x2="0" y2="1"><stop stop-color="#f3f5fa"/><stop offset="1" stop-color="#64748b"/></linearGradient></defs>
            <path d="M5 145h100M20 170h65M0 195h80" stroke="#fbbf24" stroke-width="8" stroke-linecap="round"/>
            <path d="M85 167l-40-13 30 31-40 16 58-3" fill="#fb923c"/>
            <path d="M90 145l32-29 94-15 69-63h147l83 70 81 20 20 30v38H90Z" fill="url(#fockytv-jetta-paint)" stroke="#1e293b" stroke-width="5"/>
            <path d="M237 100l58-50h53v50Zm124-50h62l60 50H361Z" fill="#172554" stroke="#94a3b8" stroke-width="3"/>
            <path d="M352 108v71M496 116l9 66M102 157h506" fill="none" stroke="#475569" stroke-width="3"/>
            <path d="M112 130h34v19h-42M551 135l43 11v13h-43" fill="#fef3c7"/>
            <path d="M579 166h33v17h-33M373 119h24" stroke="#0f172a" stroke-width="6"/>
            <g fill="#0f172a" stroke="#475569" stroke-width="6"><circle cx="194" cy="191" r="36"/><circle cx="505" cy="191" r="36"/></g>
            <g fill="#cbd5e1" stroke="#64748b" stroke-width="7"><circle cx="194" cy="191" r="20"/><circle cx="505" cy="191" r="20"/></g>
            <text x="370" y="151" fill="#0f172a" font-size="20" font-family="sans-serif" font-weight="900">JETTA TURBO</text>
        </svg>
    </div>`;
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
