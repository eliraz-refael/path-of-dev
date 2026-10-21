import { isIPv4, isIPv6 } from "node:net"

// Who a request to the public server comes from, for the limits keyed by client address. Every request reaches it
// through Traefik (Coolify's proxy, on the same host), and a request for api.pathof.dev or pathof.dev/u through
// Cloudflare first:
//
//   client ─▶ Cloudflare edge ─▶ Traefik ─▶ server
//               sets CF-Connecting-IP   appends the address that reached it to X-Forwarded-For
//
//   clientIpOf(trust, headers, socket address)
//     ├─ the socket is no proxy of ours ───────────────────▶ the socket's address: headers never move the key
//     └─ the socket is Traefik ─▶ the LAST X-Forwarded-For entry, the address that reached Traefik
//           ├─ in Cloudflare's ranges, with a CF-Connecting-IP ─▶ CF-Connecting-IP: Cloudflare names the client
//           └─ anything else (a client that went round Cloudflare) ─▶ that address
//
// Only the last X-Forwarded-For entry is read, and only from our own proxy, which writes it whatever Traefik's
// `trustedIPs` says: every entry before it is the client's own to make up. CF-Connecting-IP is read only from an
// address Cloudflare publishes as its own; anyone else can send it. So a header forged by a peer we don't trust never
// changes the key.
//
// A client on IPv6 usually holds a whole /64, so `limitKeyOf` keys it by that, and an IPv4 address mapped into IPv6
// is the IPv4 address.

/** Cloudflare's edge, as it publishes it at https://www.cloudflare.com/ips-v4 and /ips-v6 (read 2026-10-21). */
export const cloudflareRanges: ReadonlyArray<string> = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
]

/**
 * Where our own proxy can connect from: loopback and the private ranges, which Docker's networks (Coolify's
 * `coolify` network among them) are drawn from. Nothing on the internet has these addresses, so only a container on
 * the host can claim to be Traefik, as long as the server's port is not published on the host (docs/deploy.md).
 */
export const proxyRanges: ReadonlyArray<string> = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::1/128",
  "fc00::/7",
]

/** An address as a number: 32 bits for IPv4, 128 for IPv6. */
export interface Address {
  readonly family: 4 | 6
  readonly value: bigint
}

/** A range of addresses: those whose first `bits` bits are `network`'s. */
export interface Cidr {
  readonly family: 4 | 6
  readonly network: bigint
  readonly bits: number
}

/** Whose headers the server believes: the proxy in front of it, and Cloudflare's edge in front of that. */
export interface Trust {
  readonly proxies: ReadonlyArray<Cidr>
  readonly cloudflare: ReadonlyArray<Cidr>
}

const widthOf = (family: 4 | 6): number => (family === 4 ? 32 : 128)

const ipv4Of = (text: string): bigint =>
  text.split(".").reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n)

/** IPv4 addresses mapped into IPv6, `::ffff:0:0/96`. */
const mappedPrefix = 0xffffn << 32n

/**
 * The address `text` writes, IPv4 or IPv6 (a zone after `%` left out), with an IPv4 address mapped into IPv6 read as
 * the IPv4 address; null for anything else, a port included.
 */
export const addressOf = (text: string | undefined | null): Address | null => {
  const trimmed = (text ?? "").trim()
  if (isIPv4(trimmed)) return { family: 4, value: ipv4Of(trimmed) }
  const bare = trimmed.split("%")[0] ?? ""
  if (!isIPv6(bare)) return null
  const [head = "", tail] = bare.split("::")
  const groupsOf = (part: string): Array<bigint> =>
    part === ""
      ? []
      : part.split(":").flatMap((group) =>
        group.includes(".") ? [ipv4Of(group) >> 16n, ipv4Of(group) & 0xffffn] : [BigInt(`0x${group}`)]
      )
  const left = groupsOf(head)
  const right = tail === undefined ? [] : groupsOf(tail)
  const groups = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0n), ...right]
  const value = groups.reduce((sum, group) => (sum << 16n) | group, 0n)
  return value >> 32n === 0xffffn ? { family: 4, value: value & 0xffffffffn } : { family: 6, value }
}

/** The range `text` writes as `address/bits`, or null when it is none. */
export const cidrOf = (text: string): Cidr | null => {
  const [base, bits, extra] = text.split("/")
  const address = addressOf(base)
  if (address === null || bits === undefined || extra !== undefined || !/^[0-9]{1,3}$/.test(bits)) return null
  const width = widthOf(address.family)
  const length = Number(bits)
  if (length > width) return null
  const shift = BigInt(width - length)
  return { family: address.family, network: (address.value >> shift) << shift, bits: length }
}

/** Whether `address` is in `range`. */
export const isIn = (address: Address, range: Cidr): boolean => {
  if (address.family !== range.family) return false
  const shift = BigInt(widthOf(range.family) - range.bits)
  return address.value >> shift === range.network >> shift
}

/** Ranges as the server trusts them; a range that is none fails loudly, as it is the source's own data. */
export const cidrsOf = (texts: ReadonlyArray<string>): ReadonlyArray<Cidr> =>
  texts.map((text) => {
    const range = cidrOf(text)
    if (range === null) throw new Error(`Not an address range: ${text}`)
    return range
  })

/** The public server's trust: Traefik from a private address, and Cloudflare's published edge. */
export const publicTrust: Trust = { proxies: cidrsOf(proxyRanges), cloudflare: cidrsOf(cloudflareRanges) }

const isAny = (address: Address, ranges: ReadonlyArray<Cidr>): boolean => ranges.some((range) => isIn(address, range))

/** The address as text: dotted for IPv4, eight full groups for IPv6, so one address is always spelt one way. */
export const textOf = (address: Address): string =>
  address.family === 4
    ? [24n, 16n, 8n, 0n].map((shift) => String((address.value >> shift) & 0xffn)).join(".")
    : [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n]
      .map((shift) => ((address.value >> shift) & 0xffffn).toString(16))
      .join(":")

/**
 * The client's address as text, by `trust`, from the request's headers (lower-case names) and the socket's address;
 * null when the socket has none.
 */
export const clientIpOf = (
  trust: Trust,
  headers: Readonly<Record<string, string | undefined>>,
  remote: string | null,
): string | null => {
  const socket = addressOf(remote)
  if (socket === null) return null
  if (!isAny(socket, trust.proxies)) return textOf(socket)
  // The last entry is the one our proxy wrote: the address that reached it. One without any is the proxy's own.
  const forwarded = (headers["x-forwarded-for"] ?? "").split(",")
  const edge = addressOf(forwarded[forwarded.length - 1]) ?? socket
  if (isAny(edge, trust.cloudflare)) {
    const client = addressOf(headers["cf-connecting-ip"])
    if (client !== null) return textOf(client)
  }
  return textOf(edge)
}

/** The key a client's address is limited by: an IPv4 address, or the /64 an IPv6 address is in. */
export const limitKeyOf = (ip: string | null): string => {
  const address = addressOf(ip)
  if (address === null) return "unknown"
  return address.family === 4 ? textOf(address) : `${textOf({ family: 6, value: (address.value >> 64n) << 64n })}/64`
}
