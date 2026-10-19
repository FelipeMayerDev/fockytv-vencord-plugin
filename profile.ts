// SPDX-License-Identifier: GPL-3.0-or-later
// O que está sendo transmitido (jogo, vídeo/filme ou tela), para o aviso da live.
export type ProfileKind = "game" | "video" | "screen";

interface Source { id?: string; name?: string; windowHandle?: string; pid?: number; exeName?: string; }
interface Game { name?: string; windowHandle?: string | number; pid?: number; }

// ponytail: lista fixa de players e streaming pelo nome da janela; aumente aqui quando faltar algum.
const videoApps = /youtube|netflix|prime video|disney|hbo|\bmax\b|crunchyroll|twitch|vlc|mpv|plex|jellyfin|globoplay|stremio|kodi|media player|filmes e tv|apple tv|paramount|mubi/i;

export function detectProfile(source: Source = {}, games: Game[] = [], visibleGame?: Game | null): { kind: ProfileKind; name?: string; } {
    const handle = source.windowHandle ?? /^window:(\d+)/.exec(source.id ?? "")?.[1];
    const title = source.name?.trim();
    // O seletor do Discord passa o próprio jogo (pid) quando você escolhe um jogo detectado.
    if (source.pid != null || source.exeName) return { kind: "game", name: title };
    const game = games.find(game => handle && game.windowHandle != null && String(game.windowHandle) === handle)
        ?? games.find(game => title && game.name && game.name.length >= 3 && title.toLowerCase().includes(game.name.toLowerCase()))
        ?? (/^screen/.test(source.id ?? "") ? visibleGame ?? undefined : undefined);
    if (game) return { kind: "game", name: game.name ?? title };
    if (title && videoApps.test(title)) return { kind: "video", name: title };
    return { kind: "screen", name: title };
}

