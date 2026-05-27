require('dotenv').config()

const express = require('express')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const hljs = require('highlight.js')
const MarkdownIt = require('markdown-it')

const app = express()
const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const MAX_GENERATION_ATTEMPTS = 1_000
const LANGUAGE_SAMPLE_SIZE = 64 * 1024
const CUSTOM_ID_MAX_LENGTH = 80
const RESERVED_IDS = new Set(['api', 'auth', 'assets', 'raw', 'favicon.ico', 'robots.txt'])
const LANGUAGE_CANDIDATES = [
	'javascript',
	'typescript',
	'json',
	'html',
	'xml',
	'css',
	'scss',
	'bash',
	'shell',
	'powershell',
	'python',
	'go',
	'rust',
	'java',
	'kotlin',
	'c',
	'cpp',
	'csharp',
	'php',
	'ruby',
	'sql',
	'yaml',
	'toml',
	'ini',
	'markdown',
	'dockerfile'
].filter(language => hljs.getLanguage(language))
const CODE_LANGUAGE_CANDIDATES = LANGUAGE_CANDIDATES.filter(language => language !== 'markdown')

const markdown = new MarkdownIt({
	html: false,
	linkify: true,
	typographer: false,
	highlight(code, language) {
		const languageKey = language?.trim().toLowerCase()
		if (languageKey && hljs.getLanguage(languageKey)) {
			return `<pre class="markdown-code"><code class="language-${escapeAttribute(languageKey)}">${
				hljs.highlight(code, {
					language: languageKey,
					ignoreIllegals: true
				}).value
			}</code></pre>`
		}

		return `<pre class="markdown-code"><code>${escapeHtml(code)}</code></pre>`
	}
})

function readConfig() {
	const port = Number.parseInt(process.env.PORT || '7250', 10)
	const baseUrl = normalizeBaseUrl(process.env.BASE_URL || `http://localhost:${port}`)
	const apiToken = process.env.API_TOKEN?.trim()
	const pasteCodeLength = Number.parseInt(process.env.PASTE_CODE_LENGTH || '3', 10)
	const pasteMaxSize = Number.parseInt(process.env.PASTE_MAX_SIZE || '1048576', 10)
	const highlightMaxSize = Number.parseInt(process.env.HIGHLIGHT_MAX_SIZE || '262144', 10)
	const dataDir = resolveDataDir(process.env.DATA_DIR || './data')

	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('PORT must be a valid TCP port')
	}

	if (!baseUrl) {
		throw new Error('BASE_URL must be a valid http(s) URL')
	}

	if (!apiToken) {
		throw new Error('API_TOKEN is required')
	}

	if (!Number.isInteger(pasteCodeLength) || pasteCodeLength < 1 || pasteCodeLength > 16) {
		throw new Error('PASTE_CODE_LENGTH must be an integer from 1 to 16')
	}

	if (!Number.isInteger(pasteMaxSize) || pasteMaxSize < 1 || pasteMaxSize > 50 * 1024 * 1024) {
		throw new Error('PASTE_MAX_SIZE must be an integer from 1 to 52428800')
	}

	if (!Number.isInteger(highlightMaxSize) || highlightMaxSize < 0 || highlightMaxSize > pasteMaxSize) {
		throw new Error('HIGHLIGHT_MAX_SIZE must be an integer from 0 to PASTE_MAX_SIZE')
	}

	return { port, baseUrl, apiToken, pasteCodeLength, pasteMaxSize, highlightMaxSize, dataDir }
}

function normalizeBaseUrl(value) {
	if (typeof value !== 'string') {
		return null
	}

	try {
		const url = new URL(value.trim())
		if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
			return null
		}

		return url.href.replace(/\/$/, '')
	} catch {
		return null
	}
}

function resolveDataDir(value) {
	return path.resolve(__dirname, value)
}

const CONFIG = readConfig()
const INDEX_FILE = path.join(CONFIG.dataDir, 'index.json')
const PASTES_DIR = path.join(CONFIG.dataDir, 'pastes')

function ensureStorage() {
	fs.mkdirSync(PASTES_DIR, { recursive: true })

	if (!fs.existsSync(INDEX_FILE)) {
		saveIndex([])
	}
}

function loadIndex() {
	ensureStorage()

	const rawData = fs.readFileSync(INDEX_FILE, 'utf8')
	const data = JSON.parse(rawData || '[]')
	if (!Array.isArray(data)) {
		throw new Error('data/index.json must contain an array')
	}

	let changed = false
	for (const entry of data) {
		if (entry?.id) {
			const url = pasteUrl(entry.id)
			const rawUrl = rawPasteUrl(entry.id)
			if (entry.url !== url) {
				entry.url = url
				changed = true
			}
			if (entry.rawUrl !== rawUrl) {
				entry.rawUrl = rawUrl
				changed = true
			}
		}
		if (entry && Object.prototype.hasOwnProperty.call(entry, 'filename')) {
			delete entry.filename
			changed = true
		}
	}
	if (changed) {
		saveIndex(data)
	}

	return data
}

