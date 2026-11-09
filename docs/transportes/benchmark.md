# Benchmark dos transportes de tela

Comparação dos 3 transportes do plugin no backend Insider, medida de ponta a ponta (publicador → servidor → espectador) com o código real do plugin. Dados brutos: [`benchmark-results.json`](benchmark-results.json).

```sh
# matriz completa (4 cenários × 3 transportes × 3 rodadas, ~25 min)
/home/focky/Vencord/node_modules/.bin/tsx scripts/bench/transport-bench.ts
# WebRTC em regime (depois da rampa de banda), somado ao mesmo JSON
/home/focky/Vencord/node_modules/.bin/tsx scripts/bench/transport-bench.ts --append --transports webrtc-steady --scenarios clean --runs 3 --steady-warmup 60
```

Precisa de `ssh servidor` com `sudo -n tc`, FFmpeg com muxer WHIP, `/usr/bin/chromium` e esbuild/puppeteer-core em `/home/focky/Vencord`.

## Método

| | WebRTC "modo simples" | Captura nativa (padrão) | UDP experimental |
|---|---|---|---|
| Fonte | canvas 1080p30 → `captureStream()` | quadros crus do Node → FIFO | idem nativa |
| Encoder | encoder WebRTC do Chromium (H.264, via `Session`, `session.ts`) | libx264 com as flags de `videoCodec()` (CBR, baseline, sem B-frames, IDR a cada 0,5 s, `bufsize 333k`) | libx264, `videoCodec(..., udp=true)` (IDR a cada 1 s, `bufsize 1000k`) |
| Transporte | WHIP → LiveKit | `startCapture()` real: muxer WHIP do FFmpeg + proxy local com `preferLocalCandidates` → LiveKit | `startCapture()` + `udpSink` real (AES-GCM, FEC XOR 8+1, entrelaçamento, pacing) → relay :7996 |
| Espectador | `watchLive()` + `livekit-client.umd.js` | idem | `udpReceiver` (remux FFmpeg → fMP4) + `watchUdp()` (MSE → `captureStream()`) |

- **Código real**: `session.ts`, `viewer.ts`, `udp-viewer.ts`, `native-capture.ts` (`startCapture`) e `native-udp.ts` são usados sem cópia (o código de navegador é empacotado com esbuild). A única troca é o `ffmpeg.exe`: `scripts/bench/ffmpeg-libx264.sh` substitui `gfxcapture` pelo FIFO e `h264_nvenc`/`p4`/`ull` por `libx264`/`ultrafast`/`zerolatency`, mantendo as flags de taxa/GOP/IDR.
- **Fonte**: testsrc2 1920×1080 rolando 16 px por quadro + uma caixa de ruído 640×360 nova a cada quadro (força o encoder a gastar bitrate), 30 FPS, 8 Mbps em todos. No WebRTC o teto foi baixado de 12 (`MAX_BITRATE`) para 8 Mbps.
- **Glass-to-glass**: cada quadro leva os 32 bits baixos do `Date.now()` + 16 bits de verificação num código de barras de blocos 32×32 no topo. O espectador lê o código em todo quadro apresentado (`requestVideoFrameCallback` + `getImageData`) e subtrai do relógio na hora da apresentação. Fonte e espectador estão no mesmo PC, mesmo relógio.
- **Rodada**: publica, o espectador entra assim que a live está no ar, 6 s de aquecimento, 20 s de medição. 3 rodadas por cenário, transportes intercalados em cada rodada (a variação do Wi-Fi atinge todos por igual). Mediana e p95 entre rodadas (com 3 rodadas, p95 = pior rodada); glass-to-glass usa todos os quadros das 3 rodadas juntos.
- **Métricas**: 1º quadro desde o início da publicação e desde a entrada do espectador; FPS entregue = quadros distintos apresentados/s; travadas = intervalos entre quadros apresentados > 100 ms e > 500 ms; quadros perdidos = quadros da fonte que nunca apareceram (inclui FPS reduzido pelo próprio encoder); congelados = mesmo quadro apresentado de novo; fio = bytes de mídia recebidos no espectador (par ICE escolhido no WebRTC; pacotes UDP aceitos × 1172 B no UDP; sem cabeçalhos IP/UDP; vídeo + áudio + RTX/FEC); saída do encoder = bytes que o encoder escreveu (`/proc/<pid>/io`, MPEG-TS) ou `bytesSent+headerBytesSent` no WebRTC; CPU = `/proc` (100% = 1 núcleo).
- **`udp-mse`**: as mesmas rodadas UDP lidas no `<video>` MSE interno do `watchUdp`, antes do `captureStream()`. Separa o transporte do problema de captura descrito abaixo.

## Ambiente

