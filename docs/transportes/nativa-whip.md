# Captura nativa com WHIP (padrão no Windows)

Windows Graphics Capture e encoder de hardware no FFmpeg, publicando por WHIP no mesmo
LiveKit do modo WebRTC. Os quadros não passam pelo Chromium (`native-capture.ts:2-3`).
Espectadores não mudam nada: veem uma sala LiveKit comum.

Quando é usado: Windows, `nativeCapture = true` (padrão, `index.tsx:48`), fonte do
seletor do Discord mapeável por `nativeSource` (`discord.ts:345-350`) e UDP experimental
desligado (`index.tsx:1540`). Decisão em `tryNative` (`index.tsx:795-805`).

## Pipeline

```
┌─ Renderer do Discord ──────────────────────────────────────────────────────┐
│ tryNative → publishNative (index.tsx:776) → IPC startNativeShare           │
│ NativeShare (session.ts:215): IPC nativeShareState a cada 2 s              │
│ nativePreview (index.tsx:742): canvas ← IPC nativeShareThumbnail a cada 1 s│
└──────┬ IPC ────────────────────────────────────────────────────────────────┘
       ▼
┌─ Electron main: startCapture (native-capture.ts:213) ──────────────────────┐
│  audio-helper --hwnd N | --mix-except ...  ─ PCM f32 48k/2 ─┐              │
│  audio-helper --watch-window N (fim da janela = fim da live) │              │
│                                                              ▼ pump 10 ms   │
│  [ffmpeg encoder] lavfi gfxcapture (WGC/D3D11) + pipe:0 PCM                │
│      → h264_nvenc|amf|qsv|mf + libopus → MPEG-TS stdout                    │
│  main: forward() → videoFrameMeter (adapt) ─┬→ [ffmpeg muxer] stdin         │
│                                             └→ [ffmpeg stills] stdin        │
│  [ffmpeg stills] -skip_frame nokey → preview.jpg (1 fps, 640 px)            │
│  [ffmpeg muxer] -c copy -f whip http://127.0.0.1:<porta>/whip               │
│  proxy HTTP local (222-245) → request() → HTTPS /api/livekit/whip           │
│      answer reordenada por preferLocalCandidates (68-79)                    │
└──────┬ ICE/DTLS/SRTP UDP do processo ffmpeg muxer ─────────────────────────┘
       ▼
 livekit-ingress (sem transcode) → LiveKit SFU → espectadores (igual a webrtc.md)
```

Quatro processos por live além do main: encoder, muxer, stills e até dois `audio-helper`.
Só o encoder é reiniciado ao trocar fonte/FPS/resolução; o muxer mantém a sessão WebRTC
e o relógio continua por `-output_ts_offset` (`native-capture.ts:187-188,473-491`).

## Componentes e LOC

| Arquivo / trecho | LOC | Papel |
|---|---:|---|
| `native-capture.ts` (total) | 495 | download do FFmpeg, args, encoders, adapt, áudio, proxy WHIP |
| ↳ só WHIP: `66-79`, `201-209`, `216-266`, `447-455` | ~82 | candidatos ICE, muxer, proxy, saída do muxer |
| ↳ motor compartilhado com UDP | ~413 | captura, encoder, fallback, adapt, stills, áudio |
| `native.ts:273-366` | 94 | `startNativeShare`, estado, restart, thumbnail (compartilhado com UDP) |
| `session.ts:206-254` `NativeShare` | 49 | proxy do estado no renderer (compartilhado com UDP) |
| `index.tsx:742-805` | 61 | `nativePreview`, `publishNative`, `tryNative` (compartilhado com UDP) |
| `discord.ts:345-350` `nativeSource` | 6 | id do Discord → `window:`/`hmonitor:`/`monitor:` |
| `native-audio.ts:19-30` `helperPath` | 12 | extrai o `audio-helper.exe` embutido |
| `audio-helper.cpp` | 842 | WASAPI process loopback; também usado pelo modo WebRTC no Windows |
| **Exclusivo do WHIP nativo** | **~82** | o resto é motor comum com o UDP |
| **Motor nativo (WHIP + UDP)** | **~637** | sem contar `audio-helper.cpp` |

Visualização no espectador é a mesma do WebRTC: `viewer.ts` (160), `native-socket.ts` (64),
`livekit-client.umd.js` (vendorizado). Contagem por `wc -l` e intervalo de linhas da função.

## Codec e parâmetros

