const STORAGE_KEY = 'seki:api-token'

const authView = document.getElementById('auth-view')
const workspace = document.getElementById('workspace')
const authForm = document.getElementById('auth-form')
const tokenInput = document.getElementById('token-input')
const authSubmit = document.getElementById('auth-submit')
const authError = document.getElementById('auth-error')
const editorView = document.getElementById('editor-view')
const viewerView = document.getElementById('viewer-view')
const editorInput = document.getElementById('editor-input')
const codeFrame = document.getElementById('code-frame')
const lineNumbers = document.getElementById('line-numbers')
const codeOutput = document.getElementById('code-output')
const markdownFrame = document.getElementById('markdown-frame')
const metaStrip = document.getElementById('meta-strip')
const idMeta = document.getElementById('id-meta')
const languageMeta = document.getElementById('language-meta')
const viewsMeta = document.getElementById('views-meta')
const sizeMeta = document.getElementById('size-meta')
const toast = document.getElementById('toast')

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
let isAuthenticated = false
let currentPaste = null
let currentContent = ''
let toastTimer = null
let pendingAfterAuth = null

function getStoredToken() {
	return localStorage.getItem(STORAGE_KEY) || ''
}

function storeToken(token) {
	localStorage.setItem(STORAGE_KEY, token)
	activeToken = token
	isAuthenticated = true
}

function clearToken() {
	localStorage.removeItem(STORAGE_KEY)
	activeToken = ''
	isAuthenticated = false
}

function authHeaders(token = activeToken) {
	return {
		Authorization: `Bearer ${token}`
	}
}

function setLoading(button, isLoading, loadingText) {
	if (!button.dataset.defaultText) {
		button.dataset.defaultText = button.textContent
	}

	button.disabled = isLoading
	button.textContent = isLoading ? loadingText : button.dataset.defaultText
}

function setMessage(element, message) {
	element.textContent = message || ''
}

function currentRouteId() {
	const parts = window.location.pathname.split('/').filter(Boolean)
	if (parts.length !== 1) {
		return null
	}

	return parts[0]
}

function showAuth(message = '', afterAuth = null) {
	pendingAfterAuth = afterAuth
	workspace.hidden = true
	authView.hidden = false
	setMessage(authError, message)
	tokenInput.value = ''
	tokenInput.focus()
}

function showWorkspace() {
	authView.hidden = true
	workspace.hidden = false
	setMessage(authError, '')
}

function showEditor(content = '') {
	currentPaste = null
	currentContent = content
	document.title = 'Seki'
	showWorkspace()
	viewerView.hidden = true
	editorView.hidden = false
	metaStrip.hidden = true
	setToolbar(['save', 'new', 'github', 'signOut'])
	editorInput.value = content
	editorInput.focus()
}

function showViewer(paste) {
	currentPaste = paste
	currentContent = paste.content || ''
	showWorkspace()
	editorView.hidden = true
	viewerView.hidden = false
	metaStrip.hidden = false
	idMeta.textContent = paste.id || 'paste'
	idMeta.title = paste.url || paste.id || 'paste'
	languageMeta.textContent = paste.language || 'Plain text'
	viewsMeta.textContent = `${paste.views || 0} ${paste.views === 1 ? 'view' : 'views'}`
	sizeMeta.textContent = formatBytes(paste.size || 0)
	document.title = `${paste.id || 'Paste'} - Seki`
	if (paste.renderMode === 'markdown' && paste.renderedHtml) {
		renderMarkdown(paste.renderedHtml)
	} else {
		renderCode(paste.content || '', paste.highlightedHtml, paste.languageKey)
	}
	updateViewerToolbar()
}

function showNotFound() {
	const content = 'Paste not found'
	showWorkspace()
	editorView.hidden = true
	viewerView.hidden = false
	metaStrip.hidden = true
	currentPaste = null
	currentContent = content
	document.title = 'Paste not found - Seki'
	renderCode(content, null, 'plaintext')
	setToolbar(isAuthenticated ? ['new', 'github', 'signOut'] : ['new', 'github'])
}

function updateViewerToolbar() {
	const actions = ['new', 'duplicate', 'raw', 'copy']
	if (isAuthenticated) {
		actions.push('rename', 'delete', 'github', 'signOut')
	} else {
		actions.push('github')
	}
	setToolbar(actions)
}

function setToolbar(visibleActions) {
	const visible = new Set(visibleActions)
	for (const [name, button] of Object.entries(buttons)) {
		button.hidden = !visible.has(name)
	}
}

