// Acceptance scenarios from NETWORX_PROTOCOLS_SPEC.md §11 and NETWORX_PHASE4_SPEC.md §4, run headless against `npm run preview`.
// Usage: node e2e/acceptance.mjs [baseUrl]   (default http://localhost:4173/)
// Uses the system Chrome through playwright-core (no browser download). Screenshots: e2e/screenshots/.
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
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
const rows = () => page.locator('[data-testid=capture-table] tbody tr[data-no]')

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
  const d = await detailOf(/Standard query 0x[0-9a-f]{4} A www/)
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
  check('search for the password finds nothing', (await rows().count()) === 0 && (await page.getByTestId('capture-table').innerText()).includes('No packets match'))
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

// ── Phase 2 ─────────────────────────────────────────────────────────────────

async function setCertificate(state) {
  await selectNode('CareConnect Web')
  await openTab('Services')
  await page.getByTestId('certificate-select').selectOption(state)
}

async function browse(url) {
  await openTab('Browser')
  const addr = page.getByTestId('browser-address')
  await addr.fill(url)
  await addr.press('Enter')
  return addr
}

await scenario(14, 'Certificate states, curl -k and the browser warning', async () => {
  if (!(await page.getByTestId('capture-drawer').isVisible().catch(() => false))) await page.getByTestId('capture-toggle').click()
  await setSpeed('3')
  await setCertificate('self-signed')
  await shot('14a-certificate-setting')
  await terminalOn("Patient's Laptop")
  await clearTerm(); await clearCapture()
  await cmd('curl -v https://www.careconnect.example')
  let o = await output()
  check('self-signed: curl (60)', o.includes('curl: (60) SSL certificate problem: self-signed certificate'))
  check('self-signed: no page', !o.includes('<!DOCTYPE html>'))
  await page.waitForTimeout(300)
  const tls = (await rowTexts()).map(cols).filter((x) => x.proto === 'TLS')
  check('capture: ClientHello, ServerHello, then an encrypted alert — no GET',
    tls.length === 3 && tls[0].info.startsWith('Client Hello') && tls[2].info.startsWith('🔒'), tls.map((x) => x.info).join(' | '))
  await shot('14b-curl-self-signed')

  await clearTerm()
  await cmd('curl -vk https://www.careconnect.example')
  o = await output()
  check('-k: continuing anyway, and the page', o.includes('SSL certificate verify result: self-signed certificate, continuing anyway.') && o.includes('<!DOCTYPE html>'))
  check('-k: ⓘ explains what was skipped', o.includes('ⓘ -k skipped the certificate check'))
  await shot('14c-curl-k')

  await browse('https://www.careconnect.example')
  await page.getByTestId('cert-warning').waitFor({ timeout: 30000 })
  const warning = await page.getByTestId('cert-warning').innerText()
  check('browser: "Your connection is not private"', warning.includes('Your connection is not private'))
  check('browser: reason and NET::ERR_CERT_AUTHORITY_INVALID', warning.includes('signed by the server itself') && warning.includes('NET::ERR_CERT_AUTHORITY_INVALID'))
  check('browser: no way to proceed', (await page.getByTestId('cert-warning').getByRole('button').count()) === 0)
  check('browser: red Not secure chip', await page.getByTestId('cert-error-chip').isVisible())
  await shot('14d-browser-warning')

  for (const [state, expected] of [
    ['expired', 'curl: (60) SSL certificate problem: certificate has expired'],
    ['wrong-name', "curl: (60) SSL: no alternative certificate subject name matches target host name 'www.careconnect.example'"],
  ]) {
    await setCertificate(state)
    await terminalOn("Patient's Laptop")
    await clearTerm()
    await cmd('curl https://www.careconnect.example')
    check(`${state}: ${expected.slice(0, 48)}…`, (await output()).includes(expected))
  }
  await setCertificate('valid')
})

await scenario(15, 'HTTP → HTTPS redirect and curl -I', async () => {
  await selectNode('CareConnect Web')
  await openTab('Services')
  await page.getByTestId('redirect-http').check()
  await terminalOn("Patient's Laptop")
  await clearTerm(); await clearCapture()
  await cmd('curl -v http://www.careconnect.example')
  let o = await output()
  check('301 Moved Permanently with Location', o.includes('< HTTP/1.1 301 Moved Permanently') && o.includes('< Location: https://www.careconnect.example/'))
  await page.waitForTimeout(300)
  check('capture: the 301 is readable', (await rowTexts()).some((t) => t.includes('301 Moved Permanently') && !t.includes('🔒')))
  await shot('15a-curl-301')

  await clearTerm()
  await cmd('curl -I http://www.careconnect.example')
  o = await output()
  check('curl -I: headers only, with Location', o.includes('Location: https://www.careconnect.example/') && !o.includes('<!DOCTYPE html>'))

  const addr = await browse('http://www.careconnect.example')
  await page.getByTestId('secure-chip').waitFor({ timeout: 40000 })
  check('browser follows the redirect to https://', (await addr.inputValue()).startsWith('https://'))
  await shot('15b-browser-redirected')

  await selectNode('CareConnect Web')
  await openTab('Services')
  await page.getByTestId('redirect-http').uncheck()
  await terminalOn("Patient's Laptop")
  await clearTerm()
  await cmd('curl -I https://www.careconnect.example')
  o = await output()
  check('curl -I https: 200 OK headers, no body', o.includes('HTTP/1.1 200 OK') && o.includes('Content-Length:') && !o.includes('<!DOCTYPE html>'))
  await shot('15c-curl-I')
})

