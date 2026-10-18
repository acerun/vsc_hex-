// 输入解析：地址默认十六进制（0800_1000 / 0x1000 / 1000h，#4096 为十进制）；数值默认十进制（0x 十六进制、0b 二进制）。
// 解析失败抛出 FieldError，携带出错的字段名，便于界面高亮对应输入框。

export class FieldError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
  }
}

export function parseAddress(text: string | undefined): number {
  let t = (text ?? '').trim().replace(/_/g, '');
  if (t.startsWith('#')) {
    return /^\d+$/.test(t.slice(1)) ? Number(t.slice(1)) : NaN;
  }
  t = t.replace(/^0x/i, '').replace(/h$/i, '');
  return /^[0-9a-f]{1,8}$/i.test(t) ? parseInt(t, 16) : NaN;
}

/** 带符号的地址偏移：+1000 / -0x20 / #-16 */
export function parseDelta(text: string | undefined): number {
  const t = (text ?? '').trim();
  const neg = t.startsWith('-') || t.startsWith('#-');
  const body = t.replace(/^#?[+-]/, (m) => (m.startsWith('#') ? '#' : ''));
  const v = parseAddress(body);
  return neg ? -v : v;
}

export function parseValue(text: string | undefined): number {
  const t = (text ?? '').trim().replace(/_/g, '');
  const neg = t.startsWith('-');
  const b = neg ? t.slice(1) : t;
  let v = NaN;
  if (/^0x[0-9a-f]+$/i.test(b)) {
    v = parseInt(b.slice(2), 16);
  } else if (/^0b[01]+$/i.test(b)) {
    v = parseInt(b.slice(2), 2);
  } else if (/^\d+$/.test(b)) {
    v = Number(b);
  }
  return neg ? -v : v;
}

/** 单个字节，十六进制：FF / 0xFF */
export function parseByte(text: string | undefined): number {
  const t = (text ?? '').trim().replace(/^0x/i, '');
  return /^[0-9a-f]{1,2}$/i.test(t) ? parseInt(t, 16) : NaN;
}

/** 十六进制字节序列：DE AD BE EF / DEADBEEF / 0xDE,0xAD */
export function parseHexBytes(text: string | undefined): Uint8Array | undefined {
  const out: number[] = [];
  for (const tok of (text ?? '').trim().split(/[\s,;]+/)) {
    if (!tok) {
      continue;
    }
    const t = tok.replace(/^0x/i, '');
    if (!/^([0-9a-f]{2})+$/i.test(t)) {
      return undefined;
    }
    for (let i = 0; i < t.length; i += 2) {
      out.push(parseInt(t.substr(i, 2), 16));
    }
  }
  return out.length ? Uint8Array.from(out) : undefined;
}

export function need(v: number, field: string, msg: string): number {
  if (!Number.isFinite(v)) {
    throw new FieldError(field, msg);
  }
  return v;
}

/** 范围：结束地址（含）或 "+长度"（十六进制，#为十进制），返回 [start, end)。 */
export function parseRange(start: string | undefined, end: string | undefined, fields: [string, string] = ['start', 'end']) {
  const a = need(parseAddress(start), fields[0], '起始地址无效');
  const e = (end ?? '').trim();
  let b: number;
  if (e.startsWith('+')) {
    b = a + need(parseAddress(e.slice(1)), fields[1], '长度无效');
  } else {
    b = need(parseAddress(e), fields[1], '结束地址无效') + 1;
  }
  if (b <= a) {
    throw new FieldError(fields[1], '结束地址必须大于起始地址');
  }
  return { start: a, end: b };
}
