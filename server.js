import express from 'express'
import qrcode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import pkg from 'whatsapp-web.js'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'

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

// ─── Config de disparo (freios anti-ban, iguais ao whatsapp-disparo) ───────────
const NUMERO_TESTE = process.env.NUMERO_TESTE || '5511977777030' // teste padrão (Fabio Lino)
const DELAY_MIN = Number(process.env.DELAY_MIN || 8000) // 8s mín entre envios
const DELAY_MAX = Number(process.env.DELAY_MAX || 25000) // 25s máx entre envios
const LOTE = Number(process.env.LOTE || 20) // msgs por lote
const PAUSA_LOTE = Number(process.env.PAUSA_LOTE || 120000) // 2min entre lotes

// Janela de horário do disparo de LISTA (teste/dry-run ignoram). Fora dela o
// disparo pausa e retoma sozinho quando reabre. Padrão: 9h–18h de Brasília.
const JANELA_INICIO = Number(process.env.JANELA_INICIO || 9)
const JANELA_FIM = Number(process.env.JANELA_FIM || 18)
const JANELA_TZ = process.env.JANELA_TZ || 'America/Sao_Paulo'

// Campanha multi-dia (fila persistente no volume + teto diário com rampa).
const CAMPANHA_FILE = join(WWEB_AUTH, 'campanha.json')
let campanha = null // objeto da campanha em andamento (ou null)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

// Normaliza pro formato do WhatsApp: 55 + DDD + número. O JID real (com/sem 9º
// dígito) é resolvido depois por client.getNumberId, que evita mensagem "sumida".
function normalizar(raw) {
  let n = String(raw).replace(/\D/g, '')
  n = n.replace(/^0+/, '') // tira zeros à esquerda (011 → 11)
  if (!n) return null
  if (!n.startsWith('55')) n = '55' + n // assume Brasil se não vier DDI
  return n
}

// Registra o envio e poda entradas mais velhas que o cooldown — num processo
// 24/7 a Map cresceria sem limite (1 entrada por contato único pra sempre).
function registrarResposta(from, ts) {
  ultimaResposta.set(from, ts)
  if (ultimaResposta.size > 1000) {
    for (const [k, t] of ultimaResposta) {
      if (ts - t > COOLDOWN_MS) ultimaResposta.delete(k)
    }
  }
}