- PC: Intel Core Ultra 5 235U (14 threads, sem GPU usada), Linux, Wi-Fi, 192.168.1.6. Chromium 155 headless (SwiftShader), FFmpeg 9.0.2.
- Servidor: Insider em casa (192.168.1.129, cabo), LiveKit em host network anunciando o IP da LAN. Sinalização HTTP/WebSocket pelo túnel Cloudflare; mídia direta pela LAN (par ICE `192.168.1.6 ← 192.168.1.129:7992/udp` em todas as rodadas).
- Rede ruim: `netem` no servidor (`enp0s31f6`, `prio` + filtro `u32 dst 192.168.1.6`), só no sentido **servidor → este PC**. Como publicador e espectador são o mesmo PC, a mídia do publicador → servidor fica limpa, mas o retorno servidor → publicador (RTCP/STUN do WebRTC, ACKs do UDP) também sofre o netem. O qdisc foi restaurado (`pfifo_fast`) ao fim de cada cenário, com dead-man no servidor caso o script morresse.
- Cenários: `clean`; `loss1` = `loss random 1%`; `burst` = `loss gemodel 0.1% 20%` (≈0,5% de perda em rajadas de ~5 pacotes); `jitter` = `delay 40ms 20ms` (uniforme; o netem reordena pacotes com jitter).

## Resultados

Mediana / p95. "OK" = rodadas que chegaram ao fim da medição sem erro do script.

### clean

| Transporte | OK | 1º quadro desde publicar (ms) | Entrada→1º quadro (ms) | Glass-to-glass (ms) | FPS entregue | Travadas >100 ms | Travadas >500 ms | Quadros perdidos (%) |
|---|---|---|---|---|---|---|---|---|
| webrtc | 3/3 | 2628 / 2789 | 1986 / 1996 | 37 / 55 | 14.9 / 15.0 | 7 / 10 | 0 / 0 | 50.1 / 50.3 |
| native | 3/3 | 2219 / 2273 | 1163 / 1181 | 125 / 142 | 29.4 / 30.0 | 0 / 4 | 0 / 0 | 2.2 / 2.2 |
| udp | 3/3 | 2143 / 2191 | 1339 / 1391 | 473 / 856 | 3.4 / 3.4 | 67 / 67 | 0 / 0 | 88.8 / 89.0 |
| udp-mse | 3/3 | 1804 / 1860 | 1000 / 1060 | 456 / 844 | 29.9 / 30.2 | 0 / 0 | 0 / 0 | 3.2 / 4.4 |

| Transporte | Fio (Mbps) | Encoder (Mbps) | Overhead (%) | CPU pub / esp (%) | Perda RTP (%) | NACKs | FEC recuperados | Grupos perdidos | Reinícios do remux |
|---|---|---|---|---|---|---|---|---|---|
| webrtc | 0.94 / 0.94 | 0.92 / 0.92 | 1.7 / 2.1 | 48 / 19 | 0.00 | 25 / 32 | — | — | — |
| native | 5.57 / 5.57 | 5.64 / 5.65 | -1.4 / -1.2 | 92 / 98 | 0.00 | 128 / 141 | — | — | — |
| udp | 8.52 / 8.54 | 7.93 / 7.94 | 7.4 / 7.5 | 91 / 114 | — | — | 0 / 0 | 0 / 0 | 0 / 0 |

### loss1 (`netem loss random 1%`)

| Transporte | OK | 1º quadro desde publicar (ms) | Entrada→1º quadro (ms) | Glass-to-glass (ms) | FPS entregue | Travadas >100 ms | Travadas >500 ms | Quadros perdidos (%) |
|---|---|---|---|---|---|---|---|---|
| webrtc | 3/3 | 2764 / 2817 | 2124 / 2128 | 48 / 73 | 14.1 / 14.2 | 16 / 27 | 0 / 0 | 52.8 / 53.2 |
| native | 3/3 | 2316 / 2332 | 1299 / 1321 | 113 / 212 | 19.0 / 19.2 | 61 / 65 | 0 / 0 | 36.5 / 37.4 |
| udp | 3/3 | 2193 / 2251 | 1353 / 1386 | 1120 / 1771 | 2.6 / 3.4 | 74 / 74 | 0 / 0 | 91.2 / 91.5 |
| udp-mse | 3/3 | 1893 / 1940 | 1042 / 1086 | 1127 / 1748 | 18.7 / 26.0 | 5 / 10 | 2 / 6 | 32.8 / 37.3 |

| Transporte | Fio (Mbps) | Encoder (Mbps) | Overhead (%) | CPU pub / esp (%) | Perda RTP (%) | NACKs | FEC recuperados | Grupos perdidos | Reinícios do remux |
|---|---|---|---|---|---|---|---|---|---|
| webrtc | 0.90 / 0.95 | 0.88 / 0.93 | 1.6 / 1.7 | 52 / 20 | 0.91 / 1.00 | 62 / 65 | — | — | — |
| native | 5.56 / 5.58 | 5.64 / 5.66 | -1.4 / -1.4 | 91 / 75 | 0.95 / 1.03 | 365 / 369 | — | — | — |
| udp | 8.48 / 8.54 | 7.96 / 7.96 | 7.2 / 7.3 | 91 / 92 | — | — | 160 / 161 | 5 / 14 | 5 / 8 |

### burst (`netem loss gemodel 0.1% 20%`)

