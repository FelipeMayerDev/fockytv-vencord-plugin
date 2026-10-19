// SPDX-License-Identifier: GPL-3.0-or-later
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { copyToClipboard } from "@utils/clipboard";
import { IS_WINDOWS } from "@utils/constants";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { RenderModalProps, Stream } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { ApplicationStreamingStore, ApplicationStreamPreviewStore, Button, ChannelStore, FluxDispatcher, MediaEngineStore, Modal, openModal, React, SelectedChannelStore, UserStore, VoiceStateStore, Tooltip, useEffect, useRef, useState, useStateFromStores } from "@webpack/common";

import { screenAudio } from "./audio";
import { captureNativeCamera, syncCameraFilter } from "./camera";
import { videoStats } from "./diagnostics";
import { captureConstraints, DiscordSource, discordPatches, matchCamera, nativeSource } from "./discord";
import { jiraError, jiraSite } from "./jira";
import { JiraFetch, JiraPanel } from "./jira-panel";
import { streamAudio } from "./playback";
import { cameraKey, liveStyle, liveStyles, serverUrl, streamKey } from "./protocol";
import { defaultProfiles, detectProfile, profileFor, ProfileKind, profileLabels } from "./profile";
import { qualityConstraints, shareQuality, ShareQuality } from "./quality";
import { replayBuffer } from "./replay";
import { NativeShare, Request, Session } from "./session";
import { thumbnail } from "./thumbnail";
import { loadLivekit, proxySocket, receivedQuality, Viewing, watchLive } from "./viewer";
import livekitSource from "file://./livekit-client.umd.js";
import managedStyle from "./style.css?managed";

const settings = definePluginSettings({
    url: { type: OptionType.STRING, description: "Servidor FockyTV", default: "https://fockytv.felipemayer.com.br", isValid: value => { try { if (typeof value !== "string") return false; serverUrl(value); return true; } catch { return false; } } },
    nativeCapture: { type: OptionType.BOOLEAN, description: "Windows: capturar e codificar na GPU (WGC + NVENC), sem passar pelo Chromium. Se falhar, usa a captura do Discord.", default: true },
    nativeBitrate: { type: OptionType.SELECT, description: "Bitrate da captura nativa (vale na próxima live). Cada espectador recebe esse valor; abaixe se a imagem travar para quem assiste.", options: [4, 6, 8, 12, 20].map(value => ({ label: `${value} Mbps`, value, default: value === 8 })) },
    liveStyle: { type: OptionType.COMPONENT, default: "rainbow", component: ({ setValue }) => <LiveStylePicker setValue={setValue} /> },
    liveTitle: { type: OptionType.STRING, description: "Título da live no aviso do canal (vazio: \"Live de <seu nome>\"). O jogo ou a janela transmitida aparece junto.", default: "" },
    autoProfile: { type: OptionType.BOOLEAN, description: "Perfil automático: com a resolução \"Fonte\" no Discord, detecta se você transmite um jogo, um vídeo/filme ou a tela/apps e usa o FPS e a resolução da categoria. Uma resolução escolhida no Discord sempre vale.", default: true },
    profiles: { type: OptionType.COMPONENT, default: defaultProfiles, component: ({ setValue }) => <ProfilesEditor setValue={setValue} /> },
    replayBuffer: { type: OptionType.BOOLEAN, description: "Replay das lives assistidas: grava em segundo plano e o botão na live (ou Alt+Shift+R) salva os últimos 30 a 60 s em Vídeos/FockyTV. Usa um pouco de CPU enquanto você assiste (vale na próxima live assistida).", default: false },
    jiraSite: { type: OptionType.STRING, description: "Jira Cloud: endereço do site (https://empresa.atlassian.net).", default: "", isValid: value => { try { if (value) jiraSite(String(value)); return true; } catch { return false; } } },
    jiraEmail: { type: OptionType.STRING, description: "Jira Cloud: e-mail da sua conta Atlassian.", default: "" },
    jiraToken: { type: OptionType.COMPONENT, default: "", component: ({ setValue }) => <JiraTokenInput setValue={setValue} /> },
    jiraBoard: { type: OptionType.NUMBER, description: "Último board aberto no Jira.", default: 0, hidden: true }
});

// Token como senha: não fica à mostra na tela de configurações.
function JiraTokenInput({ setValue }: { setValue(value: unknown): void; }) {
    const [token, setToken] = useState(settings.store.jiraToken);
    return <section className="fockytv-setting">
        <h3>Jira Cloud: API token</h3>
        <p>Crie em id.atlassian.com → Segurança → Criar e gerenciar tokens de API. Com o site, o e-mail e o token preenchidos, o botão do Jira aparece no painel de voz.</p>
        <input className="fockytv-jira-input" type="password" autoComplete="off" aria-label="API token do Jira" value={token} onChange={event => { setToken(event.currentTarget.value); setValue(event.currentTarget.value.trim()); }} />
    </section>;
}
const RunningGameStore = findStoreLazy("RunningGameStore") as { getRunningGames(): { name?: string; windowHandle?: string | number; pid?: number; }[]; getVisibleGame(): { name?: string; windowHandle?: string | number; } | null; };

