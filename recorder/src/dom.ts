// Tiny DOM builder shared by the screens.

export type Kid = Node | string | null | false | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) (e as any)[k] = v; else if (k in e) (e as any)[k] = v; else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}