| Transporte | OK | 1º quadro desde publicar (ms) | Entrada→1º quadro (ms) | Glass-to-glass (ms) | FPS entregue | Travadas >100 ms | Travadas >500 ms | Quadros perdidos (%) |
|---|---|---|---|---|---|---|---|---|
| webrtc | 3/3 | 2633 / 2743 | 1969 / 2092 | 42 / 74 | 14.8 / 14.9 | 7 / 13 | 0 / 0 | 50.6 / 50.9 |
| native | 3/3 | 2260 / 2266 | 1190 / 1219 | 115 / 136 | 27.1 / 28.0 | 7 / 9 | 0 / 0 | 9.7 / 19.7 |
| udp | 3/3 | 2164 / 2217 | 1368 / 1384 | 1219 / 1760 | 1.8 / 2.8 | 52 / 74 | 0 / 0 | 90.6 / 91.1 |
| udp-mse | 3/3 | 1849 / 1902 | 1053 / 1069 | 1206 / 1756 | 12.9 / 19.8 | 7 / 9 | 5 / 7 | 34.1 / 37.5 |

| Transporte | Fio (Mbps) | Encoder (Mbps) | Overhead (%) | CPU pub / esp (%) | Perda RTP (%) | NACKs | FEC recuperados | Grupos perdidos | Reinícios do remux |
|---|---|---|---|---|---|---|---|---|---|
| webrtc | 0.91 / 0.93 | 0.90 / 0.92 | 1.7 / 1.7 | 54 / 20 | 0.25 / 0.82 | 26 / 26 | — | — | — |
| native | 5.56 / 5.64 | 5.64 / 5.73 | -1.4 / -1.3 | 93 / 96 | 0.41 / 0.59 | 147 / 159 | — | — | — |
| udp | 6.80 / 8.50 | 7.95 / 7.95 | -14.4 / 7.2 | 95 / 69 | — | — | 42 / 45 | 27 / 34 | 10 / 11 |

No UDP com rajadas o espectador desistiu em 2 de 3 rodadas (aos 8 s e aos 24 s): o `udpReceiver` encerra com "Perda UDP persistente" depois de mais de 5 reinícios do remux em 5 s. Os números dessas rodadas cobrem só o trecho em que ainda havia vídeo (daí o fio mediano de 6,8 Mbps).

### jitter (`netem delay 40ms 20ms`)

| Transporte | OK | 1º quadro desde publicar (ms) | Entrada→1º quadro (ms) | Glass-to-glass (ms) | FPS entregue | Travadas >100 ms | Travadas >500 ms | Quadros perdidos (%) |
|---|---|---|---|---|---|---|---|---|
| webrtc | 3/3 | 3459 / 4003 | 2686 / 3150 | 98 / 124 | 9.9 / 14.9 | 80 / 86 | 0 / 0 | 66.7 / 68.8 |
| native | 3/3 | 5069 / 7186 | 3838 / 5998 | 165 / 183 | 0.8 / 27.4 | 5 / 14 | 5 / 14 | 10.5 / 33.3 |
| udp | 3/3 | 2271 / 2376 | 1391 / 1516 | 538 / 872 | 3.3 / 3.7 | 65 / 74 | 0 / 0 | 89.0 / 92.2 |
| udp-mse | 3/3 | 1928 / 1972 | 1068 / 1092 | 519 / 877 | 30.0 / 30.1 | 0 / 0 | 0 / 0 | 2.3 / 2.4 |

| Transporte | Fio (Mbps) | Encoder (Mbps) | Overhead (%) | CPU pub / esp (%) | Perda RTP (%) | NACKs | FEC recuperados | Grupos perdidos | Reinícios do remux |
|---|---|---|---|---|---|---|---|---|---|
| webrtc | 0.94 / 0.98 | 0.92 / 0.96 | 1.6 / 1.7 | 49 / 21 | 0.10 / 0.42 | 407 / 436 | — | — | — |
| native | 0.17 / 5.60 | 0.04 / 5.68 | -1.4 / 87.5 | 1 / 13 | 0.00 | 43 / 1694 | — | — | — |
| udp | 8.73 / 8.74 | 7.94 / 7.96 | 10.0 / 10.0 | 92 / 114 | — | — | 897 / 948 | 0 / 0 | 0 / 0 |

A captura nativa travou em 2 de 3 rodadas (glass-to-glass só da rodada boa). Uma reexecução só desse caso (3 rodadas, fora do JSON) repetiu o padrão: 2 de 3 travadas. Ver "Achados".

### WebRTC em regime (`webrtc-steady`, clean, 60 s de aquecimento)

| Transporte | OK | 1º quadro desde publicar (ms) | Entrada→1º quadro (ms) | Glass-to-glass (ms) | FPS entregue | Travadas >100 ms | Travadas >500 ms | Quadros perdidos (%) |
|---|---|---|---|---|---|---|---|---|
| webrtc-steady | 3/3 | 2622 / 2810 | 1989 / 1999 | 67 / 86 | 27.6 / 29.3 | 0 / 0 | 0 / 0 | 8.0 / 14.1 |

| Transporte | Fio (Mbps) | Encoder (Mbps) | Overhead (%) | CPU pub / esp (%) | Perda RTP (%) | NACKs |
|---|---|---|---|---|---|---|
| webrtc-steady | 7.97 / 8.02 | 7.84 / 7.90 | 1.5 / 1.7 | 88 / 64 | 0.00 | 161 / 189 |