// ─── Estado em memória (pra página de status) ──────────────────────────────────
const state = {
  ready: false,
  qr: null, // dataURL pra exibir
  me: null, // número conectado
  log: [],
  atendidos: 0, // quantas respostas a Cláudia mandou
  suprimidos: 0, // quantas vezes suprimiu (menu de bot)
  disparo: { enviando: false, aguardandoJanela: false, progresso: { total: 0, feitos: 0, ok: 0, falha: 0 } },
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
  'Recebi sua mídia! 📸 Aqui eu só tiro dúvidas — pra anunciar sua bike (rapidinho e grátis) é no site: ' +
  'acesse buybike.com.br que a IA identifica o modelo e sugere o preço. Qualquer dúvida, me chama aqui.'

client.on('message', async (msg) => {
  try {
    // Ignora: nada que a gente mandou, grupos, status/broadcast, newsletters/canais.
    if (msg.fromMe) return
    const from = msg.from || ''
    if (from.endsWith('@g.us')) return // grupo
    if (from.endsWith('@broadcast')) return // status@broadcast e listas de transmissão
    if (from.endsWith('@newsletter')) return
    if (!CLAUDIA_ENABLED) return

    // Anti-flood por contato.
    const agora = Date.now()
    const ultima = ultimaResposta.get(from) || 0
    if (agora - ultima < COOLDOWN_MS) {
      pushLog(`(cooldown) ignorando msg de ${from}`)
      return
    }

    // Não-texto: imagem/vídeo/documento → convite pro /anunciar (publicar está fora
    // de escopo). Sticker, áudio, localização, contato etc. são ignorados (não tem
    // o que responter em Q&A de texto e evita o convite de foto sair errado).
    if (msg.type !== 'chat') {
      if (msg.type === 'image' || msg.type === 'video' || msg.type === 'document') {
        registrarResposta(from, agora)
        await msg.reply(CONVITE_FOTO)
        state.atendidos++
        pushLog(`📸 ${from} mandou ${msg.type} → convite pro /anunciar`)
      }
      return
    }

    const texto = (msg.body || '').trim()
    if (!texto) return

    // Contato e chat em paralelo (duas chamadas à ponte do WhatsApp Web) — o nome
    // é opcional, então toleramos falha em qualquer um dos dois.
    const [contactRes, chatRes] = await Promise.allSettled([msg.getContact(), msg.getChat()])
    const contact = contactRes.status === 'fulfilled' ? contactRes.value : null
    const nome = contact?.pushname || contact?.name || undefined
    const chat = chatRes.status === 'fulfilled' ? chatRes.value : null
    try { await chat?.sendStateTyping() } catch {}

    const resposta = await responderComoClaudia({ pergunta: texto, nome, canal: 'WhatsApp' })

    if (resposta === CLAUDIA_SUPPRESS) {
      state.suprimidos++
      pushLog(`🤫 ${from} — auto-reply/menu de bot, suprimido: "${texto.slice(0, 50)}"`)
      try { await chat?.clearState() } catch {}
      return
    }

    const final = resposta || RESPOSTA_MOCK // null (erro) → welcome padrão
    registrarResposta(from, agora)
    await msg.reply(final)
    state.atendidos++
    pushLog(`✓ ${from} ${nome ? `(${nome}) ` : ''}→ respondido: "${texto.slice(0, 50)}"`)
  } catch (e) {
    pushLog(`✗ erro ao atender ${msg?.from}: ${e.message}`)
  }
})

// ─── Janela de horário (BRT) ───────────────────────────────────────────────────
// Hora local na timezone configurada, robusta mesmo com o servidor em UTC (Railway).
function horaLocal() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: JANELA_TZ,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date())
  const h = Number(parts.find((p) => p.type === 'hour').value)
  const m = Number(parts.find((p) => p.type === 'minute').value)
  return h + m / 60
}
function janelaAberta() {
  const h = horaLocal()
  return h >= JANELA_INICIO && h < JANELA_FIM
}
// Bloqueia até a janela reabrir, checando a cada minuto.
async function aguardarJanela() {
  let avisou = false
  while (!janelaAberta()) {
    if (!avisou) {
      pushLog(`Fora da janela (${JANELA_INICIO}h–${JANELA_FIM}h ${JANELA_TZ}). Disparo pausado até reabrir…`)
      state.disparo.aguardandoJanela = true
      avisou = true
    }
    await sleep(60000)
  }
  if (avisou) {
    pushLog('Janela reaberta — retomando disparo.')
    state.disparo.aguardandoJanela = false
  }
}

// ─── Disparo em massa (mesmos freios anti-ban do whatsapp-disparo) ─────────────
// Convive com o atendente: o que disparamos chega como fromMe e não dispara
// auto-reply; quem RESPONDER ao disparo cai no fluxo da Cláudia normalmente.
async function disparar({ numeros, mensagem, dryRun, respeitarJanela }) {
  state.disparo.enviando = true
  state.disparo.aguardandoJanela = false
  state.disparo.progresso = { total: numeros.length, feitos: 0, ok: 0, falha: 0 }
  pushLog(`${dryRun ? '[DRY-RUN] ' : ''}Disparo iniciado para ${numeros.length} número(s).${respeitarJanela ? ` Janela ${JANELA_INICIO}h–${JANELA_FIM}h ${JANELA_TZ}.` : ''}`)

  for (let i = 0; i < numeros.length; i++) {
    // Respeita a janela de horário (lista real); pausa e retoma sozinho.
    if (respeitarJanela) await aguardarJanela()
    const n = numeros[i]
    try {
      if (dryRun) {
        pushLog(`[DRY-RUN] (simulado) → ${n}`)
        state.disparo.progresso.ok++
      } else {
        // getNumberId resolve o JID REAL (trata o 9º dígito) — montar `${n}@c.us`
        // na mão faz a mensagem "sumir" em contas sem o 9.
        const numberId = await client.getNumberId(n)
        if (!numberId) {
          pushLog(`✗ ${n} — não tem WhatsApp, pulando.`)
          state.disparo.progresso.falha++
        } else {
          await client.sendMessage(numberId._serialized, mensagem)
          pushLog(`✓ ${n} → enviado.`)
          state.disparo.progresso.ok++
        }
      }
    } catch (e) {
      pushLog(`✗ ${n} — erro: ${e.message}`)
      state.disparo.progresso.falha++
    }
    state.disparo.progresso.feitos++

    // Pausa entre lotes; senão, delay aleatório entre envios.
    if ((i + 1) % LOTE === 0 && i + 1 < numeros.length) {
      pushLog(`— Lote de ${LOTE} concluído. Pausa de ${PAUSA_LOTE / 1000}s —`)
      await sleep(dryRun ? 1000 : PAUSA_LOTE)
    } else if (i + 1 < numeros.length) {
      await sleep(dryRun ? 300 : rand(DELAY_MIN, DELAY_MAX))
    }
  }

  pushLog(`Disparo concluído. OK: ${state.disparo.progresso.ok} · Falha: ${state.disparo.progresso.falha}`)
  state.disparo.enviando = false
}

