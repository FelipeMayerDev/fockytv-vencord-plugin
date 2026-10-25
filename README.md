# FockyTV para Vencord

Port do plugin Rust deste projeto para um userplugin TypeScript do Vencord
**desktop** (Discord ou Vesktop com uma build personalizada do Vencord).
Licença GPL-3.0-or-later, conforme LICENSE.

Quando o usuário com username `huestavo` entra na sua chamada, um Jetta turbo
com a imagem personalizada em `jetta.png` atravessa a tela com som de aceleração por 3 segundos. Todos na mesma
chamada com o plugin ativo veem o efeito, inclusive o próprio `huestavo` ao entrar,
com cooldown de 60 segundos por cliente.
O som fica desativado para quem estiver com o microfone ou o áudio mutado no Discord, inclusive na prévia.
Mute, câmera e entrar numa chamada onde ele já estava não disparam a animação.
O som usa o trecho de 0:18 a 0:21 de https://www.youtube.com/watch?v=SXIwKvqBi-8,
embutido em `jetta.mp3`, sem downloads durante a animação; a opção de reduzir movimento do
sistema mantém o carro parado durante os 3 segundos.
Nas configurações do plugin, o botão **braguilha** dispara uma prévia local
imediata, sem aguardar o cooldown. Clicar novamente reinicia o efeito.
Após os 3 segundos, um modal com sacolas 🛍️ dá as boas-vindas ao Braga,
mostra a data e hora da chegada e conta os dias, horas e minutos desde a última
saída observada da call. O histórico inicial parte dos 2 dias de ausência informados
em 22/10/2026 e continua avançando a partir dessa referência fixa. A prévia também
mostra o modal, sem alterar o histórico.
As datas ficam salvas nas configurações locais do plugin e sobrevivem a reinícios;
o plugin precisa estar aberto e na mesma call para observar uma saída. Esse tempo
representa ausência da call, não o status online do Discord, e pode variar entre clientes.

## Instalação automática

**Linux x64:**

```sh
curl -fsSL https://raw.githubusercontent.com/FelipeMayerDev/fockytv-vencord-plugin/main/installer/install.sh | bash
```

**Windows x64 — execute no PowerShell:**

```powershell
irm https://raw.githubusercontent.com/FelipeMayerDev/fockytv-vencord-plugin/main/installer/install.ps1 | iex
```

O instalador identifica Discord (Stable/PTB/Canary) e Vesktop. Se encontrar
mais de um cliente, pergunta em qual instalar. Fecha somente o cliente escolhido,
compila o plugin e ativa **FockyTV** e **FakeNitro** nas configurações. Abra o cliente novamente
quando terminar; entrar em uma chamada ou transmitir não acontece automaticamente.

O servidor padrão é `https://fockytv.felipemayer.com.br`; outro endereço pode ser
definido nas configurações do plugin. Reinstalar atualiza o endereço padrão antigo.

- **Vesktop:** usa o Vencord embutido com uma build personalizada indicada em
  `state.json`; não injeta nem substitui o aplicativo Vesktop.
- **Discord com Vencord a partir do fonte:** encontra o checkout pela injeção e
  recompila nele, preservando os outros userplugins.
- **Discord sem Vencord:** baixa o fonte oficial, compila com FockyTV e usa o
  instalador oficial do Vencord para injetar a build.
- **Vencord binário sem checkout:** procura o fonte nas pastas comuns ou cria
  uma build separada. Configurações e arquivos antigos são preservados, mas
  userplugins sem fonte não podem ser incorporados à nova build.
- **Discord com Equicord:** mesmo fluxo, com o fonte do Equicord, o instalador
  Equilotl e as configurações em `Equicord/settings`. Vesktop não aceita Equicord.