Rampa típica (rodada 2, `[s desde publicar, Mbps enviados, largura, FPS]`): 7 s → 0,23 Mbps, 640 px, 3 FPS · 19 s → 0,8 Mbps, 480 px, 15 FPS · 31 s → 1,8 Mbps, 640 px · 43 s → 5,2 Mbps · 55 s → 7,2 Mbps, 1280 px, 30 FPS (alvo 8 Mbps atingido). Mesmo em regime o encoder ficou em 960–1280 px de largura, não 1920.

## Achados

1. **UDP: o `captureStream()` do espectador entrega ~3,5 FPS.** O transporte UDP entrega ~30 FPS no `<video>` MSE (`udp-mse`), mas o `MediaStream` que o plugin tira dele com `captureStream()` sai a ~3,5 FPS em todas as rodadas (`getSettings().frameRate` ≈ 3,6). Reproduzido fora do benchmark com um arquivo fMP4 sintético no MSE: basta um **buraco de timestamp logo depois do 1º quadro** (0 → 0,67 s) para o `captureStream()` cair para ~4 FPS. O mesmo buraco no meio do arquivo, ou o arquivo sem buraco, dá 30 FPS. O remux do `udpReceiver` gera esse buraco quando o espectador entra com a live em andamento, que é o caso normal. O `scripts/udp-smoke.ts` não pega isso porque liga o receptor antes do publicador. Ainda não foi confirmado no Discord/Electron com GPU, só no Chromium 155 headless.
2. **UDP: latência alta por desenho.** Glass-to-glass de ~0,45–0,5 s com rede limpa e ~1,1–1,2 s com perda, contra 0,04–0,17 s nos transportes WebRTC. A maior parte é o buffer do MSE (o controle do `watchUdp` só volta para velocidade 1× com menos de 0,3 s de folga e começa com o buraco inicial de ~0,7 s), somada ao remux em fragmentos de 50 ms.
3. **UDP: cada grupo FEC perdido reinicia o remux, e isso trava a imagem.** Com 1% de perda aleatória o FEC recuperou ~160 pacotes por rodada, mas os grupos perdidos (5 de mediana) viraram reinícios do remux e travadas > 500 ms. Com rajadas, o entrelaçamento não espalhou o suficiente: com 8 Mbps só cabem ~4 grupos nos 40 ms de espera, e o espectador desistiu em 2 de 3 rodadas.
4. **Captura nativa sem retransmissão útil com perda.** Com 1% de perda o espectador manda ~365 NACKs por rodada, mas fica em ~19 FPS distintos com 60 travadas > 100 ms (36% dos quadros da fonte nunca aparecem). O Chromium decodificou ~570 quadros por rodada, mas só ~380 foram apresentados: os quadros chegam em rajadas depois da recuperação. Com rajadas (`burst`) o efeito é bem menor (27 FPS).
5. **Captura nativa trava com jitter.** Em 4 de 6 rodadas com `delay 40ms 20ms` o muxer WHIP do FFmpeg parou de consumir a entrada: o encoder ficou travado por contrapressão (o gerador descartou até 598 de 600 quadros) e o `startCapture` reportou ~2 FPS. O detector de sobrecarga do plugin reagiu com "a live caiu para 720p 30 FPS", um falso positivo de GPU/encoder. Lembrar que o netem também atrasa e reordena o RTCP/STUN do servidor para o publicador. A causa no muxer não foi isolada. Os avisos `MaxListenersExceededWarning: 11 drain listeners` também mostram contrapressão do muxer em rodadas limpas.
6. **WebRTC "modo simples": a banda sobe devagar.** A resposta WHIP do servidor só negocia `goog-remb`, sem `transport-cc`. O Chromium começa em ~300 kbps e, sob `degradationPreference: "balanced"`, transmite em 640×360 a ~15 FPS. Ao fim dos 30 s de rodada estava em ~1,5–1,6 Mbps de alvo (`qualityLimitationReason: bandwidth` 100% do tempo), longe dos 8 Mbps. O alvo de 8 Mbps só chega por volta de 50–55 s de live. Em regime (`webrtc-steady`) fica em ~28 FPS, 960–1280 px de largura, com glass-to-glass de 67 ms: ainda o menor dos três, mas 1080p cheio não apareceu. Nas rodadas de 30 s a latência baixa vem dos quadros pequenos, e os "quadros perdidos" perto de 50% são a metade do FPS da fonte. A série completa está em `runs[].ramp` (`[s, Mbps, largura, FPS, alvo kbps]`).
7. **Bitrate efetivo da captura nativa abaixo do pedido.** Com `bufsize 333k` o libx264 entregou ~5,6 Mbps dos 8 pedidos. O UDP (`bufsize 1000k`, mesmo encoder e conteúdo) entregou 7,9. Com NVENC isso pode ser diferente.
8. **Overhead.** WebRTC/WHIP: ~+2% sobre o RTP enviado. Nativo: −1,4% (o lado do encoder conta MPEG-TS, mais gordo que RTP). UDP: +7% no limpo (FEC 1/8 + cabeçalho/tag GCM, menos o MPEG-TS) e +10% com jitter (pacotes atrasados chegam e são contados de novo).