await scenario(16, 'SMTP relay on port 25', async () => {
  await terminalOn('Reception PC')
  await clearTerm(); await clearCapture()
  await cmd('smtp reception@careconnect.example referrals@gp-clinic.example "Referral"')
  const o = await output()
  check('accepted (250 OK queued)', o.includes('250 OK queued'))
  check("ⓘ passes the message on, port 25", o.includes("ⓘ Your server passes the message to the recipient's server on port 25."))
  await page.waitForTimeout(300)
  await filter('SMTP')
  const relay = (await rowTexts()).map(cols).filter((x) => x.dst.endsWith(':25') || x.src.endsWith(':25'))
  check('capture: relay rows from the mail server (203.0.113.25) to port 25', relay.length > 0 && relay.some((x) => x.src.startsWith('203.0.113.25:') && x.dst.endsWith(':25')))
  check('capture: the relayed message is readable', relay.some((x) => x.info.startsWith('Message:') && !x.info.includes('🔒')))
  await shot('16-smtp-relay')
  await filter('All')
})

await scenario(17, 'DHCP and ssh in the capture', async () => {
  await terminalOn("Patient's Laptop")
  await clearTerm(); await clearCapture()
  await cmd('dhclient')
  await page.waitForTimeout(300)
  await filter('DHCP')
  const dhcp = (await rowTexts()).map(cols)
  check('DHCP: Discover, Offer, Request, ACK', dhcp.length === 4 && ['Discover', 'Offer', 'Request', 'ACK'].every((k, i) => dhcp[i].info.includes(`DHCP ${k}`)), dhcp.map((x) => x.info).join(' | '))
  check('DHCP: 0.0.0.0:68 → 255.255.255.255:67', dhcp[0]?.src === '0.0.0.0:68' && dhcp[0]?.dst === '255.255.255.255:67')
  await shot('17a-dhcp')
  await filter('All')

  await terminalOn('Reception PC')
  await clearTerm(); await clearCapture()
  await cmd('ssh 203.0.113.21')
  await page.waitForTimeout(300)
  await filter('SSH')
  const ssh = (await rowTexts()).map(cols)
  const kex = ssh.findIndex((x) => x.info.includes('Key Exchange Reply'))
  check('ssh: banners and key exchange readable', kex > 0 && ssh.slice(0, kex + 1).every((x) => !x.info.startsWith('🔒')))
  check('ssh: everything after is encrypted', ssh.slice(kex + 1).length > 0 && ssh.slice(kex + 1).every((x) => x.info.startsWith('🔒')))
  check('ssh: still enters the session', (await page.locator('aside').last().innerText()).includes('SSH → File Server'))
  await shot('17b-ssh')
  await cmd('exit')
  await filter('All')
})

await scenario(18, 'Layer labels by name', async () => {
  await page.getByRole('button', { name: 'Layers' }).click()
  const labels = page.getByTestId('layer-label')
  const texts = await labels.allInnerTexts()
  check('labels are names, not numbers', texts.includes('Application') && texts.includes('Link') && texts.includes('Internet') && !texts.some((t) => /^L\d/.test(t)), [...new Set(texts)].join(', '))
  const title = await labels.filter({ hasText: /^Application$/ }).first().getAttribute('title')
  check('tooltip gives the OSI equivalent', title?.includes('OSI layers 5–7'), title ?? '')
  await shot('18-layer-labels')
  await page.getByRole('button', { name: 'Layers' }).click()
})

async function tapEdge(edgeId) {
  // Close the side panel so the whole network is in view
  await page.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } })
  await page.waitForTimeout(500)
  // Click a point on the line itself that no device covers, as a person would
  const pt = await page.evaluate((id) => {
    const path = document.querySelector(`[data-testid="rf__edge-${id}"] path.react-flow__edge-path`)
    for (const f of [0.3, 0.7, 0.2, 0.8, 0.5]) {
      const p = path.getPointAtLength(path.getTotalLength() * f)
      const m = path.getScreenCTM()
      const x = p.x * m.a + p.y * m.c + m.e, y = p.x * m.b + p.y * m.d + m.f
      if (document.elementFromPoint(x, y)?.closest(`[data-testid="rf__edge-${id}"]`)) return { x, y }
    }
    return null
  }, edgeId)
  if (!pt) throw new Error(`no clickable point on ${edgeId}`)
  await page.mouse.click(pt.x, pt.y)
  await page.getByTestId('tap-link').first().click()
}

await scenario(19, 'Tap a link', async () => {
  await clearCapture()
  await tapEdge('cc-e1')
  const note = await page.getByTestId('tap-note').innerText()
  check("drawer note: Tapping: Patient's Laptop ⇄ Home Gateway (Wi-Fi)", note.includes("Tapping: Patient's Laptop ⇄ Home Gateway (Wi-Fi)"), note)
  await terminalOn('Reception PC')
  await clearTerm()
  await cmd('curl http://www.careconnect.example')
  await page.waitForTimeout(300)
  check("the clinic's traffic is not on the patient's link", (await rows().count()) === 0, String(await rows().count()))
  await terminalOn("Patient's Laptop")
  await clearTerm()
  await cmd('curl http://www.careconnect.example')
  await page.waitForTimeout(300)
  const wifi = await detailOf((t) => cols(t).info.startsWith('GET'))
  check('on the Wi-Fi link: laptop MAC → home gateway MAC', wifi?.includes('src aa:bb:cc:01:01:01 → dst aa:bb:cc:01:00:01') && wifi?.includes('on the tapped link'), wifi?.split('\n').find((l) => l.includes('Ethernet')))
  await shot('19a-tap-wifi')

  await page.getByTestId('tap-all').click()
  await tapEdge('cc-e6')
  await clearCapture()
  await terminalOn("Patient's Laptop")
  await clearTerm()
  await cmd('curl http://www.careconnect.example')
  await page.waitForTimeout(300)
  const lan = await detailOf((t) => cols(t).info.startsWith('GET'))
  check('on the web server link: router MAC → web server MAC, same IPs', lan?.includes('src aa:bb:cc:02:00:01 → dst aa:bb:cc:02:00:80') && lan?.includes('192.168.1.'), lan?.split('\n').filter((l) => /IPv4|Ethernet/.test(l)).join(' / '))
  await shot('19b-tap-server-link')
  await page.getByTestId('tap-all').click()
  check('Tap: all clears it', !(await page.getByTestId('tap-note').isVisible().catch(() => false)))
})