const profileKinds = Object.keys(profileLabels) as ProfileKind[];
function ProfilesEditor({ setValue }: { setValue(value: unknown): void; }) {
    const [profiles, setProfiles] = useState(() => Object.fromEntries(profileKinds.map(kind => [kind, profileFor(kind, settings.store.profiles)])));
    const change = (kind: ProfileKind, field: "fps" | "resolution", value: number) => {
        const next = { ...profiles, [kind]: { ...profiles[kind], [field]: value } };
        setProfiles(next);
        setValue(next);
    };
    return <section className="fockytv-setting">
        <h3>Presets do perfil automático</h3>
        <p>FPS e resolução de cada categoria; "Fonte" mantém a resolução da tela.</p>
        <table className="fockytv-profiles"><tbody>
            {profileKinds.map(kind => <tr key={kind}>
                <th scope="row">{profileLabels[kind]}</th>
                <td><select aria-label={`FPS: ${profileLabels[kind]}`} value={profiles[kind].fps} onChange={event => change(kind, "fps", Number(event.currentTarget.value))}>
                    {[15, 30, 60].map(fps => <option key={fps} value={fps}>{fps} FPS</option>)}
                </select></td>
                <td><select aria-label={`Resolução: ${profileLabels[kind]}`} value={profiles[kind].resolution} onChange={event => change(kind, "resolution", Number(event.currentTarget.value))}>
                    {([[720, "720p"], [1080, "1080p"], [1440, "1440p"], [2160, "4K"], [0, "Fonte"]] as const).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select></td>
            </tr>)}
        </tbody></table>
    </section>;
}

// Seu avatar com o anel e o selo "AO VIVO" do estilo, como os outros vão ver na lista de voz.
function LiveStylePreview({ style }: { style: string; }) {
    const user = UserStore.getCurrentUser();
    const live = style ? `fockytv-style-${style}` : "";
    return <div className="fockytv-preview">
        <div className={`fockytv-preview-avatar ${style ? `fockytv-avatar ${live}` : ""}`} style={user ? { backgroundImage: `url(${user.getAvatarURL(undefined, 48)})` } : undefined} />
        {user?.globalName ?? user?.username}
        <span className={`fockytv-preview-badge ${style ? `fockytv-badge ${live}` : ""}`}>AO VIVO</span>
    </div>;
}

function LiveStylePicker({ setValue }: { setValue(value: string): void; }) {
    const [current, setCurrent] = useState(() => liveStyle(settings.store.liveStyle));
    return <section className="fockytv-setting">
        <h3>Estilo da sua live</h3>
        <p>Anel no seu avatar e selo "AO VIVO" que quem tem o plugin vê enquanto você transmite (vale na próxima live). Passe o mouse para ver o preview.</p>
        <div className="fockytv-style-picker" role="group" aria-label="Estilo da sua live">
            {Object.entries(liveStyles).map(([value, label]) =>
                <Tooltip key={value} text={<LiveStylePreview style={value} />}>
                    {tooltip => <button {...tooltip} type="button" aria-pressed={current === value} className={`fockytv-style-option ${value ? `fockytv-style-${value}` : ""}`} onClick={() => { setCurrent(value); setValue(value); }}>
                        <span className="fockytv-style-swatch" />{label}
                    </button>}
                </Tooltip>)}
        </div>
    </section>;
}
const Native = VencordNative.pluginHelpers.FockyTV as PluginNative<typeof import("./native")>;
const request: Request = (url, method, key, body) => Native.request(url, method, key, body);
const StreamingSettings = findStoreLazy("ApplicationStreamingSettingsStore") as { getState(): ShareQuality; };
const previewStreamId = "fockytv-preview";
const cameraStreamId = "fockytv-camera";
const watchStreamPrefix = "fockytv-watch:";
const watchCameraPrefix = "fockytv-camera:";
let OriginalVideo: React.ComponentType<VideoProps>;
interface VideoProps { streamId?: string; className?: string; onReady?: (() => void) | null; onResize?: (size: { width: number; height: number; }) => void; paused?: boolean; }
function PreviewVideo(props: VideoProps) {
    const video = useRef<HTMLVideoElement>(null);
    const camera = props.streamId === cameraStreamId;
    const remoteCamera = props.streamId?.startsWith(watchCameraPrefix) ? cameraViewers.get(props.streamId.slice(watchCameraPrefix.length))?.viewing?.media : undefined;
    const watched = props.streamId?.startsWith(watchStreamPrefix) ? watching.get(props.streamId.slice(watchStreamPrefix.length))?.viewing?.media : undefined;
    const capture = props.streamId?.startsWith(watchCameraPrefix) ? remoteCamera : watched ?? publishers.get(camera ? "camera" : "screen")?.capture;
    useEffect(() => {
        const element = video.current;
        if (!element) return;
        element.srcObject = capture ?? null;
        return () => { element.srcObject = null; };
    }, [capture]);
    useEffect(() => {
        if (props.paused) video.current?.pause();
        else void video.current?.play().catch(() => {});
    }, [capture, props.paused]);
    const resize = () => {
        if (video.current) props.onResize?.({ width: video.current.videoWidth, height: video.current.videoHeight });
    };
    const element = <video ref={video} className={props.className} autoPlay muted playsInline onResize={resize} onLoadedData={() => { resize(); props.onReady?.(); }} aria-label={remoteCamera ? "Câmera FockyTV" : watched ? "Live FockyTV" : "Preview da sua transmissão FockyTV"} style={{ width: "100%", height: "100%", objectFit: camera || remoteCamera ? "cover" : "contain" }} />;
    if (!watched) return element;
    // Live assistida: replay (se ligado) e picture-in-picture sobre o vídeo.
    const key = props.streamId!.slice(watchStreamPrefix.length);
    const stop = (event: React.SyntheticEvent) => event.stopPropagation();
    return <div className="fockytv-player">
        {element}
        <div className="fockytv-player-controls" onClick={stop} onDoubleClick={stop}>
            {watching.get(key)?.replay && <button type="button" className="fockytv-player-button" title="Salvar os últimos 30 a 60 s (Alt+Shift+R)" onClick={() => void saveReplay(key)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>Replay
            </button>}
            <button type="button" className="fockytv-player-button" title="Picture-in-picture" aria-label="Picture-in-picture" onClick={() => void togglePictureInPicture(watched)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" /></svg>
            </button>
        </div>
    </div>;
}

// Picture-in-picture num <video> próprio: continua aberto quando o tile do Discord desmonta ao trocar de canal.
let pipVideo: HTMLVideoElement | undefined;
async function togglePictureInPicture(media: MediaStream) {
    try {
        if (document.pictureInPictureElement && pipVideo?.srcObject === media) return await document.exitPictureInPicture();
        if (!pipVideo) {
            pipVideo = Object.assign(document.createElement("video"), { muted: true, playsInline: true });
            pipVideo.addEventListener("leavepictureinpicture", () => { pipVideo!.srcObject = null; });
        }
        pipVideo.srcObject = media;
        await pipVideo.play();
        await pipVideo.requestPictureInPicture();
    } catch (error) {
        console.warn("FockyTV: picture-in-picture", error);
        void showNotification({ title: "FockyTV: picture-in-picture indisponível", body: String(error) });
    }
}

function closePictureInPicture(media?: MediaStream) {
    if (pipVideo && document.pictureInPictureElement === pipVideo && (!media || pipVideo.srcObject === media)) void document.exitPictureInPicture().catch(() => {});
}

async function saveReplay(key: string) {
    const replay = watching.get(key)?.replay;
    if (!replay) return;
    try {
        const blob = await replay.save();
        const file = await Native.saveReplay(liveOwners.get(ownerOf(key)) ?? "live", replay.extension, new Uint8Array(await blob.arrayBuffer()));
        void showNotification({ title: "FockyTV: replay salvo", body: `${file}\nClique para abrir a pasta.`, onClick: () => void Native.showReplay(file) });
    } catch (error) {
        console.error("FockyTV: replay", error);
        void showNotification({ title: "FockyTV: não foi possível salvar o replay", body: String(error) });
    }
}

function replayShortcut(event: KeyboardEvent) {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.code !== "KeyR") return;
    const keys = [...watching].filter(([, entry]) => entry.replay).map(([key]) => key);
    if (!keys.length) return;
    event.preventDefault();
    keys.forEach(key => void saveReplay(key));
}
function VideoComponent(props: VideoProps) {
    return props.streamId === previewStreamId || props.streamId === cameraStreamId || (props.streamId?.startsWith(watchStreamPrefix) || props.streamId?.startsWith(watchCameraPrefix)) ? <PreviewVideo {...props} /> : <OriginalVideo {...props} />;
}
function updatePreview(share: Stream, streamId: string | null) {
    // Só atualiza os stores locais de vídeo; não abre uma sessão Go Live no gateway.
    FluxDispatcher.dispatch({ type: "RTC_CONNECTION_VIDEO", guildId: share.guildId, channelId: share.channelId, userId: share.ownerId, streamId, rtcServerId: null, context: "stream" });
}
// Sempre o username do Discord: é por ele que o plugin dos outros reconhece a live na call.
const nickname = () => streamKey(UserStore.getCurrentUser()?.username || "");
// Toda mudança na câmera reflete no Discord (botão, quadro e preview), venha de onde vier.
const publishers = new class extends Map<"screen" | "camera", Session | NativeShare> {
    set(kind: "screen" | "camera", session: Session | NativeShare) { super.set(kind, session); setTimeout(syncCamera, 0); return this; }
    delete(kind: "screen" | "camera") { const deleted = super.delete(kind); setTimeout(syncCamera, 0); return deleted; }
    clear() { super.clear(); setTimeout(syncCamera, 0); }
}();
let cameraShown = false;
function syncCamera() {
    const active = publishers.has("camera");
    if (active === cameraShown) return;
    cameraShown = active;
    MediaEngineStore.emitChange();
    const userId = UserStore.getCurrentUser()?.id;
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!userId || !channelId) return;
    const guildId = ChannelStore.getChannel(channelId)?.guild_id ?? null;
    // Só nos stores locais: o gateway continua com selfVideo falso, ninguém vê câmera vazia.
    FluxDispatcher.dispatch({ type: "RTC_CONNECTION_VIDEO", guildId, channelId, userId, streamId: active ? cameraStreamId : null, rtcServerId: null, context: "default" });
    const state = VoiceStateStore.getVoiceStateForUser(userId);
    if (state) FluxDispatcher.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates: [{ ...state, guildId, selfVideo: false }] });
}
const pending = new Set<"screen" | "camera">();
let generation = 0;
let routingEnabled = false;
let discordQuality: ShareQuality | null = null;
let shareChanges: Promise<void> = Promise.resolve();
let discordShare: (Stream & { state: "CONNECTING" | "ACTIVE"; }) | null = null;

