# FockyTV para Vencord

Port do plugin Rust deste projeto para um userplugin TypeScript do Vencord
**desktop** (Discord ou Vesktop com uma build personalizada do Vencord).
Sem dependências adicionais. Licença GPL-3.0-or-later, conforme LICENSE.

## Instalação

1. Tenha uma cópia do código-fonte do Vencord e suas dependências instaladas.
2. Copie esta pasta inteira para `Vencord/src/userplugins/fockytv`.
3. Na pasta do Vencord, execute `pnpm build`.
4. Para Discord desktop, execute `pnpm inject`. Para Vesktop, selecione a pasta
   `Vencord/dist` na opção de localização personalizada do Vencord.
5. Reinicie o cliente e ative **FockyTV** em Configurações → Vencord → Plugins.
6. Configure a URL base do servidor (sem caminho), nick (vazio usa seu username), FPS e resolução.

Plugins personalizados precisam ser compilados junto com o Vencord; este ZIP
não é um plugin BetterDiscord e não pode ser importado como `.plugin.js`.
Referência: https://docs.vencord.dev/plugins/

## Uso

Com o FockyTV ativado, use o **botão normal de compartilhar tela do Discord**
e escolha tela/janela e qualidade no seletor nativo. A transmissão é enviada
para o FockyTV; o comando normal de parar encerra a publicação. Uma notificação
confirma o início ou informa o erro. Desativar o plugin devolve o botão ao Go Live
(após reiniciar o cliente para remover os patches).

O ícone de TV na barra de mensagens e **Abrir FockyTV** nas configurações abrem
o painel de lives/câmera. O painel também compartilha tela e câmera simultaneamente,
com chaves `nick` e `nick-cam` (limitadas a 32 caracteres), e lista lives a
cada cinco segundos. Use o nick do Discord para ser reconhecido pelo cliente Rust.

O player para ao fechar o painel. Publicações continuam e param com os botões,
a saída da chamada, logout ou desativação do plugin. O encerramento envia DELETE
para liberar a sessão no servidor. Se o processo morrer abruptamente, o servidor
precisa expirar a sessão.

## Limites

- Tela/câmera usam WHIP; player usa WHEP, como o plugin Rust original.
  Lives `engine: livekit` exigem o site FockyTV, acessível pelo painel.
- No Windows, respeita **Compartilhar áudio** no seletor do Discord. Uma janela
  captura o áudio do processo escolhido; uma tela mistura os aplicativos,
  excluindo Discord/Vesktop/FockyTV. O preview local é sempre silenciado.
  O helper WASAPI exige Windows 10 build 20348+ ou Windows 11. Em outro sistema
  ou se a captura de som falhar, informa o erro e preserva o vídeo.
- O preview aparece como tile local na chamada do Discord. Usa a captura
  publicada, sem uma segunda sessão de vídeo ou reprodução do próprio áudio.
- Câmera não captura microfone; WHEP recebe áudio quando a live o oferece.
- Redireciona o início de tela e o comando de parar do Discord. O estado do
  botão e do preview é local; não cria um Go Live nos servidores Discord nem
  adiciona badges/players FockyTV aos outros participantes. Eles assistem pelo painel
  ou pelo site. O botão nativo de câmera continua sendo o do Discord.
- A fonte escolhida no seletor usa captura desktop do Chromium (tela/janela).
  Fontes especiais, como câmeras escolhidas para Go Live ou o seletor nativo
  de macOS, ainda não são suportadas por essa integração.
- Os patches dependem do código interno do Discord e podem precisar de ajuste
  após uma atualização. O GoLiveBypass pode permanecer ativo.
- Captura usa as permissões e o seletor do Chromium/Electron. No Linux/Wayland,
  depende do portal disponível e da implementação de captura desktop do cliente.
- Sinalização HTTP usa o helper nativo; esta versão não suporta Vencord no navegador.
- Lives seguem a visibilidade do servidor FockyTV, não as permissões do canal Discord.
- Validado com testes automatizados e build local; captura/player reais ainda
  precisam de teste no cliente conectado ao servidor. A checagem TypeScript
  do checkout usado não apontou erros neste plugin; falha por erros
  preexistentes do GoLiveBypass.

## Verificação

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