// ─── Campanha multi-dia (fila persistente + teto diário com rampa) ─────────────
// Data YYYY-MM-DD na timezone da janela (pra contar "dia" e zerar o teto diário).
function dataLocal() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: JANELA_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

// Rampa: caps diários que crescem de ~0.5x a ~1.5x da média, somando exatamente total.
function planoRampa(total, dias) {
  const w = []
  for (let d = 0; d < dias; d++) w.push(0.5 + (dias > 1 ? d / (dias - 1) : 0))
  const sw = w.reduce((a, b) => a + b, 0)
  const plano = w.map((x) => Math.max(1, Math.round((total * x) / sw)))
  let diff = total - plano.reduce((a, b) => a + b, 0)
  let i = plano.length - 1
  while (diff !== 0 && i >= 0) {
    const step = diff > 0 ? 1 : -1
    plano[i] += step
    diff -= step
    i--
    if (i < 0) i = plano.length - 1
  }
  return plano
}

function salvarCampanha() {
  try {
    if (campanha) writeFileSync(CAMPANHA_FILE, JSON.stringify(campanha))
    else if (existsSync(CAMPANHA_FILE)) rmSync(CAMPANHA_FILE, { force: true })
  } catch (e) {
    pushLog(`erro salvando campanha: ${e.message}`)
  }
}

function carregarCampanha() {
  try {
    if (existsSync(CAMPANHA_FILE)) {
      campanha = JSON.parse(readFileSync(CAMPANHA_FILE, 'utf8'))
      pushLog(`Campanha carregada do volume: ${campanha.enviados.length}/${campanha.total} enviados, ${campanha.pendentes.length} pendentes, ${campanha.pausada ? 'PAUSADA' : 'ativa'}.`)
    }
  } catch (e) {
    pushLog(`erro carregando campanha: ${e.message}`)
  }
}

function capHoje() {
  if (!campanha) return 0
  return campanha.plano[Math.min(campanha.diaIndice, campanha.plano.length - 1)]
}