function saveIndex(data) {
	fs.mkdirSync(CONFIG.dataDir, { recursive: true })

	const tempFile = path.join(path.dirname(INDEX_FILE), `.${path.basename(INDEX_FILE)}.${process.pid}.${Date.now()}.tmp`)
	fs.writeFileSync(tempFile, `${JSON.stringify(data, null, 2)}\n`)
	fs.renameSync(tempFile, INDEX_FILE)
}

function pastePath(file) {
	const fullPath = path.resolve(PASTES_DIR, file)
	if (!fullPath.startsWith(`${PASTES_DIR}${path.sep}`)) {
		throw new Error('Invalid paste file path')
	}

	return fullPath
}

function pasteUrl(id) {
	return `${CONFIG.baseUrl}/${encodeURIComponent(id)}`
}

function rawPasteUrl(id) {
	return `${CONFIG.baseUrl}/${encodeURIComponent(id)}/raw`
}

function contentDisposition(filename) {
	const asciiFilename = filename.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_')
	return `inline; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function normalizePasteId(value) {
	if (typeof value !== 'string') {
		return null
	}

	const normalized = value
		.trim()
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9_.-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/\.{2,}/g, '.')
		.replace(/^[-_.]+/, '')
		.replace(/[-_.]+$/, '')
		.slice(0, CUSTOM_ID_MAX_LENGTH)
		.replace(/[-_.]+$/, '')

	if (!validPasteId(normalized)) {
		return null
	}

	return normalized
}

function isReservedPasteId(id) {
	return RESERVED_IDS.has(id.toLowerCase())
}

function downloadFilename(entry) {
	const id = entry.id || 'paste'
	if (/\.[a-z0-9]{1,12}$/i.test(id)) {
		return id
	}

	return `${id}${extensionForLanguage(entry.languageKey)}`
}

function extensionForLanguage(languageKey) {
	const extensions = {
		bash: '.sh',
		c: '.c',
		cpp: '.cpp',
		csharp: '.cs',
		css: '.css',
		dockerfile: '.Dockerfile',
		go: '.go',
		html: '.html',
		ini: '.ini',
		java: '.java',
		javascript: '.js',
		json: '.json',
		kotlin: '.kt',
		markdown: '.md',
		php: '.php',
		powershell: '.ps1',
		python: '.py',
		ruby: '.rb',
		rust: '.rs',
		scss: '.scss',
		shell: '.sh',
		sql: '.sql',
		toml: '.toml',
		typescript: '.ts',
		xml: '.xml',
		yaml: '.yaml'
	}

	return extensions[languageKey] || '.txt'
}

function genShort() {
	let short = ''
	for (let i = 0; i < CONFIG.pasteCodeLength; i++) {
		short += CODE_ALPHABET.charAt(crypto.randomInt(CODE_ALPHABET.length))
	}

	return short
}

function genUniqueShort(data) {
	const usedCodes = new Set(data.map(item => item.id))
	const codeSpace = CODE_ALPHABET.length ** CONFIG.pasteCodeLength
	if (usedCodes.size >= codeSpace) {
		throw new Error('Paste code space is exhausted')
	}

	for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
		const short = genShort()
		if (!usedCodes.has(short) && !isReservedPasteId(short)) {
			return short
		}
	}

	throw new Error('Unable to generate a unique paste code')
}

function detectLanguage(content) {
	const sample = content.slice(0, LANGUAGE_SAMPLE_SIZE)
	if (isLikelyMarkdown(sample)) {
		return { language: 'Markdown', languageKey: 'markdown', relevance: 100 }
	}

	const result = hljs.highlightAuto(sample, CODE_LANGUAGE_CANDIDATES)
	if (!result.language || result.relevance < 2) {
		return { language: 'Plain text', languageKey: 'plaintext', relevance: result.relevance || 0 }
	}

	return {
		language: formatLanguageName(result.language),
		languageKey: result.language,
		relevance: result.relevance || 0
	}
}

function refreshDetectedLanguage(entry, content) {
	const detected = detectLanguage(content)
	const changed =
		entry.language !== detected.language ||
		entry.languageKey !== detected.languageKey ||
		entry.relevance !== detected.relevance

	if (changed) {
		entry.language = detected.language
		entry.languageKey = detected.languageKey
		entry.relevance = detected.relevance
	}

	return changed
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

function formatLanguageName(languageKey) {
	const language = hljs.getLanguage(languageKey)
	return language?.name || languageKey
}

function renderPasteContent(content, languageKey, size) {
	if (languageKey === 'markdown') {
		if (CONFIG.highlightMaxSize === 0 || size > CONFIG.highlightMaxSize) {
			return { renderMode: 'markdown', highlightedHtml: null, renderedHtml: null }
		}

		return { renderMode: 'markdown', highlightedHtml: null, renderedHtml: markdown.render(content) }
	}

	return { renderMode: 'code', highlightedHtml: highlightContent(content, languageKey, size), renderedHtml: null }
}

function highlightContent(content, languageKey, size) {
	if (CONFIG.highlightMaxSize === 0 || size > CONFIG.highlightMaxSize) {
		return null
	}

	try {
		if (languageKey && languageKey !== 'plaintext' && hljs.getLanguage(languageKey)) {
			return hljs.highlight(content, { language: languageKey, ignoreIllegals: true }).value
		}

		return escapeHtml(content)
	} catch {
		return escapeHtml(content)
	}
}

function escapeHtml(value) {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function escapeAttribute(value) {
	return escapeHtml(value).replace(/`/g, '&#96;')
}

