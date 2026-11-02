require('dotenv').config()

const express = require('express')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const hljs = require('highlight.js')
const MarkdownIt = require('markdown-it')

const app = express()
const PUBLIC_DIR = path.join(__dirname, 'public')
const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const MAX_GENERATION_ATTEMPTS = 1_000
const LANGUAGE_SAMPLE_SIZE = 64 * 1024
const CUSTOM_ID_MAX_LENGTH = 80
const RESERVED_IDS = new Set(['api', 'auth', 'assets', '404.html'])
const EXTENSIONS = {
	bash: 'sh',
	c: 'c',
	cpp: 'cpp',
	csharp: 'cs',
	css: 'css',
	dockerfile: 'Dockerfile',
	go: 'go',
	html: 'html',
	ini: 'ini',
	java: 'java',
	javascript: 'js',
	json: 'json',
	kotlin: 'kt',
	markdown: 'md',
	php: 'php',
	powershell: 'ps1',
	python: 'py',
	ruby: 'rb',
	rust: 'rs',
	scss: 'scss',
	shell: 'sh',
	sql: 'sql',
	toml: 'toml',
	typescript: 'ts',
	xml: 'xml',
	yaml: 'yaml'
}
const CODE_LANGUAGES = Object.keys(EXTENSIONS).filter(language => language !== 'markdown' && hljs.getLanguage(language))

function readConfig() {
	const port = Number.parseInt(process.env.PORT || '7250', 10)
	const baseUrl = parseUrl(process.env.BASE_URL?.trim())
	const apiToken = process.env.API_TOKEN?.trim()
	const codeLength = Number.parseInt(process.env.PASTE_CODE_LENGTH || '3', 10)
	const maxSize = Number.parseInt(process.env.PASTE_MAX_SIZE || '1048576', 10)
	const highlightMaxSize = Number.parseInt(process.env.HIGHLIGHT_MAX_SIZE || '262144', 10)
	const dataDir = path.resolve(__dirname, process.env.DATA_DIR || './data')

	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('PORT must be a valid TCP port')
	}

	if (!baseUrl || (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:')) {
		throw new Error('BASE_URL must be a valid http(s) URL')
	}

	if (!apiToken) {
		throw new Error('API_TOKEN is required')
	}

	if (!Number.isInteger(codeLength) || codeLength < 1 || codeLength > 16) {
		throw new Error('PASTE_CODE_LENGTH must be an integer from 1 to 16')
	}

	if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > 50 * 1024 * 1024) {
		throw new Error('PASTE_MAX_SIZE must be an integer from 1 to 52428800')
	}

	if (!Number.isInteger(highlightMaxSize) || highlightMaxSize < 0 || highlightMaxSize > maxSize) {
		throw new Error('HIGHLIGHT_MAX_SIZE must be an integer from 0 to PASTE_MAX_SIZE')
	}

	return { port, baseUrl: baseUrl.href.replace(/\/$/, ''), apiToken, codeLength, maxSize, highlightMaxSize, dataDir }
}

function parseUrl(value) {
	try {
		return new URL(value)
	} catch {
		return null
	}
}

const CONFIG = readConfig()
const INDEX_FILE = path.join(CONFIG.dataDir, 'index.json')
const PASTES_DIR = path.join(CONFIG.dataDir, 'pastes')

function sha256(value) {
	return crypto.createHash('sha256').update(value).digest()
}

const API_TOKEN_HASH = sha256(CONFIG.apiToken)

