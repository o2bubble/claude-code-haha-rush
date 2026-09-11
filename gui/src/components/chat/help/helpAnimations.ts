// helpAnimations.ts — inject CSS keyframes used by help demos (once)

let _injected = false;

export function ensureHelpAnimations() {
  if (_injected) return;
  _injected = true;
  const style = document.createElement("style");
  style.textContent = `
    @keyframes conn-pulse {
      0%, 100% { opacity: 0.5; }
      50% { opacity: 1; }
    }
  `;
  document.head.appendChild(style);
}
