const STORAGE_KEY = 'seki:api-token'

const authView = document.getElementById('auth-view')
const authForm = document.getElementById('auth-form')
const tokenInput = document.getElementById('token-input')
const authSubmit = document.getElementById('auth-submit')
const authError = document.getElementById('auth-error')
const workspace = document.getElementById('workspace')
const meta = document.getElementById('meta')
const appError = document.getElementById('app-error')
const editor = document.getElementById('editor')
const viewer = document.getElementById('viewer')
const code = document.getElementById('code')
const lines = document.getElementById('lines')
const source = document.getElementById('source')
const markdown = document.getElementById('markdown')
const copyIcon = document.getElementById('copy-icon')
const copiedIcon = document.getElementById('copied-icon')
const copyStatus = document.getElementById('copy-status')

const buttons = {
	save: document.getElementById('save-button'),
	new: document.getElementById('new-button'),
	duplicate: document.getElementById('duplicate-button'),
	raw: document.getElementById('raw-button'),
	copy: document.getElementById('copy-button'),
	rename: document.getElementById('rename-button'),
	delete: document.getElementById('delete-button'),
	github: document.getElementById('github-button'),
	signOut: document.getElementById('sign-out-button')
}

let activeToken = ''
let currentPaste = null
let errorTimer = null
let copyResetTimer = null

function getStoredToken() {
	try {
		return localStorage.getItem(STORAGE_KEY) || ''
	} catch {
		return ''
	}
}

function storeToken(token) {
	activeToken = token
	try {
		localStorage.setItem(STORAGE_KEY, token)
	} catch {}
}

function clearToken() {
	activeToken = ''
	try {
		localStorage.removeItem(STORAGE_KEY)
	} catch {}
}

function showError(message) {
	appError.textContent = message
	clearTimeout(errorTimer)
	errorTimer = setTimeout(() => (appError.textContent = ''), 4000)
}

function setToolbar(actions) {
	for (const [name, button] of Object.entries(buttons)) {
		button.hidden = !actions.includes(name)
	}
}

function showAuth(message = '') {
	workspace.hidden = true
	authView.hidden = false
	authError.textContent = message
	tokenInput.value = ''
	tokenInput.focus()
}

function showWorkspace() {
	authView.hidden = true
	workspace.hidden = false
	appError.textContent = ''
}

function showEditor(content) {
	currentPaste = null
	showWorkspace()
	viewer.hidden = true
	editor.hidden = false
	meta.textContent = ''
	document.title = 'Seki'
	setToolbar(['save', 'github', 'signOut'])
	if (content !== undefined) {
		editor.value = content
	}
	editor.focus()
}

function showViewer(paste) {
	currentPaste = paste
	showWorkspace()
	editor.hidden = true
	viewer.hidden = false
	viewer.scrollTo(0, 0)
	meta.textContent = [paste.id, paste.language, `${paste.views} ${paste.views === 1 ? 'view' : 'views'}`, formatBytes(paste.size)].join(' · ')
	document.title = `${paste.id} - Seki`
	buttons.raw.href = new URL(paste.rawUrl).pathname
	setCopied(false)
	updateViewerToolbar()

	const isMarkdown = paste.languageKey === 'markdown' && paste.html
	code.hidden = isMarkdown
	markdown.hidden = !isMarkdown
	if (isMarkdown) {
		markdown.innerHTML = paste.html
		return
	}

	markdown.textContent = ''
	lines.textContent = Array.from({ length: paste.content.split(/\r\n|\r|\n/).length }, (_value, i) => i + 1).join('\n')
	if (paste.html) {
		source.innerHTML = paste.html
	} else {
		source.textContent = paste.content
	}
}