await scenario(20, 'Step mode', async () => {
  await terminalOn("Patient's Laptop")
  await cmd('flushdns')   // earlier curls cached the name; this one should ask the DNS server
  await clearCapture()
  await page.getByTestId('step-toggle').click()
  await terminalOn("Patient's Laptop")
  await clearTerm()
  await termIn().fill('curl http://www.careconnect.example')
  await termIn().press('Enter')
  await page.getByTestId('step-label').waitFor({ timeout: 5000 })
  await page.waitForTimeout(800)
  check('paused before the first step: nothing captured yet', (await rows().count()) === 0, String(await rows().count()))
  check('names the next step', /Standard query 0x[0-9a-f]{4} A www\.careconnect\.example/.test(await page.getByTestId('step-label').innerText()))
  await shot('20a-step-paused')
  await page.getByTestId('step-next').click()
  await page.waitForTimeout(1500)
  check('Next plays one step', (await rows().count()) === 1, String(await rows().count()))
  // The space bar works when the user isn't typing
  await page.evaluate(() => (document.activeElement)?.blur())
  await page.keyboard.press('Space')
  await page.waitForTimeout(1500)
  check('space bar plays the next step', (await rows().count()) === 2, String(await rows().count()))
  check('the terminal waits meanwhile', await termIn().getAttribute('readonly') !== null)
  await shot('20b-step-next')
  await page.getByTestId('step-toggle').click()
  await page.waitForFunction(() => !document.querySelector('[data-testid=terminal-input]')?.hasAttribute('readonly'), null, { timeout: 30000 })
  check('leaving step mode finishes the command', (await output()).includes('CareConnect'))
})

await scenario(21, 'Private addresses and default gateways', async () => {
  await clearCapture()
  await terminalOn("Patient's Laptop")
  await clearTerm()
  await cmd('ping 10.0.0.11')
  let o = await output()
  check("patient can't ping the clinic's private 10.0.0.11", o.includes('Request timeout for icmp_seq 0') && !o.includes('bytes from'))
  check('ⓘ explains private addresses', o.includes('ⓘ 10.0.0.11 is a private address (10.0.0.0/8)'))
  await page.waitForTimeout(300)
  const icmp = (await rowTexts()).map(cols).filter((x) => x.proto === 'ICMP')
  check('capture: echo requests only, no replies', icmp.length === 4 && icmp.every((x) => x.info.includes('request')), icmp.map((x) => x.info).join(' | '))
  await shot('21a-private-address')
  await clearTerm()
  await cmd('ping 198.51.100.77')
  check("the clinic gateway's public address answers", (await output()).includes('64 bytes from 198.51.100.77'))

  // Remove the Reception PC's default gateway in Configure
  await selectNode('Reception PC')
  await openTab('Configure')
  const gw = aside().locator('label:has-text("Default Gateway") + input')
  await gw.fill('')
  await terminalOn('Reception PC')
  await clearTerm()
  await cmd('ping 203.0.113.80')
  o = await output()
  check('no default gateway: Network is unreachable', o.includes('ping: sendto: Network is unreachable') && o.includes('no default gateway'))
  await clearTerm()
  await cmd('ping 10.0.0.13')
  check('…but the local network still works', (await output()).includes('64 bytes from 10.0.0.13'))
  await shot('21b-no-gateway')
  await selectNode('Reception PC')
  await openTab('Configure')
  await aside().locator('label:has-text("Default Gateway") + input').fill('10.0.0.1')
})

// ── Phase 4 (NETWORX_PHASE4_SPEC.md §4) and Phase 3 ─────────────────────────

async function setPower(label, online) {
  await selectNode(label)
  await openTab('Configure')
  const btn = aside().getByRole('button', { name: online ? 'Offline' : 'Online', exact: true })
  if (await btn.count()) await btn.click()
}

async function setField(label, field, value) {
  await selectNode(label)
  await openTab('Configure')
  await aside().locator(`label:has-text("${field}") + input`).first().fill(value)
}

const hopNames = (o) => o.split('\n').filter((l) => /^ \d+ {2}/.test(l)).map((l) => (l.match(/\((.*?)\)/) ?? [])[1])

