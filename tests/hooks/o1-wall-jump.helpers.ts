/** One framed request, first response line — the raw daemon client the §5 (2) lock uses to read the daemon's own verdict. */
export function rawLine(sockPath: string, payload: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("rawLine timeout")), timeoutMs);
    Bun.connect<undefined>({
      unix: sockPath,
      socket: {
        open(s) { try { s.write(payload); } catch (e) { clearTimeout(timer); reject(e as Error); } },
        data(s, d) { buf += d.toString(); const nl = buf.indexOf("\n"); if (nl >= 0) { clearTimeout(timer); resolve(buf.slice(0, nl)); s.end(); } },
        error(_s, e) { clearTimeout(timer); reject(e); },
        connectError(_s, e) { clearTimeout(timer); reject(e); },
      },
    }).catch((e) => { clearTimeout(timer); reject(e); });
  });
}