function escapeHtml(value) {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const markdown = new MarkdownIt({
	linkify: true,
	highlight(code, language) {
		const key = language.trim().toLowerCase()
		const html = hljs.getLanguage(key) ? hljs.highlight(code, { language: key, ignoreIllegals: true }).value : escapeHtml(code)
		return `<pre><code>${html}</code></pre>`
	}
})

const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')

function renderIndex(title, description, url) {
	const values = { TITLE: title, DESCRIPTION: description, URL: url, BASE_URL: CONFIG.baseUrl }
	return INDEX_HTML.replace(/%(TITLE|DESCRIPTION|URL|BASE_URL)%/g, (_match, key) => escapeHtml(values[key]))
}

fs.mkdirSync(PASTES_DIR, { recursive: true })

function load() {
	if (!fs.existsSync(INDEX_FILE)) {
		return []
	}

	const data = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'))
	if (!Array.isArray(data)) {
		throw new Error('index.json must contain an array')
	}

	return data
}

function save(data) {
	const tempFile = `${INDEX_FILE}.tmp`
	fs.writeFileSync(tempFile, `${JSON.stringify(data, null, 2)}\n`)
	fs.renameSync(tempFile, INDEX_FILE)
}

function readContent(entry) {
	return fs.readFileSync(path.join(PASTES_DIR, entry.file), 'utf8')
}

function genUniqueId(data) {
	const usedIds = new Set(data.map(item => item.id))

	for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
		let id = ''
		for (let i = 0; i < CONFIG.codeLength; i++) {
			id += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
		}

		if (!usedIds.has(id) && !RESERVED_IDS.has(id)) {
			return id
		}
	}

	throw new Error('Unable to generate a unique paste id')
}

function normalizeId(value) {
	if (typeof value !== 'string') {
		return null
	}

	const id = value
		.trim()
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9_.-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/\.{2,}/g, '.')
		.slice(0, CUSTOM_ID_MAX_LENGTH)
		.replace(/^[-_.]+|[-_.]+$/g, '')

	return id && !RESERVED_IDS.has(id) ? id : null
}

function detectLanguage(content) {
	const sample = content.slice(0, LANGUAGE_SAMPLE_SIZE)
	if (isLikelyMarkdown(sample)) {
		return { language: 'Markdown', languageKey: 'markdown' }
	}

	const result = hljs.highlightAuto(sample, CODE_LANGUAGES)
	if (!result.language || result.relevance < 2) {
		return { language: 'Plain text', languageKey: 'plaintext' }
	}

	return { language: hljs.getLanguage(result.language).name, languageKey: result.language }
}