function pasteResponse(entry, content, render = {}) {
	const filename = downloadFilename(entry)
	return {
		id: entry.id,
		filename,
		url: pasteUrl(entry.id),
		rawUrl: rawPasteUrl(entry.id),
		language: entry.language,
		languageKey: entry.languageKey,
		size: entry.size,
		createdAt: entry.createdAt,
		views: entry.views,
		content,
		renderMode: render.renderMode || 'code',
		highlightedHtml: render.highlightedHtml || null,
		renderedHtml: render.renderedHtml || null
	}
}

function publicEntry(entry) {
	const filename = downloadFilename(entry)
	return {
		id: entry.id,
		filename,
		url: pasteUrl(entry.id),
		rawUrl: rawPasteUrl(entry.id),
		language: entry.language,
		languageKey: entry.languageKey,
		size: entry.size,
		createdAt: entry.createdAt,
		views: entry.views
	}
}

function readBearerToken(req) {
	const header = req.get('authorization') || ''
	const [scheme, token, extra] = header.trim().split(/\s+/)
	if (extra || !scheme || !token || scheme.toLowerCase() !== 'bearer') {
		return null
	}

	return token
}

function tokenMatches(token) {
	if (!token) {
		return false
	}

	const provided = Buffer.from(token)
	const expected = Buffer.from(CONFIG.apiToken)

	return provided.length === expected.length && crypto.timingSafeEqual(provided, expected)
}

function requireAuth(req, res, next) {
	if (!tokenMatches(readBearerToken(req))) {
		return sendError(res, 401, 'unauthorized', 'Unauthorized')
	}

	next()
}

function sendSuccess(res, data, status = 200) {
	return res.status(status).json({ success: true, data })
}

function sendError(res, status, code, message) {
	return res.status(status).json({ success: false, error: { code, message } })
}

function findEntry(data, id) {
	return data.find(item => item.id === id) || null
}

function validPasteId(id) {
	return (
		typeof id === 'string' &&
		id.length <= CUSTOM_ID_MAX_LENGTH &&
		/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id) &&
		!isReservedPasteId(id)
	)
}

ensureStorage()

app.disable('x-powered-by')
app.use((_req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff')
	res.setHeader('Referrer-Policy', 'no-referrer')
	next()
})
app.use(express.json({ limit: CONFIG.pasteMaxSize + 16 * 1024 }))
app.use(express.static(path.join(__dirname, 'public')))

app.post('/auth/verify', requireAuth, (_req, res) => {
	res.json({ ok: true })
})

app.post('/api/pastes', requireAuth, (req, res) => {
	const content = req.body?.content
	if (typeof content !== 'string' || content.trim() === '') {
		return sendError(res, 400, 'bad_request', 'Paste content is required')
	}

	const size = Buffer.byteLength(content, 'utf8')
	if (size > CONFIG.pasteMaxSize) {
		return sendError(res, 413, 'payload_too_large', `Paste content must be ${CONFIG.pasteMaxSize} bytes or less`)
	}

	try {
		const data = loadIndex()
		const id = genUniqueShort(data)
		const file = `${id}.txt`
		const { language, languageKey, relevance } = detectLanguage(content)
		const entry = {
			id,
			file,
			url: pasteUrl(id),
			rawUrl: rawPasteUrl(id),
			language,
			languageKey,
			relevance,
			size,
			createdAt: new Date().toISOString(),
			views: 0
		}

		fs.writeFileSync(pastePath(file), content)
		data.push(entry)
		saveIndex(data)

		const render = renderPasteContent(content, languageKey, size)
		return sendSuccess(res, pasteResponse(entry, content, render), 201)
	} catch (e) {
		console.error(`Error creating paste: ${e.stack || e}`)
		return sendError(res, 500, 'internal_server_error', 'Unable to create paste right now')
	}
})

