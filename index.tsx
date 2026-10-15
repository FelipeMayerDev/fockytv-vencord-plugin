// SPDX-License-Identifier: GPL-3.0-or-later
import { ChatBarButton } from "@api/ChatButtons";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { IconComponent, OptionType, PluginNative } from "@utils/types";
import { RenderModalProps, Stream } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { ApplicationStreamingStore, Button, ChannelStore, FluxDispatcher, Modal, openModal, React, SelectedChannelStore, UserStore, useEffect, useRef, useState } from "@webpack/common";

import { captureAudio } from "./audio";
import { captureConstraints, DiscordSource, discordPatches } from "./discord";
import { cameraKey, serverUrl, streamKey } from "./protocol";
import { Request, Session } from "./session";

const settings = definePluginSettings({
    url: { type: OptionType.STRING, description: "Servidor FockyTV", default: "https://tv.huestavo.com", isValid: value => { try { if (typeof value !== "string") return false; serverUrl(value); return true; } catch { return false; } } },
    nick: { type: OptionType.STRING, description: "Nick (vazio = username do Discord)", default: "", isValid: value => { try { if (typeof value !== "string") return false; if (value.trim()) streamKey(value); return true; } catch { return false; } } },
    fps: { type: OptionType.SELECT, description: "Quadros por segundo", options: [15, 30, 60].map(value => ({ label: `${value} fps`, value, default: value === 60 })) },
    height: { type: OptionType.SELECT, description: "Resolução máxima", options: [{ label: "Original", value: 0, default: true }, { label: "1080p", value: 1080 }, { label: "720p", value: 720 }] }
});
const Native = VencordNative.pluginHelpers.FockyTV as PluginNative<typeof import("./native")>;
const request: Request = (url, method, key, body) => Native.request(url, method, key, body);
interface ShareQuality { fps?: number; resolution?: number; soundshareEnabled?: boolean; }
const StreamingSettings = findStoreLazy("ApplicationStreamingSettingsStore") as { getState(): { soundshareEnabled: boolean; }; };
const previewStreamId = "fockytv-preview";
let OriginalVideo: React.ComponentType<VideoProps>;
interface VideoProps { streamId?: string; className?: string; onReady?: (() => void) | null; onResize?: (size: { width: number; height: number; }) => void; paused?: boolean; }
function PreviewVideo(props: VideoProps) {
    const video = useRef<HTMLVideoElement>(null);
    const capture = publishers.get("screen")?.capture;
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
    return <video ref={video} className={props.className} autoPlay muted playsInline onResize={resize} onLoadedData={() => { resize(); props.onReady?.(); }} aria-label="Preview da sua transmissão FockyTV" style={{ width: "100%", height: "100%", objectFit: "contain" }} />;
}
function VideoComponent(props: VideoProps) {
    return props.streamId === previewStreamId ? <PreviewVideo {...props} /> : <OriginalVideo {...props} />;
}
function updatePreview(share: Stream, streamId: string | null) {
    // Só atualiza os stores locais de vídeo; não abre uma sessão Go Live no gateway.
    FluxDispatcher.dispatch({ type: "RTC_CONNECTION_VIDEO", guildId: share.guildId, channelId: share.channelId, userId: share.ownerId, streamId, rtcServerId: null, context: "stream" });
}
const nickname = () => streamKey(settings.store.nick || UserStore.getCurrentUser()?.username || "");
const publishers = new Map<"screen" | "camera", Session>();
const pending = new Set<"screen" | "camera">();
let generation = 0;
let routingEnabled = false;
let discordShare: (Stream & { state: "CONNECTING" | "ACTIVE"; }) | null = null;