function renderCode(content, highlightedHtml, languageKey) {
	codeFrame.hidden = false
	markdownFrame.hidden = true
	markdownFrame.innerHTML = ''

	const lines = content.split(/\r\n|\r|\n/).length
	lineNumbers.textContent = Array.from({ length: Math.max(lines, 1) }, (_value, index) => index + 1).join('\n')
	codeOutput.className = `code-output language-${languageKey || 'plaintext'}`

	if (highlightedHtml) {
		codeOutput.innerHTML = highlightedHtml
	} else {
		codeOutput.textContent = content
	}
}

function renderMarkdown(renderedHtml) {
	codeFrame.hidden = true
	markdownFrame.hidden = false
	codeOutput.textContent = ''
	lineNumbers.textContent = ''
	markdownFrame.innerHTML = renderedHtml
}

function handleSelectAll(event) {
	const isSelectAll = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a'
	if (!isSelectAll || viewerView.hidden || !currentPaste || isEditableElement(event.target)) {
		return
	}

	const target = markdownFrame.hidden ? codeOutput : markdownFrame
	event.preventDefault()
	selectElementContents(target)
}

function isEditableElement(element) {
	return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'))
}

function selectElementContents(element) {
	const range = document.createRange()
	range.selectNodeContents(element)

	const selection = window.getSelection()
	selection.removeAllRanges()
	selection.addRange(range)
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

async function readJson(response) {
	try {
		return await response.json()
	} catch {
		return {}
	}
}

async function verifyToken(token) {
	if (!token) {
		return false
	}

	const response = await fetch('/auth/verify', {
		method: 'POST',
		headers: authHeaders(token)
	})

	return response.ok
}

async function submitAuth(event) {
	event.preventDefault()

	const token = tokenInput.value.trim()
	if (!token) {
		setMessage(authError, 'Enter your API token')
		return
	}

	setMessage(authError, '')
	setLoading(authSubmit, true, 'Checking')

	try {
		const isValid = await verifyToken(token)
		if (!isValid) {
			clearToken()
			setMessage(authError, 'Invalid token')
			return
		}

		storeToken(token)
		const next = pendingAfterAuth
		pendingAfterAuth = null
		if (next) {
			next()
			return
		}

		showEditor(currentContent || '')
	} catch (e) {
		console.error(`Token verification failed: ${e}`)
		setMessage(authError, 'Unable to verify the token right now')
	} finally {
		setLoading(authSubmit, false)
	}
}

async function savePaste() {
	const content = editorInput.value
	if (!content.trim()) {
		showToast('Paste content is required')
		return
	}

	if (!isAuthenticated || !activeToken) {
		showAuth('Unlock to create a paste', () => showEditor(content))
		return
	}

	buttons.save.disabled = true
	try {
		const response = await fetch('/api/pastes', {
			method: 'POST',
			headers: {
				...authHeaders(),
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ content })
		})

		const body = await readJson(response)
		if (response.status === 401) {
			clearToken()
			showAuth('Session expired, enter your token again', () => showEditor(content))
			return
		}
		if (!response.ok || !body.success) {
			showToast(body.error?.message || 'Unable to save paste')
			return
		}

		window.history.pushState({}, '', new URL(body.data.url).pathname)
		showViewer(body.data)
		showToast('Saved')
	} catch (e) {
		console.error(`Save failed: ${e}`)
		showToast('Unable to save paste right now')
	} finally {
		buttons.save.disabled = false
	}
}

async function loadPaste(id) {
	try {
		const response = await fetch(`/api/pastes/${encodeURIComponent(id)}`)
		const body = await readJson(response)
		if (response.status === 404) {
			showNotFound()
			return
		}
		if (!response.ok || !body.success) {
			showToast(body.error?.message || 'Unable to load paste')
			showNotFound()
			return
		}

		showViewer(body.data)
	} catch (e) {
		console.error(`Paste load failed: ${e}`)
		showToast('Unable to load paste right now')
		showNotFound()
	}
}

function newPaste() {
	if (!isAuthenticated) {
		showAuth('Unlock to create a paste', () => {
			window.history.pushState({}, '', '/')
			showEditor('')
		})
		return
	}

	window.history.pushState({}, '', '/')
	showEditor('')
}

function duplicatePaste() {
	const content = currentContent
	if (!content) {
		return
	}

	if (!isAuthenticated) {
		showAuth('Unlock to duplicate this paste', () => {
			window.history.pushState({}, '', '/')
			showEditor(content)
		})
		return
	}

	window.history.pushState({}, '', '/')
	showEditor(content)
}