await scenario(22, 'A1 — DNS server offline: timeouts, not NXDOMAIN', async () => {
  if (!(await page.getByTestId('capture-drawer').isVisible().catch(() => false))) await page.getByTestId('capture-toggle').click()
  await setSpeed('3')
  await setPower('DNS Server', false)
  await terminalOn("Patient's Laptop")
  await clearTerm(); await cmd('flushdns'); await clearCapture()
  await cmd('nslookup www.careconnect.example')
  let o = await output()
  check('nslookup: no servers could be reached', o.includes(';; connection timed out; no servers could be reached'))
  check('never 8.8.8.8 or NXDOMAIN', !o.includes('8.8.8.8') && !o.includes('NXDOMAIN'))
  await page.waitForTimeout(300)
  const dns = (await rowTexts()).map(cols).filter((r) => r.proto === 'DNS')
  check('capture: 3 queries to 203.0.113.53:53, no response', dns.length === 3 && dns.every((r) => r.dst === '203.0.113.53:53'), dns.map((r) => `${r.dst} ${r.info}`).join(' | '))
  await shot('22a-dns-offline-nslookup')
  await clearTerm()
  await cmd('curl http://www.careconnect.example')
  o = await output()
  check('curl: could not resolve + the ⓘ', o.includes('curl: (6) Could not resolve host: www.careconnect.example') && o.includes("ⓘ The DNS server 203.0.113.53 didn't answer, so the name couldn't be turned into an IP address. Connecting by IP address still works."))
  await clearTerm()
  await cmd('curl http://203.0.113.80')
  check('curl by IP address: the page', (await output()).includes('CareConnect Medical Centre'))
  await shot('22b-dns-offline-curl')
  await setPower('DNS Server', true)
})

await scenario(23, 'A2 — traceroute shows only routing devices', async () => {
  await terminalOn("Patient's Laptop")
  await clearTerm()
  await cmd('traceroute 203.0.113.80')
  const o = await output()
  const names = hopNames(o)
  check('Home Gateway, 3 backbone hops, CareConnect Router, CareConnect Web',
    JSON.stringify(names) === JSON.stringify(['Home Gateway', 'ISP Gateway', 'Backbone router', 'Exchange point', 'CareConnect Router', 'CareConnect Web']), names.join(', '))
  check('no switch, no 0.0.0.0', !o.includes('Server Switch') && !o.includes('0.0.0.0'))
  await shot('23a-traceroute')
  await terminalOn("Doctor's PC")
  await clearTerm()
  await cmd('traceroute 10.0.0.11')
  const one = hopNames(await output())
  check("Doctor's PC → 10.0.0.11: one line", one.length === 1 && one[0] === 'Reception PC', one.join(', '))
})

await scenario(24, 'A3 — TTL drops only at routers', async () => {
  await terminalOn("Doctor's PC")
  await clearTerm()
  await cmd('ping 10.0.0.11')
  const same = [...(await output()).matchAll(/ttl=(\d+)/g)].map((m) => Number(m[1]))
  check('same subnet: ttl=64', same.length === 4 && same.every((t) => t === 64), same.join(','))
  await clearTerm()
  await cmd('ping 203.0.113.80')
  const far = [...(await output()).matchAll(/ttl=(\d+)/g)].map((m) => Number(m[1]))
  check('across routers: ttl lower than 64', far.length === 4 && far.every((t) => t < 64), far.join(','))
  await shot('24-ttl')
})

await scenario(25, 'A4 — mismatched subnet masks', async () => {
  await clearCapture()
  await setField("Doctor's PC", 'IP Address', '10.0.1.13')
  await setField("Doctor's PC", 'Subnet Mask', '255.255.0.0')
  await terminalOn("Doctor's PC")
  await clearTerm()
  await cmd('ping 10.0.0.11')
  const o = await output()
  check('ping times out', o.includes('Request timeout for icmp_seq 0') && !o.includes('bytes from'))
  check('the mismatched-mask ⓘ', o.includes("ⓘ Doctor's PC (10.0.1.13/16) thinks 10.0.0.11 is on its own subnet, but Reception PC (10.0.0.11/24) thinks 10.0.1.13 is on another one, so it sends the reply to its gateway 10.0.0.1 — which can't deliver it. Both ends of a subnet must use the same mask."))
  await page.waitForTimeout(300)
  // Only this ping's rows (the last scenario's echoes may still be arriving)
  const icmp = (await rowTexts()).map(cols).filter((r) => r.proto === 'ICMP' && (r.src === '10.0.1.13' || r.dst === '10.0.1.13'))
  check('capture: requests, no replies', icmp.length > 0 && icmp.every((r) => r.src === '10.0.1.13' && r.info.includes('request')), icmp.map((r) => `${r.src}→${r.dst} ${r.info}`).join(' | '))
  await shot('25-mismatched-mask')
  await setField("Doctor's PC", 'IP Address', '10.0.0.13')
  await setField("Doctor's PC", 'Subnet Mask', '255.255.255.0')
  await terminalOn("Doctor's PC")
  await clearTerm()
  await cmd('ping 10.0.0.11')
  check('restored: ping works', (await output()).includes('64 bytes from 10.0.0.11'))
})

await scenario(26, 'B1 — the DNS Server setting', async () => {
  await terminalOn("Doctor's PC")
  await clearTerm()
  await cmd('ipconfig')
  check('ipconfig: DNS Servers . . . . : 203.0.113.53', (await output()).includes('DNS Servers  . . . . : 203.0.113.53'))
  await setField("Doctor's PC", 'DNS Server', '203.0.113.99')
  await shot('26a-dns-server-field')
  await terminalOn("Doctor's PC")
  await clearTerm()
  await cmd('nslookup www.careconnect.example')
  check('wrong DNS server: nslookup times out', (await output()).includes(';; connection timed out; no servers could be reached'))
  await clearTerm()
  await cmd('ping 203.0.113.80')
  check('ping by IP still works', (await output()).includes('64 bytes from 203.0.113.80'))
  await setField("Doctor's PC", 'DNS Server', '203.0.113.53')

  // DHCP hands out the DNS server (the Patient's Laptop, with its DNS server cleared, stands in for a new laptop)
  await setField("Patient's Laptop", 'DNS Server', '')
  await terminalOn("Patient's Laptop")
  await clearTerm(); await clearCapture()
  await cmd('dhclient')
  check('dhclient output: DNS server 203.0.113.53', (await output()).includes('DNS server 203.0.113.53'))
  await page.waitForTimeout(300)
  const offer = await detailOf('DHCP Offer')
  check('DHCP Offer: domain name server 203.0.113.53', !!offer && offer.includes('domain name server: 203.0.113.53'))
  await clearTerm()
  await cmd('ipconfig')
  check('the laptop now uses 203.0.113.53', (await output()).includes('DNS Servers  . . . . : 203.0.113.53'))
  await shot('26b-dhcp-dns')
})

