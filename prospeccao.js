// Prospecção Hub4: extrai anúncios de bike postados no grupo do WhatsApp e monta
// a DM personalizada de "reivindique seu anúncio" pro vendedor.
//
// Mesma estrutura de claudia.js: chama @anthropic-ai/sdk direto (Haiku), sem DB.
// A extração é JSON-only; em mock (sem ANTHROPIC_API_KEY) cai num fallback regex.

import Anthropic from '@anthropic-ai/sdk'

const CLAUDE_HAIKU = 'claude-haiku-4-5-20251001'

function isMockClaude() {
  const key = process.env.ANTHROPIC_API_KEY
  return !key || key.startsWith('mock')
}

let _client
function getClaude() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

// Categorias aceitas pela API do app (slug). A IA infere pelo texto.
const CATEGORIAS = ['estrada', 'montanha', 'gravel', 'urbana', 'ebike', 'vintage']

const SYSTEM_EXTRACT = `Você extrai dados estruturados de um anúncio de bicicleta seminova postado num grupo de WhatsApp de vendedores. Responda SOMENTE com um objeto JSON válido, sem texto fora dele, sem markdown, sem crases.

Campos do JSON:
- ehAnuncioBike (boolean): true se o texto é claramente um anúncio de venda de bicicleta (tem características da bike + preço/contato). false se for conversa, saudação, regra do grupo, ou qualquer coisa que NÃO seja um anúncio de bike à venda.
- titulo (string): título curto do anúncio (ex.: "Swift Racevox 51"). Use a primeira linha relevante.
- preco (number): preço em reais, SÓ o número, sem milhar nem símbolo (ex.: 31000 para R$31.000,00). null se não houver.
- marca (string|null): marca da bike (ex.: "Swift", "Specialized", "Trek").
- modelo (string|null): modelo (ex.: "Racevox").
- ano (number|null): ano da bike, se citado.
- tamanho (string|null): tamanho/quadro (ex.: "51", "M", "56").
- categoria (string): uma de [${CATEGORIAS.join(', ')}]. Infira pelo texto: speed/road/estrada→estrada; mtb/montanha→montanha; gravel→gravel; urbana/passeio→urbana; elétrica/ebike→ebike; antiga/retrô→vintage. Default "estrada" se for clara bike de velocidade.
- transmissao_grupo (string|null): slug do grupo de transmissão se citado (ex.: "shimano-ultegra-di2", "sram-rival"). minúsculo, com hífens.
- condicao (string|null): condição (ex.: "semi-nova", "nova").
- descricao (string): versão limpa das specs/bullets numa frase ou lista curta separada por vírgulas (ex.: "Shimano Ultegra Di2, 600km rodados, full carbon, NF Brasil"). Sem o contato e sem o link.
- cidade (string|null): cidade, se citada.
- vendedorNome (string|null): nome do contato (ex.: "André").
- telefone (string|null): telefone do "Contato" (ex.: "(24)99854-0606"). Mantenha como veio.
- instagram (string|null): @ do Instagram do contato, se aparecer na linha de contato (ex.: "@360bypmancini"). Com ou sem @, sem espaços. NÃO confunda com o link de "Anúncio completo" (esse é o post no IG — ignore). null se não houver.

Se NÃO for um anúncio de bike à venda, retorne {"ehAnuncioBike": false}.`

// Tira cercas de código/markdown e extrai o primeiro objeto JSON do texto.
function parseJSON(raw = '') {
  let s = String(raw).trim()
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const ini = s.indexOf('{')
  const fim = s.lastIndexOf('}')
  if (ini !== -1 && fim !== -1 && fim > ini) s = s.slice(ini, fim + 1)
  return JSON.parse(s)
}

// Fallback regex pra modo mock (sem IA): detecta telefone, preço e título.
function extrairMock(texto = '') {
  const linhas = texto.split(/\n/).map((l) => l.trim()).filter(Boolean)
  const titulo = linhas[0] || ''

  const mPreco = texto.match(/R\$\s*([\d.]+)/i)
  const preco = mPreco ? Number(mPreco[1].replace(/\./g, '')) || null : null

  const mTel = texto.match(/\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4}/)
  const telefone = mTel ? mTel[0] : null

  const mContato = texto.match(/contato:?\s*([A-Za-zÀ-ÿ]+)/i)
  const vendedorNome = mContato ? mContato[1] : null

  // @handle do IG (ignora o "Anúncio completo" que é URL, não @).
  const mIg = texto.match(/@([A-Za-z0-9._]{2,})/)
  const instagram = mIg ? mIg[1] : null

  const ehAnuncioBike = !!(telefone && preco)
  if (!ehAnuncioBike) return { ehAnuncioBike: false }

  return {
    ehAnuncioBike: true,
    titulo,
    preco,
    marca: null,
    modelo: null,
    ano: null,
    tamanho: null,
    categoria: 'estrada',
    transmissao_grupo: null,
    condicao: null,
    descricao: titulo,
    cidade: null,
    vendedorNome,
    telefone,
    instagram,
  }
}

