// SPDX-License-Identifier: GPL-3.0-or-later
// Intercepta após o seletor resolver a fonte, antes de criar o Go Live.
export const discordPatches = [
    {
        find: '"startStreamWithSource"',
        replacement: {
            match: /if\(null==\((\i)="number"==typeof \i\?[^;]+?\)\)return\[!1,"no source"\];/,
            replace: "$&if($self.routeEnabled())return $self.startDiscordShare($1,arguments[1]);"
        }
    },
    {
        find: "getCurrentUserActiveStream(){",
        replacement: {
            match: "getCurrentUserActiveStream(){",
            replace: "$&const fockytv=$self.discordStream();if(fockytv)return fockytv;"
        }
    },
    {
        find: 'type:"STREAM_START",streamType:',
        replacement: {
            match: /(\i\.h\.dispatch\(\{type:"STREAM_STOP",streamKey:(\i))/,
            replace: "$self.stopDiscordStream($2)||$1"
        }
    },
    {
        find: "getCurrentUserActiveStream(){",
        replacement: [
            {
                match: /getStreamForUser\((\i),(\i)\)\{/,
                replace: "$&const fockytv=$self.discordStreamForUser($1,$2);if(fockytv)return fockytv;"
            },
            {
                match: /getActiveStreamForStreamKey\((\i)\)\{/,
                replace: "$&const fockytv=$self.discordStreamForKey($1);if(fockytv)return fockytv;"
            },
            {
                match: /getAllActiveStreams\(\)\{return ?([^}]+)\}/,
                replace: "getAllActiveStreams(){return $self.includeDiscordShare($1)}"
            },
            {
                match: /getAllActiveStreamsForChannel\((\i)\)\{return ?([^}]+)\}/,
                replace: "getAllActiveStreamsForChannel($1){return $self.includeDiscordShare($2,$1)}"
            }
        ]
    },
    {
        find: "getVideoComponent(){",
        replacement: {
            match: /getVideoComponent\(\)\{return ?([^}]+)\}/,
            replace: "getVideoComponent(){return $self.videoComponent($1)}"
        }
    }
];

export interface DiscordSource {
    id?: string;
    windowHandle?: string;
    name?: string;
}

export function captureConstraints(source: DiscordSource, fps: number, height: number) {
    const id = source.id && /^(screen|window):-?\d+(?::\d+)?$/.test(source.id)
        ? source.id.split(":").length === 2 ? `${source.id}:0` : source.id
        : source.windowHandle && /^\d+$/.test(source.windowHandle)
            ? `window:${source.windowHandle}:0`
            : undefined;
    if (!id) throw new Error(`Fonte de captura incompatível (id=${source.id ?? "ausente"}, janela=${source.windowHandle ?? "ausente"}). Escolha uma tela ou janela no seletor do Discord.`);
    if (!Number.isFinite(fps) || fps <= 0 || fps > 240 || !Number.isFinite(height) || height < 0 || height > 4320)
        throw new Error("Qualidade de captura inválida.");
    return {
        audio: false,
        video: {
            mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: id,
                maxFrameRate: fps,
                ...(height ? { maxHeight: height } : {})
            }
        }
    };
}
