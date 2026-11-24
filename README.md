# Networx

A browser-based network emulator for teaching computer networking concepts at GCSE and A Level (OCR specifications J277 and H446).

**[Live demo →](https://milesberry.net/networx)**

![Classroom network](classroom.png)

## What it does

Networx lets you build virtual networks by dragging hardware components onto a canvas and connecting them with wired or wireless links. Once built, you can:

- **Run terminal commands** on PCs, laptops, and servers — `ping`, `traceroute`, `ipconfig`, `nslookup`, `curl`, `ssh`, and more
- **Browse the web** — a built-in browser on PC/Laptop/Server nodes renders pages served by Web Server nodes, resolves hostnames via local DNS, and simulates internet access through a Cloud node
- **SSH between nodes** — `ssh <ip>` opens a persistent session; all subsequent commands run as the remote device until you type `exit`
- **Assign IPs with DHCP** — routers run a DHCP server; clients request leases with `dhclient` (Linux) or `ipconfig /renew` (Windows), animating the full four-way handshake
- **Configure DNS records** — DNS Server nodes hold A records that resolve hostnames across the network
- **Ping domain names** — `ping google.com` resolves via DNS and routes through the internet node
- **Inspect switch MAC tables** — tables populate as traffic flows, showing which MAC address was learned on which port
- **Configure routers** — add static routing table entries
- **Set firewall rules** — allow/deny by protocol, port, and IP
- **Configure wireless access points** — SSID, WPA key, 2.4/5 GHz band
- **Load preset scenarios** — five built-in topologies covering key exam topics
- **Save and share** — export your network as a `.json` file and import it elsewhere

## Preset scenarios

| Scenario | Covers |
|---|---|
| Star Topology (LAN) | Switch MAC tables, LAN addressing, ping |
| Home Network | NAT, router, WAP, wired + wireless clients |
| School Network | Firewall rules, network segmentation, servers |
| Client-Server Model | DNS resolution, HTTP, `nslookup`, `curl` |
| Mesh / WAN Topology | Redundant paths, inter-site routing, internet backbone |

## Curriculum links

- **OCR GCSE Computer Science J277** — Networks (1.3): protocols, hardware, topologies, internet, security
- **OCR A Level Computer Science H446** — Communication and networking (1.3): IP, TCP/IP stack, packet switching, hardware, client-server

Spec links:
- [GCSE J277](https://www.ocr.org.uk/Images/558027-specification-gcse-computer-science-j277.pdf)
- [A Level H446](https://www.ocr.org.uk/images/170844-specification-accredited-a-level-gce-computer-science-h446.pdf)

## SGCS extensions

This fork ([wilsoncheng-sgcs/networx](https://github.com/wilsoncheng-sgcs/networx)) extends the original
[milesberry/networx](https://github.com/milesberry/networx) for **NSW Stage 6 Software Engineering (Year 12)**,
for the dot point *“Investigate and describe the function of web protocols and their ports: HTTP, HTTPS, TCP/IP,
DNS, FTP, SFTP, SSL, TLS, SMTP, POP3, IMAP”* (SE-12-03). It adds:

- **Ports everywhere** — a single services table (`src/simulation/services.ts`); every packet carries a client
  (ephemeral) port and a server (well-known) port
- **Packet capture** — a Wireshark-style drawer listing every packet with source/destination `IP:port`, protocol,
  length and info, and a layer-by-layer detail pane; encrypted traffic shows only ciphertext
- **TCP three-way handshake**, **DNS over UDP 53** (unknown names now return NXDOMAIN) and **TLS 1.3** for HTTPS
- **`curl -v`** in the style of curl 8 on macOS, with ⓘ teaching notes, and a browser padlock / *Not secure* chip
- **File Server** with `ftp` (ports 21 and 20, readable) and `sftp` (inside SSH on 22, encrypted)
- **Mail Server** with `smtp` (587, AUTH PLAIN shown as Base64), `pop3` (110) and `imap` (143), plus `--tls`
  variants on 465, 995 and 993, and `mail` to read downloaded messages
- **Services tab** on servers, `ss` and a real `netstat`
- **Animation speed** control and terminal output timed to the packets (control+C stops it)
- **CareConnect** preset (fictional clinic on `careconnect.example`) for the lesson's labs
- **Certificates** — valid, self-signed, expired or wrong-name per server: `curl` fails with error 60 (`-k` carries
  on), the browser shows *Your connection is not private*
- **HTTP → HTTPS redirect** (`301 Moved Permanently`) and **`curl -I`** (headers only)
- **SMTP relay** from mail server to mail server on port 25
- **Tap a link** — capture only what crosses one connection, with that link's MAC addresses
- **Step mode** — pause before each packet of a conversation; Next or the space bar plays it
- **Layer labels** by name (Application, Internet, Link) with the OSI equivalent, and DHCP/SSH capture records
- **Subnets, default gateways and private addresses** decide what can reach what: a wrong mask or gateway breaks
  connectivity (with an ⓘ explaining why), and private 10.x / 172.16–31.x / 192.168.x addresses can't be reached
  across the internet. DHCP only reaches a server on the same network segment. Mismatched subnet masks fail as
  they do in real networks (the reply goes to the wrong place)
- **traceroute and TTL** count only devices that route: switches never appear, and same-subnet replies keep TTL 64
- **Firewall rules enforced** on firewalls and gateways (first match wins, inbound/outbound, stateful); a dropped
  connection stops at the firewall with a red ✕ and the client times out
- **DNS server setting** on every host (and handed out by DHCP), with an **Alternate DNS Server**; an unreachable DNS
  server times out (three queries) instead of answering NXDOMAIN
- **DNS records** A, AAAA, CNAME, MX, NS and TXT with TTLs, **`dig`** (`@server`, `+short`, `+trace` from the root),
  `nslookup -type=…`, and a **DNS cache** on each device that honours TTL (`dnscache`, `flushdns`); a DNS server
  can be a **secondary** that copies a primary's records
- Vitest unit tests: `npm run test`; headless acceptance run: `npm run acceptance` (with `npm run preview` running)

The original copyright and MIT licence are unchanged.

## Running locally

```bash
npm install
npm run dev
npm run test   # unit tests (Vitest)
```

Requires Node 18+.

## Tech stack

- [React](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [React Flow (@xyflow/react)](https://reactflow.dev/) — canvas and graph rendering
- [Zustand](https://zustand-demo.pmnd.rs/) — state management
- [Tailwind CSS](https://tailwindcss.com/) — styling
- [Lucide React](https://lucide.dev/) — icons
- [Vite](https://vitejs.dev/) — build tool

## License

MIT — see [LICENSE](LICENSE).