// Extrai os campos do card de texto. Retorna { ehAnuncioBike: false } se não for anúncio.
export async function extrairPost({ texto }) {
  const t = (texto || '').trim()
  if (!t) return { ehAnuncioBike: false }

  if (isMockClaude()) {
    console.log('[prospeccao:mock] extraindo →', t.slice(0, 60))
    return extrairMock(t)
  }

  try {
    const client = getClaude()
    const response = await client.messages.create({
      model: CLAUDE_HAIKU,
      max_tokens: 500,
      temperature: 0,
      system: SYSTEM_EXTRACT,
      messages: [{ role: 'user', content: `Texto do anúncio:\n"""\n${t}\n"""` }],
    })
    const out = response.content.find((c) => c.type === 'text')?.text?.trim()
    if (!out) return { ehAnuncioBike: false }
    const dados = parseJSON(out)
    if (!dados || !dados.ehAnuncioBike) return { ehAnuncioBike: false }
    // Normaliza categoria pra um slug válido (a IA às vezes inventa).
    if (!CATEGORIAS.includes(dados.categoria)) dados.categoria = 'estrada'
    // Normaliza o @ do IG: sem @, minúsculo, só o handle.
    if (dados.instagram) dados.instagram = String(dados.instagram).replace(/^@+/, '').trim().toLowerCase() || null
    return dados
  } catch (err) {
    console.error('[prospeccao] erro na extração:', err?.message)
    // Não estoura o worker: trata como "não é anúncio" e segue.
    return { ehAnuncioBike: false }
  }
}

// Formata preço em reais no padrão BR sem centavos (ex.: 31000 → "R$ 31.000").
function formatarPreco(preco) {
  const n = Number(preco)
  if (!Number.isFinite(n) || n <= 0) return null
  return 'R$ ' + Math.round(n).toLocaleString('pt-BR')
}

// Hash estável de uma string → inteiro. Usado pra escolher o template de forma
// determinística por vendedor (mesmo lead sempre recebe a mesma DM, mesmo em
// reenvio), variando entre leads.
function hashStr(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

// DM curta, calorosa e PERSONALIZADA (texto puro, no máx 1 emoji), na voz da
// Cláudia (ver buildSystem em claudia.js). Cita a bike + preço, diz que o anúncio
// JÁ está montado na Buybike e que basta reivindicar com o número, manda o link,
// e reforça 100% grátis / sem comissão.
//
// 4 variações em rotação determinística por vendedor: além de soar menos robótico,
// reduz o padrão repetido de mensagem (ajuda a não cair em filtro de spam).
export function mensagemReivindicacao({ vendedorNome, titulo, preco, claimUrl }) {
  const primeiroNome = (vendedorNome || '').trim().split(/\s+/)[0]
  const saudacao = primeiroNome ? `Oi ${primeiroNome}!` : 'Oi!'
  const precoFmt = formatarPreco(preco)
  const tituloTxt = titulo || 'sua bike'
  const bikeDe = titulo ? `da ${titulo}` : 'da sua bike'
  const comPreco = precoFmt ? ` (${precoFmt})` : ''

  const templates = [
    // 0 — apresentação (padrão)
    `${saudacao} 👋 Aqui é a Cláudia, da Buybike. Vi seu anúncio ${bikeDe}${comPreco} ` +
      `no grupo da Hub4 e já deixei ele montado pra você na Buybike. ` +
      `Pra publicar é só reivindicar com o seu número aqui: ${claimUrl} — ` +
      `leva uns 30s, 100% grátis e sem comissão. Depois você ajusta fotos e preço do jeito que quiser.`,
    // A — benefício direto
    `${saudacao} Sua ${tituloTxt} já está montada na Buybike` +
      `${precoFmt ? ` — fotos, specs e os ${precoFmt} prontinhos` : ' com fotos e specs prontas'}. ` +
      `Pra ela ir ao ar é só você reivindicar com o seu número: ${claimUrl} 🚲 ` +
      `É de graça, sem comissão, e depois você edita o que quiser.`,
    // B — gancho de pergunta
    `${saudacao} Tudo bem? Essa ${tituloTxt}${comPreco} é sua, né? ` +
      `Montei o anúncio dela aqui na Buybike e separei pra você. ` +
      `Confirma que é sua e assume em 30s: ${claimUrl} — 100% grátis, sem taxa nenhuma.`,
    // C — alcance/vitrine
    `${saudacao} Coloquei sua ${tituloTxt} na vitrine da Buybike pra ela aparecer ` +
      `pra compradores de bike premium do Brasil inteiro. ` +
      `Só falta você reivindicar com o seu número pra publicar: ${claimUrl} 🚴 ` +
      `Sem custo e sem comissão — o contato vem direto pra você.`,
  ]

  const idx = hashStr(`${vendedorNome || ''}|${titulo || ''}`) % templates.length
  return templates[idx]
}

// Mensagem PESSOAL (voz do operador, ex.: Gustavo) que vai PRÉ-PREENCHIDA no link
// wa.me do push. Quem envia é o operador, tocando o link no próprio WhatsApp — não
// há disparo automático pro vendedor. Honesta: o rascunho REALMENTE já foi montado
// (chamada hub4-import) antes desta mensagem ser gerada.
export function mensagemPessoal({ vendedorNome, titulo, preco, claimUrl, operador = 'Gustavo' }) {
  const primeiroNome = (vendedorNome || '').trim().split(/\s+/)[0]
  const saudacao = primeiroNome ? `Oi ${primeiroNome}!` : 'Oi!'
  const precoFmt = formatarPreco(preco)
  const tituloTxt = titulo || 'sua bike'
  const comPreco = precoFmt ? ` (${precoFmt})` : ''
  return (
    // DRIFT: cópia de mensagemProspeccao() em lib/hub4-extract.js (o app). Mudou
    // uma, mude a outra — senão o push de anúncio novo (bot) sai com um texto e a
    // tela /marketing/prospeccao com outro. Enxuta de propósito: o WhatsApp corta
    // a prévia em ~300 chars, e o link precisa aparecer antes do "Ler mais".
    `${saudacao} Vi sua ${tituloTxt}${comPreco} no Hub4. Sou o ${operador}, da Buybike.com.br — ` +
    `te convido a anunciar ela no nosso site também. Já montei o rascunho: grátis, sem comissão, ` +
    `e o comprador fala direto com você. Só revisar e publicar: ${claimUrl}`
  )
}
