// SPDX-License-Identifier: GPL-3.0-or-later
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { IS_WINDOWS } from "@utils/constants";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { RenderModalProps, Stream } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { ApplicationStreamingStore, ApplicationStreamPreviewStore, Button, ChannelStore, FluxDispatcher, MediaEngineStore, Modal, openModal, React, SelectedChannelStore, UserStore, VoiceStateStore, useEffect, useRef, useState } from "@webpack/common";

import { screenAudio } from "./audio";
import { captureConstraints, DiscordSource, discordPatches, matchCamera } from "./discord";
import { streamAudio } from "./playback";
import { cameraKey, serverUrl, streamKey } from "./protocol";
import { qualityConstraints, shareQuality, ShareQuality } from "./quality";
import { Request, Session } from "./session";
import { thumbnail } from "./thumbnail";
import { loadLivekit, proxySocket, Viewing, watchLive } from "./viewer";
import livekitSource from "file://./livekit-client.umd.js";

const settings = definePluginSettings({
    url: { type: OptionType.STRING, description: "Servidor FockyTV", default: "https://fockytv.felipemayer.com.br", isValid: value => { try { if (typeof value !== "string") return false; serverUrl(value); return true; } catch { return false; } } },
    fps: { type: OptionType.SELECT, description: "Quadros por segundo", options: [15, 30, 60].map(value => ({ label: `${value} fps`, value, default: value === 60 })) },
    height: { type: OptionType.SELECT, description: "Resolução máxima", options: [{ label: "Original", value: 0, default: true }, { label: "1080p", value: 1080 }, { label: "720p", value: 720 }] }
});
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
    return <video ref={video} className={props.className} autoPlay muted playsInline onResize={resize} onLoadedData={() => { resize(); props.onReady?.(); }} aria-label={remoteCamera ? "Câmera FockyTV" : watched ? "Live FockyTV" : "Preview da sua transmissão FockyTV"} style={{ width: "100%", height: "100%", objectFit: camera || remoteCamera ? "cover" : "contain" }} />;
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
const publishers = new class extends Map<"screen" | "camera", Session> {
    set(kind: "screen" | "camera", session: Session) { super.set(kind, session); setTimeout(syncCamera, 0); return this; }
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
const watching = new Map<string, { viewing?: Viewing; audio?: ReturnType<typeof streamAudio>; }>();
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

function liveSelfStream(state: { userId?: string; channelId?: string | null; selfStream?: boolean; }) {
    return !!state.selfStream || (!!state.userId && liveOwners.has(state.userId) && state.channelId != null && state.channelId === SelectedChannelStore.getVoiceChannelId());
}

async function refreshLives() {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    const keys = new Map<string, string>(); // minúsculo → stream key exata
    if (channelId && routingEnabled) {
        try {
            const response = await request(`${serverUrl(settings.store.url)}/api/status`, "GET");
            if (response.status !== 200) return;
            for (const live of JSON.parse(response.body) as { streamKey: string; engine?: string; videoTracks?: unknown[]; }[])
                if (live.engine === "livekit" && live.videoTracks?.length) keys.set(live.streamKey.toLowerCase(), live.streamKey);
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
    const changed = [...new Set([...owners.keys(), ...liveOwners.keys()])].filter(id => owners.has(id) !== liveOwners.has(id));
    liveOwners.clear();
    owners.forEach((key, id) => liveOwners.set(id, key));
    for (const key of [...watching.keys()]) if (!liveOwners.has(ownerOf(key))) endWatch(key);
    if (!changed.length || !channelId) return;
    // Reaplica o estado de voz atual: os patches marcam selfStream e o Discord mostra "AO VIVO" e o botão Assistir.
    // ponytail: um Go Live nativo simultâneo some até a próxima atualização de voz real desse usuário
    const guildId = ChannelStore.getChannel(channelId)?.guild_id ?? null;
    const voiceStates = changed.map(id => VoiceStateStore.getVoiceStateForUser(id)).filter(Boolean).map(state => ({ ...state, guildId, selfStream: false }));
    if (voiceStates.length) FluxDispatcher.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates });
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
    const entry: { viewing?: Viewing; audio?: ReturnType<typeof streamAudio>; } = {};
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
    const selected = shareQuality(quality ?? {}, discordShare ? StreamingSettings.getState() : { fps: settings.store.fps, resolution: settings.store.height, soundshareEnabled: StreamingSettings.getState().soundshareEnabled });
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
    return { capture, releaseAudio, quality: selected };
}

function watchEnded(kind: "screen" | "camera", session: Session, track: MediaStreamTrack) {
    track.addEventListener("ended", () => {
        if (publishers.get(kind) === session) {
            publishers.delete(kind);
            if (kind === "screen") clearDiscordShare();
        }
    }, { once: true });
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
    try {
        ({ capture, releaseAudio, quality: selected } = await openCapture(kind, source, quality));
        if (version !== generation || (source && !discordShare)) { releaseAudio?.(); capture.getTracks().forEach(track => track.stop()); return; }
        session = new Session(request, kind === "camera" ? cameraKey(nick) : nick, capture, releaseAudio);
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
        capture?.getTracks().forEach(track => track.stop());
        await session?.close();
        throw error;
    } finally { pending.delete(kind); }
}

// "Trocar de tela" do Discord: troca as faixas na mesma sessão, sem derrubar a live.
async function switchSource(source?: DiscordSource, quality?: Partial<ShareQuality>) {
    const session = publishers.get("screen");
    if (!session || pending.has("screen")) throw new Error("already sharing");
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
function UpdateControls() {
    const [available, setAvailable] = useState(false);
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
                setMessage(result.available ? "Nova versão do FockyTV disponível." : "FockyTV está atualizado.");
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
                setMessage(result.started ? "Instalando. O cliente será fechado; reabra quando a instalação terminar." : "FockyTV está atualizado.");
            }
        } catch (error) { if (mounted.current) setError(String(error)); }
        finally { if (mounted.current) setBusy(false); }
    };
    return <div>
        <p role="status">{message}</p>
        {error && <p role="alert">{error}</p>}
        <Button disabled={busy} onClick={available ? install : check}>{available ? "Instalar atualização e fechar o cliente" : "Verificar atualização"}</Button>
    </div>;
}