## Limitações

- **Sem GPU/WGC**: libx264 `ultrafast`/`zerolatency` no lugar de NVENC/AMF/QSV e uma fonte sintética no lugar do `gfxcapture`. Latência, bitrate efetivo e CPU do encoder não representam o Windows. Depois de um reinício do encoder (detector de sobrecarga), o FIFO do benchmark não volta a alimentar o encoder novo.
- **WebRTC com canvas**, não `getDisplayMedia`. Codec H.264 do Chromium Linux; `encoderImplementation` não é exposto. Teto de 8 Mbps em vez dos 12 do plugin. Flag `WebRtcHideLocalIpsWithMdns` desligada, para expor o IP da LAN como numa captura com permissão.
- **Chromium headless sem GPU** (SwiftShader) nos dois lados. Os números de CPU incluem a leitura do código de barras e, no UDP, dois `<video>`. O receptor UDP roda no mesmo processo Node do gerador e do `udpSink`. A ponte `readUdpWatch` usa base64 via CDP, não o IPC do Electron.
- **Só o sentido servidor → PC é degradado**, e isso inclui o retorno ao publicador (ver Ambiente). O publicador → servidor é LAN limpa. Não há perda na internet real, nem Cloudflare no caminho da mídia.
- **Wi-Fi ruidoso**: houve grupos perdidos e NACKs mesmo no `clean`. 3 rodadas por caso é pouco; o p95 é a pior rodada.
- **"Quadros perdidos"** mistura perda de rede, FPS reduzido pelo encoder WebRTC e quadros decodificados mas não apresentados (dois quadros no mesmo vsync).
- Não medido: 60 FPS, múltiplos espectadores, publicador e espectador em máquinas diferentes, CPU do lado do servidor.

## Windows + RTX 3060 Ti (captura e encoder reais)

O mesmo script, rodando no PC Windows do usuário (Ryzen 9 3900X, RTX 3060 Ti, monitor 2560×1080, 192.168.1.21) com o FFmpeg do plugin (`gfxcapture` + `h264_nvenc`) chamado pelo `startCapture` real, **sem** wrapper. Dados em `benchmark-results.json` → `windows`.

```bat
:: numa tarefa agendada interativa do usuário (a captura WGC não funciona pela sessão SSH)
set VENCORD=C:\Users\Focky\fockytv-bench
set CHROMIUM_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
set BENCH_FFMPEG=%APPDATA%\discord\FockyTV\ffmpeg-60f467265b1e3123.exe
set BENCH_LOGS=C:\Users\Focky\fockytv-bench\logs
node_modules\.bin\tsx.cmd scripts\bench\transport-bench.ts --scenarios clean --runs 3 --transports native,udp,webrtc --append --out win-results.json
:: 60 FPS nos padrões do plugin: --fps 60 --bitrate 12 (nativa) / --fps 60 --bitrate 20 (UDP)
```

No Windows o script não mexe no `tc`: o netem (`dst 192.168.1.21`) foi aplicado e retirado a partir do Linux em volta de cada cenário, com o mesmo dead-man.

**Como foi medido**

- **Fonte**: a página-relógio (mesmo padrão + código de barras) numa janela do Edge em tela cheia, 2560×1080. A sessão do console estava **bloqueada**: o monitor mostrava a tela de bloqueio e a captura de monitor só via essa imagem parada. Por isso a captura é por janela (`window:<hwnd>`, o mesmo caminho do plugin para janelas, com o `audio-helper --watch-window`). Saída 2560×1080: 1080 de altura, ~33% mais pixels que 1920×1080.
- **Glass-to-glass** aqui inclui render do Edge → composição do DWM → WGC → NVENC → rede → Edge headless (espectador na mesma máquina, mesmo relógio). Não inclui o scan-out do monitor.
- **WebRTC**: o `getDisplayMedia` da aba (`--auto-accept-this-tab-capture`) saiu a ~1 FPS com a sessão bloqueada. O WebRTC publicou então o `captureStream()` do mesmo canvas, pela `Session` real, com o encoder H.264 do Edge (`MediaFoundationVideoEncodeAccelerator`, NVIDIA).
- **Sem CPU** (não há `/proc`). Bitrate do encoder: só no UDP (bytes entregues ao `udpSink`). Na nativa vale o fio do espectador (≈ RTP enviado).
- O espectador (Edge headless, decodificação na mesma GPU) disputa GPU/CPU com o encoder e com a janela da fonte.
- 3 rodadas no `clean`, 2 nos demais; `loss1` não foi rodado no Windows (fora do tempo).

### clean

