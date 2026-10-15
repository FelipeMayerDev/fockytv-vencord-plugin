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
        // Botão de câmera do Discord: liga/desliga a câmera no FockyTV em vez do Discord.
        find: 'type:"MEDIA_ENGINE_SET_VIDEO_ENABLED"',
        replacement: {
            match: /setVideoEnabled\((\i)\)\{/,
            replace: "$&if($self.routeEnabled()&&$self.discordCamera($1))return;"
        }
    },
    {
        // Todos os botões/atalhos de câmera leem daqui: ligado enquanto a câmera FockyTV transmite.
        find: "isVideoAvailable(){return Object.values(",
        replacement: {
            match: /isVideoEnabled\(\)\{return /,
            replace: "$&$self.cameraActive()||"
        }
    },
    {
        // Mas o gateway recebe o estado real: ninguém vê câmera ligada sem vídeo no Discord.
        find: "computeVoiceFlags(){",
        replacement: {
            match: /selfVideo:(\i\.\i)\.isVideoEnabled\(\)/g,
            replace: "selfVideo:!$self.cameraActive()&&$1.isVideoEnabled()"
        }
    },
    {
        // Quadros de câmera locais e remotos para quem tem o plugin.
        find: 'static displayName="VoiceStateStore"',
        replacement: [
            {
                match: /selfVideo:(\i)\.selfVideo,sessionId:/,
                replace: "selfVideo:$self.selfVideo($1),sessionId:"
            },
            {
                // Quem transmite no FockyTV aparece "AO VIVO" para quem tem o plugin.
                match: /selfStream:(\i)\.selfStream,/,
                replace: "selfStream:$self.liveSelfStream($1),"
            }
        ]
    },
    {
        // Assistir/fechar uma live FockyTV não passa pelo gateway; o resto do fluxo nativo segue igual.
        find: ".STREAM_WATCH,{stream_key:",
        replacement: [
            {
                match: /streamWatch\((\i)\)\{/,
                replace: "$&if($self.watchFockyStream($1))return;"
            },
            {
                match: /streamDelete\((\i)\)\{/,
                replace: "$&if($self.unwatchFockyStream($1))return;"
            }
        ]
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
            },
            {
                // Lista de streams disponíveis no canal (botão "Assistir").
                match: /(selfStream:(\i),discoverable:\i\}=(\i);)/,
                replace: "$1$2=$self.liveSelfStream($3);"
            }
        ]
    },
    {
        find: "getVideoComponent(){",
        replacement: {
            match: /getVideoComponent\(\)\{return ?([^}]+)\}/,
            replace: "getVideoComponent(){return $self.videoComponent($1)}"
        }
    },
    {
        // Discord web (Vesktop): compartilhar tela pede getDisplayMedia e inicia o Go Live sem passar pelo startStreamWithSource.
        find: "sourceName:null,analyticsLocations:",
        replacement: {
            match: /(?<=\{if\(\i\.isPlatformEmbedded\)\(0,\i\.openModalLazy\).{0,1500}?\);)else\{(?=let \i=\i\.\i\.getChannel)/,
            replace: "else if(!$self.startWebShare()){"
        }
    },
    {
        // [FTV] depois do nome na lista de voz (antes do sufixo de convidado, que o RoleColorEverywhere usa).
        find: "#{intl::GUEST_NAME_SUFFIX})]",
        replacement: {
            match: /children:\[(\i\?\?\i\.\i\.getName\((\i)\)),(?=\i\?\(0,\i\.jsxs\)\("span")/,
            replace: "children:[$1,$self.ftvTag($2),"
        }
    },
    {
        find: '\"2026-08-video-guard\"',
        replacement: {
            match: /(?<=name:"2026-08-video-guard".{0,100}?)variations:\{.{0,120}?\}\}(?=\}\))/,
            replace: "variations:{}"
        }
    },
    {
        find: 'type:"STREAM_PREVIEW_FETCH_START"',
        replacement: {
            match: /(async function \i\((\i),(\i),(\i)\)\{)(?=if\(!\i\.\i\.shouldFetchPreview\()/,
            replace: "$1if($self.fetchFtvPreview($2,$3,$4))return;"
        }
    },
    {
        // A publicação FockyTV não tem fonte RTC nativa; encaminha as escolhas do menu diretamente.
        find: '"stream-settings-fps"',
        replacement: [
            {
                match: /(\i=\i\.useCallback\(\((\i),(\i),(\i),(\i)\)=>\{)(?=if\()/,
                replace: "$1if($self.updateDiscordQuality({resolution:$3,frameRate:$4,preset:3}))return;"
            },
            {
                match: /(\i\.isPlatformEmbedded)(?=\?\(0,\i\.jsx\)\(\i\.\i,\{id:"stream-settings")/,
                replace: "($self.discordStream()||$1)"
            }
        ]
    },
    {
        find: 'type:"STREAM_UPDATE_SETTINGS"',
        replacement: {
            match: /(function \i\((\i)\)\{)(?=!0!==\2\.noTrack)/,
            replace: "$1if($self.updateDiscordQuality($2))return;"
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

// Usa a câmera escolhida no Discord. Os ids nativos diferem dos do Chromium e o rótulo do
// Chromium leva o sufixo USB ("USB Live camera (0c45:6366)"): casa pelo nome ou pelo vid:pid.
export function matchCamera(device: { id?: string; name?: string; } | undefined, inputs: { deviceId: string; label: string; }[]) {
    if (!device?.name) return undefined;
    const usb = device.id?.match(/vid_([0-9a-f]{4}).*?pid_([0-9a-f]{4})/i);
    const strip = (label: string) => label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "");
    return (inputs.find(input => input.label === device.name)
        ?? inputs.find(input => strip(input.label) === device.name)
        ?? (usb ? inputs.find(input => input.label.toLowerCase().endsWith(`(${usb[1]}:${usb[2]})`.toLowerCase())) : undefined))?.deviceId;
}