function isLikelyMarkdown(sample) {
	let score = 0
	if (/(^|\n)\s*```[\w-]*\s*\n[\s\S]*?\n\s*```\s*(\n|$)/.test(sample)) score += 3
	if (/^#{1,6}\s+\S/m.test(sample)) score += 2
	if (/^\s{0,3}[-*+]\s+\S/m.test(sample)) score += 1
	if (/^\s{0,3}\d+\.\s+\S/m.test(sample)) score += 1
	if (/^\s{0,3}>\s+\S/m.test(sample)) score += 1
	if (/\[[^\]\n]+\]\((https?:\/\/|\/|\.\/|\.\.\/|#)[^)\s]+\)/.test(sample)) score += 2
	if (/^\s*\|.+\|\s*$/m.test(sample) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(sample)) score += 2
	if (/^\s{0,3}[-*]\s+\[[ xX]\]\s+\S/m.test(sample)) score += 2
	if (/(^|\s)(\*\*|__)[^\n]+(\*\*|__)(\s|[.,;:!?)]|$)/.test(sample)) score += 1

	return score >= 3
}

function renderContent(entry, content) {
	if (entry.size > CONFIG.highlightMaxSize) {
		return null
	}
	if (entry.languageKey === 'markdown') {
		return markdown.render(content)
	}
	if (hljs.getLanguage(entry.languageKey)) {
		return hljs.highlight(content, { language: entry.languageKey, ignoreIllegals: true }).value
	}

	return null
}

function formatBytes(value) {
	if (value < 1024) {
		return `${value} B`
	}
	if (value < 1024 * 1024) {
		return `${(value / 1024).toFixed(1)} KB`
	}

	return `${(value / (1024 * 1024)).toFixed(2)} MB`
}

function filename(entry) {
	return /\.[a-z0-9]{1,12}$/i.test(entry.id) ? entry.id : `${entry.id}.${EXTENSIONS[entry.languageKey] || 'txt'}`
}

function pasteJson(entry, content) {
	return {
		id: entry.id,
		url: `${CONFIG.baseUrl}/${encodeURIComponent(entry.id)}`,
		rawUrl: `${CONFIG.baseUrl}/${encodeURIComponent(entry.id)}/raw`,
		language: entry.language,
		languageKey: entry.languageKey,
		size: entry.size,
		views: entry.views,
		createdAt: entry.createdAt,
		content,
		html: renderContent(entry, content)
	}
}

function requireAuth(req, res, next) {
	const [scheme, token, extra] = (req.get('authorization') || '').trim().split(/\s+/)
	if (scheme.toLowerCase() !== 'bearer' || !token || extra || !crypto.timingSafeEqual(sha256(token), API_TOKEN_HASH)) {
		return res.status(401).json({ error: 'Unauthorized' })
	}

	next()
}

function findPaste(req, res, next) {
	req.data = load()
	req.entry = req.data.find(item => item.id === req.params.id)
	if (!req.entry) {
		return res.status(404).json({ error: 'Paste not found' })
	}

	next()
}

app.disable('x-powered-by')
app.use(express.json({ limit: CONFIG.maxSize * 2 }))
app.use(express.static(PUBLIC_DIR, { index: false }))

app.post('/auth/verify', requireAuth, (_req, res) => {
	res.json({ ok: true })
})

app.post('/api/pastes', requireAuth, (req, res) => {
	const content = req.body?.content
	if (typeof content !== 'string' || !content.trim()) {
		return res.status(400).json({ error: 'Paste is empty' })
	}

	const size = Buffer.byteLength(content)
	if (size > CONFIG.maxSize) {
		return res.status(413).json({ error: `Paste must be ${formatBytes(CONFIG.maxSize)} or less` })
	}

	const data = load()
	const entry = { id: genUniqueId(data), file: `${crypto.randomUUID()}.txt`, ...detectLanguage(content), size, views: 0 }
	entry.createdAt = new Date().toISOString()

	fs.writeFileSync(path.join(PASTES_DIR, entry.file), content)
	data.push(entry)
	save(data)

	res.status(201).json(pasteJson(entry, content))
})

app.get('/api/pastes/:id', findPaste, (req, res) => {
	const content = readContent(req.entry)
	req.entry.views += 1
	save(req.data)

	res.json(pasteJson(req.entry, content))
})

app.patch('/api/pastes/:id', requireAuth, findPaste, (req, res) => {
	const id = normalizeId(req.body?.id)
	if (!id) {
		return res.status(400).json({ error: 'Use letters, numbers, dots, dashes or underscores' })
	}
	if (id !== req.entry.id && req.data.some(item => item.id === id)) {
		return res.status(409).json({ error: 'This name is taken' })
	}

	const languageKey = Object.keys(EXTENSIONS).find(key => id.endsWith(`.${EXTENSIONS[key].toLowerCase()}`))
	if (languageKey && hljs.getLanguage(languageKey)) {
		req.entry.languageKey = languageKey
		req.entry.language = hljs.getLanguage(languageKey).name
	}

	req.entry.id = id
	save(req.data)

	res.json(pasteJson(req.entry, readContent(req.entry)))
})

app.delete('/api/pastes/:id', requireAuth, findPaste, (req, res) => {
	req.data.splice(req.data.indexOf(req.entry), 1)
	save(req.data)
	fs.rmSync(path.join(PASTES_DIR, req.entry.file), { force: true })

	res.json({ id: req.entry.id })
})

app.get('/', (_req, res) => {
	res.type('html').send(renderIndex('Seki', 'Private paste service', `${CONFIG.baseUrl}/`))
})

app.get('/:id', (req, res) => {
	const entry = load().find(item => item.id === req.params.id)
	if (!entry) {
		return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'))
	}

	const url = `${CONFIG.baseUrl}/${encodeURIComponent(entry.id)}`
	res.type('html').send(renderIndex(`${entry.id} - Seki`, `${entry.language} · ${formatBytes(entry.size)}`, url))
})

app.get('/:id/raw', (req, res) => {
	const data = load()
	const entry = data.find(item => item.id === req.params.id)
	if (!entry) {
		return res.status(404).type('text').send('Paste not found')
	}

	entry.views += 1
	save(data)

	const name = filename(entry)
	res.sendFile(path.join(PASTES_DIR, entry.file), {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Content-Disposition': `inline; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
			'Cache-Control': 'no-store'
		}
	})
})

app.use((err, req, res, _next) => {
	console.error(err)

	const error = err.expose ? err.message : 'Something went wrong'
	res.status(err.status || 500)
	if (req.method === 'GET' && !req.path.startsWith('/api/')) {
		return res.type('text').send(error)
	}

	res.json({ error })
})

app.listen(CONFIG.port, () => {
	console.log(`Server is running on http://localhost:${CONFIG.port}`)
})