| Transporte | OK | 1º quadro desde publicar (ms) | Entrada→1º quadro (ms) | Glass-to-glass (ms) | FPS entregue | Travadas >100 / >500 ms | Quadros perdidos (%) | Fio (Mbps) | Encoder (Mbps) |
|---|---|---|---|---|---|---|---|---|---|
| native (8 Mbps) | 3/3 | 2535 / 2537 | 1412 / 1417 | 194 / 218 | 26.8 / 27.2 | 0 / 0 | 10.5 / 13.6 | 7.39 / 7.48 | — |
| udp (8 Mbps) | 3/3 | 2901 / 2941 | 2014 / 2024 | 605 / 680 | **1.0** / 1.0 | 19 / 19 | 96.5 | 7.78 / 7.81 | 7.24 / 7.28 |
| udp-mse | 3/3 | 1875 / 1915 | 988 / 998 | 579 / 657 | 25.7 / 26.4 | 1 / 1 | 15.2 / 18.4 | | |
| webrtc (8 Mbps, canvas) | 3/3 | 2494 / 2761 | 2100 / 2122 | 65 / 84 | 29.7 / 29.7 | 0 / 0 | 1.2 / 1.3 | 1.18 / 1.19 | 1.16 / 1.17 |
| native 60 FPS 12 Mbps (padrão) | 2/2 | 2442 / 2481 | 1294 / 1338 | 127 / 138 | 45.4 / 46.6 | 0 / 0 | 22.3 / 24.4 | 10.06 / 10.07 | — |
| udp 60 FPS 20 Mbps (padrão) | 0/2 útil | 3204 / 3234 | 2235 / 2256 | — | 0.0 | 5 / 5 | — | 0 | 0 |

### jitter (`netem delay 40ms 20ms`)

| Transporte | Rodadas | Glass-to-glass (ms) | FPS entregue | Travadas >500 ms | Fio (Mbps) | Observação |
|---|---|---|---|---|---|---|
| native | 2 | 242 / 291 | 25.6 e **0.7** | 0 e 12 | 7.04 e **0.23** | rodada 2 travou (ver abaixo) |
| udp | 2 | 621 / 646 | 1.0 (mse 25.4) | 20 | 7.72 | rodada 1: receptor morreu ("non-existing PPS 0") |

### burst (`netem loss gemodel 0.1% 20%`)

| Transporte | Rodadas | Glass-to-glass (ms) | FPS entregue | Travadas >100 / >500 ms | Fio (Mbps) | Observação |
|---|---|---|---|---|---|---|
| native | 2 | 204 / 229 | 23.1 / 24.0 | 10 / 0 | 6.92 / 7.04 | perda RTP 0,7%, ~133 NACKs |
| udp | 2 | 628 / 1386 | 0.3 / 1.0 (mse 6.6 / 17.8) | 8 / 7 | 2.86 / 6.85 | rodada 1: publicador caiu ("A fila UDP atrasou além do limite"); rodada 2: receptor morreu (PPS) |

### O que mudou com GPU real

1. **(c) Bitrate efetivo da nativa com NVENC**: 7,4 de 8 Mbps (~92%) a 30 FPS e 10,1 de 12 Mbps (~84%) a 60 FPS, contra 5,6 de 8 com libx264. O `bufsize 333k` pesa menos no NVENC, mas ainda segura a taxa abaixo do pedido a 60 FPS.
2. **(a) A nativa trava com jitter também com NVENC** (1 de 2 rodadas). O log do muxer WHIP mostra o motivo: o `-progress` do muxer cai de `speed=1x` para 0,06x em ~10 s (`frame=24` em 1 s, depois +1–2 quadros/s). O muxer WHIP do FFmpeg deixa de consumir a entrada, e o encoder fica parado por contrapressão. O `startCapture` vê ~0 FPS e o detector de sobrecarga avisa "a live caiu para 720p 30 FPS", um falso positivo. Isso aconteceu com o netem atrasando e reordenando também o retorno servidor → publicador (RTCP/STUN), com a mídia publicador → servidor limpa.
3. **(b) UDP + `captureStream()`: pior no Edge/Windows**. O `<video>` MSE recebe 25–26 FPS, e o `MediaStream` que o plugin entrega sai a ~1 FPS em todas as rodadas com o espectador entrando depois da live no ar (no Chromium Linux eram ~3,5 FPS). O mesmo defeito, agora num Chromium 157 com GPU.
4. **UDP a 60 FPS / 20 Mbps (padrão do plugin) não funcionou**: nas 2 rodadas o publicador encerrou com "A fila UDP atrasou além do limite. Reduza o bitrate." em segundos. Também aconteceu uma vez a 8 Mbps com `burst`. Hipótese ainda não testada: o pacing do `udpSink` acorda por `setTimeout(…, 1)` e libera no máximo 12 000 B por despertar. Com a granularidade de timer do Windows (ms a 15,6 ms), o teto efetivo fica perto da taxa necessária (20 Mbps × 1,17 ≈ 23 Mbps exigem ≥ 2,9 kB/ms), e qualquer atraso do event loop enche a fila.
5. **UDP: o receptor morre ao entrar no meio da live com NVENC** (2 de 7 rodadas UDP a 30 FPS): `Receptor UDP encerrou: … non-existing PPS 0 referenced`. O remux do `udpReceiver` sai antes de achar SPS/PPS. Não aconteceu com libx264 no Linux.
6. **WebRTC no Windows**: mesma rampa lenta (`goog-remb` só). Em 30 s o Edge transmitia 640×270 a ~1,2 Mbps, mas a 30 FPS e com o menor glass-to-glass (65 ms). Não houve rodada `webrtc-steady` no Windows.
7. **Glass-to-glass da nativa**: 194 ms a 30 FPS e 127 ms a 60 FPS (o intervalo de quadro e o pacing do WGC pesam). Com libx264 no Linux eram 125 ms, mas sem DWM/WGC no caminho.

