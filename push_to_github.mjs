import fs from 'fs'
import path from 'path'

const OWNER = 'dgq533-gemini'
const REPO = 'pixel-beads'
const TOKEN = process.env.GH_TOKEN
const API = 'https://api.github.com'
const ROOT = process.cwd()

const EXCLUDE = new Set(['node_modules', '.git', 'dist', 'dist-ssr', '.vercel', 'gen_palette.js', 'palette.json', 'palette_count.txt'])
const EXCLUDE_FILES = new Set(['.DS_Store'])

function walk(dir, base = '') {
  const entries = []
  for (const name of fs.readdirSync(dir)) {
    if (EXCLUDE.has(name)) continue
    const full = path.join(dir, name)
    const rel = base ? `${base}/${name}` : name
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      entries.push(...walk(full, rel))
    } else if (stat.isFile() && !EXCLUDE_FILES.has(name)) {
      entries.push(rel)
    }
  }
  return entries
}

async function gh(path, method = 'GET', body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

async function main() {
  const files = walk(ROOT)
  console.log(`Files to upload: ${files.length}`)

  // Bootstrap: create .gitignore via Contents API (repo is empty)
  const gitignorePath = files.find(f => f === '.gitignore')
  if (gitignorePath) {
    const content = fs.readFileSync(path.join(ROOT, gitignorePath)).toString('base64')
    await gh(`/repos/${OWNER}/${REPO}/contents/.gitignore`, 'PUT', {
      message: 'chore: initial commit',
      content,
      branch: 'main',
    })
    console.log('Bootstrap commit created')
  }

  // Create blobs for each remaining file
  const tree = []
  for (const rel of files) {
    if (rel === '.gitignore') continue
    const content = fs.readFileSync(path.join(ROOT, rel))
    const isBinary = content.some((b) => b === 0)
    const blob = await gh(`/repos/${OWNER}/${REPO}/git/blobs`, 'POST', {
      content: isBinary ? content.toString('base64') : content.toString('utf-8'),
      encoding: isBinary ? 'base64' : 'utf-8',
    })
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha })
    console.log(`  blob: ${rel}`)
  }

  // Create tree
  const treeRes = await gh(`/repos/${OWNER}/${REPO}/git/trees`, 'POST', { tree })
  console.log(`Tree SHA: ${treeRes.sha}`)

  // Get the bootstrap commit SHA (HEAD of main)
  const refRes = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/main`)
  const parentSha = refRes.object.sha

  // Create commit with parent
  const commit = await gh(`/repos/${OWNER}/${REPO}/git/commits`, 'POST', {
    message: 'feat: Pixel Beads pattern generator with original OKLab color palette\n\nImage to bead pattern converter with 283-color original palette, 10-language i18n, payment flow, and SEO optimization.',
    tree: treeRes.sha,
    parents: [parentSha],
  })
  console.log(`Commit SHA: ${commit.sha}`)

  // Update main branch ref
  await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/main`, 'PATCH', {
    sha: commit.sha,
    force: true,
  })

  console.log('\n✅ Push complete!')
  console.log(`Repo: https://github.com/${OWNER}/${REPO}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