// Worker único: roda pra sempre, idle quando não há o que enviar. Respeita janela,
// teto diário, pausa, e cede a vez pro disparo manual. Persiste a cada envio.
let campanhaRodando = false
async function rodarCampanha() {
  if (campanhaRodando) return
  campanhaRodando = true
  for (;;) {
    try {
      if (!campanha || campanha.pausada || !campanha.pendentes.length) { await sleep(30000); continue }
      if (!state.ready) { await sleep(30000); continue }

      // Virou o dia? avança o índice do plano e zera o teto diário.
      const hoje = dataLocal()
      if (campanha.diaRef !== hoje) {
        if (campanha.diaRef) campanha.diaIndice++
        campanha.diaRef = hoje
        campanha.enviadosHoje = 0
        salvarCampanha()
        pushLog(`Campanha: dia ${Math.min(campanha.diaIndice + 1, campanha.plano.length)}/${campanha.plano.length} (${hoje}), teto de hoje: ${capHoje()}.`)
      }

      if (!janelaAberta()) { await sleep(60000); continue }
      if (campanha.enviadosHoje >= capHoje()) { await sleep(60000); continue } // teto do dia batido
      if (state.disparo.enviando) { await sleep(5000); continue } // cede pro disparo manual

      const n = campanha.pendentes[0]
      try {
        const numberId = await client.getNumberId(n)
        if (!numberId) {
          pushLog(`[campanha] ✗ ${n} — sem WhatsApp, pulando.`)
          campanha.falhas.push(n)
        } else {
          await client.sendMessage(numberId._serialized, campanha.mensagem)
          campanha.enviados.push(n)
          pushLog(`[campanha] ✓ ${n} enviado (${campanha.enviados.length}/${campanha.total}).`)
        }
      } catch (e) {
        pushLog(`[campanha] ✗ ${n} — erro: ${e.message}`)
        campanha.falhas.push(n)
      }
      campanha.pendentes.shift()
      campanha.enviadosHoje++
      salvarCampanha()

      if (!campanha.pendentes.length) {
        pushLog(`Campanha CONCLUÍDA. Enviados: ${campanha.enviados.length} · Falhas: ${campanha.falhas.length}.`)
        continue
      }
      // Freios anti-ban (iguais ao disparo): pausa a cada lote, senão delay aleatório.
      if (campanha.enviadosHoje % LOTE === 0) {
        pushLog(`[campanha] lote de ${LOTE} — pausa de ${PAUSA_LOTE / 1000}s.`)
        await sleep(PAUSA_LOTE)
      } else {
        await sleep(rand(DELAY_MIN, DELAY_MAX))
      }
    } catch (e) {
      pushLog(`[campanha] erro no loop: ${e.message}`)
      await sleep(60000)
    }
  }
}

// O profile do Chromium vive no volume persistente. Se o container morre sem
// fechar o Chromium (deploy/crash), sobra um SingletonLock no profile e o próximo
// container recusa o launch ("profile in use on another computer") → crash loop.
// Limpa esses locks órfãos no boot antes de subir o cliente.
function limparLocksChromium(dir) {
  try {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        limparLocksChromium(full)
      } else if (/^Singleton(Lock|Cookie|Socket)$/.test(entry.name)) {
        try {
          rmSync(full, { force: true })
          pushLog(`lock órfão do Chromium removido: ${full}`)
        } catch {}
      }
    }
  } catch {}
}
limparLocksChromium(WWEB_AUTH)

client.initialize().catch((e) => {
  // Não deixa um erro de launch derrubar o processo sem log claro (Railway reinicia).
  pushLog(`Erro ao inicializar o WhatsApp: ${e?.message}`)
})

// Retoma campanha persistida (se houver) e liga o worker multi-dia.
carregarCampanha()
rodarCampanha()

// ─── Página de QR / status / disparo ──────────────────────────────────────────
const app = express()
app.use(express.json())

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
    disparo: state.disparo,
    janela: { inicio: JANELA_INICIO, fim: JANELA_FIM, tz: JANELA_TZ, aberta: janelaAberta() },
    campanha: campanha
      ? {
          total: campanha.total,
          enviados: campanha.enviados.length,
          pendentes: campanha.pendentes.length,
          falhas: campanha.falhas.length,
          enviadosHoje: campanha.enviadosHoje,
          capHoje: capHoje(),
          dia: Math.min(campanha.diaIndice + 1, campanha.plano.length),
          dias: campanha.plano.length,
          pausada: campanha.pausada,
          plano: campanha.plano,
          concluida: campanha.pendentes.length === 0,
        }
      : null,
    log: state.log.slice(-200),
  })
})

