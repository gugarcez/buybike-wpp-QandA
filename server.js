import express from 'express'
import qrcode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import pkg from 'whatsapp-web.js'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'

import { responderComoClaudia, CLAUDIA_SUPPRESS, RESPOSTA_MOCK } from './claudia.js'
import { extrairPost, mensagemReivindicacao, mensagemPessoal, mensagemBoasVindas, mensagemSemLink, nomeDoVendedor, COPY_HASH } from './prospeccao.js'

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
// Disparo imediato é pra teste/lista pequena. Lista grande DEVE ir pra Campanha
// (rampa multi-dia) — evita blast de 1000 de uma vez num número novo.
const MAX_IMEDIATO = Number(process.env.MAX_IMEDIATO || 50)

// Janela de horário do disparo de LISTA (teste/dry-run ignoram). Fora dela o
// disparo pausa e retoma sozinho quando reabre. Padrão: 9h–18h de Brasília.
const JANELA_INICIO = Number(process.env.JANELA_INICIO || 9)
const JANELA_FIM = Number(process.env.JANELA_FIM || 18)
const JANELA_TZ = process.env.JANELA_TZ || 'America/Sao_Paulo'

// Campanha multi-dia (fila persistente no volume + teto diário com rampa).
const CAMPANHA_FILE = join(WWEB_AUTH, 'campanha.json')
let campanha = null // objeto da campanha em andamento (ou null)

// ─── Config de prospecção (grupo Hub4 → anúncio pré-montado + DM ao vendedor) ──
// Por SEGURANÇA tudo nasce DESLIGADO: feature off e dry-run on por default. Quando
// ligada, identifica o grupo-alvo pelo NOME (regex) — assim funciona em vários
// grupos Hub4 ("HUB4 - Grupo 1", "Grupo 2"…) e em vários números SEM configurar um
// JID por grupo. GRUPO_ALVO_ID continua como override explícito (lista de JIDs).
const GRUPO_ALVO_REGEX_DEFAULT = 'hub\\s*-?\\s*4'
const GRUPO_ALVO_REGEX_SRC = process.env.GRUPO_ALVO_REGEX || GRUPO_ALVO_REGEX_DEFAULT
// Regex vinda do env pode ser inválida e estouraria no import — derrubando o
// processo INTEIRO (inclusive o bot de Q&A). Compila com guarda e cai no default.
let GRUPO_ALVO_REGEX
try {
  GRUPO_ALVO_REGEX = new RegExp(GRUPO_ALVO_REGEX_SRC, 'i')
} catch (e) {
  console.warn(`[prospeccao] GRUPO_ALVO_REGEX inválida ("${GRUPO_ALVO_REGEX_SRC}"): ${e.message}. Usando default.`)
  GRUPO_ALVO_REGEX = new RegExp(GRUPO_ALVO_REGEX_DEFAULT, 'i')
}
const GRUPO_ALVO_ID = process.env.GRUPO_ALVO_ID || '' // override opcional: JID(s) separados por vírgula
const GRUPO_ALVO_IDS = new Set(
  GRUPO_ALVO_ID.split(',').map((s) => s.trim()).filter(Boolean)
)
const PROSPECCAO_ENABLED = process.env.PROSPECCAO_ENABLED === 'true' // default false
const PROSPECCAO_DRY_RUN = process.env.PROSPECCAO_DRY_RUN !== 'false' // default true
// COM www de propósito: buybike.com.br responde 301 pro www, e o fetch do Node
// (spec) REMOVE o header Authorization em redirect cross-origin — o hub4-import
// voltava 403 e o lead morria sem push. Não trocar pro apex.
const BUYBIKE_API_URL = process.env.BUYBIKE_API_URL || 'https://www.buybike.com.br'
const ADMIN_SECRET = process.env.ADMIN_SECRET || '' // bearer pro /api/admin/hub4-import
// Debounce do pareamento: foto(s) + card de texto chegam como msgs separadas, com
// segundos de diferença. Acumula tudo que chega do grupo e processa quando "esfria".
const PROSPECCAO_DEBOUNCE_MS = Number(process.env.PROSPECCAO_DEBOUNCE_MS || 30000)
// Teto de idade do buffer: mesmo com msgs chegando sem parar, um buffer não vive
// além disso — senão o post A poderia colar com o card do post B (fotos/vendedor
// trocados). Ao estourar, o buffer atual é flushado e um novo começa.
const PROSPECCAO_BUFFER_MAX_MS = Number(process.env.PROSPECCAO_BUFFER_MAX_MS || 90000)
const PROSPECCAO_FILE = join(WWEB_AUTH, 'prospeccao.json')
// Modo de contato com o vendedor:
//  'push'  (padrão) → NÃO manda pro vendedor. Cria o rascunho, gera um link wa.me
//          pré-preenchido e AVISA o operador (OPERADOR_NUMERO). O operador toca o
//          link no próprio WhatsApp e envia — envio humano, do número dele.
//  'auto'  (legado) → dispara a DM direto pro vendedor pelo número do bot.
const PROSPECCAO_MODO = process.env.PROSPECCAO_MODO === 'auto' ? 'auto' : 'push'
// Blocklist ESTÁTICA de admins (telefones separados por vírgula). Existe porque o
// store do whatsapp-web.js quebra periodicamente (getChat/getChatById → erro 'r') e
// aí os admins do grupo NUNCA resolvem — com o fail-closed abaixo, todo lead era
// descartado e a prospecção ficava morta. Esta lista é o fallback: quando os admins
// dinâmicos não resolvem, ela assume o papel de guarda (donos da Hub4 nunca viram
// prospect). Só vale como fallback — se o store voltar, o set dinâmico tem prioridade.
const ADMINS_BLOCK = new Set(
  (process.env.ADMINS_BLOCK || '')
    .split(',')
    .map((s) => normalizar(s.trim()))
    .filter(Boolean)
)
// Número pessoal do operador que recebe o push (obrigatório no modo 'push').
// Diferente dos vendedores (BR), o operador pode ter DDI internacional (ex.: +34…),
// então aqui NÃO forçamos 55 — só limpamos os dígitos, preservando o DDI informado.
// Informe SEMPRE com código do país (ex.: 34627201639 para +34 627 201 639).
const OPERADOR_NUMERO =
  String(process.env.OPERADOR_NUMERO || '').replace(/\D/g, '').replace(/^0+/, '') || null
const OPERADOR_NOME = process.env.OPERADOR_NOME || 'Gustavo'

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

