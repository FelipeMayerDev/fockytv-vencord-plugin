# Avisos de atualização, PR e CI

O fluxo é `push na main → webhook assinado → servidor FockyTV → WebSocket dos clientes → checagem no GitHub → notificação`. Clientes conectados recebem o aviso assim que o evento é entregue e a consulta ao GitHub termina. A entrega não tem garantia de latência instantânea.

O cliente usa `/api/fixed/ws/plugin-updates` no servidor configurado no FockyTV. Para atualizações, só aceita eventos `plugin-update` com SHA válido e usa o evento apenas como gatilho para `checkUpdate`: a revisão e o instalador continuam vindo do repositório fixo no GitHub. Nunca instala nada por receber uma mensagem. A consulta ao `main` pede uma resposta sem cache e varia a URL por checagem, pois a API do GitHub pode servir uma revisão antiga durante 60 segundos mesmo com `no-store`. Cada revisão é notificada uma vez por sessão; se a entrega da notificação falhar, uma nova checagem pode tentar novamente.

A checagem inicial acontece imediatamente. A reconexão tem espera progressiva de 1 a 30 segundos, heartbeat a cada 25 segundos e nova checagem ao conectar para recuperar pushes ocorridos offline. A consulta a cada 15 minutos continua como fallback para falhas de webhook, servidor ou conexão. Parar o plugin encerra a conexão e os timers.

## Preparação do servidor

O backend correspondente está no projeto `fockytv`, no módulo `server/fixed-live/plugin-updates.js`, integrado ao Express antes do parser JSON e ao roteador de upgrades WebSocket. O Dockerfile copia o módulo; o compose repassa `GITHUB_WEBHOOK_SECRET` ao serviço `fixed-live`. Não há nova dependência.

1. Defina um segredo aleatório forte em `server/.env` como `GITHUB_WEBHOOK_SECRET`. Não o adicione ao Git.
2. No servidor LAN (`192.168.1.129`), em `/opt/docker/fockytv/server`, use `docker compose -f docker-compose.yml -f docker-compose.livekit.yml build fixed-live` e `docker compose -f docker-compose.yml -f docker-compose.livekit.yml up -d --no-deps fixed-live`. Recrie apenas esse serviço, preservando os overrides e as configurações do ambiente.
3. No repositório `FelipeMayerDev/fockytv-vencord-plugin`, configure um webhook ativo com URL `https://fockytv.felipemayer.com.br/api/fixed/plugin-updates/webhook`, conteúdo `application/json`, o mesmo segredo e os eventos **push**, **pull_request** e **workflow_run**. O webhook existente é `701469983`; alterar suas assinaturas requer confirmação do responsável. Mantenha a verificação TLS ligada.
4. Confira a entrega de **ping** do GitHub e, no próximo push real da `main`, a resposta **202** e os avisos dos clientes atualizados.

A ingestão fica desativada (HTTP 503) sem segredo. O servidor verifica a assinatura HMAC-SHA256 sobre o corpo original e o repositório; para pushes, também verifica `refs/heads/main`, o SHA e a indicação de exclusão da branch. Pushes de outros branches, eventos de outros repositórios e entregas repetidas são ignorados. O limite de corpo é 25 MB; assinaturas inválidas recebem 401. O servidor não executa comandos nem instala atualizações pelo webhook.

## PRs e falhas do Actions

O mesmo webhook e WebSocket enviam mensagens `github-event` para PR **aberto** (`pull_request`, ação `opened`), PR **mergeado** (`closed` com `merged: true`) e Actions que **falhou na main** (`workflow_run`, ação `completed`, conclusão `failure`, branch `main` e repositório de origem igual ao do plugin). PR reaberto, fechado sem merge, outras conclusões e execuções de forks são ignorados. Os eventos seguem a [documentação de payloads do GitHub](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

A mensagem contém `kind` (`pr-opened`, `pr-merged` ou `workflow-failed`), `id` (número do PR ou ID da execução), `title` (até 300 caracteres) e `delivery` (ID da entrega). HMAC, filtro de repositório e deduplicação são compartilhados com os pushes. O plugin valida os campos e monta o link no repositório fixo, sem aceitar URLs do payload. `showNotification` mostra o título do PR/workflow; clicar abre o PR ou a execução no navegador. O painel GitHub não oferece entrada direta por número de PR e já abre execuções externamente.

Clientes antigos ignoram `github-event` e continuam recebendo `plugin-update` sem alterações. Estes avisos não dependem do painel aberto, token GitHub ou repositório selecionado nele. A deduplicação guarda as últimas 1000 entregas em memória no servidor e no cliente; reiniciar perde esse histórico. PRs e falhas não têm histórico nem recuperação de eventos offline. O fallback de consulta continua exclusivo das atualizações do plugin.

O broadcast usa a instância atual de `fixed-live`, que hoje é única por ambiente. Em um ambiente com várias réplicas, é necessário compartilhar os eventos entre elas. Webhooks podem atrasar, falhar ou chegar fora de ordem; por isso o cliente sempre consulta o `main` atual no GitHub e mantém o fallback. Clientes antigos precisam atualizar uma vez para passar a escutar o canal de eventos. Clientes apontados para outro servidor precisam que aquele servidor ofereça o mesmo endpoint.

Referências: [boas práticas de webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks), [falhas de entrega](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

## Verificação

No checkout do Vencord, rode os testes `update-events.test.ts`, `native-socket.test.ts` e `player-updates.test.ts` com `tsx --test`, além do `self-check.ts`. `update-events.test.ts` também cobre os avisos de PR/CI, links e deduplicação após reconexão.

No backend: `cd server/fixed-live && npm test`. O teste `test/plugin-updates.mjs` usa um servidor local e dois clientes WebSocket para verificar assinatura, filtro de branch/repositório, entregas duplicadas, broadcast de push/PR/CI, exclusão de forks e heartbeat, sem acessar produção.