**Não medido no Windows**: `loss1`; WebRTC por `getDisplayMedia` real (só canvas); `webrtc-steady`; CPU/GPU; captura de monitor (sessão bloqueada); rodadas com Discord fechado (o Discord ficou aberto o tempo todo, sem live). A pasta `C:\Users\Focky\fockytv-bench` (script, `node_modules`, logs do FFmpeg por rodada) ficou no Windows para repetir os testes.

## Windows: estabilidade 30 FPS e alternativas ao WHIP

Objetivo: achar o caminho mais simples que segura **30 FPS estáveis** em 1080p30 a 8 Mbps. Mesmo PC Windows (RTX 3060 Ti, monitor 2560×1080 a 144 Hz), agora **desbloqueado**. Dados em `benchmark-results.json` → `windowsStability`.

**Como foi medido**

- Captura **de monitor** real (`gfxcapture monitor_idx=0` → `h264_nvenc`, `startCapture` do plugin). Página-relógio em tela cheia no Edge girando a **60 FPS**, como um jogo; a live é de 30. Saída 2560×1080.
- Espectador: Edge headless na mesma máquina. Aquecimento de 15 s, 20 s de medição, 2 rodadas por caso.
- netem só no sentido servidor → 192.168.1.21. Não foi degradada a saída do Windows (clumsy não está instalado), então a subida do publicador para o servidor fica limpa. O retorno do servidor (RTCP/NACK/ACK do SRT/STUN) sofre o netem.
- **Estabilidade**: FPS distintos em cada segundo de relógio do espectador. "Seg. < 27" = % de segundos abaixo de 90% do pedido; "desvio" = desvio-padrão do FPS por segundo.

**Candidatos**

| Nome | Caminho |
|---|---|
| native | plugin atual: gfxcapture + NVENC → FFmpeg WHIP → ingress LiveKit (bypass) → SFU |
| native-rtx2048 | idem, com `-rtp_history 2048` no muxer WHIP (injetado no `spawn`, plugin intacto) |
| native-cap60 | idem, com o gfxcapture a `max_framerate=60` e `-vf fps=30` antes do NVENC |
| srt | o mesmo encoder do plugin (MPEG-TS) → `ffmpeg -c copy` → SRT `latency=200 ms` → MediaMTX do Insider → WHEP (`/api/whep` do live-api) no espectador |
| webrtc-screen | `LivePublisher` atual com `getDisplayMedia` real da tela (`--auto-select-desktop-capture-source`), `degradationPreference: "balanced"` |
| webrtc-screen-mf | idem, com `contentHint = "motion"` na faixa e `degradationPreference: "maintain-framerate"` (patch só no benchmark) |

### Resultados (mediana de 2 rodadas)

| Cenário | Candidato | FPS | Desvio | Seg. < 27 | Travadas >100 / >500 ms | Glass-to-glass p50 / p95 (ms) | Resolução recebida | Fio (Mbps) |
|---|---|---|---|---|---|---|---|---|
| clean | native | 28.5 | 0.5 | 0% | 0 / 0 | 179 / 187 | 2560×1080 | 7.8 |
| clean | native-rtx2048 | 28.4 | 0.5 | 0% | 0 / 0 | 180 / 188 | 2560×1080 | 7.8 |
| clean | **native-cap60** | **29.8** | 0.4 | 0% | 0 / 0 | 207 / 212 | 2560×1080 | 8.2 |
| clean | srt | 27.9 | 0.6 | 2.5% | 0 / 0 | 468 / 480 | 2560×1080 | 7.6 |
| clean | webrtc-screen (balanced) | **4.0** | 0.9 | 100% | 79 / 3 | 319 / 455 | 2560×1080 | 5.6 |
| clean | **webrtc-screen-mf** | **29.3** | 0.4 | 0% | 0 / 0 | 103 / 113 | **1280×540** | 8.2 |
| jitter 40±20 ms | native | **0.4** (travou nas 2) | 0.6 | 100% | 6 / 6 | — | 1706 px | 0.1 |
| jitter | srt | 27.1 | 1.3 | 22.5% | 1 / 0 | 503 / 524 | 2560×1080 | 14.1 |
| jitter | webrtc-screen (balanced) | 3.9 | 1.1 | 100% | 75 / 6 | 365 / 536 | 2560×1080 | 5.6 |
| jitter | **webrtc-screen-mf** | **29.3** | 0.5 | 0% | 0 / 0 | 149 / 160 | 1280×540 | 8.2 |
| loss 1% | native | 17.2 | 3.1 | 100% | 71 / 0 | 188 / 272 | 2560×1080 | 7.6 |
| loss 1% | srt | 27.6 | 0.7 | 7.5% | 1 / 0 | 470 / 486 | 2560×1080 | 7.6 |
| loss 1% | webrtc-screen (balanced) | 3.4 | 1.0 | 100% | 66 / 5 | 386 / 520 | 2560×1080 | 5.3 |