// Programa uma campanha multi-dia (NÃO inicia: nasce PAUSADA pra você revisar
// a contagem limpa e a rampa, e só então clicar Iniciar).
app.post('/api/campanha', (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ erro: 'token inválido' })
  if (campanha && campanha.pendentes.length && !campanha.pausada)
    return res.status(409).json({ erro: 'Já existe campanha ativa. Cancele antes de criar outra.' })

  const { mensagem, texto, dias } = req.body || {}
  if (!mensagem || !mensagem.trim()) return res.status(400).json({ erro: 'Mensagem vazia.' })

  let numeros = String(texto || '')
    .split(/[\n,;]+/)
    .map(normalizar)
    .filter(Boolean)
  const brutos = numeros.length
  numeros = [...new Set(numeros)] // dedup
  if (!numeros.length) return res.status(400).json({ erro: 'Nenhum número válido.' })

  const ndias = Math.max(1, Math.min(60, Number(dias) || 15))
  campanha = {
    mensagem,
    total: numeros.length,
    pendentes: numeros,
    enviados: [],
    falhas: [],
    plano: planoRampa(numeros.length, ndias),
    enviadosHoje: 0,
    diaRef: null,
    diaIndice: 0,
    pausada: true, // nasce pausada — exige Iniciar explícito
    criadaEm: new Date().toISOString(),
  }
  salvarCampanha()
  pushLog(`Campanha PROGRAMADA (pausada): ${numeros.length} únicos de ${brutos} colados, ${ndias} dias. Plano: ${campanha.plano.join(', ')}`)
  res.json({ ok: true, validos: numeros.length, brutos, duplicatas: brutos - numeros.length, dias: ndias, plano: campanha.plano })
})

app.post('/api/campanha/acao', (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ erro: 'token inválido' })
  if (!campanha) return res.status(400).json({ erro: 'Sem campanha.' })
  const { acao } = req.body || {}
  if (acao === 'iniciar' || acao === 'retomar') {
    campanha.pausada = false
    pushLog(`Campanha ${acao === 'iniciar' ? 'INICIADA' : 'retomada'}.`)
  } else if (acao === 'pausar') {
    campanha.pausada = true
    pushLog('Campanha pausada.')
  } else if (acao === 'cancelar') {
    pushLog(`Campanha CANCELADA (${campanha.enviados.length}/${campanha.total} já enviados).`)
    campanha = null
    salvarCampanha()
    return res.json({ ok: true, cancelada: true })
  } else {
    return res.status(400).json({ erro: 'Ação inválida.' })
  }
  salvarCampanha()
  res.json({ ok: true, pausada: campanha.pausada })
})

app.post('/api/enviar', (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ erro: 'token inválido' })
  if (state.disparo.enviando) return res.status(409).json({ erro: 'Já existe um disparo em andamento.' })
  if (!state.ready) return res.status(409).json({ erro: 'WhatsApp não conectado ainda.' })

  const { texto, mensagem, dryRun, soTeste } = req.body || {}
  if (!mensagem || !mensagem.trim()) return res.status(400).json({ erro: 'Mensagem vazia.' })

  let numeros
  if (soTeste) {
    numeros = [NUMERO_TESTE]
  } else {
    numeros = String(texto || '')
      .split(/[\n,;]+/)
      .map(normalizar)
      .filter(Boolean)
    numeros = [...new Set(numeros)] // dedup
  }
  if (!numeros.length) return res.status(400).json({ erro: 'Nenhum número válido.' })

  // Janela de horário só vale pra disparo REAL de lista; teste e dry-run ignoram.
  const respeitarJanela = !dryRun && !soTeste
  disparar({ numeros, mensagem, dryRun: !!dryRun, respeitarJanela }).catch((e) => {
    pushLog(`Erro fatal no disparo: ${e.message}`)
    state.disparo.enviando = false // libera mesmo se algo estourar
    state.disparo.aguardandoJanela = false
  })
  res.json({ iniciado: true, total: numeros.length })
})

app.get('/healthz', (_req, res) => res.json({ ok: true, ready: state.ready }))

app.get('/', (req, res) => {
  if (!autorizado(req)) return res.status(401).send('token inválido — use ?token=SEU_ADMIN_TOKEN')
  res.sendFile(join(__dirname, 'public', 'index.html'))
})
app.use(express.static(join(__dirname, 'public')))

app.listen(PORT, () => pushLog(`Painel/atendente em http://localhost:${PORT}`))
