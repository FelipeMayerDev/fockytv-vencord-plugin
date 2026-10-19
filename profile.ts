// SPDX-License-Identifier: GPL-3.0-or-later
// Perfil automático: pelo que está sendo transmitido, escolhe FPS e resolução da live.
export type ProfileKind = "game" | "video" | "screen";
export interface Profile { fps: number; resolution: number; }
export const profileLabels: Record<ProfileKind, string> = { game: "Jogo", video: "Vídeo/filme", screen: "Tela/apps" };
export const defaultProfiles: Record<ProfileKind, Profile> = { game: { fps: 60, resolution: 1080 }, video: { fps: 30, resolution: 0 }, screen: { fps: 30, resolution: 0 } };

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

// Valores salvos nas configurações podem estar incompletos ou corrompidos: o que faltar vem do padrão.
export function profileFor(kind: ProfileKind, saved: unknown): Profile {
    const value = (saved as Partial<Record<ProfileKind, Partial<Profile>>> | undefined)?.[kind];
    const fps = [15, 30, 60].includes(value?.fps as number) ? value!.fps! : defaultProfiles[kind].fps;
    const resolution = [0, 720, 1080, 1440, 2160].includes(value?.resolution as number) ? value!.resolution! : defaultProfiles[kind].resolution;
    return { fps, resolution };
}