// Compara dois números normalizados ignorando o 9º dígito (ambiguidade do BR):
// confere os últimos 8 dígitos, que são iguais com ou sem o 9 na frente.
function mesmoNumero(a, b) {
  if (!a || !b) return false
  return String(a).slice(-8) === String(b).slice(-8)
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

client.on('ready', async () => {
  state.ready = true
  state.qr = null
  state.me = client.info?.wid?.user || '?'
  pushLog(`Conectado como ${state.me} ✓ — atendente ${CLAUDIA_ENABLED ? 'ATIVO' : 'DESLIGADO (CLAUDIA_ENABLED=false)'}`)
  // Sem isto a leitura de nome de grupo fica morta e a detecção só funciona por
  // JID explícito — ver recuperarStore().
  await recuperarStore()
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
    // Ignora: nada que a gente mandou, status/broadcast, newsletters/canais.
    if (msg.fromMe) return
    const from = msg.from || ''
    if (from.endsWith('@broadcast')) return // status@broadcast e listas de transmissão
    if (from.endsWith('@newsletter')) return

    // Grupos: por padrão são ignorados. EXCEÇÃO: se a prospecção está ligada e a msg
    // veio de um grupo-alvo (nome casa GRUPO_ALVO_REGEX OU JID está em GRUPO_ALVO_ID),
    // ela entra no buffer de pareamento (foto[s] + card) daquele grupo.
    if (from.endsWith('@g.us')) {
      if (PROSPECCAO_ENABLED && (await ehGrupoAlvo(msg, from))) {
        await bufferarMsgGrupo(msg, from)
      }
      return // qualquer outro grupo (ou prospecção off) segue ignorado, como hoje
    }
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
// Flag de cancelamento do disparo manual (setada por /api/disparo/parar).
let disparoCancelar = false

// Bloqueia até a janela reabrir, checando a cada minuto. Sai cedo se cancelado.
async function aguardarJanela() {
  let avisou = false
  while (!janelaAberta()) {
    if (disparoCancelar) return
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
  disparoCancelar = false
  state.disparo.enviando = true
  state.disparo.aguardandoJanela = false
  state.disparo.progresso = { total: numeros.length, feitos: 0, ok: 0, falha: 0 }
  pushLog(`${dryRun ? '[DRY-RUN] ' : ''}Disparo iniciado para ${numeros.length} número(s).${respeitarJanela ? ` Janela ${JANELA_INICIO}h–${JANELA_FIM}h ${JANELA_TZ}.` : ''}`)

  for (let i = 0; i < numeros.length; i++) {
    if (disparoCancelar) { pushLog('Disparo CANCELADO.'); break }
    // Respeita a janela de horário (lista real); pausa e retoma sozinho.
    if (respeitarJanela) await aguardarJanela()
    if (disparoCancelar) { pushLog('Disparo CANCELADO.'); break }
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

  pushLog(`Disparo finalizado. OK: ${state.disparo.progresso.ok} · Falha: ${state.disparo.progresso.falha}`)
  state.disparo.enviando = false
  state.disparo.aguardandoJanela = false
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
      // Se ainda não enviou nada, a rampa não começou — zera a contagem de dias pra
      // o dia 1 (teto 35) acontecer no 1º dia que de fato enviar, não num começo à noite.
      if (campanha.enviados.length === 0) {
        campanha.diaRef = null
        campanha.diaIndice = 0
        campanha.enviadosHoje = 0
        salvarCampanha()
      }
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
      if (!janelaAberta()) { await sleep(60000); continue }

      // O dia só vira com a janela ABERTA (= dia de envio real): começar fora da
      // janela (ex.: à noite) NÃO queima um dia da rampa. Avança o índice e zera o teto.
      const hoje = dataLocal()
      if (campanha.diaRef !== hoje) {
        if (campanha.diaRef) campanha.diaIndice++
        campanha.diaRef = hoje
        campanha.enviadosHoje = 0
        salvarCampanha()
        pushLog(`Campanha: dia ${Math.min(campanha.diaIndice + 1, campanha.plano.length)}/${campanha.plano.length} (${hoje}), teto de hoje: ${capHoje()}.`)
      }

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

// ─── Prospecção Hub4 (grupo → anúncio pré-montado + DM ao vendedor) ────────────
// Estado persistente: fila de leads + dedup + histórico. Salvo no volume, mesmo
// padrão do CAMPANHA_FILE.
const prospeccao = {
  fila: [], // leads aguardando criação de anúncio + DM/push
  enviados: [], // { tel, titulo, claimUrl, em } com sucesso (modo auto)
  pushados: [], // { tel, titulo, claimUrl, waLink, em } push enviado ao operador (modo push)
  falhas: [], // { tel, titulo, erro, em }
  jaProcessados: [], // chaves `${tel}|${tituloNorm}` já tratadas (dedup)
}
// Set em memória pra lookup O(1) do dedup; a lista serializada é a fonte da verdade.
let jaProcessadosSet = new Set()

function chaveDedup(tel, titulo) {
  // Normaliza o título (minúsculo, sem espaços extras) pra evitar duplicata por
  // pequena variação de digitação entre repostagens da mesma bike.
  const t = String(titulo || '').toLowerCase().replace(/\s+/g, ' ').trim()
  return `${tel}|${t}`
}

function salvarProspeccao() {
  try {
    prospeccao.jaProcessados = [...jaProcessadosSet]
    writeFileSync(PROSPECCAO_FILE, JSON.stringify(prospeccao))
  } catch (e) {
    pushLog(`erro salvando prospeccao: ${e.message}`)
  }
}

function carregarProspeccao() {
  try {
    if (existsSync(PROSPECCAO_FILE)) {
      const dados = JSON.parse(readFileSync(PROSPECCAO_FILE, 'utf8'))
      prospeccao.fila = dados.fila || []
      prospeccao.enviados = dados.enviados || []
      prospeccao.pushados = dados.pushados || []
      prospeccao.falhas = dados.falhas || []
      prospeccao.jaProcessados = dados.jaProcessados || []
      jaProcessadosSet = new Set(prospeccao.jaProcessados)
      pushLog(`Prospecção carregada do volume: ${prospeccao.fila.length} na fila, ${prospeccao.enviados.length} enviados, ${jaProcessadosSet.size} já processados.`)
    }
  } catch (e) {
    pushLog(`erro carregando prospeccao: ${e.message}`)
  }
}

// Cache da decisão "este grupo é alvo?" por JID (grupos são tagarelas: sem cache
// chamaríamos getChat() a cada msg). jid → boolean. Limpa de boas: o set de grupos
// de um número é pequeno.
const grupoAlvoCache = new Map() // jid → boolean
// Guarda o nome resolvido do grupo (pra repassar ao processamento e logs).
const grupoNomeCache = new Map() // jid → string

// ─── Store cru do WhatsApp Web ────────────────────────────────────────────────
// No build atual (2.3000.1043909971) o whatsapp-web.js NÃO expõe window.Store —
// expõe AuthStore e WWebJS, mas os wrappers (getChat/getChatById/getChats) chamam
// um store inexistente e estouram com 'r'. O require interno do WhatsApp continua
// acessível, então remontamos as coleções que interessam. É isso que devolve a
// leitura de nome de grupo; sem ela, a detecção depende de JID hardcoded.
async function recuperarStore() {
  try {
    const ok = await client.pupPage.evaluate(() => {
      if (window.Store?.Chat) return true
      for (const mod of ['WAWebCollections', 'WAWebChatCollection', 'WAWebMsgCollection']) {
        try {
          const m = window.require(mod)
          window.Store = window.Store || {}
          if (m?.ChatCollection || m?.Chat) window.Store.Chat = m.ChatCollection || m.Chat
          if (m?.MsgCollection || m?.Msg) window.Store.Msg = m.MsgCollection || m.Msg
        } catch {}
      }
      return !!window.Store?.Chat
    })
    pushLog(ok ? '[store] coleções remontadas via require interno ✓' : '[store] não foi possível remontar — detecção de grupo só por GRUPO_ALVO_ID.')
    return ok
  } catch (e) {
    pushLog(`[store] erro remontando: ${e.message}`)
    return false
  }
}

// Nome do grupo pelo store cru — sobrevive à quebra dos wrappers.
async function nomeDoGrupoRaw(jid) {
  try {
    return await client.pupPage.evaluate((id) => {
      const c = window.Store?.Chat?.get(id)
      return c ? c.name || c.formattedTitle || null : null
    }, jid)
  } catch {
    return null
  }
}

async function ehGrupoAlvo(msg, jid) {
  if (grupoAlvoCache.has(jid)) return grupoAlvoCache.get(jid)
  // Override explícito por JID dispensa resolver o chat.
  if (GRUPO_ALVO_IDS.has(jid)) {
    grupoAlvoCache.set(jid, true)
    return true
  }
  // Nome pelo store cru primeiro: é o caminho que funciona no build atual. O
  // wrapper abaixo fica como fallback pra quando o whatsapp-web.js voltar a expor
  // o Store (aí ele também traz os participantes pro blocklist de admins).
  const nomeRaw = await nomeDoGrupoRaw(jid)
  if (nomeRaw) {
    grupoNomeCache.set(jid, nomeRaw)
    const alvo = GRUPO_ALVO_REGEX.test(nomeRaw)
    grupoAlvoCache.set(jid, alvo)
    pushLog(`[prospeccao] grupo "${nomeRaw}" (${jid}) → ${alvo ? 'ALVO' : 'ignorado'}.`)
    return alvo
  }

  try {
    const chat = await msg.getChat()
    const nome = chat?.name || ''
    grupoNomeCache.set(jid, nome)
    const alvo = GRUPO_ALVO_REGEX.test(nome)
    grupoAlvoCache.set(jid, alvo)
    if (alvo) {
      // Aproveita o MESMO chat já buscado pra montar o blocklist de admins do grupo.
      atualizarAdminsGrupo(chat)
      pushLog(`[prospeccao] grupo-alvo identificado por nome: "${nome}" (${jid}).`)
    }
    return alvo
  } catch (e) {
    pushLog(`[prospeccao] erro resolvendo grupo ${jid}: ${e.message}`)
    return false // na dúvida, não trata como alvo
  }
}

// Buffers de pareamento POR GRUPO (jid → { fotosBase64, texto, timer, startedAt }).
// Dois grupos Hub4 diferentes não podem misturar foto/texto, então cada um debounce
// sozinho.
const postBuffers = new Map()

const MEDIA_TENTATIVAS = 3
const MEDIA_ESPERA_MS = 1500

// downloadMedia() devolve `undefined` (sem jogar) quando a mídia ainda está em
// mediaStage FETCHING/REUPLOADING — situação normal nos primeiros segundos depois
// da mensagem chegar. Uma única tentativa lia isso como "quebrado" e o anúncio
// caía na capa do Instagram, que é menor e vem cortada em 1:1.
//
// Espera entre tentativas em vez de martelar: quem resolve a mídia é o próprio
// WhatsApp Web na aba, e o retry imediato só devolve o mesmo estado.
async function baixarMediaComRetry(msg) {
  for (let i = 1; i <= MEDIA_TENTATIVAS; i++) {
    const media = await msg.downloadMedia()
    if (media?.data) return media
    if (i < MEDIA_TENTATIVAS) await new Promise((r) => setTimeout(r, MEDIA_ESPERA_MS))
  }
  return null
}

// Heurística de "card de anúncio": texto que tem PREÇO (R$) E uma sequência de
// telefone (8+ dígitos). Serve de fronteira de commit — um 2º card no mesmo buffer
// significa anúncio novo (não pode colar com o anterior).
function pareceCardDeAnuncio(texto) {
  const t = String(texto || '')
  if (!/R\$/i.test(t)) return false
  return /\d[\d\s().-]{6,}\d/.test(t) // 8+ caracteres de telefone-ish com dígitos nas pontas
}

// Dispara o processamento do buffer atual de um grupo e limpa o estado (timer +
// entrada), pra nada vazar pro próximo post.
function flushBuffer(jid) {
  const buf = postBuffers.get(jid)
  if (!buf) return
  if (buf.timer) clearTimeout(buf.timer)
  postBuffers.delete(jid)
  if (!buf.fotosBase64.length && !buf.texto) return
  const grupoNome = grupoNomeCache.get(jid) || null
  const post = { fotosBase64: buf.fotosBase64, texto: buf.texto, grupoJid: jid, grupoNome, postadoEm: buf.startedAt }
  processarPostGrupo(post).catch((e) => pushLog(`[prospeccao] erro processando post: ${e.message}`))
}

async function bufferarMsgGrupo(msg, jid) {
  try {
    if (msg.type !== 'image' && msg.type !== 'chat') {
      // Antes isto saía sem log nenhum: se um card chegasse num tipo inesperado
      // (vídeo com legenda, documento), ele sumia e não havia como saber.
      pushLog(`[prospeccao] msg de grupo ${jid} — tipo "${msg.type}" não tratado, ignorado.`)
      return
    }

    // Identidade do grupo SEM depender do store (getChat() quebra com erro 'r'): loga
    // o autor da msg. No Hub4 quem posta é sempre o admin, então o autor identifica o
    // grupo — é assim que se descobre qual JID pôr em GRUPO_ALVO_ID.
    pushLog(`[prospeccao] msg de grupo ${jid} — autor ${normalizar((msg.author || '').replace(/@.*/, '')) || '?'} (${msg.type}).`)

    const agora = Date.now()
    let buf = postBuffers.get(jid)

    // Teto de idade: se o buffer já existe e está velho demais, flusha ANTES de
    // misturar — evita estender pra sempre e colar dois posts distintos.
    if (buf && agora - buf.startedAt >= PROSPECCAO_BUFFER_MAX_MS) {
      pushLog(`[prospeccao] buffer do grupo ${jid} estourou idade máxima — flush antes de iniciar novo.`)
      flushBuffer(jid)
      buf = null
    }

    // Fronteira por card: se um card de anúncio chega e o buffer JÁ tem um card,
    // são dois anúncios empilhados — flusha o atual e começa um novo com esta msg.
    // O card pode vir como mensagem de texto OU como legenda da foto. Ler só
    // `body` de `chat` perdia todo anúncio postado com legenda — e a perda era
    // silenciosa, porque a imagem era bufferada normalmente.
    const corpo = msg.type === 'chat'
      ? (msg.body || '').trim()
      : (msg.caption || '').trim()
    // Vale pra card em texto E em legenda: com anúncios em rajada, é esta fronteira
    // que impede o card novo de sobrescrever o anterior e apagá-lo do buffer.
    if (
      buf &&
      pareceCardDeAnuncio(corpo) &&
      pareceCardDeAnuncio(buf.texto)
    ) {
      pushLog(`[prospeccao] 2º card de anúncio no grupo ${jid} — flush do anterior e novo buffer.`)
      flushBuffer(jid)
      buf = null
    }

    if (!buf) {
      buf = { fotosBase64: [], texto: '', timer: null, startedAt: agora }
      postBuffers.set(jid, buf)
    }

    if (msg.type === 'image') {
      // Esta é a foto QUE IMPORTA: o arquivo original que o vendedor mandou no
      // grupo (1600×1200 típico). O fallback do Instagram só entrega 720×1280 já
      // cortado, então cada falha aqui vira um anúncio com capa pior.
      //
      // Vale retry: logo após o `message_create` a mídia costuma estar em
      // mediaStage FETCHING, e o downloadMedia devolve undefined sem jogar — o
      // que antes era lido como "quebrado" e caía direto no IG.
      //
      // Isolado num try próprio pra não abortar o buffer: o card de texto, que é
      // o que realmente importa, chega em outra mensagem e precisa ser bufferado.
      try {
        const media = await baixarMediaComRetry(msg)
        // media.data é base64 cru (sem prefixo data:…;base64,) — vai direto pra API.
        if (media?.data) {
          buf.fotosBase64.push(media.data)
          const kb = Math.round((media.data.length * 3) / 4 / 1024)
          pushLog(`[prospeccao] foto recebida do grupo ${jid} (${buf.fotosBase64.length} no buffer, ~${kb}KB).`)
        } else {
          pushLog(`[prospeccao] foto do grupo ${jid} não resolveu após ${MEDIA_TENTATIVAS} tentativas — usará a capa do Instagram.`)
        }
      } catch (e) {
        pushLog(`[prospeccao] foto do WhatsApp indisponível (${e.message}) — usará a capa do Instagram.`)
      }
      if (corpo) {
        buf.texto = corpo
        pushLog(`[prospeccao] card veio na LEGENDA da foto (${jid}): "${corpo.slice(0, 50)}"`)
      }
    } else if (corpo) {
      buf.texto = corpo // card de texto mais recente vence
      pushLog(`[prospeccao] card de texto recebido (${jid}): "${corpo.slice(0, 50)}"`)
    }

    // Debounce: reinicia o timer a cada msg pra agrupar foto(s) + card que chegam juntos.
    if (buf.timer) clearTimeout(buf.timer)
    buf.timer = setTimeout(() => flushBuffer(jid), PROSPECCAO_DEBOUNCE_MS)
  } catch (e) {
    pushLog(`[prospeccao] erro no buffer: ${e.message}`)
  }
}

// Blocklist de admins POR GRUPO (jid → Set de telefones normalizados). Donos da
// Hub4 NUNCA podem receber DM, então o store é por grupo (com 2 grupos, um global
// sobrescreveria o outro e checaria a lista errada). Resolve os participantes de
// fato — se chat.participants vier vazio, NÃO sobrescreve um set bom já conhecido.
const adminsPorGrupo = new Map() // jid → Set<tel>
async function atualizarAdminsGrupo(chat) {
  try {
    const jid = chat?.id?._serialized
    if (!jid) return
    // Garante que os participantes estão carregados (às vezes vêm vazios do cache).
    let participantes = chat.participants || []
    if (!participantes.length && typeof chat.fetchParticipants === 'function') {
      try {
        await chat.fetchParticipants()
        participantes = chat.participants || []
      } catch {}
    }
    // Ainda vazio: NÃO sobrescreve um set bom anterior (evita "esvaziar" a blocklist
    // e deixar um admin passar). O grupo fica UNRESOLVED até a próxima tentativa.
    if (!participantes.length) {
      if (!adminsPorGrupo.has(jid)) {
        pushLog(`[prospeccao] participantes do grupo ${jid} não carregaram — admins não resolvidos.`)
      }
      return
    }
    const novos = new Set()
    for (const p of participantes) {
      if (p.isAdmin || p.isSuperAdmin) {
        const tel = normalizar(p.id?._serialized?.replace(/@.*/, ''))
        if (tel) novos.add(tel)
      }
    }
    adminsPorGrupo.set(jid, novos)
  } catch (e) {
    pushLog(`[prospeccao] erro lendo admins do grupo: ${e.message}`)
  }
}

// Processa um post pareado: extrai os campos, aplica os gates de segurança e (se
// passar) enfileira o lead pro worker — ou, em dry-run, só loga o que faria.
async function processarPostGrupo(post) {
  if (!post.texto) {
    pushLog('[prospeccao] post sem card de texto — ignorado.')
    // Fotos sem card é exatamente o sintoma do bug da legenda. Se voltar, quero
    // saber pelo WhatsApp e não por alguém reclamando dias depois.
    if (post.fotosBase64?.length) {
      await avisarPulado({ titulo: '(fotos sem card)', preco: null, motivo: 'chegaram fotos mas nenhum texto de anúncio — verificar' })
    }
    return
  }

  const dados = await extrairPost({ texto: post.texto })
  const { ehAnuncioBike, telefone, titulo } = dados
  if (!ehAnuncioBike) {
    const primeiraLinha = post.texto.split('\n')[0].replace(/\*/g, '').trim().slice(0, 60)
    pushLog(`[prospeccao] não é anúncio de bike — ignorado: "${post.texto.slice(0, 40)}"`)
    // Só avisa se parecer um anúncio (tem preço): conversa solta do grupo não vira
    // notificação, senão o aviso vira ruído e perde a função de sinal de vida.
    if (/💵|R\$/.test(post.texto)) {
      await avisarPulado({ titulo: primeiraLinha, preco: null, motivo: 'não é bike (acessório, roda, gear)' })
    }
    return
  }
  if (!telefone) {
    pushLog(`[prospeccao] anúncio "${titulo}" sem telefone de contato — ignorado.`)
    await avisarPulado({ titulo, preco: dados.preco, motivo: 'sem telefone no card (só @ ou nada)' })
    return
  }

  const tel = normalizar(telefone)
  if (!tel) {
    pushLog(`[prospeccao] telefone inválido ("${telefone}") — ignorado.`)
    return
  }

  // Atualiza o blocklist de admins DESTE grupo ANTES de checar (donos da Hub4 não
  // são prospects). Rebusca o chat pra pegar admins atuais.
  if (post.grupoJid) {
    try { await atualizarAdminsGrupo(await client.getChatById(post.grupoJid)) } catch {}
  }
  // Blocklist efetiva: o set dinâmico do grupo tem prioridade; se ele não resolveu
  // (store do whatsapp-web.js quebrado), cai na lista estática ADMINS_BLOCK.
  const adminsDinamicos = post.grupoJid ? adminsPorGrupo.get(post.grupoJid) : null
  const dinamicoOk = adminsDinamicos && adminsDinamicos.size > 0
  const adminsDoGrupo = dinamicoOk ? adminsDinamicos : ADMINS_BLOCK
  // FAIL-CLOSED: sem NENHUMA fonte de admins (dinâmica quebrada E ADMINS_BLOCK vazia)
  // pulamos por segurança — jamais arriscar contato com um admin Hub4.
  if (adminsDoGrupo.size === 0) {
    pushLog(`[prospecção] admins não resolvidos e ADMINS_BLOCK vazia — pulando por segurança: ${tel}`)
    // Este gate mata TODO lead enquanto durar. Sem aviso, a operação inteira para
    // e parece só "não teve anúncio hoje".
    await avisarPulado({ titulo, preco: dados.preco, motivo: 'ADMINS_BLOCK vazia — configure pra destravar os leads' })
    return
  }
  if (!dinamicoOk) {
    pushLog(`[prospeccao] admins do grupo não resolvidos — usando ADMINS_BLOCK estática (${adminsDoGrupo.size} nº).`)
  }
  if (adminsDoGrupo.has(tel)) {
    pushLog(`[prospeccao] contato ${tel} é admin do grupo (Hub4) — pulando.`)
    await avisarPulado({ titulo, preco: dados.preco, motivo: 'bike da própria Hub4 (contato é o admin)' })
    return
  }
  // Guard do próprio número do bot: compara os últimos 8 dígitos de cada número
  // normalizado, pra ser robusto à ambiguidade do 9º dígito no BR (nunca DM a si).
  const meuNumero = normalizar(state.me)
  if (meuNumero && mesmoNumero(meuNumero, tel)) {
    pushLog('[prospeccao] contato é o próprio número do bot — pulando.')
    return
  }
  const chave = chaveDedup(tel, titulo)
  if (jaProcessadosSet.has(chave)) {
    pushLog(`[prospeccao] "${titulo}" de ${tel} já processado — pulando (dedup).`)
    return
  }

  // Payload da API de criação (ver contrato em /api/admin/hub4-import).
  const payload = {
    titulo: titulo || '',
    preco: dados.preco ?? null,
    categoria: dados.categoria || 'estrada',
    marca: dados.marca || null,
    modelo: dados.modelo || null,
    ano: dados.ano ?? null,
    tamanho: dados.tamanho || null,
    condicao: dados.condicao || null,
    descricao: dados.descricao || '',
    transmissao_grupo: dados.transmissao_grupo || null,
    cidade: dados.cidade || '',
    original_phone: tel,
    original_vendedor: nomeDoVendedor(dados),
    fotosBase64: post.fotosBase64 || [],
    // O card cru vai junto pro app conseguir achar o link do post no IG e usar a
    // capa de lá — o downloadMedia daqui quebrou com o store do whatsapp-web.js.
    texto: post.texto || null,
    // Data do post no GRUPO, que é diferente de quando o rascunho é criado — é ela
    // que diz se o lead está quente. Sem isso o painel só saberia a data do import.
    origem_postado_em: post.postadoEm ? new Date(post.postadoEm).toISOString() : null,
    // O @ vai junto: a central usa como canal alternativo ao WhatsApp.
    instagram: dados.instagram || null,
  }

  if (PROSPECCAO_DRY_RUN) {
    const claimUrl = `${BUYBIKE_API_URL}/claim/<uuid-dry-run>`
    if (PROSPECCAO_MODO === 'push') {
      const dm = mensagemPessoal({ vendedorNome: nomeDoVendedor(dados), titulo, preco: dados.preco, claimUrl, operador: OPERADOR_NOME })
      const waLink = `https://wa.me/${tel}?text=${encodeURIComponent(dm)}`
      const alvo = OPERADOR_NUMERO ? `${OPERADOR_NOME} (${OPERADOR_NUMERO})` : 'OPERADOR — ⚠️ OPERADOR_NUMERO não setado'
      const igTxt = dados.instagram ? ` + IG @${dados.instagram} (instagram.com/${dados.instagram})` : ''
      pushLog(`[DRY-RUN/push] criaria anúncio (${payload.fotosBase64.length} foto[s]) + avisaria ${alvo} com link: ${waLink}${igTxt}`)
    } else {
      const dm = mensagemReivindicacao({ vendedorNome: nomeDoVendedor(dados), titulo, preco: dados.preco, claimUrl })
      pushLog(`[DRY-RUN/auto] criaria anúncio (${payload.fotosBase64.length} foto[s]) + mandaria DM pra ${tel}: ${dm}`)
    }
    // Marca no dedup pra o dry-run não logar o mesmo post a cada debounce.
    jaProcessadosSet.add(chave)
    salvarProspeccao()
    return
  }

  // Real: enfileira o lead; o worker faz a chamada de API + push com throttle.
  prospeccao.fila.push({ tel, titulo, vendedorNome: nomeDoVendedor(dados), preco: dados.preco, instagram: dados.instagram || null, payload })
  salvarProspeccao()
  pushLog(`[prospeccao] lead enfileirado: ${titulo} → ${tel} (fila: ${prospeccao.fila.length}).`)
}

// Monta o texto do push pro operador (usado pelo worker e pelo endpoint de teste).
// Retorna { push, waLink }. Com teste=true, marca como teste e avisa que o rascunho
// é placeholder — pra não reencaminhar pro vendedor sem querer.
// O WhatsApp para de linkar uma URL longa no meio dela: um wa.me com ?text=
// grande chega quebrado no push e o operador não consegue tocar. Encurtar
// resolve — o app tem /l/<code> justamente pra isso. Best-effort: se falhar,
// devolve a URL longa (melhor um link feio que push nenhum).
async function encurtar(url) {
  try {
    const resp = await fetch(`${BUYBIKE_API_URL}/api/admin/encurtar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({ url }),
    })
    if (!resp.ok) return url
    const { short } = await resp.json()
    return short || url
  } catch {
    return url
  }
}

// Resolve o número do operador e entrega a mensagem. Três lugares faziam isso
// (push do lead, aviso de pulado, push de teste), cada um com um tratamento de erro
// diferente — o do worker estourava, o do teste devolvia 400, o do aviso engolia.
// Uma porta só: quem chama decide o que fazer com a falha.
async function enviarAoOperador(texto) {
  if (!OPERADOR_NUMERO) throw new Error('OPERADOR_NUMERO não configurado (modo push)')
  const opId = await client.getNumberId(OPERADOR_NUMERO)
  if (!opId) throw new Error(`OPERADOR_NUMERO sem WhatsApp: ${OPERADOR_NUMERO}`)
  await client.sendMessage(opId._serialized, texto)
}

// Avisa o operador de um anúncio que NÃO virou lead, com o motivo. Existe porque
// silêncio e "bot quebrado" são indistinguíveis do lado de quem espera: passamos 3
// dias sem push (todos os anúncios eram da própria Hub4) e a leitura foi de que o
// bot tinha parado. Vai SEM wa.me de propósito — não é pra abordar ninguém.
async function avisarPulado({ titulo, preco, motivo }) {
  if (!OPERADOR_NUMERO || PROSPECCAO_DRY_RUN) return
  try {
    const precoTxt = Number(preco) > 0 ? ` — R$ ${Math.round(preco).toLocaleString('pt-BR')}` : ''
    const texto = [
      `👀 Anúncio no Hub4 que NÃO virou lead`,
      '',
      `*${titulo || 'Bike'}*${precoTxt}`,
      `Motivo: ${motivo}`,
      '',
      'Nada a fazer — é só pra você saber que o bot está vivo e vendo o grupo.',
    ].join('\n')
    await enviarAoOperador(texto)
    pushLog(`[prospeccao] aviso de pulado enviado ao operador: ${titulo} (${motivo}).`)
  } catch (e) {
    pushLog(`[prospeccao] falha ao avisar pulado: ${e.message}`)
  }
}

async function montarPushProspeccao({ tel, titulo, vendedorNome, preco, instagram, claimUrl, semFoto = false, teste = false }) {
  // Sem foto no rascunho, a mensagem não pode prometer anúncio pronto — vai a
  // variante que pede as fotos e omite o preço (mesma regra da tela do admin).
  const dm = semFoto
    ? mensagemBoasVindas({ vendedorNome, titulo, claimUrl, operador: OPERADOR_NOME })
    : mensagemPessoal({ vendedorNome, titulo, preco, claimUrl, operador: OPERADOR_NOME })
  const waLinkLongo = `https://wa.me/${tel}?text=${encodeURIComponent(dm)}`
  const waLink = await encurtar(waLinkLongo)
  const igLink = instagram ? `https://instagram.com/${instagram}` : null
  const precoTxt = Number(preco) > 0 ? ` — R$ ${Math.round(preco).toLocaleString('pt-BR')}` : ''
  const linhas = [
    `${teste ? '🧪 TESTE — ' : ''}🚲 Novo anúncio no Hub4 — pronto pra você enviar`,
    '',
    `*${titulo || 'Bike'}*${precoTxt}`,
    `Vendedor: ${vendedorNome || tel}${instagram ? ` (@${instagram})` : ''}`,
    '',
    `Rascunho na Buybike: ${claimUrl}`,
    '',
    '📱 WhatsApp — toque pra abrir o chat com a msg pronta (é só enviar):',
    waLink,
  ]
  if (igLink) linhas.push('', `📸 Instagram — abra o perfil e cole a mensagem: ${igLink}`)
  // As duas próximas mensagens são as opções de texto. O rótulo mora AQUI porque
  // qualquer palavra dentro delas seria copiada junto ao segurar pra copiar.
  linhas.push(
    '',
    '👇 As 2 próximas mensagens são as opções de texto:',
    '  1ª — com o link do rascunho (mais direta)',
    '  2ª — SEM link, termina em pergunta (mais segura em contato frio)'
  )
  if (teste) linhas.push('', '⚠️ Teste: o link do rascunho é placeholder — NÃO reencaminhe pro vendedor.')
  // A mensagem do vendedor NÃO vai aqui dentro: quando ela vinha junto, segurar pra
  // copiar levava o push inteiro (cabeçalho, links, aviso) e o operador tinha que
  // limpar na mão. Vai como mensagem separada, aí "copiar" pega só ela.
  const dmSemLink = mensagemSemLink({ vendedorNome, titulo, preco, operador: OPERADOR_NOME })
  return { push: linhas.join('\n'), dm, dmSemLink, waLink }
}

// Worker único da prospecção (espelha rodarCampanha): roda pra sempre, idle 30s
// quando a fila esvazia, respeita ready/janela e cede a vez pro disparo manual.
let prospeccaoRodando = false
async function rodarProspeccao() {
  if (prospeccaoRodando) return
  prospeccaoRodando = true
  for (;;) {
    try {
      if (!PROSPECCAO_ENABLED || PROSPECCAO_DRY_RUN || !prospeccao.fila.length) { await sleep(30000); continue }
      if (!state.ready) { await sleep(30000); continue }
      // A janela 9h-18h é freio anti-ban pra mensagem a VENDEDOR (modo auto). No
      // modo push a única mensagem vai pro celular do próprio operador, que pediu
      // pra ser avisado — segurar o aviso dele até as 9h só atrasa o trabalho.
      if (PROSPECCAO_MODO !== 'push' && !janelaAberta()) { await sleep(60000); continue }
      if (state.disparo.enviando) { await sleep(5000); continue } // cede pro disparo manual

      const lead = prospeccao.fila[0]
      const { tel, titulo, vendedorNome, preco, instagram, payload } = lead
      try {
        // 1) Cria o anúncio pré-montado no app (envia as fotos como base64).
        // Timeout de 20s: sem ele, uma request pendurada travaria o worker único
        // pra sempre. No estouro, AbortError cai no catch e o lead conta como falha.
        const ctrl = new AbortController()
        const timeoutId = setTimeout(() => ctrl.abort(), 20000)
        let resp
        try {
          resp = await fetch(`${BUYBIKE_API_URL}/api/admin/hub4-import`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${ADMIN_SECRET}`,
            },
            body: JSON.stringify(payload),
            signal: ctrl.signal,
          })
        } finally {
          clearTimeout(timeoutId)
        }
        if (!resp.ok) {
          let detalhe = `HTTP ${resp.status}`
          try { detalhe = (await resp.json())?.error || detalhe } catch {}
          throw new Error(`API hub4-import: ${detalhe}`)
        }
        const { claim_url: claimUrl, already_existed: jaExistia } = await resp.json()

        // Dedup cross-número: se OUTRO número/instância (ou rodada anterior) já criou
        // o anúncio E já mandou a DM, não manda de novo. Só registra no dedup local.
        if (jaExistia === true) {
          pushLog(`[prospecção] já existia, pulando DM (outro número já tratou): ${titulo}`)
          jaProcessadosSet.add(chaveDedup(tel, titulo))
          prospeccao.fila.shift()
          salvarProspeccao()
          continue
        }

        if (!claimUrl) throw new Error('API não retornou claim_url')

        if (PROSPECCAO_MODO === 'push') {
          // 2) MODO PUSH (padrão): NÃO manda pro vendedor. Gera o link wa.me
          // pré-preenchido (mensagem na voz do operador) e avisa o OPERADOR no
          // WhatsApp dele. Ele toca o link → abre o chat com o vendedor com a msg
          // pronta → ELE envia. Envio humano, do número dele — sem disparo automático.
          const { push, dm, dmSemLink, waLink } = await montarPushProspeccao({ tel, titulo, vendedorNome, preco, instagram, claimUrl, semFoto: !payload?.fotosBase64?.length })
          await enviarAoOperador(push)
          // Separadas: segurar e copiar pega só o texto, sem cabeçalho nem rótulo.
          await enviarAoOperador(dm)
          await enviarAoOperador(dmSemLink)
          jaProcessadosSet.add(chaveDedup(tel, titulo))
          prospeccao.pushados.push({ tel, titulo, claimUrl, waLink, instagram: instagram || null, em: new Date().toISOString() })
          pushLog(`[prospeccao] ✓ PUSH pro operador — ${titulo} → ${tel} (você toca pra enviar).`)
        } else {
          // 2) MODO AUTO (legado): dispara a DM direto pro vendedor pelo número do bot.
          const dm = mensagemReivindicacao({ vendedorNome, titulo, preco, claimUrl })
          const numberId = await client.getNumberId(tel)
          if (!numberId) {
            pushLog(`[prospeccao] ✗ ${tel} — sem WhatsApp, pulando.`)
            prospeccao.falhas.push({ tel, titulo, erro: 'sem WhatsApp', em: new Date().toISOString() })
          } else {
            await client.sendMessage(numberId._serialized, dm)
            jaProcessadosSet.add(chaveDedup(tel, titulo))
            prospeccao.enviados.push({ tel, titulo, claimUrl, em: new Date().toISOString() })
            pushLog(`[prospeccao] ✓ DM enviada pra ${tel} (${titulo}).`)
          }
        }
      } catch (e) {
        pushLog(`[prospeccao] ✗ ${tel} — erro: ${e.message}`)
        prospeccao.falhas.push({ tel, titulo, erro: e.message, em: new Date().toISOString() })
        // Lead que chegou até aqui e morreu é o pior caso: o anúncio era válido e
        // ninguém fica sabendo. O aviso vai por um caminho diferente do push (que
        // acabou de falhar), então pode falhar também — daí o catch vazio.
        avisarPulado({ titulo, preco, motivo: `FALHA ao processar: ${e.message}` }).catch(() => {})
      }
      prospeccao.fila.shift()
      salvarProspeccao()

      // Freios anti-ban. No modo push só avisamos o operador (1 chat), então basta
      // um respiro curto. No modo auto (envio ao vendedor), mantém os freios da campanha.
      if (!prospeccao.fila.length) continue
      if (PROSPECCAO_MODO === 'push') {
        await sleep(2000)
      } else if (prospeccao.enviados.length % LOTE === 0) {
        pushLog(`[prospeccao] lote de ${LOTE} — pausa de ${PAUSA_LOTE / 1000}s.`)
        await sleep(PAUSA_LOTE)
      } else {
        await sleep(rand(DELAY_MIN, DELAY_MAX))
      }
    } catch (e) {
      pushLog(`[prospeccao] erro no loop: ${e.message}`)
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

// Retoma a prospecção persistida (fila + dedup) e liga o worker de DM.
carregarProspeccao()
rodarProspeccao().catch((e) => pushLog('[prospecção] worker morreu: ' + e.message))

// ─── Página de QR / status / disparo ──────────────────────────────────────────
const app = express()
// 25mb: o /api/prospeccao/processar recebe fotos em base64 (que infla ~33%), e o
// default de 100kb do express derrubava anúncio com foto grande (413).
app.use(express.json({ limit: '25mb' }))

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
    prospeccao: {
      enabled: PROSPECCAO_ENABLED,
      dryRun: PROSPECCAO_DRY_RUN,
      // Modo de matching do grupo-alvo: por NOME (regex) + override opcional por JID.
      grupoMatch: { regex: GRUPO_ALVO_REGEX_SRC, jids: [...GRUPO_ALVO_IDS] },
      gruposAlvoAtivos: [...grupoAlvoCache.entries()].filter(([, v]) => v).map(([jid]) => jid),
      modo: PROSPECCAO_MODO,
      adminsBlockEstatica: ADMINS_BLOCK.size,
      fila: prospeccao.fila.length,
      enviados: prospeccao.enviados.length, // modo auto (desligado) — fica sempre 0
      // O que importa no modo push. Sem isto o painel mostrava "0 enviados" mesmo
      // depois de dezenas de pushes, porque lia o contador do modo errado.
      pushados: prospeccao.pushados.length,
      ultimosPushes: prospeccao.pushados.slice(-12).map((p) => ({ titulo: p.titulo, tel: p.tel, em: p.em })),
      falhas: prospeccao.falhas.length,
      jaProcessados: jaProcessadosSet.size,
    },
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

  // Trava anti-blast: lista grande em envio REAL → manda usar a Campanha.
  if (!soTeste && !dryRun && numeros.length > MAX_IMEDIATO) {
    return res.status(400).json({
      erro: `Lista grande (${numeros.length}). O disparo imediato é só pra teste/até ${MAX_IMEDIATO} números. Pra essa lista use a Campanha (vários dias), que faz a rampa com segurança.`,
    })
  }

  // Janela de horário só vale pra disparo REAL de lista; teste e dry-run ignoram.
  const respeitarJanela = !dryRun && !soTeste
  disparar({ numeros, mensagem, dryRun: !!dryRun, respeitarJanela }).catch((e) => {
    pushLog(`Erro fatal no disparo: ${e.message}`)
    state.disparo.enviando = false // libera mesmo se algo estourar
    state.disparo.aguardandoJanela = false
  })
  res.json({ iniciado: true, total: numeros.length })
})

app.post('/api/disparo/parar', (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ erro: 'token inválido' })
  if (!state.disparo.enviando) return res.status(400).json({ erro: 'Nenhum disparo em andamento.' })
  disparoCancelar = true
  pushLog('Pedido de PARAR disparo recebido.')
  res.json({ ok: true })
})

// ─── Prospecção: descoberta de grupos + teste de extração ──────────────────────
// Lista os grupos do WhatsApp pra você descobrir o GRUPO_ALVO_ID.
app.get('/api/grupos', async (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ erro: 'token inválido' })
  if (!state.ready) return res.status(409).json({ erro: 'WhatsApp não conectado ainda.' })
  try {
    // Pelo store cru: client.getChats() estoura com 'r' no build atual do
    // WhatsApp Web (ver recuperarStore()).
    if (!(await recuperarStore())) return res.status(503).json({ erro: 'Store indisponível — não dá pra listar grupos.' })
    const grupos = await client.pupPage.evaluate(() =>
      window.Store.Chat.getModelsArray()
        .filter((c) => String(c.id?._serialized || c.id).endsWith('@g.us'))
        .map((c) => ({ id: String(c.id?._serialized || c.id), name: c.name || c.formattedTitle || null }))
    )
    res.json({ grupos })
  } catch (e) {
    res.status(500).json({ erro: e.message })
  }
})

// Valida a extração de um card de texto SEM criar anúncio nem mandar DM.
app.post('/api/prospeccao/testar', async (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ erro: 'token inválido' })
  const { texto } = req.body || {}
  if (!texto || !texto.trim()) return res.status(400).json({ erro: 'Texto vazio.' })
  try {
    const dados = await extrairPost({ texto })
    // Preview tem que mostrar a mensagem que REALMENTE vai sair: no modo push é a
    // do operador (mensagemPessoal). Antes mostrava sempre a da Cláudia (modo auto,
    // desligado), então a ferramenta de teste mentia sobre o texto enviado.
    const montar = PROSPECCAO_MODO === 'push' ? mensagemPessoal : mensagemReivindicacao
    const dm = dados.ehAnuncioBike
      ? montar({
          vendedorNome: nomeDoVendedor(dados),
          titulo: dados.titulo,
          preco: dados.preco,
          claimUrl: `${BUYBIKE_API_URL}/claim/<uuid-placeholder>`,
          operador: OPERADOR_NOME,
        })
      : null
    res.json({ dados, dm, modo: PROSPECCAO_MODO })
  } catch (e) {
    res.status(500).json({ erro: e.message })
  }
})

// Manda um PUSH DE TESTE pro operador (você), pra validar o fluxo sem tocar em
// vendedor nem criar rascunho. Usa o texto enviado ou, se vazio, um anúncio-exemplo.
// O claim_url é placeholder e o push vem marcado como TESTE.
app.post('/api/prospeccao/test-push', async (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ erro: 'token inválido' })
  if (!state.ready) return res.status(409).json({ erro: 'WhatsApp não conectado ainda.' })
  if (!OPERADOR_NUMERO) return res.status(400).json({ erro: 'OPERADOR_NUMERO não configurado.' })
  const EXEMPLO = [
    'Canyon Ultimate CF SLX XS', '💵 R$35.000,00', '-Tamanho: XS', '-Ano: 2025',
    '-SRAM Force AXS 12v', '-Contato: @giovanasuppioni (11)97068-9917',
    'Anúncio completo: https://www.instagram.com/p/DbNw11lEbAo/',
  ].join('\n')
  const texto = (req.body?.texto || '').trim() || EXEMPLO
  try {
    const dados = await extrairPost({ texto })
    if (!dados.ehAnuncioBike) return res.status(400).json({ erro: 'Não reconhecido como anúncio de bike.', dados })
    const tel = normalizar(dados.telefone)
    if (!tel && !dados.instagram) return res.status(400).json({ erro: 'Anúncio sem telefone nem @ de contato.', dados })
    const { push, dm, dmSemLink } = await montarPushProspeccao({
      tel, titulo: dados.titulo, vendedorNome: nomeDoVendedor(dados), preco: dados.preco,
      instagram: dados.instagram, claimUrl: `${BUYBIKE_API_URL}/claim/TESTE`, teste: true,
    })
    await enviarAoOperador(push)
    await enviarAoOperador(dm)
    await enviarAoOperador(dmSemLink)
    pushLog(`[prospeccao] push de TESTE enviado pro operador (${OPERADOR_NUMERO}).`)
    res.json({ ok: true, enviadoPara: OPERADOR_NUMERO, dados })
  } catch (e) {
    res.status(500).json({ erro: e.message })
  }
})

// Injeta um post NO FLUXO REAL (cria rascunho via hub4-import + push pro operador),
// como se tivesse chegado do grupo. Serve pra reprocessar um anúncio que o bot não
// presenciou. Respeita TODOS os gates (admins, dedup, dry-run) — não é atalho.
app.post('/api/prospeccao/processar', async (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ erro: 'token inválido' })
  if (!state.ready) return res.status(409).json({ erro: 'WhatsApp não conectado ainda.' })
  const { texto, fotosBase64, grupoJid } = req.body || {}
  if (!texto || !texto.trim()) return res.status(400).json({ erro: 'texto obrigatório.' })
  try {
    await processarPostGrupo({
      texto: texto.trim(),
      fotosBase64: Array.isArray(fotosBase64) ? fotosBase64 : [],
      grupoJid: grupoJid || null,
      grupoNome: null,
    })
    res.json({ ok: true, fila: prospeccao.fila.length, nota: 'Enfileirado; o worker cria o rascunho e manda o push. Acompanhe em /api/status.' })
  } catch (e) {
    res.status(500).json({ erro: e.message })
  }
})

// Último recurso: fala com o Store CRU da página, por baixo dos wrappers do
// whatsapp-web.js (que quebram com erro 'r'). Read-only — só lista chats e lê
// mensagens já carregadas na memória da página. Se isto também falhar, não há
// caminho remoto pro histórico e o texto tem que vir por fora.
app.get('/api/prospeccao/raw', async (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ erro: 'token inválido' })
  if (!state.ready) return res.status(409).json({ erro: 'WhatsApp não conectado ainda.' })
  const jid = String(req.query.jid || '').trim() || null
  try {
    const temStore = await recuperarStore()
    if (!temStore) return res.json({ temStore: false, grupos: [], mensagens: [] })
    const out = await client.pupPage.evaluate((alvo) => {
      const r = { temStore: true, grupos: [], mensagens: [], erros: [] }
      try {
        r.grupos = window.Store.Chat.getModelsArray()
          .filter((c) => String(c.id?._serialized || c.id).endsWith('@g.us'))
          .map((c) => ({ id: String(c.id?._serialized || c.id), nome: c.name || c.formattedTitle || null }))
      } catch (e) { r.erros.push('Chat: ' + e.message) }
      // Só a janela que a página já carregou: o modelo do chat deste build não
      // expõe loadEarlierMsgs, então não há histórico retroativo por aqui.
      if (alvo) {
        try {
          r.mensagens = window.Store.Msg.getModelsArray()
            .filter((m) => String(m.id?.remote?._serialized || m.id?.remote || '') === alvo)
            .map((m) => ({
              em: new Date((m.t || 0) * 1000).toISOString(),
              autor: String(m.author?._serialized || m.author || m.from?._serialized || ''),
              tipo: m.type,
              // caption separado do body: em imagem o body é o thumbnail base64 e
              // esconderia a legenda, que é justamente onde o card pode estar.
              caption: String(m.caption || '').slice(0, 400),
              corpo: String(m.body || '').slice(0, 400),
            }))
        } catch (e) { r.erros.push('Msg: ' + e.message) }
      }
      return r
    }, jid)
    res.json(out)
  } catch (e) {
    res.status(500).json({ erro: e.message })
  }
})

// Saúde SEM token. Só flags operacionais — nenhum telefone, nome ou conteúdo de
// mensagem passa por aqui. Existe assim de propósito: o watchdog roda na Vercel e
// depender de um segredo lá cria uma dependência humana (alguém com permissão pra
// criar env var de produção) justamente no monitor que deveria ser autônomo.
app.get('/healthz', (_req, res) =>
  res.json({
    ok: true,
    ready: state.ready,
    qrPendente: !!state.qr,
    prospeccaoAtiva: PROSPECCAO_ENABLED,
    modo: PROSPECCAO_MODO,
    gruposAlvo: GRUPO_ALVO_IDS.size,
    adminsBlock: ADMINS_BLOCK.size,
    fila: prospeccao.fila.length,
    pushados: prospeccao.pushados.length,
    // Impressão digital da copy: o watchdog compara com a do app e avisa se as
    // duas cópias divergirem — o push sairia diferente do que a tela mostra.
    copyHash: COPY_HASH,
  })
)

app.get('/', (req, res) => {
  if (!autorizado(req)) return res.status(401).send('token inválido — use ?token=SEU_ADMIN_TOKEN')
  res.sendFile(join(__dirname, 'public', 'index.html'))
})
app.use(express.static(join(__dirname, 'public')))

app.listen(PORT, () => pushLog(`Painel/atendente em http://localhost:${PORT}`))
