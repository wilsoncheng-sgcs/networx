/** Packet colours on the canvas; the capture drawer uses pale tints of the same colours. */
export const PROTOCOL_COLORS: Record<string, string> = {
  ARP:  '#16a34a',  // green
  ICMP: '#f97316',  // orange
  HTTP: '#2563eb',  // blue
  DNS:  '#9333ea',  // purple
  DHCP: '#65a30d',  // lime
  TCP:  '#0891b2',  // cyan
  UDP:  '#d97706',  // amber
  TLS:  '#4f46e5',  // indigo
  SSH:  '#7c3aed',  // violet
  FTP:  '#dc2626',  // red: plain FTP exposes everything
  'FTP-DATA': '#dc2626',
  SMTP: '#db2777',  // pink
  POP3: '#a16207',  // dark yellow
  IMAP: '#0d9488',  // teal
}

/** Pale row tint for the capture table (the colour at ~12% over white). */
export function protocolTint(protocol: string): string {
  const hex = PROTOCOL_COLORS[protocol]
  if (!hex) return 'transparent'
  return `${hex}1f`
}
