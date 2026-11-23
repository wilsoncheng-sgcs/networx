import { type TermContext, type Lines, out } from '../context'
import { listeningServices } from '../services'

/** `ss -tuln`: what this device is listening on. Servers listen; clients start connections. */
export function cmdSs(_args: string[], ctx: TermContext): Lines {
  const node = ctx.nodes.find((n) => n.id === ctx.selfId)!
  const header = out(`${'Netid'.padEnd(7)}${'State'.padEnd(8)}${'Local Address:Port'.padEnd(21)}${'Peer Address:Port'.padEnd(19)}Service`)
  const services = listeningServices(node).sort((a, b) =>
    a.transport === b.transport ? a.port - b.port : a.transport === 'UDP' ? -1 : 1,
  )
  if (services.length === 0) {
    return [header, out('(no listening ports — clients start connections, servers listen)')]
  }
  return [
    header,
    ...services.map((s) => out(
      `${s.transport.toLowerCase().padEnd(7)}${(s.transport === 'UDP' ? 'UNCONN' : 'LISTEN').padEnd(8)}` +
      `${`0.0.0.0:${s.port}`.padEnd(21)}${'0.0.0.0:*'.padEnd(19)}${s.name}`,
    )),
  ]
}

/** `netstat`: with -tuln / -an (or -l) the listening sockets, as ss; plain, the recent connections. */
export function cmdNetstat(args: string[], ctx: TermContext): Lines {
  if (args.some((a) => /^-[a-z]*[la]/.test(a))) return cmdSs(args, ctx)

  const conns = ctx.recentConnections ?? []
  const lines: Lines = [
    out('Active Internet connections (w/o servers)'),
    out(`Proto Recv-Q Send-Q ${'Local Address'.padEnd(24)}${'Foreign Address'.padEnd(24)}State`),
  ]
  if (conns.length === 0) {
    lines.push(out('(no recent connections — try curl, ftp or imap first; netstat -tuln shows listening ports)'))
    return lines
  }
  for (const c of conns) {
    lines.push(out(`tcp        0      0 ${`${c.localIp}:${c.localPort}`.padEnd(24)}${`${c.remoteIp}:${c.remotePort}`.padEnd(24)}TIME_WAIT`))
  }
  return lines
}