function clearDiscordShare() {
    if (!discordShare) return;
    const share = discordShare;
    discordShare = null;
    discordQuality = null;
    ApplicationStreamingStore.emitChange();
    setTimeout(() => updatePreview(share, null), 0);
}
// Lives FockyTV de quem está na sua call, casadas pelo username do Discord (a stream key do plugin).
const liveOwners = new Map<string, string>(); // id do Discord → stream key FockyTV (sala LiveKit)
// Stream key do Discord ("guild:g:c:dono" / "call:c:dono") → live assistida.
const watching = new Map<string, { viewing?: Viewing; audio?: ReturnType<typeof streamAudio>; replay?: ReturnType<typeof replayBuffer>; }>();
// Toda stream FockyTV já assistida: fechar uma live que já acabou também não pode chegar ao gateway.
const fockyStreams = new Set<string>();
const cameraViewers = new Map<string, { room: string; channelId: string; viewing?: Viewing; }>();
function cameraVideo(userId: string, channelId: string, streamId: string | null) {
    FluxDispatcher.dispatch({ type: "RTC_CONNECTION_VIDEO", guildId: ChannelStore.getChannel(channelId)?.guild_id ?? null, channelId, userId, streamId, rtcServerId: null, context: "default" });
    const state = VoiceStateStore.getVoiceStateForUser(userId);
    if (state?.channelId === channelId) FluxDispatcher.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates: [{ ...state, guildId: ChannelStore.getChannel(channelId)?.guild_id ?? null, selfVideo: false }] });
}
function endCamera(userId: string) {
    const entry = cameraViewers.get(userId);
    if (!entry) return;
    cameraViewers.delete(userId);
    entry.viewing?.close();
    cameraVideo(userId, entry.channelId, null);
}
async function watchCamera(userId: string, room: string, channelId: string) {
    const entry: { room: string; channelId: string; viewing?: Viewing; } = { room, channelId };
    cameraViewers.set(userId, entry);
    try {
        livekit ??= loadLivekit(livekitSource, proxySocket(Native));
        const viewing = await watchLive(livekit, request, serverUrl(settings.store.url), room, nickname(), () => {
            if (cameraViewers.get(userId) === entry) endCamera(userId);
        });
        if (cameraViewers.get(userId) !== entry) { viewing.close(); return; }
        entry.viewing = viewing;
        cameraVideo(userId, channelId, watchCameraPrefix + userId);
    } catch (error) {
        if (cameraViewers.get(userId) === entry) endCamera(userId);
        console.warn("FockyTV: assistir câmera", error);
    }
}
let livePoll: ReturnType<typeof setInterval> | undefined;
let updatePoll: ReturnType<typeof setInterval> | undefined;
let updateCheck: ReturnType<typeof setTimeout> | undefined;
let notifiedRevision = "";
let livekit: any;
const ownerOf = (key: string) => key.split(":").pop()!;
const keyOf = ({ guildId, channelId, ownerId }: { guildId?: string | null; channelId: string; ownerId: string; }) =>
    guildId ? `guild:${guildId}:${channelId}:${ownerId}` : `call:${channelId}:${ownerId}`;
type LiveQuality = { resolution: number; fps: number; style?: string; };
// Quem assiste cada live (stream key do Discord → ids): o Discord toca entrada/saída e mostra os avatares a partir disso.
const liveViewers = new Map<string, string[]>();
const webViewers = new Map<string, number>(); // stream key → quem assiste pelo site FockyTV (sessões sem membro da call)
const announcedQuality = new Map<string, string>(); // dono da live → qualidade já enviada ao selo do Discord
const ownerStyles = new Map<string, string>(); // dono da live → estilo do anel e do selo "AO VIVO"

// Só o dono da live vê quem está assistindo a ela.
const watchingMyLive = (userId: string) => !!discordShare && discordShare.ownerId !== userId && !!liveViewers.get(keyOf(discordShare))?.includes(userId);
// Componente, não constante: JSX no topo do módulo roda antes do React do Discord existir e derruba o Vencord inteiro.
const EyeIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>;
const UsersIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 19c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4" /><path d="M18 13.4c2.2.8 3.5 2.9 3.5 5.6" /></svg>;

function liveSelfStream(state: { userId?: string; channelId?: string | null; selfStream?: boolean; }) {
    return !!state.selfStream || (!!state.userId && liveOwners.has(state.userId) && state.channelId != null && state.channelId === SelectedChannelStore.getVoiceChannelId());
}

async function refreshLives() {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    const keys = new Map<string, string>(); // minúsculo → stream key exata
    const lives = new Map<string, { viewers: string[]; sessions: number; quality?: LiveQuality; }>(); // minúsculo → espectadores e qualidade
    if (channelId && routingEnabled) {
        try {
            const response = await request(`${serverUrl(settings.store.url)}/api/status`, "GET");
            if (response.status !== 200) return;
            for (const live of JSON.parse(response.body) as { streamKey: string; engine?: string; videoTracks?: unknown[]; sessions?: { viewer?: string; }[]; quality?: LiveQuality; }[])
                if (live.engine === "livekit" && live.videoTracks?.length) {
                    keys.set(live.streamKey.toLowerCase(), live.streamKey);
                    lives.set(live.streamKey.toLowerCase(), { viewers: (live.sessions ?? []).flatMap(session => session.viewer ? [session.viewer.toLowerCase()] : []), sessions: live.sessions?.length ?? 0, quality: live.quality });
                }
        } catch (error) { console.warn("FockyTV: lives", error); return; }
    }
    // Ignora respostas de uma chamada anterior ou de um plugin já desativado.
    if (channelId !== SelectedChannelStore.getVoiceChannelId()) return;
    if (!routingEnabled) keys.clear();
    const me = UserStore.getCurrentUser()?.id;
    const cameraRooms = new Map<string, string>();
    for (const id of Object.keys(channelId ? VoiceStateStore.getVoiceStatesForChannel(channelId) : {})) {
        if (id === me) continue;
        const username = UserStore.getUser(id)?.username;
        if (!username) continue;
        try {
            const room = keys.get(cameraKey(username).toLowerCase());
            if (room) cameraRooms.set(id, room);
        } catch { /* Username incompatível com as chaves FockyTV. */ }
    }
    for (const [id, entry] of cameraViewers)
        if (entry.channelId !== channelId || cameraRooms.get(id) !== entry.room) endCamera(id);
    if (channelId) for (const [id, room] of cameraRooms)
        if (!cameraViewers.has(id)) void watchCamera(id, room, channelId);
    const owners = new Map(Object.keys(channelId ? VoiceStateStore.getVoiceStatesForChannel(channelId) : {})
        .filter(id => id !== me).map(id => [id, keys.get(UserStore.getUser(id)?.username?.toLowerCase() ?? "")] as const)
        .filter((owner): owner is [string, string] => !!owner[1]));
    const styles = new Map([...owners].map(([id, key]) => [id, liveStyle(lives.get(key.toLowerCase())?.quality?.style)]));
    // O estilo chega com o anúncio de qualidade, às vezes depois da live: também reaplica a linha de quem mudou de estilo.
    const changed = [...new Set([...owners.keys(), ...liveOwners.keys()])].filter(id => owners.has(id) !== liveOwners.has(id) || styles.get(id) !== ownerStyles.get(id));
    liveOwners.clear();
    owners.forEach((key, id) => liveOwners.set(id, key));
    ownerStyles.clear();
    styles.forEach((style, id) => ownerStyles.set(id, style));
    for (const key of [...watching.keys()]) if (!liveOwners.has(ownerOf(key))) endWatch(key);
    const guildId = channelId ? ChannelStore.getChannel(channelId)?.guild_id ?? null : null;
    if (changed.length && channelId) {
        // Reaplica o estado de voz atual: os patches marcam selfStream e o Discord mostra "AO VIVO" e o botão Assistir.
        // ponytail: um Go Live nativo simultâneo some até a próxima atualização de voz real desse usuário
        const voiceStates = changed.map(id => VoiceStateStore.getVoiceStateForUser(id)).filter(Boolean).map(state => ({ ...state, guildId, selfStream: false }));
        if (voiceStates.length) FluxDispatcher.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates });
    }
    // Selo de qualidade das lives dos outros: o mesmo evento que a conexão de stream nativa emite.
    for (const id of announcedQuality.keys()) if (!liveOwners.has(id)) announcedQuality.delete(id);
    if (channelId) for (const [id, room] of liveOwners) {
        let quality = lives.get(room.toLowerCase())?.quality;
        // Live sem anúncio (versão antiga do plugin ou anúncio perdido): quem já assiste usa o que está recebendo.
        if (!quality?.resolution) quality = await receivedQuality(watching.get(keyOf({ guildId, channelId, ownerId: id }))?.viewing, quality?.fps) ?? quality;
        const signature = quality ? `${quality.resolution}:${quality.fps}` : "";
        if (!quality || announcedQuality.get(id) === signature) continue;
        announcedQuality.set(id, signature);
        FluxDispatcher.dispatch({
            type: "MEDIA_ENGINE_VIDEO_SOURCE_QUALITY_CHANGED", guildId, channelId, senderUserId: id, context: "stream", maxFrameRate: quality.fps,
            maxResolution: { type: quality.resolution ? "fixed" : "source", width: 0, height: quality.resolution }
        });
    }
    // Espectadores casados pelo username com quem está na call (quem assiste pelo site não tem conta para mostrar).
    const members = new Map(Object.keys(channelId ? VoiceStateStore.getVoiceStatesForChannel(channelId) : {})
        .map(id => [UserStore.getUser(id)?.username?.toLowerCase() ?? "", id] as const));
    const viewers = new Map<string, string[]>();
    const web = new Map<string, number>();
    const share = discordShare;
    const rooms: [string, string][] = [...liveOwners].map(([id, room]) => [channelId ? keyOf({ guildId, channelId, ownerId: id }) : "", room]);
    if (share && share.channelId === channelId && me) try { rooms.push([keyOf(share), nickname()]); } catch { /* Nick incompatível. */ }
    for (const [key, room] of rooms) {
        const live = lives.get(room.toLowerCase());
        if (!key || !live) continue;
        const ids = live.viewers.flatMap(name => members.get(name) ?? []);
        viewers.set(key, ids);
        // ponytail: quem não casa com um membro da call conta como site; sessões duplicadas de uma reconexão do Discord inflam esse número até sumirem.
        web.set(key, Math.max(0, live.sessions - ids.length));
    }
    if (JSON.stringify([...viewers, ...web]) === JSON.stringify([...liveViewers, ...webViewers])) return;
    liveViewers.clear();
    viewers.forEach((ids, key) => liveViewers.set(key, ids));
    webViewers.clear();
    web.forEach((count, key) => webViewers.set(key, count));
    ApplicationStreamingStore.emitChange();
}

