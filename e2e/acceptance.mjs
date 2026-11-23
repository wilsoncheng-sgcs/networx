// Acceptance scenarios from NETWORX_PROTOCOLS_SPEC.md §11, run headless against `npm run preview`.
// Usage: node e2e/acceptance.mjs [baseUrl]   (default http://localhost:4173/)
// Uses the system Chrome through playwright-core (no browser download). Screenshots: e2e/screenshots/.
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.argv[2] ?? 'http://localhost:4173/'
const LIVE = 'https://wilsoncheng-sgcs.github.io/networx/'
const here = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(here, 'screenshots')
mkdirSync(SHOTS, { recursive: true })

const results = []
const consoleErrors = []
let current = ''

function check(name, ok, detail = '') {
  results.push({ scenario: current, name, ok: !!ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  — ${detail}` : ''}`)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
const page = await context.newPage()
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${current}: ${m.text()}`) })
page.on('pageerror', (e) => consoleErrors.push(`${current}: ${e.message}`))

// ── helpers ──────────────────────────────────────────────────────────────────

const aside = () => page.locator('aside').last()
const termOut = () => page.getByTestId('terminal-output')
const termIn = () => page.getByTestId('terminal-input')
const rows = () => page.locator('[data-testid=capture-table] tbody tr')

async function scenario(n, title, fn) {
  current = `${n}. ${title}`
  console.log(`\n${current}`)
  try { await fn() } catch (e) {
    check('ran without error', false, String(e?.message ?? e).split('\n')[0])
    await page.screenshot({ path: join(SHOTS, `fail-${n}.png`) }).catch(() => {})
  }
}

async function shot(name) {
  await page.waitForTimeout(150)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function selectNode(label) {
  await page.locator('.react-flow__node', { hasText: label }).first().click({ position: { x: 45, y: 20 } })
  await aside().waitFor()
}

async function openTab(label) {
  await aside().getByRole('button', { name: label, exact: true }).click()
}

async function terminalOn(label) {
  await selectNode(label)
  await openTab('Terminal')
  await termIn().waitFor()
}

/** Type a command and wait until its output has finished printing. */
async function cmd(command, { wait = true, timeout = 60000 } = {}) {
  await termIn().fill(command)
  await termIn().press('Enter')
  if (wait) {
    await page.waitForTimeout(80)
    await page.waitForFunction(() => !document.querySelector('[data-testid=terminal-input]')?.hasAttribute('readonly'), null, { timeout })
  }
}

async function clearTerm() { await cmd('clear') }
async function output() { return (await termOut().innerText()) }

async function setSpeed(v) { await page.getByTestId('speed-select').selectOption(v) }
async function clearCapture() { await page.getByTestId('capture-drawer').getByRole('button', { name: /Clear/ }).click() }
async function filter(p) { await page.getByTestId('capture-filter').selectOption(p) }

async function rowTexts() { return rows().allInnerTexts() }

/** Click the first row whose text matches, return the detail pane text. */
async function detailOf(match) {
  const all = await rowTexts()
  const test = typeof match === 'string' ? (t) => t.includes(match) : typeof match === 'function' ? match : (t) => match.test(t)
  const i = all.findIndex(test)
  if (i < 0) return null
  await rows().nth(i).click()
  const d = await page.getByTestId('capture-detail').innerText()
  await rows().nth(i).click() // deselect
  return d
}

function cols(rowText) {
  const c = rowText.split('\t').map((s) => s.trim())
  return { no: c[0], time: c[1], src: c[2], dst: c[3], proto: c[4], len: c[5], info: c[6] ?? '' }
}

async function loadCareConnect() {
  await page.getByRole('button', { name: 'Presets' }).click()
  const item = page.getByRole('button', { name: /CareConnect/ }).first()
  await item.click()
  await item.click()
  await page.locator('.react-flow__node', { hasText: "Patient's Laptop" }).waitFor()
  await page.waitForTimeout(400)
}

// ── run ──────────────────────────────────────────────────────────────────────

await page.goto(BASE)
await page.evaluate(() => localStorage.clear())
await page.reload()
await loadCareConnect()
await page.getByTestId('capture-toggle').click()
await setSpeed('3')

await scenario(1, "Patient's Laptop: nslookup", async () => {
  await terminalOn("Patient's Laptop")
  await clearTerm(); await clearCapture()
  await cmd('nslookup www.careconnect.example')
  check('answer 203.0.113.80', (await output()).includes('Address:  203.0.113.80'))
  await page.waitForTimeout(300)
  const dns = (await rowTexts()).map(cols).filter((r) => r.proto === 'DNS')
  check('one DNS query and one response', dns.length === 2, `${dns.length} DNS rows`)
  check('both on UDP port 53', dns.every((r) => r.src.endsWith(':53') || r.dst.endsWith(':53')))
  const d = await detailOf('Standard query A www')
  check('detail says UDP', !!d && d.includes('UDP') && d.includes('dst port 53'))
  await cmd('nslookup wwww.careconnect.example')
  check('typo → NXDOMAIN', (await output()).includes("** server can't find wwww.careconnect.example: NXDOMAIN"))
  await shot('01-nslookup')
})

await scenario(2, 'curl -v http://', async () => {
  await clearTerm(); await clearCapture()
  await cmd('curl -v http://www.careconnect.example')
  const o = await output()
  check('DNS ⓘ line', o.includes('ⓘ DNS: asked 203.0.113.53 on port 53 (UDP): www.careconnect.example → 203.0.113.80'))
  check('handshake ⓘ line, port 80', /ⓘ TCP three-way handshake: SYN → SYN-ACK → ACK \(your port \d+ → server port 80\)/.test(o))
  check('* Connected … port 80', o.includes('* Connected to www.careconnect.example (203.0.113.80) port 80'))
  check('> GET / HTTP/1.1', o.includes('> GET / HTTP/1.1'))
  check('plain-text ⓘ line', o.includes('ⓘ Everything you see below also crossed the network in plain text.'))
  check('< HTTP/1.1 200 OK', o.includes('< HTTP/1.1 200 OK'))
  check('no TLS lines', !o.includes('TLS handshake'))
  check('left intact', o.includes('* Connection #0 to host www.careconnect.example left intact'))
  await page.waitForTimeout(300)
  const r = (await rowTexts()).map(cols)
  check('DNS ×2', r.filter((x) => x.proto === 'DNS').length === 2)
  const tcp = r.filter((x) => x.src.endsWith(':80') || x.dst.endsWith(':80'))
  const infos = tcp.map((x) => x.info)
  check('SYN, SYN-ACK, ACK to :80', infos[0]?.includes('[SYN]') && infos[1]?.includes('[SYN, ACK]') && infos[2]?.includes('[ACK]'), infos.slice(0, 3).join(' | '))
  check('FIN ×2', infos.filter((i) => i.includes('[FIN, ACK]')).length === 2)
  const clientPorts = new Set(tcp.map((x) => (x.src.endsWith(':80') ? x.dst : x.src).split(':')[1]))
  check('every TCP row has the same client port', clientPorts.size === 1, [...clientPorts].join(','))
  const get = await detailOf('GET / HTTP/1.1')
  check('GET payload readable', !!get && get.includes('Host: www.careconnect.example') && /TCP\s+src port \d+ → dst port 80/.test(get))
  const ok = await detailOf('HTTP/1.1 200 OK')
  check('200 OK carries readable HTML', !!ok && ok.includes('<!DOCTYPE html>'))
  await rows().filter({ hasText: 'GET / HTTP/1.1' }).first().click()
  await shot('02-curl-http')
  await rows().filter({ hasText: 'GET / HTTP/1.1' }).first().click()
})

await scenario(3, 'curl -v https://', async () => {
  await clearTerm(); await clearCapture()
  await cmd('curl -v https://www.careconnect.example')
  const o = await output()
  check('Client hello + SNI ⓘ', o.includes('* TLS handshake, Client hello (1):') && o.includes('ⓘ The Client hello names the site (www.careconnect.example) in plain text.'))
  check('SSL … TLSv1.3 line', o.includes('* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384'))
  check('SSL is a historical name ⓘ', o.includes('ⓘ “SSL” here is a historical name: SSL is the deprecated predecessor of TLS. The protocol in use is TLS 1.3.'))
  check('certificate block', o.includes('*  issuer: CN=Networx Demo CA') && o.includes('*  SSL certificate verify ok.'))
  check('encrypted-from-here ⓘ', o.includes('ⓘ Everything from here is encrypted on the wire.'))
  await page.waitForTimeout(300)
  const r = (await rowTexts()).map(cols)
  const tls = r.filter((x) => x.src.endsWith(':443') || x.dst.endsWith(':443'))
  check('all TCP rows use port 443', tls.length >= 10, `${tls.length} rows`)
  const hello = await detailOf('Client Hello')
  check('ClientHello readable incl. server_name', !!hello && hello.includes('server_name: www.careconnect.example') && !hello.includes('🔒'))
  const locked = tls.filter((x) => x.info.startsWith('🔒'))
  check('later rows 🔒', locked.length >= 4, `${locked.length}`)
  const app = await detailOf('🔒 Application Data')
  check('🔒 row shows hex, not the request', !!app && /17 03 03 [0-9a-f]{2} /.test(app) && !app.includes('GET /'))
  check('IPs and ports still visible', !!app && app.includes('dst port') && app.includes('203.0.113.80'))
  check('no teacher reveal without ?teacher=1', !!app && !app.includes('Teacher view'))
  await rows().filter({ hasText: '🔒 Application Data' }).first().click()
  await shot('03-curl-https')
  await rows().filter({ hasText: '🔒 Application Data' }).first().click()
})

await scenario(4, 'Browser: Not secure and padlock', async () => {
  await openTab('Browser')
  const addr = page.getByTestId('browser-address')
  await addr.fill('http://www.careconnect.example')
  await addr.press('Enter')
  await page.getByTestId('not-secure-chip').waitFor({ timeout: 30000 })
  check('http shows Not secure', await page.getByTestId('not-secure-chip').isVisible())
  check('address keeps http://', (await addr.inputValue()).startsWith('http://'))
  await shot('04a-browser-http')
  await addr.fill('https://www.careconnect.example')
  await addr.press('Enter')
  await page.getByTestId('secure-chip').waitFor({ timeout: 30000 })
  await page.getByTestId('secure-chip').click()
  const pop = await page.getByTestId('security-popover').innerText()
  check('https shows padlock popover', pop.includes('Connection is encrypted (TLS 1.3)') && pop.includes('Certificate issued to www.careconnect.example by Networx Demo CA'))
  check('popover: private ≠ trustworthy', pop.includes('it does not mean the site is trustworthy'))
  await shot('04b-browser-https')
  await page.getByTestId('secure-chip').click()
})

await scenario(5, 'Reception PC: ftp get', async () => {
  await terminalOn('Reception PC')
  await clearTerm(); await clearCapture()
  await cmd('ftp files.careconnect.example get referrals.csv')
  const o = await output()
  check('control on 21 ⓘ', o.includes('ⓘ FTP control connection on port 21 (TCP).'))
  check('Password: ******** and 226', o.includes('Password: ********') && o.includes('226 Transfer complete'))
  await page.waitForTimeout(300)
  await filter('FTP')
  const r = (await rowTexts()).map(cols)
  check('PASS Clinic2026! visible', r.some((x) => x.info.includes('PASS Clinic2026!') && x.dst.endsWith(':21')))
  const data = r.find((x) => x.proto === 'FTP-DATA')
  check('FTP-DATA from port 20', !!data && data.src.endsWith(':20'), data?.src)
  const d = await detailOf((t) => t.includes('FTP-DATA'))
  check('CSV readable in FTP-DATA', !!d && d.includes('P-1043,Sam Okafor,Cardiology,Irregular heartbeat'))
  await rows().filter({ hasText: 'FTP-DATA' }).first().click()
  await shot('05-ftp')
  await rows().filter({ hasText: 'FTP-DATA' }).first().click()
  await filter('All')
})

await scenario(6, 'Reception PC: sftp get', async () => {
  await clearTerm(); await clearCapture()
  await cmd('sftp files.careconnect.example get referrals.csv')
  const o = await output()
  check('fingerprint + password prompt', /ED25519 key fingerprint is SHA256:[A-Za-z0-9+/]{43}\./.test(o) && o.includes("clinic@files.careconnect.example's password: ********"))
  await page.waitForTimeout(300)
  await filter('SSH')
  const r = (await rowTexts()).map(cols)
  check('banners readable', r.filter((x) => x.info.includes('SSH-2.0-OpenSSH_9.6')).length === 2)
  check('key exchange readable', r.some((x) => x.info.includes('Key Exchange Init')))
  const afterKex = r.slice(r.findIndex((x) => x.info.includes('Key Exchange Reply')) + 1)
  check('everything after the key exchange 🔒', afterKex.length > 0 && afterKex.every((x) => x.info.startsWith('🔒')))
  check('all on port 22', r.every((x) => x.src.endsWith(':22') || x.dst.endsWith(':22')))
  await filter('All')
  let leaked = false
  const n = await rows().count()
  for (let i = 0; i < n; i++) {
    await rows().nth(i).click()
    const t = await page.getByTestId('capture-drawer').innerText()
    if (t.includes('Clinic2026')) leaked = true
    await rows().nth(i).click()
  }
  check('password appears nowhere in the capture (every row opened)', !leaked)
  await page.getByTestId('capture-search').fill('Clinic2026')
  check('search for the password finds nothing', (await rows().count()) === 1 && (await rows().first().innerText()).includes('No packets match'))
  await page.getByTestId('capture-search').fill('')
  await rows().filter({ hasText: '🔒 Client: Encrypted packet' }).first().click()
  await shot('06-sftp')
  await rows().filter({ hasText: '🔒 Client: Encrypted packet' }).first().click()
})

await scenario(7, 'Services: FTP off, ss', async () => {
  await selectNode('File Server')
  await openTab('Services')
  await page.getByTestId('service-ftp').uncheck()
  await shot('07a-services-tab')
  await terminalOn('Reception PC')
  await clearTerm(); await clearCapture()
  await cmd('ftp files.careconnect.example get referrals.csv')
  check('ftp refused', (await output()).includes('ftp: connect to address 203.0.113.21: Connection refused'))
  await page.waitForTimeout(300)
  const r = (await rowTexts()).map(cols).filter((x) => x.src.endsWith(':21') || x.dst.endsWith(':21'))
  check('capture: SYN then RST', r.length === 2 && r[0].info.includes('[SYN]') && r[1].info.includes('[RST, ACK]'), r.map((x) => x.info).join(' | '))
  await cmd('ssh 203.0.113.21')
  await cmd('ss')
  const o = await output()
  const ssPart = o.slice(o.lastIndexOf('Netid'))
  check('ss: 22 listening', ssPart.includes('0.0.0.0:22') && ssPart.includes('ssh'))
  check('ss: 21 absent', !ssPart.includes('0.0.0.0:21 '))
  await shot('07b-ss')
  await cmd('exit')
  check('exit closes the session', (await output()).includes('Connection to 203.0.113.21 closed.'))
})

async function mailboxCount(address) {
  await selectNode('Mail Server')
  await openTab('Mailboxes')
  const box = page.getByTestId('mailbox').filter({ has: page.locator(`input[value="${address}"]`) })
  return box.getByTestId('mailbox-count').innerText()
}

await scenario(8, 'POP3 on two devices', async () => {
  await terminalOn("Doctor's PC")
  await clearTerm()
  await cmd('pop3 dr.nguyen@careconnect.example')
  const o = await output()
  check('2 downloaded', o.includes('Downloaded 2 messages to this device.') && o.includes('2 messages (') && o.includes('Deleted 2 messages from the server.'))
  await page.waitForTimeout(200)
  check('mailbox now empty', (await mailboxCount('dr.nguyen@careconnect.example')) === '0 messages')
  await terminalOn("Doctor's Laptop")
  await clearTerm()
  await cmd('pop3 dr.nguyen@careconnect.example')
  check("laptop: 0 messages", (await output()).includes('0 messages on the server. Nothing to download.'))
  await shot('08a-pop3-laptop')
  await selectNode('Mail Server')
  await openTab('Mailboxes')
  await page.getByTestId('restore-mail').click()
  check('restore sample mail → 2', (await mailboxCount('dr.nguyen@careconnect.example')) === '2 messages')
  await shot('08b-restore')
  await terminalOn("Doctor's PC")
  await cmd('mail')
  check('mail lists the downloaded messages', (await output()).includes('Pathology results ready — P-1043'))
})

await scenario(9, 'IMAP on two devices', async () => {
  await terminalOn("Doctor's PC")
  await clearTerm()
  await cmd('imap dr.nguyen@careconnect.example read 1')
  check('read prints the message', (await output()).includes('Subject: Pathology results ready — P-1043'))
  await terminalOn("Doctor's Laptop")
  await clearTerm()
  await cmd('imap dr.nguyen@careconnect.example')
  const o = await output()
  check('both messages listed', o.includes('Pathology results ready — P-1043') && o.includes('Rostering for next week'))
  check('message 1 marked ✓, message 2 not', /\n\s+1 {2}✓/.test(o) && /\n\s+2 {2}–/.test(o))
  check('stays on the server ⓘ', o.includes('ⓘ IMAP leaves mail on the server.'))
  await shot('09-imap')
})

await scenario(10, 'Reception PC: smtp', async () => {
  await terminalOn('Reception PC')
  await clearTerm(); await clearCapture()
  await cmd('smtp reception@careconnect.example dr.nguyen@careconnect.example "Patient arrived"')
  const o = await output()
  check('250 OK queued', o.includes('250 OK queued'))
  check('Base64 ⓘ', o.includes('ⓘ The password was sent as Base64 — an encoding, not encryption.'))
  await page.waitForTimeout(300)
  const d = await detailOf('AUTH PLAIN')
  check('AUTH row decodes Base64', !!d && d.includes('Base64 decodes to: \\0reception@careconnect.example\\0Front2026!'))
  await rows().filter({ hasText: 'AUTH PLAIN' }).first().click()
  await shot('10-smtp')
  await rows().filter({ hasText: 'AUTH PLAIN' }).first().click()
  check("doctor's mailbox has 3", (await mailboxCount('dr.nguyen@careconnect.example')) === '3 messages')
})

await scenario(11, 'Speed: Instant, Normal, control+C', async () => {
  await terminalOn("Patient's Laptop")
  await setSpeed('instant')
  await clearTerm()
  await termIn().fill('curl -v https://www.careconnect.example')
  await termIn().press('Enter')
  await page.waitForTimeout(250)
  check('Instant prints at once', (await output()).includes('left intact'))
  await shot('11a-instant')
  await setSpeed('1')
  await clearTerm()
  await termIn().fill('curl -v https://www.careconnect.example')
  await termIn().press('Enter')
  await page.waitForTimeout(4500) // DNS query + answer: 2 legs × 5 hops × 300 ms
  const mid = await output()
  check('Normal: lines appear with the packets', mid.includes('* Host www.careconnect.example:443 was resolved.') && !mid.includes('left intact'))
  check('input shows running…', (await termIn().getAttribute('placeholder'))?.startsWith('running…') && (await termIn().getAttribute('readonly')) !== null)
  await shot('11b-normal-running')
  await termIn().press('Control+c')
  await page.waitForTimeout(200)
  const after = await output()
  check('control+C prints ^C', after.trim().endsWith('^C'))
  await page.waitForTimeout(4000)
  check('no more lines after ^C', !(await output()).includes('left intact') && (await output()).trim().endsWith('^C'))
  await shot('11c-ctrl-c')
  await setSpeed('3')
})

await scenario(12, 'Reload and import an export from the live site', async () => {
  await page.waitForTimeout(1800) // autosave fires 1.5 s after the last change
  const before = consoleErrors.length
  await page.reload()
  await page.locator('.react-flow__node', { hasText: "Patient's Laptop" }).waitFor()
  check('network restored from localStorage', (await page.locator('.react-flow__node').count()) === 13)
  check('no console errors on reload', consoleErrors.length === before, consoleErrors.slice(before).join(' | '))

  // Export a network.json from the live site (main, before this branch)
  const exportPath = join(SHOTS, 'live-network.json')
  try {
    const live = await context.newPage()
    await live.goto(LIVE, { timeout: 30000 })
    await live.evaluate(() => localStorage.clear())
    await live.reload()
    await live.getByRole('button', { name: 'Presets' }).click()
    const school = live.getByRole('button', { name: /School Network/ }).first()
    await school.click(); await school.click()
    await live.getByRole('button', { name: /Save/ }).first().waitFor()
    const [dl] = await Promise.all([live.waitForEvent('download'), live.getByRole('button', { name: /^Save$/ }).click()])
    await dl.saveAs(exportPath)
    await live.close()
    check('exported network.json from the live site', existsSync(exportPath))
  } catch (e) {
    check('exported network.json from the live site', false, String(e?.message ?? e).split('\n')[0])
  }
  if (existsSync(exportPath)) {
    const before2 = consoleErrors.length
    await page.locator('input[type=file]').setInputFiles(exportPath)
    await page.locator('.react-flow__node', { hasText: 'Teacher PC' }).waitFor()
    check('import loads', (await page.locator('.react-flow__node').count()) === 12)
    await terminalOn('Teacher PC')
    await clearTerm()
    await cmd('curl www.school.local')
    check('imported network works (curl www.school.local)', (await output()).includes('<h1>Welcome to Web Server</h1>'))
    await cmd('ss')
    check('ss on a client: nothing listening', (await output()).includes('(no listening ports'))
    check('no console errors on import', consoleErrors.length === before2, consoleErrors.slice(before2).join(' | '))
    await shot('12-imported')
  }
  await loadCareConnect()
})

await scenario(13, 'Layout at 1280×800 and 1440×900', async () => {
  if (!(await page.getByTestId('capture-drawer').isVisible().catch(() => false))) await page.getByTestId('capture-toggle').click()
  for (const [w, h] of [[1280, 800], [1440, 900]]) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(300)
    await terminalOn("Patient's Laptop")
    await clearTerm(); await clearCapture()
    await cmd('curl https://www.careconnect.example')
    await page.waitForTimeout(300)
    const canvas = await page.locator('.react-flow').boundingBox()
    const drawer = await page.getByTestId('capture-drawer').boundingBox()
    const term = await page.getByTestId('terminal-output').boundingBox()
    const input = await termIn().boundingBox()
    check(`${w}×${h}: canvas, terminal and capture all visible`,
      canvas && drawer && term && input && canvas.height > 200 && drawer.height >= 200 && term.height > 200 && input.y + input.height <= h,
      JSON.stringify({ canvas: canvas?.height, drawer: drawer?.height, term: term?.height }))
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    check(`${w}×${h}: no horizontal page scroll`, !overflow)
    await shot(`13-layout-${w}x${h}`)
  }
  check('no console errors in the whole run', consoleErrors.length === 0, consoleErrors.join(' | '))
})

await browser.close()

const failed = results.filter((r) => !r.ok)
writeFileSync(join(SHOTS, 'results.json'), JSON.stringify({ results, consoleErrors }, null, 2))
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('Failed:')
  for (const f of failed) console.log(`  [${f.scenario}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
}
process.exit(failed.length ? 1 : 0)
