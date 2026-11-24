/**
 * Self-contained non-secret top-level DOM check, serialized into the Browser
 * provider's page.evaluate. Never returns input contents, passwords or OTPs.
 */
export function inspectSavedPasswordTarget(candidate: {
  selector: string;
  kind: 'account' | 'password';
  expectedAccount?: string;
}): {
  count: number;
  kindValid: boolean;
  password: boolean;
  matches: boolean;
  filled: boolean;
  actionable: boolean;
  bounds?: { x: number; y: number; visible: boolean };
} {
  const empty = { count: 0, kindValid: false, password: false, matches: false, filled: false, actionable: false };
  if (window.self !== window.top) return empty;
  let candidates: Element[];
  try {
    candidates = Array.from(document.querySelectorAll(candidate.selector));
  } catch {
    return empty;
  }
  if (candidates.length !== 1) return { ...empty, count: candidates.length };
  const field = candidates[0];
  const input = field instanceof HTMLInputElement;
  const password = input && field.type === 'password';
  const accountField = input && ['text', 'email', 'tel', 'search'].includes(field.type);
  const kindValid = candidate.kind === 'password' ? password : accountField;
  if (!input || !kindValid) return { ...empty, count: 1, kindValid, password };
  const result = {
    count: 1,
    kindValid,
    password,
    matches: candidate.kind === 'account' && field.value.trim() === candidate.expectedAccount,
    filled: password && field.value.length > 0,
    actionable: false,
  };
  if (!field.isConnected || field.disabled || field.readOnly || field.hidden) return result;
  for (let node: HTMLElement | null = field; node; node = node.parentElement) {
    if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return result;
    const style = getComputedStyle(node);
    if (
      style.display === 'none' ||
      style.visibility !== 'visible' ||
      Number(style.opacity) <= 0 ||
      style.pointerEvents === 'none'
    )
      return result;
  }
  const rect = field.getBoundingClientRect();
  const x = rect.left + rect.width / 2,
    y = rect.top + rect.height / 2;
  const front =
    Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight
      ? document.elementFromPoint(x, y)
      : null;
  const visible = rect.width > 0 && rect.height > 0 && (front === field || (front != null && field.contains(front)));
  return { ...result, actionable: visible, bounds: { x, y, visible } };
}