function syncAudio() {
    const deaf = MediaEngineStore.isSelfDeaf();
    const output = MediaEngineStore.getOutputVolume();
    watching.forEach((entry, key) => {
        const owner = ownerOf(key);
        entry.audio?.update(MediaEngineStore.getLocalVolume(owner, "stream"), output,
            deaf || MediaEngineStore.isLocalMute(owner, "stream"));
    });
}

function watchVideo(key: string, streamId: string | null) {
    const parts = key.split(":");
    const [guildId, channelId] = parts[0] === "guild" ? [parts[1], parts[2]] : [null, parts[1]];
    FluxDispatcher.dispatch({ type: "RTC_CONNECTION_VIDEO", guildId, channelId, userId: ownerOf(key), streamId, rtcServerId: null, context: "stream" });
}

async function startWatch(key: string) {
    const entry: NonNullable<ReturnType<typeof watching.get>> = {};
    watching.set(key, entry);
    try {
        const room = liveOwners.get(ownerOf(key));
        if (!room) throw new Error("A live terminou.");
        livekit ??= loadLivekit(livekitSource, proxySocket(Native));
        let viewer = "";
        try { viewer = nickname(); } catch { }
        const viewing = await watchLive(livekit, request, serverUrl(settings.store.url), room, viewer, () => endWatch(key));
        if (watching.get(key) !== entry) { viewing.close(); return; }
        entry.viewing = viewing;
        // Um único elemento toca o áudio; os tiles de vídeo (podem ser vários) ficam mudos.
        entry.audio = streamAudio(viewing.media);
        syncAudio();
        if (settings.store.replayBuffer) {
            try { entry.replay = replayBuffer(viewing.media); } catch (error) { console.warn("FockyTV: replay", error); }
        }
        // STREAM_UPDATE marca a stream ativa e cancela o timeout do Discord sem exigir conexão RTC dele
        // (o handler de STREAM_CREATE do StreamRTCConnectionStore quebra sem rtcServerId).
        FluxDispatcher.dispatch({ type: "STREAM_UPDATE", streamKey: key, region: null, viewerIds: [UserStore.getCurrentUser()?.id], paused: false });
        watchVideo(key, watchStreamPrefix + key);
    } catch (error) {
        console.error("FockyTV: assistir", error);
        if (watching.get(key) === entry) {
            endWatch(key);
            void showNotification({ title: "FockyTV: não foi possível assistir", body: String(error) });
        }
    }
}

function closeViewing(key: string) {
    const entry = watching.get(key);
    if (!entry) return false;
    watching.delete(key);
    entry.replay?.stop();
    closePictureInPicture(entry.viewing?.media);
    entry.viewing?.close();
    entry.audio?.close();
    return true;
}

function endWatch(key: string) {
    if (!closeViewing(key)) return;
    // Pode ser chamado dentro de um dispatch (STREAM_WATCH/STREAM_CLOSE), e o Flux não aceita dispatch aninhado.
    setTimeout(() => {
        watchVideo(key, null);
        // Como o servidor do Discord faria; sem efeito se a stream já foi fechada.
        FluxDispatcher.dispatch({ type: "STREAM_DELETE", streamKey: key, unavailable: false, reason: "stream_ended" });
    }, 0);
}

// Quem está com o plugin ligado agora (presença no servidor), para a etiqueta [FTV] na lista de voz.
const ftvUsers = new Set<string>();
const ftvListeners = new Set<() => void>();
let presencePoll: ReturnType<typeof setInterval> | undefined;

async function refreshPresence() {
    try {
        const me = UserStore.getCurrentUser()?.username;
        const query = routingEnabled && me ? `?user=${encodeURIComponent(me.toLowerCase())}` : "";
        const response = await request(`${serverUrl(settings.store.url)}/api/presence${query}`, "GET");
        if (response.status !== 200) return; // servidor sem o endpoint: sem etiquetas
        const users = JSON.parse(response.body) as string[];
        if (users.length === ftvUsers.size && users.every(user => ftvUsers.has(user))) return;
        ftvUsers.clear();
        users.forEach(user => ftvUsers.add(user));
        ftvListeners.forEach(listener => listener());
    } catch (error) { console.warn("FockyTV: presença", error); }
}

function FtvTag({ user }: { user?: { username?: string; }; }) {
    const [, update] = useState(0);
    useEffect(() => {
        const listener = () => update(n => n + 1);
        ftvListeners.add(listener);
        return () => { ftvListeners.delete(listener); };
    }, []);
    if (!user?.username || !ftvUsers.has(user.username.toLowerCase())) return null;
    return <span title="Usando o plugin FockyTV" style={{ marginLeft: 4, fontSize: 10, fontWeight: 700, color: "var(--text-brand, #5865f2)" }}>[FTV]</span>;
}

let modalKey: string | undefined;
let closePanel: (() => void) | undefined;

async function stopPublishing() {
    generation++;
    clearDiscordShare();
    const sessions = [...publishers.values()];
    publishers.clear();
    await Promise.all(sessions.map(session => session.close()));
}

async function cameraDevice() {
    const device = MediaEngineStore.getVideoDevices()[MediaEngineStore.getVideoDeviceId()];
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(input => input.kind === "videoinput");
    const deviceId = matchCamera(device, inputs);
    if (!deviceId) throw new Error(`Câmera do Discord "${device?.name ?? "nenhuma"}" não encontrada (${inputs.map(input => input.label).join(", ")}).`);
    return { exact: deviceId };
}

async function openCapture(kind: "screen" | "camera", source?: DiscordSource, quality?: Partial<ShareQuality>) {
    const selected = shareQuality(quality ?? {}, StreamingSettings.getState());
    if (kind === "camera" && typeof (window as any).createDiscordStream === "function")
        return { ...await captureNativeCamera(MediaEngineStore.getVideoDeviceId()), releaseAudio: undefined, quality: selected };
    const sound = kind === "screen" && (selected.soundshareEnabled ?? false);
    const capture = source
        ? await navigator.mediaDevices.getUserMedia(captureConstraints(source, selected.fps, selected.resolution) as unknown as MediaStreamConstraints)
        : kind === "camera"
            ? await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: { ideal: 30, max: 30 }, deviceId: await cameraDevice() }, audio: false })
            : await navigator.mediaDevices.getDisplayMedia({ video: qualityConstraints(selected), audio: sound });
    let releaseAudio: (() => void) | undefined;
    if (kind === "screen") {
        try {
            const sourceId = source ? captureConstraints(source, selected.fps, selected.resolution).video.mandatory.chromeMediaSourceId : "screen:-1:0";
            releaseAudio = await screenAudio(Native, capture, sourceId, sound, IS_WINDOWS, error => {
                console.error("FockyTV: áudio", error);
                void showNotification({ title: "FockyTV: áudio interrompido", body: String(error) });
            });
        } catch (error) {
            console.warn("FockyTV: áudio indisponível", error);
            void showNotification({ title: "FockyTV: transmissão sem áudio", body: String(error) });
        }
    }
    return { capture, releaseAudio, releaseVideo: undefined, quality: selected };
}

function watchEnded(kind: "screen" | "camera", session: Session, track: MediaStreamTrack) {
    track.addEventListener("ended", () => {
        if (publishers.get(kind) === session) {
            publishers.delete(kind);
            if (kind === "screen") clearDiscordShare();
        }
    }, { once: true });
}

