// SPDX-License-Identifier: GPL-3.0-or-later
import type { Activity } from "@vencord/discord-types";

import type { musicPlayer } from "./music";

// ponytail: app público do musicRichPresence do Vencord; o Discord descarta atividade com application_id inválido.
// Trocar pelo ID de um app "FockyTV" próprio quando existir.
const APP_ID = "1108588077900898414";

export function fockyActivity(enabled: boolean, music: ReturnType<ReturnType<typeof musicPlayer>["snapshot"]>, live?: string): Activity | null {
    if (!enabled) return null;
    // A live é o foco principal quando a música toca em paralelo.
    if (live) return { application_id: APP_ID, name: `a live de ${live}`.slice(0, 128), type: 3, flags: 1 };
    if (music.listening && music.state?.playing && music.state.ready && music.current) {
        const { title, channel } = music.current;
        return { application_id: APP_ID, name: `${title} — ${channel}`.slice(0, 128), details: title.slice(0, 128), state: channel.slice(0, 128), type: 2, flags: 1 };
    }
    return null;
}