app.get('/api/pastes/:id', (req, res) => {
	const id = req.params.id
	if (!validPasteId(id)) {
		return sendError(res, 404, 'not_found', 'Paste not found')
	}

	try {
		const data = loadIndex()
		const entry = findEntry(data, id)
		if (!entry) {
			return sendError(res, 404, 'not_found', 'Paste not found')
		}

		const content = fs.readFileSync(pastePath(entry.file), 'utf8')
		entry.views += 1
		refreshDetectedLanguage(entry, content)
		saveIndex(data)

		const render = renderPasteContent(content, entry.languageKey, entry.size)
		return sendSuccess(res, pasteResponse(entry, content, render))
	} catch (e) {
		console.error(`Error reading paste ${id}: ${e.stack || e}`)
		return sendError(res, 500, 'internal_server_error', 'Unable to read paste right now')
	}
})

app.patch('/api/pastes/:id', requireAuth, (req, res) => {
	const id = req.params.id
	if (!validPasteId(id)) {
		return sendError(res, 404, 'not_found', 'Paste not found')
	}

	try {
		const data = loadIndex()
		const entry = findEntry(data, id)
		if (!entry) {
			return sendError(res, 404, 'not_found', 'Paste not found')
		}

		const nextId = normalizePasteId(req.body?.id ?? req.body?.name ?? req.body?.filename)
		if (!nextId) {
			return sendError(res, 400, 'bad_request', 'Paste id must contain letters, numbers, dots, dashes or underscores')
		}

		if (nextId !== entry.id && data.some(item => item.id === nextId)) {
			return sendError(res, 409, 'conflict', 'Paste id is already in use')
		}

		entry.id = nextId
		entry.url = pasteUrl(entry.id)
		entry.rawUrl = rawPasteUrl(entry.id)
		delete entry.filename
		saveIndex(data)

		const content = fs.readFileSync(pastePath(entry.file), 'utf8')
		const render = renderPasteContent(content, entry.languageKey, entry.size)
		return sendSuccess(res, pasteResponse(entry, content, render))
	} catch (e) {
		console.error(`Error renaming paste ${id}: ${e.stack || e}`)
		return sendError(res, 500, 'internal_server_error', 'Unable to rename paste right now')
	}
})

app.delete('/api/pastes/:id', requireAuth, (req, res) => {
	const id = req.params.id
	if (!validPasteId(id)) {
		return sendError(res, 404, 'not_found', 'Paste not found')
	}

	try {
		const data = loadIndex()
		const index = data.findIndex(item => item.id === id)
		if (index === -1) {
			return sendError(res, 404, 'not_found', 'Paste not found')
		}

		const [entry] = data.splice(index, 1)
		const filePath = pastePath(entry.file)
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath)
		}
		saveIndex(data)

		return sendSuccess(res, publicEntry(entry))
	} catch (e) {
		console.error(`Error deleting paste ${id}: ${e.stack || e}`)
		return sendError(res, 500, 'internal_server_error', 'Unable to delete paste right now')
	}
})

app.get('/:id/raw', (req, res) => {
	const id = req.params.id
	if (!validPasteId(id)) {
		return res.status(404).type('text/plain; charset=utf-8').send('Paste not found')
	}

	try {
		const data = loadIndex()
		const entry = findEntry(data, id)
		if (!entry) {
			return res.status(404).type('text/plain; charset=utf-8').send('Paste not found')
		}

		const filePath = pastePath(entry.file)
		const content = fs.readFileSync(filePath, 'utf8')
		entry.views += 1
		refreshDetectedLanguage(entry, content)
		saveIndex(data)

		return res.sendFile(filePath, {
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Content-Disposition': contentDisposition(downloadFilename(entry)),
				'Cache-Control': 'no-store'
			}
		})
	} catch (e) {
		console.error(`Error reading raw paste ${id}: ${e.stack || e}`)
		return res.status(500).type('text/plain; charset=utf-8').send('Unable to read paste right now')
	}
})

app.get(['/', '/:id'], (_req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.use((err, _req, res, next) => {
	if (!err) {
		return next()
	}

	if (err.type === 'entity.too.large') {
		return sendError(res, 413, 'payload_too_large', `Request body must be ${CONFIG.pasteMaxSize} bytes or less`)
	}

	console.error(`Unhandled request error: ${err.stack || err}`)
	return sendError(res, 500, 'internal_server_error', 'Unexpected server error')
})

app.listen(CONFIG.port, () => {
	console.log(`Seki is running on http://localhost:${CONFIG.port}`)
})