// O tile local do Discord espera quadros; a captura nativa não passa pelo renderer, então mostra a imagem
// que o encoder salva a cada segundo (e um aviso até a primeira). A miniatura da live sai deste mesmo canvas.
function nativePreview(id: string) {
    const canvas = Object.assign(document.createElement("canvas"), { width: 1280, height: 720 });
    const context = canvas.getContext("2d")!;
    const stream = canvas.captureStream(1);
    let shown = false;
    const draw = async () => {
        if (stream.getVideoTracks()[0]?.readyState !== "live") return clearInterval(timer);
        const url = await Native.nativeShareThumbnail(id).catch(() => null);
        if (url) {
            const image = new Image();
            image.src = url;
            try {
                await image.decode();
                // Trocar de tela pode mudar a proporção.
                if (canvas.width !== image.width || canvas.height !== image.height) { canvas.width = image.width; canvas.height = image.height; }
                shown = true;
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                return;
            } catch { }
        }
        if (shown) return;
        context.fillStyle = "#111";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#fff";
        context.font = "bold 44px sans-serif";
        context.textAlign = "center";
        context.fillText("Transmitindo pela captura nativa (GPU)", canvas.width / 2, canvas.height / 2);
    };
    // Redesenha para o tile receber quadro mesmo quando abre depois.
    const timer = setInterval(() => void draw(), 1000);
    void draw();
    return stream;
}

async function publishNative(source: string, quality: ShareQuality) {
    const nick = nickname();
    const version = generation;
    if (!await Native.nativeEncoderReady())
        void showNotification({ title: "FockyTV", body: "Baixando o encoder nativo (~110 MB, só na primeira vez)..." });
    const id = await Native.startNativeShare({ source, fps: quality.fps, resolution: quality.resolution, bitrate: settings.store.nativeBitrate, audio: quality.soundshareEnabled ?? false, key: nick, endpoint: `${serverUrl(settings.store.url)}/api/livekit/whip`, style: liveStyle(settings.store.liveStyle) });
    const share: NativeShare = new NativeShare(Native, id, nativePreview(id), quality.fps, quality.resolution, error => {
        if (publishers.get("screen") !== share) return;
        publishers.delete("screen");
        clearDiscordShare();
        void showNotification({ title: "FockyTV", body: error ? `A captura nativa parou: ${error}` : "A captura nativa terminou." });
    });
    if (version !== generation || !discordShare) { await share.close(); return; }
    publishers.set("screen", share);
    updatePreview(discordShare, previewStreamId);
}

// true se a captura nativa assumiu (ou o usuário cancelou); false volta para a captura do Chromium.
async function tryNative(source: DiscordSource | undefined, quality: ShareQuality) {
    const native = IS_WINDOWS && settings.store.nativeCapture && source ? nativeSource(source) : undefined;
    if (!native || publishers.has("screen") || pending.has("screen")) return false;
    pending.add("screen");
    try { await publishNative(native, quality); return true; }
    catch (error) {
        console.warn("FockyTV: captura nativa", error);
        void showNotification({ title: "FockyTV: usando a captura do Discord", body: `Captura nativa indisponível: ${error}` });
        return !discordShare;
    } finally { pending.delete("screen"); }
}

async function publish(kind: "screen" | "camera", source?: DiscordSource, quality?: Partial<ShareQuality>) {
    const existing = publishers.get(kind);
    if (existing) { publishers.delete(kind); if (kind === "screen") clearDiscordShare(); await existing.close(); return; }
    if (pending.has(kind)) return;
    const base = serverUrl(settings.store.url);
    const nick = nickname();
    const version = generation;
    pending.add(kind);
    let capture: MediaStream | undefined;
    let session: Session | undefined;
    let selected: ShareQuality;
    let releaseAudio: (() => void) | undefined;
    let releaseVideo: (() => void) | undefined;
    try {
        ({ capture, releaseAudio, releaseVideo, quality: selected } = await openCapture(kind, source, quality));
        if (version !== generation || (source && !discordShare)) { releaseAudio?.(); releaseVideo?.(); capture.getTracks().forEach(track => track.stop()); return; }
        session = new Session(request, kind === "camera" ? cameraKey(nick) : nick, capture, releaseAudio, releaseVideo);
        session.style = liveStyle(settings.store.liveStyle);
        publishers.set(kind, session);
        session.pc.addEventListener("connectionstatechange", () => {
            if (["failed", "closed"].includes(session!.pc.connectionState) && publishers.get(kind) === session) {
                publishers.delete(kind);
                if (kind === "screen") clearDiscordShare();
                if (session!.pc.connectionState === "failed")
                    void showNotification({ title: "FockyTV", body: "A conexão da transmissão falhou. Abra o painel FockyTV para tentar novamente." });
            }
        });
        watchEnded(kind, session, capture.getVideoTracks()[0]);
        if (kind === "screen" && discordShare) updatePreview(discordShare, previewStreamId);
        await session.connect(`${base}/api/livekit/whip`);
        if (kind === "screen") await session.setQuality(selected);
    } catch (error) {
        if (publishers.get(kind) === session) publishers.delete(kind);
        releaseAudio?.();
        if (!session) releaseVideo?.();
        capture?.getTracks().forEach(track => track.stop());
        await session?.close();
        throw error;
    } finally { pending.delete(kind); }
}

// "Trocar de tela" do Discord: troca as faixas na mesma sessão, sem derrubar a live.
async function switchSource(source?: DiscordSource, quality?: Partial<ShareQuality>) {
    const session = publishers.get("screen");
    if (!session || pending.has("screen")) throw new Error("already sharing");
    if (session instanceof NativeShare) throw new Error("A captura nativa troca a fonte pelo encoder.");
    pending.add("screen");
    // O nativo só mantém uma captura de áudio por janela; a nova encerraria a antiga com erro.
    session.stopAudio();
    try {
        const { capture, releaseAudio } = await openCapture("screen", source, quality);
        if (publishers.get("screen") !== session) { releaseAudio?.(); capture.getTracks().forEach(track => track.stop()); throw new Error("cancelled"); }
        await session.replace(capture, releaseAudio);
        watchEnded("screen", session, capture.getVideoTracks()[0]);
    } finally { pending.delete("screen"); }
}

// O que está sendo transmitido (jogo, vídeo ou tela), para o perfil automático e o aviso da live.
let liveActivity: ReturnType<typeof detectProfile> | undefined;
let profileUsed = false;
// A resolução escolhida no Discord vale; o perfil só decide quando a escolha é "Fonte".
function applyProfile(quality: ShareQuality, source?: DiscordSource) {
    let games: ReturnType<typeof RunningGameStore.getRunningGames> = [], visible: ReturnType<typeof RunningGameStore.getVisibleGame> = null;
    try { games = RunningGameStore.getRunningGames() ?? []; visible = RunningGameStore.getVisibleGame(); } catch { /* Store ausente nesta versão do Discord. */ }
    liveActivity = detectProfile(source, games, visible);
    profileUsed = settings.store.autoProfile && !quality.resolution;
    return profileUsed ? { ...quality, ...profileFor(liveActivity.kind, settings.store.profiles) } : quality;
}

// O bot do servidor avisa no chat do canal de voz da live: título, jogo ou janela e miniatura (chamadas privadas não têm aviso).
async function announceLive(share: NonNullable<typeof discordShare>) {
    if (!share.guildId) return;
    await new Promise(resolve => setTimeout(resolve, 4000)); // a captura nativa leva alguns segundos para a primeira imagem
    const session = publishers.get("screen");
    if (!session?.capture || discordShare !== share) return;
    const user = UserStore.getCurrentUser();
    const activity = liveActivity;
    const clip = (text: string) => Array.from(text.trim()).slice(0, 100).join("");
    const image = await thumbnail(session.capture, 640).catch(() => "");
    const status = await session.announce(JSON.stringify({
        channel: share.channelId,
        title: clip(settings.store.liveTitle || `Live de ${user?.globalName ?? user?.username ?? nickname()}`),
        detail: activity?.name ? clip(`${{ game: "🎮", video: "🎬", screen: "🖥️" }[activity.kind]} ${activity.name}`) : "",
        thumbnail: image.replace(/^data:image\/jpeg;base64,/, "")
    }));
    if (status >= 300) console.warn("FockyTV: aviso da live", status);
}

function commitDiscordQuality(quality: ShareQuality) {
    discordQuality = quality;
    FluxDispatcher.dispatch({ type: "STREAM_UPDATE_SETTINGS", preset: quality.preset, resolution: quality.resolution, frameRate: quality.fps, soundshareEnabled: quality.soundshareEnabled });
}

function updateDiscordQuality(options: { resolution?: number; frameRate?: number; preset?: number; soundshareEnabled?: boolean; }) {
    const session = publishers.get("screen");
    const share = discordShare;
    if (!routingEnabled || !share || !session || !discordQuality) return false;
    // O menu pode emitir várias escolhas antes de o encoder terminar a anterior.
    shareChanges = shareChanges.catch(() => {}).then(async () => {
        if (discordShare !== share || publishers.get("screen") !== session) return;
        const previous = discordQuality!;
        try {
            const selected = shareQuality({ ...options, fps: options.frameRate }, previous);
            if (selected.fps !== previous.fps || selected.resolution !== previous.resolution)
                await session.setQuality(selected);
            if (discordShare === share && publishers.get("screen") === session) commitDiscordQuality(selected);
        } catch (error) {
            if (discordShare === share && publishers.get("screen") === session) {
                commitDiscordQuality(previous);
                void showNotification({ title: "FockyTV: não foi possível alterar a qualidade", body: String(error) });
            }
        }
    });
    return true;
}

