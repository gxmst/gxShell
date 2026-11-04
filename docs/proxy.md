# Application proxy

Choose a mode under **Settings → Application proxy** and save. This controls
gxShell's outbound connections without changing the Windows global proxy.

| Mode | Behavior |
| --- | --- |
| Follow system (default) | Uses the current user's Windows static proxy, PAC or WPAD. `HTTP_PROXY` / `HTTPS_PROXY` environment variables take precedence, including `NO_PROXY`. Other platforms use these environment variables. |
| Direct connection | Ignores system and environment proxy settings. |
| Manual proxy | Routes applicable requests through an HTTP, HTTPS or SOCKS5 proxy, except targets on the bypass list. |

Manual URLs require a scheme and explicit port, for example
`http://127.0.0.1:7890`, `https://proxy.example.com:8443` or
`socks5://127.0.0.1:1080`. `socks5h://` is also accepted; SOCKS5 resolves target
hostnames at the proxy. Manual mode currently supports proxies without
authentication. URLs containing usernames or passwords are rejected.

The bypass list accepts domains, IP addresses and CIDRs separated by commas or
semicolons, for example:

```text
*.example.com,10.0.0.0/8,192.168.1.10,<local>
```

`<local>` bypasses hostnames without dots. `localhost`, its subdomains and
loopback addresses always connect directly, including local AI services and the
CLI/MCP control interface.

## Coverage and activation

- AI chat, model listing and update checks use the selected policy. Update
  checks still require their independent opt-in.
- **Use proxy for SSH connections** is off by default. When enabled, new SSH
  connections and the first jump-host hop use the policy. HTTP/HTTPS proxies use
  CONNECT; SOCKS5 provides a TCP connection.
- Saving applies the policy to new requests immediately. Active AI streams and
  established SSH sessions continue; reconnect SSH sessions to change their route.
- Connections from a jump host and networking performed by remote commands run
  on the remote machine. External browsers, ICMP/UDP diagnostics and local target
  connections of reverse tunnels are outside this policy.

An unreachable manual proxy returns a connection error without falling back to
direct access. Invalid settings are rejected before saving. An invalid policy
already on disk blocks external requests until corrected. Backup restoration
preserves the destination computer's proxy settings.

Windows PAC/WPAD resolution has per-stage timeouts and does not automatically
send Windows logon credentials. SSH requires the proxy to permit CONNECT to the
SSH port; many HTTP proxies allow only port 443. Verification used local mock
proxies; real enterprise PAC/WPAD and authenticated proxies still need platform
acceptance testing.