await scenario(27, 'B2/B3 — record types and dig', async () => {
  await terminalOn("Patient's Laptop")
  await clearTerm(); await cmd('flushdns'); await clearCapture()
  await cmd('dig www.careconnect.example')
  let o = await output()
  check('CNAME then A', /www\.careconnect\.example\. 300\tIN\tCNAME\tcareconnect\.example\.\ncareconnect\.example\. +3600\tIN\tA\t203\.0\.113\.80/.test(o))
  check('aa flag', o.includes(';; flags: qr aa rd ra;'))
  check('CNAME and TTL notes', o.includes('ⓘ CNAME: www.careconnect.example is an alias for careconnect.example') && o.includes('ⓘ 300 and 3600 are TTLs'))
  await page.waitForTimeout(300)
  const resp = (await rowTexts()).map(cols).find((r) => r.info.startsWith('Standard query response'))
  check('capture: the response shows the CNAME then the A', !!resp && /CNAME careconnect\.example A 203\.0\.113\.80/.test(resp.info), resp?.info)
  await shot('27a-dig')
  await clearTerm()
  await cmd('dig careconnect.example MX')
  check('MX: 10 mail.careconnect.example.', (await output()).includes('10 mail.careconnect.example.'))
  await clearTerm()
  await cmd('dig careconnect.example AAAA')
  check('AAAA: 2001:db8:cc::80', (await output()).includes('2001:db8:cc::80'))
  await clearTerm()
  await cmd('dig nope.careconnect.example')
  check('NXDOMAIN', (await output()).includes('status: NXDOMAIN'))
  await clearTerm()
  await cmd('nslookup -type=mx careconnect.example')
  o = await output()
  check('nslookup -type=mx: mail exchanger line', o.includes('mail exchanger = 10 mail.careconnect.example.'))
  await shot('27b-nslookup-mx')
  // The Records tab
  await selectNode('DNS Server')
  await openTab('Records')
  check('Records tab: Name · Type · Value · TTL with 9 records', (await page.getByTestId('dns-record-row').count()) === 9)
  await page.getByTestId('dns-name').fill('bad.careconnect.example')
  await page.getByTestId('dns-value').fill('203.0.113.999')
  await page.getByTestId('dns-save').click()
  check('an invalid record shows an inline error and is not saved', (await page.getByTestId('dns-error').innerText()).includes('IPv4') && (await page.getByTestId('dns-record-row').count()) === 9)
  await shot('27c-records-tab')
  await page.getByTestId('dns-name').fill('')
  await page.getByTestId('dns-value').fill('')
})

async function editARecord(fromIp, toIp) {
  await selectNode('DNS Server')
  await openTab('Records')
  const row = page.getByTestId('dns-record-row').filter({ hasText: fromIp }).filter({ has: page.locator('td', { hasText: /^A$/ }) }).first()
  await row.getByTestId('dns-edit').click()
  await page.getByTestId('dns-value').fill(toIp)
  await page.getByTestId('dns-save').click()
}

await scenario(28, 'B4 — the DNS cache honours TTL', async () => {
  await terminalOn("Patient's Laptop")
  await clearTerm(); await cmd('flushdns'); await clearCapture()
  await cmd('dig careconnect.example')
  const ttl1 = Number(((await output()).match(/careconnect\.example\. +(\d+)\tIN\tA/) ?? [])[1])
  await page.waitForTimeout(2500)
  await clearTerm(); await clearCapture()
  await cmd('dig careconnect.example')
  const o = await output()
  const ttl2 = Number((o.match(/careconnect\.example\. +(\d+)\tIN\tA/) ?? [])[1])
  await page.waitForTimeout(300)
  check('second dig: no capture rows', (await rows().count()) === 0, String(await rows().count()))
  check('second dig: a lower TTL', ttl2 < ttl1, `${ttl1} → ${ttl2}`)
  check('second dig: the cache ⓘ', o.includes("ⓘ Answered from this device's cache — nothing was sent. It stays cached until the TTL runs out."))
  await shot('28a-cache')
  await editARecord('203.0.113.80', '203.0.113.25')
  await terminalOn("Patient's Laptop")
  await clearTerm()
  await cmd('dig careconnect.example +short')
  check('after the edit: still 203.0.113.80 (cached)', (await output()).trim().endsWith('203.0.113.80'))
  await cmd('dnscache')
  check('dnscache lists the entry', /careconnect\.example +A +\d+ s +203\.0\.113\.80/.test(await output()))
  await cmd('flushdns')
  await clearTerm()
  await cmd('dig careconnect.example +short')
  check('after flushdns: 203.0.113.25', (await output()).trim().endsWith('203.0.113.25'))
  await shot('28b-flushdns')
  await editARecord('203.0.113.25', '203.0.113.80')
  await terminalOn("Patient's Laptop")
  await cmd('flushdns')
})

