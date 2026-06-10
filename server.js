import express from 'express'
import qrcode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import pkg from 'whatsapp-web.js'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { responderComoClaudia, CLAUDIA_SUPPRESS, RESPOSTA_MOCK } from './claudia.js'

const { Client, LocalAuth } = pkg
const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3838
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '' // protege a página de QR/status
const CLAUDIA_ENABLED = process.env.CLAUDIA_ENABLED !== 'false' // kill-switch
const WWEB_AUTH = process.env.WWEB_AUTH || join(__dirname, '.wwebjs_auth')
// Chromium: no Docker vem de PUPPETEER_EXECUTABLE_PATH; local cai pro Chrome do
// sistema (o bundle do puppeteer veio quebrado nesta máquina).
const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Anti-flood: no máximo 1 resposta automática a cada N ms por contato.
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 15000)
const ultimaResposta = new Map() // chatId → timestamp

// ─── Estado em memória (pra página de status) ──────────────────────────────────
const state = {
  ready: false,
  qr: null, // dataURL pra exibir
  me: null, // número conectado
  log: [],
  atendidos: 0, // quantas respostas a Cláudia mandou
  suprimidos: 0, // quantas vezes suprimiu (menu de bot)
}

function pushLog(msg) {
  const linha = `[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`
  state.log.push(linha)
  if (state.log.length > 500) state.log.shift()
  console.log(linha)
}

// ─── Cliente WhatsApp ───────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: WWEB_AUTH }),
  puppeteer: {
    headless: true,
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
})

client.on('qr', async (qr) => {
  state.qr = await qrcode.toDataURL(qr)
  state.ready = false
  pushLog('QR gerado — escaneie no painel ou pelo QR no log abaixo.')
  // QR ASCII no log: permite linkar mesmo sem abrir a página (servidor headless).
  qrcodeTerminal.generate(qr, { small: true })
})

client.on('authenticated', () => pushLog('Autenticado ✓'))

client.on('ready', () => {
  state.ready = true
  state.qr = null
  state.me = client.info?.wid?.user || '?'
  pushLog(`Conectado como ${state.me} ✓ — atendente ${CLAUDIA_ENABLED ? 'ATIVO' : 'DESLIGADO (CLAUDIA_ENABLED=false)'}`)
})

client.on('disconnected', (reason) => {
  state.ready = false
  pushLog(`Desconectado: ${reason}. Reiniciando...`)
  client.initialize()
})

// ─── Atendente: responde mensagens recebidas ───────────────────────────────────
const CONVITE_FOTO =
  'Recebi sua mídia! 📸 Pra anunciar sua bike é rapidinho e grátis: faça pelo site em ' +
  'buybike.com.br/anunciar que a IA identifica o modelo e sugere o preço. Qualquer dúvida, é só me chamar aqui.'

client.on('message', async (msg) => {
  try {
    // Ignora: nada que a gente mandou, grupos, status/broadcast, newsletters/canais.
    if (msg.fromMe) return
    const from = msg.from || ''
    if (from.endsWith('@g.us')) return // grupo
    if (from === 'status@broadcast' || from.endsWith('@broadcast')) return
    if (from.endsWith('@newsletter')) return
    if (!CLAUDIA_ENABLED) return

    // Anti-flood por contato.
    const agora = Date.now()
    const ultima = ultimaResposta.get(from) || 0
    if (agora - ultima < COOLDOWN_MS) {
      pushLog(`(cooldown) ignorando msg de ${from}`)
      return
    }

    // Mídia/foto: fluxo de publicar está fora de escopo → convite único pro site.
    if (msg.hasMedia || (msg.type && msg.type !== 'chat')) {
      ultimaResposta.set(from, agora)
      await msg.reply(CONVITE_FOTO)
      state.atendidos++
      pushLog(`📸 ${from} mandou mídia → convite pro /anunciar`)
      return
    }

    const texto = (msg.body || '').trim()
    if (!texto) return

    let nome
    try {
      const contact = await msg.getContact()
      nome = contact?.pushname || contact?.name || undefined
    } catch {}

    let chat
    try {
      chat = await msg.getChat()
      await chat.sendStateTyping()
    } catch {}

    const resposta = await responderComoClaudia({ pergunta: texto, nome, canal: 'WhatsApp' })

    if (resposta === CLAUDIA_SUPPRESS) {
      state.suprimidos++
      pushLog(`🤫 ${from} — auto-reply/menu de bot, suprimido: "${texto.slice(0, 50)}"`)
      try { await chat?.clearState() } catch {}
      return
    }

    const final = resposta || RESPOSTA_MOCK // null (erro) → welcome padrão
    ultimaResposta.set(from, agora)
    await msg.reply(final)
    state.atendidos++
    pushLog(`✓ ${from} ${nome ? `(${nome}) ` : ''}→ respondido: "${texto.slice(0, 50)}"`)
  } catch (e) {
    pushLog(`✗ erro ao atender ${msg?.from}: ${e.message}`)
  }
})

client.initialize()

// ─── Página de QR / status ──────────────────────────────────────────────────
const app = express()

function autorizado(req) {
  if (!ADMIN_TOKEN) return true // sem token configurado → aberto (use em local)
  return req.query.token === ADMIN_TOKEN
}

app.get('/api/status', (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ erro: 'token inválido' })
  res.json({
    ready: state.ready,
    qr: state.qr,
    me: state.me,
    atendidos: state.atendidos,
    suprimidos: state.suprimidos,
    claudia: CLAUDIA_ENABLED,
    log: state.log.slice(-200),
  })
})

app.get('/healthz', (_req, res) => res.json({ ok: true, ready: state.ready }))

app.get('/', (req, res) => {
  if (!autorizado(req)) return res.status(401).send('token inválido — use ?token=SEU_ADMIN_TOKEN')
  res.sendFile(join(__dirname, 'public', 'index.html'))
})
app.use(express.static(join(__dirname, 'public')))

app.listen(PORT, () => pushLog(`Painel/atendente em http://localhost:${PORT}`))
