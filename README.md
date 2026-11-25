# Networx

A browser-based network emulator for teaching networking and web protocols in **NSW Stage 6 Software Engineering**
([NESA Software Engineering 11–12 Syllabus, 2022](https://curriculum.nsw.edu.au/learning-areas/tas/software-engineering-11-12-2022/overview)).

**[Live site →](https://wilsoncheng-sgcs.github.io/networx/)** (deployed from `main`)

This fork ([wilsoncheng-sgcs/networx](https://github.com/wilsoncheng-sgcs/networx)) extends Miles Berry's
[Networx](https://github.com/milesberry/networx) for St George Christian School (SGCS).

![Classroom network](classroom.png)

## Syllabus links

Networx is built around the Software Engineering dot point *“Investigate and describe the function of web protocols
and their ports: HTTP, HTTPS, TCP/IP, DNS, FTP, SFTP, SSL, TLS, SMTP, POP3, IMAP”* (SE-12-03). Each protocol in it
can be seen working, packet by packet:

| Protocol | Port(s) | Where to see it in Networx |
|---|---|---|
| HTTP | TCP 80 | `curl`, `curl -v`, `curl -I` and the built-in browser, against a Web Server |
| HTTPS, SSL, TLS | TCP 443 | TLS 1.3 handshake in `curl -v` and the capture; padlock / *Not secure* in the browser; valid, self-signed, expired and wrong-name certificates; HTTP → HTTPS redirect |
| TCP/IP | — | TCP three-way handshake, ephemeral and well-known ports, IP addressing, subnets, gateways, routing, TTL, layer labels |
| DNS | UDP 53 | `nslookup`, `dig` (`+trace` from the root), DNS records, device and server caches, forwarders |
| FTP | TCP 21 and 20 | `ftp` to a File Server: commands and file contents readable in the capture |
| SFTP | TCP 22 | `sftp` to a File Server: the same transfer inside SSH, encrypted |
| SMTP | TCP 587, 465, 25 | `smtp` to a Mail Server (AUTH PLAIN shown as Base64), `--tls` on 465, server-to-server relay on 25 |
| POP3 | TCP 110, 995 | `pop3`: downloads and removes mail from the server (`--keep` leaves it), `--tls` on 995 |
| IMAP | TCP 143, 993 | `imap`: reads mail kept on the server, `--tls` on 993 |

The **Concepts** panel has short notes on web protocols and ports, SSL and TLS, the TCP handshake, DNS, IP
addressing, the TCP/IP model, routers, switches, security, topologies and more.

## What it does

Build a network by dragging devices onto the canvas and joining them with wired or wireless links:

| Devices | |
|---|---|
| PC, Laptop, Server | Hosts with a terminal and a web browser |
| Router, Home Gateway | Route between networks; run DHCP; the Home Gateway is a router, switch, Wi-Fi access point and firewall in one |
| Switch, Hub | Join devices on a LAN; a switch learns MAC addresses, a hub doesn't |
| Access Point | SSID, WPA key, 2.4 / 5 GHz band |
| Firewall | Allow / deny rules by protocol, port and IP |
| DNS, Web, Mail and File Servers | Hold records, pages, mailboxes and files, each edited in Configure |
| Internet | The ISP: routes to public networks behind routers |

Then:

- **Run terminal commands** on any host (type `help` for the list):

  | Group | Commands |
  |---|---|
  | Connectivity | `ping`, `traceroute` / `tracert`, `ipconfig` / `ifconfig`, `arp -a` / `arp -d`, `route`, `dhclient` / `ipconfig /renew` |
  | Name lookup | `nslookup [-type=…]`, `dig [@server] [type] [+short] [+trace]`, `dnscache`, `flushdns` |
  | Web | `curl` / `wget` with `-v`, `-I`, `-k` |
  | Files | `ftp`, `sftp` |
  | Mail | `smtp`, `pop3`, `imap`, `mail` (add `--tls` for the TLS ports) |
  | Ports | `ss`, `netstat`, `netstat -tuln` |
  | Remote | `ssh <ip>` (later commands run on that device until `exit`) |

- **Browse the web**: the browser on a PC, Laptop or Server shows pages from Web Servers, by IP or by name
- **Watch the packets**: every packet is animated along the links; terminal output is timed to the packets
  (control+C stops a command). Speed: Slow, Normal or Fast
- **Packet capture**: a Wireshark-style drawer listing every packet with source and destination `IP:port`, protocol,
  length and info, and a layer-by-layer detail pane. Encrypted traffic shows only ciphertext. Filter by protocol, or
  **tap a link** to capture only what crosses that one connection, with its MAC addresses
- **Step mode**: pause before each packet of a conversation; Next or the space bar plays it
- **Layers**: label each device with the TCP/IP layer it works at (Application, Internet, Link; a firewall spans
  Internet and Transport), with the OSI equivalent
- **Configure each device**: name, IP address, subnet mask, default gateway, DNS servers, Manual or Automatic (DHCP)
  addressing, notes, and Online / Offline
- **Save and share**: export the network as a `.json` file and import it elsewhere
- **Load a preset** (below)

## Preset scenarios

| Scenario | Covers |
|---|---|
| CareConnect | A fictional clinic on `careconnect.example`: web (HTTP/HTTPS), DNS records, mail and file servers, for the web protocols labs |
| Star Topology (LAN) | Switch MAC tables, LAN addressing, ping |
| Subnetting (/29) | Two /29 subnets on one switch: same subnet reaches, other subnet needs a router |
| Home Network | NAT, router, WAP, wired + wireless clients |
| School Network | Firewall rules, network segmentation, servers |
| Client-Server Model | DNS resolution, HTTP, `nslookup`, `curl` |
| Upstream DNS | A local DNS server with no records forwards to the school.local DNS server and caches the answer |
| Mesh / WAN Topology | Redundant paths, inter-site routing, internet backbone |

Most presets' devices have notes saying what to try.

## How it behaves

The simulation follows real networks closely enough that what goes wrong in class matches what goes wrong in life.
When something fails, an ⓘ in the terminal says why.

**Addressing and routing**
- **Subnets, default gateways and private addresses** decide what can reach what. A wrong mask or gateway breaks
  connectivity. Mismatched subnet masks fail as they do in real networks (the reply goes to the wrong place)
- Private 10.x / 172.16–31.x / 192.168.x addresses can't be reached across the internet
- **DHCP** hands out the router's own address as the default gateway, its subnet mask and its DNS server. It only
  reaches clients on the same network segment, and the four-way handshake is animated
- **Routing tables** on routers. **ISP routing table** on the Internet node: a public network behind a router is
  reachable from the internet only while a route to it is announced (Announce / Withdraw on the router's Routing
  tab). Private ranges are never carried, and the reply needs a route back too
- **traceroute and TTL** count only devices that route: switches never appear, and same-subnet replies keep TTL 64
- **ARP** tables fill as hosts find each other's MAC addresses; **switch MAC tables** fill as traffic flows
- **Firewall rules** on firewalls and home gateways: first match wins, inbound or outbound, stateful. A dropped
  connection stops at the firewall with a red ✕ and the client times out

**Ports and services**
- **Ports everywhere**: one services table (`src/simulation/services.ts`). Every packet carries a client
  (ephemeral) port and a server (well-known) port
- **Services tab** on servers shows what is listening; `ss` and `netstat` show the same from the terminal

**Web**
- **TCP three-way handshake** before every TCP conversation, and **TLS 1.3** for HTTPS
- **`curl -v`** in the style of curl 8 on macOS, with ⓘ teaching notes
- **Certificates**: valid, self-signed, expired or wrong-name per server. `curl` fails with error 60 (`-k` carries
  on); the browser shows *Your connection is not private*
- **HTTP → HTTPS redirect** (`301 Moved Permanently`) and **`curl -I`** (headers only)

**DNS**
- **DNS over UDP 53**. Unknown names return NXDOMAIN
- **DNS server setting** on every host (and handed out by DHCP), with an **Alternate DNS Server**. An unreachable
  DNS server times out (three queries) instead of answering NXDOMAIN
- **DNS records** A, AAAA, CNAME, MX, NS and TXT, with TTLs. A DNS server can be a **secondary** that copies a
  primary's records
- **DNS cache** on each device that honours TTL (`dnscache`, `flushdns`). `ping`, `curl` and the browser use it;
  `nslookup` and `dig` always ask the server
- **DNS forwarder** on each DNS server (default 8.8.8.8, set in Configure): a name the server doesn't hold, outside
  its own domains, is really asked upstream. The server's own query and the reply show in the capture and in step
  mode before the client gets its non-authoritative answer. The server caches the answer for its TTL, so the next
  lookup has no upstream leg. If the forwarder can't be reached, the server answers **SERVFAIL** after 3 s with an ⓘ
  saying why, while its own names still work; with no forwarder it answers **REFUSED**
- **DNS Cache tab** in Configure on every host: what the device has cached, with each TTL counting down and the
  server it came from, plus a Flush button. On a DNS server it also lists the answers it got from its forwarder. An
  answer appears when its packet arrives, not before

**Files and mail**
- **File Server** with `ftp` (ports 21 and 20, readable) and `sftp` (inside SSH on 22, encrypted)
- **Mail Server** with `smtp` (587, AUTH PLAIN shown as Base64), `pop3` (110) and `imap` (143), plus `--tls`
  variants on 465, 995 and 993, and `mail` to read downloaded messages. **SMTP relay** from mail server to mail
  server on port 25. Mailboxes can be reset to their sample messages after a POP3 demo empties them

## Running locally

```bash
npm install
npm run dev
npm run test         # unit tests (Vitest)
npm run build
npm run preview      # then, in another terminal:
npm run acceptance   # headless acceptance run against the preview
```

Requires Node 18+. Pushing to `main` deploys the live site through GitHub Pages, so work on a branch and merge by
pull request.

## Tech stack

- [React](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [React Flow (@xyflow/react)](https://reactflow.dev/) — canvas and graph rendering
- [Zustand](https://zustand-demo.pmnd.rs/) — state management
- [Tailwind CSS](https://tailwindcss.com/) — styling
- [Lucide React](https://lucide.dev/) — icons
- [Vite](https://vitejs.dev/) — build tool

## Licence

MIT — see [LICENSE](LICENSE). The original copyright and licence are unchanged.