Defaults: bitrate `nativeBitrate` 4/6/**8**/12 Mbps (`index.tsx:49`), limitado a
`MAX_BITRATE` = 12 (`native.ts:343`). Resolução teto 1080p (`quality.ts:4`), FPS do menu
(1–240, `native.ts:275`). Altura par (`native.ts:277`); fonte maior que a escolha reinicia o
encoder já reduzido na mesma proporção (`native-capture.ts:83-86,336-342`).

Vídeo (`native-capture.ts:144-169`):

- CBR: `-b:v = -maxrate = bitrate`, **VBV `-bufsize 333k`** (≈ 42 ms a 8 Mbps), `-bf 0`.
- **GOP = FPS/2** (`native-capture.ts:184`) e **IDR forçado a cada 0,5 s** (`-force_key_frames ... 0.5` + `forced-idr`). Motivo: o FFmpeg ignora PLI do LiveKit e o AMF/MF ignoram `-g`; sem IDR periódico, quem entra fica carregando (`native-capture.ts:144-147`).
- Perfil Baseline/Constrained Baseline: o WebRTC do Discord não decodifica todo High (`native-capture.ts:149`).
- Sem simulcast (`native-capture.ts:147-148`).
- Encoders em ordem `nvenc → amf → amf-copy → qsv → mf-copy` (`native-capture.ts:138`): NVENC `p4 -tune ull -rc cbr`; AMF `ultralowlatency speed cbr header_spacing=GOP`; `amf-copy`/`mf-copy` fazem `hwdownload` para a CPU; QSV converte para NV12 na GPU (`native-capture.ts:156-167`).
- `-fps_mode passthrough`: WGC só entrega quadro quando a imagem muda (`native-capture.ts:185,277-279`).

Áudio: sempre há faixa (silêncio `anullsrc` se desligado), porque o muxer não aceita mudar
as faixas no meio da live (`native-capture.ts:179-180`). `libopus -application lowdelay 128k`,
`aresample=async=1` (`native-capture.ts:186`). PCM e vídeo com relógio de parede comum
(`-use_wallclock_as_timestamps`, `-copyts`, `native-capture.ts:173-181`). Captura por janela
(`--hwnd`) ou mix de todos os apps exceto Discord/Vesktop/FockyTV (`--mix-except`,
`native-capture.ts:364-366`).

Adaptação (`adapt()`, `native-capture.ts:267-305`): não adapta bitrate. A cada 5 s, se os
quadros não-keyframe são grandes (mediana ≥ metade da fatia do bitrate) e chegam abaixo de
1/3 do FPS pedido, duas verificações seguidas descem um degrau: FPS pedido → 30 FPS → 720p
(`qualitySteps`, `native-capture.ts:89-93`). Volta após 40 s; queda logo após voltar dobra a
espera até 4 min. Cada degrau reinicia o encoder.

## Plataformas

- Publicar: só Windows (`native.ts:337`). Áudio exige Windows 10 build 20348+ (process loopback).
- Linux, Vesktop e web: nunca usam este caminho (sem fonte do seletor ou não-Windows) e vão para WebRTC.
- Assistir: igual ao WebRTC (plugin em qualquer plataforma e site FockyTV).
- Primeira live baixa o FFmpeg 9.0.2 essentials (~110 MB, gyan.dev) verificado por SHA-256 (`native-capture.ts:14-56`).

## Dependências de servidor e portas

As mesmas do WebRTC (`webrtc.md`): HTTPS para `live-api`, UDP do ingress (main 7885,
insider 7995) e do SFU para espectadores. Particularidade: o muxer WHIP do FFmpeg usa só o
**primeiro** candidato ICE da answer. Na LAN do servidor o IP público falha (sem hairpin
NAT), então `preferLocalCandidates` põe candidatos da sub-rede local na frente
(`native-capture.ts:66-79`); o backend acrescenta o candidato LAN (`withWHIPLANAddress` em
`live-api/livekit_whip.go`). IP público desatualizado no `node_ip` aparece como FFmpeg WHIP
"Error number -138" (timeout) para publicadores fora da LAN.

## Falhas e fallbacks

Falha **ao iniciar** → notificação "FockyTV: usando a captura do Discord" e publica pelo
WebRTC (`index.tsx:799-803`). Casos:

- Download do FFmpeg falhou ou hash inválido (`native-capture.ts:41-43`).
- Encoder não abre, morre sem quadros, ou trava 8 s sem quadro → próximo da lista (`native-capture.ts:360-363,415-425`). Todos falharam: "Nenhum encoder de vídeo funcionou (...)" (`native-capture.ts:430`). O que funcionou fica preferido até fechar o cliente; `FOCKYTV_CODEC` força o primeiro (`native-capture.ts:140-142`).
- Janela minimizada no início: "A janela está minimizada; abra-a antes de transmitir." (`native-capture.ts:427`).
- WHIP ≠ 201: `FockyTV (<status>)` (`native-capture.ts:235`).
- Não fica `live` (log `SRTP setup done`, `native-capture.ts:262`) em 30 s: "Tempo esgotado ao conectar a captura nativa..." com detalhe dos encoders (`native.ts:358-364`).

Falha **durante** a live → encerra, sem fallback: "A captura nativa parou: <erro>"
(`index.tsx:783-788`). Casos: saída do muxer ou encoder, `audio-helper` encerrou
(`native-capture.ts:396`), janela fechada (`--watch-window`, `native-capture.ts:368-376`),
formato PCM incompatível (`native-capture.ts:389-390`).

Outros: trocar para fonte não mapeável → "Fonte incompatível com a captura nativa."
(`index.tsx:1757`); troca de qualidade/fonte congela ~1 s (reinício do encoder);
sobrecarga gera aviso uma vez por texto (`session.ts:225`). Logs em
`%APPDATA%\discord\FockyTV\ffmpeg.log` e `ffmpeg-encoder.log` (`native-capture.ts:211,249-250,327`).
Diagnóstico WebRTC do painel não vê o envio nativo.

## Latência teórica

| Etapa | Onde | Buffer |
|---|---|---|
| WGC → encoder | processo encoder (GPU) | ≤ 1 quadro; `amf-copy`/`mf-copy` somam cópia GPU→CPU |
| VBV do encoder | `native-capture.ts:153` | 333 kbit: 28 ms a 12 Mbps, 42 ms a 8, 83 ms a 4 |
| Encoder → muxer | pipe MPEG-TS, `-muxdelay 0 -flush_packets 1` (`native-capture.ts:188`) | ~0; contrapressão pausa o encoder (`native-capture.ts:350`) |
| Muxer: probe inicial | `-probesize 200000 -analyzeduration 500000` (`native-capture.ts:205`) | só no início (≤ 0,5 s) |
| Muxer WHIP → ingress | FFmpeg, sem pacer; `-ts_buffer_size 8 MB` é o buffer do socket (`native-capture.ts:206-207`) | keyframe sai em rajada |
| ingress → SFU → espectador | servidor + jitter buffer WebRTC | igual a `webrtc.md` |
| Áudio | helper: fila ≤ 200 ms, começa com 40 ms (`audio-helper.cpp:582,595`); main: fila ≤ 200 ms, pump 10 ms (`native-capture.ts:394,397-407`) | 40–200 ms, mesmo relógio do vídeo |
| Entrada de espectador novo | IDR a cada 0,5 s | ≤ 0,5 s até a primeira imagem |

## Testes

- `native-capture.test.mjs`: medidor de quadros (28), degraus (38), relógio comum PCM/vídeo (44), troca de janela e watcher (151-197), sobrecarga, rampa e conteúdo lento (199-275).
- `self-check.ts:83-118`: ordem dos candidatos ICE, `nativeSource`, args do encoder, `outputSize`, CBR/sem B-frames/IDR 0,5 s/Baseline para todos os `CODECS`.
- `quality.test.ts:141,198`: menu nativo só confirma após sucesso; callback de qualidade sem fonte RTC.
- `settings-ui.test.ts:15-23`: `nativeCapture` padrão `true`, `nativeBitrate` padrão 8.
- `player-updates.test.ts:82`: toggle "Modo simples" pula a captura nativa na próxima live.

## Benchmark

Mediana de 3 rodadas, 1080p30 8 Mbps, libx264, LAN Wi‑Fi. Método e limites em [benchmark.md](benchmark.md); comparação em [comparacao.md](comparacao.md).

| Cenário | 1º quadro | glass-to-glass | FPS | travadas >100 / >500 ms |
|---|---|---|---|---|
| limpo | 2,2 s | 125 ms | 29,4 | 0 / 0 |
| 1% de perda | 2,3 s | 113 ms | 19,0 | 61 / 0 |
| perda em rajada | 2,3 s | 115 ms | 27,1 | 7 / 0 |
| jitter 40±20 ms | 5,1 s | 165 ms | 0,8 (travou em 4 de 6) | 5 / 5 |

Com jitter o muxer WHIP para de ler a entrada e o `adapt()` culpa a GPU. Bitrate real ~5,6 de 8 Mbps com `bufsize 333k` (libx264).