function updateViewerToolbar() {
	setToolbar(activeToken ? ['new', 'duplicate', 'raw', 'copy', 'rename', 'delete', 'github', 'signOut'] : ['raw', 'copy', 'github'])
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

function go(path) {
	window.history.pushState({}, '', path)
}

async function request(method, path, body) {
	const headers = { Authorization: `Bearer ${activeToken}` }
	if (body) {
		headers['Content-Type'] = 'application/json'
	}

	const response = await fetch(path, { method, headers, body: body && JSON.stringify(body) })
	const data = await response.json().catch(() => ({}))
	if (response.status === 401) {
		clearToken()
		showAuth('Session expired, enter your token again')
		return null
	}
	if (!response.ok) {
		throw new Error(data.error || 'Something went wrong')
	}

	return data
}

async function act(button, action) {
	button.disabled = true
	try {
		await action()
	} catch (e) {
		console.error(e)
		showError(e instanceof TypeError ? 'Unable to reach the server' : e.message)
	} finally {
		button.disabled = false
	}
}

async function submitAuth(event) {
	event.preventDefault()

	const token = tokenInput.value.trim()
	if (!token) {
		authError.textContent = 'Enter your API token'
		return
	}

	authError.textContent = ''
	authSubmit.disabled = true

	try {
		const response = await fetch('/auth/verify', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
		if (!response.ok) {
			authError.textContent = 'Invalid token'
			return
		}

		storeToken(token)
		route()
	} catch (e) {
		console.error(`Token verification failed: ${e}`)
		authError.textContent = 'Unable to verify the token right now'
	} finally {
		authSubmit.disabled = false
	}
}

function savePaste() {
	const content = editor.value
	if (!content.trim()) {
		showError('Paste is empty')
		return
	}

	return act(buttons.save, async () => {
		const paste = await request('POST', '/api/pastes', { content })
		if (paste) {
			go(new URL(paste.url).pathname)
			showViewer(paste)
		}
	})
}

async function loadPaste(id) {
	try {
		const response = await fetch(`/api/pastes/${encodeURIComponent(id)}`)
		if (response.status === 404) {
			window.location.reload()
			return
		}

		const paste = await response.json()
		if (!response.ok) {
			throw new Error(paste.error)
		}

		showViewer(paste)
	} catch (e) {
		console.error(`Paste load failed: ${e}`)
		showWorkspace()
		setToolbar(['github'])
		showError('Unable to load this paste right now')
	}
}

function newPaste(content) {
	go('/')
	showEditor(content)
}

function renamePaste() {
	const id = window.prompt('Link name', currentPaste.id)
	if (id === null || id === currentPaste.id) {
		return
	}

	return act(buttons.rename, async () => {
		const paste = await request('PATCH', `/api/pastes/${encodeURIComponent(currentPaste.id)}`, { id })
		if (paste) {
			window.history.replaceState({}, '', new URL(paste.url).pathname)
			showViewer(paste)
		}
	})
}

function deletePaste() {
	if (!window.confirm('Delete this paste?')) {
		return
	}

	return act(buttons.delete, async () => {
		if (await request('DELETE', `/api/pastes/${encodeURIComponent(currentPaste.id)}`)) {
			newPaste('')
		}
	})
}

function setCopied(isCopied) {
	copyIcon.hidden = isCopied
	copiedIcon.hidden = !isCopied
	copyStatus.textContent = isCopied ? 'Copied' : ''
}

async function copyLink() {
	try {
		await navigator.clipboard.writeText(currentPaste.url)
		setCopied(true)
		clearTimeout(copyResetTimer)
		copyResetTimer = setTimeout(() => setCopied(false), 1800)
	} catch (e) {
		console.error(`Copy failed: ${e}`)
		showError('Unable to copy')
	}
}

function signOut() {
	clearToken()
	if (currentPaste) {
		updateViewerToolbar()
	} else {
		showAuth()
	}
}

function selectAll(event) {
	const isSelectAll = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a'
	if (!isSelectAll || viewer.hidden || event.target.closest('input, textarea')) {
		return
	}

	event.preventDefault()
	window.getSelection().selectAllChildren(markdown.hidden ? source : markdown)
}

function route() {
	const id = decodeURIComponent(window.location.pathname.slice(1))
	if (id) {
		void loadPaste(id)
	} else if (activeToken) {
		showEditor()
	} else {
		showAuth()
	}
}

authForm.addEventListener('submit', submitAuth)
buttons.save.addEventListener('click', savePaste)
buttons.new.addEventListener('click', () => newPaste(''))
buttons.duplicate.addEventListener('click', () => newPaste(currentPaste.content))
buttons.copy.addEventListener('click', copyLink)
buttons.rename.addEventListener('click', renamePaste)
buttons.delete.addEventListener('click', deletePaste)
buttons.signOut.addEventListener('click', signOut)
document.addEventListener('keydown', selectAll)
window.addEventListener('popstate', route)

activeToken = getStoredToken()
route()