Git é instalado se faltar (winget no Windows; gerenciador de pacotes com sudo
no Linux). Sem winget, ou se ele falhar, o Windows usa MinGit portátil oficial,
verificado por SHA-256 e guardado na pasta do FockyTV, sem exigir administrador.
Node.js 22+ e npm existentes são reutilizados; se não estiverem
presentes, baixa Node.js LTS privado para o instalador e verifica SHA-256.
O pnpm usa a versão declarada no checkout e não precisa de instalação global.
A build desativa o atualizador oficial que poderia substituí-la por Vencord sem o
plugin. O FockyTV verifica atualizações imediatamente ao abrir e recebe avisos
pelo WebSocket do servidor quando há push na `main`, após configurar o webhook
assinado descrito em [notificações de atualização](docs/update-notifications.md).
O cliente confirma a revisão no GitHub antes de avisar e continua verificando a
cada 15 minutos como recuperação de eventos perdidos. O botão **Atualizar agora** do aviso instala direto; clicar no resto do aviso abre o painel. O aviso respeita
o tempo das notificações do Vencord e não bloqueia os próximos alertas.
O botão **Instalar atualização e reiniciar o cliente**, no painel
ou nas configurações do FockyTV, inicia o instalador com o cliente correto, preservando
os outros plugins e os backups. O cliente reabre automaticamente ao terminar. Nada é instalado apenas
por receber o aviso. Também é possível atualizar repetindo o comando acima.

Ao assistir pelo Discord/Vesktop, use o controle de volume e o mute da própria
transmissão. O áudio respeita também o volume geral de saída e o “ensurdecer”,
com amplificação acima de 100%, sem alterar o volume da voz do usuário.

Lives assistidas de tela e webcam têm botão de picture-in-picture ao passar o
mouse sobre o vídeo. Cada dispositivo abre sua própria janela flutuante, sempre
acima das outras. Clicar novamente fecha só aquela janela; encerrar a transmissão
também fecha o PiP correspondente.

Discord e Vesktop Flatpak são detectados pelos locais padrão; o instalador
libera apenas a pasta da build para o sandbox. Snap, outras arquiteturas e
instalações portáteis em caminhos personalizados não estão cobertos pela busca
automática. Instale e abra o cliente uma vez antes de executar. Não rode o
instalador inteiro como root; sudo é usado somente para Git/injeção quando necessário.

Para indicar um checkout existente ou escolher um cliente sem menu:

```sh
curl -fsSL https://raw.githubusercontent.com/FelipeMayerDev/fockytv-vencord-plugin/main/installer/install.sh | bash -s -- --client vesktop --source "$HOME/Vencord"
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/FelipeMayerDev/fockytv-vencord-plugin/main/installer/install.ps1))) -Client discord -Source "$env:USERPROFILE\Vencord"
```

Falhas de compilação restauram o plugin e a build anteriores. Backups da build
ficam em `dist.fockytv-backup-*` e os do plugin em `.fockytv-backups/` (só os três
mais recentes de cada); os das configurações ficam junto ao JSON original. Configuração JSON inválida interrompe a
instalação sem sobrescrever o arquivo. Não apague o checkout: o cliente usa seu
`dist` ao abrir.