interface Live { streamKey: string; engine?: string; }
type UpdateInfo = Awaited<ReturnType<typeof Native.checkUpdate>>;
const versionLabel = (version?: number) => version ? `v${version}` : "";

// Versão atual → nova e o que muda (mais recente primeiro).
function UpdateDetails({ update }: { update: UpdateInfo; }) {
    const changes = update.changes ?? [];
    return <div className="fockytv-update">
        {update.version && <div className="fockytv-update-version">
            {update.current && <span>{versionLabel(update.current)}</span>}
            {update.current && <span aria-hidden="true">→</span>}
            <span className="fockytv-update-new">{versionLabel(update.version)}</span>
        </div>}
        {changes.length > 0 && <ul className="fockytv-update-changes">
            {changes.slice(0, 5).map((change, index) => <li key={index}>{change}</li>)}
            {changes.length > 5 && <li className="fockytv-update-more">e mais {changes.length - 5} {changes.length - 5 === 1 ? "mudança" : "mudanças"}</li>}
        </ul>}
    </div>;
}

function UpdateNotice({ update }: { update: UpdateInfo; }) {
    const [state, setState] = useState<"idle" | "busy" | "started" | "current">("idle");
    const [error, setError] = useState("");
    const install = async () => {
        setState("busy"); setError("");
        try { setState((await Native.installUpdate()).started ? "started" : "current"); }
        catch (error) { setError(String(error)); setState("idle"); }
    };
    return <div>
        <UpdateDetails update={update} />
        {state === "started" ? <p role="status" className="fockytv-update-note">Instalando… o Discord vai fechar. Reabra quando a instalação terminar.</p>
            : state === "current" ? <p role="status" className="fockytv-update-note">O FockyTV já está atualizado.</p>
                : <>
                    <button type="button" className="fockytv-update-button" disabled={state === "busy"} onClick={event => { event.stopPropagation(); void install(); }}>
                        {state === "busy" ? "Preparando…" : "Atualizar agora"}
                    </button>
                    <p className="fockytv-update-note">O Discord fecha durante a instalação; reabra quando terminar.</p>
                </>}
        {error && <p role="alert" className="fockytv-update-error">{error}</p>}
    </div>;
}

function UpdateControls() {
    const [available, setAvailable] = useState(false);
    const [update, setUpdate] = useState<UpdateInfo | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const mounted = useRef(true);
    const check = async () => {
        setBusy(true); setError("");
        try {
            const result = await Native.checkUpdate();
            if (mounted.current) {
                setAvailable(result.available);
                setUpdate(result.available ? result : null);
                setMessage(result.available ? "Nova versão do FockyTV disponível." : `FockyTV está atualizado${result.version ? ` (${versionLabel(result.version)})` : ""}.`);
            }
        } catch (error) { if (mounted.current) setError(String(error)); }
        finally { if (mounted.current) setBusy(false); }
    };
    useEffect(() => { mounted.current = true; void check(); return () => { mounted.current = false; }; }, []);
    const install = async () => {
        setBusy(true); setError("");
        try {
            const result = await Native.installUpdate();
            if (mounted.current) {
                setAvailable(false);
                setUpdate(null);
                setMessage(result.started ? "Instalando. O cliente será fechado; reabra quando a instalação terminar." : "FockyTV está atualizado.");
            }
        } catch (error) { if (mounted.current) setError(String(error)); }
        finally { if (mounted.current) setBusy(false); }
    };
    return <div>
        <p role="status">{message}</p>
        {update && <UpdateDetails update={update} />}
        {error && <p role="alert">{error}</p>}
        <Button disabled={busy} onClick={available ? install : check}>{available ? "Instalar atualização e fechar o cliente" : "Verificar atualização"}</Button>
    </div>;
}

async function notifyUpdate() {
    try {
        const result = await Native.checkUpdate();
        if (!routingEnabled || !result.available || result.revision === notifiedRevision) return;
        notifiedRevision = result.revision;
        const versions = result.version ? `${result.current ? `${versionLabel(result.current)} → ` : ""}${versionLabel(result.version)}` : "";
        // O body é o que aparece se o Vencord usar notificações nativas do sistema (sem botão nem lista).
        void showNotification({
            title: "FockyTV: atualização disponível",
            body: [versions, result.changes?.slice(0, 3).join(" · "), "Clique para abrir o painel e instalar."].filter(Boolean).join("\n"),
            richBody: <UpdateNotice update={result} />,
            color: "#5865f2",
            permanent: true,
            onClick: openPanel
        });
    } catch (error) { console.warn("FockyTV: verificar atualização", error); }
}

function StreamDiagnostics({ player }: { player: Session | null; }) {
    type Source = { label: string; getStats(): Promise<RTCStatsReport>; };
    type Sample = { at: string; streams: { label: string; metrics: ReturnType<typeof videoStats>; error?: string; }[]; };
    const [sources, setSources] = useState<Source[] | null>(null);
    const [samples, setSamples] = useState<Sample[]>([]);
    const screen = publishers.get("screen");
    const available: Source[] = screen instanceof Session ? [{ label: "Envio da tela", getStats: () => screen.pc.getStats() }] : [];
    for (const { viewing } of watching.values())
        if (viewing) available.push({ label: `Recepção da live ${available.length + 1}`, getStats: () => viewing.getStats() });
    if (player) available.push({ label: "Recepção do player", getStats: () => player.pc.getStats() });

    useEffect(() => {
        if (!sources) return;
        let active = true, polling = false;
        const previous: (RTCStatsReport | undefined)[] = [];
        const sample = async () => {
            if (polling) return;
            polling = true;
            try {
                const at = new Date().toISOString();
                const streams = await Promise.all(sources.map(async (source, index) => {
                    try {
                        const report = await source.getStats();
                        const metrics = videoStats(report, previous[index]);
                        previous[index] = report;
                        return { label: source.label, metrics };
                    } catch {
                        return { label: source.label, metrics: [], error: "Não foi possível ler esta conexão." };
                    }
                }));
                if (!active) return;
                setSamples(values => [...values, { at, streams }]);
            } finally { polling = false; }
        };
        const timer = setInterval(() => void sample(), 1000);
        const stop = setTimeout(() => setSources(null), 30_000);
        void sample();
        return () => { active = false; clearInterval(timer); clearTimeout(stop); };
    }, [sources]);

    const report = JSON.stringify({ samples }, null, 2);
    return <div>
        <Button disabled={!sources && !available.length} onClick={() => {
            if (sources) setSources(null);
            else { setSamples([]); setSources(available); }
        }}>{sources ? "Parar diagnóstico" : "Diagnosticar transmissão (30 s)"}</Button>
        <p role="status">{sources ? `Coletando por 30 s: ${samples.length} amostras. Mantenha o jogo em movimento.` : samples.length ? "Diagnóstico concluído. Copie o relatório para análise." : "Mede envio e lives abertas neste cliente. Para medir recepção, assista à live durante a coleta."}</p>
        {samples.length > 0 && <>
            <Button onClick={() => void copyToClipboard(report).catch(() => {
                void showNotification({ title: "FockyTV", body: "Não foi possível copiar o diagnóstico. Abra Ver medições para copiar o texto." });
            })}>Copiar diagnóstico</Button>
            <details><summary>Ver medições</summary><pre style={{ maxHeight: 240, overflow: "auto" }}>{report}</pre></details>
        </>}
    </div>;
}