Não medidos: `webrtc-screen-mf` com 1% de perda, `native-cap60`/`native-rtx2048` com rede ruim, RTMP → ingress (precisaria recriar o `livekit-ingress`) e qualquer degradação da subida do publicador.

### O que explica cada número

1. **WebRTC "balanced" é o pior caso para tela**: o encoder do Edge na captura de tela é o **OpenH264** (software, não o NVENC via Media Foundation que o canvas usava). Com `balanced`, ele mantém 2560×1080 e derruba o FPS para ~4 quando a banda aperta (a rampa do transport-cc ainda não tinha chegado aos 8 Mbps em 35 s; `qualityLimitationReason: bandwidth`). Com `maintain-framerate` + `contentHint: "motion"`, o mesmo caminho fica em **29,3 FPS sem nenhum segundo abaixo de 27, também com jitter**, e cai a resolução para 1280×540. É a troca que o Haven descreveu, e acontece de forma imediata.
2. **Teto de ~28 FPS na captura nativa vem do `gfxcapture`**: com `max_framerate=30` num monitor de 144 Hz, os quadros chegam em múltiplos de 6,94 ms, e o limitador descarta os que chegam antes de 33,3 ms. O `startCapture` reporta 28–29 FPS saindo do encoder. Capturar a 60 e reduzir com `-vf fps=30` sobe para **29,8 FPS** (`native-cap60`). Com a fonte a exatos 30 FPS o filtro `fps` duplica e pula quadros (22 FPS distintos num teste rápido), então essa saída só serve quando a fonte gira acima de 30.
3. **WHIP do FFmpeg trava com jitter**: 2 de 2 rodadas. É o mesmo travamento do muxer visto antes; agora acontece com captura de monitor real. Com 1% de perda ele cai para 17 FPS: há NACK/RTX (`-rtp_history`), mas não há controle de congestionamento nem recuperação rápida, e o espectador perde quadro até o próximo IDR. `-rtp_history 2048` não muda nada com rede limpa; com perda não foi medido.
4. **SRT → MediaMTX é o mais robusto em resolução cheia**: 27–28 FPS nos três cenários, sem travadas > 500 ms. O custo é latência: ~470–500 ms, dos quais 200 ms vêm do `latency` do SRT. O fio dobrou no jitter (14 Mbps), por retransmissões do lado WebRTC do MediaMTX para o espectador. O SRT também fica preso no teto de ~28 do `gfxcapture` (cap60 resolveria igual).

### Ranking para "30 FPS estáveis"

1. **webrtc-direct com `maintain-framerate` + `contentHint "motion"`**: o único que fica em 30 FPS em clean **e** jitter, com a menor latência (100–150 ms). O preço é a resolução cair para 1280×540 quando o encoder (OpenH264 na captura de tela do Edge) não dá conta. É a menor mudança: em `session.ts` (`LivePublisher.publish` e `setQuality`), trocar `degradationPreference: "balanced"` por `"maintain-framerate"` e fazer `track.contentHint = "motion"` antes de publicar a tela. Backend: nada. Falta medir com 1% de perda e no Chromium do Discord, que pode escolher outro encoder.
2. **SRT → MediaMTX**: estável (27–28 FPS) em resolução cheia sob jitter e perda, com ~0,5 s de latência. Mudanças necessárias:
   - Backend: publicar a porta SRT do MediaMTX (8890/udp), definir autenticação por streamid (hoje é o usuário interno `liveapi`) e anunciar a live no `/api/status`.
   - Plugin: um sink SRT no `startCapture` (o `-c copy` direto no FFmpeg do encoder dispensa o processo extra) e um espectador WHEP.
3. **native-cap60 (WHIP atual + captura a 60 → `fps=30`)**: resolve o teto de ~28 FPS com rede limpa (29,8). Mudança de 1 linha em `videoInput`/`encoderArgs`. Não resolve o travamento do WHIP com jitter nem a queda com perda; serve de complemento a qualquer caminho nativo (também ao SRT).
4. **native (WHIP atual)**: ~28,5 FPS só com rede limpa; trava com jitter e cai a 17 FPS com 1% de perda.
5. **webrtc-direct "balanced" (atual)**: ~4 FPS em todos os cenários na captura de tela real. **É provavelmente o que o usuário está vendo no modo WebRTC.**

**Recomendação**: o caminho mais simples para 30 FPS estáveis é o WebRTC direto (`LivePublisher`) com `maintain-framerate` + `contentHint: "motion"`. É só mudança no plugin, sem servidor. Para quem precisa de resolução cheia, o próximo passo é o SRT → MediaMTX com a captura a 60 → `fps=30`.

**Servidor**: a porta SRT foi publicada só durante o teste (override temporário `docker-compose.bench-srt.yml` no `mediamtx`, com `/api/status` vazio). Depois o `mediamtx` foi recriado com o compose commitado e o override apagado. LiveKit e ingress não foram tocados.