O fluxo usa a [CLI oficial do Vencord](https://github.com/Vencord/Installer) e a
[seleção de build do Vesktop](https://github.com/Vencord/Vesktop/blob/main/src/main/vencordFilesDir.ts).
O [GoLiveBypass](https://github.com/bezumiya/GoLiveBypass#instalação-do-plugin-recomendado-para-equicord-vencord-e-vesktop)
foi consultado como referência de instalação.

## Instalação manual

1. Tenha uma cópia do código-fonte do Vencord e suas dependências instaladas.
2. Copie esta pasta inteira para `Vencord/src/userplugins/fockytv`.
3. Na pasta do Vencord, execute `pnpm build`.
4. Para Discord desktop, execute `pnpm inject`. Para Vesktop, selecione a pasta
   `Vencord/dist` na opção de localização personalizada do Vencord.
5. Reinicie o cliente e ative **FockyTV** em Configurações → Vencord → Plugins.
6. Configure a URL base do servidor (sem caminho), se não usar o padrão. FPS e resolução vêm do seletor
   do Discord. A live usa sempre seu username do Discord.

Plugins personalizados precisam ser compilados junto com o Vencord; este ZIP
não é um plugin BetterDiscord e não pode ser importado como `.plugin.js`.
Referência: https://docs.vencord.dev/plugins/

## Uso

Com o FockyTV ativado, use o **botão normal de compartilhar tela do Discord**
e escolha tela/janela e qualidade no seletor nativo. A transmissão é enviada
para o FockyTV; o comando normal de parar encerra a publicação. Uma notificação
confirma o início ou informa o erro. A resolução e o FPS escolhidos no Discord
valem desde o início, inclusive no Vesktop. Durante a transmissão, use o menu
nativo de qualidade para alterá-los: a sessão e o áudio são preservados. Uma
falha restaura a configuração anterior e informa o erro; a opção Fonte remove
o limite de altura. A qualidade efetiva continua sujeita à fonte, rede e encoder.
Desativar o plugin devolve o botão ao Go Live
(após reiniciar o cliente para remover os patches).

Quem também tem o plugin vê a live **como um Go Live nativo**: o participante
aparece "AO VIVO" na call e o botão **Assistir transmissão** abre a live no
quadro do próprio Discord (tela cheia, foco e "parar de assistir" incluídos).
O áudio respeita o ensurdecer. A live usa sempre o username do Discord, que é
como os outros a reconhecem na mesma call; a lista é atualizada a cada cinco segundos.

A webcam também aparece automaticamente no quadro de câmera da chamada para quem
tem o plugin, usando a publicação `username-cam`. A imagem remota não é espelhada;
a conexão fecha ao desligar a câmera ou sair do canal. A descoberta leva até cinco segundos.

O botão **Abrir FockyTV** nas configurações abre o painel de lives/câmera. O painel também compartilha tela e câmera simultaneamente,
com chaves `username` e `username-cam` (limitadas a 32 caracteres), e lista lives a
cada cinco segundos.

O player para ao fechar o painel. Publicações continuam e param com os botões,
a saída da chamada, logout ou desativação do plugin. O encerramento envia DELETE
para liberar a sessão no servidor. Se o processo morrer abruptamente, o servidor
precisa expirar a sessão.

### Música da call

Por padrão, a atividade do Discord mostra **Ouvindo <música> — <artista>**
(o artista é o canal informado pelo YouTube) ou **Assistindo a live de <nome>**.
A live tem prioridade quando os dois tocam juntos, por ser o foco principal.
Pausar/sair da música, parar de assistir ou desativar o plugin remove a atividade.
Desligue **showActivity** nas configurações do FockyTV para ocultá-la.
O status personalizado é preservado; a visibilidade segue o compartilhamento de
atividades do próprio Discord.

O botão de música, ao lado do de câmera no painel de voz, abre o player da call:
busca no YouTube (10 resultados), fila à direita e o que está tocando. Clicar no
botão já entra na música; "Sair da música" desliga só o seu som. Todos tocam o
mesmo trecho ao mesmo tempo: o relógio fica no servidor e cada plugin baixa a
faixa (yt-dlp no `fixed-live`, só em memória: a atual e a próxima). O botão fica
verde pulsando enquanto toca, também para quem ainda não entrou.

Qualquer um adiciona, pausa, continua, pula ou toca outra da fila; só quem
adicionou remove. O volume é seu (com o volume geral e o ensurdecer do Discord).
Enquanto você ouve, um tile local na grade da call mostra a letra em um canvas,
com a linha atual destacada pelo tempo do áudio. Só você vê esse tile; ele não
é transmitido nem publicado. Continua ao fechar o painel e some ao sair da
música, sair da call ou terminar a faixa. Se houver só letra simples, ela aparece
sem destaque sincronizado; sem letra ou com falha na consulta, mostra “Sem letra”.
Para esconder o tile, use “Ocultar letra de música” no menu “⋯” da call.

Faixas de até 2 h, fila de até 100. A fila some 1 min depois que todos saem da call.

### Watch party do YouTube

O botão de vídeo ao lado de Música entra na watch party e abre a busca,
entrada de links e playlist compartilhada (até 100 vídeos). Adicionar mantém
o vídeo atual; a fila avança automaticamente quando ele termina. O botão
fica ativo enquanto você participa, com um botão “Sair” ao lado para encerrar
a reprodução só para você. Quem assiste ganha o selo WATCH na
lista do canal para usuários do plugin. O selo fica à direita, centralizado
na linha; ao passar o mouse, quem ainda não participa pode clicar em “Juntar-se”.

O vídeo aparece como um tile na grade da call, com play/pausa, posição e
próximo vídeo para todos. No canvas, o ícone de volume abre o slider no
hover/foco; clicar silencia ou restaura o último volume. “Sair da watch party”
também fica no canvas; essa opção encerra a reprodução só para você, sem sair da call.
A sincronização e as novas tentativas após falhas de download são automáticas. O volume é
local e respeita a saída e o ensurdecer do Discord. Entrar na call por si só
não inicia a reprodução. Sair ou trocar de call encerra a participação
anterior. O estado é efêmero e some quando o último plugin sai da call.

Playlist e selo WATCH exigem a atualização correspondente de
`server/fixed-live/jam-yt.js` e `server/fixed-live/index.js` no backend FockyTV.

Usa o protocolo `yt` do WebSocket do jam, com relógio e snapshot no servidor,
e `/api/fixed/jam/yt/video`: o servidor baixa vídeo (Full HD até 400 MB, senão 720p) e áudio com
yt-dlp para a memória, junta sem recodificar e guarda até 3 vídeos por 30 min
para quem entrar depois. Nada vai para o disco. O cliente baixa o MP4 inteiro
antes de começar; arquivos acima de 512 MiB são recusados.
Vídeos restritos e lives podem não funcionar.

### Jira

Preencha nas configurações o site do Jira Cloud (`https://empresa.atlassian.net`),
o e-mail da conta Atlassian e um API token (id.atlassian.com → Segurança →
tokens de API). Com os três, o botão do Jira aparece ao lado do microfone,
no painel da conta, e abre um modal com o board: sprint ativa por coluna
(com escolha entre sprints paralelas e progresso), backlog, busca e "Só minhas".
Na tarefa dá para mudar o status, comentar, compartilhar no chat da call e abrir
no Jira. As chamadas saem do processo nativo e o token só vai para `*.atlassian.net`.

### GitHub

O botão do GitHub aparece ao lado do microfone após configurar um token e abre
o acompanhamento de um projeto (repositório). O projeto começa em branco.
O select lista os repositórios da sua conta; também é possível abrir um projeto
por `dono/repositório` ou pelo link do GitHub. A última escolha fica salva.

O painel reúne PRs, issues e execuções do Actions/CI, com busca, filtros de
estado, itens criados por você ou atribuídos a você e PRs aguardando seu review
individual. Os contadores e filtros consideram os itens carregados; **Carregar
mais** amplia a lista. No detalhe há descrição, responsáveis, labels, milestone,
branches, alterações, decisões de review e a página mais recente dos comentários
gerais. Copie o link ou abra no GitHub para responder, revisar ou fazer merge.
As descrições renderizam Markdown pelo parser do Discord (títulos, listas,
links, negrito e blocos de código); os comentários gerais continuam como texto.
HTML não é executado. Na listagem de PRs, o símbolo de CI mostra o estado do
Actions e a etapa atual; passe o mouse para ver workflow, job e etapa. A consulta
usa o commit atual do PR e só roda para os PRs visíveis, respeitando a atualização
automática. Falhas de acesso às etapas não escondem o estado do workflow.
Os dados vêm dos [jobs do Actions](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run).

O ícone do GitHub mostra um badge com a quantidade dos seus PRs (autor = dono do
token) na **Merge Queue** do repositório selecionado; PRs de outras pessoas não aparecem. No hover aparece só o número e o estado de cada PR: na fila, um ícone girando;
mesclado, um check roxo que fica por pelo menos 15 minutos e até você abrir o
painel do GitHub. No modal, **Mesclados hoje** lista em roxo seus PRs mesclados
desde a meia-noite (busca do GitHub, até 50), com o horário do merge; o histórico zera a cada dia. O modal tem cards compactos por PR na seção
**Merge Queue**, com posição, branch de destino, tempo na fila, estimativa do GitHub e checks individuais
(até 100; os demais ficam no GitHub). Execuções usam um spinner, sucessos
um ícone verde e falhas um ícone vermelho. Os nomes e contadores dos testes
são preservados; a barra resume os checks aprovados. O card do PR na lista
também indica quando ele está na fila. PRs saem do badge ao
sair da fila. Esta consulta usa o token configurado e GraphQL pelo processo
nativo, com destino fixo em `api.github.com`; não altera a fila nem o repositório.
Ícone e modal compartilham a consulta a cada 30 segundos enquanto o Discord
está visível. Falhas preservam os últimos dados, mostram `!` no badge e repetem
a consulta com espera progressiva de até 5 minutos. Fechar o último consumidor
interrompe o monitor. A Merge Queue precisa estar habilitada no GitHub; um PR
com CI aguardando execução só aparece aqui se estiver realmente nessa fila.

A atualização automática acontece a cada 60 segundos enquanto o painel está
aberto e o Discord está visível. Pode ser pausada; erros da API a pausam
automaticamente. Actions sem permissão mostra um erro na própria seção e não
impede a consulta de PRs e issues. O painel consulta dados e não altera recursos
no GitHub. Separadamente, o plugin recebe avisos de PR aberto, PR mergeado e Actions que falhou na main
deste repositório pelo mesmo canal de updates, mesmo com o painel fechado, somente nos clientes com token GitHub configurado. Remover o token oculta os botões e interrompe esses avisos; os avisos de atualização do plugin continuam para todos.
Clicar no aviso abre o PR ou a execução no GitHub. Veja a
[configuração do webhook](docs/update-notifications.md).

Para ativar o painel, listar seus projetos e consultar repositórios públicos e
privados, configure um personal access token em **FockyTV → GitHub**, com acesso
aos repositórios desejados e leitura de **Metadata**, **Pull requests**, **Issues**
e **Actions**, conforme a [documentação de permissões do GitHub](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).
Organizações podem exigir aprovação e SSO. O campo oculta o token, que fica nas
configurações locais do Vencord, como o token do Jira. As consultas saem do
processo nativo exclusivamente para `https://api.github.com`, sem seguir
redirecionamentos. GitHub Enterprise e quadros do GitHub Projects não estão
incluídos neste seletor de repositórios.

## Limites

- Tela/câmera publicam por WHIP no servidor FockyTV, como o cliente Rust atual.
  O player do painel usa WHEP para lives antigas; lives `engine: livekit`,
  incluindo as publicadas pelo plugin, são assistidas pelo Go Live do Discord
  ou pelo site. Para isso o plugin embute o `livekit-client` 2.22.3
  (Apache-2.0, o mesmo do site); a sinalização WebSocket passa pelo processo
  nativo porque o CSP do Discord bloqueia conexões ao servidor FockyTV.
- No Windows, respeita **Compartilhar áudio** no seletor do Discord. Uma janela
  captura o áudio do processo escolhido; uma tela mistura os aplicativos,
  excluindo Discord/Vesktop/FockyTV. O preview local é sempre silenciado.
  O helper WASAPI exige Windows 10 build 20348+ ou Windows 11. Se falhar,
  informa o erro e preserva o vídeo.
- No Linux/Vesktop, usa o áudio fornecido pelo seletor nativo/PipeWire,
  respeitando a opção de compartilhar sem som. Sem faixa de áudio fornecida
  pelo cliente, transmite apenas vídeo; o helper Windows não é chamado.
- O preview aparece como tile local na chamada do Discord. Usa a captura
  publicada, sem uma segunda sessão de vídeo ou reprodução do próprio áudio.
  O preview informa as dimensões ao Discord e aparece antes da negociação de rede.
- Passar o mouse sobre uma live FockyTV mostra uma miniatura no cartão nativo do
  Discord. A imagem é capturada sob demanda, sem reprodução de áudio, e usa o cache
  de previews do Discord. Uma conexão temporária usada só para a imagem é fechada
  depois da captura.
- Publicações só confirmam o início após o WebRTC conectar. A coleta ICE usa a configuração
  padrão do cliente, sem depender de STUN externo, e aproveita candidatos já
  coletados se a coleta demorar. A conexão falha após 20 segundos; rede/VPN
  e a porta de mídia do servidor ainda precisam permitir o tráfego WebRTC.
- Câmera não captura microfone; WHEP recebe áudio quando a live o oferece.
- Redireciona o início de tela e o comando de parar do Discord. O estado do
  botão e do preview é local; não cria um Go Live nos servidores Discord.
  Participantes **sem** o plugin não veem a live na call e assistem pelo site.
  O volume de stream do Discord e a prévia (miniatura) não se aplicam às lives FockyTV.
- A fonte escolhida no seletor usa captura desktop do Chromium (tela/janela).
  Fontes especiais, como câmeras escolhidas para Go Live ou o seletor nativo
  de macOS, ainda não são suportadas por essa integração.
- Inclui a liberação local de câmera e compartilhamento do experimento
  `2026-08-video-guard`; não exige GoLiveBypass para liberar os botões.
  Reinicie o Discord após ativar o plugin. Isso não altera bloqueios do servidor.
- Os patches dependem do código interno do Discord e podem precisar de ajuste
  após uma atualização.
- Captura usa as permissões e o seletor do Chromium/Electron. No Linux/Wayland,
  depende do portal disponível e da implementação de captura desktop do cliente.
  No Hyprland com `~/.config/hypr/xdph.conf` configurado, as configurações do
  FockyTV permitem alternar entre o seletor padrão (sem miniaturas) e o seletor
  com miniaturas, se instalados. O padrão contorna janelas ausentes no seletor
  com miniaturas. A escolha vale para todos os aplicativos e reinicia o portal,
  interrompendo capturas em andamento. O plugin preserva as outras opções e
  salva a configuração anterior à primeira troca em `xdph.conf.fockytv.bak`.
- Sinalização HTTP usa o helper nativo; esta versão não suporta Vencord no navegador.
- Lives seguem a visibilidade do servidor FockyTV, não as permissões do canal Discord.

## Captura nativa (Windows)

No Windows, o botão de compartilhar do Discord usa por padrão a captura nativa:
Windows Graphics Capture e o encoder de hardware da GPU (NVIDIA, AMD ou Intel) no FFmpeg, publicando por WHIP no mesmo servidor.
Os quadros ficam na GPU e não passam pelo Chromium; quem assiste não precisa de
nada diferente. Em um jogo pesado (2560×1080), a live passou de ~15 para ~50 FPS
para quem assiste.

- Na primeira live, baixa o FFmpeg 9.0.2 (gyan.dev, ~110 MB) para a pasta do cliente,
  verificado por SHA-256. O log da última live fica em `FockyTV\ffmpeg.log`
  (`%APPDATA%\discord\FockyTV` no Discord).
- Encoder de hardware, tentado nesta ordem: NVENC (NVIDIA), AMF (AMD), AMF com cópia
  da imagem pela memória, QSV (Intel) e Media Foundation do Windows (encoder do próprio
  fabricante, com conversão na CPU). Um encoder só é aprovado depois de codificar vídeo;
  no início da live, um que não entregue quadros em 8 s é trocado pelo próximo. O que
  funcionar fica escolhido até fechar o cliente. `FOCKYTV_CODEC=amf|amf-copy|qsv|mf-copy`
  no ambiente força o primeiro a tentar, para diagnosticar uma GPU.
- Se a captura nativa falhar (nenhum encoder, janela minimizada no início, tela
  totalmente parada), avisa e usa a captura do Discord.
- Trocar FPS, resolução ou a tela pelo menu do Discord reinicia só o encoder: quem
  assiste continua conectado, com um congelamento de ~1 s.
- Bitrate fixo, configurável (padrão 8 Mbps; vale na próxima live). Não há
  adaptação: cada espectador recebe o bitrate inteiro, e o LiveKit pausa o vídeo
  de quem não tem banda. Abaixe o bitrate se a imagem travar para quem assiste.
- Respeita a resolução escolhida no Discord: o tamanho da fonte só se sabe ao abrir a
  captura, então uma tela maior que a escolha (4K com 1080p) reinicia o encoder no
  primeiro segundo já reduzida, na mesma proporção da tela, sem tarjas. "Fonte" e telas
  menores que a escolha saem no tamanho original. O selo mostra a altura que sai de fato.
- O preview local e a miniatura da sua live mostram uma imagem da captura
  atualizada a cada segundo (640 px), sem decodificar a própria live.
- Desative em Configurações → FockyTV → captura nativa para voltar ao Chromium.

Na captura pelo Chromium, o encoder pode reduzir resolução e FPS
para aliviar a carga, mantendo a qualidade escolhida como teto. A adaptação
depende do WebRTC do cliente e não garante eliminar quedas de FPS no jogo.

Para investigar travadas, abra o painel FockyTV e clique em **Diagnosticar
transmissão (30 s)** enquanto joga. Depois use **Copiar diagnóstico**.
Com a captura nativa, o envio não aparece no diagnóstico; use o `ffmpeg.log`. A coleta
é local, não muda a qualidade e para ao fechar o painel. Inclui o envio da tela
e as lives que esse cliente já está assistindo; para comparar envio e recepção,
colete também no cliente de quem assiste ou abra a própria live antes de começar.
Abrir outra reprodução pode aumentar a carga da máquina.

O relatório mede FPS de captura, codificação, envio, recepção e decodificação,
além de bitrate, tempo de processamento, perdas e congelamentos. Identificação
do encoder e motivo de limitação dependem do Chromium; `null` significa dado
indisponível, não zero. `powerEfficientEncoder` é uma indicação do navegador,
não uma confirmação de NVENC. Não inclui tokens, SDP ou endereços ICE e não
envia o relatório ao servidor. A primeira amostra serve de base para as taxas.

## Verificação

Atividade de música/live, prioridade e limpeza do RPC: `pnpm exec tsx --test src/userplugins/fockytv/activity.test.ts`.

Instalador (Node.js 22+, sem alterar clientes reais):
`node --test installer/install.test.mjs`.
No PowerShell, o bootstrap também pode ser verificado sem downloads reais:
`powershell -NoProfile -ExecutionPolicy Bypass -File installer/bootstrap.test.ps1`.

Entrada do Jetta, cooldown e limpeza do efeito (Node.js 22.13+): `node --test jetta.test.ts`.

Ciclo de vida da webcam remota (Node.js 22.13+): `node --test camera.test.mjs`.

Câmera nativa e filtros do Discord desktop: `node --test camera-native.test.mjs`.
No cliente nativo, a câmera reutiliza a saída processada do preview e o fundo
selecionado no Discord. No Vesktop, a captura continua pelo Chromium, sem os
filtros nativos de fundo.

Fim da captura nativa ao fechar o jogo, com e sem áudio, e troca de fonte: `node --test native-capture.test.mjs`.

Configuração do seletor Hyprland, preservação de opções e backup: `node --test linux-picker.test.mjs`.

Áudio que chega após o vídeo ou é republicado: `node --test playback.test.mjs`.

Qualidade dinâmica (Node.js 22.13+, com tsx): `pnpm exec tsx --test src/userplugins/fockytv/quality.test.ts`.

Eventos de atualização, reconexão e rotas nativas: `pnpm exec tsx --test src/userplugins/fockytv/update-events.test.ts src/userplugins/fockytv/native-socket.test.ts`.

Letra no canvas (sincronização, fallback, troca de faixa, limpeza e patches locais):
`pnpm exec tsx --test src/userplugins/fockytv/music-lyrics.test.ts`.

PiP de webcam e alertas de atualização: `pnpm exec tsx --test src/userplugins/fockytv/player-updates.test.ts`.

Métricas e coleta de diagnóstico: `pnpm exec tsx --test src/userplugins/fockytv/diagnostics.test.ts`.

Integração com o Jira (site, colunas, texto das tarefas): `pnpm exec tsx --test src/userplugins/fockytv/jira.test.ts`.

Integração com o GitHub (configuração, acesso à API, paginação, filtros e reviews): `pnpm exec tsx --test src/userplugins/fockytv/github.test.ts src/userplugins/fockytv/github-settings.test.ts src/userplugins/fockytv/github-queue.test.ts`.

Com as ferramentas de desenvolvimento do Vencord:
`pnpm exec tsx src/userplugins/fockytv/self-check.ts`.

## Capturador de áudio Windows

`audio-helper.exe` e `audio-helper.cpp` são reutilizados do projeto FockyTV
(`electron/audio-helper/capture.cpp`). O Vencord embute o binário no helper
nativo; na primeira captura ele é materializado na pasta privada do cliente,
com verificação SHA-256. Parar a tela, sair da chamada ou fechar o cliente
encerra o capturador. Buffers preservam frames PCM e têm limite de tamanho.

Recompilação opcional (MinGW):
`x86_64-w64-mingw32-g++ -std=c++17 -O2 -static -o audio-helper.exe audio-helper.cpp -lole32 -lpsapi`.

Watch party (relógio, troca durante download, transporte e rotas nativas):
`pnpm exec tsx --test src/userplugins/fockytv/watch-party.test.ts src/userplugins/fockytv/watch-party-native.test.ts src/userplugins/fockytv/native-socket.test.ts`.