await scenario(29, 'B5 — dig +trace', async () => {
  await terminalOn("Patient's Laptop")
  await clearTerm(); await clearCapture()
  await cmd('dig +trace www.careconnect.example')
  const o = await output()
  check('root servers a to m', 'abcdefghijklm'.split('').every((l) => o.includes(`${l}.root-servers.net.`)))
  check('example. → a.tld-servers.example', /example\.\s+172800\tIN\tNS\ta\.tld-servers\.example\./.test(o))
  check('careconnect.example. NS ns1', /careconnect\.example\.\s+3600\tIN\tNS\tns1\.careconnect\.example\./.test(o))
  check('the answer from ns1', o.includes('203.0.113.80') && o.includes('#53(ns1.careconnect.example)'))
  check('the simulated-TLD ⓘ', o.includes('ⓘ Networx pretends .example is a real top-level domain'))
  await page.waitForTimeout(300)
  const q = (await rowTexts()).map(cols).filter((r) => r.proto === 'DNS' && r.dst.endsWith(':53'))
  check('queries: resolver, root, TLD, ns1', JSON.stringify(q.map((r) => r.dst)) === JSON.stringify(['203.0.113.53:53', '198.41.0.4:53', '192.0.2.10:53', '203.0.113.53:53']), q.map((r) => r.dst).join(', '))
  await shot('29-dig-trace')
})

/** Export the current network, change it, and import it. */
async function importVariant(name, change) {
  const path = join(SHOTS, `${name}.json`)
  await loadCareConnect()
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^Save$/ }).click()])
  await dl.saveAs(path)
  const net = JSON.parse(readFileSync(path, 'utf8'))
  change(net)
  writeFileSync(path, JSON.stringify(net, null, 2))
  await page.locator('input[type=file]').setInputFiles(path)
  await page.waitForTimeout(500)
}

await scenario(30, 'B6 — a secondary DNS server as the alternate', async () => {
  await importVariant('b6-two-dns', (net) => {
    const dns = net.nodes.find((n) => n.id === 'ccdns')
    net.nodes.push({ ...dns, id: 'ccdns2', position: { x: dns.position.x - 170, y: dns.position.y - 40 }, data: { ...dns.data, label: 'DNS Server 2', ip: '203.0.113.54', mac: 'aa:bb:cc:02:00:54', dnsPrimary: '203.0.113.53' } })
    net.edges.push({ id: 'dns2-e1', source: 'ccsw', target: 'ccdns2' })
    net.nodes.find((n) => n.id === 'patient').data.dnsAlternate = '203.0.113.54'
  })
  await page.locator('.react-flow__node', { hasText: 'DNS Server 2' }).waitFor()
  await selectNode('DNS Server 2')
  await openTab('Records')
  check('secondary: copying from 203.0.113.53', await page.getByTestId('dns-secondary').isChecked())
  await shot('30a-secondary')
  await setPower('DNS Server', false)
  await terminalOn("Patient's Laptop")
  await clearTerm(); await clearCapture()
  await cmd('ipconfig')
  check('ipconfig shows both DNS servers', /DNS Servers {2}\. \. \. \. : 203\.0\.113\.53\n\s+203\.0\.113\.54/.test(await output()))
  await clearTerm()
  await cmd('curl http://www.careconnect.example')
  check('curl works after the first server\'s timeouts', (await output()).includes('CareConnect Medical Centre'))
  await page.waitForTimeout(300)
  const dns = (await rowTexts()).map(cols).filter((r) => r.proto === 'DNS')
  check('capture shows both servers', dns.filter((r) => r.dst === '203.0.113.53:53').length === 3 && dns.some((r) => r.dst === '203.0.113.54:53') && dns.some((r) => r.src === '203.0.113.54:53'), dns.map((r) => `${r.src}→${r.dst}`).join(' | '))
  await shot('30b-alternate-dns')
  await loadCareConnect()
})

