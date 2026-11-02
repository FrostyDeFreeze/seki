# Seki

A small private paste service. Creating, renaming and deleting pastes needs a token, reading them doesn't. Code gets syntax highlighting, Markdown is rendered, and every paste has a raw version. No database: an index in `index.json` and one text file per paste.

![Auth](./docs/screenshots/auth.png)
![Code](./docs/screenshots/code.png)
![Markdown](./docs/screenshots/markdown.png)

## Run

Needs Node.js 18+

```bash
git clone https://github.com/FrostyDeFreeze/seki
cd seki
npm i
cp .env.example .env
npm start
```

Settings in `.env`:

| Variable             | What it does                                                     |
| -------------------- | ---------------------------------------------------------------- |
| `PORT`               | Port to listen on, `7250` by default                             |
| `BASE_URL`           | Public address used in paste links, e.g. `https://p.example.com` |
| `API_TOKEN`          | The password for writing pastes. Make it long and random         |
| `PASTE_CODE_LENGTH`  | Length of a new paste's id, from 1 to 16, `3` by default         |
| `PASTE_MAX_SIZE`     | Largest paste in bytes, `1048576` (1 MB) by default              |
| `HIGHLIGHT_MAX_SIZE` | Pastes above this many bytes are shown as plain text, `262144`   |
| `DATA_DIR`           | Where pastes are stored, `./data` by default                     |

A good token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

In production put it behind a reverse proxy on its own domain or subdomain and set `BASE_URL` to that address. Back up `DATA_DIR` now and then, it holds every paste.

## API

Send the token in a header:

```http
Authorization: Bearer <API_TOKEN>
```

`POST /api/pastes` with `{ "content": "console.log('hello')" }` creates a paste and returns it:

```json
{
	"id": "aB3",
	"url": "https://p.example.com/aB3",
	"rawUrl": "https://p.example.com/aB3/raw",
	"language": "JavaScript",
	"languageKey": "javascript",
	"size": 20,
	"views": 0,
	"createdAt": "2026-11-02T12:00:00.000Z",
	"content": "console.log('hello')",
	"html": "<span class=\"hljs-variable language_\">console</span>..."
}
```

The language is guessed from the content. `html` is the highlighted code or rendered Markdown, `null` for plain text and pastes over `HIGHLIGHT_MAX_SIZE`.

`PATCH /api/pastes/:id` with `{ "id": "release-notes.md" }` renames a paste, the old link stops working. The name is lowercased and anything but letters, digits, dots, dashes and underscores becomes a dash. A known extension like `.js` or `.md` also sets the language.

`DELETE /api/pastes/:id` removes a paste and its file.

`POST /auth/verify` answers `200` if the token is right and `401` if not.

Without a token:

- `GET /:id` opens the paste in the browser or shows a 404 page
- `GET /:id/raw` returns it as plain text
- `GET /api/pastes/:id` returns it as JSON

Opening a paste in any of these ways counts as a view.

Errors come back as `{ "error": "..." }`.