async function notifyUpdate() {
    try {
        const result = await Native.checkUpdate();
        if (!routingEnabled || !result.available || result.revision === notifiedRevision) return;
        notifiedRevision = result.revision;
        void showNotification({ title: "FockyTV: atualização disponível", body: "Clique para abrir o painel e instalar quando quiser.", onClick: openPanel });
    } catch (error) { console.warn("FockyTV: verificar atualização", error); }
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
    routeEnabled: () => routingEnabled,
    discordStream: () => discordShare,
    discordStreamForUser: (userId: string, guildId?: string | null) => discordShare?.ownerId === userId && discordShare.guildId === (guildId ?? null) ? discordShare : null,
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
                const handle = source?.id?.match(/^screen-handle:(\d+)$/)?.[1];
                if (handle) source = { ...source, id: await Native.screenSource(handle, source!.name) };
                const session = publishers.get("screen");
                const share = discordShare;
                const next = shareChanges.catch(() => {}).then(async () => {
                    if (discordShare !== share || publishers.get("screen") !== session) throw new Error("Transmissão encerrada.");
                    const previous = discordQuality!;
                    const selected = shareQuality(quality ?? {}, previous);
                    await switchSource(source, selected);
                    try { await session!.setQuality(selected); }
                    catch (error) { await session!.setQuality(previous); throw error; }
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
        try { selected = shareQuality(quality ?? {}, StreamingSettings.getState()); }
        catch (error) { return [false, String(error)]; }
        const guildId = ChannelStore.getChannel(channelId)?.guild_id ?? null;
        const share: NonNullable<typeof discordShare> = { channelId, guildId, ownerId: user.id, streamType: guildId ? "guild" : "call", state: "CONNECTING" };
        discordShare = share;
        discordQuality = selected;
        ApplicationStreamingStore.emitChange();
        try {
            const handle = source?.id?.match(/^screen-handle:(\d+)$/)?.[1];
            if (handle) source = { ...source, id: await Native.screenSource(handle, source!.name) };
            await publish("screen", source, selected);
            if (discordShare !== share || !publishers.has("screen")) return [false, "cancelled"];
            share.state = "ACTIVE";
            commitDiscordQuality(selected);
            ApplicationStreamingStore.emitChange();
            void showNotification({ title: "FockyTV", body: `Transmitindo como ${nickname()} no FockyTV.` });
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
        updatePoll = setInterval(() => void notifyUpdate(), 6 * 60 * 60 * 1000);
    },
    stop() {
        routingEnabled = false;
        for (const id of cameraViewers.keys()) endCamera(id);
        clearInterval(livePoll);
        MediaEngineStore.removeChangeListener(syncAudio);
        clearInterval(presencePoll);
        clearTimeout(updateCheck);
        clearInterval(updatePoll);
        ftvUsers.clear();
        ftvListeners.forEach(listener => listener());
        void refreshLives(); // sem routing: encerra as lives assistidas e tira o "AO VIVO"
        closePanel?.();
        void stopPublishing();
    }
});
