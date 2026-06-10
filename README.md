# buybike-wpp-QandA · Atendente Cláudia

Atendente automática **+ disparo em massa** da Buybike no **WhatsApp** via `web.whatsapp.com`
(whatsapp-web.js). Responde dúvidas dos usuários com a IA da **Cláudia** (mesma persona/base de
conhecimento do atendente oficial do app) **e** dispara mensagens pra uma lista, com freios
anti-ban. **Sem Cloud API, sem templates** — automação do WhatsApp Web.

No mesmo número/processo: você dispara a campanha e a Cláudia atende quem responder. O que o
disparo envia chega como `fromMe` e não dispara auto-reply (sem loop).

Número: **+55 11 93620-2693** (linha dedicada de atendimento).

> Escopo: **só Q&A** (responder dúvidas). NÃO faz o fluxo de foto→preço→publicar — pra anunciar,
> a Cláudia direciona pro site (buybike.com.br/anunciar). Persona é cópia de `lib/ai-claudia.js`
> do app principal (fonte da verdade).

## Como funciona

- `claudia.js` — porta enxuta da Cláudia: chama a Anthropic (Haiku) com a persona da Buybike,
  com anti-loop (detecta menu de bot de loja e não responde) e guard `NO_REPLY`.
- `server.js` — conecta no WhatsApp Web, escuta `message`, e responde. Ignora grupos, status,
  newsletters e o que ele mesmo envia. Tem cooldown anti-flood por contato. Expõe uma página de
  QR/status protegida por token.

## Rodar local (teste)

Precisa de Node 18+ e Google Chrome instalado.

```bash
npm install
cp .env.example .env   # preencha ANTHROPIC_API_KEY (copie do .env.local do app)
node server.js
```

Abra `http://localhost:3838` (sem ADMIN_TOKEN local, fica aberto) e escaneie o QR com o
WhatsApp do número **5511936202693** (Aparelhos conectados → Conectar aparelho). Mande uma
mensagem de outro celular pra testar a resposta.

> Sem `ANTHROPIC_API_KEY` o bot roda em **modo mock** (responde sempre a mesma mensagem padrão) —
> útil pra validar a conexão sem gastar token.

## Deploy no Railway

1. **New Project → Deploy from GitHub repo** → `gugarcez/buybike-wpp-QandA`.
   O Railway detecta o `Dockerfile` (Chromium já incluso na imagem).
2. **Variables** (Settings → Variables):
   - `ANTHROPIC_API_KEY` — chave da Anthropic.
   - `ADMIN_TOKEN` — uma senha aleatória pra proteger a página de QR/status.
   - `CLAUDIA_ENABLED` — `true` (use `false` pra desligar as respostas sem derrubar o serviço).
   - `WWEB_AUTH` — `/app/.wwebjs_auth` (caminho do volume, passo 3).
   - `PORT` é injetada pelo Railway automaticamente.
3. **Volume** (Settings → Volumes): adicione um volume montado em **`/app/.wwebjs_auth`**.
   Sem isso, todo redeploy desloga e exige re-scan do QR.
4. **Gerar domínio público** (Settings → Networking → Generate Domain).
5. Abra `https://SEU-APP.up.railway.app/?token=SEU_ADMIN_TOKEN` e escaneie o QR com o número.
   (Se preferir, o QR também sai em ASCII nos **Deploy Logs**.)

### Render (alternativa)
New → Web Service → conecte o repo → runtime **Docker**. Adicione um **Disk** montado em
`/app/.wwebjs_auth`. Mesmas variáveis acima. Render injeta `PORT`.

## Variáveis

| Var | Obrigatória | Default | Descrição |
|-----|-------------|---------|-----------|
| `ANTHROPIC_API_KEY` | sim (real) | — | Chave da Anthropic (sem ela = modo mock) |
| `ADMIN_TOKEN` | recomendada | vazio | Protege `/` e `/api/status` |
| `CLAUDIA_ENABLED` | não | `true` | Kill-switch das respostas |
| `COOLDOWN_MS` | não | `15000` | Anti-flood do atendente, por contato (ms) |
| `NUMERO_TESTE` | não | `5511977777030` | Número do botão "Testar" do disparo |
| `DELAY_MIN` / `DELAY_MAX` | não | `8000` / `25000` | Delay aleatório entre envios do disparo (ms) |
| `LOTE` | não | `20` | Mensagens por lote no disparo |
| `PAUSA_LOTE` | não | `120000` | Pausa entre lotes do disparo (ms) |
| `WWEB_AUTH` | prod | `./.wwebjs_auth` | Pasta da sessão (volume no Railway) |
| `PORT` | não | `3838` | Porta HTTP (PaaS injeta) |
| `PUPPETEER_EXECUTABLE_PATH` | docker | — | Chromium (Docker: `/usr/bin/chromium`) |

## Avisos

- **Responde TODO 1:1 automaticamente.** Use só num número dedicado de atendimento.
- whatsapp-web.js é **não-oficial** — risco de ban existe; mitigado por ser reativo (responde quem
  escreve), não disparo frio. Não use pra spam.
- A persona vive em `lib/ai-claudia.js` no app principal. Mudou lá → copie em `claudia.js`.
