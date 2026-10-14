// SPDX-License-Identifier: GPL-3.0-or-later
export function streamKey(value: string) {
    const key = value.trim();
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(key))
        throw new Error("Nick inválido: use 1–32 letras ASCII, números, _, - ou .");
    return key;
}

export function cameraKey(nick: string) {
    return `${streamKey(nick).slice(0, 28)}-cam`;
}

export function serverUrl(value: string) {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
        throw new Error("Informe uma URL HTTP(S) sem caminho, credenciais, query ou fragmento.");
    return url.href.replace(/\/$/, "");
}

export function sessionUrl(location: string, endpoint: string) {
    const url = new URL(location, endpoint);
    const base = new URL(endpoint);
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`) || url.username || url.password)
        throw new Error("O servidor retornou uma URL de sessão inválida.");
    return url.href;
}