function openRaw() {
	if (!currentPaste?.id) {
		return
	}

	window.open(
		new URL(currentPaste.rawUrl || `/${currentPaste.id}/raw`, window.location.origin).pathname,
		'_blank',
		'noopener,noreferrer'
	)
}

async function copyLink() {
	if (!currentPaste?.url) {
		return
	}

	try {
		await navigator.clipboard.writeText(currentPaste.url)
		showToast('Copied to clipboard')
	} catch (e) {
		console.error(`Copy failed: ${e}`)
		showToast('Unable to copy')
	}
}

async function renamePaste() {
	if (!currentPaste?.id) {
		return
	}

	if (!isAuthenticated) {
		showAuth('Unlock to rename this paste', () => showViewer(currentPaste))
		return
	}

	const nextId = window.prompt('Link name', currentPaste.id)
	if (nextId === null) {
		return
	}

	buttons.rename.disabled = true
	try {
		const response = await fetch(`/api/pastes/${encodeURIComponent(currentPaste.id)}`, {
			method: 'PATCH',
			headers: {
				...authHeaders(),
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ id: nextId })
		})

		const body = await readJson(response)
		if (response.status === 401) {
			clearToken()
			showAuth('Session expired, enter your token again', () => showViewer(currentPaste))
			return
		}
		if (!response.ok || !body.success) {
			showToast(body.error?.message || 'Unable to rename paste')
			return
		}

		window.history.replaceState({}, '', new URL(body.data.url).pathname)
		showViewer(body.data)
		showToast('Renamed')
	} catch (e) {
		console.error(`Rename failed: ${e}`)
		showToast('Unable to rename paste right now')
	} finally {
		buttons.rename.disabled = false
	}
}

async function deletePaste() {
	if (!currentPaste?.id) {
		return
	}

	if (!isAuthenticated) {
		showAuth('Unlock to delete this paste', () => showViewer(currentPaste))
		return
	}

	if (!window.confirm('Delete this paste?')) {
		return
	}

	buttons.delete.disabled = true
	try {
		const response = await fetch(`/api/pastes/${encodeURIComponent(currentPaste.id)}`, {
			method: 'DELETE',
			headers: authHeaders()
		})

		const body = await readJson(response)
		if (response.status === 401) {
			clearToken()
			showAuth('Session expired, enter your token again')
			return
		}
		if (!response.ok || !body.success) {
			showToast(body.error?.message || 'Unable to delete paste')
			return
		}

		window.history.pushState({}, '', '/')
		showEditor('')
		showToast('Deleted')
	} catch (e) {
		console.error(`Delete failed: ${e}`)
		showToast('Unable to delete paste right now')
	} finally {
		buttons.delete.disabled = false
	}
}

function signOut() {
	clearToken()
	if (currentPaste) {
		updateViewerToolbar()
		showToast('Signed out')
		return
	}

	showAuth()
}

function showToast(message) {
	toast.textContent = message
	toast.classList.add('is-visible')
	clearTimeout(toastTimer)
	toastTimer = setTimeout(() => {
		toast.classList.remove('is-visible')
	}, 2400)
}

async function boot() {
	activeToken = getStoredToken()
	const routeId = currentRouteId()

	if (activeToken) {
		try {
			isAuthenticated = await verifyToken(activeToken)
			if (!isAuthenticated) {
				clearToken()
			}
		} catch (e) {
			console.error(`Stored token check failed: ${e}`)
			clearToken()
		}
	}

	if (routeId) {
		await loadPaste(routeId)
		return
	}

	if (isAuthenticated) {
		showEditor('')
	} else {
		showAuth()
	}
}

window.addEventListener('popstate', () => {
	const routeId = currentRouteId()
	if (routeId) {
		void loadPaste(routeId)
		return
	}

	if (isAuthenticated) {
		showEditor('')
	} else {
		showAuth()
	}
})
document.addEventListener('keydown', handleSelectAll)

authForm.addEventListener('submit', submitAuth)
buttons.save.addEventListener('click', savePaste)
buttons.new.addEventListener('click', newPaste)
buttons.duplicate.addEventListener('click', duplicatePaste)
buttons.raw.addEventListener('click', openRaw)
buttons.copy.addEventListener('click', copyLink)
buttons.rename.addEventListener('click', renamePaste)
buttons.delete.addEventListener('click', deletePaste)
buttons.signOut.addEventListener('click', signOut)

boot()