await scenario(31, 'Phase 3 — firewall rules', async () => {
  await importVariant('phase3-firewall', (net) => {
    const router = net.nodes.find((n) => n.id === 'ccrouter')
    net.nodes.push({ id: 'ccfw', type: 'device', position: { x: 440, y: 205 }, data: { ...router.data, label: 'CareConnect Firewall', deviceType: 'firewall', ip: '198.51.100.2', wanIp: '', mac: 'aa:bb:cc:02:00:fe', notes: '', rules: [
      { id: 'r1', direction: 'in', protocol: 'TCP', srcIp: '*', dstIp: '*', port: '22', action: 'allow' },
      { id: 'r2', direction: 'in', protocol: 'TCP', srcIp: '*', dstIp: '*', port: '443', action: 'allow' },
      { id: 'r3', direction: 'in', protocol: 'TCP', srcIp: '*', dstIp: '*', port: '80', action: 'allow' },
      { id: 'r4', direction: 'in', protocol: 'ANY', srcIp: '*', dstIp: '*', port: '*', action: 'deny' },
    ] } })
    net.edges = net.edges.filter((e) => e.id !== 'cc-e3')
    net.edges.push({ id: 'fw-e1', source: 'net', target: 'ccfw' }, { id: 'fw-e2', source: 'ccfw', target: 'ccrouter' })
  })
  await page.locator('.react-flow__node', { hasText: 'CareConnect Firewall' }).waitFor()
  await terminalOn('Reception PC')
  await clearTerm(); await clearCapture()
  await cmd('curl http://203.0.113.80')
  check('HTTP is let in', (await output()).includes('CareConnect Medical Centre'))
  await clearTerm()
  await termIn().fill('ftp 203.0.113.21 ls')
  await termIn().press('Enter')
  await page.getByTestId('packet-dropped').first().waitFor({ timeout: 15000 })
  await shot('31a-firewall-drop')
  check('the dropped packet shows a red ✕ at the firewall', (await page.getByTestId('packet-dropped').count()) > 0)
  await page.waitForFunction(() => !document.querySelector('[data-testid=terminal-input]')?.hasAttribute('readonly'), null, { timeout: 60000 })
  const o = await output()
  check('ftp: Operation timed out, and which rule dropped it', o.includes('ftp: connect: Operation timed out') && o.includes("CareConnect Firewall's firewall dropped it: rule 4 (in ANY * deny)"))
  await page.waitForTimeout(300)
  const syn = (await rowTexts()).map(cols).filter((r) => r.dst === '203.0.113.21:21')
  check('capture: three SYNs to port 21, no answer', syn.length === 3 && !(await rowTexts()).some((t) => t.includes('203.0.113.21:21') && t.includes('[SYN, ACK]')), syn.length)
  await clearTerm()
  await cmd('sftp 203.0.113.21 ls')
  check('SFTP (port 22) is let in', (await output()).includes('referrals.csv'))
  // Add a rule allowing FTP and move it above the deny: rule order matters
  await selectNode('CareConnect Firewall')
  await openTab('Security')
  await aside().getByRole('button', { name: /Add Rule/ }).click()
  const added = page.getByTestId('firewall-rule').last()
  await added.locator('input').first().fill('21')
  const n = await page.getByTestId('firewall-rule').count()
  for (let i = n - 1; i > 0; i--) await page.getByTestId('firewall-rule').nth(i).getByTestId('rule-up').click()
  await shot('31b-rules-reordered')
  const first = await page.getByTestId('firewall-rule').first().locator('input').first().inputValue()
  check('the new rule is now rule 1 (port 21, allow)', first === '21', first)
  await terminalOn('Reception PC')
  await clearTerm()
  await cmd('ftp 203.0.113.21 ls')
  check('with in TCP 21 allow at the top, FTP gets through', (await output()).includes('referrals.csv'))
  await loadCareConnect()
})

await scenario(32, 'Configure: Manual or Automatic (DHCP) address', async () => {
  await loadCareConnect()
  if (!(await page.getByTestId('capture-drawer').isVisible().catch(() => false))) await page.getByTestId('capture-toggle').click()
  await clearCapture()
  // The Patient's Laptop is on the home gateway, which runs a DHCP server
  await selectNode("Patient's Laptop")
  await openTab('Configure')
  const ip = aside().getByTestId('ip-address')
  check('starts as Manual, address editable',
    (await aside().getByTestId('ip-mode-manual').getAttribute('aria-pressed')) === 'true' && (await ip.getAttribute('readonly')) === null)
  await aside().getByTestId('ip-mode-dhcp').click()
  await page.waitForFunction(() => document.querySelector('[data-testid=dhcp-status]')?.textContent?.startsWith('Leased'), null, { timeout: 30000 })
  const status = await aside().getByTestId('dhcp-status').innerText()
  check('lease from the Home Gateway', /Leased 192\.168\.1\.\d+ from Home Gateway \(192\.168\.1\.1\)/.test(status), status)
  check('address fields become read-only', (await ip.getAttribute('readonly')) !== null)
  check('gateway and mask come from the gateway',
    (await aside().getByTestId('default-gateway').inputValue()) === '192.168.1.1' && (await aside().getByTestId('subnet-mask').inputValue()) === '255.255.255.0')
  await page.waitForTimeout(300)
  const dhcp = (await rowTexts()).map(cols).filter((r) => r.proto === 'DHCP')
  check('Discover, Offer, Request, ACK in the capture', dhcp.length === 4, `${dhcp.length} DHCP rows`)
  await shot('32-dhcp-configure')
  await aside().getByTestId('ip-mode-manual').click()
  check('Manual again: editable, address kept', (await ip.getAttribute('readonly')) === null && (await ip.inputValue()).startsWith('192.168.1.'))
  // Reception PC: the clinic gateway's DHCP server is switched off
  await selectNode('Reception PC')
  await openTab('Configure')
  await aside().getByTestId('ip-mode-dhcp').click()
  const err = await aside().getByTestId('dhcp-status').innerText()
  check('no DHCP server: says so, and the PC is left without an address',
    err.includes('No DHCP server found') && (await aside().getByTestId('ip-address').inputValue()) === '', err)
  await shot('32-dhcp-no-server')
  await loadCareConnect()
})

