// index.js — Anti-Plagiat (Fastify + EJS + Upload + Extraction + Similarité)
process.on('unhandledRejection', (e) => {
  console.error('unhandledRejection', e);
});
process.on('uncaughtException', (e) => {
  console.error('uncaughtException', e);
  process.exit(1);
});

const path = require('path');
const Fastify = require('fastify');

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const unzipper = require('unzipper');

const app = Fastify({ logger: true });

// ---- Plugins ----
app.register(require('@fastify/cors'), { origin: true });
app.register(require('@fastify/multipart'), {
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});
app.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
  prefix: '/public/',
});
app.register(require('@fastify/view'), {
  engine: { ejs: require('ejs') },
  root: path.join(__dirname, 'views'),
  viewExt: 'ejs',
});

// ---- Helpers ----
function normalizeText(s) {
  s = String(s || '');
  return s
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ \u00A0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function tokenize(s) {
  return (
    normalizeText(s)
      .toLowerCase()
      .match(/[a-zàâçéèêëîïôûùüÿñœ0-9]+/gi) || []
  );
}
function countWords(s) {
  return tokenize(s).length;
}
function shingles(tokens, n) {
  const o = [];
  for (let i = 0; i <= tokens.length - n; i++)
    o.push(tokens.slice(i, i + n).join(' '));
  return o;
}
function similarityPlaceholder(text) {
  const toks = tokenize(text);
  if (toks.length < 12)
    return {
      score: 0,
      method: 'jaccard-3gram (interne)',
      detail: 'texte trop court',
    };
  const sh = shingles(toks, 3);
  const freq = new Map();
  let dup = 0;
  for (const g of sh) {
    const c = (freq.get(g) || 0) + 1;
    freq.set(g, c);
    if (c >= 2) dup++;
  }
  const pct = Math.round(Math.min(1, dup / (sh.length || 1)) * 100);
  return {
    score: pct,
    method: 'jaccard-3gram (interne)',
    detail: `${dup}/${sh.length} shingles répétés`,
  };
}
async function extractOdt(buffer) {
  const dir = await unzipper.Open.buffer(buffer);
  const file = dir.files.find((f) => f.path === 'content.xml');
  if (!file) return '';
  const xml = (await file.buffer()).toString('utf8');
  const text = xml
    .replace(/<text:line-break\/>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  return normalizeText(text);
}
async function extractText(buffer, ext) {
  ext = String(ext || '').toLowerCase();
  if (ext === 'pdf') {
    const { text } = await pdfParse(buffer);
    return { text: normalizeText(text), note: 'pdf-parse' };
  }
  if (ext === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer });
    return { text: normalizeText(value), note: 'mammoth (DOCX)' };
  }
  if (ext === 'odt') {
    const txt = await extractOdt(buffer);
    return { text: txt, note: 'unzipper (ODT)' };
  }
  if (ext === 'txt') {
    return { text: normalizeText(buffer.toString('utf8')), note: 'texte brut' };
  }
  return { text: '', note: `extension non gérée: .${ext}` };
}

// ---- Routes pages ----
app.get('/', (req, reply) =>
  reply.view('index', { title: 'Anti-Plagiat', active: 'home' })
);
app.get('/upload', (req, reply) =>
  reply.view('index', { title: 'Téléverser', active: 'upload', page: 'upload' })
);
app.get('/televerser', (req, reply) =>
  reply.view('index', { title: 'Téléverser', active: 'upload', page: 'upload' })
);
app.get('/services', (req, reply) =>
  reply.view('index', {
    title: 'Services',
    active: 'services',
    page: 'services',
  })
);
app.get('/a-propos', (req, reply) =>
  reply.view('index', {
    title: 'Qui sommes-nous',
    active: 'about',
    page: 'about',
  })
);
app.get('/contact', (req, reply) =>
  reply.view('index', { title: 'Contact', active: 'contact', page: 'contact' })
);

// ---- API upload ----
app.post('/upload', async (req, reply) => {
  try {
    const part = await req.file();
    if (!part)
      return reply.code(400).send({ ok: false, error: 'Aucun fichier reçu' });
    const filename = part.filename || '';
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const mime = (part.mimetype || '').toLowerCase();
    const ALLOWED_EXT = new Set(['pdf', 'docx', 'odt', 'txt']);
    const ALLOWED_MIME = new Set([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.oasis.opendocument.text',
      'text/plain',
      'application/octet-stream',
    ]);
    if (
      !ALLOWED_EXT.has(ext) ||
      (mime && !ALLOWED_MIME.has(mime) && mime !== '')
    ) {
      return reply
        .code(415)
        .send({
          ok: false,
          error: 'Type de fichier non pris en charge',
          filename,
          mimetype: mime,
        });
    }
    const buf = await part.toBuffer();
    const { text, note } = await extractText(buf, ext);
    return reply.send({
      ok: true,
      filename,
      mimetype: mime,
      size: buf.length,
      wordCount: countWords(text),
      note,
      similarity: similarityPlaceholder(text),
      snippet: text.slice(0, 600),
    });
  } catch (err) {
    app.log.error(err);
    return reply
      .code(500)
      .send({ ok: false, error: 'Erreur serveur lors de l’analyse.' });
  }
});

// ---- Démarrage (retry sur 3001/3002 si 3000 pris) ----
const isServerless = !!process.env.VERCEL;
const DEFAULT_PORT = Number(process.env.PORT) || 3000;
async function listenWithRetry(port, retries = 4) {
  try {
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`listening on ${port}`);
  } catch (e) {
    if (e.code === 'EADDRINUSE' && retries > 0) {
      app.log.warn(`Port ${port} occupé, essai sur ${port + 1}...`);
      return listenWithRetry(port + 1, retries - 1);
    }
    app.log.error(e);
    process.exit(1);
  }
}
if (isServerless) {
  module.exports = app;
} else {
  listenWithRetry(DEFAULT_PORT);
}
