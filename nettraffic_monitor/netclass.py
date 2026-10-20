"""Classify a connection as loopback / internal (LAN) / external (internet)."""
import ipaddress
import socket

LOOP, INTERNAL, EXTERNAL = 0, 1, 2

_BASE_INTERNAL = [
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",   # RFC1918
    "169.254.0.0/16", "100.64.0.0/10",                 # link-local, CGNAT
    "224.0.0.0/4", "255.255.255.255/32", "0.0.0.0/32",  # multicast, broadcast
    "fe80::/10", "fc00::/7", "ff00::/8",                # link-local, ULA, multicast
]


def local_addresses():
    """Packed addresses of all local interfaces (incl. VPN tunnels)."""
    out = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            out.add(ipaddress.ip_address(info[4][0].split("%")[0]).packed)
    except (OSError, ValueError):
        pass
    return out


class Classifier:
    def __init__(self, extra_internal=()):
        nets = [ipaddress.ip_network(n, strict=False) for n in (*_BASE_INTERNAL, *extra_internal)]
        self.v4 = [n for n in nets if n.version == 4]
        self.v6 = [n for n in nets if n.version == 6]
        self._cache = {}
        self.local = local_addresses()

    def refresh_local(self):
        self.local = local_addresses()

    def swapped(self, daddr: bytes, saddr: bytes) -> bool:
        """ETW mostly reports daddr=remote, but some receive events are swapped -
        whichever address belongs to this host is the local one."""
        return daddr in self.local and saddr not in self.local

    def classify(self, remote: bytes, local: bytes, v6: bool) -> int:
        if remote == local:  # traffic to our own interface address never leaves the host (= loopback)
            return LOOP
        # IPv6 hosts in the same /64 as the local address are on the LAN even with global addresses.
        key = (remote, local[:8]) if v6 else remote
        c = self._cache.get(key)
        if c is None:
            if len(self._cache) > 50_000:
                self._cache.clear()
            c = self._compute(remote, local, v6)
            self._cache[key] = c
        return c

    def _compute(self, remote, local, v6):
        ip = ipaddress.ip_address(remote)
        if v6 and ip.ipv4_mapped:
            ip, v6 = ip.ipv4_mapped, False
        if ip.is_loopback:
            return LOOP
        if v6 and remote[:8] == local[:8] and not ipaddress.ip_address(local).is_loopback:
            return INTERNAL
        for n in (self.v6 if v6 else self.v4):
            if ip in n:
                return INTERNAL
        return EXTERNAL