await scenario(33, 'ISP routes: a public network is reachable only while it is announced', async () => {
  await loadCareConnect()
  await selectNode('Internet')
  await openTab('Configure')
  await openTab('Routing')
  const ispRows = aside().getByTestId('isp-route-row')
  const first = (await ispRows.count()) === 1 ? await ispRows.first().innerText() : ''
  check('the Internet node lists 203.0.113.0/24 → 198.51.100.1 (CareConnect Router)',
    first.includes('203.0.113.0/24') && first.includes('198.51.100.1 (CareConnect Router)'), first)
  await shot('33a-isp-table')

  // Withdraw it from the CareConnect Router's Routing tab
  await selectNode('CareConnect Router')
  await openTab('Configure')
  await openTab('Routing')
  const status = () => aside().getByTestId('announce-status').innerText()
  check('router: announced', (await status()).startsWith('Announced'), await status())
  await aside().getByTestId('withdraw-button').click()
  check('router: not announced after Withdraw', (await status()).startsWith('Not announced'), await status())
  await shot('33c-not-announced')
  await terminalOn("Patient's Laptop")
  await clearTerm()
  await cmd('curl http://203.0.113.80')
  const o = await output()
  check('curl times out', o.includes('curl: (28) Failed to connect to 203.0.113.80 port 80'))
  check('the ⓘ names the missing route', o.includes('no ISP has a route for 203.0.113.0/24'))
  await shot('33b-no-route')

  // Add it back by hand in the Internet node's table; a private network is refused
  await selectNode('Internet')
  await openTab('Configure')
  await openTab('Routing')
  const addRoute = async (network, hop) => {
    await aside().getByTestId('isp-network').fill(network)
    await aside().getByTestId('isp-next-hop').fill(hop)
    await aside().getByTestId('isp-add').click()
  }
  await addRoute('10.0.0.0/24', '198.51.100.77')
  const refusal = await aside().getByTestId('isp-error').innerText().catch(() => '')
  check('a private network is refused', refusal.includes('is private'), refusal)
  await addRoute('203.0.113.0/24', '198.51.100.1')
  check('the route is back', (await ispRows.count()) === 1)
  await terminalOn("Patient's Laptop")
  await clearTerm()
  await cmd('curl http://203.0.113.80')
  check('curl works again', (await output()).includes('CareConnect Medical Centre'))
  await loadCareConnect()
})

await scenario(34, 'DNS forwarder: a name the server does not hold is asked upstream', async () => {
  await loadCareConnect()
  await selectNode('DNS Server')
  await openTab('Configure')
  const field = aside().getByTestId('dns-forwarder')
  check('the DNS server forwards to 8.8.8.8', (await field.inputValue()) === '8.8.8.8', await field.inputValue())
  await shot('34a-forwarder-field')
  await terminalOn('CareConnect Web')
  await clearTerm(); await clearCapture()
  await cmd('dig example.com')
  const o = await output()
  check('answered, not authoritative', o.includes('93.184.216.34') && o.includes(';; flags: qr rd ra;'))
  check('the forwarder ⓘ', o.includes('so it asked its forwarder (8.8.8.8) and passed the answer on'))
  await page.waitForTimeout(300)
  const dns = (await rowTexts()).map(cols).filter((r) => r.proto === 'DNS')
  const hops = dns.map((r) => `${r.src.replace(/:\d{5}$/, ':eph')}→${r.dst.replace(/:\d{5}$/, ':eph')}`)
  check('capture: client → server → 8.8.8.8 → server → client', JSON.stringify(hops) === JSON.stringify([
    '203.0.113.80:eph→203.0.113.53:53', '203.0.113.53:eph→8.8.8.8:53', '8.8.8.8:53→203.0.113.53:eph', '203.0.113.53:53→203.0.113.80:eph',
  ]), hops.join(' | '))
  await shot('34b-forwarded')
  await clearTerm(); await clearCapture()
  await cmd('nslookup example.com')
  await page.waitForTimeout(300)
  const again = (await rowTexts()).map(cols).filter((r) => r.proto === 'DNS')
  check('second lookup: from the server\'s cache, no upstream leg', again.length === 2 && !again.some((r) => r.dst === '8.8.8.8:53'), String(again.length))
  // No forwarder: the server refuses names it doesn't hold
  await selectNode('DNS Server')
  await openTab('Configure')
  await aside().getByTestId('dns-forwarder').fill('')
  await terminalOn('CareConnect Web')
  await clearTerm()
  await cmd('dig www.google.com')
  check('blank forwarder: REFUSED', (await output()).includes('status: REFUSED'))
  await loadCareConnect()
})

await scenario(35, 'Upstream DNS preset: the DNS Cache tab lists what each cache holds', async () => {
  await page.getByRole('button', { name: 'Presets' }).click()
  const item = page.getByRole('button', { name: /Upstream DNS/ }).first()
  await item.click()
  await item.click()
  const byId = (id) => page.locator(`.react-flow__node[data-id="${id}"]`)
  await byId('dns1').waitFor()
  await page.waitForTimeout(400)
  const cacheTabOf = async (id) => {
    await byId(id).click({ position: { x: 45, y: 20 } })
    await aside().waitFor()
    await openTab('Configure')
    await openTab('DNS Cache')
  }
  await cacheTabOf('dns1')
  check('Local DNS Server: forwarder cache empty at first', await aside().getByTestId('dns-server-cache-empty').isVisible())
  await byId('pc1').click({ position: { x: 45, y: 20 } })
  await openTab('Terminal')
  await clearTerm()
  await cmd('curl http://www.school.local')
  check('the page loads by name', (await output()).includes('Welcome to My Web Server'))
  await cacheTabOf('dns1')
  const served = aside().getByTestId('dns-server-cache')
  const st = await served.innerText()
  check('Local DNS Server lists www.school.local from 202.93.169.10', st.includes('www.school.local') && st.includes('from 202.93.169.10') && st.includes('203.93.169.26'), st)
  const ttl = async () => Number((await served.getByTestId('dns-cache-row').first().locator('td').last().innerText()).replace(/\D/g, ''))
  const before = await ttl()
  await page.waitForTimeout(2200)
  const after = await ttl()
  check('the TTL counts down', after < before && before <= 3600, `${before} → ${after}`)
  await shot('35a-server-cache')
  await cacheTabOf('pc1')
  const own = await aside().getByTestId('dns-cache').innerText()
  check('Desktop PC lists www.school.local from 192.168.1.100', own.includes('www.school.local') && own.includes('from 192.168.1.100'), own)
  await aside().getByTestId('dns-cache-flush').click()
  check('Flush empties it', await aside().getByTestId('dns-cache-empty').isVisible())
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