function Panel(props: RenderModalProps) {
    const [lives, setLives] = useState<Live[]>([]);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [, redraw] = useState(0);
    const [watching, setWatching] = useState("");
    const video = useRef<HTMLVideoElement>(null);
    const viewer = useRef<Session | null>(null);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        let polling = false;
        const refresh = async () => {
            if (polling) return;
            polling = true;
            try {
                const response = await request(`${serverUrl(settings.store.url)}/api/status`, "GET");
                if (response.status !== 200) throw new Error(`Status do servidor: ${response.status}`);
                const data: unknown = JSON.parse(response.body);
                if (!Array.isArray(data) || !data.every(item => item && typeof item.streamKey === "string"))
                    throw new Error("Lista de lives inválida.");
                if (mounted.current) setLives(data);
            } catch (error) { if (mounted.current) setError(String(error)); }
            finally { polling = false; }
        };
        void refresh();
        const timer = setInterval(() => { void refresh(); redraw(n => n + 1); }, 5000);
        closePanel = props.onClose;
        return () => {
            mounted.current = false;
            modalKey = undefined;
            closePanel = undefined;
            clearInterval(timer);
            void viewer.current?.close();
        };
    }, []);

    async function run(action: () => Promise<void>) {
        setBusy(true); setError("");
        try { await action(); }
        catch (error) { if (mounted.current) setError(String(error)); }
        finally { if (mounted.current) { setBusy(false); redraw(n => n + 1); } }
    }

    async function watch(live: Live) {
        if (live.engine === "livekit") throw new Error("Esta live usa LiveKit. Abra o site FockyTV para assisti-la.");
        await viewer.current?.close();
        const session = new Session(request, streamKey(live.streamKey));
        viewer.current = session;
        if (video.current) video.current.srcObject = session.media;
        await session.connect(`${serverUrl(settings.store.url)}/api/whep?viewer=${encodeURIComponent(nickname())}`);
        if (mounted.current) setWatching(live.streamKey);
    }

    return <Modal {...props} title="FockyTV" size="lg">
        <div style={{ padding: 16, display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 8 }}>
                <Button disabled={busy} onClick={() => run(() => publish("screen"))}>{publishers.has("screen") ? "Parar tela" : "Compartilhar tela"}</Button>
                <Button disabled={busy} onClick={() => run(() => publish("camera"))}>{publishers.has("camera") ? "Parar câmera" : "Ligar câmera"}</Button>
                <Button onClick={() => run(stopPublishing)}>Parar tudo</Button>
            </div>
            <p>Fechar este painel para o player; tela e câmera continuam até você parar ou sair da chamada.</p>
            <a href={serverUrl(settings.store.url)} target="_blank" rel="noreferrer">Abrir site FockyTV (inclui lives LiveKit)</a>
            <UpdateControls />
            <StreamDiagnostics player={viewer.current} />
            {error && <p role="alert">{error}</p>}
            <video ref={video} autoPlay controls playsInline aria-label={`Live FockyTV ${watching}`} style={{ width: "100%", maxHeight: 400, background: "black" }} />
            {watching && <Button onClick={() => run(async () => {
                await viewer.current?.close(); viewer.current = null;
                if (video.current) video.current.srcObject = null;
                setWatching("");
            })}>Parar de assistir</Button>}
            {lives.length === 0 && <p>Nenhuma live encontrada.</p>}
            {lives.map(live => <Button key={live.streamKey} disabled={busy} onClick={() => run(() => watch(live))}>
                Assistir {live.streamKey}{live.engine === "livekit" ? " (LiveKit — site)" : ""}
            </Button>)}
        </div>
    </Modal>;
}

const jiraRequest: JiraFetch = async (path, method = "GET", body) => {
    const { jiraSite: site, jiraEmail: email, jiraToken: token } = settings.store;
    const response = await Native.jiraRequest(site, email, token, path, method, body === undefined ? undefined : JSON.stringify(body));
    if (response.status >= 400) throw new Error(jiraError(response.status, response.body));
    return response.body ? JSON.parse(response.body) : null;
};

function openJira() {
    openModal(props => <JiraPanel {...props} context={{ site: settings.store.jiraSite, request: jiraRequest, board: settings.store.jiraBoard || undefined, setBoard: id => { settings.store.jiraBoard = id; } }} />);
}

const JiraIcon = ({ className }: { className?: string; }) => <svg className={className} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53Z" />
    <path d="M6.77 6.8a4.36 4.36 0 0 0 4.34 4.34h1.8v1.72a4.36 4.36 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.83-.83H6.77Z" />
    <path d="M2 11.6c0 2.4 1.95 4.34 4.35 4.34h1.78v1.72c0 2.4 1.95 4.34 4.35 4.34v-9.57a.84.84 0 0 0-.84-.84H2Z" />
</svg>;

// Botão do Jira na fileira de câmera/tela do painel de voz; só aparece com site, e-mail e token configurados.
function JiraButton() {
    const { jiraSite: site, jiraEmail: email, jiraToken: token } = settings.use(["jiraSite", "jiraEmail", "jiraToken"]);
    if (!site || !email || !token) return null;
    return <Tooltip text="Jira">
        {tooltip => <button type="button" {...tooltip} aria-label="Jira" className="fockytv-jira-button" onClick={openJira}>
            <JiraIcon />
        </button>}
    </Tooltip>;
}

function openPanel() {
    if (modalKey) return;
    modalKey = openModal(props => <Panel {...props} />);
}

