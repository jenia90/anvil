const SGR = /\x1b\[([0-9;]*)m/g;

export function stripAnsi(s: string): string {
  return s.replace(SGR, "");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isSupported(code: number): boolean {
  return code === 1 || (code >= 30 && code <= 37) || (code >= 90 && code <= 97);
}

export function ansiToHtml(s: string): string {
  let out = "";
  let open = false;
  let last = 0;
  for (const m of s.matchAll(SGR)) {
    out += escapeHtml(s.slice(last, m.index));
    last = m.index + m[0].length;
    const params = m[1];
    if (params === "" || params === "0") {
      if (open) out += "</span>";
      open = false;
    } else if (!params.includes(";") && isSupported(Number(params))) {
      if (open) out += "</span>";
      out += `<span class="ansi-${params}">`;
      open = true;
    }
  }
  out += escapeHtml(s.slice(last));
  if (open) out += "</span>";
  return out;
}