function clearDiscordShare() {
    if (!discordShare) return;
    const share = discordShare;
    discordShare = null;
    ApplicationStreamingStore.emitChange();
    setTimeout(() => updatePreview(share, null), 0);
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

async function publish(kind: "screen" | "camera", source?: DiscordSource, quality?: ShareQuality) {
    const existing = publishers.get(kind);
    if (existing) { publishers.delete(kind); if (kind === "screen") clearDiscordShare(); await existing.close(); return; }
    if (pending.has(kind)) return;
    const base = serverUrl(settings.store.url);
    const nick = nickname();
    const version = generation;
    pending.add(kind);
    let capture: MediaStream | undefined;
    let session: Session | undefined;
    let releaseAudio: (() => void) | undefined;
    try {
        const video: MediaTrackConstraints = {
            frameRate: { ideal: kind === "camera" ? 30 : settings.store.fps, max: kind === "camera" ? 30 : settings.store.fps },
            ...(settings.store.height ? { height: { ideal: settings.store.height, max: settings.store.height } } : {})
        };
        capture = source
            ? await navigator.mediaDevices.getUserMedia(captureConstraints(source, quality?.fps ?? settings.store.fps, quality?.resolution ?? settings.store.height) as unknown as MediaStreamConstraints)
            : kind === "camera"
                ? await navigator.mediaDevices.getUserMedia({ video, audio: false })
                : await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
        const withAudio = kind === "screen" && (quality?.soundshareEnabled ?? StreamingSettings.getState().soundshareEnabled);
        if (withAudio) {
            try {
                const sourceId = source ? captureConstraints(source, settings.store.fps, settings.store.height).video.mandatory.chromeMediaSourceId : "screen:-1:0";
                const audio = await captureAudio(Native, sourceId, error => {
                    console.error("FockyTV: áudio", error);
                    void showNotification({ title: "FockyTV: áudio interrompido", body: String(error) });
                });
                releaseAudio = audio.stop;
                capture.addTrack(audio.track);
            } catch (error) {
                console.warn("FockyTV: áudio indisponível", error);
                void showNotification({ title: "FockyTV: transmissão sem áudio", body: String(error) });
            }
        }
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
        capture.getVideoTracks()[0].addEventListener("ended", () => {
            if (publishers.get(kind) === session) {
                publishers.delete(kind);
                if (kind === "screen") clearDiscordShare();
            }
        }, { once: true });
        if (kind === "screen" && discordShare) updatePreview(discordShare, previewStreamId);
        await session.connect(`${base}/api/livekit/whip`);
    } catch (error) {
        if (publishers.get(kind) === session) publishers.delete(kind);
        releaseAudio?.();
        capture?.getTracks().forEach(track => track.stop());
        await session?.close();
        throw error;
    } finally { pending.delete(kind); }
}

interface Live { streamKey: string; engine?: string; }
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
const Icon: IconComponent = ({ width = 24, height = 24 }) => <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="m10 9 5 3-5 3Z" /></svg>;

export default definePlugin({
    name: "FockyTV",
    description: "Compartilhe tela/câmera e assista lives FockyTV via WHIP/WHEP.",
    authors: [{ name: "Focky", id: 0n }],
    settings,
    dependencies: ["ChatInputButtonAPI"],
    settingsAboutComponent: () => <Button onClick={openPanel}>Abrir FockyTV</Button>,
    chatBarButton: { icon: Icon, render: () => <ChatBarButton tooltip="FockyTV" onClick={openPanel}><Icon /></ChatBarButton> },
    flux: {
        VOICE_STATE_UPDATES() {
            const channelId = SelectedChannelStore.getVoiceChannelId();
            if (!channelId || (discordShare && channelId !== discordShare.channelId)) { void stopPublishing(); closePanel?.(); }
        },
        LOGOUT() { void stopPublishing(); closePanel?.(); }
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
    videoComponent(original: React.ComponentType<VideoProps>) { OriginalVideo = original; return VideoComponent; },
    async startDiscordShare(source: DiscordSource, quality?: ShareQuality) {
        const channelId = SelectedChannelStore.getVoiceChannelId();
        const user = UserStore.getCurrentUser();
        if (!channelId || !user) return [false, "no user or channel"];
        if (pending.has("screen") || publishers.has("screen")) return [false, "already sharing"];
        const guildId = ChannelStore.getChannel(channelId)?.guild_id ?? null;
        const share: NonNullable<typeof discordShare> = { channelId, guildId, ownerId: user.id, streamType: guildId ? "guild" : "call", state: "CONNECTING" };
        discordShare = share;
        ApplicationStreamingStore.emitChange();
        try {
            await publish("screen", source, quality);
            if (discordShare !== share || !publishers.has("screen")) return [false, "cancelled"];
            share.state = "ACTIVE";
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
    start() { routingEnabled = true; },
    stop() { routingEnabled = false; closePanel?.(); void stopPublishing(); }
});