export default definePlugin({
    name: "FockyTV",
    description: "Compartilhe tela/câmera e assista lives FockyTV via WHIP/WHEP.",
    authors: [{ name: "Focky", id: 0n }],
    settings,
    settingsAboutComponent: () => <><Button onClick={openPanel}>Abrir FockyTV</Button><UpdateControls /></>,
    flux: {
        USER_SETTINGS_PROTO_UPDATE() {
            setTimeout(() => void syncCameraFilter().catch(error => {
                console.error("FockyTV: filtro da câmera", error);
                void showNotification({ title: "FockyTV: falha no filtro da câmera", body: String(error) });
            }), 0);
        },
        VOICE_STATE_UPDATES() {
            setTimeout(() => {
                const channel = SelectedChannelStore.getVoiceChannelId();
                for (const [id, entry] of cameraViewers)
                    if (entry.channelId !== channel || VoiceStateStore.getVoiceStateForUser(id)?.channelId !== channel) endCamera(id);
            }, 0);
            const channelId = SelectedChannelStore.getVoiceChannelId();
            if (!channelId || (discordShare && channelId !== discordShare.channelId)) { void stopPublishing(); closePanel?.(); }
        },
        LOGOUT() { setTimeout(() => { for (const id of cameraViewers.keys()) endCamera(id); }, 0); void stopPublishing(); closePanel?.(); }
    },
    patches: discordPatches,
    managedStyle,
    // Anel no avatar e selo "AO VIVO" com o estilo do dono da live FockyTV (o seu vem da sua configuração);
    // sem live, quem assiste a sua ganha ondas e o olho no avatar.
    liveClass(userId: string, part: "avatar" | "badge") {
        const style = userId === UserStore.getCurrentUser()?.id ? discordShare && liveStyle(settings.store.liveStyle) : ownerStyles.get(userId);
        if (style) return `fockytv-${part} fockytv-style-${style}`;
        if (part === "avatar" && watchingMyLive(userId)) return "fockytv-viewer";
    },
    jiraButton: () => <JiraButton />,
    openJira,
    watchPill: (userId: string) => watchingMyLive(userId) ? <span key="watch" className="fockytv-watch-pill"><EyeIcon />ASSISTINDO</span> : null,
    useLiveViewers(stream: string) {
        const discord = useStateFromStores([ApplicationStreamingStore], () => liveViewers.get(stream)?.length, [stream]);
        const web = useStateFromStores([ApplicationStreamingStore], () => webViewers.get(stream) ?? 0, [stream]);
        return discord == null ? null : { discord, web };
    },
    viewerCount({ discord, web }: { discord: number; web: number; }) {
        const total = discord + web;
        if (!total) return null;
        return <div className="fockytv-viewer-count">
            <UsersIcon />{total} {total === 1 ? "usuário assistindo" : "usuários assistindo"}
            {!!discord && <span className="fockytv-viewer-source">{discord} pelo Discord</span>}
            {!!web && <span className="fockytv-viewer-source">{web} pelo FockyTV</span>}
        </div>;
    },
    routeEnabled: () => routingEnabled,
    discordStream: () => discordShare,
    discordStreamForUser: (userId: string, guildId?: string | null) => discordShare?.ownerId === userId && discordShare.guildId === (guildId ?? null) ? discordShare : null,
    useWatchingMyLive: (userId: string) => useStateFromStores([ApplicationStreamingStore], () => watchingMyLive(userId), [userId]),
    viewerIds: (stream: string | { guildId?: string | null; channelId: string; ownerId: string; }) =>
        liveViewers.get(typeof stream === "string" ? stream : keyOf(stream)),
    discordStreamForKey(key: string) {
        const share = discordShare;
        if (!share) return null;
        const expected = share.guildId ? `guild:${share.guildId}:${share.channelId}:${share.ownerId}` : `call:${share.channelId}:${share.ownerId}`;
        return key === expected ? share : null;
    },
    includeDiscordShare(streams: Stream[], channelId?: string) {
        return discordShare && (!channelId || discordShare.channelId === channelId) && !streams.some(stream => stream.ownerId === discordShare!.ownerId)
            ? [...streams, discordShare] : streams;
    },
    updateDiscordQuality,
    videoComponent(original: React.ComponentType<VideoProps>) { OriginalVideo = original; return VideoComponent; },
    async startDiscordShare(source?: DiscordSource, quality?: Partial<ShareQuality>) {
        const channelId = SelectedChannelStore.getVoiceChannelId();
        const user = UserStore.getCurrentUser();
        if (!channelId || !user) return [false, "no user or channel"];
        if (pending.has("screen")) return [false, "already sharing"];
        if (publishers.has("screen") && discordShare) {
            try {
                const session = publishers.get("screen");
                const native = session instanceof NativeShare && source ? nativeSource(source) : undefined;
                if (session instanceof NativeShare && !native) throw new Error("Fonte incompatível com a captura nativa.");
                const handle = source?.id?.match(/^screen-handle:(\d+)$/)?.[1];
                if (handle && !native) source = { ...source, id: await Native.screenSource(handle, source!.name) };
                const share = discordShare;
                const next = shareChanges.catch(() => {}).then(async () => {
                    if (discordShare !== share || publishers.get("screen") !== session) throw new Error("Transmissão encerrada.");
                    const previous = discordQuality!;
                    const selected = applyProfile(shareQuality(quality ?? {}, previous), source);
                    if (session instanceof NativeShare) await session.restart(native, selected);
                    else {
                        await switchSource(source, selected);
                        try { await session!.setQuality(selected); }
                        catch (error) { await session!.setQuality(previous); throw error; }
                    }
                    if (discordShare === share) commitDiscordQuality(selected);
                });
                shareChanges = next;
                await next;
                return [true, undefined];
            } catch (error) {
                console.error("FockyTV: trocar fonte", error);
                void showNotification({ title: "FockyTV: falha ao trocar de tela", body: String(error) });
                return [false, String(error)];
            }
        }
        if (publishers.has("screen")) return [false, "already sharing"];
        let selected: ShareQuality;
        try { selected = applyProfile(shareQuality(quality ?? {}, StreamingSettings.getState()), source); }
        catch (error) { return [false, String(error)]; }
        const guildId = ChannelStore.getChannel(channelId)?.guild_id ?? null;
        const share: NonNullable<typeof discordShare> = { channelId, guildId, ownerId: user.id, streamType: guildId ? "guild" : "call", state: "CONNECTING" };
        discordShare = share;
        discordQuality = selected;
        ApplicationStreamingStore.emitChange();
        try {
            if (!await tryNative(source, selected)) {
                const handle = source?.id?.match(/^screen-handle:(\d+)$/)?.[1];
                if (handle) source = { ...source, id: await Native.screenSource(handle, source!.name) };
                await publish("screen", source, selected);
            }
            if (discordShare !== share || !publishers.has("screen")) return [false, "cancelled"];
            share.state = "ACTIVE";
            commitDiscordQuality(selected);
            ApplicationStreamingStore.emitChange();
            const profile = profileUsed && liveActivity ? ` Perfil ${profileLabels[liveActivity.kind]}: ${selected.resolution ? `${selected.resolution}p` : "fonte"} ${selected.fps} FPS.` : "";
            void showNotification({ title: "FockyTV", body: `Transmitindo como ${nickname()} no FockyTV.${profile}` });
            void announceLive(share).catch(error => console.warn("FockyTV: aviso da live", error));
            return [true, undefined];
        } catch (error) {
            if (discordShare === share) clearDiscordShare();
            console.error("FockyTV: iniciar pelo Discord", error);
            void showNotification({ title: "FockyTV: falha ao transmitir", body: String(error) });
            return [false, String(error)];
        }
    },
    // Discord web/Vesktop: o botão vai direto ao getDisplayMedia (seletor do Vesktop), sem startStreamWithSource.
    startWebShare() {
        if (!routingEnabled) return false;
        void this.startDiscordShare();
        return true;
    },
    ftvTag: (user: { username?: string; }) => <FtvTag user={user} />,
    fetchFtvPreview(guildId: string | null, channelId: string, ownerId: string) {
        if (!routingEnabled) return false;
        const own = ownerId === UserStore.getCurrentUser()?.id ? publishers.get("screen") : undefined;
        const room = own ? nickname() : liveOwners.get(ownerId);
        if (!room) return false;
        if (!ApplicationStreamPreviewStore.shouldFetchPreview(guildId, channelId, ownerId)) return true;
        const streamKey = guildId ? `guild:${guildId}:${channelId}:${ownerId}` : `call:${channelId}:${ownerId}`;
        const version = generation;
        FluxDispatcher.dispatch({ type: "STREAM_PREVIEW_FETCH_START", streamKey });
        void (async () => {
            let temporary: Viewing | undefined;
            try {
                let media = own?.capture ?? watching.get(streamKey)?.viewing?.media;
                if (!media) {
                    livekit ??= loadLivekit(livekitSource, proxySocket(Native));
                    temporary = await watchLive(livekit, request, serverUrl(settings.store.url), room, nickname(), () => {});
                    media = temporary.media;
                }
                const previewURL = await thumbnail(media);
                if (!routingEnabled || version !== generation || (own ? publishers.get("screen") !== own : liveOwners.get(ownerId) !== room))
                    throw new Error("A live terminou.");
                FluxDispatcher.dispatch({ type: "STREAM_PREVIEW_FETCH_SUCCESS", streamKey, previewURL });
            } catch (error) {
                console.warn("FockyTV: miniatura", error);
                FluxDispatcher.dispatch({ type: "STREAM_PREVIEW_FETCH_FAIL", streamKey, retryAfter: 30_000 });
            } finally { temporary?.close(); }
        })();
        return true;
    },
    cameraActive: () => publishers.has("camera"),
    selfVideo(state: { userId?: string; channelId?: string | null; selfVideo?: boolean; }) {
        return !!state.selfVideo || (!!state.userId && !!cameraViewers.get(state.userId)?.viewing && state.channelId === SelectedChannelStore.getVoiceChannelId()) || (publishers.has("camera") && state.userId === UserStore.getCurrentUser()?.id && state.channelId === SelectedChannelStore.getVoiceChannelId());
    },
    discordCamera(enabled: boolean) {
        const active = publishers.has("camera");
        if (!enabled && !active) return false;
        if (enabled === active || pending.has("camera")) return true;
        publish("camera").then(() => {
            const track = publishers.get("camera")?.capture?.getVideoTracks()[0];
            if (track) {
                const { width, height } = track.getSettings();
                void showNotification({ title: "FockyTV", body: `Câmera no FockyTV como ${cameraKey(nickname())}: ${track.label} (${width}x${height}).` });
            }
        }, error => {
            console.error("FockyTV: câmera", error);
            void showNotification({ title: "FockyTV: falha na câmera", body: String(error) });
        });
        return true;
    },
    stopDiscordStream(key: string) {
        const share = discordShare;
        if (!share) return false;
        const expected = share.guildId ? `guild:${share.guildId}:${share.channelId}:${share.ownerId}` : `call:${share.channelId}:${share.ownerId}`;
        if (key !== expected) return false;
        clearDiscordShare();
        const session = publishers.get("screen");
        publishers.delete("screen");
        void session?.close();
        return true;
    },
    liveSelfStream,
    watchFockyStream(key: string) {
        if (!routingEnabled || !liveOwners.has(ownerOf(key))) return false;
        fockyStreams.add(key);
        // Assistir de novo (ex.: "tentar novamente" após falha) sempre reconecta.
        closeViewing(key);
        void startWatch(key);
        return true;
    },
    unwatchFockyStream(key: string) {
        if (!fockyStreams.has(key)) return false;
        endWatch(key);
        return true;
    },
    start() {
        routingEnabled = true;
        livePoll = setInterval(() => void refreshLives(), 5000);
        MediaEngineStore.addChangeListener(syncAudio);
        void refreshPresence();
        presencePoll = setInterval(() => void refreshPresence(), 30_000);
        updateCheck = setTimeout(() => void notifyUpdate(), 30_000);
        updatePoll = setInterval(() => void notifyUpdate(), 15 * 60 * 1000); // 2 chamadas à API do GitHub por checagem: bem abaixo do limite de 60/h sem token.
        document.addEventListener("keydown", replayShortcut);
    },
    stop() {
        routingEnabled = false;
        for (const id of cameraViewers.keys()) endCamera(id);
        clearInterval(livePoll);
        MediaEngineStore.removeChangeListener(syncAudio);
        clearInterval(presencePoll);
        clearTimeout(updateCheck);
        clearInterval(updatePoll);
        document.removeEventListener("keydown", replayShortcut);
        closePictureInPicture();
        ftvUsers.clear();
        ftvListeners.forEach(listener => listener());
        void refreshLives(); // sem routing: encerra as lives assistidas e tira o "AO VIVO"
        closePanel?.();
        void stopPublishing();
    }
});
